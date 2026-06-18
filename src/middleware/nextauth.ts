/**
 * NextAuth v5 Cookie-Based Authentication Middleware
 *
 * Verifies Auth.js session cookies using @auth/express and resolves the
 * request to a backend userId.
 *
 * Architecture:
 * - Uses @auth/express getSession() to decrypt/verify Auth.js JWE cookies
 * - AUTH_SECRET must be shared between Next.js (frontend) and Express (backend)
 * - Next.js rewrites proxy /api/backend/* requests, so the browser sends
 *   cookies automatically (same-origin from the browser's perspective)
 *
 * Cookie Name Alignment:
 * @auth/express getSession() auto-detects which cookie to look for by
 * inspecting the request URL scheme:
 * - HTTP → 'authjs.session-token',
 * - HTTPS → '__Secure-authjs.session-token'.
 * 
 * When Express sits behind a proxy:
 * that terminates TLS (Next.js rewrite → Express over plain HTTP internally),
 * it sees HTTP and looks for 'authjs.session-token' — even though the frontend
 * wrote '__Secure-authjs.session-token' because DEV_USE_SECURE_COOKIES=true
 * or NODE_ENV=production.
 *
 * Fix: explicitly pass cookies.sessionToken.name to getSession(), derived from
 * the same NODE_ENV / DEV_USE_SECURE_COOKIES env vars the frontend uses. Both
 * processes share .env, so the names stay in sync automatically.
 *
 * User Creation Policy:
 * Users are created in the backend database at sign-in time via the
 * dedicated endpoints called from the NextAuth jwt() callback:
 *   - POST /auth/google-oauth   — standard Google OAuth
 *   - POST /auth/google-one-tap — Google One Tap
 *   - POST /auth/signup         — email/password registration
 *
 * This middleware therefore operates primarily as a **lookup** — it finds
 * the userId for the verified email. It retains a fallback creation path
 * for edge cases (e.g., DB reset with valid cookies still in-flight), but
 * this path is not expected to fire in normal operation.
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../types/express.js';
import { getSession, type Session, type User } from '@auth/express';
import { handleUnauthorizedError } from '../utils/error.js';
import { createOrUpdateOAuthUser } from '../services/user-controller.js';
import { updateSessionMetadata } from '../services/session-manager.js';
import { getUserIdByEmail, invalidateByEmail } from '../services/user.js';
import { DEV_USE_SECURE_COOKIES, IS_PRODUCTION } from '../config/env.js';

// ---------------------------------------------------------------------------
// Cookie name alignment (mirror the logic in the frontend's src/auth.ts)
//
// Without this explicit config, @auth/express auto-detects from the request URL
// scheme and gets it wrong when TLS is terminated at a proxy (Express receives
// plain HTTP internally even in production / local HTTPS).
// ---------------------------------------------------------------------------
const useSecureCookies = IS_PRODUCTION || DEV_USE_SECURE_COOKIES;
const cookieNamePrefix = useSecureCookies ? '__Secure-authjs' : 'authjs';

const AUTH_COOKIE_NAME = `${cookieNamePrefix}.session-token`;

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
 * Verifies the Auth.js session cookie and returns the authenticated user.
 *
 * Flow:
 *   1. Decrypt and verify the session cookie via @auth/express getSession()
 *   2. Extract email from the verified session
 *   3. Deduplicate concurrent requests for the same email
 *   4. Look up userId in the DB (LRU-cached via getUserIdByEmail)
 *   5. If not found: create user as a fallback for edge cases
 *   6. Update session metadata (userAgent, IP) — fire-and-forget, non-blocking
 *   7. Return AuthUser { id, email, name, sessionId }
 *
 * @returns AuthUser if the cookie is valid, null otherwise
 */
export async function verifyNextAuthToken(req: Request): Promise<AuthUser | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error('[nextauth] 💀 AUTH_SECRET is not configured');
    return null;
  }

  // ── 1. Verify session cookie ───────────────────────────────────────────────
  let session: Session | null;
  try {
    session = await getSession(req, {
      providers: [], // Backend only verifies; it doesn't handle OAuth flows
      trustHost: true, // Trust x-forwarded-* headers set by Vercel, AWS, Docker, etc.
      secret,
      // Explicit cookie name — prevents auto-detection mismatch when TLS is
      // terminated at a proxy and Express sees plain HTTP internally.
      // Value is computed from the same env vars as the frontend (src/auth.ts),
      // so they always stay in sync.
      cookies: {
        sessionToken: {
          name: AUTH_COOKIE_NAME,
          options: {
            httpOnly: true,
            sameSite: useSecureCookies ? 'none' : 'lax',
            secure: useSecureCookies,
            path: '/',
          },
        },
      },
    });
  } catch (error) {
    console.error('[nextauth] ❌ getSession error:', error);
    return null;
  }

  if (!session?.user?.email) {
    // ── Diagnostic logging — three distinct failure modes ──────────────────
    //
    //  (a) No cookies at all
    //      → Cookie header not forwarded by Next.js rewrite / proxy.
    //        Check next.config.js rewrites and any stripping middleware.
    //
    //  (b) Cookie present but wrong name
    //      → NODE_ENV or DEV_USE_SECURE_COOKIES differs between frontend and
    //        backend. Both processes must read from the same .env.
    //
    //  (c) Correct cookie present but session is still null
    //      → AUTH_SECRET mismatch between frontend and backend, or the token
    //        has genuinely expired.

    const incomingCookieNames = req.headers.cookie
      ? req.headers.cookie.split(';').map(c => c.trim().split('=')[0])
      : [];

    console.log('[verifyNextAuthToken] ✨ No valid session found');
    console.log(`[verifyNextAuthToken] 🍪 Expected cookie: "${AUTH_COOKIE_NAME}"`);

    if (incomingCookieNames.length === 0) {
      console.log(
        '[verifyNextAuthToken] ⏩ (a) No cookies in request — ' +
        'Cookie header not forwarded by Next.js rewrite or upstream proxy.',
      );
    } else if (!incomingCookieNames.includes(AUTH_COOKIE_NAME)) {
      console.warn(
        `[verifyNextAuthToken] ⚠️ (b) Cookie name mismatch — ` +
        `request has [${incomingCookieNames.join(', ')}] ` +
        `but expected "${AUTH_COOKIE_NAME}". ` +
        `Ensure NODE_ENV and DEV_USE_SECURE_COOKIES are identical on frontend and backend.`,
      );
    } else {
      console.warn(
        `[verifyNextAuthToken] ⚠️ (c) Cookie "${AUTH_COOKIE_NAME}" is present but could not be decoded — ` +
        `check that AUTH_SECRET matches between frontend and backend, or whether the token has expired.`,
      );
    }

    return null;
  }

  // ── 2. Extract session fields ──────────────────────────────────────────────
  const email     = session.user.email as string;
  const name      = session.user.name  as string | undefined;
  const image     = session.user.image as string | undefined;
  const sessionId = (session.user as User & { sessionId?: string }).sessionId;

  // ── 3. Deduplicate concurrent in-flight verifications ─────────────────────
  const existing = inFlightRequests.get(email);
  if (existing) return existing;

  const verificationPromise = (async (): Promise<AuthUser | null> => {
    try {
      // ── 4. Resolve userId ──────────────────────────────────────────────────
      let userId = await getUserIdByEmail(email);

      if (!userId) {
        // ── 5. Fallback: user missing from DB ────────────────────────────────
        // Expected only in edge cases (DB reset, data inconsistency).
        // In normal operation, users are created at sign-in time by the
        // /auth/google-oauth or /auth/google-one-tap endpoints.
        console.warn(`[nextauth] ⚠️ User not found for verified email: ${email} — creating fallback`);
        userId = await createOrUpdateOAuthUser({ email, name, image });
        // Invalidate LRU cache so the new userId is picked up on the next call
        invalidateByEmail(email);
      }

      // ── 6. Update session metadata (fire-and-forget) ───────────────────────
      // Non-blocking: a failure here should never fail the request.
      if (sessionId) {
        updateSessionMetadata(
          sessionId,
          req.headers['user-agent'] ?? null,
          req.ip ?? req.socket.remoteAddress ?? null,
        ).catch(err => {
          console.error('[nextauth] ❌ Session metadata update failed:', err);
        });
      }

      // ── 7. Return resolved user ────────────────────────────────────────────
      return { id: userId, email, name, sessionId };

    } finally {
      // Always clean up the in-flight entry so the next request goes through
      // the normal path (not stuck waiting for a stale promise).
      inFlightRequests.delete(email);
    }
  })();

  // Store the promise in the cache
  inFlightRequests.set(email, verificationPromise);
  return verificationPromise;
}

// ---------------------------------------------------------------------------
// Middleware wrappers
// ---------------------------------------------------------------------------

/**
 * Requires a valid Auth.js session. Attaches req.user and req.userId.
 * Returns 401 if the cookie is absent, expired, or invalid.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 *
 * @example
 * router.get('/protected', requireAuth, (req, res) => {
 *   res.json({ userId: req.userId });
 * });
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await verifyNextAuthToken(req);
  if (!user) return handleUnauthorizedError(res, 'Authentication required');

  req.user = user;
  req.userId = user.id;
  next();
}

/**
 * Optionally verifies the session. Attaches req.user / req.userId when valid,
 * but always calls next(). Use for endpoints that serve both guests and
 * authenticated users with different response shapes.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 *
 * @example
 * router.get('/public', optionalAuth, (req, res) => {
 *   if (req.user) {
 *     res.json({ message: `Hello ${req.user.name}` });
 *   } else {
 *     res.json({ message: 'Hello, guest' });
 *   }
 * });
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await verifyNextAuthToken(req);
  if (user) {
    req.user = user;
    req.userId = user.id;
  }
  next();
}