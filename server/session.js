import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import SnapBot from "../snapbot.js";
import { sniffType } from "./media.js";

const LOGIN_URL = "https://www.snapchat.com/?original_referrer=none";
const LOGIN_FORM = '#ai_input, input[name="accountIdentifier"]';
const CHAT_LIST = "div.ReactVirtualized__Grid__innerScrollContainer";

function delay(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

// Runs one Snapchat Web session and keeps the MessageStore in sync with it.
// Emits: status, chats, screen:frame
export default class Session extends EventEmitter {
  constructor({ store, media, config, profileDir, credentials = null, BotClass = SnapBot }) {
    super();
    this.media = media;
    this.shaBySrc = new Map(); // blob URL -> sha256 of its content (blob URLs live per page load)
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
    this.lastChatDiscovery = 0;
    this.pendingSync = new Set();
    this.passiveActivity = new Map(); // chatId -> latest sidebar change
    this.syncRunning = false;
    this.sidebarDirty = false;
    this.lastSidebarSignal = 0;
    this.lastStatus = new Map(); // chatId -> status string, to spot new activity
    this.screencast = null;
    this.viewers = 0;
    this.screenTimer = null;
    this.screenPage = null;
    this.screenPageIds = new WeakMap();
    this.screenKnownPages = new Set();
    this.screenPageCounter = 0;
    this.screenBusy = false;
    this.lastScreenHash = null;
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
      this.shaBySrc.clear();
      // before Snapchat loads: never send read receipts/typing, and keep decrypted media
      bot.onPageCreated = async () => {
        if (this.config.blockedRequests.length && bot.blockRequests) {
          await bot.blockRequests(this.config.blockedRequests);
        }
        if (bot.installMediaCapture) await bot.installMediaCapture();
      };
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

      const pageState = await this.waitForPage(30000);
      if (this.status !== "starting") return; // another login or stop began
      if (pageState === "chats") {
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
    if (!this.bot?.page) throw new Error("Browser is not ready yet");
    // Avoid overlapping submits from an account auto-login and dashboard retries.
    if (this.status === "logging_in" || this.status === "connected") return;
    this.stopLoop();
    this.setStatus("logging_in");

    try {
      await this.run(async () => {
        // Navigate only if we are not already at a valid login step.
        const onForm = await this.bot.page.$(LOGIN_FORM).catch(() => null);
        const onPassword = await this.bot.page.$('input[type="password"]').catch(() => null);
        if (!onForm && !onPassword && !(await this.hasChatList()) && this.bot.page.goto) {
          await this.bot.page.goto(LOGIN_URL, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          }).catch((error) => console.warn("Snapchat login page navigation:", error.message));
        }
        await this.bot.login({ username, password });
      });
      if (this.status === "stopped") return;
      if (await this.waitForChatList(15000)) {
        await this.onLoggedIn();
      } else {
        this.setStatus("needs_login", "Snapchat did not open the chat list. Check the live screen for CAPTCHA, two-factor verification, or a login error.");
        this.watchForManualLogin();
      }
    } catch (error) {
      if (this.status === "stopped") return;
      console.warn("Automatic Snapchat login requires attention:", error.message);
      this.setStatus("needs_login", error.message);
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
    if (this.bot.watchChatList) {
      await this.run(() => this.bot.watchChatList(() => this.signalSidebarActivity())).catch(error =>
        console.warn("Passive sidebar observer unavailable; periodic scan remains active:", error.message));
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

  signalSidebarActivity() {
    if (this.status !== "connected") return;
    const now = Date.now();
    // Sidebar animations and virtualized scrolling can cause hundreds of
    // mutations; a per-session rate limiter prevents thrashing Chromium.
    if (now - this.lastSidebarSignal < 1200) return;
    this.lastSidebarSignal = now;
    this.sidebarDirty = true;
    if (!this.syncRunning) this.scheduleLoop(200);
  }

  async tick() {
    if (this.status !== "connected" || this.syncRunning) return;
    this.syncRunning = true;
    this.sidebarDirty = false;
    try {
      await this.syncChats();
    } catch (error) {
      if (this.status === "connected") console.error("Sync failed", error.message);
    } finally {
      this.syncRunning = false;
      if (this.status === "connected") this.scheduleLoop(this.sidebarDirty ? 200 : this.config.syncIntervalMs);
    }
  }

  async syncChats() {
    const discoverAll = Date.now() - this.lastChatDiscovery > 5 * 60_000;
    const visible = await this.run(() => this.bot.userStatus({ fullScan: discoverAll }));
    if (!visible.length && !(await this.hasChatList())) {
      // Chat list truly disappeared (a transient empty virtualized render is
      // not equivalent to being logged out).
      this.setStatus("needs_login");
      return this.watchForManualLogin();
    }
    if (discoverAll && visible.length) this.lastChatDiscovery = Date.now();
    // Fast visible-row refreshes must not erase previously discovered
    // conversations as the virtualized viewport changes. Keep newest visible
    // status information while retaining the rest of the known chat list.
    const merged = new Map(this.chats.map(chat => [chat.id, chat]));
    for (const chat of visible) merged.set(chat.id, chat);
    const chats = [...merged.values()];
    this.chats = chats;
    this.emit("chats", chats);

    const now = Date.now();
    const fullSync = now - this.lastFullSync > this.config.fullSyncIntervalMs;
    if (fullSync) this.lastFullSync = now;

    // Passive by default: watching sidebar changes does not open conversations.
    // Opening a chat, including one selected in the dashboard, requires a
    // separate explicit interactive action. This is not a read-receipt bypass.
    for (const chat of chats) {
      const statusKey = JSON.stringify(chat.status);
      const previous = this.lastStatus.get(chat.id);
      this.lastStatus.set(chat.id, statusKey);
      if (previous !== undefined && statusKey !== previous) {
        this.passiveActivity.set(chat.id, Date.now());
        this.emit("chat:activity", {
          chatId: chat.id, observedAt: Date.now(), status: chat.status,
        });
      }
    }
    // Only inspect the conversation that is ALREADY visible in the authenticated
    // browser. page.evaluate does not click it or request another conversation.
    // The resulting archive can be incomplete if Snapchat has not rendered data.
    const visibleChat = await this.run(async () => {
      if (this.bot.visibleChatId) return this.bot.visibleChatId();
      return null;
    });
    if (visibleChat && chats.some(chat => chat.id === visibleChat)) {
      await this.syncChat(visibleChat, { interactive: false });
    }
  }

  async syncChat(chatId, { interactive = false } = {}) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return { captured: false, reason: "Chat not discovered" };
    const items = await this.run(async () => {
      if (interactive) {
        if (!(await this.bot.openChat(chatId))) return null;
        await delay(650);
      } else if (!this.bot.visibleChatId || (await this.bot.visibleChatId()) !== chatId) {
        return null;
      }
      return this.bot.readMessages(chatId, chat.name, this.config.patterns);
    });
    if (!items) return { captured: false, reason: "Conversation not rendered" };

    const buffers = await this.run(() => this.readMediaBuffers(items, { allowNetwork: interactive }));
    const { seen } = this.store.sync(chatId, items, { preserve: true, reconcileMissing: false });
    await this.captureMedia(chatId, seen, buffers, { allowNetwork: interactive });
    return { captured: true, messageCount: this.store.getMessages(chatId).filter(m => m.kind !== "status").length };
  }

  // decrypts chat media into buffers keyed by content hash; tags each item with
  // its sha256 (blob URLs change every page load, so content is the stable id)
  async readMediaBuffers(items, { allowNetwork = false } = {}) {
    const buffers = new Map();
    for (const item of items) {
      if (item.kind !== "media") continue;
      if (!item.src || (!allowNetwork && !/^(blob:|data:)/i.test(item.src))) continue;
      if (this.shaBySrc.has(item.src)) {
        item.sha256 = this.shaBySrc.get(item.src);
        continue;
      }
      const read = await this.readBuffer(() => this.bot.readMedia(item.src));
      if (!read) continue;
      item.sha256 = read.sha256;
      this.shaBySrc.set(item.src, read.sha256);
      if (this.shaBySrc.size > 5000) this.shaBySrc.delete(this.shaBySrc.keys().next().value);
      buffers.set(read.sha256, read);
    }
    return buffers;
  }

  // Re-sync a chat when requested
  async resyncChat(chatId) {
    if (this.status === "connected") await this.syncChat(chatId, { interactive: true }).catch(() => {});
  }

  async readBuffer(read) {
    const media = await read().catch(() => null);
    if (!media?.base64) return null;
    const buffer = Buffer.from(media.base64, "base64");
    if (!buffer.length || buffer.length > 100 * 1024 * 1024) return null;
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    return { buffer, sha256, contentType: sniffType(buffer, media.type) };
  }

  // Stores media for live messages in a consented chat that don't have it yet:
  // chat photos/videos from their blob, and tap-to-view snaps by opening them
  // (opening marks them viewed on Snapchat, same as if you opened the snap).
  async captureMedia(chatId, seen, buffers, { allowNetwork = false } = {}) {
    let snapsOpened = 0;
    for (const [id, item] of seen) {
      if (item.kind !== "media" && item.kind !== "snap") continue;
      const message = this.store.getById(id);
      if (!message) continue;
      const existing = message.media[0];
      if (existing?.status === "stored") continue;
      if (existing?.retryAt && existing.retryAt > Date.now()) continue;

      const viewOnce = item.kind === "snap";
      // Never open an unopened Snap automatically, even after an explicit
      // text-chat sync. Opening a Snap requires separate user confirmation.
      if (viewOnce) continue;
      if (viewOnce && snapsOpened >= this.config.snapsPerSync) continue;

      const mediaId = existing?.id || this.store.addMedia(message.uid, {
        kind: item.mediaType || "image",
        viewOnce,
      });
      let read = viewOnce ? null : buffers.get(item.sha256);
      if (!read) {
        if (viewOnce) snapsOpened++;
        read = await this.run(() =>
          this.readBuffer(() =>
            viewOnce ? null : (allowNetwork || /^(blob:|data:)/i.test(item.src || "") ? this.bot.readMedia(item.src) : null)
          )
        );
      }
      if (!read) {
        this.store.mediaFailed(mediaId, "Media bytes not available in rendered browser");
        this.store.touch(message.uid);
        continue;
      }
      try {
        const kind = read.contentType.startsWith("video/") ? "video" : "image";
        const reuse = this.store.storedBySha(read.sha256);
        const key = reuse?.storageKey ||
          this.media.keyFor({ accountId: this.accountId, chatId, sha256: read.sha256, contentType: read.contentType });
        if (!reuse) await this.media.put(key, read.buffer, read.contentType);
        this.store.mediaStored(mediaId, {
          key, contentType: read.contentType, size: read.buffer.length, sha256: read.sha256, kind,
        });
      } catch (error) {
        console.error("Media upload failed", error.message);
        this.store.mediaFailed(mediaId, error.message);
      }
      this.store.touch(message.uid);
    }
  }

  async selectChat(chatId) {
    this.activeChatId = chatId;
    // Selecting a chat in Comnexus only reads the local archive. It does not
    // open the Snapchat conversation or acknowledge its unread state.
  }

  async sendMessage(chatId, text) {
    if (this.status !== "connected") throw new Error("Session not connected");
    await this.run(async () => {
      if (!(await this.bot.openChat(chatId))) throw new Error("Chat not found");
      await this.bot.typeMessage(text);
    });
    await delay(1000);
    await this.syncChat(chatId, { interactive: false });
  }

  async logout() {
    this.stopLoop();
    try {
      await this.run(() => this.bot.logout());
    } catch (error) {
      console.error("Logout failed", error.message);
    }
    this.store.resetSync(); // the archive stays
    this.pendingSync.clear();
    this.passiveActivity.clear();
    this.sidebarDirty = false;
    this.lastStatus.clear();
    this.lastChatDiscovery = 0;
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
    this.screenPage = null;
    this.screenKnownPages.clear();
    this.screenPageIds = new WeakMap();
    this.screenPageCounter = 0;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // ---- interactive live browser: login, OAuth popups, captcha and 2FA ----
  // Each Snapchat account has its own browser/profile. Only pages in this browser
  // can be selected and controlled. Never return credentials to the frontend.
  async screenPages() {
    if (!this.bot?.browser) return [];
    const pages = (await this.bot.browser.pages()).filter((page) =>
      page && !page.isClosed?.() && !String(page.url?.() || "").startsWith("devtools:")
    );
    const current = new Set(pages);
    for (const page of pages) {
      if (!this.screenPageIds.has(page)) {
        this.screenPageIds.set(page, String(++this.screenPageCounter));
        // Popups (e.g. Google sign-in) should become visible automatically.
        if (this.screenKnownPages.size && page !== this.bot.page) this.screenPage = page;
      }
    }
    this.screenKnownPages = current;
    if (!current.has(this.screenPage)) {
      this.screenPage = current.has(this.bot.page) ? this.bot.page : pages[pages.length - 1] || null;
    }
    return pages;
  }

  async activeScreenPage() {
    await this.screenPages();
    return this.screenPage;
  }

  async selectScreenPage(id) {
    const pages = await this.screenPages();
    const target = pages.find((page) => this.screenPageIds.get(page) === String(id));
    if (!target) throw new Error("That browser tab was closed. Refresh the screen.");
    this.screenPage = target;
    await target.bringToFront().catch(() => {});
    await this.pushScreenFrame();
  }

  async pushScreenFrame() {
    if (this.screenBusy || !this.viewers) return;
    this.screenBusy = true;
    try {
      const pages = await this.screenPages();
      const page = this.screenPage;
      if (!page) return;
      const tabs = await Promise.all(pages.map(async (p) => {
        const url = String(p.url?.() || "");
        const title = await p.title().catch(() => "");
        let site = "Browser tab";
        try { site = new URL(url).hostname || site; } catch {}
        return {
          id: this.screenPageIds.get(p),
          label: (title || site).slice(0, 65),
          site,
        };
      }));
      // Capture at native viewport resolution (1920x1080 in production).
      // Higher JPEG quality makes login buttons/text legible when fullscreen.
      // If a busy page produces an oversized JPEG, lower compression quality
      // rather than exceed typical WebSocket/polling frame limits.
      const options = { type: "jpeg", captureBeyondViewport: false };
      let image;
      let quality = 86;
      for (const candidate of [86, 72, 55, 40]) {
        quality = candidate;
        image = await page.screenshot({ ...options, quality: candidate });
        if (image?.length <= 580 * 1024) break;
      }
      if (!image || image.length > 580 * 1024) {
        console.warn("Live Screen: large frame omitted to protect Socket.IO transport");
        return;
      }
      const vp = page.viewport?.() || { width: 1280, height: 720 };
      const pageId = this.screenPageIds.get(page);
      const fingerprint = crypto.createHash("sha1").update(image)
        .update(pageId || "").update(JSON.stringify(tabs)).digest("hex");
      // Don't repeatedly transfer the same screen when nothing repainted.
      if (fingerprint === this.lastScreenHash) return;
      this.lastScreenHash = fingerprint;
      this.emit("screen:frame", {
        frame: Buffer.from(image).toString("base64"),
        pageId,
        pages: tabs,
        width: vp.width,
        height: vp.height,
        quality,
      });
    } catch (error) {
      // Navigating pages temporarily destroys their execution context.
      if (this.viewers && !/navigat|destroyed|closed|Target closed/i.test(error.message))
        console.warn("Live screen capture:", error.message);
    } finally {
      this.screenBusy = false;
    }
  }

  async addViewer() {
    this.viewers++;
    await this.startScreencast();
  }

  async removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) await this.stopScreencast();
  }

  async startScreencast() {
    // Restart the capture loop after the browser restarts while a viewer is open.
    if (!this.viewers) return;
    if (!this.screenTimer) {
      this.screenTimer = setInterval(() => void this.pushScreenFrame(), 1600);
    }
    await this.pushScreenFrame();
  }

  async stopScreencast() {
    if (this.screenTimer) clearInterval(this.screenTimer);
    this.screenTimer = null;
    this.lastScreenHash = null;
    if (this.screencast) {
      await this.screencast.send("Page.stopScreencast").catch(() => {});
      await this.screencast.detach().catch(() => {});
      this.screencast = null;
    }
  }

  async screenshot() {
    const page = await this.activeScreenPage();
    return page ? page.screenshot({ type: "jpeg", quality: 60 }) : null;
  }

  async click(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error("Invalid live screen coordinates");
    }
    return this.run(async () => {
      const page = await this.activeScreenPage();
      if (!page) throw new Error("Browser page not ready");
      const { width, height } = page.viewport?.() || { width: 1280, height: 720 };
      await page.mouse.click(x * width, y * height);
    });
  }

  async type(text) {
    if (typeof text !== "string" || !text || text.length > 2000) throw new Error("Type 1–2000 characters");
    return this.run(async () => {
      const page = await this.activeScreenPage();
      if (!page) throw new Error("Browser page not ready");
      await page.keyboard.type(text, { delay: 12 });
    });
  }

  async press(key) {
    if (!["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft",
      "ArrowRight", "Delete", "Space"].includes(key)) throw new Error("Unsupported browser key");
    return this.run(async () => {
      const page = await this.activeScreenPage();
      if (!page) throw new Error("Browser page not ready");
      await page.keyboard.press(key);
    });
  }

  async scroll(deltaY, deltaX = 0) {
    if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX)) throw new Error("Invalid scroll");
    return this.run(async () => {
      const page = await this.activeScreenPage();
      if (!page) throw new Error("Browser page not ready");
      await page.mouse.wheel({
        deltaY: Math.max(-1400, Math.min(1400, deltaY)),
        deltaX: Math.max(-1400, Math.min(1400, deltaX)),
      });
    });
  }

}
