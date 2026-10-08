import { EventEmitter } from "events";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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

// Keeps only messages that still exist on Snapchat and are younger than the TTL.
// Emits: message:new, message:deleted, message:expired, chat:snapshot
export default class MessageStore extends EventEmitter {
  constructor({ dataDir, ttlMs }) {
    super();
    this.ttlMs = ttlMs;
    this.file = path.join(dataDir, "messages.json");
    this.chats = new Map(); // chatId -> Map(messageId -> message)
    this.missing = new Map(); // messageId -> consecutive syncs missing
    // ids that hit the TTL; kept so Snapchat still showing them doesn't revive them
    this.expired = new Map(); // messageId -> { chatId, at }
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      this.expired = new Map(Object.entries(raw.expired || {}));
      for (const [chatId, messages] of Object.entries(raw.chats || {})) {
        this.chats.set(chatId, new Map(messages.map((m) => [m.id, m])));
      }
      this.sweep();
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Store load failed", error);
    }
  }

  serialize() {
    const out = { chats: {}, expired: Object.fromEntries(this.expired) };
    for (const [chatId, messages] of this.chats) {
      out.chats[chatId] = [...messages.values()];
    }
    return JSON.stringify(out);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.promises
        .writeFile(this.file, this.serialize())
        .catch((error) => console.error("Store save failed", error));
    }, 500);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    fs.writeFileSync(this.file, this.serialize());
  }

  getMessages(chatId) {
    const messages = this.chats.get(chatId);
    return messages ? [...messages.values()].sort((a, b) => a.pos - b.pos) : [];
  }

  // Reconciles a fresh scrape of a chat with what we have stored.
  // `scraped` is the full list Snapchat is currently showing for that chat.
  sync(chatId, scraped) {
    const now = Date.now();
    const stored = this.chats.get(chatId) || new Map();
    this.chats.set(chatId, stored);

    const seen = new Set();
    const counts = new Map();
    scraped.forEach((msg, pos) => {
      const key = `${msg.from}\u0000${msg.text}`;
      const occurrence = counts.get(key) || 0;
      counts.set(key, occurrence + 1);

      const id = messageId(chatId, msg, occurrence);
      seen.add(id);
      this.missing.delete(id);
      if (this.expired.has(id)) return;
      if (stored.has(id)) {
        stored.get(id).pos = pos;
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
      stored.set(id, message);
      this.emit("message:new", message);
    });

    // once an expired message is gone from Snapchat too, forget it so an
    // identical new message later isn't hidden
    for (const [id, tombstone] of this.expired) {
      if (tombstone.chatId === chatId && !seen.has(id)) this.expired.delete(id);
    }

    for (const id of [...stored.keys()]) {
      if (seen.has(id)) continue;
      const misses = (this.missing.get(id) || 0) + 1;
      if (misses < MISSING_THRESHOLD) {
        this.missing.set(id, misses);
        continue;
      }
      this.missing.delete(id);
      stored.delete(id);
      this.emit("message:deleted", { id, chatId });
    }

    this.save();
    this.emit("chat:snapshot", { chatId, messages: this.getMessages(chatId) });
  }

  // Drops anything past its TTL, Snapchat-style.
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [chatId, messages] of this.chats) {
      for (const [id, message] of messages) {
        if (message.expiresAt <= now) {
          messages.delete(id);
          this.missing.delete(id);
          this.expired.set(id, { chatId, at: now });
          changed = true;
          this.emit("message:expired", { id, chatId });
        }
      }
      if (messages.size === 0) this.chats.delete(chatId);
    }
    for (const [id, tombstone] of this.expired) {
      if (now - tombstone.at > TOMBSTONE_MS) {
        this.expired.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  clear() {
    this.chats.clear();
    this.missing.clear();
    this.expired.clear();
    this.save();
  }
}
