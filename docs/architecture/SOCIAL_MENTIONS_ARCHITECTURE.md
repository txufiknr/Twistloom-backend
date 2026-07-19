# Social Mentions Ingestion & Curation Architecture

## Overview

Twistloom collects community discussion about the product from open internet
sources and surfaces the best posts on the public homepage as social proof. The
system follows the "ingest automatically → curate manually → publish" pattern
described in [`docs/roadmap/SOCIAL_TESTIMONY_INGESTION_CHATGPT.md`](../../docs/roadmap/SOCIAL_TESTIMONY_INGESTION_CHATGPT.md).

The design intentionally keeps the **public-facing social proof curated**:
raw search results land in the database as `pending` and only become visible
after an admin approves *and* features them. This avoids accidentally publishing
negative reviews, spam, or "anyone heard of Twistloom?" posts.

## Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `social_mentions` table | `src/db/schema.ts` | Persistent store of all discovered/created mentions |
| `social-mentions.ts` cron | `src/cron/social-mentions.ts` | Periodic multi-source ingestion pipeline |
| Admin CRUD routes | `src/routes/admin.ts` | Curation queue: list, approve, reject, feature, create, delete |
| GitHub Actions workflow | `.github/workflows/social-mention-ingestion.yml` | Weekly scheduler that runs the cron on production |

## Data Model

Defined in `src/db/schema.ts` as the `socialMentions` (table `social_mentions`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid (pk) | `uuidv7()` |
| `platform` | text | `reddit`, `hackernews`, `github`, `bluesky`, or a hostname for Brave web results |
| `author` | text | Author handle, e.g. `u/foo`, `@foo`, or `foo` |
| `authorAvatar` | text \| null | Avatar URL when available (GitHub/Bluesky/Brave web) |
| `title` | text \| null | Post title or synthesized label |
| `content` | text | Normalized post body (HTML stripped) |
| `url` | text (unique) | Canonical source URL; used for dedup |
| `score` | integer | Platform engagement (upvotes/likes/reactions) |
| `sentimentScore` | real | Local heuristic, `-1.0`..`1.0` |
| `relevanceScore` | real | Local heuristic priority score; drives queue ordering |
| `status` | enum | `pending` \| `approved` \| `rejected` (default `pending`) |
| `featured` | boolean | Elevated to the public homepage wall by an admin (default `false`) |
| `publishedAt` | timestamptz \| null | Original post time |
| `createdAt` / `updatedAt` | timestamptz | Bookkeeping |

Indexes:

- `social_mentions_url_unique` — dedup guarantee at the DB level
- `social_mentions_status_idx` — filter by curation status
- `social_mentions_platform_idx` — filter by source
- `social_mentions_filtering_idx` — `(status, relevanceScore DESC)` for the admin queue
- `social_mentions_featured_idx` — `(featured, relevanceScore DESC)` for the homepage wall

### Status vs. Featured

The two flags are intentionally separate:

```
pending   → discovered, not yet reviewed
approved  → passed moderation, eligible to be featured later
rejected  → spam / off-topic / negative; never shown
featured  → admin explicitly elevated to the homepage wall
```

A mention should only appear on the public homepage when
`status = 'approved' AND featured = true`. The homepage query is therefore:

```sql
SELECT *
FROM social_mentions
WHERE status = 'approved' AND featured = true
ORDER BY relevance_score DESC, published_at DESC
LIMIT 20;
```

## Ingestion Pipeline

`runSocialMentionCollection()` in `src/cron/social-mentions.ts`:

1. Fan out to all sources **in parallel** via `Promise.all`. Each fetcher is
   self-contained and fault-tolerant — a network/parse failure returns `[]`
   rather than throwing, so one broken source never kills the run.
2. For each collected mention:
   - Strip HTML entities/markup from the body.
   - Compute local relevance + sentiment heuristics.
   - `INSERT ... ON CONFLICT DO NOTHING (url)` — idempotent across runs.
3. Log a summary (discovered vs. successfully persisted counts) and duration.

### Sources

All sources are **keyless** except Brave Search.

| Source | Endpoint | Key required | Notes |
|--------|----------|--------------|-------|
| Reddit | `reddit.com/search.json` | No | Public JSON search; `User-Agent` header required |
| Hacker News | `hn.algolia.com/api/v1/search` | No | Algolia API; covers stories + comments |
| GitHub | `api.github.com/search/issues` | No | Issues, PRs, and Discussions (10 req/min unauthenticated) |
| Bluesky | `public.api.bsky.app/xrpc/app.bsky.feed.searchPosts` | No | Public AT Protocol search |
| Brave Search | `api.search.brave.com/res/v1/web/search` | **Yes** (`BRAVE_SEARCH_API_KEY`) | Generic web results; platform label = source hostname |

### Safety mechanisms

- **`fetchWithTimeout`** wraps every upstream call with an `AbortController`
  (15s ceiling). A hung source yields `null` → treated as "no data", never a
  stall.
- **Local-only scoring** — relevance/sentiment are computed with deterministic
  string heuristics (keyword matches, word-boundary sentiment lexicon). No
  external LLM/semantic calls, so the cron is cheap and offline-safe.
- **Idempotent writes** — unique `url` constraint + `onConflictDoNothing`
  prevents duplicates across repeated runs.

### Heuristics (`computeLocalHeuristics`)

- Relevance: `+50` for `twistloom.com`, `+30` for the keyword, `+5` per context
  keyword (`story`, `thriller`, `branching`, `interactive`, `ai`, `plot`,
  `game`, `novel`), `-10` per negative word.
- Sentiment: `+0.2` per positive word, `-0.3` per negative word (word-boundary
  matched to avoid false positives like "bad" in "badge"). Clamped to `[-1, 1]`.

> The raw score is a *curation aid*, not a publication gate. Admins still review
> every item; the score just orders the queue so the best candidates surface
> first.

## Scheduling

`.github/workflows/social-mention-ingestion.yml` runs the compiled
`dist/cron/social-mentions.js` on a **weekly** schedule (Monday 02:00 UTC) and
supports `workflow_dispatch` for manual runs. Required secrets:

- `DATABASE_URL` / `DATABASE_READ_URL` — write connection (the cron uses
  `dbWrite`).
- `BRAVE_SEARCH_API_KEY` — optional; without it Brave results are skipped.

Build step compiles TS → JS; the job verifies `dist/cron/social-mentions.js`
exists before executing.

## Admin Curation API

All routes under `/admin/social-mentions` require `requireAuth` **and**
`requireSystemAdmin` (the requester's `req.userId` must equal
`process.env.SYSTEM_USER_ID`, else `403`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/social-mentions` | List queue; filters `status`, `platform`; paginated; ordered by `relevanceScore` |
| `GET` | `/admin/social-mentions/:id` | Fetch a single mention |
| `POST` | `/admin/social-mentions` | Manually create a curated mention (paste from X/blog/user submission); defaults `pending`, dedupes by URL |
| `PATCH` | `/admin/social-mentions/:id` | Moderate: `status`, `featured`, scores, `title`, `content` |
| `DELETE` | `/admin/social-mentions/:id` | Remove a mention (spam outside the approve/reject flow) |
| `POST` | `/admin/social-mentions/bulk-status` | Bulk set `status` for an array of ids |

Typical curation flow:

```
Ingestion (cron)  →  status = pending
        ↓
Admin opens GET /admin/social-mentions?status=pending
        ↓
PATCH :id  { status: "approved", featured: true }   (or bulk-status)
        ↓
Homepage wall query (status='approved' AND featured=true)
```

## Extension Guide

To add a new source:

1. Add a `fetchXMentions(): Promise<NormalizedMention[]>` function modeled on the
   existing ones — use `fetchWithTimeout`, normalize to `NormalizedMention`,
   catch errors and return `[]`.
2. Add it to the `Promise.all` array in `runSocialMentionCollection`.
3. Map the source to a stable `platform` string (used for filtering and labels).
4. No schema/migration change is needed unless you add a new stored column.

Good future candidates (all free, most keyless): Mastodon (`/api/v2/search`),
RSS (Reddit/HN/GitHub Discussions feeds), RSSHub, and Tavily (AI-agent search,
key required).

## Security & Cost Notes

- The cron never calls paid LLM endpoints — scoring is local.
- Per-source timeouts and per-item try/catch guarantee partial failures never
  abort the run or lose already-collected data.
- Only the system admin can read/modify the curation queue; the public homepage
  reads only `approved` + `featured` rows.

## Environment Variables & API Keys

All variables used by the ingestion cron and the admin curation API.

### Required (ingestion + admin cannot run without these)

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `DATABASE_URL` | Primary (write) Neon Postgres connection string | [Neon Console](https://console.neon.tech) → project → Connection Details |
| `DATABASE_READ_URL` | Read-replica connection (falls back to `DATABASE_URL` if unset) | Same as `DATABASE_URL`; optional but recommended in production |
| `SYSTEM_USER_ID` | UUID of the single admin user; gates all `/admin` curation routes | Your own DB `users.id` for the admin account |

### Optional (enhances ingestion)

| Variable | Purpose | Required? | Where to get it |
|----------|---------|-----------|-----------------|
| `BRAVE_SEARCH_API_KEY` | Unlocks Brave Search web results (cross-platform broad search). Cron skips Brave if absent. | Optional | [Brave Search API Dashboard](https://api.search.brave.com/app/dashboard) (free tier) |

### Not required by this subsystem (but commonly set in the same environment)

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `NODE_ENV` | `production` in the workflow; affects connection guards | — |
| `AUTH_SECRET` | NextAuth session signing; required for `requireAuth` on admin routes | Generate via `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` | Google OAuth verification (auth routes) | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `RESEND_API_KEY` | Email sending (verification/reset) | [Resend Dashboard](https://resend.com/dashboard) |
| `RESEND_FROM_EMAIL` | Verified sender address for Resend | Your Resend-verified domain |
| `FRONTEND_URL` | Base URL for email links | Your frontend deployment URL |
| `STRIPE_WEBHOOK_SECRET` / `STRIPE_VIP_PRICE_ID` / `STRIPE_VIP_PRODUCT_ID` | Payments / VIP subscriptions | [Stripe Dashboard](https://dashboard.stripe.com) |
| `GITHUB_API_KEY` / `GITHUB_WORKFLOW_TOKEN` | AI provider routing / workflow dispatch | [GitHub Personal Access Tokens](https://github.com/settings/tokens) |
| `GEMINI_API_KEY` / `NVIDIA_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `COHERE_API_KEY` / `CEREBRAS_API_KEY` / `OPENROUTER_API_KEY` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | LLM providers used by story generation (not used by social ingestion) | Respective provider consoles |

> **Note on sources:** Reddit, Hacker News, GitHub Search, and Bluesky are all
> **keyless** public endpoints — no API key is needed for them. Only Brave Search
> is optional/keyed. Tavily (a future candidate) would also be keyed.

### GitHub Actions secrets (for the weekly workflow)

The `.github/workflows/social-mention-ingestion.yml` job needs these repository
secrets configured under **Settings → Secrets and variables → Actions**:

| Secret | Maps to | Required? |
|--------|---------|-----------|
| `DATABASE_URL` | `DATABASE_URL` | Required |
| `DATABASE_READ_URL` | `DATABASE_READ_URL` | Optional (falls back to `DATABASE_URL`) |
| `BRAVE_SEARCH_API_KEY` | `BRAVE_SEARCH_API_KEY` | Optional (Brave skipped if absent) |
