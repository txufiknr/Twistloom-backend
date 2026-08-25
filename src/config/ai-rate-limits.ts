/**
 * AI Generation Rate Limits — per-endpoint, per-user throttles.
 *
 * **Scope (important):** this file is ONLY for endpoints that trigger AI/LLM
 * work or otherwise amplify spend (model calls, tokens, credits). Every entry
 * below exists because a single request can burn real money, so each gets a
 * stricter per-user ceiling than the global one.
 *
 * **Do NOT add non-AI endpoints here.** Endpoints that are pure DB I/O with no
 * model calls and no credit gate (e.g. page emoji reactions, likes, comments)
 * are already covered by the global `rateLimitByUser` middleware
 * (100 req/min, see `src/app.ts`), and don't need an entry in this file. Adding
 * one here would be misleading — these configs are tuned around AI cost, and
 * conflating them with free social writes muddies the spend-protection story.
 * If a non-AI endpoint ever needs a tighter cap, apply a `rateLimit()` config
 * inline at the route (see `src/middleware/rate-limit.ts`) rather than here.
 *
 * The global `rateLimitByUser` middleware (100 req/min) already guards every
 * `/api/*` route, but that ceiling is far too loose for the *cost‑amplifying*
 * AI endpoints. Each AI generation here can spin up expensive LLM calls (a
 * single book spawns dozens of page prompts across the provider waterfall), so
 * a malicious or buggy client could rack up significant spend before the
 * 100/min global cap ever trips.
 *
 * These limits are deliberately stricter than the global cap and key on the
 * authenticated `userId` (see `src/middleware/rate-limit.ts`). They run on the
 * Upstash Redis Sliding-window limiter and **fail open** if Redis is down, so
 * they can never take the app down during a Redis outage.
 *
 * Every value is tunable at deploy time without a code change via env vars:
 *   - `RLIST_MAX_<NAME>`           overrides the max requests
 *   - `RLIST_SECONDS_<NAME>`       overrides the window length (seconds)
 *
 * If an env override is unset or non-positive, the shipped default below is
 * used — so a clean deploy can never accidentally unlock a tighter limit.
 *
 * @see src/middleware/rate-limit.ts for the middleware contract
 */

export interface AIRateLimitConfig {
  /** Maximum number of requests permitted within the sliding window */
  maxRequests: number;
  /** Sliding-window length in seconds */
  windowSeconds: number;
}

/** Read a positive int from an env var, falling back to `fallback`. */
function readInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Builds a tunable {@link AIRateLimitConfig} from a pair of env overrides.
 *
 * @param envPrefix - Uppercase name used to form the env keys
 *                    `RLIST_MAX_<prefix>` / `RLIST_SECONDS_<prefix>`
 * @param fallbackMax - Default max requests when the env override is absent
 * @param fallbackWindowSeconds - Default window length when the override is absent
 * @returns A merged {@link AIRateLimitConfig} consumable by `rateLimit()`
 */
function buildRateLimit(
  envPrefix: string,
  fallbackMax: number,
  fallbackWindowSeconds: number
): AIRateLimitConfig {
  return {
    maxRequests: readInt(`RLIST_MAX_${envPrefix}`, fallbackMax),
    windowSeconds: readInt(`RLIST_SECONDS_${envPrefix}`, fallbackWindowSeconds),
  };
}

/**
 * POST /api/books — synchronous whole-book creation.
 *
 * Most expensive endpoint: generates an entire book (initial page + many
 * sequential page prompts) synchronously within a single request. Also bounded
 * by `MAX_CONCURRENT_GENERATIONS` (5) and credit checks, but the rate limit is
 * the first line of defense against spend amplification. A human creating a
 * multi-page psychological thriller will naturally take minutes — 5/min is
 * generous for genuine use while capping scripted abuse.
 *
 * why: every request runs a full multi-page LLM generation, so keep the
 * ceiling low.
 */
export const BOOK_CREATION_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "BOOK_CREATION", 5, 60
);

/**
 * POST /api/books/stream — book creation with SSE progress.
 *
 * Same underlying generation cost as {@link BOOK_CREATION_RATE_LIMIT}, but the
 * SSE path is the common interactive flow in the UI, so it allows a little more
 * headroom. Streaming also holds an open connection for the whole generation, so
 * this doubles as a cheap guard against connection-exhaustion.
 *
 * why: same per-request cost as sync creation, but the default client path —
 * 10/min is a comfortable margin above a normal creation session's requests.
 */
export const BOOK_STREAM_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "BOOK_STREAM", 10, 60
);

/**
 * POST /api/books/async — fire-and-forget creation via GitHub Actions.
 *
 * Cheapest on the backend itself (the heavy work happens in the GitHub Action runner),
 * but each dispatch can still burn significant AI credits once the runner starts
 * generating. The route also guards against workflow-spam flooding the queue.
 *
 * why: backend work is deferred to a runner, but each dispatch commits real
 * downstream compute + credits — keep the ceiling moderate to bound queue spam.
 */
export const BOOK_ASYNC_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "BOOK_ASYNC", 10, 60
);

/**
 * POST /api/books/:identifier/:pageId/actions/hint — AI hint generation.
 *
 * A hint is a short AI completion, far cheaper than a full page. Readers can
 * legitimately request several while stuck on a page, so this is more lenient —
 * but it still consumes credits and tokens, so it isn't unthrottled.
 *
 * why: cheaper per call, but still a metered AI affordance; 30/min is generous
 * for genuine reading while capping obvious hammering.
 */
export const ACTION_HINT_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "ACTION_HINT", 30, 60
);

/**
 * POST /api/books/:identifier/:pageId/custom-actions/preview — validate a custom
 * action WITHOUT charging credits.
 *
 * This is the abuse-prone one: preview validation is free, so an attacker could
 * loop it to grind AI validation tokens at zero credit cost. It's also a likely
 * candidate for accidental rapid re-submission in the UI (debounce fallback).
 *
 * why: free (no credit charge) pure-validation call — the classic free-cost
 * amplification vector; 20/min keeps previews usable while closing the gap.
 */
export const CUSTOM_ACTION_PREVIEW_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "CUSTOM_ACTION_PREVIEW", 20, 60
);

/**
 * POST /api/books/:identifier/:pageId/custom-actions/submit — generate a page
 * from a custom action (charges credits + full LLM page generation).
 *
 * The most expensive non-book-generation call: full page generation plus credit
 * debit. Credit checks already gate it, but the rate limit stops a client from
 * rapidly retrying past a failed generation to drain their own (or a shared)
 * balance repeatedly.
 *
 * why: full page generation + credit debit — mirror the book-generation
 * strictness; 10/min bounds cost and repeated debit churn.
 */
export const CUSTOM_ACTION_SUBMIT_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "CUSTOM_ACTION_SUBMIT", 10, 60
);

/**
 * POST /api/pen/sessions/:id/continue — AI continuation of a Pen draft.
 *
 * Credit-gated by the continuation-length tier (§8 of the Pen roadmap): short/
 * medium/long charge 1/2/3 credits, so all tiers are paid and the rate limit
 * primarily bounds burst spend + retry churn around a charged generation.
 *
 * why: every `/continue` burns output tokens proportional to its length tier,
 * and charged generations are additionally gated by the credit check inside
 * `continuePenDraft` — this ceiling stops a client hammering a fresh model
 * before its balance (or the credit check) catches up.
 */
export const PEN_CONTINUE_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "PEN_CONTINUE", 20, 60
);

/**
 * POST /api/pen/sessions/:id/essentials/autofill — AI-fill the blank Page
 * Essentials fields from the draft.
 *
 * Charges `PEN_ESSENTIALS_AUTOFILL` (1 credit) via `executeWithCredits`, so the
 * credit check already gates spend; this ceiling bounds burst + retry churn
 * around a charged generation (roadmap §8: even a cheap action needs a rate
 * limit, not credits alone).
 *
 * why: 1-credit structured-output generation — the credit check gates it, but
 * the limit stops a client hammering past a fresh model before its balance (or
 * the credit check) catches up.
 */
export const PEN_ESSENTIALS_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "PEN_ESSENTIALS", 10, 60
);

/**
 * POST /api/pen/sessions/:id/finalize/propose — AI-compute the next page's
 * inventory/injuries as an "adopt as canon" proposal (§2.i / §10).
 *
 * Free (`PEN_FINALIZE_PROPOSE` = 0) but still an LLM structured-output call, so
 * it gets the same spend-shape guard as essentials auto-fill.
 */
export const PEN_FINALIZE_PROPOSE_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "PEN_FINALIZE_PROPOSE", 10, 60
);

/**
 * POST /api/pen/sessions/:id/transform — AI block-action selection transformation.
 *
 * Charges `PEN_TRANSFORM` (1 credit) via `executeWithCredits`. Rate limit bounds burst
 * and retry churn.
 */
export const PEN_TRANSFORM_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "PEN_TRANSFORM", 20, 60
);

/**
 * POST /api/books/:identifier/:pageId/companion/ask — reader companion AI Q&A.
 *
 * Charges `COMPANION_ASK` (1 credit) via `executeWithCredits`. A reader can
 * legitimately ask several follow-up questions per page, so this is moderately
 * permissive — but it still burns LLM tokens per call and is credit-gated.
 *
 * why: grounded AI question-answering over story state — 20/min keeps the
 * companion usable during active reading while capping abuse.
 */
export const COMPANION_ASK_RATE_LIMIT: AIRateLimitConfig = buildRateLimit(
  "COMPANION_ASK", 20, 60
);