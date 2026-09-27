/**
 * @summary Manual CLI runner for the credit reservation leak sweeper
 * @description Refunds `type='reserve'` transaction rows older than
 * CREDIT_RESERVATION_TTL_MS — the safety net for a process crash between
 * `reserveCredits` and settle/release (roadmap §3.1 step 4).
 *
 * Scheduled production runs no longer go through this entrypoint. They are:
 *   1. Opportunistic — `sweepExpiredReservationsOpportunistically()` on the
 *      charge path (Redis-throttled), inside `reserveCredits`.
 *   2. Scheduled — Upstash QStash → `POST /api/cron/sweep-credit-reservations`
 *      every 10 minutes (`src/routes/cron.ts`).
 *
 * This file remains for local runs and manual backfills:
 *   bun --env-file=.env.local src/cron/sweep-credit-reservations.ts
 *   bun dist/cron/sweep-credit-reservations.js
 *
 * Idempotency: safe to run repeatedly and concurrently — the guarded claim
 * (`UPDATE … WHERE type = 'reserve'`) refunds each row exactly once, and rows
 * still within the TTL are left untouched.
 */

import { runCreditReservationSweep } from "../services/credit-reservations.js";

/**
 * Main execution function for the credit reservation sweeper cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    const result = await runCreditReservationSweep();

    // Surface persistent failures so the run goes red.
    if (result.failed > 0) {
      throw new Error(
        `Failed to refund ${result.failed} credit reservation(s) — will retry on the next run`
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[sweep-credit-reservations] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[sweep-credit-reservations] ❌ Sweep job failed:", error);
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for CLI correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[sweep-credit-reservations] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[sweep-credit-reservations] Uncaught exception", error);
  process.exit(1);
});

void main();
