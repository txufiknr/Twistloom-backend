/**
 * @overview User Controller Service
 * 
 * Provides enriched user profile queries with engagement metrics.
 * Centralizes user data selection logic with aggregated counts.
 * 
 * Features:
 * - User profile fields with engagement counts
 * - Optimized subqueries for book/read/like/favorite counts
 * - Reusable select builder for consistency across routes
 * - Performance considerations with indexed columns
 * - OAuth user creation and guest data migration
 */

import { users, books, userSessions, userPageProgress, userAuth, userActivityLogs } from '../db/schema.js';
import { sql, eq, and } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { generateId } from '../utils/uuid.js';

/**
 * Returns enriched user select object with engagement metrics
 * 
 * Provides user profile fields with aggregated counts for books, reads, likes, and favorites.
 * Uses correlated subqueries for performance with proper indexes.
 * 
 * Performance Analysis:
 * - books table: indexed on userId for fast COUNT
 * - userSessions table: indexed on userId for fast COUNT
 * - userLikes table: indexed on userId for fast COUNT
 * - userFavorites table: indexed on userId for fast COUNT
 * - Correlated subqueries are optimal for single-row user profile queries
 * - Alternative CTE approach would be overkill for single-user lookups
 * 
 * @returns Select object with user fields and engagement counts
 * 
 * @example
 * ```typescript
 * const result = await dbRead
 *   .select(getEnrichedUserSelect())
 *   .from(users)
 *   .where(eq(users.userId, userId))
 *   .limit(1);
 * ```
 */
export function getEnrichedUserSelect() {
  return {
    // Basic user fields
    userId: users.userId,
    name: users.name,
    username: users.username,
    email: users.email,
    bio: users.bio,
    gender: users.gender,
    image: users.image,
    credits: users.credits,
    isGuest: users.isGuest,
    lastActive: users.lastActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    // Engagement metrics using SQL subqueries (indexed by userId)
    booksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM books 
      WHERE user_id = users.user_id
    ), 0)`,
    readsCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_sessions 
      WHERE user_id = users.user_id
    ), 0)`,
    likedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_likes 
      WHERE user_id = users.user_id AND target_type = 'book'
    ), 0)`,
    savedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_favorites 
      WHERE user_id = users.user_id
    ), 0)`,
    followersCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_follows 
      WHERE following_id = users.user_id
    ), 0)`,
    likesReceived: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM books 
      INNER JOIN user_likes ON books.id = user_likes.target_id
      WHERE books.user_id = users.user_id AND user_likes.target_type = 'book'
    ), 0)`,
  };
}

// ---------------------------------------------------------------------------
// OAuth User Creation
// ---------------------------------------------------------------------------

/**
 * Creates or updates a user from OAuth provider data (e.g., Google)
 * 
 * This function handles first-time OAuth logins by creating a user record
 * in the database. If the user already exists (by email), it updates their
 * profile data from the OAuth provider.
 * 
 * @param email - User email from OAuth provider
 * @param name - User display name from OAuth provider (optional)
 * @param image - User profile image URL from OAuth provider (optional)
 * @returns The user ID (existing or newly created)
 * 
 * @example
 * ```typescript
 * // First-time Google login
 * const userId = await createOrUpdateOAuthUser('user@example.com', 'John Doe', 'https://google.com/photo.jpg');
 * 
 * // Returning user with updated profile
 * const userId = await createOrUpdateOAuthUser('user@example.com', 'John Smith', 'https://google.com/new-photo.jpg');
 * ```
 */
export async function createOrUpdateOAuthUser(
  email: string,
  name?: string,
  image?: string
): Promise<string> {
  // Check if user already exists by email
  const existing = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    // User exists - update profile data from OAuth provider
    const userId = existing[0].userId;
    await dbWrite
      .update(users)
      .set({
        name: name || users.name,
        image: image || users.image,
        lastActive: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.userId, userId));
    
    console.log(`[user-controller] ✅ Updated existing OAuth user: ${userId}`);
    return userId;
  }

  // New user - create account from OAuth data
  const newUser = await dbWrite.transaction(async (tx) => {
    // Create user record
    const userRecord = await tx.insert(users).values({
      userId: generateId(),
      email,
      name: name || null,
      image: image || null,
      isGuest: false,
      isNewUser: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActive: new Date(),
    }).returning();

    // Create user_auth record
    await tx.insert(userAuth).values({
      userId: userRecord[0].userId,
    });

    return userRecord;
  });

  console.log(`[user-controller] ✅ Created new OAuth user: ${newUser[0].userId}`);
  return newUser[0].userId;
}

// ---------------------------------------------------------------------------
// Guest Data Migration
// ---------------------------------------------------------------------------

/**
 * Migrates data from a guest user to an authenticated user
 * 
 * Transfers all books, sessions, page progress, and other data from guest to authenticated user,
 * then deletes the guest user from the database. This is called when a guest user
 * logs in via OAuth or email/password.
 * 
 * This ensures no orphaned data remains in the database and no data is lost during migration.
 * All foreign key relationships are properly handled before deleting the guest user.
 * 
 * @param guestId - The guest user ID to migrate from
 * @param authenticatedUserId - The authenticated user ID to migrate to
 * 
 * @example
 * ```typescript
 * // Migrate guest data after Google login
 * await migrateGuestToAuthUser('guest-uuid-123', 'auth-user-uuid-456');
 * ```
 */
export async function migrateGuestToAuthUser(
  guestId: string,
  authenticatedUserId: string
): Promise<void> {
  // Verify guest user exists before migration
  const guestUser = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.userId, guestId), eq(users.isGuest, true)))
    .limit(1);

  if (!guestUser.length) {
    console.warn(`[user-controller] ⚠️ Guest user ${guestId} not found, skipping migration`);
    return;
  }

  console.log(`[user-controller] 🔄 Migrating guest ${guestId} to user ${authenticatedUserId}`);

  // Migrate all user data from guest to authenticated user
  // Order matters: migrate dependent data before deleting the user
  // Tables that guests can have data in:
  // - books (guests can create books)
  // - userSessions (guests can have reading sessions)
  // - userPageProgress (guests can have page progress)
  // - userActivityLogs (guests can have activity logs)
  await dbWrite.update(books).set({ userId: authenticatedUserId }).where(eq(books.userId, guestId));
  await dbWrite.update(userSessions).set({ userId: authenticatedUserId }).where(eq(userSessions.userId, guestId));
  await dbWrite.update(userPageProgress).set({ userId: authenticatedUserId }).where(eq(userPageProgress.userId, guestId));
  await dbWrite.update(userActivityLogs).set({ userId: authenticatedUserId }).where(eq(userActivityLogs.userId, guestId));

  // Delete guest user from database
  // This is safe now because all dependent data has been migrated
  // Tables that guests don't have data in (disabled for guests):
  // - userAuth (only for authenticated users)
  // - userLikes (disabled for guests)
  // - userFavorites (disabled for guests)
  // - userComments (disabled for guests)
  // - userFollows (disabled for guests)
  // - transactions (guests can't make payments)
  // - userNotifications (disabled for guests)
  // - user_checkins (disabled for guests)
  await dbWrite.delete(users).where(eq(users.userId, guestId));

  console.log(`[user-controller] ✅ Migration complete: guest ${guestId} deleted`);
}
