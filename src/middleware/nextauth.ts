/**
 * NextAuth v5 Cookie-Based Authentication Middleware
 * 
 * This module provides middleware functions to verify NextAuth JWT tokens
 * sent via httpOnly cookies using @auth/express.
 * 
 * Architecture:
 * - Uses @auth/express's getSession() to verify Auth.js session cookies
 * - Automatically handles Auth.js v5's proprietary JWE encryption
 * - Provides both required and optional auth middleware
 * 
 * Implemented Next.js Rewrites to solve the 401 authentication issue:
 * With the rewrites, the browser sees requests going to twistloom-web.vercel.app/api/backend/...
 * instead of twistloom-backend.vercel.app/api/..., so it sends the NextAuth cookies automatically.
 * The backend receives the cookies and verifies them using the same AUTH_SECRET as NextAuth via @auth/express.
 * 
 * Note: Guest user functionality has been completely removed.
 * The system now only supports authenticated or unauthenticated users.
 */

import type { Request, Response, NextFunction } from 'express';
import { getSession, type Session, type User } from '@auth/express';
import { handleUnauthorizedError } from '../utils/error.js';
import type { AuthUser } from '../types/express.js';
import { createOrUpdateOAuthUser } from '../services/user-controller.js';
import { updateSessionMetadata } from '../services/session-manager.js';
import { getUserIdByEmail, invalidateByEmail } from '../services/user.js';

/**
 * In-flight request cache to prevent concurrent session verification
 * for the same email address
 * 
 * Maps email -> Promise<AuthUser | null>
 */
const inFlightRequests = new Map<string, Promise<AuthUser | null>>();

/**
 * Verifies NextAuth session token from request cookies using @auth/express
 * 
 * This function uses @auth/express's getSession() to verify Auth.js session cookies.
 * It automatically handles Auth.js v5's proprietary JWE encryption and cookie parsing.
 * 
 * With Next.js rewrites, the browser sends cookies automatically since requests
 * appear to stay on the same domain (twistloom-web.vercel.app/api/backend/...).
 * 
 * Note:
 * - Requires Express cookie-parser middleware: `app.use(cookieParser());`
 * - AUTH_SECRET must be shared between Next.js frontend and Express backend
 * - No need for manual cookie parsing or JWT decryption - @auth/express handles it
 * - Auto-creates users for first-time OAuth login (Google)
 * - Updates session metadata (user agent, IP address) on each request
 * 
 * @param req - Express request object
 * @returns User data if token is valid, null otherwise
 * 
 * @example
 * ```typescript
 * const user = await verifyNextAuthToken(req);
 * if (!user) {
 *   return res.status(401).json({ error: 'Unauthorized' });
 * }
 * ```
 */
export async function verifyNextAuthToken(req: Request): Promise<AuthUser | null> {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      console.error('[verifyNextAuthToken] 💀 AUTH_SECRET is not configured');
      return null;
    }

    // Debug: Log incoming cookies
    const cookies = req.headers.cookie;
    if (!cookies) {
      console.log('[verifyNextAuthToken] ⚠️ No cookies in request headers');
    } else {
      console.log('[verifyNextAuthToken] 🍪 Cookies present:', cookies);
    }

    // getSession automatically looks inside request headers for the Auth.js cookie
    // and handles decryption/verification using the shared AUTH_SECRET
    let session: Session | null = null;
    try {
      session = await getSession(req, {
        providers: [], // Empty array since backend only verifies sessions, doesn't handle OAuth
        trustHost: true, // Trust the domain forwarding headers sent by hosting environments (like Vercel, AWS, or Docker) instead of strictly checking the origin domain.
        secret,
      });

      
    } catch (getSessionError) {
      console.error('[verifyNextAuthToken] ❌ getSession error:', getSessionError);
      return null;
    }

    if (!session?.user) {
      // Posibilities:
      // 1. The token expired: The maxAge of the Auth.js session cookie has passed.
      // 2. The token is invalid: The Express backend is using a different AUTH_SECRET than Next.js, meaning it cannot decrypt the cookie.
      // 3. The cookie is missing: If you didn't set up the Next.js Rewrites proxy (or custom domains), the browser stripped the cookie before it reached Express, leaving getSession() with nothing to parse.
      console.log('[verifyNextAuthToken] ✨ No valid session found');
      console.log('[verifyNextAuthToken] 📊 Session object:', JSON.stringify(session, null, 2));
      return null;
    }

    console.log(`[verifyNextAuthToken] ✅ Session verified (expired: ${session.expires}):`, session.user);

    // Validate and extract user data from session
    const email = session.user.email as string | undefined;
    const name = session.user.name as string | undefined;
    const image = session.user.image as string | undefined;
    const sessionId = (session.user as User & { sessionId?: string }).sessionId as string | undefined;

    if (!email || typeof email !== 'string') {
      console.error('[verifyNextAuthToken] ❌ Invalid session: missing or invalid email');
      return null;
    }

    // Check if there's already an in-flight request for this email
    // This prevents race conditions when multiple requests come in simultaneously after login
    const existingRequest = inFlightRequests.get(email);
    if (existingRequest) {
      console.log('[verifyNextAuthToken] ⏳ Waiting for in-flight request for:', email);
      return existingRequest;
    }

    // Create the verification promise
    const verificationPromise = (async () => {
      try {
        // Check if user exists in database
        let userId = await getUserIdByEmail(email);
        
        if (!userId) {
          // First-time OAuth login - create user in database
          console.log('[verifyNextAuthToken] 🆕 First-time OAuth login, creating user:', email);
          userId = await createOrUpdateOAuthUser(email, name, image);
          
          // Invalidate cache for the new user
          invalidateByEmail(email);
        } else {
          // Existing user - update profile data from OAuth provider asynchronously
          // This prevents blocking concurrent requests during profile updates
          console.log('[verifyNextAuthToken] 🔄 Updating existing user profile from OAuth:', email);
          createOrUpdateOAuthUser(email, name, image)
            .then(() => {
              // Invalidate cache to ensure fresh data after update completes
              invalidateByEmail(email);
            })
            .catch((error) => {
              console.error('[verifyNextAuthToken] ❌ Failed to update user profile:', error);
            });
          
          // Invalidate cache immediately to prevent stale data
          invalidateByEmail(email);
        }

        // Update session metadata if sessionId is available
        if (sessionId) {
          try {
            const userAgent = req.headers['user-agent'] || null;
            const ipAddress = req.ip || req.socket.remoteAddress || null;
            await updateSessionMetadata(sessionId, userAgent, ipAddress);
          } catch (error) {
            // Don't fail the request if metadata update fails
            console.error('[verifyNextAuthToken] ❌ Failed to update session metadata:', error);
          }
        }

        return {
          id: userId,
          email,
          name,
          sessionId,
        };
      } finally {
        // Clean up the in-flight request cache
        inFlightRequests.delete(email);
      }
    })();

    // Store the promise in the cache
    inFlightRequests.set(email, verificationPromise);

    return verificationPromise;
  } catch (error) {
    console.error('[verifyNextAuthToken] ❌ Session verification error:', error);
    return null;
  }
}

/**
 * Middleware to require NextAuth authentication
 * Verifies the NextAuth JWT cookie and attaches user data to req.user
 * Returns 401 if authentication fails
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 * 
 * @example
 * ```typescript
 * router.get('/api/protected', requireAuth, async (req, res) => {
 *   const user = req.user!; // User is guaranteed to be authenticated
 *   res.json({ data: user.id });
 * });
 * ```
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await verifyNextAuthToken(req);

  if (!user) {
    handleUnauthorizedError(res, 'Authentication required');
    return;
  }

  req.user = user;
  req.userId = user.id; // Backward compatibility with existing routes
  next();
}

/**
 * Middleware to optionally verify NextAuth authentication
 * Attaches user data to req.user if token is valid, but allows request to proceed
 * Useful for endpoints that work for both authenticated and unauthenticated users
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 * 
 * @example
 * ```typescript
 * router.get('/api/public', optionalAuth, async (req, res) => {
 *   if (req.user) {
 *     res.json({ message: `Hello ${req.user.name}` });
 *   } else {
 *     res.json({ message: 'Hello anonymous user' });
 *   }
 * });
 * ```
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await verifyNextAuthToken(req);
  if (user) {
    req.user = user;
    req.userId = user.id; // Backward compatibility with existing routes
  }
  next();
}