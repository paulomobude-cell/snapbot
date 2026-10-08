import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { openDb, createCipher } from "./db.js";
import AccountManager from "./accounts.js";
import MediaStorage from "./media.js";
import { TenantAuth } from "./tenant-auth.js";
import { purgeProvenEmptyLegacy } from "./cleanup-empty-legacy.js";

const env = process.env;
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const config = {
  port: Number(env.PORT || 3001),
  apiToken: env.API_TOKEN || "",
  adminToken: env.ADMIN_API_TOKEN || "",
  secretKey: env.SECRET_KEY || env.API_TOKEN || "",
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((o) => o.trim()) : "*",
  dataDir: env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "./data"),
  // 0 = keep archived messages until explicitly deleted.
  ttlMs: Number(env.MESSAGE_TTL_HOURS || 0) * 60 * 60 * 1000,
  syncIntervalMs: Number(env.SYNC_INTERVAL_MS || 4000),
  fullSyncIntervalMs: Number(env.FULL_SYNC_INTERVAL_MS || 60000),
  maxAccounts: Number(env.MAX_ACCOUNTS || 3),
  headless: env.HEADLESS !== "false",
  chromePath: env.PUPPETEER_EXECUTABLE_PATH,
  username: env.USER_NAME,
  password: env.USER_PASSWORD,
  webhookUrl: env.WEBHOOK_URL,
  mock: env.MOCK === "true",
  // Requests the browser answers locally instead of sending. Empty by default:
  // the bot opens chats to mirror them and lets normal read receipts go through,
  // like an ordinary client. (Not used to hide reads.)
  blockedRequests: list(env.BLOCKED_REQUESTS),
  // capture media accessible to the signed-in account
  captureSnaps: env.CAPTURE_SNAPS !== "false",
  snapsPerSync: Number(env.SNAPS_PER_SYNC || 3),
  mediaUrlTtl: Number(env.MEDIA_URL_TTL_SECONDS || 6 * 3600),
  publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/+$/, ""),
  r2: {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  },
  patterns: {
    ...(env.DELETED_NOTICE_PATTERN && { deletedPattern: env.DELETED_NOTICE_PATTERN }),
    ...(env.SNAP_TILE_PATTERN && { snapPattern: env.SNAP_TILE_PATTERN }),
  },
};

if (!config.apiToken) {
  console.error("API_TOKEN is required: it protects access to your Snapchat sessions.");
  process.exit(1);
}
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDb(config.dataDir);
const cleaned = purgeProvenEmptyLegacy(db, config.dataDir);
if (cleaned) console.log(`Removed ${cleaned} empty legacy account placeholder(s); session profiles and archives were untouched.`);
const tenantAuth = new TenantAuth(db, { adminToken: config.adminToken });
const mediaStorage = new MediaStorage({ ...config, publicUrl: config.publicUrl || `http://localhost:${config.port}` });
const BotClass = config.mock ? (await import("./mockBot.js")).default : undefined;
const accounts = new AccountManager({
  db,
  cipher: createCipher(config.secretKey),
  media: mediaStorage,
  config,
  BotClass,
});

// single-session installs kept the profile in /data/chrome-profile: adopt it
const legacyProfile = path.join(config.dataDir, "chrome-profile");
if (fs.existsSync(legacyProfile) && db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n === 0) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO accounts (id, label, username, secret, created_at) VALUES (?, ?, ?, NULL, ?)")
    .run(id, config.username || "Default", config.username || null, Date.now());
  fs.mkdirSync(path.join(config.dataDir, "profiles"), { recursive: true });
  fs.renameSync(legacyProfile, accounts.profileDir(id));
  fs.rmSync(path.join(config.dataDir, "messages.json"), { force: true });
}

// ---- REST ----

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const authAction = (name, method) => (req, res) => {
  try {
    const phone = req.body?.phone || "";
    const gate = tenantAuth.guard(name, clientIp(req), name === "login" || name === "recovery" ? phone : "");
    const result = method(req.body || {});
    gate.success();
    res.setHeader("Cache-Control", "no-store");
    res.status(name === "signup" ? 201 : 200).json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};
app.post("/api/auth/signup", authAction("signup", (p) => tenantAuth.signup(p.phone, p.password)));
app.post("/api/auth/login", authAction("login", (p) => tenantAuth.login(p.phone, p.password)));
app.post("/api/auth/recover", authAction("recovery", (p) =>
  tenantAuth.recover(p.phone, p.recoveryCode, p.newPassword)));
app.post("/api/auth/key-login", authAction("key", (p) => {
  const user = tenantAuth.resolve(p.apiKey);
  if (!user) tenantAuth.fail("Invalid account key", 401);
  return { user, apiKey: p.apiKey };
}));
app.post("/api/auth/logout", (req, res) => {
  if (!tenantAuth.revoke(bearer(req))) return res.status(401).json({ error: "Sign in required" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ loggedOut: true });
});
app.get("/api/auth/me", (req, res) => {
  const user = tenantAuth.resolve(bearer(req));
  res.setHeader("Cache-Control", "no-store");
  return user ? res.json({ user }) : res.status(401).json({ error: "Sign in required" });
});

// An entirely separate admin secret controls global operations. Neither an
// app user's key nor the service API_TOKEN can exercise the Admin Core.
app.use("/api/admin", (req, res, next) => {
  try {
    tenantAuth.guard("admin", clientIp(req));
    if (!tenantAuth.checkAdmin(req.headers["x-admin-key"])) return res.status(403).json({ error: "Admin access denied" });
    res.setHeader("Cache-Control", "no-store");
    next();
  } catch (error) { res.status(error.statusCode || 403).json({ error: error.message }); }
});
app.get("/api/admin/overview", (_req, res) => {
  const accountsList = accounts.list();
  const users = tenantAuth.users();
  const media = db.prepare("SELECT COALESCE(SUM(size),0) bytes, COUNT(*) count FROM media WHERE status='stored'").get();
  res.json({
    users: users.length, snapchatAccounts: accountsList.length,
    unassigned: accountsList.filter(a => !accounts.get(a.id).account.owner_user_id).length,
    connected: accountsList.filter(a => a.status === "connected").length,
    archive: db.prepare("SELECT COUNT(*) n FROM messages").get().n,
    mediaBytes: media.bytes, mediaCount: media.count, mediaStorage: mediaStorage.kind,
  });
});
const usageForUser = db.prepare(`
  SELECT COALESCE((SELECT COUNT(*) FROM messages
      WHERE account_id IN (SELECT id FROM accounts WHERE owner_user_id=?)),0) AS archived,
    COALESCE((SELECT SUM(size) FROM media
      WHERE account_id IN (SELECT id FROM accounts WHERE owner_user_id=?)
      AND status='stored'),0) AS mediaBytes
`);
const auditInsert = db.prepare("INSERT INTO admin_audit (action,target,client_hash,at) VALUES (?,?,?,?)");
const adminAudit = (req, action, target = null) => {
  const clientHash = crypto.createHash("sha256").update(String(clientIp(req))).digest("hex").slice(0, 16);
  auditInsert.run(action, target, clientHash, Date.now());
};
app.get("/api/admin/audit", (_req, res) =>
  res.json(db.prepare("SELECT action, target, at FROM admin_audit ORDER BY seq DESC LIMIT 50").all()));
app.get("/api/admin/users", (_req, res) => {
  const users = tenantAuth.users().map(u => ({
    ...u, accounts: accounts.list(u.id), usage: usageForUser.get(u.id, u.id),
  }));
  const legacy = accounts.list().filter(a => !accounts.get(a.id).account.owner_user_id);
  res.json({ users, legacy });
});
app.post("/api/admin/claim", (req, res) => {
  try {
    const userId = String(req.body?.userId || ""), accountId = String(req.body?.accountId || "");
    if (!tenantAuth.sql.getId.get(userId)) return res.status(404).json({ error: "User not found" });
    const account = accounts.claim(userId, accountId);
    adminAudit(req, "claim", accountId + " -> " + userId);
    res.json({ account });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete("/api/admin/users/:id", async (req, res) => {
  try {
    const user = tenantAuth.sql.getId.get(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (String(req.body?.confirmPhone || "").replace(/\D/g, "") !== user.phone) {
      return res.status(400).json({ error: "Type the full account phone to confirm deletion" });
    }
    const removedAccounts = await accounts.removeAllForOwner(user.id);
    tenantAuth.deleteUser(user.id);
    adminAudit(req, "delete-user", user.id + " (accounts: " + removedAccounts + ")");
    res.json({ deleted: true, removedAccounts });
  } catch (error) { res.status(500).json({ error: "Account removal failed: " + error.message }); }
});

app.use("/api", (req, res, next) => {
  req.tenant = tenantAuth.resolve(bearer(req));
  if (!req.tenant) return res.status(401).json({ error: "Sign in required" });
  next();
});

const handle = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
};
const owned = req => accounts.owned(req.tenant.id, req.params.id);
const session = (req) => owned(req).session;
const store = (req) => owned(req).store;

app.get("/api/accounts", handle(req => accounts.list(req.tenant.id)));
app.post("/api/accounts", handle((req) => accounts.create({ ...(req.body || {}), ownerId: req.tenant.id })));
app.patch("/api/accounts/:id", handle((req) => (owned(req), accounts.update(req.params.id, req.body || {}))));
app.delete("/api/accounts/:id", handle((req) => (owned(req), accounts.remove(req.params.id))));
app.post("/api/accounts/:id/start", handle((req) => { session(req).start(); }));
app.post("/api/accounts/:id/restart", handle((req) => { session(req).restart(); }));
app.post("/api/accounts/:id/logout", handle((req) => session(req).logout()));
app.post("/api/accounts/:id/login", handle((req) => (owned(req), accounts.login(req.params.id, req.body || {}))));
app.get("/api/accounts/:id/events", handle((req) => (owned(req), accounts.events(req.params.id))));
app.get("/api/accounts/:id/chats", handle((req) => (owned(req), accounts.chatsWithPreviews(req.params.id))));
app.get("/api/accounts/:id/chats/:chatId/messages", handle((req) =>
  (owned(req), accounts.messages(req.params.id, req.params.chatId, {
    beforeOrd: req.query.before ? Number(req.query.before) : Infinity,
  }))
));
app.post("/api/accounts/:id/chats/:chatId/messages", handle(async (req) => {
  const text = String(req.body?.text || "").trim();
  if (!text) throw new Error("text required");
  await session(req).sendMessage(req.params.chatId, text);
}));
app.get("/api/accounts/:id/screen", async (req, res) => {
  const image = await Promise.resolve().then(() => session(req).screenshot()).catch(() => null);
  if (!image) return res.status(404).end();
  res.type("jpeg").send(image);
});

// signed, short-lived links for media kept on the local volume (R2 signs its own)
app.get(/^\/media\/(.+)$/, (req, res) => {
  // Historical /data/media files remain available after enabling R2.
  const key = req.params[0].split("/").map(decodeURIComponent).join("/");
  if (!mediaStorage.verify(key, req.query.exp, req.query.sig)) return res.status(403).end();
  try {
    res.sendFile(mediaStorage.localPath(key));
  } catch {
    res.status(404).end();
  }
});

// ---- WebSocket ----

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });

io.use((socket, next) => {
  const credential = socket.handshake.auth?.token;
  const user = tenantAuth.resolve(credential);
  if (!user) return next(new Error("Sign in required"));
  socket.data.user = user;
  socket.data.credential = credential;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  socket.join(`tenant:${user.id}`);
  // Revoked/rotated keys may not continue performing operations.
  socket.use((_packet, next) => tenantAuth.resolve(socket.data.credential) ? next() : next(new Error("Credential revoked")));
  socket.emit("config", { ttlMs: config.ttlMs, now: Date.now(), maxAccounts: config.maxAccounts });
  socket.emit("accounts", accounts.list(user.id));

  const ack = (fn) => async (payload, cb) => {
    try {
      const result = await fn(payload || {});
      cb?.({ ok: true, result });
    } catch (error) {
      cb?.({ ok: false, error: error.message });
    }
  };
  const entry = (p) => accounts.owned(user.id, p.accountId);

  // full state of one account; sent on every (re)connect so nothing stale lingers
  socket.on("account:open", ack((p) => {
    const { session } = entry(p);
    socket.emit("status", { accountId: p.accountId, ...session.getStatus() });
    socket.emit("chats", { accountId: p.accountId, chats: (entry(p), accounts.chatsWithPreviews(p.accountId)) });
    socket.emit("activity:list", { accountId: p.accountId, events: (entry(p), accounts.events(p.accountId)) });
  }));
  socket.on("account:create", ack((p) => accounts.create({ ...p, ownerId: user.id })));
  socket.on("account:update", ack((p) => { entry(p); return accounts.update(p.accountId, p); }));
  socket.on("account:remove", ack((p) => { entry(p); return accounts.remove(p.accountId); }));
  socket.on("account:login", ack((p) => { entry(p); return accounts.login(p.accountId, p); }));
  socket.on("account:start", ack((p) => { entry(p).session.start(); }));
  socket.on("account:restart", ack((p) => { entry(p).session.restart(); }));
  socket.on("account:logout", ack((p) => entry(p).session.logout()));

  socket.on("chat:select", ack(async (p) => {
    socket.emit("chat:snapshot", {
      accountId: p.accountId,
      chatId: p.chatId,
      messages: await (entry(p), accounts.messages(p.accountId, p.chatId)),
    });
    await entry(p).session.selectChat(p.chatId);
  }));
  socket.on("message:send", ack((p) => {
    entry(p);
    if (!p.text?.trim()) throw new Error("text required");
    return entry(p).session.sendMessage(p.chatId, p.text.trim());
  }));

  // live screen: one watched account per socket
  let watching = null;
  const stopWatching = async () => {
    if (!watching) return;
    const id = watching;
    watching = null;
    socket.leave(`screen:${id}`);
    await accounts.entries.get(id)?.session.removeViewer();
  };
  socket.on("screen:start", ack(async (p) => {
    if (watching === p.accountId) return;
    await stopWatching();
    const { session } = entry(p);
    watching = p.accountId;
    socket.join(`screen:${p.accountId}`);
    await session.addViewer();
  }));
  socket.on("screen:stop", ack(stopWatching));
  socket.on("screen:select-page", ack((p) => entry(p).session.selectScreenPage(p.pageId)));
  socket.on("disconnect", stopWatching);
  socket.on("screen:click", ack((p) => entry(p).session.click(Number(p.x), Number(p.y))));
  socket.on("screen:type", ack((p) => entry(p).session.type(String(p.text))));
  socket.on("screen:key", ack((p) => entry(p).session.press(String(p.key))));
  socket.on("screen:scroll", ack((p) => entry(p).session.scroll(Number(p.deltaY), Number(p.deltaX || 0))));
});

// ---- events -> clients + webhook ----

function webhook(event, data) {
  if (!config.webhookUrl) return;
  fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, data, at: Date.now() }),
  }).catch((error) => console.error("Webhook failed", error.message));
}

// Never broadcast private events or account lists across tenants.
accounts.on("accounts", () => {
  for (const socket of io.sockets.sockets.values()) {
    const user = tenantAuth.resolve(socket.data.credential);
    if (!user) { socket.disconnect(true); continue; }
    socket.emit("accounts", accounts.list(user.id));
  }
});
accounts.on("screen:frame", (data) => {
  const owner = accounts.entries.get(data.accountId)?.account.owner_user_id;
  if (owner) io.to(`screen:${data.accountId}`).volatile.emit("screen:frame", data);
});
for (const event of ["chats", "chat:snapshot", "activity", "status", "message:new",
  "message:updated", "message:removed"]) {
  accounts.on(event, (data) => {
    const owner = accounts.entries.get(data.accountId)?.account.owner_user_id;
    if (!owner) return;
    io.to(`tenant:${owner}`).emit(event, data);
    if (["status", "message:new", "message:updated", "message:removed"].includes(event)) webhook(event, data);
  });
}
setInterval(() => {
  for (const socket of io.sockets.sockets.values()) {
    if (!tenantAuth.resolve(socket.data.credential)) socket.disconnect(true);
  }
}, 10_000);

setInterval(() => accounts.sweep(), 15000);

server.listen(config.port, () => {
  console.log(`SnapBot server on :${config.port} (data: ${config.dataDir}${config.mock ? ", MOCK" : ""})`);
  console.log(`Media storage: ${mediaStorage.kind === "r2" ? "Cloudflare R2" : "local volume"}`);
  accounts.startAll();
});

const shutdown = async () => {
  await accounts.stopAll();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
