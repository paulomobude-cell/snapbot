import assert from "node:assert/strict";
import Session from "../server/session.js";
import { MAX_BACKFILL_CHATS, validateBackfillSelection } from "../server/backfill-selection.js";

const chats=[
  { id:"already-seen",name:"Old chat",status:{type:"Opened"} },
  { id:"unread",name:"Unread chat",status:{type:"New Snap"} },
  { id:"delivered",name:"Delivered chat",status:{type:"Delivered"} },
];
assert.deepEqual(validateBackfillSelection(["already-seen","unread"],chats),["already-seen","unread"]);
assert.throws(()=>validateBackfillSelection([],chats),/Select between/);
assert.throws(()=>validateBackfillSelection(["unread","unread"],chats),/only once/);
assert.throws(()=>validateBackfillSelection(["missing"],chats),/Unknown/);
assert.throws(()=>validateBackfillSelection(Array.from({length:MAX_BACKFILL_CHATS+1},()=>chats[0].id),chats),/Select between/);

const session=new Session({store:{chatIds:()=>[]},media:{},config:{fullSyncIntervalMs:60000,syncIntervalMs:4000},profileDir:"/tmp/not-used"});
session.status="connected";
session.chats=chats;
session.bot={userStatus:async()=>chats,visibleChatId:async()=>null,openChat:async()=>{throw Error("must not auto-open")}};
session.lastChatDiscovery=Date.now();
session.hasChatList=async()=>true;
const opened=[];
session.syncChat=async(id,{interactive=false,fromBackfill=false}={})=>{
  assert.equal(interactive,true);
  assert.equal(fromBackfill,true);
  opened.push(id);
  if(id==="delivered") throw Error("simulated unavailable conversation");
  return {captured:true,messageCount:2};
};
await session.syncChats();
assert.deepEqual(opened,[],"Even Web 'Opened' status cannot implicitly trigger a read");
assert.throws(()=>session.startBackfill(["already-seen"]),/confirm/);
assert.throws(()=>session.startBackfill(["absent"],{confirmReadRisk:true}),/Unknown/);
const initial=session.startBackfill(["already-seen","delivered"],{confirmReadRisk:true});
assert.equal(initial.total,2);
assert.throws(()=>session.startBackfill(["unread"],{confirmReadRisk:true}),/already running/);
for(let t=0;t<40 && session.getBackfill().status==="running";t++)await new Promise(resolve=>setTimeout(resolve,20));
const final=session.getBackfill();
assert.deepEqual(opened,["already-seen","delivered"],"Only approved chats may be opened");
assert.equal(final.status,"completed");
assert.equal(final.completed,2);
assert.equal(final.captured,1);
assert.equal(final.failed,1);
assert.equal(final.errors.length,1);
assert.equal(opened.includes("unread"),false,"Unapproved Snap conversation left alone");

// Cancelling a batch cannot interrupt the currently active action, but must
// prevent opening the next selected chat.
opened.length=0;
session.syncChat=async(id)=>{
  opened.push(id);
  await new Promise(resolve=>setTimeout(resolve,45));
  return {captured:true};
};
session.startBackfill(["already-seen","unread"],{confirmReadRisk:true});
await new Promise(resolve=>setTimeout(resolve,5));
session.cancelBackfill();
for(let t=0;t<40 && session.getBackfill().status==="running";t++)await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(opened,["already-seen"]);
assert.equal(session.getBackfill().status,"cancelled");
console.log("Selected archive checks passed: explicit consent, stale-status safety, sequential progress, errors, cancellation.");
