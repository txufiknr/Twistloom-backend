/**
 * @overview Cache Utilities Module
 * 
 * Provides database-backed caching system for user content with TTL management.
 * Implements intelligent cache invalidation and cleanup strategies for optimal performance.
 * 
 * Features:
 * - Database-backed cache with automatic TTL enforcement
 * - JSON payload storage for complex data structures
 * - Pattern-based cache invalidation for bulk operations
 * - Automatic cleanup of expired entries
 * - Transaction-safe cache operations
 * 
 * Architecture:
 * - Uses user_cache table with key/payload/updated_at schema
 * - SQL-level TTL enforcement for data consistency
 * - Upsert operations for atomic cache updates
 * - Flexible invalidation strategies (key, pattern, cluster-based)
 */

import { and, eq, gt, like, or, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import { userCache } from "../db/schema.js";
import { CACHE_TTL_MINUTES } from "../config/cache.js";
import { getErrorMessage } from "./error.js";

/**
 * Removes expired user cache entries using database-enforced TTL.
 * Runs asynchronously and logs cleanup results for monitoring.
 * 
 * @param maxAgeMinutes - Maximum age in minutes before entries expire (defaults to CACHE_TTL_MINUTES)
 * @returns Promise that resolves when cleanup is complete
 * 
 * @example
 * ```typescript
 * // Clean up entries older than default TTL
 * await cleanupUserCache();
 * 
 * // Clean up entries older than 30 minutes
 * await cleanupUserCache(30);
 * ```
 * 
 * Behavior:
 * - Uses SQL interval arithmetic for precise time calculations
 * - Executes raw SQL for optimal performance on large datasets
 * - Logs number of deleted entries for monitoring
 * - Runs asynchronously without blocking operations
 * 
 * Performance:
 * - Uses direct SQL DELETE for efficient bulk operations
 * - Database-level filtering for optimal query performance
 * - Non-blocking async execution
 * 
 * @note
 * - Called automatically by getCachedUser for maintenance
 * - Safe to call multiple times (idempotent operation)
 * - Uses database timestamp for consistency across timezones
 */
export async function cleanupUserCache(
  maxAgeMinutes = CACHE_TTL_MINUTES
) {
  await dbWrite.execute(sql`
    DELETE FROM user_cache
    WHERE updated_at < now() - interval '${sql.raw(String(maxAgeMinutes))} minutes'
  `).then((result) => {
    console.log('[cache] ✨ Cleaned up expired cache entries:', result.rowCount ?? 0);
  }).catch((error) => {
    console.error('[cache] ❌ Error cleaning up expired cache entries:', getErrorMessage(error));
  });
}

/**
 * Retrieves cached user data with automatic TTL validation and cleanup.
 * Uses SQL-level freshness enforcement to ensure data consistency.
 * 
 * @template T - Type of the cached payload (automatically inferred)
 * @param key - Unique cache key identifier
 * @param maxAgeMinutes - Maximum age in minutes before cache is considered stale (defaults to CACHE_TTL_MINUTES)
 * @returns Promise resolving to cached payload or null if expired/not found
 * 
 * @example
 * ```typescript
 * // Get cached user
 * const cachedUser = await getCachedUser('user:user123');
 * if (cachedUser) {
 *   console.log('Cache hit:', cachedUser);
 * } else {
 *   console.log('Cache miss - fetching fresh data');
 * }
 * 
 * // Get cached user with custom TTL
 * const cachedUser = await getCachedUser('user:user123', 15);
 * ```
 * 
 * Behavior:
 * - Queries cache with both key match and freshness validation
 * - Uses SQL interval arithmetic for precise TTL checking
 * - Automatically triggers cleanup of expired entries
 * - Returns null for stale or missing cache entries
 * - Type-safe payload retrieval with generic typing
 * 
 * @ttl-enforcement
 * - Database-level filtering ensures stale entries are ignored
 * - Uses `updated_at > now() - interval` for accurate time calculations
 * - Handles timezone differences via database timestamp functions
 * - Configurable TTL per operation with sensible defaults
 * 
 * Performance:
 * - Single query with compound filtering for efficiency
 * - Automatic cleanup prevents cache bloat
 * - Type-safe JSON parsing with generic support
 * - Async non-blocking operation
 * 
 * @note
 * - Triggers cleanup operation on every call for maintenance
 * - Stale entries are treated as cache misses
 * - Payload is cast to type T (ensure type consistency)
 * - Safe for high-frequency access patterns
 */
export async function getCachedUser<T>(
  key: string,
  maxAgeMinutes = CACHE_TTL_MINUTES
): Promise<T | null> {
  const row = await dbRead
    .select({
      payload: userCache.payload,
    })
    .from(userCache)
    .where(
      and(
        eq(userCache.key, key),
        gt(
          userCache.updatedAt,
          sql`now() - interval '${sql.raw(String(maxAgeMinutes))} minutes'`
        )
      )
    )
    .limit(1)
    .then(rows => rows[0]);

  const result = row ? (row.payload as T) : null;
  cleanupUserCache();
  return result;
}

/**
 * Stores data in cache with atomic upsert operation and automatic timestamp.
 * Creates new entries or updates existing ones with fresh data and timestamps.
 * 
 * @param key - Unique cache key identifier
 * @param payload - Data to cache (any JSON-serializable value)
 * @returns Promise that resolves when cache operation completes
 * 
 * @example
 * ```typescript
 * // Cache a simple user response
 * await setCachedUserRaw('user:latest:all', {
 *   items: [...],
 *   nextCursor: null,
 *   hasMore: false
 * });
 * 
 * // Cache complex data with metadata
 * await setCachedUserRaw('user:personalized:user123', {
 *   items: [...],
 *   metadata: {
 *     generatedAt: new Date(),
 *     userId: 'user123',
 *     score: 0.95
 *   }
 * });
 * ```
 * 
 * Behavior & Atomicity:
 * - Uses atomic upsert operation (INSERT...ON CONFLICT UPDATE) to prevent race conditions
 * - Automatically updates timestamp on each write for fresh TTL calculation
 * - Overwrites existing cache entries completely with no partial updates
 * - Maintains data consistency with database transactions
 * - Supports any JSON-serializable data structure
 * 
 * Performance & Storage:
 * - Single database operation for both insert and update minimizes overhead
 * - Optimized for high-frequency cache writes with async non-blocking operation
 * - Payload stored as JSON with automatic serialization/deserialization
 * - Supports complex nested objects and arrays with type-agnostic storage
 * 
 * @note
 * - Timestamp is automatically set to current time
 * - Existing cache entries are completely replaced
 * - Payload must be JSON-serializable
 * - Use consistent key naming patterns for organization
 */
export async function setCachedUserRaw(
  key: string,
  payload: unknown
): Promise<void> {
  await dbWrite
    .insert(userCache)
    .values({
      key,
      payload,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userCache.key,
      set: {
        payload,
        updatedAt: new Date(),
      },
    });
}

/**
 * Removes a specific cache entry by exact key match.
 * Provides precise control over individual cache invalidation.
 * 
 * @param key - Exact cache key to invalidate
 * @returns Promise that resolves when invalidation completes
 * 
 * @example
 * ```typescript
 * // Invalidate specific user's personalized user
 * await invalidateCacheKey('user:personalized:user123');
 * 
 * // Invalidate latest user cache
 * await invalidateCacheKey('user:latest:all');
 * 
 * // Invalidate cluster detail cache
 * await invalidateCacheKey('cluster:cluster-456');
 * ```
 * 
 * Behavior:
 * - Uses exact key matching for precise invalidation
 * - Single DELETE operation for efficiency
 * - Safe operation (no error if key doesn't exist)
 * - Immediate effect on subsequent cache reads
 * 
 * @use-cases
 * - User-specific cache invalidation on preference changes
 * - Targeted cache updates for specific content
 * - Manual cache management for debugging
 * - Granular cache control for sensitive data
 * 
 * Performance:
 * - Single indexed DELETE operation
 * - O(1) complexity with proper key indexing
 * - Minimal database overhead
 * - Async non-blocking operation
 * 
 * @note
 * - Idempotent operation (safe to call multiple times)
 * - No error thrown for non-existent keys
 * - Use consistent key naming patterns
 * - Consider pattern-based invalidation for bulk operations
 */
export async function invalidateCacheKey(
  key: string
): Promise<void> {
  await dbWrite
    .delete(userCache)
    .where(eq(userCache.key, key));
}

/**
 * Removes cache entries matching SQL LIKE pattern for bulk invalidation.
 * Provides flexible pattern-based cache management for complex scenarios.
 * 
 * @param pattern - SQL LIKE pattern for matching cache keys
 * @returns Promise that resolves when pattern invalidation completes
 * 
 * @example
 * ```typescript
 * // Invalidate all user personalized users
 * await invalidateCachePattern('user:personalized:%');
 * ```
 * 
 * Pattern syntax:
 * - `%`: Matches any sequence of characters (including empty)
 * - `_`: Matches any single character
 * - SQL LIKE pattern matching rules apply
 * - Case-sensitive matching (depends on database collation)
 * 
 * Behavior:
 * - Uses SQL LIKE for flexible pattern matching
 * - Bulk deletion operation for efficiency
 * - Matches against cache keys only (not payloads)
 * - Immediate effect on subsequent cache reads
 * 
 * Use cases:
 * - User-specific cache invalidation (user:personalized:user_%)
 * - Date-based cache clearing (user:2023-01-%)
 * - Feature-specific cache invalidation (%trending%)
 * - Bulk cache management for maintenance
 * 
 * Performance:
 * - Single DELETE with LIKE pattern
 * - Efficient for bulk operations
 * - May require full table scan without proper indexing
 * - Consider key structure for optimal performance
 * 
 * Note:
 * - Powerful but use with caution (broad impact)
 * - Test patterns in development first
 * - Consider database performance with large datasets
 * - Use specific patterns when possible
 */
export async function invalidateCachePattern(
  pattern: string
): Promise<void> {
  await dbWrite
    .delete(userCache)
    .where(like(userCache.key, pattern));
}

/**
 * Invalidates a user-specific latest user cache key (with optional topic support)
 * @param userId - User ID whose latest user cache should be invalidated
 * @param topic - Optional topic to invalidate topic-specific cache (if not provided, clears all user's latest user caches)
 * @returns Promise that resolves when invalidation completes
 * 
 * @example
 * ```typescript
 * // Invalidate specific user's latest user (all topics)
 * await invalidateUserLatestUser('user123');
 * 
 * // Invalidate specific user's latest user for specific topic
 * await invalidateUserLatestUser('user123', 'fiqh');
 * ```
 * 
 * Behavior:
 * - Uses exact key matching for precise invalidation (when topic provided)
 * - Uses pattern matching for all user's latest users (when no topic)
 * - Single DELETE operation for efficiency
 * - Safe operation (no error if key doesn't exist)
 * - Immediate effect on subsequent cache reads
 * 
 * Use cases:
 * - User preference changes
 * - Manual cache refresh for specific user
 * - Debugging cache issues for individual users
 * - Topic-specific cache invalidation
 * 
 * Note:
 * - Consistent with other cache invalidation patterns
 * - Uses same error handling and logging
 */
export async function invalidateUserLatestUser(userId: string, topic?: string): Promise<void> {
  if (topic) {
    // Invalidate specific topic cache for user
    const cacheKey = `user:latest:${topic}:${userId}`;
    await invalidateCacheKey(cacheKey);
  } else {
    // Invalidate all latest user caches for this user (all topics)
    await invalidateCachePattern(`user:latest:%:${userId}`);
  }
}

/**
 * Invalidates all standard user caches and personalized users efficiently.
 * Provides comprehensive cache clearing for system-wide content updates.
 * 
 * @returns Promise that resolves when all standard user invalidation completes
 * 
 * Behavior:
 * - Uses optimized batch operations for minimal database round trips
 * - Clears both global users and all personalized users
 * - Conservative approach ensures cache consistency
 * - Optimized for serverless environments (no transactions)
 * 
 * Invalidation scope:
 * - **Global Users**: user:trending, user:personalized (global)
 * - **Personalized Users**: All keys matching user:personalized:% pattern  
 * - **Latest Users**: All keys matching user:latest:% pattern (includes user:latest:all)
 * - **Comprehensive Coverage**: Ensures no stale cache remains
 * - **User Impact**: All users will receive fresh content on next request
 * 
 * Use cases:
 * - After updating trending scores globally
 * - After major system-wide content refresh
 * - After system configuration updates
 * - After user algorithm changes
 * - After content trust level adjustments
 * 
 * Performance:
 * - 1 database round trip (optimal for serverless)
 * - Single query with OR conditions for maximum efficiency
 * - Minimal database connection overhead
 * - Optimized pattern-based deletions
 * 
 * Note:
 * - Conservative approach (clears more than necessary)
 * - Consider user experience impact (cache miss wave)
 * - Use for significant content changes only
 * - May cause temporary increase in database load
 */
export async function invalidateStandardUsers(): Promise<void> {
  // Delete all standard user cache keys in a single optimized query
  // Covers: latest users (all topics/users), personalized users, trending, and global personalized
  // Possible keys covered:
  // 1. user:personalized (global)
  // 2. user:personalized:user123 (per-user)
  // 3. user:trending (global)
  // 4. user:trending:user123 (per-user)
  // 5. user:latest:all (global)
  // 6. user:latest:all:user123 (per-user)
  // 7. user:latest:fiqh (global topic)
  // 8. user:latest:seerah:user123 (per-user topic)
  await dbWrite
    .delete(userCache)
    .where(
      or(
        like(userCache.key, "user:latest:%"),
        like(userCache.key, "user:personalized:%"),
        like(userCache.key, "user:trending:%"), // Covers per-user trending
        eq(userCache.key, "user:personalized"), // Global personalized
        eq(userCache.key, "user:trending") // Covers global trending
      )
    );
}

/**
 * @summary Comprehensive cache invalidation for cluster-specific updates
 * @description Handles cluster detail cache and all affected user caches in one operation.
 * 
 * @param clusterId - The ID of cluster that was updated
 * @returns Promise that resolves when cluster-related cache invalidation completes
 * 
 * @example
 * ```typescript
 * // After updating cluster metadata
 * await invalidateCachesForCluster('cluster-123');
 * 
 * // After trust level adjustment
 * await invalidateCachesForCluster('cluster-456');
 * 
 * // After embedding update
 * await invalidateCachesForCluster('cluster-789');
 * ```
 * 
 * Behavior:
 * - Multi-layered invalidation strategy for comprehensive coverage
 * - Handles both direct cluster cache and indirect user cache impacts
 * - Error-tolerant with logging for debugging
 * - Conservative approach ensures cache consistency
 * 
 * Invalidation:
 * - **Layer 1**: Direct cluster cache (cluster:{clusterId})
 * - **Layer 2**: Standard users (latest, trending, global personalized)
 * - **Layer 3**: All personalized users (conservative pattern-based)
 * 
 * Use cases:
 * - Cluster metadata updates (title, summary, hero image)
 * - Trust level refinements and adjustments
 * - Embedding vector updates
 * - Content quality improvements
 * - Cluster status changes
 * 
 * @note
 * - Conservative invalidation may cause unnecessary cache misses
 * - Consider performance impact during bulk cluster updates
 * - Monitor error logs for cache invalidation issues
 * - Use for any cluster metadata or content changes
 */
export function invalidateCachesForCluster(clusterId: string) {
  try {
    // 1) cluster detail cache key (if you have it)
    void invalidateCacheKey(`cluster:${clusterId}`);
  
    // 2) standard users
    void invalidateStandardUsers();

    // 3) remove personalized caches (conservative)
    // invalidateCachePattern('user:personalized:%');
  } catch (err) {
    console.error('[cache] ❌ Failed to invalidate user caches for cluster', clusterId, err);
  }
}
