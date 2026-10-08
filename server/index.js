import "dotenv/config";
import fs from "fs";
import http from "http";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import MessageStore from "./store.js";
import Session from "./session.js";

const env = process.env;
const config = {
  port: Number(env.PORT || 3001),
  apiToken: env.API_TOKEN || "",
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((o) => o.trim()) : "*",
  dataDir: env.DATA_DIR || (fs.existsSync("/data") ? "/data" : "./data"),
  ttlMs: Number(env.MESSAGE_TTL_HOURS || 24) * 60 * 60 * 1000,
  syncIntervalMs: Number(env.SYNC_INTERVAL_MS || 4000),
  fullSyncIntervalMs: Number(env.FULL_SYNC_INTERVAL_MS || 60000),
  headless: env.HEADLESS !== "false",
  chromePath: env.PUPPETEER_EXECUTABLE_PATH,
  username: env.USER_NAME,
  password: env.USER_PASSWORD,
  blockTyping: env.BLOCK_TYPING === "true",
  webhookUrl: env.WEBHOOK_URL,
  mock: env.MOCK === "true",
};

if (!config.apiToken) {
  console.error("API_TOKEN is required: it protects access to your Snapchat session.");
  process.exit(1);
}
fs.mkdirSync(config.dataDir, { recursive: true });

const store = new MessageStore({ dataDir: config.dataDir, ttlMs: config.ttlMs });
const BotClass = config.mock ? (await import("./mockBot.js")).default : undefined;
const session = new Session({ store, config, BotClass });

function validToken(token) {
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(config.apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- REST ----

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true, ...session.getStatus() }));

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

app.get("/api/status", handle(() => session.getStatus()));
app.post("/api/session/start", handle(() => { session.start(); }));
app.post("/api/session/restart", handle(() => { session.restart(); }));
app.post("/api/session/logout", handle(() => session.logout()));
app.post("/api/session/login", handle((req) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw new Error("username and password required");
  session.login(username, password).catch((e) => console.error("Login failed", e));
}));
app.get("/api/chats", handle(() => session.chats));
app.get("/api/chats/:id/messages", handle((req) => store.getMessages(req.params.id)));
app.post("/api/chats/:id/messages", handle(async (req) => {
  const text = String(req.body?.text || "").trim();
  if (!text) throw new Error("text required");
  await session.sendMessage(req.params.id, text);
}));
app.get("/api/screen", async (req, res) => {
  const image = await session.screenshot().catch(() => null);
  if (!image) return res.status(404).end();
  res.type("jpeg").send(image);
});

// ---- WebSocket ----

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });

io.use((socket, next) => {
  if (validToken(socket.handshake.auth?.token)) return next();
  next(new Error("Unauthorized"));
});

io.on("connection", (socket) => {
  // full state on every (re)connect, so the client never keeps stale messages
  socket.emit("status", session.getStatus());
  socket.emit("chats", session.chats);
  socket.emit("config", { ttlMs: config.ttlMs, now: Date.now() });

  const ack = (fn) => async (payload, cb) => {
    try {
      await fn(payload || {});
      cb?.({ ok: true });
    } catch (error) {
      cb?.({ ok: false, error: error.message });
    }
  };

  socket.on("chat:select", ack(async ({ chatId }) => {
    socket.emit("chat:snapshot", { chatId, messages: store.getMessages(chatId) });
    await session.selectChat(chatId);
  }));
  socket.on("message:send", ack(({ chatId, text }) => {
    if (!text?.trim()) throw new Error("text required");
    return session.sendMessage(chatId, text.trim());
  }));
  socket.on("session:start", ack(() => { session.start(); }));
  socket.on("session:restart", ack(() => { session.restart(); }));
  socket.on("session:logout", ack(() => session.logout()));
  socket.on("session:login", ack(({ username, password }) => {
    session.login(username, password).catch((e) => console.error("Login failed", e));
  }));

  let watching = false;
  socket.on("screen:start", ack(async () => {
    if (watching) return;
    watching = true;
    socket.join("screen");
    await session.addViewer();
  }));
  const stopWatching = async () => {
    if (!watching) return;
    watching = false;
    socket.leave("screen");
    await session.removeViewer();
  };
  socket.on("screen:stop", ack(stopWatching));
  socket.on("disconnect", stopWatching);
  socket.on("screen:click", ack(({ x, y }) => session.click(Number(x), Number(y))));
  socket.on("screen:type", ack(({ text }) => session.type(String(text))));
  socket.on("screen:key", ack(({ key }) => session.press(String(key))));
  socket.on("screen:scroll", ack(({ deltaY }) => session.scroll(Number(deltaY))));
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

session.on("status", (s) => { io.emit("status", s); webhook("status", s); });
session.on("chats", (chats) => io.emit("chats", chats));
session.on("screen:frame", (frame) => io.to("screen").volatile.emit("screen:frame", frame));
for (const event of ["message:new", "message:deleted", "message:expired"]) {
  store.on(event, (data) => { io.emit(event, data); webhook(event, data); });
}
store.on("chat:snapshot", (data) => io.emit("chat:snapshot", data));

setInterval(() => store.sweep(), 15000);

server.listen(config.port, () => {
  console.log(`SnapBot server on :${config.port} (data: ${config.dataDir}${config.mock ? ", MOCK" : ""})`);
  session.start();
});

const shutdown = async () => {
  store.saveNow();
  await session.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
