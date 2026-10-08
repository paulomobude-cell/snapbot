import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const snap = pkg.name === "snapbot-web";
const appId = snap ? "snapbot" : "commnexus";
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, check]);
}
function inRound(x, y, l, t, r, b, rad) {
  const px = Math.max(l + rad, Math.min(r - rad, x));
  const py = Math.max(t + rad, Math.min(b - rad, y));
  return (x - px) ** 2 + (y - py) ** 2 <= rad ** 2;
}
function symbol(x, y) {
  if (snap) {
    const head = (x - .5) ** 2 + (y - .41) ** 2 < .19 ** 2;
    const body = x > .31 && x < .69 && y >= .41 && y < .70;
    const feet = y >= .67 && y < .76 && (
      (x > .29 && x < .42) || (x > .43 && x < .57) || (x > .58 && x < .71));
    const shape = head || body || feet;
    const leftEye = (x - .435) ** 2 + (y - .42) ** 2 < .022 ** 2;
    const rightEye = (x - .565) ** 2 + (y - .42) ** 2 < .022 ** 2;
    const mouth = (x - .5) ** 2 / (.032 ** 2) + (y - .525) ** 2 / (.045 ** 2) < 1;
    return shape ? ((leftEye || rightEye || mouth) ? 2 : 1) : 0;
  }
  const bubble = inRound(x, y, .22, .27, .78, .68, .13);
  const tail = x > .255 && x < .405 && y > .61 && y < .79 && x < .40 - (y - .61) * .62;
  const dot = [.39, .5, .61].some(cx => (x - cx) ** 2 + (y - .475) ** 2 < .023 ** 2);
  return bubble || tail ? (dot ? 2 : 1) : 0;
}
function png(size, maskable = false) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const start = snap ? [255, 252, 0] : [79, 70, 229];
  const end = snap ? [255, 222, 0] : [139, 92, 246];
  for (let y = 0; y < size; y++) {
    const nY = (y + .5) / size;
    for (let x = 0; x < size; x++) {
      const nX = (x + .5) / size;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const isBg = maskable || inRound(nX, nY, .015, .015, .985, .985, .18);
      const pct = (nX + nY) / 2;
      const c = start.map((v, i) => Math.round(v + (end[i] - v) * pct));
      let symX = nX, symY = nY;
      if (maskable) { symX = .5 + (nX - .5) / .80; symY = .5 + (nY - .5) / .80; }
      const mark = symbol(symX, symY);
      const ink = snap ? [24, 24, 26] : [36, 26, 103];
      const foreground = [255, 255, 255];
      const rgb = mark === 1 ? foreground : mark === 2 ? ink : c;
      rows[offset] = rgb[0];
      rows[offset + 1] = rgb[1];
      rows[offset + 2] = rgb[2];
      rows[offset + 3] = isBg ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function generateIcons() {
  fs.mkdirSync(path.join(publicDir, "icons"), { recursive: true });
  for (const size of [192, 512])
    fs.writeFileSync(path.join(publicDir, "icons", "icon-" + size + ".png"), png(size));
  fs.writeFileSync(path.join(publicDir, "icons", "maskable-512.png"), png(512, true));
  fs.writeFileSync(path.join(publicDir, "apple-touch-icon.png"), png(180));
  console.log("Generated " + appId + " PNG icons for Android, desktop and Apple devices");
}
function finalize() {
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const assets = [...new Set((html.match(/\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)/g) || []))];
  const precache = [
    "/offline.html", "/manifest.webmanifest", "/index.html",
    "/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png",
    "/icons/maskable-512.png", ...assets,
  ];
  for (const pathname of precache) {
    const file = path.join(distDir, pathname.replace(/^\//, ""));
    if (!fs.existsSync(file)) throw new Error("Missing PWA precache asset: " + pathname);
  }
  const revision = crypto.createHash("sha256").update(html)
    .update(assets.map(a => fs.statSync(path.join(distDir, a.slice(1))).size).join(":"))
    .update(fs.readFileSync(path.join(root, "scripts", "pwa-build.mjs")))
    .digest("hex").slice(0, 12);
  const prefix = "pwa-" + appId + "-";
  const shell = prefix + revision + "-shell";
  const runtime = prefix + revision + "-assets";
  const source = [
    "/* Generated on build. Do not edit dist/sw.js. */",
    "const SHELL = " + JSON.stringify(shell) + ";",
    "const ASSETS = " + JSON.stringify(runtime) + ";",
    "const PREFIX = " + JSON.stringify(prefix) + ";",
    "const PRECACHE = " + JSON.stringify(precache) + ";",
    "self.addEventListener('install', event => {",
    "  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(PRECACHE)));",
    "});",
    "self.addEventListener('activate', event => {",
    "  event.waitUntil((async () => {",
    "    for (const key of await caches.keys()) {",
    "      if (key.startsWith(PREFIX) && key !== SHELL && key !== ASSETS) await caches.delete(key);",
    "    }",
    "    await self.clients.claim();",
    "  })());",
    "});",
    "self.addEventListener('message', event => {",
    "  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();",
    "});",
    "self.addEventListener('fetch', event => {",
    "  const request = event.request;",
    "  if (request.method !== 'GET' || request.headers.has('authorization')) return;",
    "  const url = new URL(request.url);",
    "  if (url.origin !== self.location.origin) return;",
    "  if (/^\\/(api|socket\\.io|media)(\\/|$)/.test(url.pathname)) return;",
    "  if (request.mode === 'navigate') {",
    "    event.respondWith(fetch(request).catch(async () =>",
    "      (await caches.match('/offline.html')) ||",
    "      new Response('Offline. Reconnect and try again.', { status: 503, headers: { 'Content-Type': 'text/plain' } })",
    "    ));",
    "    return;",
    "  }",
    "  if (!url.pathname.startsWith('/assets/') || !['script', 'style', 'font', 'image'].includes(request.destination)) return;",
    "  event.respondWith((async () => {",
    "    const cached = await caches.match(request);",
    "    if (cached) return cached;",
    "    const response = await fetch(request);",
    "    if (response.ok && response.type === 'basic' && !/no-store|private/i.test(response.headers.get('Cache-Control') || '')) {",
    "      const cache = await caches.open(ASSETS);",
    "      await cache.put(request, response.clone());",
    "      const keys = await cache.keys();",
    "      if (keys.length > 100) await Promise.all(keys.slice(0, keys.length - 100).map(key => cache.delete(key)));",
    "    }",
    "    return response;",
    "  })());",
    "});",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(distDir, "sw.js"), source);
  console.log("PWA service worker revision " + revision + " (" + precache.length + " precached assets)");
}
if (process.argv[2] === "icons") generateIcons();
else if (process.argv[2] === "finalize") finalize();
else throw new Error("Use 'icons' or 'finalize'");
