/**
 * @summary Runs periodic creator earnings maturation hold release job
 * @description Matures held earnings after the 14-day risk settlement window
 *
 * Idempotency:
 * - Safe to run repeatedly: only processes earnings with status='pending' and mature_at <= now()
 * - Atomic operations: transfers pendingAmount to availableAmount inside DB transactions
 *
 * Can be run via scheduled worker, GitHub Actions, or Vercel Cron
 */

import { getErrorMessage } from "../utils/error.js";
import { maturePendingEarnings } from "../services/maturation.js";

export async function runMaturationJob(): Promise<void> {
  const startedAt = Date.now();
  console.log("[maturation] ⏳ Starting creator earnings maturation check...");

  try {
    const result = await maturePendingEarnings();
    const durationMs = Date.now() - startedAt;

    console.log(`[maturation] ✅ Maturation run completed in ${durationMs}ms:`, {
      maturedCount: result.maturedCount,
      creatorsCount: result.creatorsCount,
      totalAmountsByCurrency: result.totalAmountsByCurrency,
    });
  } catch (error) {
    console.error("[maturation] ❌ Creator earnings maturation job failed:", getErrorMessage(error));
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    await runMaturationJob();
    process.exit(0);
  } catch (error) {
    console.error("[maturation] ❌ Job failed:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[maturation] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[maturation] Uncaught exception", error);
  process.exit(1);
});

// Run directly if invoked via CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void main();
}
