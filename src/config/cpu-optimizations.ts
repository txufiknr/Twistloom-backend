/**
 * Central CPU-optimization feature flag.
 *
 * Every CPU/billing-saving refactor in this codebase is gated behind this
 * single switch so operators can flip between two modes without code edits:
 *
 * - **Optimizations ON (default)** — for CPU-constrained / credit-constrained
 *   tiers (Vercel Hobby, Netlify Free): status-poll coalescing (P1.4),
 *   session-verify cache (P2.4), and status payload compression skip (P2.5)
 *   are all active.
 * - **Optimizations OFF** — set `DISABLE_CPU_OPTIMIZATIONS=true` (or `1`/`yes`/
 *   `on`) for paid tiers where CPU/duration is no longer a constraint. This
 *   restores maximum data freshness (no coalescing staleness) and removes the
 *   ≤60s session-verify trust window, at the cost of full CPU.
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
