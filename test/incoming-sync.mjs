import assert from "node:assert/strict";
import Session from "../server/session.js";

// Passive sidebar refresh may report activity, but must NEVER open a chat.
const statuses = [{id:"read",name:"Already open",status:{type:"Chat",time:"old"}},{id:"unread",name:"Unread",status:{type:"Received",time:"old"}}];
const calls = [], observed = [];
const session = new Session({
  store: { chatIds: () => [] }, media: {},
  config: { fullSyncIntervalMs: 60000, syncIntervalMs: 4000 },
  profileDir: "/tmp/not-used",
});
session.status = "connected";
session.lastChatDiscovery = Date.now();
session.bot = {
  userStatus: async () => statuses,
  visibleChatId: async () => "read",
  openChat: async id => { calls.push("OPEN:" + id); return true; },
  readMessages: async id => { calls.push("READ:" + id); return []; },
};
session.hasChatList = async () => true;
session.syncChat = async (id, { interactive = false } = {}) => {
  calls.push((interactive ? "INTERACTIVE:" : "PASSIVE:") + id);
};
session.on("chat:activity", evt => observed.push(evt));
await session.syncChats();
assert.deepEqual(calls, ["PASSIVE:read"]);
calls.length = 0;
statuses[1] = {...statuses[1], status:{type:"Received",time:"now"}};
await session.syncChats();
assert.deepEqual(calls, ["PASSIVE:read"]);
assert.equal(observed.length, 1);
assert.equal(observed[0].chatId, "unread");
assert.equal(session.passiveActivity.has("unread"), true);
assert.equal(calls.some(x => x.includes("unread")), false);
console.log("Passive sync: unread chat is observed without being opened.");
