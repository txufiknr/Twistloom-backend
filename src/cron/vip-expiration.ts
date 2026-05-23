/**
 * @summary Runs daily VIP expiration check and downgrade job
 * @description Checks for expired VIP subscriptions and downgrades users to standard tier
 * 
 * Idempotency:
 * - Safe to run multiple times: only downgrades users with expired subscriptions
 * - Uses consistent timestamp: checks vip_expires_at < now()
 * - Atomic operations: updates user tier and clears subscription reference
 * - No side effects: only downgrades expired users, never affects active users
 * 
 * Should be run once per day via cron job, but safe to run repeatedly
 */
import { getErrorMessage } from "../utils/error.js";

export async function runVipExpirationCheck(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[vip-expiration] 🔍 Starting VIP expiration check...");
    
    // Lazy import to avoid circular dependencies
    const { downgradeUserFromVip } = await import("../services/subscription.js");
    const { dbRead } = await import("../db/client.js");
    const { users } = await import("../db/schema.js");
    const { eq, and, lt, sql } = await import("drizzle-orm");
    
    // Find users with expired VIP subscriptions
    const expiredUsers = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(and(
        eq(users.tier, 'vip'),
        sql`${users.vipExpiresAt} IS NOT NULL`,
        lt(users.vipExpiresAt, new Date())
      ));
    
    if (expiredUsers.length === 0) {
      console.log("[vip-expiration] ✨ No expired VIP subscriptions found");
      return;
    }
    
    console.log(`[vip-expiration] ⚠️ Found ${expiredUsers.length} expired VIP subscriptions, downgrading...`);
    
    let downgradedCount = 0;
    let failedCount = 0;
    
    // Downgrade each expired user
    for (const user of expiredUsers) {
      try {
        await downgradeUserFromVip(user.userId);
        downgradedCount++;
        console.log(`[vip-expiration] ✅ Downgraded user ${user.userId} from VIP to standard`);
      } catch (error) {
        failedCount++;
        console.error(`[vip-expiration] ❌ Failed to downgrade user ${user.userId}:`, getErrorMessage(error));
      }
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[vip-expiration] ✅ VIP expiration check completed in ${durationMs}ms:`, {
      total: expiredUsers.length,
      downgraded: downgradedCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error("[vip-expiration] ❌ VIP expiration check failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for VIP expiration cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    await runVipExpirationCheck();
    const durationMs = Date.now() - startedAt;
    console.log(`[vip-expiration] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[vip-expiration] ❌ VIP expiration job failed:", getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[vip-expiration] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[vip-expiration] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
