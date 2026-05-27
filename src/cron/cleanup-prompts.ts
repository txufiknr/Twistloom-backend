/**
 * @overview Daily Prompt Cleanup Cron Job
 * 
 * Cleans up expired, low-quality, and over-used prompts.
 * Runs according to PROMPT_CLEANUP_CRON schedule (default: Daily 3:00 AM UTC).
 */

import { deactivateExpiredPrompts, deactivateLowQualityPrompts, deactivateOverusedPrompts } from "../services/prompt-cache.js";
import { dbRead } from "../db/client.js";
import { storyPrompts, userPromptHistory } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";

/**
 * Cron job: Clean up old prompts
 * 
 * Tasks:
 * - Deactivate expired prompts
 * - Deactivate low-quality prompts
 * - Deactivate over-used prompts
 * - Archive old user prompt history (> 90 days)
 */
export async function cleanupPrompts() {
  console.log('[cleanupPrompts] Starting daily prompt cleanup');
  
  try {
    let totalDeactivated = 0;
    
    // Task 1: Deactivate expired prompts
    const expiredCount = await deactivateExpiredPrompts();
    if (expiredCount > 0) {
      console.log(`[cleanupPrompts] Deactivated ${expiredCount} expired prompts`);
      totalDeactivated += expiredCount;
    }
    
    // Task 2: Deactivate low-quality prompts
    const lowQualityCount = await deactivateLowQualityPrompts();
    if (lowQualityCount > 0) {
      console.log(`[cleanupPrompts] Deactivated ${lowQualityCount} low-quality prompts`);
      totalDeactivated += lowQualityCount;
    }
    
    // Task 3: Deactivate over-used prompts
    const overusedCount = await deactivateOverusedPrompts();
    if (overusedCount > 0) {
      console.log(`[cleanupPrompts] Deactivated ${overusedCount} over-used prompts`);
      totalDeactivated += overusedCount;
    }
    
    // Task 4: Archive old user prompt history (> 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const archivedHistory = await dbRead
      .delete(userPromptHistory)
      .where(
        and(
          eq(userPromptHistory.usedForBook, false), // Only delete if not used for book
          sql`${userPromptHistory.viewedAt} < ${ninetyDaysAgo}`
        )
      )
      .returning({ id: userPromptHistory.id });
    
    if (archivedHistory.length > 0) {
      console.log(`[cleanupPrompts] Archived ${archivedHistory.length} old user prompt history entries`);
    }
    
    console.log(`[cleanupPrompts] ✅ Complete. Total deactivated: ${totalDeactivated}, Archived: ${archivedHistory.length}`);
    
  } catch (error) {
    console.error('[cleanupPrompts] ❌ Error:', error);
    throw error;
  }
}

/**
 * Gets cache statistics for monitoring
 * 
 * @returns Promise resolving to cache statistics
 */
export async function getCacheStatistics() {
  const activeCount = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  const inactiveCount = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, false));
  
  const avgQuality = await dbRead
    .select({ avg: sql<number>`AVG(quality_score)` })
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  const totalUsage = await dbRead
    .select({ total: sql<number>`SUM(usage_count)` })
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  const historyCount = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userPromptHistory);
  
  return {
    activePrompts: activeCount[0]?.count || 0,
    inactivePrompts: inactiveCount[0]?.count || 0,
    averageQuality: avgQuality[0]?.avg || 0,
    totalUsage: totalUsage[0]?.total || 0,
    totalHistoryEntries: historyCount[0]?.count || 0,
  };
}