import assert from "node:assert/strict";
import Session from "../server/session.js";

// The browser queue must commit the previous rendered chat before a click
// switches conversations, and commit the destination immediately after it
// renders. These are real session methods with a deterministic fake page.
const events = [];
let current = "first";
let readable = true;
let selected = "second";
const page = {
  viewport: () => ({ width: 1200, height: 800 }),
  evaluate: async (_fn, _coords) => ({ chatId: selected, insideChat: null }),
  mouse: {
    click: async () => { events.push("click"); current = selected; },
    wheel: async () => { events.push("scroll"); },
  },
  keyboard: { press: async key => { events.push("key:" + key); } },
};
const store = {
  sync(id, items) {
    events.push("persist:" + id);
    return { seen: new Map(), added: [...items] };
  },
  getMessages: () => [{ kind: "text", text: "archived", uid: "test" }],
};
const session = new Session({
  store, media: {}, config: { patterns: {}, fullSyncIntervalMs: 60000 }, profileDir: "/tmp/snapbot-live-archive",
});
session.status = "connected";
session.accountId = "test";
session.chats = [
  { id: "first", name: "First" }, { id: "second", name: "Second" },
];
session.bot = {
  page,
  browser: { pages: async () => [page] },
  visibleChatId: async () => current,
  readMessages: async id => readable && id === current
    ? [{ kind: "text", text: "message " + id, from: "Friend", isMe: false, time: "" }]
    : null,
  openChat: async id => { events.push("open:" + id); current = id; return true; },
  typeMessage: async () => events.push("type"),
};
session.screenPage = page;
const outcomes = [];
session.on("chat:archive", data => outcomes.push(data));

await session.click(.5, .5);
assert.deepEqual(events.slice(0, 3), ["persist:first", "click", "persist:second"],
  "visible content is committed before navigation and newly opened chat is committed immediately");
assert.equal(outcomes.at(-1).captured, true);
assert.equal(outcomes.at(-1).complete, true);

events.length = 0;
current = "first";
readable = false;
await assert.rejects(session.click(.5, .5), /Navigation stopped/);
assert.ok(!events.includes("click"), "do not navigate away from a chat that could not be archived");
assert.equal(outcomes.at(-1).captured, false);

readable = true;
events.length = 0;
current = "first";
const interactive = await session.syncChat("second", { interactive: true });
assert.equal(interactive.captured, true);
assert.deepEqual(events.slice(0, 3), ["persist:first", "open:second", "persist:second"],
  "bot-initiated interactive opens must flush the previous chat first");

events.length = 0;
await session.scroll(300);
assert.deepEqual(events.slice(0, 3), ["persist:second", "scroll", "persist:second"],
  "live scrolling must save both the outgoing and newly rendered view");
assert.ok(!outcomes.at(-1).reason, "scroll remains a background save without a noisy archive event");

console.log("Live archive regression passed: click, bot open, failed save, history scroll.");
