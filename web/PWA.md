# SnapBot PWA

This Vite frontend is installable on Chromium desktop/Android and iOS/iPadOS Safari. On modern macOS Safari, use **File → Add to Dock**. Browser install availability varies.

## Deployment

- Deploy this repository's `web` directory on Vercel with **npm run build** (including npm lifecycle scripts).
- The `prebuild` hook generates standard PNG icons, maskable icons and an Apple touch icon without external packages.
- The `postbuild` hook generates a revisioned `dist/sw.js` **after Vite emits hashed assets**, ensuring installed clients detect releases.
- `sw.js` must be served from the domain root with no-store/no-cache response headers. Keep HTTPS enabled (localhost is allowed for development, but the service worker is deliberately disabled during development).
- The manifest, icons and offline page are public static files.
- Clear old site service workers if changing domains or routing.

## Security and caching policy

- Only the offline fallback, manifest, app icons, Vite entry assets, and versioned static JS/CSS/font/image assets may enter the Cache Storage.
- Navigation always tries the network and falls back to a neutral offline page; it does not cache chat pages or authenticated HTML.
- No API, Socket.IO or /media routes, cross-origin requests, request bodies, headers bearing authorization, messages, cookies or credentials are cached by this service worker.
- Installing the app does **not** make live chat or sending work offline. Do not imply messages are archived for offline access.
- Updates appear as a prompt; clicking Update activates the waiting worker and reloads. Other tabs may still use their previous loaded code until reloaded.

## Validation

1. Run `npm ci && npm run build` from `web`.
2. Check that `dist/sw.js`, `dist/manifest.webmanifest`, `dist/apple-touch-icon.png`, `dist/offline.html` and `dist/icons/*.png` are present.
3. Verify the icons are valid PNGs, and the manifest icons load over HTTPS.
4. Chrome DevTools → Application → Manifest and Service Workers: confirm installable, scope /, and active worker. Inspect Cache Storage to ensure no API or chat responses are cached.
5. Reload offline: the offline page must appear. Reconnect, then publish a second build and confirm the Update prompt appears.
6. On iPhone/iPad, open Safari → Share → Add to Home Screen; launch installed app and verify safe-area appearance.
7. Verify Android's Add to Home Screen/Install and desktop Chrome/Edge installation.
