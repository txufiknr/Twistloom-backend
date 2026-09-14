/**
 * @fileoverview Cron Job: Periodic Page Illustration Generation
 *
 * Generates AI illustrations for high-importance pages that don't yet have one.
 * Supports both scheduled batch processing and on-demand single-book triggers.
 *
 * Execution modes:
 * - Scheduled (no env vars): Batch process across all active public books
 * - On-demand (TRIGGERED_BOOK_ID set): Generate for a specific book only
 *
 * Environment variables:
 * - TRIGGERED_BOOK_ID: Optional book ID to generate illustrations for
 * - TRIGGERED_BATCH_SIZE: Optional max pages to process (default: 20)
 *
 * Reference pattern: `src/cron/retry-pending-generations.ts`.
 */

async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    // Lazy imports for better memory usage and startup time
    const { generateMissingPageIllustrations, generateBookIllustrations } = await import("../services/page-illustration.js");

    const triggeredBookId = process.env.TRIGGERED_BOOK_ID?.trim();
    const batchSizeStr = process.env.TRIGGERED_BATCH_SIZE?.trim();
    const batchSize = batchSizeStr ? parseInt(batchSizeStr, 10) : 20;

    let stats: { processed: number; generated: number; failed: number };

    if (triggeredBookId) {
      console.log(`[generate-page-illustrations] 🎯 On-demand trigger for book ${triggeredBookId}`);
      stats = await generateBookIllustrations(triggeredBookId, batchSize);
    } else {
      console.log(`[generate-page-illustrations] 🔄 Scheduled batch processing`);
      stats = await generateMissingPageIllustrations(batchSize);
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[generate-page-illustrations] ✅ Completed in ${durationMs}ms:`, stats);
    process.exit(0);
  } catch (error) {
    console.error("[generate-page-illustrations] ❌ Job failed:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[generate-page-illustrations] 💥 Unhandled promise rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[generate-page-illustrations] 💥 Uncaught exception:", error);
  process.exit(1);
});

void main();
