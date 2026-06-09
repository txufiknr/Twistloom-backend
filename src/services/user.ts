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

import type { Request, Response } from "express";
import { type DBClient, dbRead, dbWrite } from "../db/client.js";
import { users, userAuth, userCheckins, userActivityLogs } from "../db/schema.js";
import { eq, and, gt, ne, sql, desc, or } from "drizzle-orm";
import { debounceAsync } from "../utils/debounce.js";
import { sanitizeTextForDB } from '../utils/text-processing.js';
import { getErrorMessage, handleValidationError } from "../utils/error.js";
import { DAILY_CHECKIN_BONUS, DAILY_CHECKIN_DAYS, DAILY_CHECKIN_BIG_BONUS } from "../config/credits.js";
import { getCurrentUTCDay } from "../utils/time.js";
import { requireEnv } from "../utils/env.js";
import type { DBNewUser, DBNewUserActivityLog, DBUserForAuth } from "../types/schema.js";
import type { CheckinPostResponse, CheckinStatusResponse } from "../types/user.js";
import { VIP_BENEFITS } from "../config/subscription.js";
import { LRUCache } from 'lru-cache';
import { convertEmailToName, convertNameOrEmailToUsername, sanitizeUsername, validateUsername } from "../utils/username.js";
import { normalizeGender } from "../utils/parser.js";

/**
 * LRU cache for email -> userId mappings
 * 
 * Caches user ID lookups to reduce database query overhead.
 * Uses a maximum of 1000 entries with a 5-minute TTL.
 */
const userIdCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

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
export async function updateUserLastActivity(userId: string, client: DBClient = dbWrite): Promise<void> {
  try {
    const result = await debounceAsync(
      async (userId: string): Promise<void> => {
        await client
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
export async function logUserActivity(params: DBNewUserActivityLog, options?: { req?: Pick<Request, 'ip' | 'get'>, client?: DBClient }): Promise<void> {
  const { userId } = params;
  const { req, client = dbWrite } = options ?? {};
  const isInternal = userId === process.env.SYSTEM_USER_ID;
  if (isInternal) return;

  try {
    await client.insert(userActivityLogs).values({
      ...params,
      ipAddress: req?.ip,
      userAgent: req?.get('user-agent'),
      platform: req?.get('x-platform'),
      appVersion: req?.get('x-app-version'),
    });
    await updateUserLastActivity(userId, client);
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
 * Retrieves user ID from database using email address, with LRU caching
 * 
 * This function queries the database to find a user ID by email address.
 * Results are cached in an LRU cache to reduce database query overhead for
 * repeated lookups of the same email.
 * 
 * Cache behavior:
 * - Maximum 1000 entries
 * - 5-minute TTL per entry
 * - Cache hit: Returns cached ID immediately
 * - Cache miss: Queries database and caches result
 * 
 * Use this function for non-critical lookups where performance is important.
 * For authentication operations, use getUserForAuth instead.
 * 
 * @param email - User email address to look up
 * @returns User ID if found, null otherwise
 * 
 * @example
 * ```typescript
 * const userId = await getUserIdByEmail('user@example.com');
 * if (userId) {
 *   console.log('User ID:', userId);
 * }
 * ```
 */
export async function getUserIdByEmail(email: string): Promise<string | null> {
  // Check cache first
  const cachedId = userIdCache.get(email);
  if (cachedId) return cachedId;

  // Query database if not in cache
  const [user] = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
    
  if (user) {
    // Cache the result
    userIdCache.set(email, user.userId);
    return user.userId;
  }

  return null;
}

/**
 * Retrieves user data for authentication by email or username
 * 
 * This function queries the database to find a user by either email address
 * or username, returning all fields required for authentication including
 * the password hash. This is used during login and authentication flows.
 * 
 * Security considerations:
 * - NOT cached: Always queries database to ensure fresh authentication data
 * - Password changes take effect immediately
 * - Account deletions/bans prevent login immediately
 * - Suitable for security-critical authentication operations
 * 
 * Performance: Uses indexed lookups on email and username columns for fast queries.
 * 
 * @param emailOrUsername - User email address or username to look up
 * @returns User object with authentication data if found, null otherwise
 * 
 * @example
 * ```typescript
 * const user = await getUserForAuth('user@example.com');
 * if (user) {
 *   // Verify password hash
 *   const isValid = await verifyPassword(password, user.passwordHash);
 * }
 * ```
 * 
 * @example
 * ```typescript
 * // Can also use username
 * const user = await getUserForAuth('johndoe');
 * if (user) {
 *   console.log('Found user:', user.username);
 * }
 * ```
 */
export async function getUserForAuth(emailOrUsername: string): Promise<DBUserForAuth | null> {
  // Normalize lookup value (case-insensitive usernames/emails)
  const lookup = sanitizeTextForDB(String(emailOrUsername).trim().toLowerCase());

  // Find user by email or username
  const [user] = await dbRead
    .select({
      userId: users.userId,
      email: users.email,
      username: users.username,
      name: users.name,
      image: users.image,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(
      or(
        eq(users.email, lookup),
        eq(users.username, lookup)
      )
    )
    .limit(1);

  return user;
}

/**
 * Invalidates cached user ID for a specific email address
 * 
 * This function removes the cached user ID for the given email from
 * the LRU cache, forcing the next getUserIdByEmail call to query the
 * database again.
 * 
 * Use this when:
 * - User email is changed
 * - User account is deleted
 * - User data needs to be refreshed immediately
 * - Cache consistency is critical for an operation
 * 
 * Note: This only affects the getUserIdByEmail cache. The getUserForAuth
 * function is not cached and does not require invalidation.
 * 
 * @param email - Email address to invalidate from cache
 * 
 * @example
 * ```typescript
 * // After updating user email
 * await updateUserEmail(userId, 'newemail@example.com');
 * invalidateByEmail('oldemail@example.com');
 * ```
 * 
 * @example
 * ```typescript
 * // After deleting user account
 * await deleteUserAccount(userId);
 * invalidateByEmail('user@example.com');
 * ```
 */
export function invalidateByEmail(email: string) {
  userIdCache.delete(email);
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
 * Supports dual claim system:
 * - Regular claim: +5 credits (days 1-6), +20 credits (day 7) - available to all users
 * - VIP 2x claim: +10 credits (days 1-6), +40 credits (day 7) - only available to VIP users
 * - Total for VIP: +15 (days 1-6), +60 (day 7) when both buttons are clicked
 * 
 * @param userId - The user ID performing check-in
 * @param claimType - Type of claim: 'regular' or 'vip_2x'
 * @returns Promise resolving to check-in result with credits awarded
 * 
 * @example
 * ```typescript
 * // Regular claim
 * const result = await performDailyCheckIn('user123', 'regular');
 * console.log(`Awarded ${result.creditsAwarded} credits`);
 * 
 * // VIP 2x claim (only for VIP users)
 * const vipResult = await performDailyCheckIn('user123', 'vip_2x');
 * console.log(`Awarded ${vipResult.creditsAwarded} credits`);
 * ```
 */
export async function performDailyCheckIn(userId: string, claimType: 'regular' | 'vip_2x' = 'regular'): Promise<CheckinPostResponse> {
  const todayUTC = getCurrentUTCDay();
  
  try {
    return await dbWrite.transaction(async (tx) => {
      // Check if user has already checked in today with this claim type
      const existingCheckIn = await tx
        .select({ id: userCheckins.id, creditsClaimed: userCheckins.creditsClaimed })
        .from(userCheckins)
        .where(and(
          eq(userCheckins.userId, userId),
          eq(userCheckins.checkInDate, todayUTC)
        ))
        .limit(1);
      
      // For VIP 2x claim, check if user has VIP status
      if (claimType === 'vip_2x') {
        const user = await tx
          .select({ tier: users.tier, vipExpiresAt: users.vipExpiresAt })
          .from(users)
          .where(eq(users.userId, userId))
          .limit(1);
        
        if (user.length === 0 || user[0].tier !== 'vip') {
          console.warn(`[checkin] ⚠️ User ${userId} attempted VIP 2x claim without VIP status`);
          return {
            success: false,
            creditsAwarded: 0,
            currentStreak: 0,
            totalCreditsClaimed: 0,
            checkInDate: todayUTC,
            message: "VIP 2x claim is only available to VIP subscribers",
          } satisfies CheckinPostResponse;
        }
        
        // Check if VIP subscription has expired
        if (user[0].vipExpiresAt && new Date(user[0].vipExpiresAt) < new Date()) {
          console.warn(`[checkin] ⚠️ User ${userId} attempted VIP 2x claim with expired subscription`);
          return {
            success: false,
            creditsAwarded: 0,
            currentStreak: 0,
            totalCreditsClaimed: 0,
            checkInDate: todayUTC,
            message: "VIP subscription has expired",
          } satisfies CheckinPostResponse;
        }
      }

      // Compute consecutive streak up to yesterday (for awarding)
      const recent = await tx
        .select({ checkInDate: userCheckins.checkInDate })
        .from(userCheckins)
        .where(eq(userCheckins.userId, userId))
        .orderBy(desc(userCheckins.checkInDate))
        .limit(DAILY_CHECKIN_DAYS);

      const dateSet = new Set(recent.map(r => r.checkInDate));
      const utcToday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      let prevStreak = 0;
      for (let i = 1; i <= DAILY_CHECKIN_DAYS; i++) {
        const d = new Date(utcToday);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        if (dateSet.has(iso)) prevStreak++; else break;
      }

      const nextIndex = Math.min(prevStreak + 1, DAILY_CHECKIN_DAYS);
      // Base bonus: days 1-6 => DAILY_CHECKIN_BONUS each, day 7 => DAILY_CHECKIN_BIG_BONUS
      const baseCredits = nextIndex === DAILY_CHECKIN_DAYS ? DAILY_CHECKIN_BIG_BONUS : DAILY_CHECKIN_BONUS;
      
      // Apply multiplier based on claim type
      const multiplier = claimType === 'vip_2x' ? VIP_BENEFITS.checkInMultiplier : 1;
      const creditsToAward = baseCredits * multiplier;

      // Create or update check-in record
      if (existingCheckIn.length > 0) {
        // Add to existing check-in (dual claim system)
        await tx
          .update(userCheckins)
          .set({ 
            creditsClaimed: existingCheckIn[0].creditsClaimed + creditsToAward,
            updatedAt: new Date(),
          })
          .where(eq(userCheckins.id, existingCheckIn[0].id));
      } else {
        // Create new check-in record
        await tx.insert(userCheckins).values({
          userId,
          checkInDate: todayUTC,
          creditsClaimed: creditsToAward,
        });
      }

      // Import credits service to add credits (prevent circular deps)
      const { addCredits } = await import("./credits.js");

      // Add credits to user
      await addCredits(userId, creditsToAward, {
        context: claimType === 'vip_2x' ? "daily_checkin_vip_2x" : "daily_checkin",
        metadata: { checkInDate: todayUTC, creditsAwarded: creditsToAward, claimType },
      });

      // Compute new totals for response
      const totals = await tx
        .select({ totalCreditsClaimed: sql<number>`SUM(${userCheckins.creditsClaimed})` })
        .from(userCheckins)
        .where(eq(userCheckins.userId, userId))
        .limit(1);

      const totalCreditsClaimed = totals[0]?.totalCreditsClaimed || 0;

      console.log(`[checkin] 🎁 User ${userId} checked in (${claimType}) and claimed ${creditsToAward} credits!`);
      return {
        success: true,
        creditsAwarded: creditsToAward,
        currentStreak: prevStreak + 1,
        totalCreditsClaimed,
        checkInDate: todayUTC,
        message: `Successfully claimed ${creditsToAward} ${claimType === 'vip_2x' ? 'VIP 2x' : 'daily'} credits`,
      } satisfies CheckinPostResponse;
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
export async function getCheckInStatus(userId: string): Promise<CheckinStatusResponse> {
  try {
    // Check if user can check-in today
    const canCheckInStatus = await checkCanCheckIn(userId);

    // Get user tier for VIP status
    const userResult = await dbRead
      .select({ tier: users.tier })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    const isVip = userResult.length > 0 && userResult[0].tier === 'vip';

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

    // Compute current consecutive streak (include today if present)
    const dateSet = new Set(checkInHistory.map(c => c.checkInDate));
    const utcToday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    let streak = 0;
    for (let i = 0; i < DAILY_CHECKIN_DAYS; i++) {
      const d = new Date(utcToday);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (dateSet.has(iso)) streak++; else break;
    }

    // For nextClaimAmount, compute using streak excluding today (start from yesterday)
    let streakExcludingToday = 0;
    for (let i = 1; i <= DAILY_CHECKIN_DAYS; i++) {
      const d = new Date(utcToday);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (dateSet.has(iso)) streakExcludingToday++; else break;
    }

    let nextClaimAmount = 0;
    let regularClaimAmount = 0;
    let vipClaimAmount = 0;
    if (canCheckInStatus.canCheckIn) {
      const nextIndex = Math.min(streakExcludingToday + 1, DAILY_CHECKIN_DAYS);
      const baseAmount = nextIndex === DAILY_CHECKIN_DAYS ? DAILY_CHECKIN_BIG_BONUS : DAILY_CHECKIN_BONUS;
      nextClaimAmount = baseAmount;
      regularClaimAmount = baseAmount;
      vipClaimAmount = baseAmount * VIP_BENEFITS.checkInMultiplier;
    }

    return {
      canCheckIn: canCheckInStatus.canCheckIn,
      lastCheckInDate: canCheckInStatus.lastCheckInDate,
      totalCheckIns: totals[0]?.totalCheckIns || 0,
      totalCreditsClaimed: totals[0]?.totalCreditsClaimed || 0,
      currentStreak: streak,
      nextClaimAmount,
      recentCheckIns: checkInHistory,
      isVip,
      regularClaimAmount,
      vipClaimAmount: isVip ? vipClaimAmount : 0,
    } satisfies CheckinStatusResponse;
  } catch (error) {
    console.error("[user] ❌ Failed to get check-in status:", getErrorMessage(error));
    throw error;
  }
}

export async function cleanedUserData(userData: Partial<Pick<DBNewUser, 'name' | 'email' | 'username' | 'gender' | 'image'>>, options?: { res?: Response, createNew?: boolean }): Promise<Omit<DBNewUser, 'userId'> | null> {
  const { name: providedName, email, username: providedUsername, gender, image } = userData;
  const { res, createNew = true } = options ?? {};
  
  if (!email) {
    if (res) handleValidationError(res, 'Email is required');
    return null;
  }

  const name = providedName ?? convertEmailToName(email);
  const username = providedUsername ?? convertNameOrEmailToUsername(email, name);

  const cleanName = sanitizeTextForDB(String(name).trim());
  const cleanEmail = sanitizeTextForDB(String(email).trim().toLowerCase());
  const cleanUsername = sanitizeUsername(String(username));
  const cleanImage = image ? sanitizeTextForDB(String(image)) : undefined;
  const normalizedGender = normalizeGender(gender);

  if (createNew) {
    // TODO: detect duplicate username in db, auto append number suffix to `cleanUsername`
    // TODO: check for existing email (username should be already deduped)
    const existing = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(or(eq(users.email, cleanEmail), eq(users.username, cleanUsername)))
      .limit(1);
  
    if (existing && existing.length > 0) {
      if (res) res.status(409).json({ error: 'Email or username already exists' });
      return null;
    }
  }

  // TODO: should be valid by `sanitizeUsername`, should remove this?
  const usernameValidation = validateUsername(cleanUsername);
  if (!usernameValidation.valid) {
    if (res) res.status(422).json({ error: 'Invalid username', details: usernameValidation.errors });
    return null;
  }
  
  // Prepare user data for upsert (exclude timestamp fields from frontend)
  return {
    name: cleanName,
    email: cleanEmail,
    username: cleanUsername,
    gender: normalizedGender,
    ...(cleanImage ? {image: cleanImage} : {}),
  };
}