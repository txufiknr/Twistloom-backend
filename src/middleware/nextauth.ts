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
 * @remarks Auth.js v5 + Hono Compatibility
 * This function is safe to call before or after body-parsing middleware.
 * The global auth middleware in `app.ts` runs **before** `parseJsonBody`,
 * so `getAuthUser` always receives a pristine, unconsumed request body.
 *
 * Flow:
 *   1. Verify the session cookie through @hono/auth-js getAuthUser() (which
 *      delegates to @auth/core getSession).
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
    // The global auth middleware in app.ts runs before parseJsonBody, so the
    // request body is still pristine when getAuthUser wraps it. No workaround
    // for the "disturbed or locked" body error is needed here.
    authUser = await getAuthUser(c);
  } catch (error) {
    console.error("[nextauth] ❌ getAuthUser error:", error);
    return null;
  }

  // The decoded session exposes the user in two shapes:
  //   - `authUser.user`  : the full AdapterUser/token subject (ALWAYS includes email)
  //   - `authUser.session.user` : the object returned by the frontend's `session()`
  //     callback, which may omit `email` (common with the JWT strategy + a custom
  //     session callback that only copies name/image).
  // Prefer `authUser.user` and fall back to `session.user` so a valid session is
  // never rejected just because the frontend stripped email from `session.user`.
  // This also matches how the previous @auth/express integration resolved the user.
  const resolvedUser = authUser?.user ?? authUser?.session?.user;
  const email = resolvedUser?.email as string | undefined;
  if (!email) {
    console.warn(
      "[verifyNextAuthToken] ⚠️ Session present but could not be decoded — " +
        "check that AUTH_SECRET is identical on frontend and backend, and that the token has not expired.",
    );
    return null;
  }

  const name = resolvedUser?.name as string | undefined;
  const image = (resolvedUser as { image?: string }).image as string | undefined;
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
 * Requires a valid Auth.js session.
 *
 * @remarks
 * The user/session is already verified by the global auth middleware in
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
 */
export const optionalAuth = createMiddleware<AppEnv>(async (c, next) => {
  await next();
});
