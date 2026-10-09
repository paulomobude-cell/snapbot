import assert from "node:assert/strict";
import { reconcileSnapshot, reconcileUpdate, signedUrlStillFresh } from "../src/snapshot-stability.js";
import { stableMessageRows } from "../src/message-groups.js";
import { shouldFollowTail, chooseScrollTop } from "../src/scroll-behavior.js";

const now=Date.UTC(2026,9,9,12,0,0);
const date="20261009T120000Z";
const signed=(sig,dateValue=date,expires=21600)=>"https://bucket.r2.cloudflarestorage.com/object?X-Amz-Date="+dateValue+"&X-Amz-Expires="+expires+"&X-Amz-Signature="+sig;
assert.equal(signedUrlStillFresh(signed("abc"),now),true);
assert.equal(signedUrlStillFresh(signed("abc",date,60),now),false,"short expiration must not be cached");
const local=exp=>"https://snapbot.example/media/test?exp="+exp+"&sig=abc";
assert.equal(signedUrlStillFresh(local(Math.floor((now+6*3600*1000)/1000)),now),true);
assert.equal(signedUrlStillFresh(local(Math.floor((now+30*1000)/1000)),now),false);
const baseMedia={id:"media-1",status:"stored",kind:"video",size:30000,contentType:"video/mp4",url:signed("initial")};
const previous=[
  {uid:"old",kind:"text",from:"Friend",text:"earlier message",ord:1,media:[]},
  {uid:"video",kind:"media",from:"Friend",ord:2,media:[baseMedia]},
];
const serverRefresh=previous.map(m=>({...m,media:m.media.map(media=>({...media,url:signed("different")}))}));
const stable=reconcileSnapshot(previous,serverRefresh,now);
assert.strictEqual(stable,previous,"repeated snapshots with re-signed URLs must not rerender messages");
assert.strictEqual(stable[1].media[0].url,baseMedia.url,"playing videos keep their original signed URL");
const prepended=[{uid:"history",kind:"text",from:"Friend",text:"old text",ord:0,media:[]},...serverRefresh];
const withHistory=reconcileSnapshot(previous,prepended,now);
assert.deepEqual(withHistory.map(m=>m.uid),["history","old","video"]);
assert.strictEqual(withHistory[2],previous[1],"prepending history doesn't recreate existing video message objects");
assert.deepEqual(stableMessageRows(previous).map(row=>row.key),["old","video"]);
assert.deepEqual(stableMessageRows(withHistory).map(row=>row.key),["history","old","video"]);
assert.equal(stableMessageRows(withHistory)[2].startsGroup,false,"sender grouping is visual and doesn't change keys");
const changedVideo={...serverRefresh[1],media:[{...baseMedia,size:29999,url:signed("new-file")}]};
const modified=reconcileUpdate(previous[1],changedVideo,now);
assert.equal(modified.media[0].url,signed("new-file"),"genuine file modifications must not use stale links");
const renew=reconcileSnapshot(previous,serverRefresh,now+6*3600*1000-60000);
assert.equal(renew[1].media[0].url,signed("different"),"near expiry refreshes signed links");
const failed=reconcileUpdate(previous[1],{...previous[1],media:[{...baseMedia,status:"failed",url:null}]},now);
assert.equal(failed.media[0].url,null,"failed media never keep a stored URL");

const oldIds=["old","video"];
assert.equal(shouldFollowTail(oldIds,["history",...oldIds],true),false,
  "scrollback prepends must NOT scroll to the bottom");
assert.equal(shouldFollowTail(oldIds,[...oldIds,"new"],true),true);
assert.equal(shouldFollowTail(oldIds,[...oldIds,"new"],false),false,
  "user scrolling older history disables automatic jump");
const previousView={anchorUid:"video",anchorOffset:80,scrollTop:350,atBottom:false};
assert.equal(chooseScrollTop({previous:previousView,currentAnchorOffset:280,
  afterIds:["history",...oldIds],beforeIds:oldIds,newScrollHeight:3200}),550,
  "keep the same visible bubble at the same screen offset");
assert.equal(chooseScrollTop({previous:previousView,currentAnchorOffset:80,
  afterIds:[...oldIds,"new"],beforeIds:oldIds,newScrollHeight:3200}),350,
  "append during manual reading must preserve position");
assert.equal(chooseScrollTop({previous:{...previousView,atBottom:true},currentAnchorOffset:80,
  afterIds:[...oldIds,"new"],beforeIds:oldIds,newScrollHeight:3200}),3200);
assert.equal(chooseScrollTop({previous:previousView,currentAnchorOffset:null,
  afterIds:["history",...oldIds],beforeIds:oldIds,newScrollHeight:3200}),350,
  "if anchor disappears preserve last scrollTop, not the bottom");
assert.equal(chooseScrollTop({previous:previousView,afterIds:oldIds,beforeIds:oldIds,
  newScrollHeight:3200,forceLatest:true}),3200,"user-sent message deliberately follows latest");

const statuses=stableMessageRows([{uid:"a",kind:"text",isMe:false,from:"Zeze"},
 {uid:"status",kind:"status",from:"Snapchat",isMe:false},
 {uid:"b",kind:"text",isMe:false,from:"Zeze"}]);
assert.deepEqual(statuses.map(row=>row.startsGroup),[true,true,true]);
console.log("Chat stability checks passed: signed URL reuse, unchanged snapshots, stable per-message keys and scroll anchoring.");
