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
  /**
   * Unique Redis key prefix for this rate limiter.
   *
   * Every `rateLimit()` call creates a separate `@upstash/ratelimit` instance.
   * Without a distinct prefix, all instances share the same Redis key
   * (`@upstash/ratelimit:<userId>:<bucket>`) and **increment the same
   * counter**, causing unrelated limiters (e.g. the global 100/min and a
   * per-route 10/min) to double-count against each other. Each per-route
   * limiter MUST supply a unique prefix so its counter is isolated.
   *
   * The global `rateLimitByUser` (no prefix) keeps the default so it remains
   * a true global ceiling that doesn't collide with any per-route limiter.
   */
  prefix?: string;
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