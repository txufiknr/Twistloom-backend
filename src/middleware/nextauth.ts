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
 * - Compatible with guest user flow
 * 
 * Summary
 * Implemented Option 1 (Next.js Rewrites) to solve the 401 authentication issue:
 * 
 * Changes Made:
 * Frontend (next.config.ts):
 * - Added Next.js rewrites to proxy backend API requests through /api/backend/:path*
 * - Requests to /api/backend/payments/create-checkout-session will be rewritten to https://twistloom-backend.vercel.app/api/payments/create-checkout-session
 * - This makes the browser send NextAuth cookies automatically since requests appear to stay on the same domain
 * 
 * Backend (nextauth.ts):
 * - Switched from jose to @auth/express for session verification
 * - Updated verifyNextAuthToken to use @auth/express's getSession function
 * - Removed manual JWT decryption/verification logic (now handled by @auth/express)
 * - Removed jose dependency
 * 
 * Why @auth/express instead of jose:
 * Auth.js tokens use JWE (JSON Web Encryption) with proprietary encryption structure.
 * @auth/express abstracts away HKDF key derivation, decryption algorithms, and cookie parsing.
 * It's the official and recommended way to verify Auth.js sessions in Express backends.
 * 
 * Next Steps:
 * 1. Update frontend API calls - Change your frontend fetch calls from:
 * fetch('https://twistloom-backend.vercel.app/api/payments/create-checkout-session', ...)
 * To:
 * fetch('/api/backend/payments/create-checkout-session', ...)
 * 
 * 2. Set environment variable (optional) - Add NEXT_PUBLIC_BACKEND_URL to your frontend .env if you want to override the default backend URL
 * 3. Test the authentication - Try accessing the protected endpoint after signing in with Google. The NextAuth cookies should now be sent automatically.
 * 
 * Why This Works:
 * With the rewrites, the browser sees requests going to twistloom-web.vercel.app/api/backend/... instead of twistloom-backend.vercel.app/api/..., so it sends the NextAuth cookies automatically. The backend receives the cookies and verifies them using the same AUTH_SECRET as NextAuth via @auth/express.
 */

import type { Request, Response, NextFunction } from 'express';
import { getSession } from '@auth/express';
import { handleUnauthorizedError } from '../utils/error.js';
import type { AuthUser } from '../types/express.js';
import { dbRead } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import { createOrUpdateOAuthUser, migrateGuestToAuthUser } from '../services/user-controller.js';

/**
 * LRU cache for email -> userId mappings
 * 
 * Caches user ID lookups to reduce database query overhead.
 * Uses a maximum of 1000 entries with a 5-minute TTL.
 */
const userIdCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

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
 * - Migrates guest data to authenticated user on login
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

    // getSession automatically looks inside request headers for the Auth.js cookie
    // and handles decryption/verification using the shared AUTH_SECRET
    const session = await getSession(req, {
      providers: [], // Empty since Next.js frontend manages providers
      secret,
      session: { strategy: 'jwt' },
    });

    if (!session?.user) {
      // Posibilities:
      // 1. The token expired: The maxAge of the Auth.js session cookie has passed.
      // 2. The token is invalid: The Express backend is using a different AUTH_SECRET than Next.js, meaning it cannot decrypt the cookie.
      // 3. The cookie is missing: If you didn't set up the Next.js Rewrites proxy (or custom domains) discussed earlier, the browser stripped the cookie before it reached Express, leaving getSession() with nothing to parse.
      console.log('[verifyNextAuthToken] ✨ No valid session found');
      // To make sure your user is kicked out of Next.js when Express rejects the token,
      // you must handle the 401 response in your frontend network requests and
      // trigger the Auth.js signOut() function.
      return null;
    }

    console.log('[verifyNextAuthToken] ✅ Session verified:', session.user);

    // Validate and extract user data from session
    const email = session.user.email as string | undefined;
    const name = session.user.name as string | undefined;
    const image = session.user.image as string | undefined;

    if (!email || typeof email !== 'string') {
      console.error('[verifyNextAuthToken] ❌ Invalid session: missing or invalid email');
      return null;
    }

    // Check if user exists in database
    let userId = await getUserId(email);
    
    if (!userId) {
      // First-time OAuth login - create user in database
      console.log('[verifyNextAuthToken] 🆕 First-time OAuth login, creating user:', email);
      userId = await createOrUpdateOAuthUser(email, name, image);
      
      // Invalidate cache for the new user
      userIdCache.delete(email);
    } else {
      // Existing user - update profile data from OAuth provider
      console.log('[verifyNextAuthToken] 🔄 Updating existing user profile from OAuth:', email);
      await createOrUpdateOAuthUser(email, name, image);
      
      // Invalidate cache to ensure fresh data
      userIdCache.delete(email);
    }

    // Migrate guest data if guest cookie exists
    const guestCookie = req.cookies?.['twistloom_guest_id'];
    if (guestCookie && guestCookie !== userId) {
      console.log('[verifyNextAuthToken] 🔄 Migrating guest data:', guestCookie, '->', userId);
      await migrateGuestToAuthUser(guestCookie, userId);
    }

    return {
      id: userId,
      email,
      name,
    };
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
 * Useful for endpoints that work for both authenticated and guest users
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
 *     res.json({ message: 'Hello guest' });
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

/**
 * Retrieves user ID from database using email, with LRU caching
 * 
 * This function queries the database to find a user ID by email address.
 * Results are cached in an LRU cache to reduce database query overhead for
 * repeated lookups of the same email.
 * 
 * Cache behavior:
 * - Maximum 1000 entries
 * - 5-minute TTL per entry
 * - Cache hit: Returns cached ID immediately
 * - Cache miss: Queries database and caches result
 * 
 * @param email - User email address to look up
 * @returns User ID if found, null otherwise
 * 
 * @example
 * ```typescript
 * const userId = await getUserId('user@example.com');
 * if (userId) {
 *   console.log('User ID:', userId);
 * }
 * ```
 */
async function getUserId(email: string): Promise<string | null> {
  // Check cache first
  const cachedId = userIdCache.get(email);
  if (cachedId) {
    return cachedId;
  }

  // Query database if not in cache
  const user = await dbRead
    .select({ id: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user.length > 0) {
    const userId = user[0].id;
    // Cache the result
    userIdCache.set(email, userId);
    return userId;
  }

  return null;
}