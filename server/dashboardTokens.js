import crypto from "node:crypto";

// Browser receives a short-lived, narrowly scoped Socket.IO ticket, never API_TOKEN.
// Railway alone holds the HMAC signing key (SECRET_KEY or API_TOKEN fallback).
const AUDIENCE = "snapbot:dashboard:socket";
const MAX_SECONDS = 15 * 60;

export function createSocketTicket(secret, now = Date.now(), ttlSeconds = 10 * 60) {
  if (!secret || ttlSeconds < 1 || ttlSeconds > MAX_SECONDS) throw new Error("Invalid socket ticket settings");
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({
    v: 1, aud: AUDIENCE, exp: expiresAt, nonce: crypto.randomBytes(12).toString("hex"),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update("snapbot:ticket:v1:" + body).digest("base64url");
  return { token: body + "." + signature, expiresAt: expiresAt * 1000 };
}

export function verifySocketTicket(secret, ticket, now = Date.now()) {
  if (!secret || typeof ticket !== "string" || ticket.length > 1024) return false;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match) return false;
  const [, body, signature] = match;
  const expected = crypto.createHmac("sha256", secret)
    .update("snapbot:ticket:v1:" + body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const t = Math.floor(now / 1000);
    return payload?.v === 1 &&
      payload?.aud === AUDIENCE &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp > t &&
      payload.exp <= t + MAX_SECONDS &&
      typeof payload.nonce === "string" && /^[a-f0-9]{24}$/.test(payload.nonce);
  } catch {
    return false;
  }
}
