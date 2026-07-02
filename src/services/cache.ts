/**
 * @overview Cache Service
 * 
 * Provides caching operations with Redis and graceful fallback to database.
 * Handles cache invalidation, TTL management, and error recovery.
 * 
 * Features:
 * - Automatic cache get/set/del operations
 * - Graceful degradation when Redis is unavailable
 * - TTL-based expiration
 * - Pattern-based cache invalidation
 * - Error logging and monitoring
 */

import { REDIS_CACHE_TTL, REDIS_CACHE_KEYS } from '../config/redis.js';
import { getRedisClient } from '../utils/redis.js';

// Re-export for convenience
export const CACHE_TTL = REDIS_CACHE_TTL;
export const CACHE_KEYS = REDIS_CACHE_KEYS;

/**
 * Cache result type
 */
export interface CacheResult<T> {
  /** Cached data if found, null otherwise */
  data: T | null;
  /** Whether the data was retrieved from cache */
  hit: boolean;
}

/**
 * Gets data from cache
 * 
 * @param key - Cache key
 * @returns Cached data or null if not found/Redis unavailable
 */
export async function getFromCache<T>(key: string): Promise<CacheResult<T>> {
  const redis = getRedisClient();
  
  if (!redis) {
    return { data: null, hit: false };
  }

  try {
    const cached = await redis.get<T>(key);
    if (cached) {
      return { data: cached, hit: true };
    }
    return { data: null, hit: false };
  } catch (error) {
    console.error(`[cache] ❌ Get failed for key ${key}:`, error);
    return { data: null, hit: false };
  }
}

/**
 * Sets data in cache with TTL
 * 
 * @param key - Cache key
 * @param value - Data to cache
 * @param ttlSeconds - Time to live in seconds (defaults to CACHE_TTL.DEFAULT)
 * @returns true if successful, false otherwise
 */
export async function setCache<T>(key: string, value: T, ttlSeconds: number = CACHE_TTL.DEFAULT): Promise<boolean> {
  const redis = getRedisClient();
  
  if (!redis) {
    return false;
  }

  try {
    await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
    return true;
  } catch (error) {
    console.error(`[cache] ❌ Set failed for key ${key}:`, error);
    return false;
  }
}

/**
 * Deletes data from cache
 * 
 * @param key - Cache key
 * @returns true if successful, false otherwise
 */
export async function deleteCache(key: string): Promise<boolean> {
  const redis = getRedisClient();
  
  if (!redis) {
    return false;
  }

  try {
    await redis.del(key);
    return true;
  } catch (error) {
    console.error(`[cache] ❌ Delete failed for key ${key}:`, error);
    return false;
  }
}

/**
 * Deletes multiple cache keys matching a pattern
 * 
 * @param pattern - Cache key pattern (e.g., "books:user:*")
 * @returns Number of keys deleted
 */
export async function deleteCachePattern(pattern: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;

  try {
    // Upstash Redis doesn't support KEYS command in production
    // Use scan instead for pattern matching
    let cursor = 0;
    let deletedCount = 0;
    
    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(result[0]);
      const keys = result[1];
      
      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== 0);
    
    return deletedCount;
  } catch (error) {
    console.error(`[cache] ❌ Delete failed for pattern ${pattern}:`, error);
    return 0;
  }
}

/**
 * Cache wrapper function with automatic fallback
 * 
 * Automatically tries to get from cache first, and if miss, executes the fetch function
 * and stores the result in cache.
 * 
 * @param key - Cache key
 * @param fetchFn - Function to fetch data if cache miss
 * @param ttlSeconds - Time to live in seconds
 * @returns Data from cache or fetch function
 */
export async function withCache<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number = CACHE_TTL.DEFAULT
): Promise<T> {
  // Try to get from cache
  const cached = await getFromCache<T>(key);
  if (cached.hit && cached.data !== null) return cached.data;

  // Cache miss - fetch from source
  const data = await fetchFn();

  // Store in cache
  await setCache(key, data, ttlSeconds);

  return data;
}

/**
 * Invalidates user-specific book caches
 * 
 * @param userId - User ID
 * @returns Number of cache keys deleted
 */
export async function invalidateUserBooksCache(userId: string): Promise<number> {
  const pattern = CACHE_KEYS.USER_BOOKS_PATTERN(userId);
  return deleteCachePattern(pattern);
}

/**
 * Options for conditional explore cache invalidation.
 */
export interface InvalidateExploreOptions {
  /**
   * Current book to check — invalidates only if visibility='public' AND status='active'.
   */
  book?: { status: string; visibility: string };
  /**
   * Previous book state (for before/after comparison).
   * When paired with `after`, invalidates if either was or is public+active.
   */
  before?: { status: string; visibility: string };
  /**
   * New book state (for before/after comparison).
   * When paired with `before`, invalidates if either was or is public+active.
   */
  after?: { status: string; visibility: string };
}

/**
 * Invalidates explore page 1 cache (both default and trending).
 *
 * When a `book` is provided, only invalidates if the book is publicly visible
 * (visibility='public' AND status='active'). When `before` and `after` are
 * provided, invalidates if either state is public+active. When no options are
 * given, always invalidates.
 *
 * @param options - Optional book state to conditionally invalidate
 * @returns true if successful, false otherwise
 */
export async function invalidateExploreCache(options?: InvalidateExploreOptions): Promise<boolean> {
  if (options) {
    const { book, before, after } = options;
    const isPublicActive = (b: { status: string; visibility: string }) => b.visibility === 'public' && b.status === 'active';

    if (book) {
      if (!isPublicActive(book)) return true; // skip — book not in explore
    } else if (before && after) {
      if (!isPublicActive(before) && !isPublicActive(after)) return true; // skip — neither was in explore
    }
    // else: invalidate (preserves always-invalidate behavior for unknown option shapes)
  }

  // Invalidate both explore caches since trending scores affect ranking
  await deleteCache(CACHE_KEYS.EXPLORE_PAGE_1);
  await deleteCache(CACHE_KEYS.EXPLORE_PAGE_1_TRENDING);
  return true;
}

/**
 * Invalidates user profile cache
 * 
 * @param userId - User ID
 * @returns true if successful, false otherwise
 */
export async function invalidateUserProfileCache(userId: string): Promise<boolean> {
  const key = CACHE_KEYS.USER_PROFILE(userId);
  return deleteCache(key);
}


