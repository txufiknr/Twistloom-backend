/**
 * Redis Helper Functions
 * 
 * Provides reusable Redis-based utilities for rate limiting, idempotency,
 * and caching operations across the application.
 * 
 * @overview
 * - Rate limiting with sliding window
 * - Idempotency key management
 * - Redis client wrapper with null safety
 */

import { Redis } from '@upstash/redis';
import type { RateLimitConfig, RateLimitResult } from '../types/redis.js';
import { getErrorMessage } from './error.js';

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
    console.warn('⚠️ Redis not configured. Caching will be disabled.');
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
    console.error('❌ Failed to initialize Redis client:', getErrorMessage(error));
    return null;
  }
}

/**
 * Checks if Redis is available and configured
 * 
 * @returns true if Redis is available, false otherwise
 */
export function isRedisAvailable(): boolean {
  return getRedisClient() !== null;
}

/**
 * Checks rate limit using Redis
 * 
 * @param key - Unique identifier for the rate limit (e.g., "checkout-session-user123")
 * @param config - Rate limit configuration
 * @returns Rate limit result
 * 
 * @example
 * ```typescript
 * const result = await checkRateLimit('checkout-session-user123', {
 *   maxRequests: 1,
 *   windowSeconds: 10
 * });
 * if (!result.allowed) {
 *   return res.status(429).json({ error: 'Too many requests' });
 * }
 * ```
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  if (!redis) {
    // If Redis is not available, allow request (fail open)
    return { allowed: true, requestCount: 1 };
  }

  const { maxRequests, windowSeconds } = config;
  
  // Use atomic INCR with EXPIRE to prevent race condition
  // If key doesn't exist, INCR creates it with value 1 and sets expiration
  // If key exists, only INCR is executed
  const requestCount = await redis.incr(key);
  
  // Only set expiration if this is the first request (key was just created)
  // This prevents the race condition where INCR succeeds but EXPIRE fails
  if (requestCount === 1) {
    await redis.expire(key, windowSeconds);
  }

  const allowed = requestCount <= maxRequests;

  return {
    allowed,
    requestCount,
    resetAfter: allowed ? windowSeconds : 0,
  };
}

/**
 * Idempotency configuration
 */
export interface IdempotencyConfig {
  /** Unique idempotency key */
  key: string;
  /** Key prefix for Redis (default: "idempotency") */
  prefix?: string;
  /** TTL in seconds (default: 300 = 5 minutes) */
  ttl?: number;
}

/**
 * Idempotency check result
 */
export interface IdempotencyCheckResult<T = unknown> {
  /** Whether this is a duplicate request */
  isDuplicate: boolean;
  /** Cached result if duplicate */
  cachedResult: T | null;
}

/**
 * Sets a processing flag for idempotency to prevent race conditions
 * 
 * @param config - Idempotency configuration
 * @returns Promise resolving to processing result with cleanup function
 * 
 * @example
 * ```typescript
 * const processing = await setIdempotencyProcessing({
 *   key: 'story-user123-book456-gen1',
 *   prefix: 'credit-consume',
 *   ttl: 300
 * });
 * if (!processing.set) {
 *   // Another request is processing, return conflict
 * }
 * try {
 *   // Do work
 * } finally {
 *   // Always clean up processing flag
 *   await processing.cleanup();
 * }
 * ```
 */
export async function setIdempotencyProcessing(
  config: IdempotencyConfig
): Promise<{ set: boolean; cleanup: () => Promise<void> }> {
  const redis = getRedisClient();
  if (!redis) {
    // If Redis not available, allow processing with no-op cleanup
    return { 
      set: true, 
      cleanup: async () => {} 
    };
  }

  const { key, prefix = "idempotency", ttl = 300 } = config;
  const processingKey = `${prefix}-processing-${key}`;
  
  // Try to set processing flag with expiration
  const result = await redis.set(processingKey, '1', { 
    ex: ttl, 
    nx: true // Only set if key doesn't exist
  });
  
  const set = result === 'OK';
  
  // Always provide cleanup function with error handling
  const cleanup = async () => {
    if (set && redis) {
      try {
        // Only cleanup if we set the flag and Redis is available
        await redis.del(processingKey);
      } catch (error) {
        // Log cleanup error but don't throw - cleanup failures should not break the main flow
        console.error('[redis] ⚠️ Failed to cleanup processing flag:', {
          processingKey,
          error: getErrorMessage(error)
        });
        // Continue without throwing - processing flag will expire naturally via TTL
      }
    }
  };
  
  return { set, cleanup };
}

/**
 * Checks if an idempotency key has already been used
 * 
 * @param config - Idempotency configuration
 * @returns Idempotency check result
 * 
 * @example
 * ```typescript
 * const result = await checkIdempotency({
 *   key: 'story-user123-book456-gen1',
 *   prefix: 'credit-consume',
 *   ttl: 300
 * });
 * if (result.isDuplicate) {
 *   return res.status(409).json(result.cachedResult);
 * }
 * ```
 */
export async function checkIdempotency<T = unknown>(
  config: IdempotencyConfig
): Promise<IdempotencyCheckResult<T>> {
  const redis = getRedisClient();
  if (!redis) {
    // If Redis is not available, assume not duplicate
    return { isDuplicate: false, cachedResult: null };
  }

  const { key, prefix = "idempotency" } = config;
  const redisKey = `${prefix}-${key}`;
  const existingResult = await redis.get(redisKey);

  if (existingResult) {
    try {
      return {
        isDuplicate: true,
        cachedResult: JSON.parse(existingResult as string) as T,
      };
    } catch {
      // If parsing fails, delete corrupted key and treat as not duplicate
      await redis.del(redisKey);
      return { isDuplicate: false, cachedResult: null };
    }
  }

  return { isDuplicate: false, cachedResult: null };
}

/**
 * Stores idempotency result in Redis
 * 
 * @param config - Idempotency configuration
 * @param result - Result to cache
 * 
 * @example
 * ```typescript
 * await storeIdempotencyResult(
 *   { key: 'story-user123-book456-gen1', prefix: 'credit-consume', ttl: 300 },
 *   { success: true, creditsConsumed: 5, remainingCredits: 145 }
 * );
 * ```
 */
export async function storeIdempotencyResult<T = unknown>(
  config: IdempotencyConfig,
  result: T
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    // If Redis is not available, skip storage
    return;
  }

  const { key, prefix = "idempotency", ttl = 300 } = config;
  const redisKey = `${prefix}-${key}`;
  await redis.set(redisKey, JSON.stringify(result), { ex: ttl });
}

/**
 * Validates and constructs a safe URL to prevent open redirects
 * 
 * @param path - URL path to validate
 * @param baseUrl - Base URL to prepend
 * @param defaultPath - Default path if validation fails
 * @returns Safe URL
 * 
 * @example
 * ```typescript
 * const url = constructSafeUrl(
 *   '/payment/success?from=pricing',
 *   'https://example.com',
 *   '/dashboard?success=true'
 * );
 * // Returns: 'https://example.com/payment/success?from=pricing'
 * 
 * const unsafeUrl = constructSafeUrl(
 *   'https://evil.com',
 *   'https://example.com',
 *   '/dashboard'
 * );
 * // Returns: 'https://example.com/dashboard' (rejected unsafe URL)
 * ```
 */
export function constructSafeUrl(
  path: string | undefined,
  baseUrl: string,
  defaultPath: string
): string {
  if (!path) {
    return `${baseUrl}${defaultPath}`;
  }

  // Validate baseUrl format - must include protocol and domain
  try {
    const baseUrlObj = new URL(baseUrl);
    if (!baseUrlObj.protocol || !baseUrlObj.hostname) {
      // Invalid baseUrl, use default
      return `${baseUrl}${defaultPath}`;
    }
  } catch {
    // Invalid baseUrl URL format, use default
    return `${baseUrl}${defaultPath}`;
  }

  // Security validation: prevent open redirects
  // Only allow relative paths starting with / and no protocol
  if (path.startsWith('/') && !path.includes('//') && !path.includes('http')) {
    return `${baseUrl}${path}`;
  }

  // If invalid, use default
  return `${baseUrl}${defaultPath}`;
}
