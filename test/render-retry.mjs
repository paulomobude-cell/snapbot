import assert from "node:assert/strict";
import Session from "../server/session.js";

const syncs = [];
const store = {
  sync(chatId, items, options) {
    syncs.push({ chatId, items, options });
    return { seen: new Map() };
  },
  getMessages: () => [],
};
const session = new Session({ store, media: {}, config: { patterns: {} }, profileDir: "/tmp/snapbot-test-no-browser" });
session.status = "connected";
session.chats = [{ id: "friend", name: "Friend" }];
let reads = 0, opens = 0, visible = false;
session.bot = {
  openChat: async () => { opens++; visible = true; return true; },
  visibleChatId: async () => visible ? "friend" : null,
  readMessages: async () => ++reads === 1 ? null : [{ kind: "text", text: "Saved", from: "Friend" }],
};
session.readMediaBuffers = async () => new Map();
session.captureMedia = async () => {};
const result = await session.syncChat("friend", { interactive: true });
assert.equal(result.captured, true, "wait for rendered messages after a successful click");
assert.equal(reads, 2, "retry after initial unrendered DOM");
assert.equal(opens, 1);
assert.equal(syncs.length, 1);
assert.equal(syncs[0].options.reconcileMissing, false, "never erase archived content from a partial snapshot");

visible = false; opens = 0; reads = 0;
const passive = await session.syncChat("friend", { interactive: false });
assert.equal(passive.captured, false);
assert.equal(opens, 0, "passive sync must not click conversations");
assert.equal(reads, 0, "passive sync must not read unavailable DOM");
assert.match(passive.reason, /not already visible/);

session.bot.openChat = async () => { session.bot.lastChatOpenReason = "Chat not found in virtualized list"; return false; };
const failed = await session.syncChat("friend", { interactive: true });
assert.equal(failed.captured, false);
assert.match(failed.reason, /virtualized list/);
assert.equal(syncs.length, 1, "failed open must not modify the archive");
console.log("Render retries passed: interactive delay, meaningful errors, no passive opening, archive safety.");
