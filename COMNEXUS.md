# Comnexus account system for SnapBot

This release changes SnapBot from a single shared `API_TOKEN` dashboard to a multi-tenant Comnexus user account system. The existing Railway service, SQLite archive, Chrome profiles, and optional R2 storage remain intact.

## Authentication and ownership

- New users register with a phone number (7–15 digits including country code) and a password of at least 12 characters.
- The backend stores salted scrypt password hashes, one-time SHA-256 recovery-code hashes, and SHA-256 hashes of personal API keys.
- Each sign-in issues a separate personal key. Users can sign in on multiple devices; password recovery replaces the primary key, revokes all existing device credentials and provides a new one-time recovery code.
- The React frontend stores a **personal** key on that user's device, mirroring WPPConnect. It never receives the Railway service `API_TOKEN` or `SECRET_KEY`.
- REST requests and Socket.IO listeners/actions are authorized by the session's tenant. A user may not see or control accounts or message archives owned by other tenants.
- `API_TOKEN` stays configured on Railway for service identity and backward-compatible secret fallback, but it **no longer authenticates a browser**.
- `ADMIN_API_TOKEN` is an entirely separate 32+ character secret. It belongs **only on Railway**. Admin Core asks for it when opened; the frontend does not bundle or persist it.
- Login/signup/recovery/admin requests are rate-limited. Browser sockets associated with revoked credentials are disconnected.

## Upgrading an existing installation without data loss

1. **Back up the SnapBot /data volume first**, including `snapbot.db`, `snapbot.db-wal`, `snapbot.db-shm`, `profiles/` and `media/`. Do not change the existing `SECRET_KEY` or `API_TOKEN` values; the former decrypts stored Snapchat passwords and signs legacy local media URLs.
2. Add a strong, unique `ADMIN_API_TOKEN` variable to the **SnapBot** Railway service.
3. Deploy the merge to `main` and allow both Railway and Vercel to finish. Vercel still only needs `VITE_API_URL=https://<snapbot-railway-origin>`. Do NOT add `VITE_API_TOKEN`; `API_TOKEN` set on Vercel isn't used as a user credential.
4. Refresh the frontend. The old backend-Connect screen is replaced with Comnexus **Sign up / Log in / Personal API key** forms. The legacy shared token stored by older frontends in localStorage is removed.
5. Create your Comnexus user account and **save your one-time recovery code**.
6. Open **Admin Core** (shield icon in the Snapchat chat toolbar). Enter your `ADMIN_API_TOKEN`. Under *Unassigned legacy Snapchat accounts*, select your new Comnexus user and click **Assign**. This preserves the original account ID, browser profile, messages, and media.
7. Check that your account and chats appear after the claim, and verify that a newly registered test user does **not** see them.
8. Configure R2 credentials when ready. New media then uploads to R2, but existing local media remains accessible through signed Railway URLs until you separately migrate those objects.

Do **not** assign a saved Snapchat account to an untrusted user. Claiming immediately grants its owner access to the archived messages, stored media, and remote login profile.

## Railway environment

Required existing variables: `API_TOKEN`, `SECRET_KEY`, `DATA_DIR=/data`, `CORS_ORIGIN=https://snapbot.comnexus.xyz`.

New required variable for Admin Core: `ADMIN_API_TOKEN=<unique 32+ character random secret>`. Generate one with `openssl rand -hex 32`. Keep it different from the service `API_TOKEN`.

Optional R2 variables for private media storage: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

Keep one Railway replica due to the SQLite database and persistent Chromium profile architecture. Note `MAX_ACCOUNTS` remains a **global** limit for the service, not a per-user quota; use measured RAM to increase it deliberately when onboarding additional tenants.

## Admin Core

Uses endpoints requiring a valid `x-admin-key` header; other credentials cannot access them:

- `GET /api/admin/overview`: counts for users, accounts, active sessions, archived messages, and recorded media bytes.
- `GET /api/admin/users`: users, owned sessions, and unassigned legacy accounts (no passwords/keys).
- `POST /api/admin/claim`: assign an unowned historical Snapchat account once.
- `DELETE /api/admin/users/:id`: delete the Comnexus user and their Snapchat accounts, with full phone-number confirmation.

Deletion stops Chromium, attempts remote media deletion, clears local archive data, and removes profile directories. Failed media deletion is surfaced, leaving database records for a retry; do not claim deletion succeeded if the backend reports an error.

## Security limitations and operational follow-ups

- This follows WPPConnect's bearer-key model: personal user keys are present on their own browser and are stored in localStorage. **Only the master service and admin tokens are kept off the bundled frontend.** Use HTTPS and audit XSS risks.
- R2 signed media links are bearer URLs valid for `MEDIA_URL_TTL_SECONDS`. Someone who already possesses a valid signed URL can access that object until expiry; do not forward the links.
- Admin authorization is shared-secret based (like WPPConnect). For broader public SaaS launch, add MFA, admin identities/roles, more detailed auditing and backup verification.
- Admin overview displays **recorded** media bytes from SQLite, not a live Cloudflare R2 billing calculation.
- Snapchat's login/browser automation may trigger view receipts and may break after Snapchat changes its page.
- Before a high-traffic SaaS rollout, isolate tenants at the worker/resource layer and plan migration away from a single Railway instance/SQLite database.

## Validation

GitHub CI in `.github/workflows/comnexus-tenants.yml` runs:

```bash
npm ci
node test/tenant-auth.mjs
npm test
node test/login.mjs
node test/live-screen.mjs
cd web
npm ci
npm run build
node scripts/pwa-smoke.mjs
node scripts/tenant-e2e.mjs
```

The e2e test launches a mock SnapBot service and exercises signup/login, socket isolation, REST authorization, admin claim and deletion, legacy archive preservation and recovery.
