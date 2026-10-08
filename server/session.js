import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import SnapBot from "../snapbot.js";

const LOGIN_URL = "https://www.snapchat.com/?original_referrer=none";
const LOGIN_FORM = '#ai_input, input[name="accountIdentifier"]';
const CHAT_LIST = "div.ReactVirtualized__Grid__innerScrollContainer";

function delay(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

// Runs one Snapchat Web session and keeps the MessageStore in sync with it.
// Emits: status, chats, screen:frame
export default class Session extends EventEmitter {
  constructor({ store, config, profileDir, credentials = null, BotClass = SnapBot }) {
    super();
    this.BotClass = BotClass;
    this.profileDir = profileDir;
    this.credentials = credentials; // { username, password } for auto re-login
    this.store = store;
    this.config = config;
    this.bot = null;
    this.status = "stopped"; // stopped | starting | needs_login | logging_in | connected | error
    this.error = null;
    this.chats = [];
    this.activeChatId = null;
    this.queue = Promise.resolve();
    this.loopTimer = null;
    this.lastFullSync = 0;
    this.lastStatus = new Map(); // chatId -> status string, to spot new activity
    this.screencast = null;
    this.viewers = 0;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit("status", this.getStatus());
  }

  getStatus() {
    return { status: this.status, error: this.error };
  }

  // every page interaction goes through here so they never overlap
  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  async start() {
    if (this.status !== "stopped" && this.status !== "error") return;
    this.setStatus("starting");
    try {
      const profileDir = this.profileDir;
      fs.mkdirSync(profileDir, { recursive: true });
      // a crashed container leaves Chrome's lock behind and blocks relaunch
      for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        fs.rmSync(path.join(profileDir, lock), { force: true });
      }

      const bot = new this.BotClass();
      this.bot = bot;
      await bot.launchSnapchat({
        headless: this.config.headless,
        executablePath: this.config.chromePath || undefined,
        userDataDir: profileDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--force-device-scale-factor=1",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--window-size=1920,1080",
        ],
      });
      if (this.status === "stopped" || this.bot !== bot) {
        // stopped (or account removed) while Chrome was launching
        await bot.browser?.close().catch(() => {});
        return;
      }
      if (!bot.page) throw new Error("Browser failed to start");
      this.bot.browser.on("disconnected", () => {
        if (this.status !== "stopped") {
          this.stopLoop();
          this.setStatus("error", "Browser disconnected");
        }
      });
      if (this.viewers > 0) await this.startScreencast();

      if ((await this.waitForPage(30000)) === "chats") {
        await this.onLoggedIn();
      } else if (this.credentials) {
        await this.login(this.credentials.username, this.credentials.password);
      } else {
        this.setStatus("needs_login");
        this.watchForManualLogin();
      }
    } catch (error) {
      console.error("Session start failed", error);
      this.setStatus("error", error.message);
    }
  }

  async login(username, password) {
    if (!this.bot?.page) throw new Error("Session not started");
    this.setStatus("logging_in");
    await this.run(async () => {
      // get back to the login form if the page is somewhere else (error page, logged out)
      const onForm = await this.bot.page
        .$(LOGIN_FORM)
        .catch(() => null);
      if (!onForm && this.bot.page.goto) {
        await this.bot.page.goto(LOGIN_URL, { waitUntil: "networkidle2" }).catch(() => {});
      }
      await this.bot.login({ username, password });
    });
    if (await this.waitForChatList(15000)) {
      await this.onLoggedIn();
    } else {
      // captcha / 2FA: user finishes it through the live screen
      this.setStatus("needs_login");
      this.watchForManualLogin();
    }
  }

  // logged in == the chat list is showing (an error page has no login form either)
  async hasChatList() {
    try {
      if (this.bot.hasChatList) return await this.bot.hasChatList();
      return !!(await this.bot.page.$(CHAT_LIST));
    } catch (error) {
      return false; // page navigating
    }
  }

  async hasLoginForm() {
    try {
      if (this.bot.hasLoginForm) return await this.bot.hasLoginForm();
      return !!(await this.bot.page.$(LOGIN_FORM));
    } catch (error) {
      return false;
    }
  }

  // resolves "chats" | "login" | null (neither showed up: error page, captcha...)
  async waitForPage(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.hasChatList()) return "chats";
      if (await this.hasLoginForm()) return "login";
      await delay(1000);
    }
    return null;
  }

  async waitForChatList(timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.hasChatList()) return true;
      await delay(1000);
    }
    return false;
  }

  watchForManualLogin() {
    this.stopLoop();
    const check = async () => {
      if (this.status !== "needs_login" && this.status !== "logging_in") return;
      if (await this.hasChatList()) return this.onLoggedIn();
      this.loopTimer = setTimeout(check, 3000);
    };
    this.loopTimer = setTimeout(check, 3000);
  }

  async onLoggedIn() {
    this.setStatus("connected");
    await this.run(() => this.bot.handlePopup());
    if (this.config.blockTyping) {
      await this.run(() => this.bot.blockTypingNotifications(true));
    }
    this.scheduleLoop(0);
  }

  scheduleLoop(ms) {
    this.stopLoop();
    this.loopTimer = setTimeout(() => this.tick(), ms);
  }

  stopLoop() {
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
  }

  async tick() {
    if (this.status !== "connected") return;
    try {
      await this.syncChats();
    } catch (error) {
      if (this.status !== "connected") return; // stopped mid-sync
      console.error("Sync failed", error.message);
    }
    this.scheduleLoop(this.config.syncIntervalMs);
  }

  async syncChats() {
    const chats = await this.run(() => this.bot.userStatus());
    if (!chats.length && !(await this.hasChatList())) {
      // chat list vanished: logged out or the page broke
      this.setStatus("needs_login");
      return this.watchForManualLogin();
    }
    this.chats = chats;
    this.emit("chats", chats);

    const now = Date.now();
    const fullSync = now - this.lastFullSync > this.config.fullSyncIntervalMs;
    if (fullSync) this.lastFullSync = now;

    const held = new Set(this.store.chatIds());
    const toSync = new Set();
    if (this.activeChatId) toSync.add(this.activeChatId);
    for (const chat of chats) {
      const statusKey = JSON.stringify(chat.status);
      const changed = this.lastStatus.get(chat.id) !== statusKey;
      this.lastStatus.set(chat.id, statusKey);
      // sync on new activity; on a full sync re-check every chat we hold messages
      // for, so deletions and Snapchat's own expiry are picked up
      if (changed || (fullSync && held.has(chat.id))) {
        toSync.add(chat.id);
      }
    }
    for (const chatId of toSync) {
      await this.syncChat(chatId);
    }
    // leave the selected chat open so its messages keep rendering
    if (this.activeChatId) {
      await this.run(() => this.bot.openChat(this.activeChatId));
    }
  }

  async syncChat(chatId) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const messages = await this.run(async () => {
      if (!(await this.bot.openChat(chatId))) return null;
      await delay(800); // let messages render
      return this.bot.readMessages(chatId, chat.name);
    });
    // null means the chat didn't load; don't treat that as "everything deleted"
    if (messages) this.store.sync(chatId, messages);
  }

  async selectChat(chatId) {
    this.activeChatId = chatId;
    if (this.status === "connected" && chatId) await this.syncChat(chatId);
  }

  async sendMessage(chatId, text) {
    if (this.status !== "connected") throw new Error("Session not connected");
    await this.run(async () => {
      if (!(await this.bot.openChat(chatId))) throw new Error("Chat not found");
      await this.bot.typeMessage(text);
    });
    await delay(1000);
    await this.syncChat(chatId);
  }

  async logout() {
    this.stopLoop();
    try {
      await this.run(() => this.bot.logout());
    } catch (error) {
      console.error("Logout failed", error.message);
    }
    this.store.clear();
    this.chats = [];
    this.emit("chats", []);
    this.setStatus("needs_login");
    this.watchForManualLogin();
  }

  async stop() {
    this.stopLoop();
    this.setStatus("stopped");
    await this.stopScreencast();
    if (this.bot?.browser) await this.bot.browser.close().catch(() => {});
    this.bot = null;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // ---- live screen (for login / captcha / 2FA) ----

  async addViewer() {
    this.viewers++;
    if (this.viewers === 1) await this.startScreencast();
    // screencast only sends frames when the page repaints, so send the current view now
    const image = await this.screenshot().catch(() => null);
    if (image) this.emit("screen:frame", Buffer.from(image).toString("base64"));
  }

  async removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) await this.stopScreencast();
  }

  async startScreencast() {
    if (this.screencast || !this.bot?.page?.createCDPSession) return;
    try {
      const client = await this.bot.page.createCDPSession();
      this.screencast = client;
      client.on("Page.screencastFrame", async ({ data, sessionId }) => {
        this.emit("screen:frame", data);
        await client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 2,
      });
    } catch (error) {
      console.error("Screencast failed", error.message);
      this.screencast = null;
    }
  }

  async stopScreencast() {
    if (!this.screencast) return;
    await this.screencast.send("Page.stopScreencast").catch(() => {});
    await this.screencast.detach().catch(() => {});
    this.screencast = null;
  }

  async screenshot() {
    if (!this.bot?.page) return null;
    return this.bot.page.screenshot({ type: "jpeg", quality: 60 });
  }

  // x, y are 0..1 relative to the frame
  async click(x, y) {
    if (!this.bot?.page) return;
    const { width, height } = this.bot.page.viewport();
    await this.run(() => this.bot.page.mouse.click(x * width, y * height));
  }

  async type(text) {
    if (!this.bot?.page) return;
    await this.run(() => this.bot.page.keyboard.type(text, { delay: 50 }));
  }

  async press(key) {
    if (!this.bot?.page) return;
    await this.run(() => this.bot.page.keyboard.press(key));
  }

  async scroll(deltaY) {
    if (!this.bot?.page) return;
    await this.run(() => this.bot.page.mouse.wheel({ deltaY }));
  }
}
