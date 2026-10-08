import { EventEmitter } from "events";
import crypto from "crypto";

// How many consecutive syncs a message must be missing from Snapchat before
// we treat it as deleted. Guards against half-loaded chats wiping messages.
const MISSING_THRESHOLD = 2;
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

function messageId(chatId, msg, occurrence) {
  return crypto
    .createHash("sha1")
    .update(`${chatId}\u0000${msg.from}\u0000${msg.text}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 16);
}

function toMessage(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    from: row.from_name,
    isMe: !!row.is_me,
    text: row.text,
    time: row.time,
    pos: row.pos,
    firstSeenAt: row.first_seen_at,
    expiresAt: row.expires_at,
  };
}

// Keeps only messages that still exist on Snapchat and are younger than the TTL,
// for one account. Emits: message:new, message:deleted, message:expired, chat:snapshot
export default class MessageStore extends EventEmitter {
  constructor({ db, accountId, ttlMs }) {
    super();
    this.db = db;
    this.accountId = accountId;
    this.ttlMs = ttlMs;
    this.missing = new Map(); // messageId -> consecutive syncs missing
    const q = (sql) => db.prepare(sql);
    this.sql = {
      chatMessages: q(`SELECT * FROM messages WHERE account_id = ? AND chat_id = ? ORDER BY pos`),
      chatIds: q(`SELECT DISTINCT chat_id FROM messages WHERE account_id = ?`),
      previews: q(`
        SELECT m.* FROM messages m
        JOIN (SELECT chat_id, MAX(pos) AS pos FROM messages
              WHERE account_id = ? GROUP BY chat_id) last
          ON m.chat_id = last.chat_id AND m.pos = last.pos
        WHERE m.account_id = ?`),
      counts: q(`SELECT chat_id, COUNT(*) AS n FROM messages WHERE account_id = ? GROUP BY chat_id`),
      insert: q(`INSERT INTO messages
        (account_id, id, chat_id, from_name, is_me, text, time, pos, first_seen_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setPos: q(`UPDATE messages SET pos = ? WHERE account_id = ? AND id = ?`),
      remove: q(`DELETE FROM messages WHERE account_id = ? AND id = ?`),
      expired: q(`SELECT id, chat_id FROM messages WHERE account_id = ? AND expires_at <= ?`),
      tombstones: q(`SELECT id FROM tombstones WHERE account_id = ? AND chat_id = ?`),
      addTombstone: q(`INSERT OR REPLACE INTO tombstones (account_id, id, chat_id, at) VALUES (?, ?, ?, ?)`),
      removeTombstone: q(`DELETE FROM tombstones WHERE account_id = ? AND id = ?`),
      pruneTombstones: q(`DELETE FROM tombstones WHERE account_id = ? AND at < ?`),
      clearMessages: q(`DELETE FROM messages WHERE account_id = ?`),
      clearTombstones: q(`DELETE FROM tombstones WHERE account_id = ?`),
    };
    this.sweep();
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getMessages(chatId) {
    return this.sql.chatMessages.all(this.accountId, chatId).map(toMessage);
  }

  chatIds() {
    return this.sql.chatIds.all(this.accountId).map((r) => r.chat_id);
  }

  // { [chatId]: { last: Message, count } } for the chat list
  previews() {
    const counts = Object.fromEntries(
      this.sql.counts.all(this.accountId).map((r) => [r.chat_id, r.n])
    );
    const out = {};
    for (const row of this.sql.previews.all(this.accountId, this.accountId)) {
      out[row.chat_id] = { last: toMessage(row), count: counts[row.chat_id] || 0 };
    }
    return out;
  }

  // Reconciles a fresh scrape of a chat with what we have stored.
  // `scraped` is the full list Snapchat is currently showing for that chat.
  sync(chatId, scraped) {
    const now = Date.now();
    const stored = new Map(this.getMessages(chatId).map((m) => [m.id, m]));
    const tombstones = new Set(
      this.sql.tombstones.all(this.accountId, chatId).map((r) => r.id)
    );
    const seen = new Set();
    const counts = new Map();
    const added = [];
    const deleted = [];

    this.tx(() => {
      scraped.forEach((msg, pos) => {
        const key = `${msg.from}\u0000${msg.text}`;
        const occurrence = counts.get(key) || 0;
        counts.set(key, occurrence + 1);

        const id = messageId(chatId, msg, occurrence);
        seen.add(id);
        this.missing.delete(id);
        if (tombstones.has(id)) return;
        if (stored.has(id)) {
          if (stored.get(id).pos !== pos) this.sql.setPos.run(pos, this.accountId, id);
          return;
        }
        const message = {
          id,
          chatId,
          from: msg.from,
          isMe: !!msg.isMe,
          text: msg.text,
          time: msg.time || "",
          pos,
          firstSeenAt: now,
          expiresAt: now + this.ttlMs,
        };
        this.sql.insert.run(
          this.accountId, id, chatId, message.from, message.isMe ? 1 : 0,
          message.text, message.time, pos, now, message.expiresAt
        );
        added.push(message);
      });

      // once an expired message is gone from Snapchat too, forget it so an
      // identical new message later isn't hidden
      for (const id of tombstones) {
        if (!seen.has(id)) this.sql.removeTombstone.run(this.accountId, id);
      }

      for (const id of stored.keys()) {
        if (seen.has(id)) continue;
        const misses = (this.missing.get(id) || 0) + 1;
        if (misses < MISSING_THRESHOLD) {
          this.missing.set(id, misses);
          continue;
        }
        this.missing.delete(id);
        this.sql.remove.run(this.accountId, id);
        deleted.push(id);
      }
    });

    for (const message of added) this.emit("message:new", message);
    for (const id of deleted) this.emit("message:deleted", { id, chatId });
    this.emit("chat:snapshot", { chatId, messages: this.getMessages(chatId) });
  }

  // Drops anything past its TTL, Snapchat-style.
  sweep() {
    const now = Date.now();
    const expired = this.sql.expired.all(this.accountId, now);
    this.tx(() => {
      for (const { id, chat_id } of expired) {
        this.sql.remove.run(this.accountId, id);
        this.sql.addTombstone.run(this.accountId, id, chat_id, now);
        this.missing.delete(id);
      }
      this.sql.pruneTombstones.run(this.accountId, now - TOMBSTONE_MS);
    });
    for (const { id, chat_id } of expired) {
      this.emit("message:expired", { id, chatId: chat_id });
    }
  }

  clear() {
    this.missing.clear();
    this.tx(() => {
      this.sql.clearMessages.run(this.accountId);
      this.sql.clearTombstones.run(this.accountId);
    });
  }
}
