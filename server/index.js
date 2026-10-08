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

const env = process.env;
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const config = {
  port: Number(env.PORT || 3001),
  apiToken: env.API_TOKEN || "",
  secretKey: env.SECRET_KEY || env.API_TOKEN || "",
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((o) => o.trim()) : "*",
  dataDir: env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "./data"),
  // 0 = keep preserved messages forever (the point of preservation). Only applies
  // to consented, preserved chats; un-preserved chats are mirror-only anyway.
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
  // media capture, for consented pairs only
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
const media = new MediaStorage({ ...config, publicUrl: config.publicUrl || `http://localhost:${config.port}` });
const BotClass = config.mock ? (await import("./mockBot.js")).default : undefined;
const accounts = new AccountManager({
  db,
  cipher: createCipher(config.secretKey),
  media,
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

function validToken(token) {
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(config.apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- REST ----

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) =>
  res.json({ ok: true, accounts: accounts.list().map(({ status }) => status) })
);

app.use("/api", (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!validToken(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const handle = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
const session = (req) => accounts.get(req.params.id).session;
const store = (req) => accounts.get(req.params.id).store;

app.get("/api/accounts", handle(() => accounts.list()));
app.post("/api/accounts", handle((req) => accounts.create(req.body || {})));
app.patch("/api/accounts/:id", handle((req) => accounts.update(req.params.id, req.body || {})));
app.delete("/api/accounts/:id", handle((req) => accounts.remove(req.params.id)));
app.post("/api/accounts/:id/start", handle((req) => { session(req).start(); }));
app.post("/api/accounts/:id/restart", handle((req) => { session(req).restart(); }));
app.post("/api/accounts/:id/logout", handle((req) => session(req).logout()));
app.post("/api/accounts/:id/login", handle((req) => accounts.login(req.params.id, req.body || {})));
app.get("/api/accounts/:id/events", handle((req) => accounts.events(req.params.id)));
app.get("/api/accounts/:id/chats", handle((req) => accounts.chatsWithPreviews(req.params.id)));
app.get("/api/accounts/:id/chats/:chatId/messages", handle((req) =>
  accounts.messages(req.params.id, req.params.chatId, {
    beforeOrd: req.query.before ? Number(req.query.before) : Infinity,
  })
));
app.post("/api/accounts/:id/chats/:chatId/messages", handle(async (req) => {
  const text = String(req.body?.text || "").trim();
  if (!text) throw new Error("text required");
  await session(req).sendMessage(req.params.chatId, text);
}));
// consent handshake (preservation is off until both sides opt in)
app.get("/api/accounts/:id/pairs", handle((req) => accounts.pairs(req.params.id)));
app.post("/api/accounts/:id/chats/:chatId/handshake", handle((req) =>
  accounts.requestHandshake(req.params.id, req.params.chatId)
));
app.delete("/api/accounts/:id/chats/:chatId/handshake", handle((req) =>
  accounts.revokeHandshake(req.params.id, req.params.chatId)
));
app.get("/api/accounts/:id/screen", async (req, res) => {
  const image = await Promise.resolve().then(() => session(req).screenshot()).catch(() => null);
  if (!image) return res.status(404).end();
  res.type("jpeg").send(image);
});

// signed, short-lived links for media kept on the local volume (R2 signs its own)
app.get(/^\/media\/(.+)$/, (req, res) => {
  if (media.kind !== "local") return res.status(404).end();
  const key = req.params[0].split("/").map(decodeURIComponent).join("/");
  if (!media.verify(key, req.query.exp, req.query.sig)) return res.status(403).end();
  try {
    res.sendFile(media.localPath(key));
  } catch {
    res.status(404).end();
  }
});

// ---- WebSocket ----

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });

io.use((socket, next) => {
  if (validToken(socket.handshake.auth?.token)) return next();
  next(new Error("Unauthorized"));
});

io.on("connection", (socket) => {
  socket.emit("config", { ttlMs: config.ttlMs, now: Date.now(), maxAccounts: config.maxAccounts });
  socket.emit("accounts", accounts.list());

  const ack = (fn) => async (payload, cb) => {
    try {
      const result = await fn(payload || {});
      cb?.({ ok: true, result });
    } catch (error) {
      cb?.({ ok: false, error: error.message });
    }
  };
  const entry = (p) => accounts.get(p.accountId);

  // full state of one account; sent on every (re)connect so nothing stale lingers
  socket.on("account:open", ack((p) => {
    const { session } = entry(p);
    socket.emit("status", { accountId: p.accountId, ...session.getStatus() });
    socket.emit("chats", { accountId: p.accountId, chats: accounts.chatsWithPreviews(p.accountId) });
    socket.emit("activity:list", { accountId: p.accountId, events: accounts.events(p.accountId) });
  }));
  socket.on("account:create", ack((p) => accounts.create(p)));
  socket.on("account:update", ack((p) => accounts.update(p.accountId, p)));
  socket.on("account:remove", ack((p) => accounts.remove(p.accountId)));
  socket.on("account:login", ack((p) => accounts.login(p.accountId, p)));
  socket.on("account:start", ack((p) => { entry(p).session.start(); }));
  socket.on("account:restart", ack((p) => { entry(p).session.restart(); }));
  socket.on("account:logout", ack((p) => entry(p).session.logout()));

  socket.on("chat:select", ack(async (p) => {
    socket.emit("chat:snapshot", {
      accountId: p.accountId,
      chatId: p.chatId,
      messages: await accounts.messages(p.accountId, p.chatId),
    });
    await entry(p).session.selectChat(p.chatId);
  }));
  socket.on("message:send", ack((p) => {
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
  socket.on("disconnect", stopWatching);
  socket.on("screen:click", ack((p) => entry(p).session.click(Number(p.x), Number(p.y))));
  socket.on("screen:type", ack((p) => entry(p).session.type(String(p.text))));
  socket.on("screen:key", ack((p) => entry(p).session.press(String(p.key))));
  socket.on("screen:scroll", ack((p) => entry(p).session.scroll(Number(p.deltaY))));
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

accounts.on("accounts", (list) => io.emit("accounts", list));
accounts.on("screen:frame", ({ accountId, frame }) =>
  io.to(`screen:${accountId}`).volatile.emit("screen:frame", { accountId, frame })
);
for (const event of ["chats", "chat:snapshot", "activity"]) {
  accounts.on(event, (data) => io.emit(event, data));
}
for (const event of ["status", "message:new", "message:updated", "message:removed"]) {
  accounts.on(event, (data) => {
    io.emit(event, data);
    webhook(event, data);
  });
}

setInterval(() => accounts.sweep(), 15000);

server.listen(config.port, () => {
  console.log(`SnapBot server on :${config.port} (data: ${config.dataDir}${config.mock ? ", MOCK" : ""})`);
  console.log(`Media storage: ${media.kind === "r2" ? "Cloudflare R2" : "local volume"}`);
  accounts.startAll();
});

const shutdown = async () => {
  await accounts.stopAll();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
