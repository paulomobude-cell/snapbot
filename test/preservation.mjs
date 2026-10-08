// Automatic archiving regression test. Runs the real store/session/
// accounts stack against the mock bot (no Snapchat, no browser).
//   node test/preservation.mjs
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { openDb, createCipher } from "../server/db.js";
import MediaStorage from "../server/media.js";
import AccountManager from "../server/accounts.js";
import MockBot from "../server/mockBot.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, name);
  console.log("✓", name);
  passed++;
};

function makeAccounts(dir) {
  const db = openDb(dir);
  const config = {
    dataDir: dir, ttlMs: 0, syncIntervalMs: 9e9, fullSyncIntervalMs: 9e9, maxAccounts: 9,
    headless: true, secretKey: "k", mediaUrlTtl: 3600, captureSnaps: true, snapsPerSync: 5,
    blockedRequests: [], patterns: {}, r2: {}, publicUrl: "http://localhost:9999",
  };
  const media = new MediaStorage({ ...config });
  const accounts = new AccountManager({ db, cipher: createCipher("k"), media, config, BotClass: MockBot });
  return { db, media, accounts };
}

async function connected(accounts, id) {
  const { session } = accounts.get(id);
  for (let i = 0; i < 60; i++) {
    if (session.status === "connected") return;
    await sleep(100);
  }
  throw new Error(`account not connected: ${session.status}`);
}

// 1) archive messages without a peer-code handshake
async function testArchive(root) {
  const dir = fs.mkdtempSync(path.join(root, "archive-"));
  const { db, accounts } = makeAccounts(dir);
  const main = accounts.create({ label: "Main", username: "me", password: "pw" });
  await connected(accounts, main.id);
  const A = accounts.get(main.id);
  A.session.stopLoop();
  await A.session.syncChats();
  await A.session.syncChat("sam");
  A.session.bot.simulate();
  await A.session.syncChat("sam");
  await A.session.syncChat("sam");
  const archived = A.store.getMessages("sam").filter((m) => m.state !== "live");
  check("automatic archiving keeps removed messages", archived.length > 0);
  check("archived message text stays readable", archived.every((m) => m.display === m.text));
  await accounts.stopAll();
  db.close();
}

// 2) deleted media & viewed view-once snaps still render
async function testDeletedMedia(root) {
  const dir = fs.mkdtempSync(path.join(root, "media-"));
  const { db, media, accounts } = makeAccounts(dir);

  accounts.create({ label: "Sam", username: "sam", password: "pw" }); // makes "sam" chat linkable
  const main = accounts.create({ label: "Main", username: "me", password: "pw" });
  await connected(accounts, main.id);
  const A = accounts.get(main.id);
  A.session.stopLoop();
  await A.session.syncChats();
  await A.session.syncChat("sam");
  await A.session.syncChat("sam");

  let msgs = await accounts.messages(main.id, "sam");
  const photo = msgs.find((m) => m.kind === "media");
  const snap = msgs.find((m) => m.kind === "snap");
  check("photo captured with url", photo?.media[0]?.status === "stored" && !!photo.media[0].url);
  check("view-once snap captured with url", snap?.media[0]?.status === "stored" && !!snap.media[0].url);

  // sender deletes the photo; the snap disappears after viewing
  const bot = A.session.bot;
  bot.chats.sam.messages = bot.chats.sam.messages.filter((m) => m.kind !== "media");
  (bot.notices.sam ||= []).push({ from: "Sam", text: "Sam deleted a chat", ttl: 2 });
  bot.chats.sam.messages = bot.chats.sam.messages.filter((m) => m.kind !== "snap");
  await A.session.syncChat("sam");
  await A.session.syncChat("sam");

  msgs = await accounts.messages(main.id, "sam");
  const dphoto = msgs.find((m) => m.uid === photo.uid);
  const dsnap = msgs.find((m) => m.uid === snap.uid);
  check("deleted photo still present & marked", dphoto && dphoto.state !== "live");
  check("deleted photo still renders", dphoto?.media[0]?.status === "stored" && !!dphoto.media[0].url);
  check("gone view-once snap still present & marked", dsnap && dsnap.state !== "live");
  check("gone view-once snap still renders", dsnap?.media[0]?.status === "stored" && !!dsnap.media[0].url);
  check("snap keeps its view-once flag", dsnap?.media[0]?.viewOnce === true);
  const key = A.store.getMedia(dsnap.media[0].id)?.storageKey;
  check("snap bytes still on disk", key && fs.existsSync(media.localPath(key)));

  await accounts.stopAll();
  db.close();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-test-"));
try {
  await testArchive(root);
  await testDeletedMedia(root);
  console.log(`\n${passed} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
