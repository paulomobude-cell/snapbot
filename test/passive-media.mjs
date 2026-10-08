import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import MessageStore from "../server/store.js";
import MediaStorage from "../server/media.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-media-"));
try {
  const db = openDb(root);
  db.prepare("INSERT INTO accounts(id,label,created_at) VALUES('a','a',?)").run(Date.now());
  const store = new MessageStore({db,accountId:"a",ttlMs:0});
  store.sync("friend",[
    {kind:"text",from:"Friend",isMe:false,text:"Hello",time:"now"},
    {kind:"notice",notice:"saved",from:"Friend",isMe:false,text:"You saved a video",time:"now"},
    {kind:"media",from:"Friend",isMe:false,text:"",src:"blob:loaded",sha256:"sha",mediaType:"video"},
  ],{preserve:true,reconcileMissing:false});
  let messages = store.getMessages("friend");
  assert.deepEqual(messages.map(m=>m.kind),["text","status","media"]);
  assert.equal(store.previews().friend.count,2,"status notices excluded from message counts");
  assert.equal(store.previews().friend.last.kind,"media");
  const mediaMsg=messages.find(m=>m.kind==="media");
  const id=store.addMedia(mediaMsg.uid,{kind:"video",viewOnce:false});
  store.mediaFailed(id,"R2 NoSuchBucket");
  const failed=store.getMedia(id);
  assert.equal(failed.status,"failed");
  assert.equal(failed.lastError,"R2 NoSuchBucket");
  assert.ok(failed.retryAt > Date.now());
  store.mediaStored(id,{key:"a/f/sha.mp4",contentType:"video/mp4",size:100,sha256:"sha",kind:"video"});
  const stored=store.getMedia(id);
  assert.equal(stored.status,"stored");
  assert.equal(stored.retryAt,null);
  assert.equal(stored.lastError,null);
  store.sync("friend",[],{preserve:true,reconcileMissing:false});
  assert.equal(store.getMessages("friend").length,3,"partial passive snapshot never flags historical messages gone");
  // Regression for uploaded Railway NoSuchBucket report: the bucket name must
  // be used literally, never derived from the API-token name. Once corrected,
  // a new upload attempt succeeds without changing account or archive rows.
  const r2 = new MediaStorage({ dataDir: root, secretKey: "test", publicUrl: "http://localhost",
    r2: {accountId:"cloudflare-account",accessKeyId:"dummy-key",secretAccessKey:"dummy-secret",
      bucket:"comnexus-snapbot-media"} });
  let attempts=0;
  r2.client = { fetch: async url => {
    assert.ok(url.includes("/comnexus-snapbot-media/"));
    attempts++;
    if(attempts===1) return {ok:false,status:404,text:async()=>"<NoSuchBucket/>"};
    return {ok:true,status:200};
  } };
  await assert.rejects(() => r2.put("a/f/sha.mp4",Buffer.from("media"),"video/mp4"),/R2 upload failed: 404/);
  await r2.put("a/f/sha.mp4",Buffer.from("media"),"video/mp4");
  assert.equal(attempts,2,"corrected R2 bucket permits reattempt");
  db.close();
  console.log("Passive status/media test passed: status separation, retry metadata, protected archive, mock R2 recovery");
} finally {fs.rmSync(root,{recursive:true,force:true});}
