// Fake SnapBot for running the server + frontend without Snapchat (MOCK=true).
// Friends reply now and then, and "Sam" deletes their messages after ~40s,
// so you can watch deletions disappear in the frontend.
export default class MockBot {
  constructor() {
    this.page = { viewport: () => ({ width: 1280, height: 720 }) };
    this.browser = { on() {}, close: async () => {} };
    this.chats = {
      alex: { name: "Alex", messages: [{ from: "Alex", text: "yo" }] },
      sam: { name: "Sam", messages: [{ from: "Sam", text: "this will vanish" }] },
    };
    this.timer = setInterval(() => this.simulate(), 10000);
  }

  simulate() {
    const now = Date.now();
    this.count = (this.count || 0) + 1;
    this.chats.alex.messages.push({ from: "Alex", text: `ping ${this.count}`, at: now });
    this.chats.sam.messages.push({ from: "Sam", text: `secret ${this.count}`, at: now });
    this.chats.sam.messages = this.chats.sam.messages.filter((m) => !m.at || now - m.at < 40000);
  }

  async launchSnapchat() {}
  async hasChatList() { return true; }
  async login() {}
  async handlePopup() {}
  async logout() {}
  async blockTypingNotifications() {}

  async userStatus() {
    return Object.entries(this.chats).map(([id, chat]) => ({
      id,
      name: chat.name,
      status: { type: "Received", time: `${chat.messages.length}`, streak: null },
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
