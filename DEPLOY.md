# Live dashboard: backend on Railway, frontend on Vercel

Deploy SnapBot as a **separate Railway service** inside the existing `celebrated-gratitude` project. Keep the existing `COMMNEXUS` (WPPConnect) service and its mounted volume untouched. Use a dedicated `/data` volume for SnapBot's SQLite archive and Chromium profiles.

Messages visible to the connected Snapchat account are archived automatically; no preservation code or peer handshake is required. When Snapchat removes content, previously captured messages stay in the private archive with a Deleted or No longer on Snapchat label (without strikethrough). Content not captured while available cannot be recovered. Keeping other people's messages may carry privacy and legal obligations.

The bot does **not** hide that you've read messages:
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

1. Open the **existing `celebrated-gratitude` project** and add a **new service** from `paulomobude-cell/snapbot` (root directory `/`). Deploy the tested feature branch or merge its PR before selecting `main`.
   Railway finds `Dockerfile` and `railway.json` on its own.
2. **Add a new SnapBot-only Volume** to the service, mount path `/data`. Never reuse WPPConnect's existing volume. It holds the Chrome
   profile, so you stay logged in across deploys.
3. Variables:
   | Name | Value |
   |---|---|
   | `API_TOKEN` | long random string (required) |
   | `SECRET_KEY` | optional; encrypts remembered passwords (defaults to `API_TOKEN`) |
   | `MAX_ACCOUNTS` | `3` (each account is one Chrome, ~300-500 MB RAM) |
   | `CORS_ORIGIN` | `https://snapbots.comnexus.xyz` |
   | `MESSAGE_TTL_HOURS` | `24` (optional) |
   | `USER_NAME` / `USER_PASSWORD` | optional; creates an account on first boot |
   | `WEBHOOK_URL` | optional, receives every event as a POST |
4. Settings → Networking → **Generate Domain** for the backend, then configure the frontend's custom domain `snapbots.comnexus.xyz` separately. Check `https://<domain>/health`.

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
- Archiving is automatic for messages the logged-in account can access, not a guarantee of recovering expired messages or unopened view-once media.
- This implementation opens chats in Snapchat Web and can trigger read receipts. Do not advertise it as unread/stealth mode.
- Each account runs a separate Chromium profile. Sharing tabs across accounts is deferred until profile isolation and resource usage are validated.
- Keep the API token private, restrict `CORS_ORIGIN`, and take backups of the SnapBot-only `/data` volume.
- The service depends on Snapchat Web's DOM selectors, which may change.
