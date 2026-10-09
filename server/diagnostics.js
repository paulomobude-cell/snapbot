import crypto from "node:crypto";

// Privacy-safe production telemetry. Do not log usernames, message bodies,
// browser URLs, media URLs, account IDs, cookies or credentials. Emit only
// hashed tenant-scoped references and bounded, predefined diagnostic fields.
function fingerprint(...parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

const numericFields = new Set([
  "count", "total", "completed", "failed", "captured", "items", "text", "status",
  "snap", "image", "video", "media", "stored", "reused", "unavailable",
  "retryDeferred", "viewOnceSkipped", "buffered", "newMessages", "elapsedMs",
  "pages", "reachedTop", "truncated", "reordered",
  "visible", "audioElements", "audioSources", "loadingPlaceholders", "voiceControls",
]);
const stringFields = new Set(["mode", "stage", "reason", "provider"]);

export function classifyDiagnosticError(error) {
  const value = String(error?.message || error || "");
  if (/NoSuchBucket/i.test(value)) return "r2_no_such_bucket";
  const http = /R2 (?:upload|deletion) failed:\s*(\d{3})/i.exec(value);
  if (http) return "r2_http_" + http[1];
  if (/timed?\s*out|timeout/i.test(value)) return "timeout";
  if (/not found|not discovered|virtualized/i.test(value)) return "chat_not_found";
  if (/render|selector/i.test(value)) return "chat_not_rendered";
  if (/ECONN|ENOTFOUND|network|fetch failed/i.test(value)) return "network_failure";
  return "other";
}

export function diagnostic(event, { accountId, chatId, ...metrics } = {}) {
  const payload = { event };
  if (accountId) payload.account = fingerprint(accountId);
  if (chatId) payload.chat = fingerprint(accountId || "unknown", chatId);
  for (const [key, value] of Object.entries(metrics)) {
    if (numericFields.has(key) && Number.isFinite(value)) payload[key] = Math.max(0, Math.floor(value));
    else if (stringFields.has(key) && typeof value === "string" && /^[a-z][a-z0-9_-]{0,48}$/.test(value)) payload[key] = value;
  }
  console.info("[snapbot]", JSON.stringify(payload));
}
