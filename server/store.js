import { EventEmitter } from "events";
import crypto from "crypto";

// How many consecutive syncs a message must be missing from Snapchat before we
// decide it left. Guards against half-loaded chats.
const MISSING_THRESHOLD = 2;
// A "gone" message that shows up again this soon was just scrolled out of view
const REVIVE_WINDOW_MS = 30 * 60 * 1000;
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 300;
export const DELETED_MARK = "🗑️";

const hash = (...parts) =>
  crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);

function identity(item) {
  if (item.kind === "notice" || item.kind === "status") return `e\u0000${item.from}\u0000${item.text}`;
  if (item.kind === "media") return `m\u0000${item.from}\u0000${item.sha256 || "unread"}\u0000${item.text}`;
  if (item.kind === "snap") return `s\u0000${item.from}`;
  return `t\u0000${item.from}\u0000${item.text}`;
}

const sameSender = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function toMessage(row) {
  const deleted = row.state === "deleted";
  return {
    id: row.id,
    uid: row.uid,
    chatId: row.chat_id,
    kind: row.kind,
    from: row.from_name,
    isMe: !!row.is_me,
    text: row.text,
    // what to show: deleted ones keep their content with the bin in front
    display: row.text,
    time: row.time,
    ord: row.ord,
    state: row.state,
    firstSeenAt: row.first_seen_at,
    changedAt: row.changed_at,
    media: [],
  };
}

function toMedia(row) {
  return {
    id: row.id,
    messageUid: row.message_uid,
    kind: row.kind,
    viewOnce: !!row.view_once,
    status: row.status,
    retryAt: row.retry_at,
    lastError: row.last_error,
    attempts: row.attempts,
    contentType: row.content_type,
    size: row.size,
    storageKey: row.storage_key,
  };
}

// Archive of one account's chats. Messages are never dropped when they leave
// Snapchat: they're marked deleted (sender deleted it) or gone (Snapchat cleared
// it), and only MESSAGE_TTL_HOURS (off by default) removes non-deleted ones.
// Emits: message:new, message:updated, chat:snapshot, media:purge
export default class MessageStore extends EventEmitter {
  constructor({ db, accountId, ttlMs }) {
    super();
    this.db = db;
    this.accountId = accountId;
    this.ttlMs = ttlMs;
    this.missing = new Map(); // id -> consecutive syncs missing
    this.usedNotices = new Map(); // chatId -> Set of notice keys already matched
    const q = (sql) => db.prepare(sql);
    this.sql = {
      page: q(`SELECT * FROM (SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND ord < ?
               ORDER BY ord DESC LIMIT ?) ORDER BY ord`),
      live: q(`SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND state = 'live'`),
      maxOrd: q(`SELECT MAX(ord) AS m FROM messages WHERE account_id = ? AND chat_id = ?`),
      byId: q(`SELECT * FROM messages WHERE account_id = ? AND id = ?`),
      byUid: q(`SELECT * FROM messages WHERE uid = ?`),
      revivable: q(`SELECT * FROM messages WHERE account_id = ? AND chat_id = ? AND state = 'gone'
                    AND id LIKE ? AND changed_at > ? ORDER BY changed_at DESC LIMIT 1`),
      chatIds: q(`SELECT DISTINCT chat_id FROM messages WHERE account_id = ?`),
      previews: q(`
        SELECT m.* FROM messages m
        JOIN (SELECT chat_id, MAX(ord) AS ord FROM messages WHERE account_id = ? AND kind != 'status' GROUP BY chat_id) last
          ON m.chat_id = last.chat_id AND m.ord = last.ord
        WHERE m.account_id = ? AND m.kind != 'status'`),
      counts: q(`SELECT chat_id, SUM(kind != 'status') AS n, SUM(state = 'deleted' AND kind != 'status') AS deleted
                 FROM messages WHERE account_id = ? GROUP BY chat_id`),
      insert: q(`INSERT INTO messages
        (account_id, id, uid, chat_id, kind, from_name, is_me, text, time, ord, state, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`),
      setState: q(`UPDATE messages SET id = ?, state = ?, changed_at = ? WHERE account_id = ? AND id = ?`),
      expired: q(`SELECT * FROM messages WHERE account_id = ? AND state != 'deleted' AND first_seen_at <= ?`),
      remove: q(`DELETE FROM messages WHERE account_id = ? AND id = ?`),
      tombstones: q(`SELECT id FROM tombstones WHERE account_id = ? AND chat_id = ?`),
      addTombstone: q(`INSERT OR REPLACE INTO tombstones (account_id, id, chat_id, at) VALUES (?, ?, ?, ?)`),
      removeTombstone: q(`DELETE FROM tombstones WHERE account_id = ? AND id = ?`),
      pruneTombstones: q(`DELETE FROM tombstones WHERE account_id = ? AND at < ?`),
      // archived-message cleanup
      chatMediaKeys: q(`SELECT storage_key FROM media WHERE account_id = ? AND storage_key IS NOT NULL
        AND message_uid IN (SELECT uid FROM messages WHERE account_id = ? AND chat_id = ?)`),
      removeChatMedia: q(`DELETE FROM media WHERE account_id = ? AND message_uid IN
        (SELECT uid FROM messages WHERE account_id = ? AND chat_id = ?)`),
      removeChatMessages: q(`DELETE FROM messages WHERE account_id = ? AND chat_id = ?`),
      removeChatArchived: q(`DELETE FROM messages WHERE account_id = ? AND chat_id = ? AND state != 'live'`),
      chatArchivedMediaKeys: q(`SELECT storage_key FROM media WHERE account_id = ? AND storage_key IS NOT NULL
        AND message_uid IN (SELECT uid FROM messages WHERE account_id = ? AND chat_id = ? AND state != 'live')`),
      removeChatArchivedMedia: q(`DELETE FROM media WHERE account_id = ? AND message_uid IN
        (SELECT uid FROM messages WHERE account_id = ? AND chat_id = ? AND state != 'live')`),
      removeChatTombstones: q(`DELETE FROM tombstones WHERE account_id = ? AND chat_id = ?`),
      // media
      mediaFor: q(`SELECT * FROM media WHERE message_uid = ?`),
      mediaById: q(`SELECT * FROM media WHERE id = ? AND account_id = ?`),
      mediaBySha: q(`SELECT * FROM media WHERE account_id = ? AND sha256 = ? AND status = 'stored' LIMIT 1`),
      addMedia: q(`INSERT INTO media (id, account_id, message_uid, kind, view_once, status, created_at)
                   VALUES (?, ?, ?, ?, ?, 'pending', ?)`),
      mediaStored: q(`UPDATE media SET status = 'stored', storage_key = ?, content_type = ?, size = ?,
                      sha256 = ?, kind = ?, retry_at = NULL, last_error = NULL WHERE id = ?`),
      mediaFailed: q(`UPDATE media SET attempts = attempts + 1, status = 'failed',
                      retry_at = ?, last_error = ? WHERE id = ?`),
      mediaKeysFor: q(`SELECT storage_key FROM media WHERE message_uid = ? AND storage_key IS NOT NULL`),
      removeMedia: q(`DELETE FROM media WHERE message_uid = ?`),
      keyInUse: q(`SELECT COUNT(*) AS n FROM media WHERE storage_key = ?`),
      allKeys: q(`SELECT storage_key FROM media WHERE account_id = ? AND storage_key IS NOT NULL`),
      clearMessages: q(`DELETE FROM messages WHERE account_id = ?`),
      clearMedia: q(`DELETE FROM media WHERE account_id = ?`),
      clearTombstones: q(`DELETE FROM tombstones WHERE account_id = ?`),
    };
    this.sweep();
  }

  tx(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  withMedia(row) {
    const message = toMessage(row);
    message.media = this.sql.mediaFor.all(row.uid).map(toMedia);
    return message;
  }

  // newest PAGE_SIZE messages, or the page before `beforeOrd`
  getMessages(chatId, { beforeOrd = Infinity, limit = PAGE_SIZE } = {}) {
    const before = Number.isFinite(beforeOrd) ? beforeOrd : Number.MAX_VALUE;
    return this.sql.page.all(this.accountId, chatId, before, limit).map((r) => this.withMedia(r));
  }

  // live message by its current id
  getById(id) {
    const row = this.sql.byId.get(this.accountId, id);
    return row ? this.withMedia(row) : null;
  }

  getMessage(uid) {
    const row = this.sql.byUid.get(uid);
    return row && row.account_id === this.accountId ? this.withMedia(row) : null;
  }

  chatIds() {
    return this.sql.chatIds.all(this.accountId).map((r) => r.chat_id);
  }

  // { [chatId]: { last, count, deleted } } for the chat list
  previews() {
    const counts = Object.fromEntries(
      this.sql.counts.all(this.accountId).map((r) => [r.chat_id, r])
    );
    const out = {};
    for (const row of this.sql.previews.all(this.accountId, this.accountId)) {
      const c = counts[row.chat_id] || {};
      out[row.chat_id] = { last: toMessage(row), count: c.n || 0, deleted: c.deleted || 0 };
    }
    return out;
  }

  // Reconcile visible chat messages with the local archive.
  // Messages removed from Snapchat remain available as deleted/gone.
  sync(chatId, items, { preserve = true, reconcileMissing = false } = {}) {
    const now = Date.now();
    const live = new Map(this.sql.live.all(this.accountId, chatId).map((r) => [r.id, r]));
    const tombstones = new Set(this.sql.tombstones.all(this.accountId, chatId).map((r) => r.id));
    const notices = [];
    const entries = []; // { id, item, index }
    const counts = new Map();

    items.forEach((item, index) => {
      if (item.kind === "notice") {
        const key = `${item.from.toLowerCase()}`;
        const n = counts.get(`n\u0000${key}`) || 0;
        counts.set(`n\u0000${key}`, n + 1);
        notices.push({ ...item, index, key: `${key}#${n}` });
        // Keep real status/activity entries in timeline, separate from chat
        // bubbles and excluded from conversation message counts.
        item = { ...item, kind: "status" };
      }
      const key = identity(item);
      const occurrence = counts.get(key) || 0;
      counts.set(key, occurrence + 1);
      entries.push({ id: hash(chatId, key, occurrence), item, index });
    });

    const added = [];
    const updated = [];
    const removed = [];
    const seen = new Map();

    this.tx(() => {
      let maxOrd = this.sql.maxOrd.get(this.accountId, chatId).m ?? 0;
      const ords = entries.map((e) => live.get(e.id)?.ord ?? null);

      entries.forEach((entry, i) => {
        const { id, item } = entry;
        seen.set(id, item);
        this.missing.delete(id);
        if (live.has(id) || tombstones.has(id)) return;

        // scrolled out of view and back: bring the archived copy back to life
        const revived = this.sql.revivable.get(this.accountId, chatId, `${id}~%`, now - REVIVE_WINDOW_MS);
        if (revived) {
          this.sql.setState.run(id, "live", now, this.accountId, revived.id);
          ords[i] = revived.ord;
          updated.push(this.withMedia({ ...revived, id, state: "live", changed_at: now }));
          return;
        }

        let prev = null;
        for (let j = i - 1; j >= 0; j--) if (ords[j] !== null) { prev = ords[j]; break; }
        let next = null;
        for (let j = i + 1; j < ords.length; j++) if (ords[j] !== null) { next = ords[j]; break; }
        let ord;
        if (next === null) ord = ++maxOrd; // newest
        else if (prev === null) ord = next - 1; // older history loaded above
        else ord = (prev + next) / 2;
        ords[i] = ord;
        maxOrd = Math.max(maxOrd, ord);

        const uid = crypto.randomUUID();
        this.sql.insert.run(
          this.accountId, id, uid, chatId, item.kind, item.from, item.isMe ? 1 : 0,
          item.text || "", item.time || "", ord, now
        );
        added.push(this.withMedia(this.sql.byId.get(this.accountId, id)));
      });

      // forget TTL tombstones once Snapchat stops showing the message too
      for (const id of tombstones) {
        if (reconcileMissing && !seen.has(id)) this.sql.removeTombstone.run(this.accountId, id);
      }

      // messages that left Snapchat: deleted by the sender, or cleared by Snapchat
      const used = this.usedNotices.get(chatId) || new Set();
      this.usedNotices.set(chatId, used);
      const indexOf = new Map(entries.map((e) => [e.id, e.index]));
      const sortedLive = [...live.values()].sort((a, b) => a.ord - b.ord);
      for (const row of sortedLive) {
        if (!reconcileMissing || row.kind === "status" || seen.has(row.id)) continue;
        const misses = (this.missing.get(row.id) || 0) + 1;
        if (misses < MISSING_THRESHOLD) {
          this.missing.set(row.id, misses);
          continue;
        }
        this.missing.delete(row.id);

        // not a consented pair: just mirror Snapchat, so drop what it dropped
        if (!preserve) {
          for (const key of this.sql.mediaKeysFor.all(row.uid).map((r) => r.storage_key)) {
            removed.push({ id: row.id, uid: row.uid, chatId, key });
          }
          this.sql.removeMedia.run(row.uid);
          this.sql.remove.run(this.accountId, row.id);
          removed.push({ id: row.id, uid: row.uid, chatId });
          continue;
        }

        // the "X deleted a chat" notice sits where the message was
        const before = sortedLive.filter((r) => r.ord < row.ord && seen.has(r.id)).pop();
        const after = sortedLive.find((r) => r.ord > row.ord && seen.has(r.id));
        const lo = before ? indexOf.get(before.id) : -1;
        const hi = after ? indexOf.get(after.id) : Infinity;
        const inRange = notices.filter((n) => n.index > lo && n.index < hi && !used.has(n.key));
        const bySender = (n) =>
          sameSender(n.from, row.from_name) || (row.is_me && /^(you|me)$/i.test(n.from));
        // names in notices can differ from the chat-list name; a lone notice in the gap is enough
        const notice = inRange.find(bySender) || (inRange.length === 1 ? inRange[0] : null);
        const state = notice ? "deleted" : "gone";
        if (notice) used.add(notice.key);

        const archivedId = `${row.id}~${now.toString(36)}`;
        this.sql.setState.run(archivedId, state, now, this.accountId, row.id);
        updated.push(this.withMedia({ ...row, id: archivedId, state, changed_at: now }));
      }
    });

    for (const message of added) this.emit("message:new", message);
    for (const message of updated) this.emit("message:updated", message);
    for (const r of removed) {
      if (r.key && this.sql.keyInUse.get(r.key).n === 0) this.emit("media:purge", [r.key]);
      else if (!r.key) this.emit("message:removed", { id: r.id, uid: r.uid, chatId: r.chatId });
    }
    this.emit("chat:snapshot", { chatId, messages: this.getMessages(chatId) });
    return { seen, added, preserve };
  }

  // ---- media ----

  addMedia(messageUid, { kind, viewOnce }) {
    const id = crypto.randomUUID();
    this.sql.addMedia.run(id, this.accountId, messageUid, kind, viewOnce ? 1 : 0, Date.now());
    return id;
  }

  storedBySha(sha256) {
    const row = this.sql.mediaBySha.get(this.accountId, sha256);
    return row ? toMedia(row) : null;
  }

  mediaStored(id, { key, contentType, size, sha256, kind }) {
    this.sql.mediaStored.run(key, contentType, size, sha256, kind, id);
  }

  mediaFailed(id, reason = "Media unavailable") {
    const row = this.sql.mediaById.get(id, this.accountId);
    const attempts = (row?.attempts || 0) + 1;
    const nextAt = Date.now() + Math.min(30 * 60_000, 20_000 * (2 ** Math.min(attempts - 1, 6)));
    this.sql.mediaFailed.run(nextAt, String(reason).slice(0, 180), id);
  }

  getMedia(id) {
    const row = this.sql.mediaById.get(id, this.accountId);
    return row ? toMedia(row) : null;
  }

  // re-announce a message after its media changed
  touch(uid) {
    const message = this.getMessage(uid);
    if (message) this.emit("message:updated", message);
  }

  // ---- retention ----

  // MESSAGE_TTL_HOURS > 0 removes old messages; deleted ones are always kept.
  sweep() {
    if (!this.ttlMs) return;
    const now = Date.now();
    const expired = this.sql.expired.all(this.accountId, now - this.ttlMs);
    const keys = [];
    this.tx(() => {
      for (const row of expired) {
        keys.push(...this.sql.mediaKeysFor.all(row.uid).map((r) => r.storage_key));
        this.sql.removeMedia.run(row.uid);
        this.sql.remove.run(this.accountId, row.id);
        if (row.state === "live") this.sql.addTombstone.run(this.accountId, row.id, row.chat_id, now);
        this.missing.delete(row.id);
      }
      this.sql.pruneTombstones.run(this.accountId, now - TOMBSTONE_MS);
    });
    for (const row of expired) {
      this.emit("message:removed", { id: row.id, uid: row.uid, chatId: row.chat_id });
    }
    const orphaned = [...new Set(keys)].filter((k) => this.sql.keyInUse.get(k).n === 0);
    if (orphaned.length) this.emit("media:purge", orphaned);
  }

  // logout: the archive is kept; only the in-memory sync state resets
  resetSync() {
    this.missing.clear();
    this.usedNotices.clear();
  }

  // account removed: everything goes, including stored media
  clear({ purge = true } = {}) {
    const keys = this.sql.allKeys.all(this.accountId).map((r) => r.storage_key);
    this.resetSync();
    this.tx(() => {
      this.sql.clearMedia.run(this.accountId);
      this.sql.clearMessages.run(this.accountId);
      this.sql.clearTombstones.run(this.accountId);
    });
    if (purge && keys.length) this.emit("media:purge", [...new Set(keys)]);
  }
}
