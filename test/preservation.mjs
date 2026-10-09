// Preserve already-captured content without secretly opening unread Snapchat
// conversations. Test against the real SQLite store and mock browser session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { openDb, createCipher } from "../server/db.js";
import MediaStorage from "../server/media.js";
import AccountManager from "../server/accounts.js";
import MockBot from "../server/mockBot.js";
import { group } from "../web/src/message-groups.js";

// A Snapchat nickname update must relabel archived incoming bubbles without
// altering stored sender data, outgoing messages or system event provenance.
const archived = [
  { uid: "old", from: "TWIN BRO", isMe: false, kind: "text", text: "hello" },
  { uid: "mine", from: "Me", isMe: true, kind: "text", text: "hi" },
  { uid: "status", from: "Snapchat", isMe: false, kind: "status", text: "Saved a snap" },
];
const renamedGroups = group(archived, "ASHLEY");
assert.equal(renamedGroups[0].from, "ASHLEY");
assert.equal(renamedGroups[1].from, "Me");
assert.equal(renamedGroups[2].from, "Snapchat");
assert.equal(archived[0].from, "TWIN BRO", "the archived sender must stay unchanged");
assert.equal(group(archived)[0].from, "TWIN BRO", "existing callers retain old behavior");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-passive-archive-"));
let db, accounts;
try {
  db = openDb(root);
  const config = {
    dataDir: root, ttlMs: 0, syncIntervalMs: 1e9, fullSyncIntervalMs: 1e9,
    maxAccounts: 3, headless: true, secretKey: "test", mediaUrlTtl: 300,
    captureSnaps: false, snapsPerSync: 0, blockedRequests: [], patterns: {},
    r2: {}, publicUrl: "http://localhost:9999",
  };
  const media = new MediaStorage(config);
  accounts = new AccountManager({ db, cipher: createCipher("test"), media, config, BotClass: MockBot });
  const acc = accounts.create({ label: "Test", username: "me", password: "pw" });
  const entry = accounts.get(acc.id);
  for (let i=0; i<80 && entry.session.status !== "connected"; i++)
    await new Promise(r => setTimeout(r, 75));
  assert.equal(entry.session.status, "connected");
  entry.session.stopLoop();
  await entry.session.syncChats();
  assert.equal(entry.session.bot.lastOpenedId, undefined, "passive startup must not open any conversation");
  assert.equal(entry.store.getMessages("sam").length, 0, "unread content is not silently opened");

  const action = await entry.session.syncChat("sam", { interactive:true });
  assert.equal(action.captured, true);
  assert.equal(entry.session.bot.lastOpenedId, "sam");
  let messages = await accounts.messages(acc.id, "sam");
  const photo = messages.find(m => m.kind === "media");
  const snap = messages.find(m => m.kind === "snap");
  assert.equal(photo?.media[0]?.status, "stored", "already loaded image blob is captured");
  assert.ok(photo.media[0].url);
  assert.equal(snap.media.length, 0, "unopened Snap remains unopened and uncaptured");

  entry.session.bot.simulate();
  await entry.session.syncChats(); // detects activity without opening other chats
  assert.equal(entry.session.bot.lastOpenedId, "sam");
  messages = await accounts.messages(acc.id, "sam");
  assert.ok(messages.some(m => m.text === "secret 1"), "captures content only in existing visible chat");
  const capturedCount = messages.length;
  entry.session.bot.chats.sam.messages = entry.session.bot.chats.sam.messages.filter(m => m.text !== "secret 1");
  await entry.session.syncChats();
  messages = await accounts.messages(acc.id, "sam");
  assert.ok(messages.some(m => m.text === "secret 1"), "passive partial DOM cannot erase archive history");
  assert.ok(messages.length >= capturedCount);
  console.log("Passive archive test passed: no automatic opening, loaded photo capture, no Snap viewing, preserved archive");
} finally {
  if (accounts) await accounts.stopAll();
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
