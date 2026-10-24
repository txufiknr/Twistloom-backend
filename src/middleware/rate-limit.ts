/**
 * @overview Rate Limiting Middleware Module (Upstash Redis)
 * 
 * Provides serverless-safe rate limiting per user using Upstash Redis.
 * Optimized for high-performance, low-latency rate limiting with automatic TTL expiration.
 * 
 * Features:
 * - Sliding window rate limiting (more accurate than fixed window)
 * - Redis-backed; REST latency depends on region/network
 * - Automatic TTL expiration (no cleanup needed)
 * - Serverless-safe (Upstash REST API)
 * - Configurable limits per endpoint or globally
 * 
 * Architecture:
 * - Uses @upstash/ratelimit for battle-tested rate limiting
 * - Automatic key expiration via TTL
 * - No database bloat concerns
 * - One shared enforcement boundary across serverless instances
 * 
 * @note
 * - Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables
 * - Fails open when Redis is absent or unavailable (explicit infrastructure policy)
 * - Default middleware keys authenticated requests by userId; anonymous IP
 *   fallback is opt-in, and auth attempts use separate helper buckets below
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { Ratelimit } from '@upstash/ratelimit';
import { getErrorMessage } from '../utils/error.js';
import type { RateLimitConfig } from '../types/redis.js';
import { getRedisClient, checkRateLimit } from '../utils/redis.js';
import { hashSHA256 } from '../utils/hash.js';
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
 * - Deployment latency must be measured; no sub-millisecond guarantee
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
    let identifier = userId;
    if (!userId && opts?.ipFallback) {
      const clientIp = getClientIp(c);
      if (clientIp !== 'unknown') {
        try {
          identifier = `ip:${await hashSHA256(clientIp)}`;
        } catch (error) {
          console.error('[rate-limit] Error hashing client IP:', getErrorMessage(error));
          await next();
          return;
        }
      }
    }
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

    let result: Awaited<ReturnType<Ratelimit['limit']>>;
    try {
      // Check rate limit (atomic operation in Redis).
      result = await ratelimit.limit(identifier);
    } catch (error) {
      // Fail open only when the limiter itself fails. Keep downstream route
      // exceptions outside this catch so `next()` is never run a second time.
      console.error('[rate-limit] Error checking rate limit:', getErrorMessage(error));
      await next();
      return;
    }

    if (!result.success) {
      const resetTime = new Date(result.reset);
      const retryAfter = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));

      c.header('Retry-After', retryAfter.toString());
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', result.remaining.toString());
      c.header('X-RateLimit-Reset', resetTime.toISOString());

      throw new HTTPException(429, {
        message:
          message ||
          `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowSeconds} seconds. Retry after ${retryAfter} seconds.`,
      });
    }

    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', result.remaining.toString());
    c.header('X-RateLimit-Reset', new Date(result.reset).toISOString());
    await next();
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
 * Distributed IP attempts for unauthenticated auth/recovery routes.
 *
 * Uses the shared atomic Redis fixed-window helper rather than warm-instance
 * counters. A broad IP burst ceiling is combined with a tighter per-action IP
 * bucket and optional normalized account bucket. Account lockout is separate.
 * Keys contain SHA-256 digests rather than plaintext IPs or account values.
 *
 * @remarks Redis absence/outage fails open by repository policy. Netlify
 *   supplies trusted context.ip; arbitrary forwarded headers are not authority.
 *   Signed web exchanges use separate egress/account limits to avoid pooling
 *   every browser into one five-attempt frontend-server bucket.
 * @example
 * if (!await checkRateLimitByIP(getClientIp(c), 'password-recovery', email)) return cRateLimitError(c);
 * @param ip - Adapter-provided address (or the shared local unknown fallback).
 * @param scope - Server-defined action key; never derive this from request data.
 * @param account - Optional normalized account identifier.
 * @returns Whether distributed attempt admission permits this request.
 */
function positiveAuthSetting(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const AUTH_IP_BURST_LIMIT = positiveAuthSetting(process.env.AUTH_RATE_LIMIT_IP_MAX_REQUESTS, 60);
const AUTH_IP_BURST_WINDOW_MS = positiveAuthSetting(process.env.AUTH_RATE_LIMIT_IP_WINDOW_MS, 60000);
const AUTH_SCOPE_LIMIT = positiveAuthSetting(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, 5);
const AUTH_SCOPE_WINDOW_MS = positiveAuthSetting(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60000);

export type AuthRateLimitScope =
  | 'web-password-login'
  | 'web-google-login'
  | 'signup'
  | 'password-recovery'
  | 'password-reset'
  | 'email-verification'
  | 'verification-resend'
  | 'email-change'
  | 'password-change'
  | 'username-change';

/**
 * Distributed auth admission has three independent buckets: a higher shared
 * source-IP ceiling for broad abuse, a tighter per-action IP ceiling to avoid
 * cross-route coupling, and an optional normalized-account ceiling. Redis keys
 * contain digests, not raw IPs or account identifiers. Infrastructure failures
 * follow the repository's explicit fail-open policy.
 */
export async function checkRateLimitByIP(
  ip: string,
  scope: AuthRateLimitScope,
  account?: string,
): Promise<boolean> {
  try {
    if (ip !== 'unknown') {
      const ipDigest = await hashSHA256(ip);
      const ipWindowSeconds = Math.max(1, Math.ceil(AUTH_IP_BURST_WINDOW_MS / 1000));
      const scopeWindowSeconds = Math.max(1, Math.ceil(AUTH_SCOPE_WINDOW_MS / 1000));

      const burstResult = await checkRateLimit('auth:ip:' + ipDigest,
        { maxRequests: AUTH_IP_BURST_LIMIT, windowSeconds: ipWindowSeconds });
      if (!burstResult.allowed) return false;

      const scopeResult = await checkRateLimit(`auth:ip-scope:${scope}:` + ipDigest,
        { maxRequests: AUTH_SCOPE_LIMIT, windowSeconds: scopeWindowSeconds });
      if (!scopeResult.allowed) return false;
    }

    if (!account?.trim()) return true;
    return (await checkRateLimit(`auth:account:${scope}:` + await hashSHA256(account.trim().toLowerCase()),
      { maxRequests: AUTH_SCOPE_LIMIT, windowSeconds: 15 * 60 })).allowed;
  } catch {
    console.error('[auth] Distributed attempt limiter unavailable (fail open)');
    return true;
  }
}
