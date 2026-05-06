/**
 * @overview Distributed Lock Utility
 * 
 * Provides distributed locking mechanism for serverless environments
 * using Redis to prevent concurrent execution of the same operation.
 * 
 * Features:
 * - Redis-based distributed locks
 * - Automatic lock expiration (prevents deadlocks)
 * - Idempotent operations
 * - Graceful degradation when Redis is unavailable
 */

import { getErrorMessage } from './error.js';
import { getRedisClient } from './redis.js';

/**
 * Default distributed lock TTL in seconds
 * 
 * Controls how long a lock is held when processing operation
 * to prevent concurrent modifications.
 * Default: 5 minutes (300s).
 */
export const DEFAULT_LOCK_TTL = 300;

/**
 * Lock key patterns
 */
export const LOCK_KEYS = {
  /** Candidate generation lock: lock:candidate:{pageId} */
  CANDIDATE_GENERATION: (pageId: string) => `lock:candidate:${pageId}`,
  /** Story state lock: lock:state:{userId}:{bookId} */
  STORY_STATE: (userId: string, bookId: string) => `lock:state:${userId}:${bookId}`,
  /** Book generation lock: lock:book:{bookId} */
  BOOK_GENERATION: (bookId: string) => `lock:book:${bookId}`,
} as const;

/**
 * Acquires a distributed lock for a given resource
 * 
 * @param key - Unique lock key for the resource
 * @param ttl - Time-to-live for the lock in seconds (default: 300)
 * @returns true if lock was acquired, false if already locked
 * 
 * @example
 * ```typescript
 * const acquired = await acquireLock('lock:candidate:page123', 60);
 * if (acquired) {
 *   // Perform operation
 *   await releaseLock('lock:candidate:page123');
 * }
 * ```
 */
export async function acquireLock(key: string, ttl: number = DEFAULT_LOCK_TTL): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    console.warn(`[distributed-lock] ⚠️ Redis unavailable, assuming lock acquired for ${key}`);
    return true; // Assume lock acquired if Redis unavailable (graceful degradation)
  }

  try {
    // Use SET with NX (only if not exists) and EX (expiration)
    const result = await redis.set(key, 'locked', {
      nx: true, // Only set if key doesn't exist
      ex: ttl,  // Expire after TTL seconds
    });

    const acquired = result === 'OK';
    if (!acquired) {
      console.log(`[distributed-lock] 🔒 Lock already held for ${key}`);
    } else {
      console.log(`[distributed-lock] 🔓 Lock acquired for ${key} (TTL: ${ttl}s)`);
    }
    
    return acquired;
  } catch (error) {
    console.error(`[distributed-lock] ❌ Failed to acquire lock for ${key}:`, getErrorMessage(error));
    return false; // Assume lock not acquired on error
  }
}

/**
 * Releases a distributed lock
 * 
 * @param key - Lock key to release
 * @returns true if lock was released, false otherwise
 * 
 * @example
 * ```typescript
 * await releaseLock('lock:candidate:page123');
 * ```
 */
export async function releaseLock(key: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) {
    console.warn(`[distributed-lock] ⚠️ Redis unavailable, assuming lock released for ${key}`);
    return true; // Assume lock released if Redis unavailable
  }

  try {
    await redis.del(key);
    console.log(`[distributed-lock] 🔓 Lock released for ${key}`);
    return true;
  } catch (error) {
    console.error(`[distributed-lock] ❌ Failed to release lock for ${key}:`, getErrorMessage(error));
    return false;
  }
}

/**
 * Executes a function with a distributed lock
 * 
 * Automatically acquires and releases the lock around the function execution.
 * Returns null if lock cannot be acquired.
 * 
 * @param key - Lock key for the resource
 * @param fn - Function to execute while holding the lock
 * @param ttl - Lock TTL in seconds (default: 300)
 * @returns Result of the function, or null if lock could not be acquired
 * 
 * @example
 * ```typescript
 * const result = await withLock('lock:candidate:page123', async () => {
 *   // Perform operation
 *   return await someAsyncOperation();
 * }, 60);
 * ```
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttl: number = DEFAULT_LOCK_TTL
): Promise<T | null> {
  const acquired = await acquireLock(key, ttl);
  if (!acquired) {
    return null;
  }

  try {
    const result = await fn();
    return result;
  } finally {
    await releaseLock(key);
  }
}
