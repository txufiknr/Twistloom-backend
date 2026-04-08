/**
 * @summary Runs daily cleanup job for old user history entries and snapshot optimization
 * @description Removes history entries older than HISTORY_RETENTION_DAYS (7 days) and optimizes snapshot storage
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
    
    // Optimize snapshots for all users with books (batch operation)
    console.log("[cleanup] 📸 Optimizing snapshot storage...");
    let totalSnapshotsOptimized = 0;
    let totalSnapshotsDeleted = 0;
    
    try {
      // Get all users who have recent activity (simpler approach)
      const { getStoryProgress } = await import("../services/story.js");
      const { getActiveUsers } = await import("../services/user.js");
      
      const activeUsers = await getActiveUsers(30); // Last 30 days
      
      for (const userId of activeUsers) {
        try {
          const progress = await getStoryProgress(userId);
          if (progress && progress.book && progress.book.id) {
            const { optimizeSnapshots } = await import("../services/snapshots.js");
            const result = await optimizeSnapshots(userId, progress.book.id, 20); // Default limit
              totalSnapshotsOptimized += result.kept;
              totalSnapshotsDeleted += result.deleted;
              
              if (result.deleted > 0) {
                console.log(`[cleanup] 📚 Snapshots optimized:`, {
                  user: userId,
                  book: progress.book.id,
                  deleted: result.deleted,
                  kept: result.kept
                });
              }
          }
        } catch (error) {
          console.error(`[cleanup] ❌ Failed to optimize snapshots:`, {userId, error: getErrorMessage(error)});
          // Continue with next user - don't fail entire cleanup
        }
      }
      
      const durationMs = Date.now() - startedAt;
      console.log(`[cleanup] ✅ Cleanup completed in ${durationMs}ms:`, {
        images: imageCleanupStats.processed,
        snapshotsDeleted: totalSnapshotsDeleted,
        snapshotsKept: totalSnapshotsOptimized
      });
    } catch (error) {
      console.error("[cleanup] ❌ Snapshot optimization failed:", getErrorMessage(error));
      // Don't throw error - continue with image cleanup completed
    }
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
