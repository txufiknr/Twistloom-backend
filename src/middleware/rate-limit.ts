/**
 * @overview Rate Limiting Middleware Module (Upstash Redis)
 * 
 * Provides serverless-safe rate limiting per user using Upstash Redis.
 * Optimized for high-performance, low-latency rate limiting with automatic TTL expiration.
 * 
 * Features:
 * - Sliding window rate limiting (more accurate than fixed window)
 * - Redis-backed (ultra-fast, <1ms latency)
 * - Automatic TTL expiration (no cleanup needed)
 * - Serverless-safe (Upstash REST API)
 * - Configurable limits per endpoint or globally
 * 
 * Architecture:
 * - Uses @upstash/ratelimit for battle-tested rate limiting
 * - Automatic key expiration via TTL
 * - No database bloat concerns
 * - Sub-millisecond response times
 * 
 * @note
 * - Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables
 * - Falls back to database-backed rate limiting if Redis is unavailable
 * - Only applies rate limiting to requests with userId (set by NextAuth auth middleware)
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { Ratelimit } from '@upstash/ratelimit';
import { LRUCache } from 'lru-cache';
import { getErrorMessage } from '../utils/error.js';
import type { RateLimitConfig } from '../types/redis.js';
import { getRedisClient } from '../utils/redis.js';
import type { AppEnv } from '../hono/env.js';
import { getClientIp } from '../hono/express-shim.js';

/**
 * Default rate limit: 100 requests per minute
 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
  message: 'Rate limit exceeded. Please try again later.',
};

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  /**
   * When `true`, unauthenticated requests are keyed by **client IP** instead of
   * being skipped. The standard `rateLimit()` middleware returns early for any
   * request without a `userId`, which is correct for most public endpoints but
   * leaves `optionalAuth` endpoints that still perform expensive work (e.g. AI
   * generation on `GET /api/books/prompt`) wide open to anonymous abuse. Set
   * this only for those endpoints so anonymous traffic is throttled by IP.
   */
  ipFallback?: boolean;
}

/**
 * Creates rate limiting middleware with configurable limits using Upstash Redis.
 * 
 * Uses sliding window algorithm for accurate rate limiting:
 * - Counts requests within the last N seconds
 * - More accurate than fixed window (no burst at window boundaries)
 * - Automatic TTL expiration (no cleanup needed)
 * - Ultra-fast (<1ms latency vs 10-50ms for database)
 * 
 * @param config - Rate limit configuration (defaults to 100 req/min)
 * @param opts - Optional behavior flags (see {@link RateLimitOptions})
 * @returns Hono middleware function
 * 
 * @example
 * ```typescript
 * // Use default (100 req/min)
 * router.get('/endpoint', rateLimit(), handler);
 * 
 * // Custom limit (50 req/30sec)
 * router.post('/endpoint', rateLimit({ maxRequests: 50, windowSeconds: 30 }), handler);
 * 
 * // Throttle anonymous traffic by IP on an optionalAuth AI endpoint
 * router.get('/prompt', optionalAuth, rateLimit(BOOK_PROMPT_RATE_LIMIT, { ipFallback: true }), handler);
 * ```
 * 
 * @note
 * - Keyed by `userId` when authenticated; with `ipFallback` also keys anonymous
 *   requests by client IP. Without `ipFallback`, requests without a `userId` are
 *   not rate limited (public endpoints).
 * - Falls back gracefully if Redis is unavailable
 * - Serverless-safe (Upstash REST API, no persistent connections)
 */
export function rateLimit(config: RateLimitConfig = DEFAULT_RATE_LIMIT, opts?: RateLimitOptions) {
  const { maxRequests, windowSeconds, message, prefix } = config;

  // Create rate limiter instance if Redis is available.
  //
  // Each per-route limiter MUST supply a unique `prefix` so that its Redis key
  // namespace is isolated from every other limiter. Without this, all instances
  // with the same prefix + identifier + window write to the identical Redis key
  // (`@upstash/ratelimit:<userId>:<bucket>`), causing every limiter to
  // double-count against the same shared counter.
  //
  // The global `rateLimitByUser` passes no prefix and falls back to the
  // library default (`@upstash/ratelimit`). Per-route configs must never omit
  // their prefix.
  const redis = getRedisClient();
  const ratelimit = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
        analytics: true, // Track rate limit analytics
        prefix: prefix ? `rl:${prefix}` : undefined,
      })
    : null;

  return createMiddleware<AppEnv>(async (c, next) => {
    // Identify the caller. Authenticated requests key on userId; when `ipFallback`
    // is set (optionalAuth, expensive endpoints), anonymous requests key on client
    // IP so they are still throttled. Without an identifier we cannot limit.
    const userId = c.get('userId');
    const identifier = userId ?? (opts?.ipFallback ? getClientIp(c) : undefined);
    if (!identifier || identifier === 'unknown') {
      await next();
      return;
    }

    // If Redis is not available, allow request (fail open)
    if (!ratelimit) {
      console.warn('[rate-limit] Redis not available, skipping rate limiting');
      await next();
      return;
    }

    try {
      // Check rate limit (atomic operation in Redis)
      const result = await ratelimit.limit(identifier);

      // Check if limit exceeded
      if (!result.success) {
        const resetTime = new Date(result.reset);
        const retryAfter = Math.ceil((resetTime.getTime() - Date.now()) / 1000);

        // Set Retry-After header for better UX
        c.header('Retry-After', retryAfter.toString());
        c.header('X-RateLimit-Limit', maxRequests.toString());
        c.header('X-RateLimit-Remaining', result.limit.toString());
        c.header('X-RateLimit-Reset', resetTime.toISOString());

        throw new HTTPException(429, {
          message:
            message ||
            `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowSeconds} seconds. Retry after ${retryAfter} seconds.`,
        });
      }

      // Set rate limit headers for successful requests
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', result.limit.toString());
      c.header('X-RateLimit-Reset', new Date(result.reset).toISOString());

      // Request allowed, continue
      await next();
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      // On error, allow request to proceed (fail open for availability)
      // Log error for monitoring but don't block legitimate users
      console.error('[rate-limit] ❌ Error checking rate limit:', getErrorMessage(error));
      await next();
    }
  });
}

/**
 * Global rate limiting middleware (100 requests per minute).
 * Can be applied globally using app.use(rateLimitByUser).
 * 
 * @example
 * ```typescript
 * import { rateLimitByUser } from './middleware/rate-limit.js';
 * 
 * // JSON body parsing is handled by Hono's body middleware
 * app.use(cors());
 * app.use(rateLimitByUser); // Apply globally
 * app.use("/api", routes);
 * ```
 * 
 * @note
 * - Only applies rate limiting to requests with userId (set by NextAuth auth middleware)
 * - Public endpoints without userId are not rate limited
 * - Can be overridden per-route with custom rateLimit() configuration
 * - Requires Upstash Redis environment variables
 */
export const rateLimitByUser = rateLimit(DEFAULT_RATE_LIMIT);

/**
 * Simple in-memory IP-based rate limiter for unauthenticated endpoints.
 * 
 * Used for endpoints where the user is not yet authenticated (e.g., login, signup).
 * The global rateLimitByUser middleware requires req.userId, which doesn't exist
 * before authentication. This IP-based limiter fills that gap for security.
 * 
 * Security Purpose:
 * - Prevents brute force attacks on login/signup endpoints
 * - Limits attempts per IP address instead of per user
 * - Simple in-memory implementation (no Redis needed)
 * 
 * Implementation:
 * - Uses LRU cache for automatic memory management
 * - Max 10,000 IPs cached (prevents unbounded memory growth)
 * - Automatic eviction when cache is full
 * - Configurable via environment variables
 * 
 * Limitations:
 * - In-memory only (resets on server restart)
 * - Per-IP (can be bypassed with proxy rotation)
 * - Not distributed across multiple server instances
 * 
 * Environment Variables:
 * - AUTH_RATE_LIMIT_MAX_ATTEMPTS: Maximum attempts per window (default: 5)
 * - AUTH_RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 60000)
 * 
 * @example
 * ```typescript
 * import { checkRateLimitByIP } from '../middleware/rate-limit.js';
 * 
 * app.post('/api/auth/login', async (c) => {
 *   const ip = getClientIp(c) || 'unknown';
 *   if (!checkRateLimitByIP(ip)) {
 *     return c.json({ error: 'Too many attempts' }, 429);
 *   }
 *   // ... rest of handler
 * });
 * ```
 * 
 * @param ip - IP address to check
 * @returns true if request is allowed, false if rate limited
 */
const IP_RATE_LIMIT = parseInt(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS || '5', 10); // Max attempts per window
const IP_RATE_WINDOW = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '60000', 10); // Time window in milliseconds

// LRU cache for IP rate limiting (max 10,000 entries to prevent memory bloat)
const ipRateLimitCache = new LRUCache<string, { count: number; resetTime: number }>({
  max: 10000, // Maximum number of IPs to track
  ttl: IP_RATE_WINDOW, // Auto-expire entries after time window
});

export function checkRateLimitByIP(ip: string): boolean {
  const now = Date.now();
  const record = ipRateLimitCache.get(ip);

  if (!record || now > record.resetTime) {
    // Reset or first attempt
    ipRateLimitCache.set(ip, { count: 1, resetTime: now + IP_RATE_WINDOW });
    return true;
  }

  if (record.count >= IP_RATE_LIMIT) {
    return false; // Rate limited
  }

  record.count++;
  ipRateLimitCache.set(ip, record);
  return true;
}
