/**
 * Central CPU-optimization feature flag.
 *
 * Shared switch for the gated polling, cookie-decoding, and compression
 * optimizations, allowing comparison or rollback without code edits:
 *
 * - **Optimizations ON (default)** — for CPU-constrained / credit-constrained
 *   tiers (Vercel Hobby, Netlify Free): status-poll coalescing (P1.4),
 *   immutable session-cookie decode cache (P2.4), and status compression skip (P2.5)
 *   are all active.
 * - **Optimizations OFF** — set `DISABLE_CPU_OPTIMIZATIONS=true` (or `1`/`yes`/
 *   `on`) to disable these gated paths for measurement or rollback. Paid tiers
 *   still benefit from reduced work; disabling this is an operational choice,
 *   not a prerequisite for upgrading. Cookie decode single-flight can still
 *   coalesce concurrent requests; the completed decode LRU is bypassed.
 *
 * Security invariant: session existence, ownership, and account standing are
 * checked freshly in both modes. This flag never enables stale authorization.
 *
 * Reading `process.env` once at module load is safe on both Bun and Node.js
 * serverless runtimes (platforms inject env vars into `process.env`).
 */

const raw = (process.env.DISABLE_CPU_OPTIMIZATIONS ?? "").trim();
const disabled = /^(1|true|yes|on)$/i.test(raw);

/**
 * `true` when the CPU-saving optimizations should be active.
 * Inverted from `DISABLE_CPU_OPTIMIZATIONS` so the default (unset) is opt-in
 * (optimizations enabled).
 */
export const CPU_OPTIMIZATIONS_ENABLED = !disabled;
