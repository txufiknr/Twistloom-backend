/**
 * @overview Redis Configuration
 * 
 * Provides Redis client configuration for caching.
 * Uses Upstash Redis for serverless-compatible HTTP-based Redis.
 * 
 * Features:
 * - Singleton Redis client instance
 * - Automatic connection management
 * - Error handling and graceful degradation
 * - Environment-based configuration
 */

import { Redis } from '@upstash/redis';

/**
 * Redis client singleton instance
 * Lazily initialized on first access
 */
let redisClient: Redis | null = null;

/**
 * Gets or creates the Redis client instance
 * 
 * @returns Redis client instance or null if not configured
 */
export function getRedisClient(): Redis | null {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env['REDIS_URL'];
  const redisRestUrl = process.env['UPSTASH_REDIS_REST_URL'];
  const redisRestToken = process.env['UPSTASH_REDIS_REST_TOKEN'];

  // Check if Redis is configured
  if (!redisUrl && (!redisRestUrl || !redisRestToken)) {
    console.warn('⚠️  Redis not configured. Caching will be disabled.');
    return null;
  }

  try {
    // Use Upstash Redis REST API (serverless-friendly)
    if (redisRestUrl && redisRestToken) {
      redisClient = new Redis({
        url: redisRestUrl,
        token: redisRestToken,
      });
      console.log('✅ Upstash Redis client initialized (REST API)');
    } 
    // Fallback to direct Redis URL with token
    else if (redisUrl) {
      redisClient = new Redis({
        url: redisUrl,
        token: process.env['REDIS_TOKEN'] || '',
      });
      console.log('✅ Redis client initialized (direct connection)');
    }

    return redisClient;
  } catch (error) {
    console.error('❌ Failed to initialize Redis client:', error);
    return null;
  }
}

/**
 * Cache TTL configuration (in seconds)
 */
export const CACHE_TTL = {
  /** Per-user book list: 5 minutes */
  PER_USER_BOOKS: 5 * 60,
  /** Explore page 1: 2 minutes (rapidly changing) */
  EXPLORE_PAGE_1: 2 * 60,
  /** User profile: 2 minutes */
  USER_PROFILE: 2 * 60,
  /** Default: 1 minute */
  DEFAULT: 60,
} as const;

/**
 * Cache key patterns
 */
export const CACHE_KEYS = {
  /** Per-user book list: books:user:{userId}:page:{page} */
  USER_BOOKS: (userId: string, page: number) => `books:user:${userId}:page:${page}`,
  /** Invalidate all user books: books:user:{userId}:* */
  USER_BOOKS_PATTERN: (userId: string) => `books:user:${userId}:*`,
  /** Explore page 1: books:explore:page:1 */
  EXPLORE_PAGE_1: 'books:explore:page:1',
  /** User profile: user:profile:{userId} */
  USER_PROFILE: (userId: string) => `user:profile:${userId}`,
} as const;

/**
 * Checks if Redis is available and configured
 * 
 * @returns true if Redis is available, false otherwise
 */
export function isRedisAvailable(): boolean {
  return getRedisClient() !== null;
}
