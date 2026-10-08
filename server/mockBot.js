import fs from "fs";
import path from "path";

// Fake SnapBot for running the server + frontend without Snapchat (MOCK=true).
// Starts logged out (any password works except "wrong"), friends reply now and
// then, and "Sam" deletes their messages after ~40s, so you can watch
// deletions disappear in the frontend.
export default class MockBot {
  constructor() {
    this.page = {
      viewport: () => ({ width: 1280, height: 720 }),
      $: async () => null,
    };
    this.browser = { on() {}, close: async () => clearInterval(this.timer) };
    this.chats = {
      alex: { name: "Alex", messages: [{ from: "Alex", text: "yo" }, { from: "Me", text: "sup" }] },
      sam: { name: "Sam", messages: [{ from: "Sam", text: "this will vanish" }] },
      jo: { name: "Jo", messages: [{ from: "Jo", text: "see you at 8?" }] },
      crew: { name: "The Crew", messages: [{ from: "Alex", text: "who's driving" }, { from: "Jo", text: "not me" }] },
    };
    this.timer = setInterval(() => this.simulate(), 10000);
  }

  simulate() {
    if (!this.loggedIn) return;
    const now = Date.now();
    this.count = (this.count || 0) + 1;
    this.chats.alex.messages.push({ from: "Alex", text: `ping ${this.count}`, at: now });
    this.chats.sam.messages.push({ from: "Sam", text: `secret ${this.count}`, at: now });
    this.chats.sam.messages = this.chats.sam.messages.filter((m) => !m.at || now - m.at < 40000);
  }

  async launchSnapchat({ userDataDir }) {
    this.marker = path.join(userDataDir, "mock-logged-in");
    this.loggedIn = fs.existsSync(this.marker);
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
  async blockTypingNotifications() {}

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
    return !!this.lastOpened;
  }

  async readMessages(chatId) {
    return this.chats[chatId].messages.map((m) => ({ from: m.from, isMe: m.from === "Me", text: m.text, time: "Today" }));
  }

  async typeMessage(text) {
    // the session always opens the chat before typing
    this.lastOpened.messages.push({ from: "Me", text });
  }
}
