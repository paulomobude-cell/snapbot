import fs from "fs";
import path from "path";

// Fake SnapBot for running the server + frontend without Snapchat (MOCK=true).
// Starts logged out (any password except "wrong" logs in). Models text, media,
// tap-to-view snaps, deletions (with the "X deleted a chat" notice), and lets
// two accounts whose usernames are "alpha"/"beta" link for preservation.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAE0lEQVR42mNk+M9Qz0BkYBxVSF8FAHWBBkAiGHpAAAAAAElFTkSuQmCC",
  "base64"
);

let nextId = 1;
const msg = (from, text, extra = {}) => ({ id: nextId++, from, text, kind: "text", ...extra });

export default class MockBot {
  constructor() {
    this.page = { viewport: () => ({ width: 1280, height: 720 }), $: async () => null };
    this.browser = { on() {}, close: async () => clearInterval(this.timer) };
    this.notices = {}; // chatId -> [{ from, text, ttl }]
    this.chats = {
      alex: { name: "Alex", messages: [msg("Alex", "yo"), msg("Me", "sup")] },
      sam: {
        name: "Sam",
        messages: [
          msg("Sam", "this stays"),
          msg("Sam", "", { kind: "media", mediaType: "image", src: "blob:mock/photo1" }),
          msg("Sam", "", { kind: "snap", snapIndex: 0, src: "blob:mock/snap0" }),
        ],
      },
      jo: { name: "Jo", messages: [msg("Jo", "see you at 8?")] },
      // peers that correspond to your other accounts (for linked handshakes in tests)
      alpha: { name: "alpha", messages: [msg("alpha", "hey from alpha")] },
      beta: { name: "beta", messages: [msg("beta", "hey from beta")] },
    };
    this.timer = setInterval(() => this.simulate(), 8000);
  }

  // Sam keeps sending secrets and deleting the previous one (with a notice),
  // so you can watch mirror-only drop them vs. a preserved chat keep them.
  simulate() {
    if (!this.loggedIn) return;
    const sam = this.chats.sam;
    this.count = (this.count || 0) + 1;
    const prev = [...sam.messages].reverse().find((m) => m.text.startsWith("secret "));
    if (prev) {
      sam.messages = sam.messages.filter((m) => m !== prev);
      (this.notices.sam ||= []).push({ from: "Sam", text: "Sam deleted a chat", ttl: 2 });
    }
    sam.messages.push(msg("Sam", `secret ${this.count}`, { at: Date.now() }));
  }

  async launchSnapchat({ userDataDir }) {
    this.marker = path.join(userDataDir, "mock-logged-in");
    this.loggedIn = fs.existsSync(this.marker);
    if (this.onPageCreated) await this.onPageCreated(this.page, this.browser);
  }
  async hasChatList() { return this.loggedIn; }
  async hasLoginForm() { return !this.loggedIn; }
  async login({ password }) {
    if (password === "wrong") return;
    this.loggedIn = true;
    fs.writeFileSync(this.marker, "1");
  }
  async handlePopup() {}
  async logout() {
    this.loggedIn = false;
    fs.rmSync(this.marker, { force: true });
  }
  async blockRequests() {}
  async installMediaCapture() {}

  async userStatus() {
    if (!this.loggedIn) return [];
    return Object.entries(this.chats).map(([id, chat]) => ({
      id,
      name: chat.name,
      status: { type: "Received", time: `${chat.messages.length}`, streak: id === "alex" ? "42🔥" : null },
    }));
  }

  async openChat(chatId) {
    this.lastOpened = this.chats[chatId];
    this.lastOpenedId = chatId;
    return !!this.lastOpened;
  }

  async visibleChatId() { return this.lastOpenedId || null; }

  async readMessages(chatId) {
    const chat = this.chats[chatId];
    if (!chat) return null;
    const notices = this.notices[chatId] || [];
    for (const n of notices) n.ttl--;
    this.notices[chatId] = notices.filter((n) => n.ttl > 0);
    const items = chat.messages.map((m) => ({
      kind: m.kind, from: m.from, isMe: m.from === "Me", text: m.text,
      time: "Today", src: m.src, mediaType: m.mediaType, snapIndex: m.snapIndex,
    }));
    // notices render in-line where the removed message was (end is fine for the mock)
    for (const n of notices) items.push({ kind: "notice", notice: "deleted", from: n.from, text: n.text, time: "Today" });
    return items;
  }

  async readMedia(src) {
    if (!src?.startsWith("blob:mock/")) return null;
    return { base64: TINY_PNG.toString("base64"), type: "image/png", size: TINY_PNG.length };
  }
  async openReceivedSnap() {
    return this.readMedia("blob:mock/snap-opened");
  }

  async typeMessage(text) {
    this.lastOpened.messages.push(msg("Me", text));
  }

  // test helper: inject a peer message (e.g. the handshake code)
  inject(chatId, from, text) {
    this.chats[chatId]?.messages.push(msg(from, text));
  }
}
