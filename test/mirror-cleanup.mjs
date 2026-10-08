import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/db.js";
import { purgeProvenEmptyLegacy } from "../server/cleanup-empty-legacy.js";
import { mirrorPoint } from "../web/src/mirror.js";

const bounds = { left: 0, top: 0, width: 1200, height: 900 };
assert.deepEqual(mirrorPoint(600, 450, bounds, 1920, 1080), { x: .5, y: .5 });
assert.equal(mirrorPoint(600, 30, bounds, 1920, 1080), null, "letterbox must not click Snapchat");
assert.equal(mirrorPoint(600, 870, bounds, 1920, 1080), null, "lower letterbox ignored");
assert.equal(mirrorPoint(5, 450, bounds, 0, 1080), null);
assert.ok(mirrorPoint(300, 281.25, bounds, 1920, 1080)?.x === .25);
console.log("✓ Click mapping ignores letterbox and maps screenshot pixels safely");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-safe-cleanup-"));
const db = openDb(dir);
const make = (id, username = null) => db.prepare(
  "INSERT INTO accounts (id, label, username, secret, created_at) VALUES (?, 'test', ?, null, ?)"
).run(id, username, Date.now());
try {
  make("empty-placeholder");
  make("real-with-username", "my-snapchat");
  make("has-profile");
  make("has-message");
  make("has-media");
  make("has-event");
  make("has-tombstone");

  fs.mkdirSync(path.join(dir, "profiles", "has-profile"), { recursive: true });
  db.prepare(`INSERT INTO messages
    (account_id,id,uid,chat_id,kind,from_name,is_me,text,time,ord,state,first_seen_at)
    VALUES ('has-message','m','unique-message-uid','chat','text','X',0,'keep','now',1,'live',?)`)
    .run(Date.now());
  db.prepare(`INSERT INTO media
    (id, account_id, message_uid, kind, view_once, status, created_at)
    VALUES ('media','has-media','someuid','image',0,'stored',?)`).run(Date.now());
  db.prepare("INSERT INTO events (account_id, type, at) VALUES ('has-event','status',?)").run(Date.now());
  db.prepare("INSERT INTO tombstones (account_id,id,chat_id,at) VALUES ('has-tombstone','t','chat',?)").run(Date.now());

  assert.equal(purgeProvenEmptyLegacy(db, dir), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id='empty-placeholder'").get().n, 0);
  for (const id of ["real-with-username","has-profile","has-message","has-media","has-event","has-tombstone"]) {
    assert.ok(db.prepare("SELECT id FROM accounts WHERE id=?").get(id), id + " must remain");
  }
  assert.equal(purgeProvenEmptyLegacy(db, dir), 0, "repeated startup must not delete more");
  console.log("✓ Safe cleanup only removes empty placeholders; usernames, profiles and all archive types survive");
} finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
