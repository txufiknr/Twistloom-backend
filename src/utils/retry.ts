/**
 * Retry utility functions for handling transient failures
 */

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
