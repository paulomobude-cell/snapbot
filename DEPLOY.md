# Live dashboard: backend on Railway, frontend on Vercel

Like wppconnect-server: the backend keeps Snapchat Web sessions running in
headless Chrome (one per account) and exposes them over REST + WebSocket. The
frontend is a live chat dashboard for all your accounts.

**By default the dashboard is a live mirror.** It shows what Snapchat is
currently showing for each account, and when Snapchat removes a message the
dashboard drops it too. Nothing is archived, no media is downloaded.

**Preservation is opt-in per chat, and needs both sides to consent.** For a chat
you turn it on for (see below), messages are *kept* instead of lost:
- A message the other person **deletes** stays, struck through with a 🗑️ and a
  *Deleted* tag.
- A message Snapchat **clears** (after viewing, or its disappear timer) stays,
  marked *No longer on Snapchat*.
- **Photos, videos and tap-to-view snaps** are saved (to Cloudflare R2 or the
  data volume) and viewable in the dashboard without a time or view limit.
- Nothing expires on its own (`MESSAGE_TTL_HOURS=0`). Set it above 0 only if you
  *want* preserved messages pruned after N hours; deleted ones are always kept.

**Consent handshake.** Preservation only turns on for a chat once both ends opt
in, so you're never silently keeping someone else's disappearing messages:
- If the chat's peer is **another account you added here**, it links
  automatically — both ends are yours.
- Otherwise the dashboard shows a **code**; the other person types that code into
  the chat, and *their* reply is their consent. Until then the chat stays a live
  mirror. Turning preservation off erases what was kept for that chat.

The bot does **not** hide that you've read messages: opening a chat to mirror it
marks it read on Snapchat, exactly like opening the app yourself.

**Dashboard features:** multiple accounts with status dots and unread badges,
chat search (`Ctrl K` or `/`), All / Unread / With-messages filters, previews,
streaks, grouped messages, inline media with a lightbox, optimistic sending with
retry, jump-to-latest, an activity feed, desktop notifications, unread count in
the tab title, light/dark theme, and a phone layout.

## Accounts: dashboard login vs env

Add accounts from the dashboard (**+** in the left rail). Each account gets its
own Chrome profile under `/data/profiles/<id>`, and **that profile is what keeps
you logged in**, so the password isn't needed after the first login.

- **Username & password**: the backend types them into Snapchat for you. Tick
  *Remember password* to store it **encrypted (AES-256-GCM)** in SQLite, so the
  bot can log back in by itself if Snapchat ever drops the session. Leave it off
  and the password is used for that one login and never written to disk.
- **Log in on live screen**: you log in by clicking and typing on the remote
  browser. The password never goes through the dashboard's API.
- Captcha or 2FA: finish it on the live screen. Click the screen and type;
  keystrokes and paste go to Snapchat.
- `USER_NAME` / `USER_PASSWORD` env vars still work: on first boot they create
  an account and are never copied into the database.

Everything lives in `/data/snapbot.db` (SQLite: accounts, messages, media
records, consent pairs, activity) plus the Chrome profiles. Preserved media
files go to Cloudflare R2 if configured, otherwise under `/data/media`.

## Media storage: Cloudflare R2 (recommended) or the volume

Images and videos add up, so for preserved chats put them in **Cloudflare R2**:
create a bucket and an API token, then set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. The frontend only ever receives short-lived
**signed** URLs (`MEDIA_URL_TTL_SECONDS`), never public links. If you leave the
R2 vars unset, media is stored on the `/data` volume and served through the
backend with the same signed-URL scheme (`PUBLIC_URL`, auto-detected on Railway).

## 1. Backend → Railway

1. New Project → Deploy from GitHub repo → pick this repo (root directory `/`).
   Railway finds `Dockerfile` and `railway.json` on its own.
2. **Add a Volume** to the service, mount path `/data`. It holds the Chrome
   profile, so you stay logged in across deploys.
3. Variables:
   | Name | Value |
   |---|---|
   | `API_TOKEN` | long random string (required) |
   | `SECRET_KEY` | optional; encrypts remembered passwords (defaults to `API_TOKEN`) |
   | `MAX_ACCOUNTS` | `3` (each account is one Chrome, ~300-500 MB RAM) |
   | `CORS_ORIGIN` | your Vercel URL, e.g. `https://snapbot.vercel.app` |
   | `MESSAGE_TTL_HOURS` | `24` (optional) |
   | `USER_NAME` / `USER_PASSWORD` | optional; creates an account on first boot |
   | `WEBHOOK_URL` | optional, receives every event as a POST |
4. Settings → Networking → **Generate Domain**. Check `https://<domain>/health`.

## 2. Frontend → Vercel

1. Add New Project → this repo → set **Root Directory** to `web`
   (Vite gets detected).
2. Env var `VITE_API_URL` = your Railway URL (no trailing slash).
3. Deploy, open the site, and enter your `API_TOKEN`.

## 3. First login

Open the site and enter your `API_TOKEN`. On first run the *Add account* dialog
opens. Pick username & password or the live screen, and the account comes
online once Snapchat accepts the login. It stays logged in across redeploys
because the profile is on the `/data` volume.

Upgrading from the single-session version: an existing `/data/chrome-profile`
is adopted as your first account automatically.

## Run locally

```bash
npm install && npm run dev          # backend in MOCK mode on :3001 (token: dev)
cd web && npm install && npm run dev  # frontend on :5173
```
`MOCK=true` uses fake accounts (any password except `wrong` logs in) where one
friend's messages get deleted, so you can watch deletion and expiry work without
a Snapchat account. Without mock:
`API_TOKEN=... npm start` (set `HEADLESS=false` to see Chrome).

## API

All `/api/*` routes need `Authorization: Bearer <API_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | account statuses (no auth) |
| GET · POST | `/api/accounts` | list · create `{ label, username?, password?, remember? }` |
| PATCH · DELETE | `/api/accounts/:id` | update `{ label?, remember?, password? }` · remove (deletes its data) |
| POST | `/api/accounts/:id/start` · `/restart` · `/logout` | session lifecycle |
| POST | `/api/accounts/:id/login` | `{ username, password, remember? }` |
| GET | `/api/accounts/:id/chats` | chats with previews + `preservation` state |
| GET | `/api/accounts/:id/chats/:chatId/messages` | messages (with signed media URLs); `?before=<ord>` to page |
| POST | `/api/accounts/:id/chats/:chatId/messages` | `{ text }` send a chat |
| GET · POST · DELETE | `/api/accounts/:id/pairs` · `.../chats/:chatId/handshake` | list · request · revoke preservation |
| GET | `/api/accounts/:id/events` | activity feed |
| GET | `/api/accounts/:id/screen` | JPEG screenshot of the session |

Socket.IO (`auth: { token }`). Every payload carries `accountId`. The server
emits `accounts`, `status`, `chats`, `chat:snapshot`, `message:new`,
`message:updated` (archived, or media saved), `message:removed`, `pairs`,
`activity`, `activity:list` and `screen:frame`. The client emits
`account:open|create|update|remove|login|start|restart|logout`, `chat:select`,
`message:send`, `pair:request`, `pair:revoke` and
`screen:start|stop|click|type|key|scroll`. Webhook bodies are
`{ event, data, at }` with `data.accountId` set.

## Caveats
- Preservation needs the other side's consent (linked own-account, or the code).
  It can't technically *prove* the person understood; it records that they took
  the opt-in action. Use it honestly.
- The bot reads chats by opening them in Snapchat Web, so the other person sees
  them as opened, just like opening them yourself. Chats with no new activity are
  re-checked every `FULL_SYNC_INTERVAL_MS`.
- Opening a preserved tap-to-view snap marks it viewed on Snapchat (same as if
  you opened it). Snaps you *sent* are never auto-opened.
- It depends on Snapchat Web's CSS selectors (last tested on v13.38.0). If
  Snapchat changes its UI, the selectors in `snapbot.js` need updating; the
  deleted-notice and snap-tile text can be tuned with `DELETED_NOTICE_PATTERN`
  and `SNAP_TILE_PATTERN`.
