/**
 * Performance-monitoring feature flag.
 *
 * Every metric recording path in `src/services/performance-monitoring.ts` is
 * gated behind this single switch so operators can disable the in-process
 * metrics collector without code edits:
 *
 * - **Monitoring ON (default)** — set `DISABLE_PERFORMANCE_MONITORING` unset or
 *   falsy. `startPerformanceMeasurement` records metrics, target violations are
 *   logged, and the periodic in-memory cleanup interval is scheduled.
 * - **Monitoring OFF** — set `DISABLE_PERFORMANCE_MONITORING=true` (or `1`/
 *   `yes`/`on`). `startPerformanceMeasurement` returns a no-op measurement
 *   whose `end()` records nothing, no warnings are emitted, and the cleanup
 *   `setInterval` is never scheduled (important on Vercel serverless, where a
 *   lingering interval keeps the event loop alive and prevents freeze/teardown).
 *
 * Reading `process.env` once at module load is safe on both Bun and Node.js
 * serverless runtimes (Vercel injects env vars into `process.env`).
 */

const raw = (process.env.DISABLE_PERFORMANCE_MONITORING ?? "").trim();
const disabled = /^(1|true|yes|on)$/i.test(raw);

/**
 * `true` when performance metrics should be collected.
 * Inverted from `DISABLE_PERFORMANCE_MONITORING` so the default (unset) keeps
 * monitoring enabled.
 */
export const PERFORMANCE_MONITORING_ENABLED = !disabled;
