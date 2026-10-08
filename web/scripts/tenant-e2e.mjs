import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { openDb } from "../../server/db.js";

const root = path.resolve(import.meta.dirname, "../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapbot-tenant-e2e-"));
const adminToken = crypto.randomBytes(32).toString("hex");
const serviceToken = crypto.randomBytes(32).toString("hex");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const n = server.address().port;
    server.close(() => resolve(n));
  });
});
const base = "http://127.0.0.1:" + port;
let server;
const sockets = [];
async function request(url, options = {}, key, extra = {}) {
  const res = await fetch(base + url, {
    ...options,
    headers: {
      "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}),
      ...extra, ...(options.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (url, body, key, extra) => request(url, { method: "POST", body: JSON.stringify(body) }, key, extra);
const call = (s, event, payload) => new Promise((resolve, reject) => {
  s.timeout(4000).emit(event, payload, (error, response) =>
    error ? reject(error) : resolve(response));
});
async function connect(key) {
  const socket = io(base, { auth: { token: key }, transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Socket connection timed out")), 6000)),
  ]);
  return socket;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const seed = openDb(dataDir);
  seed.prepare("INSERT INTO accounts (id,label,username,secret,created_at) VALUES ('legacy', 'Previous Snapchat', 'saved', NULL, ?)")
    .run(Date.now());
  seed.prepare(`INSERT INTO messages
    (account_id,id,uid,chat_id,kind,from_name,is_me,text,time,ord,state,first_seen_at)
    VALUES ('legacy','old','old-uid','sam','text','friend',0,'previously archived','10:00',1,'gone',?)`)
    .run(Date.now());
  seed.close();
  server = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "server/index.js"], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, MOCK: "true",
      API_TOKEN: serviceToken,
      ADMIN_API_TOKEN: adminToken, SECRET_KEY: "fixed-secret",
      CORS_ORIGIN: "http://localhost:5173", MAX_ACCOUNTS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", d => { stderr += String(d); });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("Backend exited: " + stderr);
    try {
      const response = await fetch(base + "/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  assert.ok(ready, "Backend didn't start: " + stderr);

  const a = await post("/api/auth/signup", { phone: "15555550101", password: "secure-passphrase-A" });
  const b = await post("/api/auth/signup", { phone: "15555550102", password: "secure-passphrase-B" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const keyA = a.body.apiKey, keyB = b.body.apiKey;
  assert.notEqual(keyA, keyB);
  const aSocket = await connect(keyA);
  const bSocket = await connect(keyB);
  const createA = await call(aSocket, "account:create", { label: "A's Snapchat" });
  const createB = await call(bSocket, "account:create", { label: "B's Snapchat" });
  assert.ok(createA.ok && createB.ok);
  const idA = createA.result.id, idB = createB.result.id;
  const listA = await request("/api/accounts", {}, keyA);
  const listB = await request("/api/accounts", {}, keyB);
  assert.deepEqual(listA.body.map(x => x.id), [idA]);
  assert.deepEqual(listB.body.map(x => x.id), [idB]);
  assert.equal((await request("/api/accounts")).status, 401);
  assert.equal((await request("/api/accounts", {}, serviceToken)).status, 401);
  assert.equal((await post("/api/accounts", { label: "unauthorized" })).status, 401);
  assert.equal((await call(aSocket, "account:open", { accountId: idB })).ok, false);
  assert.equal((await call(aSocket, "account:remove", { accountId: idB })).ok, false);
  assert.equal((await call(aSocket, "screen:start", { accountId: idB })).ok, false);
  assert.equal((await call(aSocket, "message:send", { accountId: idB, chatId: "sam", text: "hi" })).ok, false);
  assert.equal((await request("/api/accounts/" + idB + "/chats", {}, keyA)).status, 404);
  assert.equal((await request("/api/accounts/" + idB + "/events", {}, keyA)).status, 404);
  // Prove unsolicited Socket.IO events stay inside the owning tenant room.
  let crossTenantStatus = false;
  aSocket.on("status", data => { if (data.accountId === idB) crossTenantStatus = true; });
  const restarted = await call(bSocket, "account:restart", { accountId: idB });
  assert.equal(restarted.ok, true);
  await sleep(300);
  assert.equal(crossTenantStatus, false, "User A must not receive user B's session events");

  const personal = await post("/api/auth/login", { phone: "15555550101", password: "secure-passphrase-A" });
  assert.equal(personal.status, 200);
  assert.equal((await request("/api/auth/me", {}, personal.body.apiKey)).body.user.id, a.body.user.id);
  assert.equal((await request("/api/auth/me", {}, keyA)).status, 200);
  assert.equal((await post("/api/auth/logout", {}, personal.body.apiKey)).status, 200);
  assert.equal((await request("/api/auth/me", {}, personal.body.apiKey)).status, 401);
  assert.equal((await request("/api/auth/me", {}, keyA)).status, 200);

  assert.equal((await request("/api/admin/users", {}, keyA)).status, 403);
  assert.equal((await request("/api/admin/users", {}, undefined, { "x-admin-key": "wrong" })).status, 403);
  const info = await request("/api/admin/users", {}, undefined, { "x-admin-key": adminToken });
  assert.equal(info.status, 200);
  assert.equal(info.body.legacy.length, 1);
  assert.equal(info.body.legacy[0].id, "legacy");
  const claim = await post("/api/admin/claim", { userId: a.body.user.id, accountId: "legacy" }, undefined, { "x-admin-key": adminToken });
  assert.equal(claim.status, 200);
  const usage = await request("/api/admin/users", {}, undefined, { "x-admin-key": adminToken });
  assert.equal(usage.body.users.find(u => u.id === a.body.user.id).usage.archived, 1);
  assert.equal((await request("/api/accounts", {}, keyB)).body.length, 1);
  assert.equal((await request("/api/accounts", {}, keyA)).body.length, 2);
  const retained = await request("/api/accounts/legacy/chats/sam/messages", {}, keyA);
  assert.equal(retained.status, 200);
  assert.equal(retained.body[0].text, "previously archived");
  assert.equal((await request("/api/accounts/legacy/chats/sam/messages", {}, keyB)).status, 404);

  const deleted = await request("/api/admin/users/" + b.body.user.id, {
    method: "DELETE", body: JSON.stringify({ confirmPhone: "15555550102" }),
  }, undefined, { "x-admin-key": adminToken });
  assert.equal(deleted.status, 200);
  const audit = await request("/api/admin/audit", {}, undefined, { "x-admin-key": adminToken });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some(item => item.action === "claim"));
  assert.ok(audit.body.some(item => item.action === "delete-user"));
  assert.equal((await request("/api/auth/me", {}, keyB)).status, 401);
  assert.equal((await request("/api/accounts", {}, keyA)).body.length, 2);
  assert.equal((await request("/api/accounts/legacy/chats/sam/messages", {}, keyA)).body[0].text, "previously archived");

  const recovery = await post("/api/auth/recover", {
    phone: "15555550101", recoveryCode: a.body.recoveryCode, newPassword: "new-secure-passphrase-A",
  });
  assert.equal(recovery.status, 200);
  assert.equal((await request("/api/auth/me", {}, keyA)).status, 401);
  assert.equal((await request("/api/auth/me", {}, personal.body.apiKey)).status, 401);
  assert.equal((await request("/api/auth/me", {}, recovery.body.apiKey)).status, 200);
  console.log("Tenant e2e: signup, login, independent sessions, strict Socket.IO/REST isolation, admin claim/deletion, legacy archive, recovery: passed");
} finally {
  for (const socket of sockets) socket.disconnect();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise(resolve => server.once("exit", resolve)), sleep(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
