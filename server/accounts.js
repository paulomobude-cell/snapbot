import { EventEmitter } from "events";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import MessageStore from "./store.js";
import Session from "./session.js";

const EVENT_LIMIT = 500; // per account

// Owns every account and its Session + MessageStore.
// Re-emits everything with an accountId attached:
// accounts, status, chats, chat:snapshot, message:*, activity, screen:frame
export default class AccountManager extends EventEmitter {
  constructor({ db, cipher, media, config, BotClass }) {
    super();
    this.media = media;
    this.db = db;
    this.cipher = cipher;
    this.config = config;
    this.BotClass = BotClass;
    this.entries = new Map(); // accountId -> { account, session, store }
    const q = (sql) => db.prepare(sql);
    this.sql = {
      all: q(`SELECT * FROM accounts ORDER BY created_at`),
      get: q(`SELECT * FROM accounts WHERE id = ?`),
      insert: q(`INSERT INTO accounts (id, label, username, secret, created_at) VALUES (?, ?, ?, ?, ?)`),
      update: q(`UPDATE accounts SET label = ?, username = ?, secret = ? WHERE id = ?`),
      remove: q(`DELETE FROM accounts WHERE id = ?`),
      addEvent: q(`INSERT INTO events (account_id, type, chat_id, detail, at) VALUES (?, ?, ?, ?, ?)`),
      events: q(`SELECT * FROM events WHERE account_id = ? ORDER BY seq DESC LIMIT ?`),
      pruneEvents: q(`DELETE FROM events WHERE account_id = ? AND seq <= (
        SELECT seq FROM events WHERE account_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`),
    };
  }

  startAll() {
    for (const row of this.sql.all.all()) this.attach(row);
    // first boot with USER_NAME/USER_PASSWORD in env: create that account
    if (this.entries.size === 0 && this.config.username && this.config.password) {
      this.create({
        label: this.config.username,
        username: this.config.username,
        password: this.config.password,
        remember: false,
      });
    }
  }

  credentialsFor(row) {
    if (row.secret) {
      const password = this.cipher.decrypt(row.secret);
      if (password) return { username: row.username, password };
    }
    // the env account keeps working without storing its password
    if (row.username && row.username === this.config.username && this.config.password) {
      return { username: row.username, password: this.config.password };
    }
    return null;
  }

  profileDir(id) {
    return path.join(this.config.dataDir, "profiles", id);
  }

  attach(row) {
    const id = row.id;
    const store = new MessageStore({ db: this.db, accountId: id, ttlMs: this.config.ttlMs });
    const session = new Session({
      store,
      config: this.config,
      media: this.media,
      profileDir: this.profileDir(id),
      credentials: this.credentialsFor(row),
      BotClass: this.BotClass,
    });
    session.accountId = id;
    const entry = { account: row, session, store };
    this.entries.set(id, entry);

    const chatName = (chatId) => session.chats.find((c) => c.id === chatId)?.name || "";
    // media links are signed per send; a chain keeps events in order
    let chain = Promise.resolve();
    const send = (event, build) => {
      chain = chain
        .then(async () => this.emit(event, { accountId: id, ...(await build()) }))
        .catch((error) => console.error(`Emit ${event} failed`, error.message));
    };
    const short = (text) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);
    const what = (m) => (m.kind === "snap" ? "a snap" : m.kind === "media" ? "a photo/video" : "a chat");

    session.on("status", (s) => {
      this.log(id, "status", null, s.error ? `${s.status}: ${s.error}` : s.status);
      this.emit("status", { accountId: id, ...s });
      this.emitAccounts();
    });
    session.on("chats", () => this.emit("chats", { accountId: id, chats: this.chatsWithPreviews(id) }));
    session.on("screen:frame", (frame) => this.emit("screen:frame", { accountId: id, frame }));
    store.on("chat:snapshot", ({ chatId, messages }) =>
      send("chat:snapshot", async () => ({ chatId, messages: await this.withUrls(messages) }))
    );
    store.on("message:new", (message) => {
      send("message:new", async () => ({ message: (await this.withUrls([message]))[0] }));
      if (!message.isMe) this.log(id, "new", message.chatId, `${chatName(message.chatId)}: sent ${what(message)}`);
    });
    store.on("message:updated", (message) => {
      send("message:updated", async () => ({ message: (await this.withUrls([message]))[0] }));
      if (message.state === "deleted") {
        const content = message.text ? `"${short(message.text)}"` : what(message);
        this.log(id, "deleted", message.chatId, `${message.from} deleted ${content} in ${chatName(message.chatId)}`);
      }
    });
    store.on("message:removed", (data) => send("message:removed", () => data));
    store.on("media:purge", (keys) => {
      for (const key of keys) this.media.remove(key).catch(() => {});
    });

    session.start();
    return entry;
  }

  log(accountId, type, chatId, detail) {
    if (!this.entries.has(accountId)) return; // removed account
    const at = Date.now();
    const info = this.sql.addEvent.run(accountId, type, chatId, detail, at);
    this.sql.pruneEvents.run(accountId, accountId, EVENT_LIMIT);
    this.emit("activity", {
      accountId,
      event: { seq: Number(info.lastInsertRowid), type, chatId, detail, at },
    });
  }

  events(accountId, limit = 100) {
    return this.sql.events.all(accountId, limit).map((r) => ({
      seq: r.seq, type: r.type, chatId: r.chat_id, detail: r.detail, at: r.at,
    }));
  }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Account not found");
    return entry;
  }

  // adds short-lived signed links to stored media
  async withUrls(messages) {
    return Promise.all(messages.map(async (m) => ({
      ...m,
      media: await Promise.all(m.media.map(async ({ storageKey, ...media }) => ({
        ...media,
        url: media.status === "stored" ? await this.media.url(storageKey, this.config.mediaUrlTtl) : null,
      }))),
    })));
  }

  async messages(accountId, chatId, options) {
    return this.withUrls(this.get(accountId).store.getMessages(chatId, options));
  }

  chatsWithPreviews(id) {
    const { session, store } = this.get(id);
    const previews = store.previews();
    return session.chats.map((chat) => {
      return {
        ...chat,
        preview: previews[chat.id] || null,
      };
    });
  }

  list() {
    return [...this.entries.values()].map(({ account, session }) => ({
      id: account.id,
      label: account.label,
      username: account.username,
      remembered: !!account.secret,
      createdAt: account.created_at,
      ...session.getStatus(),
    }));
  }

  emitAccounts() {
    this.emit("accounts", this.list());
  }

  create({ label, username, password, remember }) {
    if (this.entries.size >= this.config.maxAccounts) {
      throw new Error(`Account limit reached (MAX_ACCOUNTS=${this.config.maxAccounts})`);
    }
    username = username?.trim() || null;
    const id = crypto.randomUUID();
    const secret = remember && password ? this.cipher.encrypt(password) : null;
    this.sql.insert.run(id, label?.trim() || username || "Account", username, secret, Date.now());
    const entry = this.attach(this.sql.get.get(id));
    if (password && !secret) this.useOnce(entry.session, { username, password });
    this.emitAccounts();
    return this.list().find((a) => a.id === id);
  }

  update(id, { label, remember, password }) {
    const { account, session } = this.get(id);
    let secret = account.secret;
    if (remember === false) secret = null;
    if (remember && password) secret = this.cipher.encrypt(password);
    const next = { ...account, label: label?.trim() || account.label, secret };
    this.sql.update.run(next.label, next.username, next.secret, id);
    this.get(id).account = next;
    session.credentials = this.credentialsFor(next);
    this.emitAccounts();
  }

  login(id, { username, password, remember }) {
    const entry = this.get(id);
    if (!username || !password) throw new Error("Username and password required");
    const secret = remember ? this.cipher.encrypt(password) : null;
    const next = { ...entry.account, username, secret };
    this.sql.update.run(next.label, username, secret, id);
    entry.account = next;
    if (remember) entry.session.credentials = { username, password };
    else this.useOnce(entry.session, { username, password });
    this.emitAccounts();
    entry.session.login(username, password).catch((e) => {
      console.error("Login failed", e);
      this.log(id, "status", null, `login failed: ${e.message}`);
    });
  }

  // password not remembered: keep it only until this login attempt settles
  useOnce(session, credentials) {
    session.credentials = credentials;
    const forget = (s) => {
      if (s.status === "connected" || s.status === "needs_login" || s.status === "error") {
        const account = this.entries.get(session.accountId)?.account;
        session.credentials = account ? this.credentialsFor(account) : null;
        session.off("status", forget);
      }
    };
    session.on("status", forget);
  }

  async remove(id) {
    const { session, store } = this.get(id);
    store.clear(); // purges its media from storage too
    this.entries.delete(id);
    await session.stop();
    session.removeAllListeners();
    store.removeAllListeners();
    this.sql.remove.run(id); // cascades messages, tombstones, events
    fs.rmSync(this.profileDir(id), { recursive: true, force: true });
    this.emitAccounts();
  }

  sweep() {
    for (const { store } of this.entries.values()) store.sweep();
  }

  async stopAll() {
    await Promise.all([...this.entries.values()].map(({ session }) => session.stop()));
  }
}
