# Deployment Platform Lifecycle: Dual-Track, Reversal & Cleanup

> **Status:** Active Dual-Track (Netlify Primary, Vercel Rollback Retained)  
> **Last Updated:** 2026-10-04  
> **Owner:** Twistloom Backend  

---

## 1. Overview & Architectural Philosophy

Twistloom Backend maintains a **dual-track deployment architecture**:
1. **Primary Platform (Production):** **Netlify Serverless Functions** (Node.js 24 runtime, pure Web `Request`/`Response` API).
2. **Rollback Platform (Standby):** **Vercel Serverless** (Node.js runtime, `vercelHandler` adapter).
3. **Local Development:** **Bun** (`src/server.bun.ts` executing `Bun.serve`).

### Why Dual-Track?
Instead of immediately deleting all Vercel deployment configuration, the codebase is architected to keep both platforms operational side-by-side. If Netlify experiences unexpected quota exhaustion, cross-region database latency spikes, or provider-specific outages, traffic can be redirected back to Vercel within minutes simply by switching DNS / external URLs, with zero emergency code rollbacks required.

---

## 2. Platform Environment Variables Matrix

**How to read this table.** `🟢 AUTO` = injected by the platform, never copy it
in. `🔴 MANUAL` = you must declare it yourself. Every value below is documented
in one place in the repository — **`.env.example` → section 11
"DEPLOYMENT PLATFORM"** — so platform keys are never scattered across the file.

> **Netlify gotcha:** variables declared in `netlify.toml` are **build-only** and
> are **not** visible to functions. Anything read at runtime (including
> `NODE_ENV`) must be set in *Netlify UI → Site configuration → Environment
> variables*. On the Free plan scopes are not configurable, so one variable
> serves both Builds and Functions.

### 2.1 Complete Variable Comparison

| Environment Variable | Where Configured | Netlify Behavior | Vercel Behavior | Local Dev (`.env.local`) | CI (GitHub Actions) | Purpose & Acquisition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`NODE_ENV`** | Dashboard | 🔴 **MANUAL** (Must set `production`) | 🟢 **AUTO** (`production`) | `development` / `test` | `test` / `production` | **Critical:** Netlify docs state "by default, Netlify's build system does not set any value for `NODE_ENV`". If omitted, `IS_PRODUCTION` (`src/config/env.ts:4`) is `false` in production, loosening error messages, disabling secure-cookie flags and payment gating. Do **not** move this into `[build.environment]` — build vars never reach functions, and `NODE_ENV=production` would stop devDependencies (typescript, eslint) installing for `bun run typecheck`. |
| **`BACKEND_URL`** | Dashboard / `.env.production` | 🔴 **MANUAL** (`https://twistloom-backend.netlify.app`) | 🔴 **MANUAL** (`https://twistloom-backend.vercel.app`) | `http://localhost:3000` | Secrets (`secrets.BACKEND_URL`) | Base public URL of backend. Target destination for QStash schedules, webhooks, and self-callbacks. Re-run `bun qstash:setup:prod` after every change. |
| **`NETLIFY`** | Injected by platform | 🟢 **AUTO** (`true`) | ⚪ *Absent* | ⚪ *Absent* | ⚪ *Absent* | Platform detection flag. Gates `IS_SERVERLESS` (`src/config/env.ts:18`) and the cache-tag purge guard. |
| **`SITE_ID`** | Injected by platform | 🟢 **AUTO** (Site UUID) | ⚪ *Absent* | ⚪ *Absent* | ⚪ *Absent* | Read-only, available to functions at runtime. Fallback site id for `purgeCache()`. |
| **`NETLIFY_PURGE_API_TOKEN`** | Injected by platform | 🟢 **AUTO** (ambient token) | ⚪ *Absent* | ⚪ *Absent* | ⚪ *Absent* | Ambient CDN purge credential. `@netlify/functions` reads it first, so deployed functions need **zero** purge configuration. |
| **`NETLIFY_SITE_ID`** | External override | ⚪ *Not needed at runtime* | ⚪ *Absent* | Optional (CI purge) | Optional (GitHub secret) | Explicit site id for purging **from outside** a deployed function. Value = *Netlify UI → Project configuration → General → Project details → Project ID*. |
| **`NETLIFY_AUTH_TOKEN`** | External override | ⚪ *Not needed at runtime* | ⚪ *Absent* | Optional (Netlify CLI) | Optional (GitHub secret) | Personal Access Token for the Netlify CLI and external API calls. *Netlify → User settings → Applications → New access token.* |
| **`AWS_LAMBDA_JS_RUNTIME`** | Dashboard | 🟡 **OPTIONAL** (`nodejs24.x`) | ⚪ *Absent* | ⚪ *Absent* | ⚪ *Absent* | Pins the functions runtime independently of the build Node version. UI/CLI only — `netlify.toml` is ignored for this key. |
| **`NETLIFY_LOCAL`** | Injected by platform | 🟢 **AUTO** (under `netlify dev`) | ⚪ *Absent* | ⚪ *Absent* | ⚪ *Absent* | Makes `purgeCache()` a no-op locally instead of hitting production. |
| **`VERCEL` / `VERCEL_ENV`** | Injected by platform | ⚪ *Absent* (**Do not set!**) | 🟢 **AUTO** (`1` / `production`) | ⚪ *Absent* | ⚪ *Absent* | Vercel detection flags. Gates `IS_SERVERLESS` when on Vercel. Setting them on Netlify makes the runtime flag lie. |
| **`VERCEL_URL`** | Injected by platform | ⚪ *Absent* | 🟢 **AUTO** (host) | ⚪ *Absent* | ⚪ *Absent* | Legacy fallback for QStash URL resolution only (`src/cron/ensure-qstash-schedules.ts:107`). `BACKEND_URL` always wins. |
| **`DATABASE_URL`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Neon Postgres pooled connection string. |
| **`DATABASE_READ_URL`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Neon Postgres read connection string. |
| **`AUTH_SECRET`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Session/JWE encryption secret (`openssl rand -base64 32`). |
| **`MOBILE_ACCESS_SECRET`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Secret for signing mobile JWT bearer tokens. |
| **`FRONTEND_URL`** | Dashboard | 🔴 **MANUAL** (`https://twistloom-web.vercel.app`) | 🔴 **MANUAL** (`https://twistloom-web.vercel.app`) | `http://localhost:3001` | ⚪ *Absent* | Origin of the frontend application (CORS allow-list + CSRF origin check). **Unchanged by this migration** — the frontend stays on Vercel. |
| **`AUTH_URL`** / **`AUTH_TRUST_HOST`** | Frontend dashboard | ⚪ *Not read by this backend* | ⚪ *Not read by this backend* | `http://localhost:3001` | ⚪ *Absent* | Auth.js (NextAuth v5) runs in `twistloom-web`; a repo-wide grep shows this backend never reads either key. Listed here only because they appear in `.env.example`. |
| **`CRON_SECRET`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Bearer secret protecting `/api/cron/*` endpoints from unauthorized requests. |
| **`INTERNAL_SECRET`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Secret protecting internal service-to-service fire-and-forget invocations. |
| **`UPSTASH_REDIS_*`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Redis REST URL and token for caching and rate limiting. |
| **`QSTASH_*`** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | `QSTASH_TOKEN` + `CRON_SECRET` for scheduled dispatch. |
| **AI Provider Keys** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | Gemini, Mistral, Cohere, Cerebras, Groq, NVIDIA, OpenRouter, Jina, … (full list in `.env.example`). |
| **Payment Secrets** | Dashboard / Secrets | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | 🔴 **MANUAL** | `STRIPE_*`, `XENDIT_*` — note the webhook signing secrets are **per endpoint**, see §3.3. |

---

## 3. External Services Repointing & Migration Checklist

When switching active deployment from Vercel (`https://twistloom-backend.vercel.app`) to Netlify (`https://twistloom-backend.netlify.app`), the following external systems must be repointed:

### 3.1 Backend & Infrastructure
- [ ] **Netlify Environment Variables:** Set `NODE_ENV=production`, `BACKEND_URL=https://twistloom-backend.netlify.app`, and all application secrets in *Netlify UI → Site configuration → Environment variables*.
- [ ] **`.env.production`:** Ensure `BACKEND_URL=https://twistloom-backend.netlify.app`.
- [ ] **Upstash QStash Schedules:** Run `bun qstash:setup:prod`. This upserts the **2** registered schedules (`/api/cron/sweep-credit-reservations` every 10 min, `/api/cron/sweep-custom-actions` every 5 min — see `QSTASH_SCHEDULES` in `src/cron/ensure-qstash-schedules.ts`) so their destination becomes `https://twistloom-backend.netlify.app`. The `Upstash-Schedule-Id` header makes re-runs idempotent — no duplicates.
- [ ] **GitHub Actions Secret:** Update `BACKEND_URL` in *GitHub Repo → Settings → Secrets and variables → Actions* so asynchronous book generation workflows (`on-demand-book-creation.yml:89`) post callbacks to Netlify.
- [ ] **GitHub Actions secret hygiene:** ensure `VERCEL_URL` is **not** set there — `BACKEND_URL` must be the sole destination source.

### 3.2 Frontend & Mobile Applications
- [ ] **Frontend Web App (`twistloom-web`, stays on Vercel):**
  - Update `NEXT_PUBLIC_API_URL` (or the rewrite-proxy `BACKEND_URL`) in the frontend's Vercel project settings to `https://twistloom-backend.netlify.app`.
  - If a Next.js rewrite proxy is used (`/api/backend/:path*` → backend), redeploy the frontend after the change.
  - **No domain change:** `https://twistloom-web.vercel.app` is unchanged everywhere it is referenced in this repo (`src/app.ts` CORS/CSRF allow-list, `src/config/emails/base-layout.ts`, `src/services/social/extract-twistloom-link.ts`).
- [ ] **Mobile App (`twistloom-mobile` / Expo):**
  - Update `EXPO_PUBLIC_API_URL` (or the equivalent API base URL) to `https://twistloom-backend.netlify.app`.
  - Ship an OTA update or a new store build.

### 3.3 Payment Gateways & Webhooks
- [ ] **Stripe Dashboard:**
  - Navigate to *Developers → Webhooks*. Stripe **does not let you edit an existing endpoint's URL** — create a **new** endpoint:
    `https://twistloom-backend.netlify.app/api/payments/stripe/webhook`
    (the canonical path — `src/routes/payments.ts:564` `POST /api/payments/stripe/webhook`).
  - Copy that new endpoint's signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` — **signing secrets are per endpoint**, reusing the old one makes signature verification fail with 400.
  - Delete the old `twistloom-backend.vercel.app` endpoint only after a live event succeeds.
- [ ] **Xendit Dashboard** (*Settings → Developers → Callbacks*) — **two** callbacks to update, both verified by `x-callback-token`:
  - Invoices & Tips: `https://twistloom-backend.netlify.app/api/payments/xendit/webhook`
  - Creator disbursements: `https://twistloom-backend.netlify.app/api/payments/xendit/disbursement-webhook`
  - Confirm the callback verification token matches `XENDIT_WEBHOOK_TOKEN`.

### 3.4 Identity Providers & OAuth
- [ ] **Google Cloud Console — expected: no change, verify anyway.**
  This backend never hosts an OAuth redirect; `src/routes/auth.ts` only calls
  `googleClient.verifyIdToken({ audience: GOOGLE_CLIENT_ID })` for
  `POST /api/auth/google-oauth`, `/google-one-tap` and `/mobile/google`. The
  authorization code flow runs entirely inside `twistloom-web`.
  - *APIs & Services → Credentials → OAuth 2.0 Client IDs* → **Authorized
    JavaScript origins**: should list only frontend origins
    (`https://twistloom-web.vercel.app`, `http://localhost:3001`). Do **not**
    add the backend host — nothing on it ever executes Google JS.
  - **Authorized redirect URIs**: should list only
    `…/api/auth/callback/google` on the **frontend**. There is no
    `/api/auth/callback/google` route in this backend.
  - *OAuth consent screen → Authorized domains*: must be a domain **you have
    verified** (e.g. `twistloom.com`). Google rejects public platform suffixes
    such as `vercel.app` and `netlify.app`, so `netlify.app` cannot be added.
- [ ] **Apple Sign in with Apple — expected: no change.**
  The backend only verifies identity tokens (`POST /api/auth/mobile/apple`,
  audience `APPLE_CLIENT_ID`); it exposes no browser callback. If the web
  Sign-in-with-Apple flow is used, its Return URL lives on the **frontend**
  Services ID and is unaffected by the backend host change.
- [ ] **Mobile deep-link / universal links:** unchanged — they point at the
  app, not the backend.

### 3.5 App Stores Compliance & Legal URLs
- [ ] **Hosting check (applies to both stores):** this backend has **no**
  `/privacy` or `/terms` route. Privacy Policy, Terms of Service, Support and
  Account-Deletion pages are served by `https://twistloom-web.vercel.app`, which
  did not move — so these URLs should require **no** edit. Audit each field
  only to confirm nothing hard-codes `twistloom-backend.vercel.app`.
- [ ] **Google Play Console:**
  - *App content → Privacy policy* and *Terms of service*: confirm the URL is the frontend policy page.
  - *App content → Data safety* and *Account deletion*: confirm the deletion entry point (web URL or in-app flow) still resolves.
- [ ] **Apple App Store Connect:**
  - *App Information → Privacy Policy URL* and *User Support URL*: confirm they point at the frontend.
  - *App Store Server Notifications (v2)*: **N/A today** — this backend exposes no Apple notification endpoint. If one is added later, it must be registered against the then-active backend host.
- [ ] **Do not** repoint any of the above to `…netlify.app`; the API host is not a legal/compliance surface.

---

## 4. Lifecycle Management Tool: `scripts/platform-cleanup.ts`

The repository includes a dedicated lifecycle CLI script: `scripts/platform-cleanup.ts`,
exposed as package scripts (`platform:status`, `platform:cleanup:vercel`,
`platform:cleanup:netlify`, `platform:restore`).

**Safety properties**
- Dry-run is the default — nothing is written without `--apply`.
- Every run is idempotent; already-cleaned files report `already clean`.
- All edits are line-based, so CRLF and LF checkouts behave identically.
- An edit **aborts the run** if its anchor/marker is missing, rather than
  writing a half-migrated file.
- `--apply` first snapshots every path it will touch into
  `.platform-cleanup-backup/<timestamp>/` (gitignored) and prints the location;
  `bun platform:restore` replays it. Git remains the second safety net.

### 4.1 Checking Artifact Status
Run at any time to inspect which platform artifacts are present:
```bash
bun run platform:status
# or
bun scripts/platform-cleanup.ts status
```

Output:
```text
Deployment platform artifacts

  vercel
    [present] vercel.json
    [present] api/index.ts
    [present] src/app.ts (adapter markers)
  netlify
    [present] netlify.toml
    [present] netlify/functions/api.mts
    [present] bun.lockb
    [present] public/robots.txt
    [present] src/utils/netlify-cache.ts

  Mode: DUAL-TRACK (both adapters live)
```

---

## 5. Operator Runbooks

### Runbook A: Retiring Vercel Permanently
Execute this runbook only after Netlify has served production traffic successfully, all Step 7 checks from `NETLIFY_MIGRATION_ROADMAP.md` have passed, and you have decided to permanently retire the Vercel backend deployment.

> **Prerequisite:** every box in §3 must already be checked. The repo cleanup
> is the *last* step, not the first — deleting the adapter while Stripe,
> Xendit or QStash still point at `twistloom-backend.vercel.app` silently drops
> payments and cron traffic.

1. **Confirm Netlify is healthy:**
   ```bash
   bun scripts/verify-deployment.ts https://twistloom-backend.netlify.app
   bun run check && bun test
   ```

2. **Simulate Vercel Cleanup (Dry-Run):**
   ```bash
   bun run platform:cleanup:vercel
   ```
   Verify the planned deletions (`vercel.json`, `api/`, adapter markers in `src/app.ts`, dead `APP_WEB_URL`).

3. **Apply Vercel Cleanup:**
   ```bash
   bun scripts/platform-cleanup.ts vercel --apply
   ```
   A backup snapshot is written to `.platform-cleanup-backup/<timestamp>/` and printed; undo with `bun platform:restore`.

4. **Verify Integrity:**
   ```bash
   bun run check
   bun test
   ```

5. **Decommission on Vercel Dashboard:**
   - Vercel Dashboard → `twistloom-backend` project → Settings → General → Delete Project (or at minimum disable auto-deploy and delete the project's environment variables).
   - Optionally delete the now-unused `twistloom-backend.vercel.app` domain once nothing references it.

---

### Runbook B: Rolling Back from Netlify to Vercel
If Netlify must be abandoned in favor of returning to Vercel:

> **Soft vs hard revert.** While the repository is in `DUAL-TRACK` mode
> (`bun platform:status`) **no code changes are required at all** — the Vercel
> adapter, `vercel.json` and `api/index.ts` are still present and deployable.
> Step 1 below is sufficient. Only run step 2 if you previously executed
> `platform:cleanup:vercel --apply` (which strips the adapter) *and* you
> actually want to drop the Netlify files.

1. **Repoint External Systems Back to Vercel:**
   - Update `BACKEND_URL=https://twistloom-backend.vercel.app` in `.env.production`.
   - Run `bun qstash:setup:prod` to redirect QStash schedules back to Vercel.
   - Update GitHub Actions secret `BACKEND_URL` to `https://twistloom-backend.vercel.app`.
   - Create a new Stripe webhook endpoint for the Vercel host and copy its fresh `whsec_…` into `STRIPE_WEBHOOK_SECRET` (signing secrets are per endpoint).
   - Update both Xendit callbacks (invoices + disbursement) back to the Vercel host.
   - Update the frontend `NEXT_PUBLIC_API_URL` / rewrite-proxy `BACKEND_URL`.
   - Google OAuth, Apple, and the legal/privacy URLs need **no** change — see §3.4 and §3.5.
   - **Vercel env vars:** confirm `NODE_ENV=production` (Vercel sets it itself) and that every secret from `.env.example` is still present in the project. Do **not** set `NETLIFY*` keys.

2. **Restore the Vercel adapter if it was removed (hard cleanup only):**
   ```bash
   bun platform:status   # "src/app.ts (adapter markers)" must read [present]
   ```
   If it reads `[absent]`, bring it back before deploying:
   ```bash
   bun run platform:restore   # replays the snapshot taken by the --apply
   # or, if you committed the dual-track state:
   git checkout -- src/app.ts vercel.json api/
   ```
   Without this, Vercel has no handler and every path returns a platform 404.

3. **Verify Vercel Deployment:**
   - Trigger a deployment on Vercel (or push to main).
   - `bun scripts/verify-deployment.ts https://twistloom-backend.vercel.app`
   - `bun run check && bun test`

4. **(Optional) Clean up Netlify Artifacts:**
   If you wish to remove Netlify-specific files and return to a pure Vercel setup:
   ```bash
   bun run platform:cleanup:netlify          # dry-run first
   bun scripts/platform-cleanup.ts netlify --apply
   bun remove @netlify/functions
   bun run check
   ```
   External half: remove `NODE_ENV`/`NETLIFY_*` from the Netlify UI (or delete
   the site), and point Stripe/Xendit/QStash/GitHub/frontend back to Vercel
   as in step 1.

---

### Runbook C: Undoing Cleanup / Emergency Restore
If `platform-cleanup.ts` was run with `--apply` and you want to restore the repository to its prior state without using Git:
```bash
bun run platform:restore
# or specify timestamp:
bun scripts/platform-cleanup.ts restore 2026-10-04T12-00-00-000Z
```
This replays the files stored in `.platform-cleanup-backup/<timestamp>/`,
including re-creating anything the cleanup deleted. Afterwards run
`bun run check` to verify. Available snapshots are the directories under
`.platform-cleanup-backup/`.
