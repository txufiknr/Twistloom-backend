/**
 * Retry utility functions for handling transient failures and deduplication
 */

import { LRUCache } from "lru-cache";
import { getErrorMessage } from "./error.js";

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
  /** Optional predicate to determine whether an error should be retried. Return false to stop retrying. */
  shouldRetry?: (error: unknown) => boolean;
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
  shouldRetry: () => true,
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

      // If caller indicated this error should not be retried, rethrow immediately
      try {
        if (!opts.shouldRetry(error)) {
          throw error;
        }
      } catch {
        // If shouldRetry threw or returned false, rethrow original error
        throw error;
      }

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

// ============================================================================
// UNIQUE CONSTRAINT RETRY UTILITIES
// ============================================================================

/**
 * Common unique constraint error patterns
 * 
 * Includes PostgreSQL error codes and message patterns:
 * - 23505: unique_violation
 * - 23000: integrity_constraint_violation
 */
const UNIQUE_CONSTRAINT_PATTERNS = [
  'unique constraint',
  'duplicate key',
  'violates unique constraint',
  'already exists',
  'duplicate entry',
  '23505', // PostgreSQL unique_violation error code
  '23000', // PostgreSQL integrity_constraint_violation error code
  'pages_parent_branch_unique', // Specific constraint name from pages table
];

/**
 * Type guard for errors with custom properties
 */
export interface ErrorWithCustomProperties extends Error {
  code?: string;
  shouldRetry?: boolean;
  cause?: unknown;
  retryAttempt?: number;
  maxRetries?: number;
}

/**
 * Checks if an error is a unique constraint violation, including through
 * wrapped errors (i.e., errors with a `cause` chain).
 *
 * Drizzle and application code frequently wrap PostgreSQL errors in new Error
 * instances. Walking the cause chain ensures the original constraint error's
 * `code` and `message` are reachable even after wrapping.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  const check = (err: unknown): boolean => {
    if (!err) return false;

    const message = getErrorMessage(err).toLowerCase();
    if (UNIQUE_CONSTRAINT_PATTERNS.some(pattern => message.includes(pattern))) return true;

    const e = err as ErrorWithCustomProperties & { code?: string };
    if (e.code === '23505' || e.code === '23000') return true;

    // Walk the cause chain — errors are often wrapped multiple times
    if (e.cause !== undefined) return check(e.cause);

    return false;
  };

  return check(error);
}

/**
 * Checks if an error is marked as non-retryable
 * 
 * This provides type-safe checking for errors that have custom properties
 * like `shouldRetry: false` or specific error codes.
 * 
 * @param error - The error to check
 * @returns true if the error should not be retried
 */
export function isNonRetryableError(error: unknown): boolean {
  const err = error as ErrorWithCustomProperties;
  return err.shouldRetry === false || err.code === 'PAGE_DELETED';
}

/**
 * Creates a non-retryable error with custom properties
 * 
 * This helper function creates errors that will not be retried by the
 * {@link retryWithUniqueConstraint} function, providing a type-safe way to
 * mark errors as non-retryable.
 * 
 * @param message - Error message
 * @param code - Optional error code for identification
 * @returns Error object with non-retryable properties
 */
export function createNonRetryableError(message: string, code?: string): ErrorWithCustomProperties {
  const error = new Error(message) as ErrorWithCustomProperties;
  error.shouldRetry = false;
  if (code) {
    error.code = code;
  }
  return error;
}

/**
 * Retry options for database operations with unique constraints
 */
export interface DatabaseRetryOptions<TData = any> extends RetryOptions {
  /** Function to modify data before retry (for generating unique values) */
  modifyData?: (attempt: number, data: TData) => TData;
}

/**
 * Executes a database operation with automatic retry on unique constraint conflicts
 *
 * Note: `shouldRetry` from the base `RetryOptions` interface is intentionally
 * not used here. This function enforces its own retry predicate: only unique
 * constraint violations are retried; all other errors (including non-retryable
 * ones) are thrown immediately.
 * 
 * @param operation - The database operation function to execute
 * @param initialData - Initial data for operation
 * @param options - Retry configuration options
 * @returns Promise resolving to operation result
 */
export async function retryWithUniqueConstraint<T, D = any>(
  operation: (data: D) => Promise<T>,
  initialData: D,
  options: DatabaseRetryOptions<D> = {}
): Promise<T> {
  const { modifyData, ...retryOptions } = options;
  let currentData = initialData;
  let lastError: unknown;

  const maxRetries = retryOptions.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(currentData);
    } catch (error) {
      lastError = error;

      // Only retry on unique constraint violations
      // Check for specific error codes that should not be retried
      if (isNonRetryableError(error)) throw error;

      if (!isUniqueConstraintError(error)) {
        // Add retry context to non-unique constraint errors
        const errorMessage = getErrorMessage(error);
        console.error(`[retryWithUniqueConstraint] ❌ Non-retryable error (attempt ${attempt + 1}/${maxRetries + 1}):`, errorMessage);
        console.error(`[retryWithUniqueConstraint] 🔍 Full error object:`, error);
        
        const contextError = createNonRetryableError(`Non-retryable error in retryWithUniqueConstraint (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}`);
        contextError.cause = error;
        contextError.retryAttempt = attempt + 1;
        contextError.maxRetries = maxRetries + 1;
        throw contextError;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) break;

      // Modify data for next attempt
      if (modifyData) {
        try {
          currentData = modifyData(attempt + 1, currentData);
        } catch (modifyError) {
          console.error(`[retryWithUniqueConstraint] ❌ Error modifying data on attempt ${attempt + 1}:`, modifyError);
          throw modifyError; // Re-throw to fail the retry
        }
      }

      // Calculate delay and wait
      const baseDelayMs = retryOptions.baseDelayMs ?? 1000;
      const maxDelayMs = retryOptions.maxDelayMs ?? 30000;
      const exponentialBackoff = retryOptions.exponentialBackoff ?? true;
      
      const delay = exponentialBackoff
        ? Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
        : baseDelayMs;

      // Call retry callback if provided
      retryOptions.onRetry?.(attempt + 1, error);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries failed, throw last error
  throw lastError;
}

/**
 * Specialized retry wrapper for branch ID conflicts
 * 
 * @param operation - Database operation that uses branchId
 * @param data - Data containing branchId
 * @param generateNewBranchId - Function to generate new branch ID
 * @param options - Additional retry options
 */
export async function retryWithBranchConflict<T, TData extends { branchId?: string }>(
  operation: (data: TData) => Promise<T>,
  data: TData,
  generateNewBranchId: () => string,
  options: DatabaseRetryOptions<TData> = {}
): Promise<T> {
  return retryWithUniqueConstraint(
    operation,
    data,
    {
      ...options,
      modifyData: (attempt, currentData) => ({
        ...currentData,
        branchId: generateNewBranchId()
      }),
      onRetry: (attempt, error) => {
        console.log(`[retryWithBranchConflict] 🔄 Branch conflict detected, generating new branch ID (attempt ${attempt})`);
        options.onRetry?.(attempt, error);
      }
    }
  );
}
