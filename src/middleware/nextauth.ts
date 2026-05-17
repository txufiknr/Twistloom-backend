/**
 * NextAuth v5 Cookie-Based Authentication Middleware
 * 
 * This module provides middleware functions to verify NextAuth JWT tokens
 * sent via httpOnly cookies.
 * 
 * Architecture:
 * - Uses NextAuth's getToken() to verify JWT cookies
 * - Supports conditional cookie naming for NextAuth v5
 * - Provides both required and optional auth middleware
 * - Compatible with guest user flow
 * 
 * Summary
 * I've successfully implemented Option 1 (Next.js Rewrites) to solve the 401 authentication issue:
 * 
 * Changes Made:
 * Frontend (next.config.ts):
 * - Added Next.js rewrites to proxy backend API requests through /api/backend/:path*
 * - Requests to /api/backend/payments/create-checkout-session will be rewritten to https://twistloom-backend.vercel.app/api/payments/create-checkout-session
 * - This makes the browser send NextAuth cookies automatically since requests appear to stay on the same domain
 * 
 * Backend (nextauth.ts):
 * - Switched from jsonwebtoken to jose for JWT verification (jose is newer, already installed, and used by NextAuth internally)
 * - Updated verifyNextAuthToken to use jose's jwtVerify function
 * - Removed jsonwebtoken and @types/jsonwebtoken dependencies
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
 * With the rewrites, the browser sees requests going to twistloom-web.vercel.app/api/backend/... instead of twistloom-backend.vercel.app/api/..., so it sends the NextAuth cookies automatically. The backend receives the cookies and verifies them using the same AUTH_SECRET as NextAuth.
 * 
 * @todo
 * Optional Performance Optimization (from migration guide):
 * - The guide suggests adding authCacheMiddleware to avoid re-verifying JWT
 * - This provides ~50-70% reduction in JWT verification overhead
 * - Not implemented here because Express middleware runs sequentially
 * - JWT is only verified once per request in current architecture
 * - To implement: Add middleware that checks if req.user is already set
 * - See BACKEND_AUTH_MIGRATION_GUIDE.md Step 9 for details
 */

import type { Request, Response, NextFunction } from 'express';
import { jwtVerify, jwtDecrypt, type JWTPayload } from 'jose';
import { handleUnauthorizedError } from '../utils/error.js';
import type { AuthUser } from '../types/express.js';
import { IS_PRODUCTION } from '../config/env.js';

/**
 * Determines the NextAuth cookie name based on environment
 * Auth.js v5 uses new cookie naming convention: authjs.session-token
 * 
 * @returns Cookie name for the current environment
 */
function getCookieName(): string {
  // Auth.js v5 changed cookie names from next-auth.session-token to authjs.session-token
  // Development: authjs.session-token (no __Secure prefix, works on HTTP)
  // Production: __Secure-authjs.session-token (requires HTTPS)
  return IS_PRODUCTION
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/**
 * Verifies NextAuth JWT token from request cookies
 * 
 * This function manually verifies the JWT token using the AUTH_SECRET,
 * since NextAuth's getToken() is designed for Next.js API routes, not Express.
 * 
 * Auth.js v5 supports both signed (JWS) and encrypted (JWE) tokens:
 * - JWS (JSON Web Signature): Token is signed and can be verified with jwtVerify
 * - JWE (JSON Web Encryption): Token is encrypted and must be decrypted with jwtDecrypt
 * 
 * This function attempts both methods to support both token types.
 * 
 * twistloom-web.vercel.app → twistloom-backend.vercel.app = cross-domain,
 * no automatic cookie sending.
 * 
 * Note:
 * - Requires Express cookie-parser middleware: `app.use(cookieParser());`
 * - For cross-domain requests with cookies, needs CORS configured with credentials support: `app.use(cors({ origin: 'https://twistloom-web.vercel.app', credentials: true }));`
 * - Your frontend fetch calls need credentials: 'include' for cross-domain cookie sending.
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
    const cookieName = getCookieName();
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      console.error('[verifyNextAuthToken] 💀 AUTH_SECRET is not configured');
      return null;
    }

    // Debug: Log all available cookies
    console.log('[verifyNextAuthToken] 🔍 All cookies:', Object.keys(req.cookies || {}));
    console.log('[verifyNextAuthToken] 🔍 Looking for cookie:', cookieName);

    // Try multiple possible cookie names for Auth.js v5
    const possibleCookieNames = [
      cookieName,
      'next-auth.session-token',
      '__Secure-next-auth.session-token',
      'authjs.session-token',
      '__Secure-authjs.session-token',
    ];

    let token: string | undefined;

    for (const name of possibleCookieNames) {
      if (req.cookies?.[name]) {
        token = req.cookies[name];
        console.log(`[verifyNextAuthToken] ✅ Found token in cookie: ${name}`);
        break;
      }
    }

    if (!token) {
      console.log(`[verifyNextAuthToken] ✨ No token found in any of these cookies:`, possibleCookieNames);
      return null;
    }

    // Debug: Log token format (first 50 chars)
    console.log('[verifyNextAuthToken] 🔍 Token preview:', token.substring(0, 50));
    console.log('[verifyNextAuthToken] 🔍 Token length:', token.length);

    const secretKey = new TextEncoder().encode(secret);
    let payload: JWTPayload;

    // Auth.js v5 may use encrypted tokens (JWE) instead of signed tokens (JWS)
    // Try decryption first (for JWE), then verification (for JWS)
    try {
      // Try to decrypt (for encrypted/JWE tokens)
      const { payload: decryptedPayload } = await jwtDecrypt(token, secretKey);
      payload = decryptedPayload;
      console.log('[verifyNextAuthToken] ✅ Token decrypted successfully (JWE):', payload);
    } catch (decryptError) {
      // If decryption fails, try verification (for signed/JWS tokens)
      try {
        const { payload: verifiedPayload } = await jwtVerify(token, secretKey);
        payload = verifiedPayload;
        console.log('[verifyNextAuthToken] ✅ Token verified successfully (JWS):', payload);
      } catch (verifyError) {
        console.error('[verifyNextAuthToken] ❌ Token verification failed (both JWE and JWS):', { decryptError, verifyError });
        throw verifyError;
      }
    }

    // Validate token structure with type guards
    const userId = payload.userId as string | undefined;
    const email = payload.email as string | undefined;
    const name = payload.name as string | undefined;

    if (!userId || typeof userId !== 'string') {
      console.error('[verifyNextAuthToken] ❌ Invalid token: missing or invalid userId');
      return null;
    }

    if (!email || typeof email !== 'string') {
      console.error('[verifyNextAuthToken] ❌ Invalid token: missing or invalid email');
      return null;
    }

    // Extract user data from token with validation
    return {
      id: userId,
      email,
      name: typeof name === 'string' ? name : undefined,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'JWTExpired') {
        console.warn('[verifyNextAuthToken] ⚠️ JWT token expired:', error.message);
      } else if (error.name === 'JWTInvalid' || error.name === 'JWSSignatureVerificationFailed' || error.name === 'JWEInvalid') {
        console.warn('[verifyNextAuthToken] ⚠️ Invalid JWT token:', error.message);
      } else {
        console.error('[verifyNextAuthToken] ❌ Token verification error:', error.message);
      }
    } else {
      console.error('[verifyNextAuthToken] ❌ Unknown error:', error);
    }
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
