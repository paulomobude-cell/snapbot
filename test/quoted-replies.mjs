import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractVisibleMessages } from "../server/chat-reader.js";
import { openDb } from "../server/db.js";
import MessageStore from "../server/store.js";

// Lightweight DOM fixture modeled on Zeze's screenshot: an outer chat bubble
// with an inset sender-labeled quotation, followed by the actual reply text.
// The quoted content must not become its own chat message.
function node(tag, {text="", classes=[], sender=null, quote=false, media=null, leftBorder=0, legacy=false} = {}, children=[]) {
  const el={tagName:tag.toUpperCase(), parentElement:null, children, className:classes.join(" "),
    hidden:false, naturalWidth:200, naturalHeight:200, src:media,
    textContent:text,
    getAttribute(key) {return key==="data-sender" ? sender : null;},
    matches(selector) {
      if (quote && selector.includes("blockquote")) return true;
      if (selector==="li.T1yt2") return tag==="li"&&classes.includes("T1yt2");
      if (selector.startsWith("li.T1yt2,")) return tag==="li"&&classes.includes("T1yt2");
      if (selector==="span.ogn1z") return tag==="span"&&legacy;
      return false;
    },
    contains(other) {
      if (this===other) return true;
      return this.children.some(ch=>ch.contains(other));
    },
    closest(selector) {
      for(let cur=this;cur;cur=cur.parentElement) {
        if (selector.includes("[data-sender]")&&cur._sender) return cur;
        if(selector.includes("[data-message-id]")&&cur._messageRow) return cur;
        if(selector.includes("li,")&&cur.tagName==="LI") return cur;
      }
      return null;
    },
    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;},
    querySelectorAll(selector) {
      const all=[];
      const visit=n=>{for(const child of n.children){all.push(child); visit(child);}};
      visit(this);
      if(selector==="*") return all;
      if(selector==="li.T1yt2") return all.filter(x=>x._messageRow);
      if(selector==="li") return all.filter(x=>x.tagName==="LI");
      if(selector==="img, video") return all.filter(x=>x.tagName==="IMG"||x.tagName==="VIDEO");
      if(selector.startsWith("img, video")) return all.filter(x=>x.tagName==="IMG"||x.tagName==="VIDEO");
      if(selector.startsWith("span.ogn1z")) return all.filter(x=>(x.tagName==="SPAN" && x._legacy) || x.tagName==="IMG"||x.tagName==="VIDEO");
      return [];
    },
    _sender:sender,_quote:quote,_leftBorder:leftBorder,_legacy:legacy,
    _messageRow: tag==="li"&&classes.includes("T1yt2"),
  };
  for(const ch of children) ch.parentElement=el;
  Object.defineProperty(el,"textContent",{get(){return text + children.map(c=>c.textContent).join("");}});
  return el;
}
const n=(text,legacy=false)=>node("span",{text,legacy});
const quote=(author,quotedText,media=false)=>node("div",{quote:true,leftBorder:3},[
  n(author),n(quotedText),...(media?[node("img",{media:"blob:quote-thumbnail"})]:[])
]);
const reply=(sender,originalAuthor,originalText,repliedText,withPreviewMedia=false)=>{
  const q=quote(originalAuthor,originalText,withPreviewMedia);
  return node("li",{classes:["T1yt2"],sender},[q,n(repliedText,true)]);
};
const me=reply("Me","ZEZE","Omo, it is well","You're in finals now right?");
const zeze=reply("Zeze","ME","You're in finals now right?","Nahh, next year");
const last=reply("Zeze","ME","Next month","Oh woww\nThat's so nice\nCongratulations",true);
const plain=node("li",{classes:["T1yt2"],sender:"Me"},[n("How's school?",true)]);
const root=node("div",{},[plain,me,zeze,last]);
const beforeDoc=globalThis.document, beforeStyle=globalThis.getComputedStyle;
globalThis.getComputedStyle=el=>({display:"block",visibility:"visible",borderColor:el._sender==="Me"?"rgb(242, 60, 87)":"rgb(14, 173, 255)",borderLeftWidth:el._leftBorder+"px"});
globalThis.document={getElementById:id=>id==="cv-zeze"?root:null};
try {
  const items=extractVisibleMessages("zeze","Zeze");
  assert.ok(items,"should extract the visible chat");
  assert.equal(items.length,4,"quoted originals and author labels are not separate messages");
  assert.deepEqual(items.map(m=>m.text),[
    "How's school?",
    "You're in finals now right?",
    "Nahh, next year",
    "Oh woww That's so nice Congratulations",
  ]);
  assert.deepEqual(items.map(m=>m.from),["Me","Me","Zeze","Zeze"]);
  assert.deepEqual(items.map(m=>m.replyTo),[
    undefined,
    {from:"Zeze",text:"Omo, it is well",mediaType:null},
    {from:"Me",text:"You're in finals now right?",mediaType:null},
    {from:"Me",text:"Next month",mediaType:"image"},
  ]);
  assert.equal(items.some(x=>x.kind==="media"),false,"quoted image preview is not a new delivered media");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"snapbot-replies-"));
  try {
    const db=openDb(dir);
    db.prepare("INSERT INTO accounts(id,label,created_at) VALUES('a','a',?)").run(Date.now());
    const store=new MessageStore({db,accountId:"a",ttlMs:0});
    store.sync("zeze",items,{preserve:true,reconcileMissing:false});
    const archived=store.getMessages("zeze");
    assert.equal(archived.length,4,"reply counts exclude quoted original fragments");
    assert.equal(archived[2].replyTo.from,"Me");
    assert.equal(archived[2].replyTo.text,"You're in finals now right?");
    const preservedUid=archived[1].uid;
    // Repeated scans retain the same rows and associations.
    store.sync("zeze",items,{preserve:true,reconcileMissing:false});
    assert.equal(store.getMessages("zeze").length,4);
    assert.equal(store.getMessages("zeze")[1].uid,preservedUid);
    // Old plain replies can be enriched, not duplicated.
    store.sync("old",[{kind:"text",from:"Me",isMe:true,text:"Test reply",time:""}]);
    store.sync("old",[{kind:"text",from:"Me",isMe:true,text:"Test reply",time:"",
      replyTo:{from:"Zeze",text:"Earlier message",mediaType:null}}]);
    assert.equal(store.getMessages("old").length,1);
    assert.equal(store.getMessages("old")[0].replyTo.text,"Earlier message");
    db.close();
    const reopened=openDb(dir);
    const restored=new MessageStore({db:reopened,accountId:"a",ttlMs:0});
    assert.equal(restored.getMessages("zeze")[2].replyTo.text,"You're in finals now right?");
    reopened.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  console.log("Quoted reply tests passed: actual sender, nested quote, media preview, archive persistence and enrichment.");
} finally {
  globalThis.document=beforeDoc;
  globalThis.getComputedStyle=beforeStyle;
}
