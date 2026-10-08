import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "snapbot.db"));
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
      id            TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      from_name     TEXT NOT NULL,
      is_me         INTEGER NOT NULL,
      text          TEXT NOT NULL,
      time          TEXT NOT NULL,
      pos           INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat ON messages (account_id, chat_id);
    CREATE INDEX IF NOT EXISTS messages_expiry ON messages (expires_at);

    -- ids of messages that hit the TTL while Snapchat still showed them
    CREATE TABLE IF NOT EXISTS tombstones (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      id         TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      at         INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    );

    -- activity feed; never holds message text, so deleted content isn't kept
    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      chat_id    TEXT,
      detail     TEXT,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_account ON events (account_id, seq);
  `);
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
