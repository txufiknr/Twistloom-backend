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
 * - OAuth user creation
 */

import { users, userAuth } from '../db/schema.js';
import { sql, eq } from 'drizzle-orm';
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
