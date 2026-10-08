# Live dashboard: backend on Railway, frontend on Vercel

Like wppconnect-server: the backend keeps one Snapchat Web session running in
headless Chrome and exposes it over REST + WebSocket. The frontend is a live chat
dashboard.

**What the dashboard shows**
- Only messages that are **still on Snapchat**. If a message is deleted on
  Snapchat (or Snapchat clears it after it's viewed), it's removed from the
  backend and the chat box on the next sync, normally within a few seconds.
- Messages also **expire after 24h** (`MESSAGE_TTL_HOURS`), counted from when the
  bot first saw them. Each bubble shows a countdown. The browser removes them on
  time even when the connection is down.
- On every reconnect the browser discards its cache and loads fresh state, so
  stale messages never come back.

## 1. Backend → Railway

1. New Project → Deploy from GitHub repo → pick this repo (root directory `/`).
   Railway finds `Dockerfile` and `railway.json` on its own.
2. **Add a Volume** to the service, mount path `/data`. It holds the Chrome
   profile, so you stay logged in across deploys.
3. Variables:
   | Name | Value |
   |---|---|
   | `API_TOKEN` | long random string (required) |
   | `CORS_ORIGIN` | your Vercel URL, e.g. `https://snapbot.vercel.app` |
   | `MESSAGE_TTL_HOURS` | `24` (optional) |
   | `USER_NAME` / `USER_PASSWORD` | optional auto-login |
   | `WEBHOOK_URL` | optional, receives every event as a POST |
4. Settings → Networking → **Generate Domain**. Check `https://<domain>/health`.

## 2. Frontend → Vercel

1. Add New Project → this repo → set **Root Directory** to `web`
   (Vite gets detected).
2. Env var `VITE_API_URL` = your Railway URL (no trailing slash).
3. Deploy, open the site, and enter your `API_TOKEN`.

## 3. First login

Open the site. If the session isn't logged in, the **Live screen** opens with a
view of the backend's Chrome. Log in with the form, or click and type on the
screen to get through captcha/2FA. After that, the session stays in the `/data`
volume.

## Run locally

```bash
npm install && npm run dev          # backend in MOCK mode on :3001 (token: dev)
cd web && npm install && npm run dev  # frontend on :5173
```
`MOCK=true` uses fake chats where one friend's messages get deleted, so you can
watch deletion and expiry work without a Snapchat account. Without mock:
`API_TOKEN=... npm start` (set `HEADLESS=false` to see Chrome).

## API

All `/api/*` routes need `Authorization: Bearer <API_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/health` | session status (no auth) |
| GET | `/api/status` | session status |
| POST | `/api/session/start` · `/restart` · `/logout` | lifecycle |
| POST | `/api/session/login` | `{ username, password }` |
| GET | `/api/chats` | chat list with status |
| GET | `/api/chats/:id/messages` | live messages (deleted/expired excluded) |
| POST | `/api/chats/:id/messages` | `{ text }` send a chat |
| GET | `/api/screen` | JPEG screenshot of the session |

Socket.IO (`auth: { token }`): server emits `status`, `chats`, `chat:snapshot`,
`message:new`, `message:deleted`, `message:expired`, `screen:frame`. Client
emits `chat:select`, `message:send`, `session:*`, `screen:start|stop|click|type|key|scroll`.

## Caveats
- The bot reads chats by opening them in Snapchat Web, so the other person sees
  them as opened, just like opening them yourself. Chats that have no new
  activity are only re-checked for deletions every `FULL_SYNC_INTERVAL_MS`.
- It depends on Snapchat Web's CSS selectors (last tested on v13.38.0). If
  Snapchat changes its UI, the selectors in `snapbot.js` need updating.
