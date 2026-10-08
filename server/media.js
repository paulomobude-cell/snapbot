import fs from "fs";
import path from "path";
import crypto from "crypto";
import { AwsClient } from "aws4fetch";

// Guess the real type from the first bytes; decrypted Snapchat blobs often
// come without a useful MIME type.
export function sniffType(buffer, fallback = "") {
  const b = buffer;
  const hex = b.subarray(0, 12).toString("hex");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("47494638")) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(4, 8).toString() === "ftyp") {
    const brand = b.subarray(8, 12).toString();
    if (/^(heic|heix|mif1|msf1)/.test(brand)) return "image/heic";
    return "video/mp4";
  }
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  return fallback && fallback !== "application/octet-stream" ? fallback : "application/octet-stream";
}

const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "image/heic": "heic", "video/mp4": "mp4", "video/webm": "webm",
};

// Stores media in Cloudflare R2 when configured, otherwise on the data volume.
// Either way the frontend only ever gets short-lived signed URLs.
export default class MediaStorage {
  constructor(config) {
    this.secret = crypto.createHash("sha256").update(`media:${config.secretKey}`).digest();
    this.publicUrl = config.publicUrl; // backend's own URL, for local signed links
    // Keep local storage mounted even if R2 is enabled: existing media records
    // refer to bare keys and must stay readable until explicitly migrated.
    this.dir = path.join(config.dataDir, "media");
    fs.mkdirSync(this.dir, { recursive: true });
    const r2 = config.r2 || {};
    if (r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket) {
      this.kind = "r2";
      this.bucketUrl = `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}`;
      this.client = new AwsClient({
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
        service: "s3",
        region: "auto",
      });
    } else {
      this.kind = "local";
    }
  }

  keyFor({ accountId, chatId, sha256, contentType }) {
    const safeChat = String(chatId).replace(/[^\w-]/g, "_");
    return `${accountId}/${safeChat}/${sha256}.${EXT[contentType] || "bin"}`;
  }

  async put(key, buffer, contentType) {
    if (this.kind === "r2") {
      const res = await this.client.fetch(`${this.bucketUrl}/${encodeKey(key)}`, {
        method: "PUT",
        body: buffer,
        headers: { "content-type": contentType, "content-length": String(buffer.length) },
      });
      if (!res.ok) throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
      return;
    }
    const file = this.localPath(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buffer);
  }

  async remove(key) {
    // Delete both for cross-backend key migration; R2 deletion failures are
    // surfaced so callers can retry rather than silently leak stored media.
    if (this.kind === "r2") {
      const res = await this.client.fetch(`${this.bucketUrl}/${encodeKey(key)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 deletion failed: ${res.status}`);
    }
    await fs.promises.rm(this.localPath(key), { force: true });
  }

  // signed GET link valid for `seconds`
  async url(key, seconds, baseUrl) {
    if (this.kind === "r2" && !fs.existsSync(this.localPath(key))) {
      const signed = await this.client.sign(
        `${this.bucketUrl}/${encodeKey(key)}?X-Amz-Expires=${seconds}`,
        { method: "GET", aws: { signQuery: true } }
      );
      return signed.url;
    }
    const exp = Math.floor(Date.now() / 1000) + seconds;
    return `${this.publicUrl || baseUrl}/media/${encodeKey(key)}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  sign(key, exp) {
    return crypto.createHmac("sha256", this.secret).update(`${key}\n${exp}`).digest("base64url");
  }

  // for the local /media route
  verify(key, exp, sig) {
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(String(sig));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }

  localPath(key) {
    const file = path.resolve(this.dir, key);
    if (!file.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("Bad media key");
    return file;
  }
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}
