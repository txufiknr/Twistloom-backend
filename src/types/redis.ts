/**
 * Redis rate limiting types
 * 
 * Centralized types for Redis-based rate limiting and idempotency operations.
 * Used across middleware, utils, and route handlers.
 */

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional custom error message */
  message?: string;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  /** Whether request is allowed */
  allowed: boolean;
  /** Current request count */
  requestCount: number;
  /** Time until reset (seconds) */
  resetAfter?: number;
}