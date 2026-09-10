import { Ratelimit } from '@upstash/ratelimit';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { dbRead } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AppEnv } from '../hono/env.js';
import { getErrorMessage } from '../utils/error.js';
import { getRedisClient } from '../utils/redis.js';

const NEW_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1_000;
const redis = getRedisClient();

const newAccountLimiter = createLimiter(3, 'wall-create-new');
const freeLimiter = createLimiter(10, 'wall-create-free');
const vipLimiter = createLimiter(30, 'wall-create-vip');

/** Applies the approved account-age and active-tier Wall creation limits. */
export const wallCreateRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get('userId');
  if (!userId || !redis) {
    await next();
    return;
  }

  try {
    const [user] = await dbRead
      .select({
        tier: users.tier,
        vipExpiresAt: users.vipExpiresAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!user) {
      await next();
      return;
    }

    const accountIsNew = Date.now() - user.createdAt.getTime() < NEW_ACCOUNT_AGE_MS;
    const activeVip = user.tier === 'vip'
      && (!user.vipExpiresAt || user.vipExpiresAt.getTime() > Date.now());
    const limiter = accountIsNew ? newAccountLimiter : activeVip ? vipLimiter : freeLimiter;
    const maximum = accountIsNew ? 3 : activeVip ? 30 : 10;
    if (!limiter) {
      await next();
      return;
    }

    const result = await limiter.limit(userId);
    const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000));
    c.header('X-RateLimit-Limit', String(maximum));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', new Date(result.reset).toISOString());

    if (!result.success) {
      c.header('Retry-After', String(retryAfter));
      return c.json({
        success: false,
        error: 'Wall Note creation rate limit exceeded',
        code: 'WALL_RATE_LIMITED',
        retryAfter,
      }, 429);
    }

    await next();
  } catch (error) {
    console.error('[wall-rate-limit] Redis/entitlement check failed open:', getErrorMessage(error));
    await next();
  }
});

function createLimiter(maximum: number, prefix: string): Ratelimit | null {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maximum, '1 h'),
    analytics: true,
    prefix: `rl:${prefix}`,
  });
}
