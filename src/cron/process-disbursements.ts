/**
 * @summary Runs automated payout disbursement batching and dispatch job
 * @description Processes pending creator payouts, dispatches to payment rails (Xendit)
 *
 * Idempotency:
 * - Safe to run repeatedly: queries payouts with status='pending' and acquires row lock
 * - Uses external_id: `twistloom_payout_${payoutId}` ensuring gateway idempotency
 *
 * Can be run via scheduled worker, GitHub Actions, or Vercel Cron
 */

import { getErrorMessage } from "../utils/error.js";
import { processPendingPayouts } from "../services/disbursement.js";

export async function runDisbursementJob(): Promise<void> {
  const startedAt = Date.now();
  console.log("[disbursement] 💸 Starting automated payout disbursement processing...");

  try {
    const result = await processPendingPayouts();
    const durationMs = Date.now() - startedAt;

    console.log(`[disbursement] ✅ Disbursement run completed in ${durationMs}ms:`, {
      processedCount: result.processedCount,
      completedCount: result.completedCount,
      pendingCount: result.pendingCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });
  } catch (error) {
    console.error("[disbursement] ❌ Disbursement job failed:", getErrorMessage(error));
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await runDisbursementJob();
    process.exit(0);
  } catch (error) {
    console.error("[disbursement] ❌ Job failed:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[disbursement] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[disbursement] Uncaught exception", error);
  process.exit(1);
});

// Run directly if invoked via CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void main();
}
