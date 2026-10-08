import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, createCipher } from "../server/db.js";
import { TenantAuth } from "../server/tenant-auth.js";
import AccountManager from "../server/accounts.js";
import MediaStorage from "../server/media.js";
import MockBot from "../server/mockBot.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-tenant-"));
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log("✓", name); };
let db;
let manager;
try {
  db = openDb(dir);
  const legacyId = "legacy-account";
  db.prepare("INSERT INTO accounts (id,label,username,secret,created_at) VALUES (?,?,'legacy',NULL,?)")
    .run(legacyId, "Saved Snapchat", Date.now());
  db.prepare(`INSERT INTO messages
    (account_id,id,uid,chat_id,kind,from_name,is_me,text,time,ord,state,first_seen_at)
    VALUES (?, 'old', 'legacy-uid', 'chat', 'text', 'Friend', 0, 'old archived chat', 'now', 1, 'gone', ?)`)
    .run(legacyId, Date.now());
  db.close();
  db = openDb(dir);

  check("pre-existing archives are retained", db.prepare("SELECT text FROM messages WHERE account_id=?").get(legacyId).text === "old archived chat");
  check("legacy Snapchat sessions are unclaimed", db.prepare("SELECT owner_user_id FROM accounts WHERE id=?").get(legacyId).owner_user_id === null);

  const auth = new TenantAuth(db, { adminToken: "admin-".repeat(7) });
  const alice = auth.signup("+1 (202) 555-0140", "correct-horse-battery");
  const bob = auth.signup("+1 (202) 555-0141", "another-strong-password");
  check("distinct Comnexus tenant users", alice.user.id !== bob.user.id);
  check("user API key is not stored in plaintext", !db.prepare("SELECT * FROM app_users WHERE id=?").get(alice.user.id).api_key_hash.includes(alice.apiKey));
  check("API key resolves only its owner", auth.resolve(alice.apiKey).id === alice.user.id);
  check("service token cannot resolve as a user", !auth.resolve("f".repeat(64)));
  assert.throws(() => auth.login(alice.user.phone, "wrong-password"), /Invalid/);
  check("wrong password refused", true);
  const second = auth.login(alice.user.phone, "correct-horse-battery");
  check("second-device sign-in doesn't revoke original device", auth.resolve(alice.apiKey)?.id === alice.user.id && auth.resolve(second.apiKey)?.id === alice.user.id);
  check("one device can log out without revoking another", auth.revoke(second.apiKey) && !auth.resolve(second.apiKey) && !!auth.resolve(alice.apiKey));
  check("admin token is separate from user credentials", auth.checkAdmin("admin-".repeat(7)) && !auth.checkAdmin(alice.apiKey));
  assert.throws(() => auth.recover(alice.user.phone, "0".repeat(48), "new-strong-password"), /Invalid/);
  const recovered = auth.recover(alice.user.phone, alice.recoveryCode, "new-strong-password");
  check("recovery revokes all previous sessions", !auth.resolve(alice.apiKey) && !auth.resolve(second.apiKey) && auth.resolve(recovered.apiKey)?.id === alice.user.id);
  assert.throws(() => auth.recover(alice.user.phone, alice.recoveryCode, "new-strong-password"), /Invalid/);
  check("recovery codes are single-use", true);

  const cfg = {
    dataDir: dir, ttlMs: 0, syncIntervalMs: 9e9, fullSyncIntervalMs: 9e9,
    maxAccounts: 10, headless: true, secretKey: "secret", mediaUrlTtl: 300,
    captureSnaps: true, snapsPerSync: 1, blockedRequests: [], patterns: {},
    publicUrl: "http://localhost:3001", r2: {},
  };
  const media = new MediaStorage(cfg);
  manager = new AccountManager({ db, cipher: createCipher("secret"), media, config: cfg, BotClass: MockBot });
  manager.startAll();
  check("legacy sessions hidden from all newly registered users", manager.list(alice.user.id).length === 0 && manager.list(bob.user.id).length === 0);
  const claimed = manager.claim(alice.user.id, legacyId);
  check("admin claim preserves historic message and profile id", claimed.id === legacyId &&
    db.prepare("SELECT text FROM messages WHERE account_id=?").get(legacyId).text === "old archived chat");
  check("claimed account only visible to assigned tenant", manager.list(alice.user.id).length === 1 && manager.list(bob.user.id).length === 0);
  assert.throws(() => manager.owned(bob.user.id, legacyId), /Account not found/);
  check("cross-tenant account access blocked", manager.owned(alice.user.id, legacyId).account.id === legacyId);
  assert.throws(() => manager.claim(bob.user.id, legacyId), /Only unassigned/);
  check("claimed sessions cannot be reassigned", true);

  const secondary = manager.create({ label: "Bob Snapchat", ownerId: bob.user.id });
  check("new accounts are owned by requesting tenant", manager.owned(bob.user.id, secondary.id).account.owner_user_id === bob.user.id);
  assert.throws(() => manager.owned(alice.user.id, secondary.id), /Account not found/);
  check("new-account cross-tenant access blocked", true);
  await manager.removeAllForOwner(bob.user.id);
  check("one user's removal doesn't erase another's archive", manager.list(alice.user.id).length === 1 &&
    db.prepare("SELECT text FROM messages WHERE account_id=?").get(legacyId).text === "old archived chat");

  // Media stored on the volume before R2 was enabled must remain accessible.
  const r2 = new MediaStorage({ ...cfg, r2: {
    accountId: "000000", accessKeyId: "fake", secretAccessKey: "fake", bucket: "test",
  } });
  const mediaKey = "legacy-account/chat/media.jpg";
  await fs.promises.mkdir(path.dirname(r2.localPath(mediaKey)), { recursive: true });
  await fs.promises.writeFile(r2.localPath(mediaKey), "old-media-bytes");
  const mediaUrl = await r2.url(mediaKey, 300);
  const u = new URL(mediaUrl);
  check("R2 switch serves previously saved local objects", u.hostname === "localhost" &&
    r2.verify(mediaKey, u.searchParams.get("exp"), u.searchParams.get("sig")));

  console.log("\n" + checks + " Comnexus tenant regression checks passed");
} finally {
  if (manager) await manager.stopAll();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
