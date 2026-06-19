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
 * Cookie Name Detection:
 * Auth.js v5 uses one of two session-token cookie names depending on the
 * frontend's IS_PRODUCTION || DEV_USE_SECURE_COOKIES flag:
 *   - '__Secure-authjs.session-token'  (production / local HTTPS)
 *   - 'authjs.session-token'           (plain HTTP development)
 *
 * Rather than mirroring that env-var logic here (error-prone across separate
 * projects, frameworks, and deployment domains), we inspect the incoming Cookie
 * header and use whichever variant is actually present. Security is unaffected:
 * the JWT is still validated against AUTH_SECRET regardless of the name we look
 * it up under — the name is just a key, not a trust boundary.
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

// ---------------------------------------------------------------------------
// Cookie name detection
//
// Auth.js v5 writes the session token under one of these two names,
// depending on whether the frontend runs with secure cookies enabled.
// We detect which one is present rather than mirroring the frontend's env
// config, which would require keeping two separate projects in sync.
// ---------------------------------------------------------------------------
const SESSION_COOKIE_SECURE = '__Secure-authjs.session-token';
const SESSION_COOKIE_PLAIN  = 'authjs.session-token';

/**
 * Returns the name of whichever Auth.js session-token cookie is present in
 * the Cookie header, or null if neither is found.
 *
 * Prefers the secure variant when both are present — this shouldn't happen
 * in practice, but handles edge cases such as a client whose cookie jar
 * still holds an old plain cookie after the environment was switched to HTTPS.
 */
function detectSessionCookieName(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const names = new Set(cookieHeader.split(';').map(c => c.trim().split('=')[0]));
  if (names.has(SESSION_COOKIE_SECURE)) return SESSION_COOKIE_SECURE;
  if (names.has(SESSION_COOKIE_PLAIN))  return SESSION_COOKIE_PLAIN;
  return null;
}

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
 *   1. Detect which session-token cookie variant is present in the request
 *   2. Decrypt and verify it via @auth/express getSession()
 *   3. Extract email from the verified session
 *   4. Deduplicate concurrent requests for the same email
 *   5. Look up userId in the DB (LRU-cached via getUserIdByEmail)
 *   6. If not found: create user as a fallback for edge cases
 *   7. Update session metadata (userAgent, IP) — fire-and-forget, non-blocking
 *   8. Return AuthUser { id, email, name, sessionId }
 *
 * @returns AuthUser if the cookie is valid, null otherwise
 */
export async function verifyNextAuthToken(req: Request): Promise<AuthUser | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error('[nextauth] 💀 AUTH_SECRET is not configured');
    return null;
  }

  // ── 1. Detect which session cookie is present ──────────────────────────────
  const detectedCookieName = detectSessionCookieName(req.headers.cookie);

  if (!detectedCookieName) {
    // No session cookie at all — nothing to verify.
    // Common causes:
    //   • Unauthenticated request (guest) — completely normal
    //   • Cookie header stripped by Next.js rewrite or upstream proxy
    //   • Client is sending to the wrong domain / path
    const presentNames = req.headers.cookie
      ? req.headers.cookie.split(';').map(c => c.trim().split('=')[0]).join(', ')
      : 'none';
    console.log(
      `[verifyNextAuthToken] 🍪 No session cookie found. ` +
      `Looked for: ["${SESSION_COOKIE_SECURE}", "${SESSION_COOKIE_PLAIN}"]. ` +
      `Present cookies: [${presentNames}]`,
    );
    return null;
  }

  // ── 2. Decrypt and verify the session cookie ───────────────────────────────
  let session: Session | null;
  try {
    session = await getSession(req, {
      providers: [], // Backend only verifies; it doesn't handle OAuth flows
      trustHost: true, // Trust x-forwarded-* headers set by Vercel, AWS, Docker, etc.
      secret,
      // Use the detected cookie name so @auth/express looks in exactly the
      // right place — bypassing its own environment-based auto-detection,
      // which fails when TLS is terminated at a proxy (Express sees plain HTTP
      // internally even though the frontend set a __Secure-prefixed cookie).
      cookies: {
        sessionToken: {
          name: detectedCookieName,
          // options are only relevant when Auth.js *writes* cookies (SetCookie
          // response header). For read-only verification they have no effect,
          // but we keep them accurate for completeness.
          options: {
            httpOnly: true,
            sameSite: detectedCookieName === SESSION_COOKIE_SECURE ? 'none' : 'lax',
            secure:   detectedCookieName === SESSION_COOKIE_SECURE,
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
    // Cookie was detected but could not be decoded. Most likely causes:
    //   • AUTH_SECRET differs between frontend and backend
    //   • Token has expired
    //   • Token was issued by a different Auth.js instance (e.g. staging vs prod)
    console.warn(
      `[verifyNextAuthToken] ⚠️ Cookie "${detectedCookieName}" is present but could not be decoded — ` +
      `check that AUTH_SECRET is identical on frontend and backend, and that the token has not expired.`,
    );
    return null;
  }

  // ── 3. Extract session fields ──────────────────────────────────────────────
  const email     = session.user.email as string;
  const name      = session.user.name  as string | undefined;
  const image     = session.user.image as string | undefined;
  const sessionId = (session.user as User & { sessionId?: string }).sessionId;

  // ── 4. Deduplicate concurrent in-flight verifications ─────────────────────
  const existing = inFlightRequests.get(email);
  if (existing) return existing;

  const verificationPromise = (async (): Promise<AuthUser | null> => {
    try {
      // ── 5. Resolve userId ──────────────────────────────────────────────────
      let userId = await getUserIdByEmail(email);

      if (!userId) {
        // ── 6. Fallback: user missing from DB ────────────────────────────────
        // Expected only in edge cases (DB reset, data inconsistency).
        // In normal operation, users are created at sign-in time by the
        // /auth/google-oauth or /auth/google-one-tap endpoints.
        console.warn(`[nextauth] ⚠️ User not found for verified email: ${email} — creating fallback`);
        userId = await createOrUpdateOAuthUser({ email, name, image });
        // Invalidate LRU cache so the new userId is picked up on the next call
        invalidateByEmail(email);
      }

      // ── 7. Update session metadata (fire-and-forget) ───────────────────────
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

      // ── 8. Return resolved user ────────────────────────────────────────────
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