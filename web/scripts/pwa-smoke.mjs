import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const exists = (name) => fs.readFileSync(path.join(dist, name));
const html = exists("index.html").toString("utf8");
const manifest = JSON.parse(exists("manifest.webmanifest").toString("utf8"));
const sw = exists("sw.js").toString("utf8");
assert.match(html, /manifest\.webmanifest/, "manifest link not in built HTML");
assert.match(html, /apple-touch-icon\.png/, "Apple touch icon missing from HTML");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.start_url, "/");
assert.equal(manifest.scope, "/");
assert.match(sw, /caches\.open\(SHELL\)/, "service worker lacks precache");
assert.match(sw, /request\.mode === 'navigate'/, "missing offline navigation");
assert.match(sw, /url\.origin !== self\.location\.origin/, "cross-origin responses must bypass worker");
assert.match(sw, /api\|socket/, "API and Socket.IO paths must bypass cache");
assert.match(sw, /request\.headers\.has\('authorization'\)/, "authorized requests must bypass cache");
assert.match(sw, /SKIP_WAITING/, "manual update activation missing");
exists("offline.html");
for (const [file, size] of [
  ["icons/icon-192.png", 192],
  ["icons/icon-512.png", 512],
  ["icons/maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  const png = exists(file);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file + " is not PNG");
  assert.equal(png.readUInt32BE(16), size, file + " width");
  assert.equal(png.readUInt32BE(20), size, file + " height");
}
console.log("PWA smoke checks passed: app manifest, install icons, SW offline/update/privacy policy.");
