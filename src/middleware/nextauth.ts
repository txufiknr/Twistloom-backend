/**
 * NextAuth v5 Cookie-Based Authentication Middleware (Hono)
 *
 * Verifies Auth.js session cookies and resolves the request to a backend userId.
 *
 * Architecture:
 * - Uses @hono/auth-js `getAuthUser()` to decrypt/verify Auth.js JWE cookies
 *   (built on the runtime-agnostic @auth/core, the same engine as @auth/express).
 * - AUTH_SECRET must be shared between Next.js (frontend) and this backend.
 * - Next.js rewrites proxy /api/backend/* requests, so the browser sends
 *   cookies automatically (same-origin from the browser's perspective).
 *
 * Cookie Name Detection:
 * Auth.js v5 uses one of two session-token cookie names depending on the
 * frontend's secure-cookie setting:
 *   - '__Secure-authjs.session-token'  (production / local HTTPS)
 *   - 'authjs.session-token'           (plain HTTP development)
 *
 * @hono/auth-js (via @auth/core `getSession`) already auto-detects the correct
 * cookie name based on the request's secure context, so we no longer need the
 * manual detection logic the old @auth/express integration required. The JWT is
 * validated against AUTH_SECRET regardless of the cookie name.
 *
 * User Creation Policy:
 * Users are created in the backend database at sign-in time via the dedicated
 * endpoints called from the NextAuth jwt() callback. This middleware operates
 * primarily as a **lookup** — it finds the userId for the verified email. It
 * retains a fallback creation path for edge cases (e.g., DB reset with valid
 * cookies still in-flight), but this path is not expected to fire in normal
 * operation.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AuthUser as AuthJsUser } from "@hono/auth-js";
import { getAuthUser } from "@hono/auth-js";
import type { AuthUser } from "../types/express.js";
import { createOrUpdateOAuthUser } from "../services/user-controller.js";
import { updateSessionMetadata } from "../services/session-manager.js";
import { getUserIdByEmail, invalidateByEmail } from "../services/user.js";
import { getClientIp } from "../hono/express-shim.js";
import type { AppEnv } from "../hono/env.js";

// @auth/express is no longer imported; @hono/auth-js (built on @auth/core) is
// used instead. The `getClientIp` helper remains from the shared shim module.

// ---------------------------------------------------------------------------
// In-flight request deduplication
//
// Prevents a race condition where two concurrent requests arriving just after
// login both see a cache miss and race to create the same user.
// Maps email → Promise<AuthUser | null> for in-progress verifications.
// ---------------------------------------------------------------------------
const inFlightRequests = new Map<string, Promise<AuthUser | null>>();

// ---------------------------------------------------------------------------
// verifyNextAuthToken
// ---------------------------------------------------------------------------

/**
 * Verifies the Auth.js session cookie via @hono/auth-js and resolves the
 * authenticated backend user.
 *
 * Flow:
 *   1. Verify the session cookie through @hono/auth-js getAuthUser() (which
 *      delegates to @auth/core getSession — handling secure/plain cookie names).
 *   2. Extract email from the verified session.
 *   3. Deduplicate concurrent requests for the same email.
 *   4. Look up userId in the DB (LRU-cached via getUserIdByEmail).
 *   5. If not found: create user as a fallback for edge cases.
 *   6. Update session metadata (userAgent, IP) — fire-and-forget, non-blocking.
 *   7. Return AuthUser { id, email, name, sessionId }.
 *
 * @param c - Hono context
 * @returns AuthUser if the cookie is valid, null otherwise
 */
export async function verifyNextAuthToken(c: Context<AppEnv>): Promise<AuthUser | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error("[nextauth] 💀 AUTH_SECRET is not configured");
    return null;
  }

  let authUser: AuthJsUser | null;
  try {
    // Relies on `initAuthConfig` having been mounted in app.ts, which sets the
    // Auth.js config (secret + trustHost) on the context as `authConfig`.
    authUser = await getAuthUser(c);
  } catch (error) {
    console.error("[nextauth] ❌ getAuthUser error:", error);
    return null;
  }

  const sessionUser = authUser?.session?.user;
  if (!sessionUser?.email) {
    console.warn(
      "[verifyNextAuthToken] ⚠️ Session present but could not be decoded — " +
        "check that AUTH_SECRET is identical on frontend and backend, and that the token has not expired.",
    );
    return null;
  }

  const email = sessionUser.email as string;
  const name = sessionUser.name as string | undefined;
  const image = (sessionUser as { image?: string }).image as string | undefined;
  const sessionId = (authUser?.token as { sessionId?: string } | undefined)?.sessionId;

  // ── Deduplicate concurrent in-flight verifications ─────────────────────
  const existing = inFlightRequests.get(email);
  if (existing) return existing;

  const verificationPromise = (async (): Promise<AuthUser | null> => {
    try {
      let userId = await getUserIdByEmail(email);

      if (!userId) {
        console.warn(`[nextauth] ⚠️ User not found for verified email: ${email} — creating fallback`);
        userId = await createOrUpdateOAuthUser({ email, name, image });
        invalidateByEmail(email);
      }

      if (sessionId) {
        updateSessionMetadata(
          sessionId,
          c.req.header("user-agent") ?? null,
          getClientIp(c),
        ).catch((err) => {
          console.error("[nextauth] ❌ Session metadata update failed:", err);
        });
      }

      return { id: userId, email, name, sessionId };
    } finally {
      inFlightRequests.delete(email);
    }
  })();

  inFlightRequests.set(email, verificationPromise);
  return verificationPromise;
}

// ---------------------------------------------------------------------------
// Middleware wrappers
// ---------------------------------------------------------------------------

/**
 * Requires a valid Auth.js session. Attaches userId / user to the context.
 * Throws 401 if the cookie is absent, expired, or invalid.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await verifyNextAuthToken(c);
  if (!user) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  c.set("user", user);
  c.set("userId", user.id);
  await next();
});

/**
 * Optionally verifies the session. Attaches user / userId to the context when
 * valid, but always proceeds. Use for endpoints that serve both guests and
 * authenticated users with different response shapes.
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await verifyNextAuthToken(c);
  if (user) {
    c.set("user", user);
    c.set("userId", user.id);
  }
  await next();
});
