/**
 * Bearer auth middleware (Step 5 — native face).
 *
 * When `Authorization: Bearer <mobile access JWT>` is present, verifies the
 * token (jose HS256), enforces revocation (`tokenVersion` + ban + session row),
 * and attaches `userId` / `user` on the Hono context — same shape as the
 * cookie path so `requireAuth` and all routes work unchanged.
 *
 * Cookie path is untouched: when no Authorization header is present, this
 * middleware is a no-op and `verifyNextAuthToken` (cookie) continues to run.
 *
 * Service-bearer exemption: `/api/cron/*` uses `Authorization: Bearer <CRON_SECRET>`
 * (see `src/routes/cron.ts`). Those paths must skip user-JWT verification so
 * inbound cron jobs are not rejected as "invalid token".
 *
 * Performance: a short-TTL process LRU keyed by SHA-256(raw token) skips
 * JWT verify + DB lookups for the same token within the window (CPU savings
 * for hot authenticated routes). Gated by `CPU_OPTIMIZATIONS_ENABLED`. The
 * cache stores only `{userId, email, claims}` after a full successful verify;
 * logout invalidates the presented token immediately via `invalidateBearerCache`.
 */

import type { Context, Next } from "hono";
import { LRUCache } from "lru-cache";
import {
  verifyAccessToken,
  loadUserForBearer,
  toAuthUserFromBearer,
  touchBearerSession,
  sessionRowExistsFresh,
  type MobileAccessTokenClaims,
} from "../services/mobile-tokens.js";
import { hashSHA256 } from "../utils/hash.js";
import { CPU_OPTIMIZATIONS_ENABLED } from "../config/cpu-optimizations.js";

/** Cache TTL for verified bearer identity (≤15s per roadmap). */
const BEARER_CACHE_TTL_MS = 15_000;
const BEARER_CACHE_MAX = 5_000;

interface BearerCacheEntry {
  userId: string;
  email: string;
  claims: MobileAccessTokenClaims;
}

const bearerCache = new LRUCache<string, BearerCacheEntry>({
  max: BEARER_CACHE_MAX,
  ttl: BEARER_CACHE_TTL_MS,
  updateAgeOnGet: true,
});

/**
 * Returns a cache key for a raw bearer token (never stores the plaintext token).
 * Returns null when CPU optimizations are disabled (always-fresh path).
 */
async function bearerCacheKey(token: string): Promise<string | null> {
  if (!CPU_OPTIMIZATIONS_ENABLED) return null;
  return hashSHA256(token);
}

/** Reads a cached bearer identity for this token, if present. */
export async function getCachedBearerIdentity(
  token: string,
): Promise<BearerCacheEntry | null> {
  const key = await bearerCacheKey(token);
  if (!key) return null;
  return bearerCache.get(key) ?? null;
}

/** Writes a verified bearer identity into the short-TTL cache. */
export async function setCachedBearerIdentity(
  token: string,
  entry: BearerCacheEntry,
): Promise<void> {
  const key = await bearerCacheKey(token);
  if (!key) return;
  bearerCache.set(key, entry);
}

/**
 * Invalidates the cache entry for a presented token (call on logout so the
 * same token cannot be replayed against a still-warm identity entry).
 */
export async function invalidateBearerCache(token: string): Promise<void> {
  const key = await bearerCacheKey(token);
  if (!key) return;
  bearerCache.delete(key);
}

/** Extracts the raw token from an Authorization header, or null. */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

/** Paths whose Authorization header carries a service secret, not a user JWT. */
export function isServiceBearerPath(pathname: string): boolean {
  return /^\/api\/cron(\/|$)/.test(pathname);
}

/**
 * Global bearer branch. Runs only when an Authorization header is present
 * and the path is not a service-bearer (cron) route.
 */
export async function bearerAuthMiddleware(c: Context, next: Next): Promise<void | Response> {
  const authHeader = c.req.header("authorization");

  if (!authHeader) {
    await next();
    return;
  }

  const pathname = new URL(c.req.url).pathname;
  if (isServiceBearerPath(pathname)) {
    await next();
    return;
  }

  const token = extractBearerToken(authHeader);
  if (!token) {
    await next();
    return;
  }

  // Short-TTL identity cache: skip JWT verify + DB when the same token was
  // verified within the last ≤15s (and CPU optimizations are on).
  const cached = await getCachedBearerIdentity(token);
  if (cached) {
    const authUser = toAuthUserFromBearer(cached.userId, cached.email, cached.claims);
    c.set("user", authUser);
    c.set("userId", cached.userId);
    touchBearerSession(
      cached.claims.sid,
      c.req.header("user-agent") ?? null,
      getClientIpSafe(c),
    );
    await next();
    return;
  }

  const verified = await verifyAccessToken(token);

  if (!verified.ok) {
    if (verified.reason === "expired") {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="token expired"');
      return c.json({ success: false, error: "Token expired" }, 401);
    }
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return c.json({ success: false, error: "Invalid token" }, 401);
  }

  const claims = verified.claims;
  const loaded = await loadUserForBearer(claims);

  if (!loaded.ok) {
    if (loaded.kind === "banned") {
      return c.json({ success: false, error: "Account banned" }, 403);
    }
    c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="revoked"');
    return c.json({ success: false, error: "Token revoked" }, 401);
  }

  if (claims.sid) {
    const exists = await sessionRowExistsFresh(claims.sid);
    if (!exists) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="session revoked"');
      return c.json({ success: false, error: "Session revoked" }, 401);
    }
  }

  // Full verify succeeded — cache identity for the short TTL window.
  await setCachedBearerIdentity(token, {
    userId: loaded.userId,
    email: loaded.email,
    claims,
  });

  const authUser = toAuthUserFromBearer(loaded.userId, loaded.email, claims);
  c.set("user", authUser);
  c.set("userId", loaded.userId);

  touchBearerSession(
    claims.sid,
    c.req.header("user-agent") ?? null,
    getClientIpSafe(c),
  );

  await next();
}

function getClientIpSafe(c: Context): string | null {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? null;
}
