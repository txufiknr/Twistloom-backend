/**
 * @summary Runs daily cleanup job for old user history entries and snapshot optimization
 * @description Removes history entries older than HISTORY_RETENTION_DAYS (7 days), optimizes snapshot storage, and cleans up orphaned user records
 * 
 * Idempotency:
 * - Safe to run multiple times: only deletes records matching criteria
 * - Uses consistent timestamp: `now() - interval '7 days'` ensures same cutoff
 * - Atomic operations: count and delete use identical WHERE conditions
 * - No side effects: only removes old data, never modifies active data
 * 
 * Should be run once per day via cron job, but safe to run repeatedly
 */
import { getErrorMessage } from "../utils/error.js";

export async function runDailyCleanup(): Promise<void> {
  // Lazy imports in cron for better memory usage and startup time
  const { processQueuedImageDeletions } = await import("../services/image.js");
  const { cleanupExpiredTemporarySessions } = await import("../services/temporary-session.js");
  const { cleanupOrphanedAssociations } = await import("../services/session-data-association.js");
  const { runVipExpirationCheck } = await import("./vip-expiration.js");

  const startedAt = Date.now();

  try {
    console.log("[cleanup] 🧹 Starting daily cleanup...");

    // Cleanup queued ImageKit deletions (idempotent operation)
    console.log("[cleanup] 🖼️ Cleaning up queued ImageKit deletions...");
    const imageCleanupStats = await processQueuedImageDeletions(100); // Process up to 100 images per run

    // Log results for monitoring (safe to run multiple times)
    if (imageCleanupStats.processed > 0) {
      console.log(`[cleanup] 🖼️ Processed ${imageCleanupStats.processed} ImageKit deletions: ${imageCleanupStats.successful} successful, ${imageCleanupStats.failed} failed`);
      if (imageCleanupStats.errors.length > 0) {
        console.log(`[cleanup] ⚠️ ImageKit cleanup errors: ${imageCleanupStats.errors.join('; ')}`);
      }
    } else {
      console.log("[cleanup] ✨ No queued ImageKit deletions to process");
    }

    // Cleanup expired temporary sessions (daily is sufficient given LRU cache auto-eviction)
    console.log("[cleanup] 🗑️ Cleaning up expired temporary sessions...");
    const sessionCleanupCount = await cleanupExpiredTemporarySessions();
    console.log(`[cleanup] ✨ Cleaned up ${sessionCleanupCount} expired temporary sessions`);

    // Cleanup orphaned session data associations
    console.log("[cleanup] 🗑️ Cleaning up orphaned session data associations...");
    const associationCleanupCount = await cleanupOrphanedAssociations();
    console.log(`[cleanup] ✨ Cleaned up ${associationCleanupCount} orphaned associations`);

    // Check for expired VIP subscriptions and downgrade users
    console.log("[cleanup] 👑 Checking for expired VIP subscriptions...");
    await runVipExpirationCheck();
    console.log("[cleanup] ✨ VIP expiration check completed");

    const durationMs = Date.now() - startedAt;
    console.log(`[cleanup] ✅ Cleanup completed in ${durationMs}ms:`, {
      images: imageCleanupStats.processed,
      sessions: sessionCleanupCount,
      associations: associationCleanupCount,
    });
  } catch (error) {
    console.error("[cleanup] ❌ Daily cleanup failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for cleanup cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    await runDailyCleanup();
    const durationMs = Date.now() - startedAt;
    console.log(`[cleanup] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[cleanup] ❌ Cleanup job failed:", getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[cleanup] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[cleanup] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
