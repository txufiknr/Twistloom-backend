/**
 * NextAuth v5 Cookie-Based Authentication Middleware
 * 
 * This module provides middleware functions to verify NextAuth JWT tokens
 * sent via httpOnly cookies, replacing the old X-Client-Id header approach.
 * 
 * Architecture:
 * - Uses NextAuth's getToken() to verify JWT cookies
 * - Supports conditional cookie naming for NextAuth v5
 * - Provides both required and optional auth middleware
 * - Compatible with guest user flow
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
import { getToken } from 'next-auth/jwt';
import { handleUnauthorizedError } from '../utils/error.js';
import type { AuthUser } from '../types/express.js';

/**
 * Determines the NextAuth cookie name based on environment
 * NextAuth v5 uses conditional cookie naming for localhost support
 * 
 * @returns Cookie name for the current environment
 */
function getCookieName(): string {
  // Development: next-auth.session-token (no __Secure prefix, works on HTTP)
  // Production: __Secure-next-auth.session-token (requires HTTPS)
  return process.env.NODE_ENV === 'production'
    ? '__Secure-next-auth.session-token'
    : 'next-auth.session-token';
}

/**
 * Verifies NextAuth JWT token from request cookies
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
    const token = await getToken({
      req: req as unknown as { headers: Record<string, string> },
      secret: process.env.AUTH_SECRET,
      cookieName: getCookieName(),
    });

    if (!token) {
      return null;
    }

    // Validate token structure with type guards
    const userId = token.userId;
    const email = token.email;
    const name = token.name;

    if (!userId || typeof userId !== 'string') {
      console.error('Invalid token: missing or invalid userId');
      return null;
    }

    if (!email || typeof email !== 'string') {
      console.error('Invalid token: missing or invalid email');
      return null;
    }

    // Extract user data from token with validation
    return {
      id: userId,
      email,
      name: typeof name === 'string' ? name : undefined,
    };
  } catch (error) {
    console.error('NextAuth token verification error:', error);
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
