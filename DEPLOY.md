# Live dashboard: backend on Railway, frontend on Vercel

Like wppconnect-server: the backend keeps Snapchat Web sessions running in
headless Chrome (one per account) and exposes them over REST + WebSocket. The
frontend is a live chat dashboard for all your accounts.

**What the dashboard shows**
- Only messages that are **still on Snapchat**. If a message is deleted on
  Snapchat (or Snapchat clears it after it's viewed), it's struck through, marked
  *Deleted*, and fades out, normally within a few seconds.
- Messages also **expire after 24h** (`MESSAGE_TTL_HOURS`), counted from when the
  bot first saw them. Each bubble has a countdown ring. The browser removes them on
  time even when the connection is down.
- On every reconnect the browser discards its cache and loads fresh state, so
  stale messages never come back.

**Dashboard features:** multiple accounts with status dots and unread badges,
chat search (`Ctrl K` or `/`), All / Unread / With-messages filters, previews,
streaks, grouped messages, optimistic sending with retry, jump-to-latest, an
activity feed (new / deleted / session events), desktop notifications, unread
count in the tab title, light/dark theme, and a phone layout.

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

Everything lives in `/data/snapbot.db` (SQLite: accounts, messages, expiry
records, activity) plus the Chrome profiles. The activity feed never stores
message text, so deleted messages don't linger there either.

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
| GET | `/api/accounts/:id/chats` | chats with last-message previews |
| GET | `/api/accounts/:id/chats/:chatId/messages` | live messages (deleted/expired excluded) |
| POST | `/api/accounts/:id/chats/:chatId/messages` | `{ text }` send a chat |
| GET | `/api/accounts/:id/events` | activity feed |
| GET | `/api/accounts/:id/screen` | JPEG screenshot of the session |

Socket.IO (`auth: { token }`). Every payload carries `accountId`. The server emits
`accounts`, `status`, `chats`, `chat:snapshot`, `message:new`, `message:deleted`,
`message:expired`, `activity`, `activity:list` and `screen:frame`. The client
emits `account:open|create|update|remove|login|start|restart|logout`,
`chat:select`, `message:send` and `screen:start|stop|click|type|key|scroll`.
Webhook bodies are `{ event, data, at }` with `data.accountId` set.

## Caveats
- The bot reads chats by opening them in Snapchat Web, so the other person sees
  them as opened, just like opening them yourself. Chats that have no new
  activity are only re-checked for deletions every `FULL_SYNC_INTERVAL_MS`.
- It depends on Snapchat Web's CSS selectors (last tested on v13.38.0). If
  Snapchat changes its UI, the selectors in `snapbot.js` need updating.
