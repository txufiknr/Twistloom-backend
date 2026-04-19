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
 */

import { users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

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
    gender: users.gender,
    image: users.image,
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
  };
}
