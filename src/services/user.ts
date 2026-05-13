/**
 * @overview User Service Module
 * 
 * Provides helper functions for user-related operations.
 * Implements DRY patterns for user management and activity tracking.
 * 
 * Architecture Features:
 * - Centralized user activity tracking
 * - Consistent timestamp updates
 * - Database abstraction layer
 * - Type-safe operations
 */

import { dbRead, dbWrite } from "../db/client.js";
import { users, userAuth, userCheckins, userActivityLogs } from "../db/schema.js";
import { eq, and, gt, ne, sql, desc } from "drizzle-orm";
import { debounceAsync } from "../utils/debounce.js";
import { getErrorMessage } from "../utils/error.js";
import { DAILY_CHECKIN_CREDITS } from "../config/credits.js";
import { getCurrentUTCDay } from "../utils/time.js";
import type { DBNewUserActivityLog } from "../types/schema.js";
import { requireEnv } from "../utils/env.js";

/**
 * Cleans up orphaned user records
 * 
 * Orphaned users are users that exist in the `users` table but don't have
 * corresponding records in the `user_auth` table. This can happen during
 * the registration process when the manual rollback fails after user_auth
 * creation fails.
 * 
 * This function finds and deletes these orphaned users to maintain data consistency.
 * 
 * Security:
 * - Uses Drizzle's sql template tag with parameter binding (not string interpolation)
 * - No sql.raw() usage - all values are properly parameterized
 * 
 * Performance:
 * - Single bulk DELETE with IN clause per chunk (not N+1 queries)
 * - Chunking prevents query size limits for large datasets
 * 
 * Idempotency:
 * - Safe to run multiple times: only deletes users without user_auth records
 * - Uses LEFT JOIN to identify orphans efficiently
 * 
 * @returns Number of orphaned users deleted
 * 
 * @example
 * ```typescript
 * const deletedCount = await cleanupOrphanedUsers();
 * console.log(`Deleted ${deletedCount} orphaned users`);
 * ```
 */
export async function cleanupOrphanedUsers(): Promise<number> {
  try {
    console.log("[user] 👤 Checking for orphaned users...");
    
    // Find users without user_auth records using LEFT JOIN
    const systemUserId = requireEnv('SYSTEM_USER_ID');
    const orphanedUsers = await dbWrite
      .select({ userId: users.userId })
      .from(users)
      .leftJoin(userAuth, eq(users.userId, userAuth.userId))
      .where(and(
        sql`${userAuth.userId} IS NULL`,
        ne(users.userId, systemUserId)
      ));
    
    if (orphanedUsers.length === 0) {
      console.log("[user] ✨ No orphaned users found");
      return 0;
    }
    
    console.log(`[user] ⚠️ Found ${orphanedUsers.length} orphaned users, deleting...`);
    
    // Delete orphaned users using parameterized bulk delete
    const userIds = orphanedUsers.map(u => u.userId);
    
    // Delete in batches to avoid query size limits
    const CHUNK_SIZE = 100;
    let totalDeleted = 0;
    
    for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
      const chunk = userIds.slice(i, i + CHUNK_SIZE);
      
      // Using sql.join for parameterized bulk delete (secure, not sql.raw)
      await dbWrite
        .delete(users)
        .where(sql`${users.userId} IN (${sql.join(chunk, sql`, `)})`);
      
      totalDeleted += chunk.length;
    }
    
    console.log(`[user] ✅ Deleted ${totalDeleted} orphaned users`);
    return totalDeleted;
  } catch (error) {
    console.error("[user] ❌ Failed to cleanup orphaned users:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Updates user's lastActive timestamp to current time
 * 
 * This function should be called after any user activity to ensure
 * accurate tracking of user engagement and session management.
 * Uses 2-second delay to prevent rapid successive calls
 * 
 * @param userId - The user ID to update
 * @returns Promise resolving when update is complete (or debounced)
 * 
 * @example
 * ```typescript
 * // Update user activity after login
 * await updateUserLastActivity('user123');
 * 
 * // Multiple rapid calls will be debounced:
 * await updateUserLastActivity('user123'); // Executes
 * await updateUserLastActivity('user123'); // Debounced
 * await updateUserLastActivity('user123'); // Debounced
 * // After 2 seconds, only the last call executes
 * ```
 * 
 * Behavior:
 * - Multiple calls within 2 seconds are debounced per user
 * - Only the last call for each user executes
 * - Different users have independent debounce timers
 * - Returns execution status for debugging
 */
export async function updateUserLastActivity(userId: string): Promise<void> {
  try {
    const result = await debounceAsync(
      async (userId: string): Promise<void> => {
        await dbWrite
          .update(users)
          .set({
            lastActive: new Date(),
          })
          .where(eq(users.userId, userId));
      },
      { delay: 2000 }
    )(userId);
    
    // Log if call was debounced (useful for debugging)
    if (!result.executed) {
      console.log(`[user] ⏳ Activity update debounced for user: ${userId}`);
    }
  } catch (error) {
    // Log error but don't throw to avoid breaking main flow
    console.error(`[user] ❌ Failed to update last activity for user ${userId}:`, getErrorMessage(error));
  }
}

/**
 * Logs user activity for analytics and engagement monitoring
 * 
 * This function records user activities such as book creation, likes, comments,
 * follows, favorites, and session updates. It captures rich context including
 * request metadata (IP, user agent, platform, app version) for security analytics.
 * 
 * @param params - Activity log parameters
 * @param params.userId - The user ID performing the activity
 * @param params.activityType - Type of activity (e.g., "book_created", "liked", "commented", "followed", "favorited", "session_updated")
 * @param params.targetType - Type of target (e.g., "book", "comment", "user")
 * @param params.targetId - ID of the target entity
 * @param params.metadata - Additional context-specific data
 * @param params.ipAddress - User's IP address (optional)
 * @param params.userAgent - Browser/app user agent (optional)
 * @param params.platform - Platform (e.g., "android", "ios", "web") (optional)
 * @param params.appVersion - App version (optional)
 * @returns Promise resolving when log is inserted
 * 
 * @example
 * ```typescript
 * // Log book creation
 * await logUserActivity({
 *   userId: 'user123',
 *   activityType: 'book_created',
 *   targetType: 'book',
 *   targetId: 'book456',
 *   metadata: { title: 'The Haunting' },
 *   platform: 'android',
 *   appVersion: '1.0.0'
 * });
 * 
 * // Log like action
 * await logUserActivity({
 *   userId: 'user123',
 *   activityType: 'liked',
 *   targetType: 'book',
 *   targetId: 'book456',
 *   ipAddress: '192.168.1.1',
 *   userAgent: 'Mozilla/5.0...',
 *   platform: 'web'
 * });
 * ```
 * 
 * Behavior:
 * - Inserts activity log record with provided context
 * - Does not throw errors to avoid breaking main flow
 * - Logs errors for debugging
 * - Can be called from any route handler
 */
export async function logUserActivity(params: DBNewUserActivityLog): Promise<void> {
  const { userId } = params;
  const isInternal = userId === process.env.SYSTEM_USER_ID;
  if (isInternal) return;

  try {
    await dbWrite.insert(userActivityLogs).values(params);
    await updateUserLastActivity(userId);
  } catch (error) {
    // Log error but don't throw to avoid breaking main flow
    console.error(`[user] ❌ Failed to log activity for user ${params.userId}:`, getErrorMessage(error));
  }
}

/**
 * Gets users with recent activity for cleanup operations
 * 
 * @param daysAgo - How many days back to consider activity (default: 30)
 * @returns Promise resolving to array of user IDs with recent activity
 * 
 * @example
 * ```typescript
 * // Get users active in last 30 days
 * const activeUsers = await getActiveUsers(30);
 * console.log(`Found ${activeUsers.length} active users for cleanup`);
 * ```
 */
export async function getActiveUsers(daysAgo: number = 30): Promise<string[]> {
  try {
    const cutoffDate = new Date(Date.now() - (daysAgo * 24 * 60 * 60 * 1000));
    
    const recentUsers = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(and(
        gt(users.lastActive, cutoffDate)
      ))
      .limit(1000); // Reasonable limit for cleanup operations
    
    return recentUsers.map(user => user.userId);
  } catch (error) {
    console.error("[user] ❌ Failed to get active users:", getErrorMessage(error));
    return [];
  }
}

/**
 * Gets today's check-in record for a user if it exists
 * 
 * @param userId - The user ID to check
 * @returns Promise resolving to today's check-in record or null
 */
async function getTodayCheckIn(userId: string): Promise<{
  checkInDate: string;
  creditsClaimed: number;
} | null> {
  const todayUTC = getCurrentUTCDay();
  
  const existingCheckIn = await dbRead
    .select({
      checkInDate: userCheckins.checkInDate,
      creditsClaimed: userCheckins.creditsClaimed,
    })
    .from(userCheckins)
    .where(and(
      eq(userCheckins.userId, userId),
      eq(userCheckins.checkInDate, todayUTC)
    ))
    .limit(1);
  
  return existingCheckIn.length > 0 ? existingCheckIn[0] : null;
}

/**
 * Gets the last check-in date for a user
 * 
 * @param userId - The user ID to check
 * @returns Promise resolving to last check-in date or null
 */
async function getLastCheckInDate(userId: string): Promise<string | null> {
  const lastCheckIn = await dbRead
    .select({ checkInDate: userCheckins.checkInDate })
    .from(userCheckins)
    .where(eq(userCheckins.userId, userId))
    .orderBy(desc(userCheckins.checkInDate))
    .limit(1);
  
  return lastCheckIn.length > 0 ? lastCheckIn[0].checkInDate : null;
}

/**
 * Checks if user can perform daily check-in today
 * 
 * @param userId - The user ID to check
 * @returns Promise resolving to check-in status object
 * 
 * @example
 * ```typescript
 * const status = await checkCanCheckIn('user123');
 * if (status.canCheckIn) {
 *   console.log('User can check-in today');
 * } else {
 *   console.log('Already checked in today');
 * }
 * ```
 */
export async function checkCanCheckIn(userId: string): Promise<{
  canCheckIn: boolean;
  lastCheckInDate: string | null;
  creditsClaimed: number | null;
}> {
  try {
    const todayCheckIn = await getTodayCheckIn(userId);
    
    if (todayCheckIn) {
      return {
        canCheckIn: false,
        lastCheckInDate: todayCheckIn.checkInDate,
        creditsClaimed: todayCheckIn.creditsClaimed,
      };
    }
    
    const lastCheckInDate = await getLastCheckInDate(userId);
    
    return {
      canCheckIn: true,
      lastCheckInDate,
      creditsClaimed: null,
    };
  } catch (error) {
    console.error("[user] ❌ Failed to check check-in status:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Performs daily check-in and awards credits to user
 * 
 * Uses a database transaction to prevent race conditions where multiple
 * concurrent requests could both pass the check and award credits twice.
 * 
 * @param userId - The user ID performing check-in
 * @returns Promise resolving to check-in result with credits awarded
 * 
 * @example
 * ```typescript
 * const result = await performDailyCheckIn('user123');
 * console.log(`Awarded ${result.creditsAwarded} credits`);
 * ```
 */
export async function performDailyCheckIn(userId: string): Promise<{
  success: boolean;
  creditsAwarded: number;
  checkInDate: string;
  message: string;
}> {
  const todayUTC = getCurrentUTCDay();
  
  try {
    return await dbWrite.transaction(async (tx) => {
      // Check if user has already checked in today within the transaction
      const existingCheckIn = await tx
        .select({ id: userCheckins.id })
        .from(userCheckins)
        .where(and(
          eq(userCheckins.userId, userId),
          eq(userCheckins.checkInDate, todayUTC)
        ))
        .limit(1);
      
      if (existingCheckIn.length > 0) {
        return {
          success: false,
          creditsAwarded: 0,
          checkInDate: todayUTC,
          message: "Already checked in today",
        };
      }
      
      // Create check-in record
      await tx.insert(userCheckins).values({
        userId,
        checkInDate: todayUTC,
        creditsClaimed: DAILY_CHECKIN_CREDITS,
      });
      
      // Import credits service to add credits (prevent circular deps)
      const { addCredits } = await import("./credits.js");
      
      // Add credits to user
      await addCredits(userId, DAILY_CHECKIN_CREDITS, {
        context: "daily_checkin",
        metadata: { checkInDate: todayUTC },
      });
      
      console.log(`[user] ✅ User ${userId} checked in and claimed ${DAILY_CHECKIN_CREDITS} credits`);
      
      return {
        success: true,
        creditsAwarded: DAILY_CHECKIN_CREDITS,
        checkInDate: todayUTC,
        message: `Successfully claimed ${DAILY_CHECKIN_CREDITS} daily credits`,
      };
    });
  } catch (error) {
    console.error("[user] ❌ Failed to perform daily check-in:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Gets user's check-in status and history
 * 
 * @param userId - The user ID to query
 * @returns Promise resolving to check-in status with history
 * 
 * @example
 * ```typescript
 * const status = await getCheckInStatus('user123');
 * console.log(`Total check-ins: ${status.totalCheckIns}`);
 * console.log(`Last check-in: ${status.lastCheckInDate}`);
 * ```
 */
export async function getCheckInStatus(userId: string): Promise<{
  canCheckIn: boolean;
  lastCheckInDate: string | null;
  totalCheckIns: number;
  totalCreditsClaimed: number;
  recentCheckIns: Array<{
    checkInDate: string;
    creditsClaimed: number;
    createdAt: Date;
  }>;
}> {
  try {
    // Check if user can check-in today
    const canCheckInStatus = await checkCanCheckIn(userId);
    
    // Get check-in history (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
    const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    const checkInHistory = await dbRead
      .select({
        checkInDate: userCheckins.checkInDate,
        creditsClaimed: userCheckins.creditsClaimed,
        createdAt: userCheckins.createdAt,
      })
      .from(userCheckins)
      .where(and(
        eq(userCheckins.userId, userId),
        sql`${userCheckins.checkInDate} >= ${cutoffDate}`
      ))
      .orderBy(desc(userCheckins.checkInDate))
      .limit(30);
    
    // Get total check-ins and credits claimed
    const totals = await dbRead
      .select({
        totalCheckIns: sql<number>`COUNT(*)`,
        totalCreditsClaimed: sql<number>`SUM(${userCheckins.creditsClaimed})`,
      })
      .from(userCheckins)
      .where(eq(userCheckins.userId, userId))
      .limit(1);
    
    return {
      canCheckIn: canCheckInStatus.canCheckIn,
      lastCheckInDate: canCheckInStatus.lastCheckInDate,
      totalCheckIns: totals[0]?.totalCheckIns || 0,
      totalCreditsClaimed: totals[0]?.totalCreditsClaimed || 0,
      recentCheckIns: checkInHistory,
    };
  } catch (error) {
    console.error("[user] ❌ Failed to get check-in status:", getErrorMessage(error));
    throw error;
  }
}
