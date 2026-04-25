/**
 * Retry utility functions for handling transient failures and deduplication
 */

import { LRUCache } from "lru-cache";

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000ms) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000ms) */
  maxDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
  /** Optional callback for retry attempts */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  exponentialBackoff: true,
  onRetry: () => {},
};

// ============================================================================
// DEDUPLICATION TRACKER
// ============================================================================

/**
 * Default deduplication window in milliseconds (1 minute)
 */
const DEFAULT_DEDUP_WINDOW_MS = 60000;

/**
 * Maximum number of entries in the deduplication cache
 * 
 * Prevents unbounded memory growth in serverless environments.
 * Each entry represents a unique operation key (e.g., "retry:pageId:timestamp").
 */
const DEDUPE_CACHE_MAX_SIZE = 1000;

/**
 * LRU cache for deduplication tracking
 * 
 * Uses LRU (Least Recently Used) eviction policy to automatically remove
 * old entries when the cache reaches max size. This prevents memory leaks
 * in serverless environments while still providing effective deduplication.
 * 
 * Each entry stores the timestamp of the last execution.
 */
const dedupeCache = new LRUCache<string, number>({
  max: DEDUPE_CACHE_MAX_SIZE,
  ttl: DEFAULT_DEDUP_WINDOW_MS,
  updateAgeOnGet: true,
});

/**
 * Checks if an operation should be deduplicated (already executed within window)
 *
 * This prevents multiple concurrent executions of the same operation within
 * a time window. Useful for preventing duplicate retries when multiple requests
 * trigger the same operation simultaneously.
 *
 * Uses LRU cache for automatic cleanup and memory management, making it
 * suitable for serverless environments (Vercel, Fly.io) where in-memory state
 * must be carefully managed.
 *
 * @param key - Unique identifier for the operation (e.g., "retry:pageId:timestamp")
 * @param windowMs - Deduplication window in milliseconds (default: 60000ms)
 * @returns true if operation should proceed (not deduplicated), false if it should be skipped
 *
 * @example
 * ```typescript
 * const key = `retry:${pageId}:${Math.floor(Date.now() / 60000)}`;
 * if (shouldProceedWithRetry(key)) {
 *   // Execute operation
 * }
 * ```
 *
 * @remarks
 * **Memory Management:**
 * - LRU cache automatically evicts old entries when max size (1000) is reached
 * - TTL-based cleanup removes entries after window expires
 * - Prevents memory leaks in long-running serverless instances
 *
 * **Cross-Instance Limitation:**
 * - Cache is in-memory and does not persist across serverless instances
 * - Each Vercel/Fly.io instance has its own cache
 * - Deduplication only works within the same instance
 *
 * **Suitability for Use Case:**
 * - Acceptable for fire-and-forget operations with low probability of concurrent cross-instance access
 * - For true cross-instance deduplication, consider using Redis or similar distributed cache
 */
export function shouldProceedWithRetry(key: string, windowMs: number = DEFAULT_DEDUP_WINDOW_MS): boolean {
  const now = Date.now();
  const lastExecution = dedupeCache.get(key);
  
  // Check if already executed within window
  if (lastExecution && now - lastExecution < windowMs) {
    return false;
  }
  
  // Mark as executed (LRU cache handles cleanup automatically)
  dedupeCache.set(key, now, { ttl: windowMs });
  return true;
}

/**
 * Executes a function with retry logic and exponential backoff
 * 
 * This function retries the provided operation if it fails, with increasing
 * delay between attempts using exponential backoff. Useful for handling
 * transient failures in network requests, database operations, or AI calls.
 * 
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the function's result
 * @throws Error if all retry attempts fail
 * 
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => fetchExternalAPI(),
 *   { maxRetries: 5, baseDelayMs: 2000 }
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = opts.exponentialBackoff
        ? Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs)
        : opts.baseDelayMs;

      // Call retry callback if provided
      opts.onRetry(attempt + 1, error);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries failed, throw the last error
  throw lastError;
}

/**
 * Executes a function with retry logic and returns null if all attempts fail
 * 
 * Similar to retryWithBackoff but returns null instead of throwing on failure.
 * Useful when you want to handle failures gracefully without exceptions.
 * 
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the function's result or null if all retries fail
 * 
 * @example
 * ```typescript
 * const result = await retryWithBackoffOrNull(
 *   () => fetchExternalAPI(),
 *   { maxRetries: 3 }
 * );
 * if (result) {
 *   console.log('Success:', result);
 * } else {
 *   console.log('All retries failed');
 * }
 * ```
 */
export async function retryWithBackoffOrNull<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T | null> {
  try {
    return await retryWithBackoff(fn, options);
  } catch {
    return null;
  }
}
