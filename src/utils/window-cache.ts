/** SDK-deserialized, validated cache envelopes with lifecycle-boundary expiry. */
import { getRedisClient } from "./redis.js";

export function isCacheObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cacheDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export async function invalidateWindowCache(key: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval("redis.call('INCR', KEYS[2]); return redis.call('DEL', KEYS[1])", [key, `${key}:revision`], []);
  } catch { /* Cache availability never blocks a committed mutation. */ }
}

/** CAS prevents a read started before invalidation from repopulating stale data. */
export async function readWindowCache<T>(key: string, ttlSeconds: number, decode: (value: unknown) => T | undefined,
  load: () => Promise<T | null>, boundaries: (value: T) => readonly number[]): Promise<T | null> {
  const redis = getRedisClient();
  let revision: number | undefined;
  if (redis) {
    try {
      const cached = await redis.get<unknown>(key);
      if (isCacheObject(cached) && cached.version === 2 && typeof cached.validUntil === "number" && cached.validUntil > Date.now()) {
        if (cached.value === null) return null;
        const value = decode(cached.value);
        if (value !== undefined) return value;
      }
      const current = await redis.get<unknown>(`${key}:revision`);
      if (current === null) revision = 0;
      else if (typeof current === "number" && Number.isSafeInteger(current)) revision = current;
    } catch { /* Authoritative loader remains available. */ }
  }
  const value = await load();
  const now = Date.now();
  const times = value ? boundaries(value) : [];
  const end = times.at(-1);
  const validUntil = end && end <= now ? now : Math.min(now + ttlSeconds * 1000, ...times.filter(time => time > now));
  if (redis && revision !== undefined) {
    try {
      await redis.eval("if tonumber(redis.call('GET', KEYS[2]) or '0') == tonumber(ARGV[1]) then return redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end return nil",
        [key, `${key}:revision`], [revision, JSON.stringify({ version: 2, validUntil, value }), Math.max(1, validUntil - now)]);
    } catch { /* Non-fatal cache refill. */ }
  }
  return value;
}
