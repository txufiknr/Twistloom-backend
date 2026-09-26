/**
 * @summary Refunds leaked credit reservations (reserve → crash → never settled)
 * @description Sweeps `type='reserve'` transaction rows older than
 * CREDIT_RESERVATION_TTL_MS and refunds them — the safety net for a process
 * crash between `reserveCredits` and settle/release (roadmap §3.1 step 4).
 *
 * Idempotency:
 * - Safe to run multiple times and concurrently: the guarded claim
 *   (`UPDATE … WHERE type = 'reserve'`) ensures each row is refunded once.
 * - Rows still within the TTL are left untouched for the next run.
 *
 * Should be run every ~10 minutes via cron job, but safe to run repeatedly.
 */

export async function runCreditReservationSweep(): Promise<void> {
  // Lazy import in cron for better memory usage and startup time
  const { sweepExpiredCreditReservations } = await import("../services/credit-reservations.js");

  const startedAt = Date.now();
  console.log("[sweep-credit-reservations] 🔍 Sweeping leaked credit reservations...");

  const result = await sweepExpiredCreditReservations();

  const durationMs = Date.now() - startedAt;
  console.log(`[sweep-credit-reservations] ✅ Sweep completed in ${durationMs}ms:`, {
    scanned: result.scanned,
    refunded: result.refunded,
    alreadyHandled: result.alreadyHandled,
    failed: result.failed,
  });

  // Surface persistent failures so the workflow run goes red.
  if (result.failed > 0) {
    throw new Error(`Failed to refund ${result.failed} credit reservation(s) — will retry on the next run`);
  }
}

/**
 * Main execution function for the credit reservation sweeper cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await runCreditReservationSweep();
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
 * Important for GitHub Actions correctness.
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
