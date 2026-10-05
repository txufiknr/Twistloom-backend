/**
 * Bearer auth middleware (Step 5 — native face).
 *
 * When `Authorization: Bearer <mobile access JWT>` is present, verifies the
 * token (jose HS256), enforces revocation (`tokenVersion` + ban + session row),
 * and attaches `userId` / `user` on the Hono context — same shape as the
 * cookie path so `requireAuth` and all routes work unchanged.
 *
 * Cookie path is untouched when `Authorization` is **absent**: this middleware
 * is a no-op and `verifyNextAuthToken` (cookie) continues to run.
 *
 * **Intentional hard-401 (no cookie fallback) for non-Bearer schemes:**
 * a present `Authorization` header on a non-service path that is *not* a
 * well-formed `Bearer <token>` (e.g. `Basic …`, bare `Bearer`, empty value)
 * **claims bearer intent** and is rejected with `401 Invalid authorization
 * scheme` (+ `WWW-Authenticate: Bearer`) — it never silently falls through to
 * the cookie path. This prevents ambiguous dual-credential identity
 * (mobile contract: reject mixed mechanisms rather than fall back). In-repo
 * callers checked 2026-09-23: only `/api/cron/*` reads inbound `Authorization`
 * (service-bearer exempt below); no known external `Basic`/`Token` clients.
 *
 * Service-bearer exemption: `/api/cron/*` uses `Authorization: Bearer <CRON_SECRET>`
 * (see `src/routes/cron.ts`). Those paths must skip user-JWT verification so
 * inbound cron jobs are not rejected as "invalid token".
 *
 * Performance: a bounded fixed-TTL LRU keyed by SHA-256(raw token) reuses
 * immutable verified claims only. Every hit checks exp and loads the owned
 * session/current user from primary; cache reuse cannot delay revocation.
 * Metadata has a separate minute throttle and Netlify waitUntil scheduling.
 */

import type { Context, Next } from "hono";
import { LRUCache } from "lru-cache";
import { verifyAccessToken, loadUserForBearer, toAuthUserFromBearer, type MobileAccessTokenClaims } from "../services/mobile-tokens.js";
import { hashSHA256 } from "../utils/hash.js";
import { CPU_OPTIMIZATIONS_ENABLED } from "../config/cpu-optimizations.js";
import { scheduleSessionMetadata } from "./nextauth.js";
import type { AppEnv } from "../hono/env.js";

/** Cache TTL for verified bearer identity (≤15s per roadmap). */
const BEARER_CACHE_TTL_MS = 15_000;
const BEARER_CACHE_MAX = 5_000;

interface BearerCacheEntry {
  claims: MobileAccessTokenClaims;
}

const bearerCache = new LRUCache<string, BearerCacheEntry>({
  max: BEARER_CACHE_MAX,
  ttl: BEARER_CACHE_TTL_MS,
  updateAgeOnGet: false,
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
  const entry = bearerCache.get(key);
  if (entry && entry.claims.exp <= Date.now() / 1000) {
    bearerCache.delete(key);
    return null;
  }
  return entry ?? null;
}

/** Writes a verified bearer identity into the short-TTL cache. */
export async function setCachedBearerIdentity(
  token: string,
  entry: BearerCacheEntry,
): Promise<void> {
  const key = await bearerCacheKey(token);
  if (!key) return;
  const remaining = entry.claims.exp * 1000 - Date.now();
  if (remaining > 0) bearerCache.set(key, entry, { ttl: Math.min(BEARER_CACHE_TTL_MS, remaining) });
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
export async function bearerAuthMiddleware(c: Context<AppEnv>, next: Next): Promise<void | Response> {
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
    // Present Authorization on a non-service path but not a well-formed
    // `Bearer <token>` (e.g. `Basic`, bare `Bearer`) claims bearer intent —
    // reject with 401 and never fall back to the cookie path.
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ success: false, error: "Invalid authorization scheme" }, 401);
  }

  // Fixed-TTL verified-claims cache skips crypto only, never primary policy.
  const cached = await getCachedBearerIdentity(token);
  // Reuse signature verification only. Standing and session ownership are
  // primary-store authority on EVERY request, including a warm cache hit.
  const verified = cached ? { ok: true as const, claims: cached.claims }
    : await verifyAccessToken(token);

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
    if (loaded.kind === "session") {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="session revoked"');
      return c.json({ success: false, error: "Session revoked" }, 401);
    }
    c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="revoked"');
    return c.json({ success: false, error: "Token revoked" }, 401);
  }

  // Full verify succeeded — cache identity for the short TTL window.
  if (!cached) await setCachedBearerIdentity(token, { claims });

  const authUser = toAuthUserFromBearer(loaded.userId, loaded.email, claims);
  c.set("user", authUser);
  c.set("userId", loaded.userId);

  scheduleSessionMetadata(c, claims.sid);

  await next();
}

