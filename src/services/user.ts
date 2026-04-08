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
import { users } from "../db/schema.js";
import { eq, and, gt } from "drizzle-orm";
import { debounceAsync } from "../utils/debounce.js";
import { getErrorMessage } from "../utils/error.js";

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
    console.error("[user] Failed to get active users:", getErrorMessage(error));
    return [];
  }
}
