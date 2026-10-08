import path from "path";
import fs from "node:fs";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "snapbot.db"));
  // A one-time SQLite-consistent snapshot before introducing Comnexus users.
  // VACUUM INTO captures outstanding WAL changes; a plain file copy would not.
  // If space is exhausted, abort rather than risk modifying the only archive.
  const hasExistingAccounts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
  const alreadyMigrated = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_users'").get();
  if (hasExistingAccounts && !alreadyMigrated) {
    const backupDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, "snapbot-pre-comnexus-" + Date.now() + ".sqlite");
    db.exec("VACUUM INTO '" + backupFile.replace(/'/g, "''") + "'");
    console.log("Pre-Comnexus SQLite backup created:", backupFile);
  }
  // v3 archives messages instead of dropping them; older message tables only
  // held what Snapchat still showed, so they're rebuilt from the next sync
  if (db.prepare("PRAGMA user_version").get().user_version < 3) {
    db.exec("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS tombstones;");
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      username    TEXT,
      secret      TEXT,            -- encrypted password, only if "remember" was ticked
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,   -- content-derived; suffixed once the message leaves Snapchat
      uid           TEXT NOT NULL,   -- never changes; media points here
      chat_id       TEXT NOT NULL,
      kind          TEXT NOT NULL,   -- text | media | snap
      from_name     TEXT NOT NULL,
      is_me         INTEGER NOT NULL,
      text          TEXT NOT NULL,
      time          TEXT NOT NULL,
      ord           REAL NOT NULL,   -- display order, stable as Snapchat drops messages
      state         TEXT NOT NULL DEFAULT 'live', -- live | deleted (by sender) | gone (cleared by Snapchat)
      first_seen_at INTEGER NOT NULL,
      changed_at    INTEGER,
      PRIMARY KEY (account_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat ON messages (account_id, chat_id, ord);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_uid ON messages (uid);

    CREATE TABLE IF NOT EXISTS media (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      message_uid  TEXT NOT NULL,
      kind         TEXT NOT NULL,     -- image | video
      view_once    INTEGER NOT NULL,  -- tap-to-view snap
      status       TEXT NOT NULL,     -- pending | stored | failed
      storage_key  TEXT,
      content_type TEXT,
      size         INTEGER,
      sha256       TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_message ON media (message_uid);

    -- ids of messages removed by MESSAGE_TTL_HOURS while Snapchat still showed them
    CREATE TABLE IF NOT EXISTS tombstones (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      id         TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      at         INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    );

    -- activity feed
    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      chat_id    TEXT,
      detail     TEXT,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_account ON events (account_id, seq);
    PRAGMA user_version = 4;
  `);
  // Add tenant ownership without dropping or rewriting any existing archive.
  // Legacy accounts deliberately remain unassigned until an admin claims them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      key_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id, created_at);
    CREATE TABLE IF NOT EXISTS admin_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target TEXT,
      client_hash TEXT,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      scope TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    );
  `);
  const existingColumns = db.prepare("PRAGMA table_info(accounts)").all().map((col) => col.name);
  if (!existingColumns.includes("owner_user_id")) {
    db.exec("ALTER TABLE accounts ADD COLUMN owner_user_id TEXT REFERENCES app_users(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts(owner_user_id)");
  db.exec("PRAGMA user_version = 5");
  return db;
}

// AES-256-GCM for stored passwords; key comes from SECRET_KEY (or API_TOKEN)
export function createCipher(secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
    },
    decrypt(payload) {
      try {
        const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        return null; // key changed
      }
    },
  };
}
