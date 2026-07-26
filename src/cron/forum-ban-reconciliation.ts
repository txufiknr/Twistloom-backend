/**
 * @summary Re-publishes user.banned events for all currently banned users.
 * @description Selects users where banned_at IS NOT NULL and sends a
 * user.banned event for each. Portal dedupes via idempotency key user.banned:{userId}.
 *
 * Idempotency:
 * - Safe to run multiple times: portal ignores duplicate deliveries
 * - No DB writes: only publishes queue events
 *
 * Should be run once after queue deployment to catch missed webhooks.
 */
import { getErrorMessage } from "../utils/error.js";

async function runBanReconciliation(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log("[forum-ban-reconciliation] 🔍 Starting ban reconciliation...");

    const { dbRead } = await import("../db/client.js");
    const { users } = await import("../db/schema.js");
    const { isNotNull } = await import("drizzle-orm");
    const { notifyForumUserBanned } = await import("../services/forum-queue.js");

    const bannedUsers = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(isNotNull(users.bannedAt));

    if (bannedUsers.length === 0) {
      console.log("[forum-ban-reconciliation] ✨ No banned users found");
      return;
    }

    console.log(`[forum-ban-reconciliation] ⚠️ Found ${bannedUsers.length} banned users, publishing events...`);

    let publishedCount = 0;
    let failedCount = 0;

    for (const user of bannedUsers) {
      try {
        notifyForumUserBanned(user.userId, 'reconciliation');
        publishedCount++;
        console.log(`[forum-ban-reconciliation] ✅ Published user.banned for ${user.userId}`);
      } catch (error) {
        failedCount++;
        console.error(`[forum-ban-reconciliation] ❌ Failed to publish for user ${user.userId}:`, getErrorMessage(error));
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[forum-ban-reconciliation] ✅ Ban reconciliation completed in ${durationMs}ms:`, {
      total: bannedUsers.length,
      published: publishedCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error("[forum-ban-reconciliation] ❌ Ban reconciliation failed:", getErrorMessage(error));
    throw error;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await runBanReconciliation();
    const durationMs = Date.now() - startedAt;
    console.log(`[forum-ban-reconciliation] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[forum-ban-reconciliation] ❌ Ban reconciliation job failed:", error);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[forum-ban-reconciliation] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[forum-ban-reconciliation] Uncaught exception", error);
  process.exit(1);
});

void main();
