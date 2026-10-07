/**
 * Outbound HTTP request timeouts (ms) for `AbortSignal.timeout(...)`.
 *
 * Central registry so every third-party deadline is tunable in one place instead
 * of being scattered as magic numbers across `src/utils`, `src/services`, and
 * `src/cron`. Each constant documents its caller, why the value was chosen, and
 * how failures surface.
 *
 * Selection guidance when changing a value:
 * - Keep the deadline **below** the invoking function's wall-clock budget
 *   (Netlify/Vercel function limits) so an upstream hang aborts and retries
 *   instead of the platform killing the invocation mid-flight.
 * - `AbortSignal.timeout` rejects with `TimeoutError`, which `retryWithBackoff`
 *   (`src/utils/retry.ts`) classifies as retryable — deadlines on retryable
 *   paths can be aggressive because a stall becomes a bounded retry, not a
 *   failed user action.
 * - Prefer matching the upstream's observed p95 latency with headroom; a value
 *   far above p95 only prolongs the worst case without improving success rate.
 */

/**
 * LibreTranslate translate API (single-text and batch endpoints).
 *
 * Used by `translateText` / `translateTexts` (`src/utils/translation.ts`).
 * Public LibreTranslate instances are slow and bursty — paragraph-scale batches
 * regularly take several seconds — so 30 s gives generous headroom over typical
 * responses while still bounding a hung instance. Not wrapped in
 * `retryWithBackoff`; on timeout the error propagates to the caller (UI shows a
 * translation failure toast), so the cap is a UX budget, not a retry knob.
 */
export const TRANSLATION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Jina embeddings API (`POST /v1/embeddings`).
 *
 * Used by `callJinaEmbeddingsAPI` (`src/utils/embedding.ts`), which sits inside
 * `retryWithBackoff` with rate-limit-aware backoff. Embedding batches for page
 * content can be large (hundreds of chunks), so 30 s covers slow batches; a
 * `TimeoutError` is retried with backoff rather than failing generation, so the
 * value mainly bounds per-attempt stall time inside the retry loop.
 */
export const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

/**
 * GitHub `POST /actions/workflows/{file}/dispatches` (workflow trigger).
 *
 * Used by `dispatchGitHubWorkflow` (`src/utils/github-workflow.ts`), inside
 * `retryWithBackoff` (3 retries). The dispatch endpoint normally answers in
 * well under a second; 30 s tolerates GitHub API hiccups while keeping total
 * worst-case (timeout × attempts + backoff) inside the caller's function
 * budget. A timeout here is ambiguous (the dispatch may have landed), which is
 * why the retry path treats re-dispatch as safe for these workflows.
 */
export const GITHUB_WORKFLOW_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * GitHub Actions read/control endpoints (list workflow runs, cancel a run).
 *
 * Used by `listWorkflowRuns` / `cancelWorkflowRun` (`src/utils/github-workflow.ts`).
 * These are lightweight REST reads without `retryWithBackoff`, so a tighter
 * 15 s cap keeps admin/cron callers responsive — a hung list call should fail
 * fast to the UI rather than occupy the request for 30 s.
 */
export const GITHUB_API_TIMEOUT_MS = 15_000;

/**
 * Upstash QStash API calls: message publish (`v1/publish`) and schedule upsert
 * (`schedules/{destination}`).
 *
 * Used by `publishForumEvent` (`src/services/forum-queue.ts`) and the
 * `qstash:setup` registration script (`src/cron/ensure-qstash-schedules.ts`).
 * QStash accepts publishes in milliseconds; 15 s bounds a control-plane stall.
 * Forum publish is fire-and-forget (failure logged, mutation never fails), and
 * schedule upsert is an explicit ops step that should surface errors quickly.
 */
export const QSTASH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Neon console control-plane API (`GET /projects/{id}` consumption metrics).
 *
 * Used by `fetchNeonProjectUsage` (`src/services/neon-usage.ts`). The endpoint
 * is a fast metadata read; results are cached 5 minutes via `withCache`, so a
 * slow response is not worth waiting on — 10 s fails fast and lets the caller
 * surface `NeonApiError` (admin dashboard) instead of hanging on billing data
 * that only changes per billing period.
 */
export const NEON_USAGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Store receipt verification: Google Play Developer API (`getPurchase`) and
 * App Store Server API (transaction lookup) in `src/services/store-verification/`.
 *
 * Both are synchronous HTTPS calls on the purchase-verification critical path,
 * where the user is waiting. 15 s matches typical mobile-store API behavior
 * with headroom; on timeout the verifier returns an "unavailable" outcome (a
 * transient failure) rather than blocking checkout indefinitely.
 */
export const STORE_VERIFICATION_TIMEOUT_MS = 15_000;
