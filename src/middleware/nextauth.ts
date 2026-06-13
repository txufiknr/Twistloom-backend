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
      trustHost: true, // Trust the domain forwarding headers sent by hosting environments (like Vercel, AWS, or Docker) instead of strictly checking the origin domain.
      secret,
    });
  } catch (error) {
    console.error('[nextauth] ❌ getSession error:', error);
    return null;
  }

  if (!session?.user?.email) {
    // TODO: I got this 401 when user is just logged in (via Google) in frontend
    // and just redirected back to reader page (where user did the login)
    // is it possible that cookie propagation delay also the cause?
    // but I also have waited for that in frontend, so what's wrong?
    // GET /api/user?ref=users-api (401)
    // [verifyNextAuthToken] ✨ No valid session found
    // [verifyNextAuthToken] 📊 Session object: null

    // Common causes:
    // • Cookie has expired (maxAge reached)
    // • AUTH_SECRET mismatch between frontend and backend
    // • Cookie was stripped by browser (missing Next.js rewrite)
    console.log('[verifyNextAuthToken] ✨ No valid session found');
    console.log('[verifyNextAuthToken] 📊 Session object:', JSON.stringify(session, null, 2));

    // Debug: Log incoming cookies
    const cookies = req.headers.cookie;
    if (!cookies) {
      console.log('[verifyNextAuthToken] ⚠️ No cookies in request headers');
    } else {
      console.log('[verifyNextAuthToken] 🍪 Cookies present:', cookies);
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
