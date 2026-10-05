/**
 * Auth.js v5 cookie-based authentication for Hono.
 *
 * Architecture:
 * - `@hono/auth-js` uses `@auth/core` to decrypt and verify the frontend's
 *   encrypted session cookie with the shared `AUTH_SECRET`.
 * - Browser API requests use the frontend's `/api/backend/*` proxy; server-side
 *   frontend requests must forward their Auth.js cookies to this backend.
 * - Global authentication in `app.ts` runs before JSON body parsing because
 *   Auth.js wraps the raw request and needs its body to remain unconsumed.
 *
 * Cookie handling:
 * Auth.js uses `authjs.session-token` for plain HTTP and
 * `__Secure-authjs.session-token` for secure cookies, including local HTTPS.
 * Large tokens may be split into numbered chunks. Cache fingerprints and
 * rejection cleanup include the actual names/chunks sent by the client rather
 * than inferring a cookie name from TLS behind a proxy. Auth.js itself remains
 * responsible for token verification.
 *
 * Identity and user-creation policy:
 * Sign-in endpoints create/update users and issue a tracked backend session.
 * Cookies must carry canonical backend `userId` and `sessionId` UUIDs; email
 * and a provider subject are not substitutes. This middleware only looks up
 * that session and its owner. Missing users/sessions or legacy cookies require
 * reauthentication; they never trigger fallback user or session creation.
 *
 * Cache boundary:
 * Only immutable decoded claims may be reused. Every request independently
 * checks session existence, ownership, and current ban status on the primary
 * store, so decoding reuse cannot extend a revoked session's authorization.
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { getAuthUser } from "@hono/auth-js";
import type { AuthUser } from "../types/express.js";
import { updateSessionMetadata } from "../services/session-manager.js";
import { loadWebSession } from "../services/web-session.js";
import { getClientIp } from "../hono/express-shim.js";
import { isEmailVerified } from "../utils/email-verification.js";
import { isValidUuid } from "../utils/uuid.js";
import { AuthPolicyError } from "../utils/auth-error.js";
import { dbRead } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import type { AppEnv } from "../hono/env.js";
import { hashSHA256 } from "../utils/hash.js";
import { CPU_OPTIMIZATIONS_ENABLED } from "../config/cpu-optimizations.js";

/** Verified cookie claims only; mutable profile and authorization data are excluded. */
interface DecodedIdentity { id: string; sessionId: string; expiresAt: number }

// A bounded, instance-local 60-second LRU avoids repeated JWE work on polling
// routes. Keys hash the sorted cookie names/values, including numbered chunks;
// the cache retains neither plaintext cookies nor a previously authorized user.
// The token's own expiry is checked separately, even while an LRU entry is fresh.
const decodedCache = new LRUCache<string, DecodedIdentity>({ max: 5000, ttl: 60_000 });

// Single-flight decoding is keyed by the cookie fingerprint, not email/userId:
// different device sessions must never share session attribution. Only crypto
// work is coalesced; the primary-store authorization lookup stays per request.
// This map still deduplicates concurrent decodes when LRU reuse is disabled.
const decoding = new Map<string, Promise<DecodedIdentity | null>>();

// Device metadata is advisory: reserve one write per session/minute on this
// instance, including concurrent requests. This cache never answers an auth
// check; session existence, ownership and standing are still read every time.
const metadataUpdates = new LRUCache<string, boolean>({ max: 5000, ttl: 60_000 });

/** Schedules throttled device tracking independently of authorization. */
export function scheduleSessionMetadata(c: Context<AppEnv>, sessionId: string): void {
  if (metadataUpdates.has(sessionId)) return;
  metadataUpdates.set(sessionId, true);
  const task = updateSessionMetadata(sessionId, c.req.header("user-agent") ?? null, getClientIp(c))
    .catch(() => {
      metadataUpdates.delete(sessionId); // Allow a later request to retry a failed write.
      console.error("[nextauth] Session metadata update failed");
    });
  try {
    // The Netlify adapter supplies waitUntil so work can finish after response.
    c.executionCtx.waitUntil(task);
  } catch {
    // Bun/test and legacy adapters may have no execution context. The handled
    // promise remains best-effort there; metadata never blocks or grants access.
  }
}

/**
 * Compatibility hook for moderation callers that previously evicted a ban LRU.
 *
 * Ban status is now read from the primary store on every cookie-authenticated
 * request, so there is no cached authorization to invalidate. Retaining the
 * export keeps those callers compatible without recreating a stale trust window.
 *
 * @param _userId - User whose former ban-cache entry would have been evicted.
 */
export function invalidateUserBanCache(_userId: string): void {}

/**
 * Collects plain/secure Auth.js session cookies and their numbered chunks.
 *
 * Sorting makes the decode-cache fingerprint independent of cookie-header order;
 * names remain part of the fingerprint so different cookie layouts cannot share
 * an entry. This helper does not decrypt or choose a session token.
 *
 * @param c - Request context containing the browser's forwarded Cookie header.
 * @returns Matching cookie names and raw values, sorted by name.
 */
function sessionCookies(c: Context<AppEnv>): Array<{ name: string; value: string }> {
  return (c.req.header("cookie") ?? "").split(";").flatMap(part => {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator).trim();
    return /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)
      ? [{ name, value: part.slice(separator + 1) }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Expires every session-cookie name/chunk actually supplied by this request.
 *
 * Secure-prefixed cookies retain the Secure attribute on deletion. Append each
 * Set-Cookie header so chunk cleanup does not overwrite another cookie response;
 * a request with no matching cookies produces no deletion headers.
 */
function clearSessionCookies(c: Context<AppEnv>): void {
  for (const { name } of sessionCookies(c)) {
    c.header("Set-Cookie", name + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" +
      (name.startsWith("__Secure-") ? "; Secure" : ""), { append: true });
  }
}

/**
 * Evicts decoded claims for the session cookies carried by this request.
 *
 * Logout callers must also delete the authoritative session row. Eviction is
 * local to this instance and does not cancel an in-flight decode; the fresh
 * session lookup, rather than cache eviction, enforces revocation everywhere.
 *
 * @param c - Request context used to compute the same fingerprint as verification.
 */
export async function invalidateCurrentSessionVerifyCache(c: Context<AppEnv>): Promise<void> {
  const cookies = sessionCookies(c);
  if (cookies.length) decodedCache.delete(await hashSHA256(JSON.stringify(cookies)));
}

/**
 * Extracts canonical backend IDs and expiry from Auth.js-verified JWT claims.
 * Session/profile callback fields and provider subjects are not identity sources.
 *
 * @returns Minimal verified claims, or null for missing, legacy, or expired claims.
 * @throws Auth.js decoding errors; the caller normalizes these to invalid identity.
 */
async function decodeIdentity(c: Context<AppEnv>): Promise<DecodedIdentity | null> {
  const verified = await getAuthUser(c);
  const token = verified?.token;
  if (!token || !isValidUuid(token.userId) || !isValidUuid(token.sessionId) ||
      typeof token.exp !== "number" || token.exp * 1000 <= Date.now()) return null;
  return { id: token.userId, sessionId: token.sessionId, expiresAt: token.exp * 1000 };
}

/**
 * Resolves an Auth.js cookie to a currently authorized backend device session.
 *
 * Flow:
 * 1. Reuse unexpired decoded claims, or single-flight the JWE decode for this cookie.
 * 2. Validate the session ID and user ID together against the primary store.
 * 3. Reject missing/revoked sessions and currently banned accounts.
 * 4. Schedule a throttled, non-blocking metadata update for this device session.
 * 5. Return current user fields from the database, not a cached AuthUser.
 *
 * @remarks
 * Call after `initAuthConfig` and before any middleware consumes the request body.
 * The global middleware in `app.ts` handles this once; route guards reuse the
 * resolved context identity. Authorization must stay outside both decode caches
 * and the shared promise, including when CPU optimizations are enabled.
 * Legacy cookies without canonical IDs fail closed and require a new sign-in.
 *
 * @param c - Hono request context configured for Auth.js cookie verification.
 * @returns Current backend user/session identity, or null when no session cookie
 *   was supplied or AUTH_SECRET is unavailable.
 * @throws AuthPolicyError with 401/auth.sessionRevoked for invalid, expired, or
 *   missing sessions; sent session cookies are cleared in these rejection paths.
 * @throws AuthPolicyError with 403/auth.accountBanned for a currently banned user.
 * @throws Primary-store lookup failures, propagated to the global error handler
 *   rather than converted into an authorized user or an anonymous request.
 */
export async function verifyNextAuthToken(c: Context<AppEnv>): Promise<AuthUser | null> {
  if (!process.env.AUTH_SECRET || !sessionCookies(c).length) return null;
  const key = await hashSHA256(JSON.stringify(sessionCookies(c)));
  let identity = CPU_OPTIMIZATIONS_ENABLED ? decodedCache.get(key) : undefined;
  if (!identity || identity.expiresAt <= Date.now()) {
    let pending = decoding.get(key);
    if (!pending) {
      pending = decodeIdentity(c).catch(() => null).finally(() => decoding.delete(key));
      decoding.set(key, pending);
    }
    identity = await pending ?? undefined;
    if (identity && CPU_OPTIMIZATIONS_ENABLED) decodedCache.set(key, identity);
  }
  if (!identity) {
    decodedCache.delete(key);
    clearSessionCookies(c);
    throw new AuthPolicyError(401, "auth.sessionRevoked", "Session expired or invalid");
  }
  // Keep this gate outside the decode LRU and shared promise: a warm cookie can
  // outlive its session row, and different concurrent requests need fresh checks.
  const row = await loadWebSession(identity.sessionId, identity.id);
  if (!row) {
    decodedCache.delete(key);
    clearSessionCookies(c);
    throw new AuthPolicyError(401, "auth.sessionRevoked", "Session revoked");
  }
  if (row.bannedAt) throw new AuthPolicyError(403, "auth.accountBanned", "account_banned");
  // Metadata is advisory, not an authorization prerequisite. Attribute it to
  // the verified device session; a write failure must not undo a successful gate.
  scheduleSessionMetadata(c, identity.sessionId);
  return { id: row.userId, email: row.email, name: row.name ?? undefined, sessionId: identity.sessionId };
}

// ---------------------------------------------------------------------------
// Middleware wrappers
// ---------------------------------------------------------------------------

/**
 * Requires an identity already resolved by global cookie or bearer authentication.
 *
 * @remarks
 * The cookie session or bearer identity is already verified by global auth in
 * `app.ts` (which runs before body parsing). This middleware only guards
 * the route — if no userId was resolved, it throws 401.
 *
 * Attaching user / userId on the context was already done by the global
 * auth middleware, so this middleware avoids calling getAuthUser again.
 *
 * Throws 401 if authentication is not present.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("userId")) {
    throw new HTTPException(401, { message: "Authentication required" });
  }
  await next();
});

/**
 * Pass-through that preserves backward compatibility.
 *
 * @remarks
 * The global auth middleware in `app.ts` already resolves the session and
 * sets userId on the context if valid. Route handlers that called
 * `optionalAuth` to detect guest vs. authenticated users work identically
 * because `c.get("userId")` was already populated upstream.
 * Invalid/revoked-cookie policy errors are still enforced by global auth;
 * this pass-through does not turn those failures into anonymous access.
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  await next();
});

/**
 * Requires the authenticated user's email to be verified.
 *
 * @remarks
 * Use after `requireAuth`: global authentication populates `userId`, while
 * `requireAuth` rejects guests. This guard deliberately passes guests through
 * and cannot enforce authentication by itself.
 *
 * Unverified users within a 72-hour grace period from account creation are
 * allowed through so onboarding is not blocked. After the grace period, a
 * 403 is returned.
 *
 * Throws 403 if the user's email is not verified and the grace period has
 * expired.
 *
 * @example
 * ```typescript
 * import { requireAuth, requireVerifiedEmail } from "../middleware/nextauth.js";
 *
 * router.post("/checkin", requireAuth, requireVerifiedEmail, (c) => handleCheckIn(c));
 * ```
 */
export const requireVerifiedEmail = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    // Let requireAuth handle this — no userId means no authentication
    return await next();
  }

  const verified = await isEmailVerified(userId);
  if (verified) return await next();

  // Grace period: 72 hours from account creation
  const [userRow] = await dbRead
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (userRow?.createdAt) {
    const msSinceCreation = Date.now() - new Date(userRow.createdAt).getTime();
    if (msSinceCreation < GRACE_PERIOD_MS) return await next();
  }

  throw new HTTPException(403, {
    message: "Email verification required. Please verify your email address before performing this action.",
  });
});

const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000; // 72 hours
