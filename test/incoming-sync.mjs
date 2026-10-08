import assert from "node:assert/strict";
import Session from "../server/session.js";

// Fast path: new chat status must jump ahead of a long historical backfill,
// while previously queued contacts remain eligible for later sync ticks.
const statuses = Array.from({length: 8},(_,n)=>({id:String(n),name:"Person "+n,status:{type:"Chat",time:"old"}}));
const seen = [];
const session = new Session({store:{chatIds:()=>[]},media:{},config:{fullSyncIntervalMs:60_000},profileDir:"/tmp/not-used"});
session.status = "connected";
session.lastChatDiscovery = Date.now();
session.bot = { userStatus:async()=>statuses };
session.hasChatList = async()=>true;
session.syncChat = async(id)=>seen.push(id);
await session.syncChats();
assert.deepEqual(seen,["0","1","2"]);
assert.equal(session.pendingSync.size,5);

statuses[7] = {...statuses[7],status:{type:"Received",time:"now"}};
seen.length=0;
await session.syncChats();
assert.equal(seen[0],"7","changed conversation should be synchronized ahead of old backfill");
assert.ok(session.pendingSync.has("6"),"untouched backfill still pending");
assert.equal(session.pendingSync.size,2);
seen.length=0;
await session.syncChats();
assert.deepEqual(seen,["5","6"]);
assert.equal(session.pendingSync.size,0);
console.log("Priority sync test: urgent incoming activity, backfill queue and bounded batches passed");
