/** Account-scoped provider coordination. No SQL on the permission path. */
import { Ratelimit } from "@upstash/ratelimit";
import { getRedisClient } from "../utils/redis.js";
import { emailRequestsPerSecond, EMAIL_LEASE_MS } from "../config/email-delivery.js";
import { generateId } from "../utils/uuid.js";
import type { EmailSendResult } from "../types/email-delivery.js";

const stateKey = "email:{resend-team}:cooldown";
let rate: { configured: number; global: Ratelimit; bulk: Ratelimit } | undefined;
export type EmailPermit = { allowed: true; probeToken: string | null } | { allowed: false; retryAt: Date };
/** Atomically admits exactly one recovery probe after a cooldown. Hash keys expire after a week. */
const admissionScript = `local untilAt = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
local probeAt = tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0')
local now = tonumber(ARGV[1])
if untilAt > now then return {0, untilAt, ''} end
if probeAt > now then return {0, probeAt, ''} end
if redis.call('HEXISTS', KEYS[1], 'until') == 1 then
 redis.call('HSET', KEYS[1], 'probe', ARGV[2], 'probeUntil', now + tonumber(ARGV[3]))
 redis.call('EXPIRE', KEYS[1], 604800)
 return {1, 0, ARGV[2]}
end
return {1, 0, ''}`;

/** Supervisor avoids enumeration and recipient writes during known provider pauses. */
export async function emailProviderPausedUntil(): Promise<Date | null> {
  const redis = getRedisClient();
  if (!redis) return new Date(Date.now() + 60_000);
  try {
    const result: unknown = await redis.eval("return math.max(tonumber(redis.call('HGET', KEYS[1], 'until') or '0'), tonumber(redis.call('HGET', KEYS[1], 'probeUntil') or '0'))", [stateKey], []);
    return typeof result === "number" && result > Date.now() ? new Date(result) : null;
  } catch { return new Date(Date.now() + 60_000); }
}

export async function acquireEmailPermit(priority: number): Promise<EmailPermit> {
  const retryAt = new Date(Date.now() + 1000);
  const redis = getRedisClient();
  if (!redis) return { allowed: false, retryAt };
  let probeToken: string | null = null;
  try {
    const admission: unknown = await redis.eval(admissionScript, [stateKey], [Date.now(), generateId(), EMAIL_LEASE_MS]);
    if (!Array.isArray(admission) || admission.length !== 3) return { allowed: false, retryAt };
    if (admission[0] !== 1) return { allowed: false, retryAt: new Date(typeof admission[1] === "number" ? admission[1] : retryAt.getTime()) };
    probeToken = typeof admission[2] === "string" && admission[2] ? admission[2] : null;
    const configured = emailRequestsPerSecond();
    if (!rate || rate.configured !== configured) rate = {
      configured,
      global: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(configured, "1 s"), prefix: "email:provider", timeout: 1000, ephemeralCache: false }),
      bulk: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(Math.max(1, Math.floor(configured * 0.75)), "1 s"), prefix: "email:bulk", timeout: 1000, ephemeralCache: false }),
    };
    if (priority === 2) {
      const bulk = await rate.bulk.limit("resend-team");
      await bulk.pending;
      if (!bulk.success || bulk.reason === "timeout") {
        await releaseEmailProbe(probeToken);
        return { allowed: false, retryAt: new Date(Math.max(Date.now() + 1000, bulk.reset)) };
      }
    }
    const global = await rate.global.limit("resend-team");
    await global.pending;
    if (!global.success || global.reason === "timeout") {
      await releaseEmailProbe(probeToken);
      return { allowed: false, retryAt: new Date(Math.max(Date.now() + 1000, global.reset)) };
    }
    return { allowed: true, probeToken };
  } catch {
    await releaseEmailProbe(probeToken);
    console.warn("[email] Provider coordination unavailable; delivery deferred");
    return { allowed: false, retryAt };
  }
}

export async function releaseEmailProbe(token: string | null): Promise<void> {
  if (!token) return;
  try { await getRedisClient()?.eval("if redis.call('HGET', KEYS[1], 'probe') == ARGV[1] then redis.call('HDEL', KEYS[1], 'probe', 'probeUntil') end return 1", [stateKey], [token]); }
  catch { /* The finite probe lease allows recovery. */ }
}

export async function recordEmailProviderResult(result: EmailSendResult, probeToken: string | null): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    if (result.kind === "paused") await redis.eval(`local current = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
if tonumber(ARGV[1]) >= current then
 redis.call('HSET', KEYS[1], 'until', ARGV[1], 'reason', ARGV[2])
 redis.call('HDEL', KEYS[1], 'probe', 'probeUntil')
 redis.call('EXPIRE', KEYS[1], 604800)
end return 1`, [stateKey], [result.retryAt.getTime(), result.code]);
    else if (probeToken) {
      if (result.kind === "accepted") await redis.eval("if redis.call('HGET', KEYS[1], 'probe') == ARGV[1] then redis.call('DEL', KEYS[1]) end return 1", [stateKey], [probeToken]);
      else await redis.eval("if redis.call('HGET', KEYS[1], 'probe') == ARGV[1] then redis.call('HSET', KEYS[1], 'until', ARGV[2]); redis.call('HDEL', KEYS[1], 'probe', 'probeUntil') end return 1", [stateKey], [probeToken, Date.now() + 60_000]);
    }
  } catch { console.warn("[email] Could not update provider cooldown; recipient state remains durable"); }
}
