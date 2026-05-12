/**
 * Guest User Authentication Middleware
 * 
 * This module provides middleware to support guest user flow.
 * Guests can create content without logging in, and their data
 * can be migrated to authenticated users when they sign in.
 * 
 * Architecture:
 * - Tries NextAuth authentication first
 * - Falls back to guest cookie for unauthenticated users
 * - Creates new guest users if no guest cookie exists
 * - Supports data migration from guest to authenticated user
 */

import type { Request, Response, NextFunction } from 'express';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyNextAuthToken } from './nextauth.js';
import { generateId } from '../utils/uuid.js';
import { IS_PRODUCTION } from '../config/env.js';

const GUEST_COOKIE_NAME = 'twistloom_guest_id';
const GUEST_COOKIE_TTL_MS = 60 * 60 * 24 * 30 * 1000; // 30 days in ms
const MAX_GUEST_CREATION_RETRIES = 3;

/**
 * Parses FRONTEND_URL environment variable safely
 * Returns null if URL is malformed or not set
 */
function parseFrontendHostname(): string | null {
  try {
    return process.env.FRONTEND_URL ? new URL(process.env.FRONTEND_URL).hostname : null;
  } catch {
    console.error('[guest] ❌ Invalid FRONTEND_URL:', process.env.FRONTEND_URL);
    return null;
  }
}

// Cache frontend hostname at module load for performance
const FRONTEND_HOSTNAME = parseFrontendHostname();

/**
 * Calculates the cookie domain for cross-subdomain sharing
 * e.g., 'api.example.com' -> '.example.com', 'localhost' -> undefined
 * 
 * Note: Bare domains (e.g., 'example.com') return undefined since there's no subdomain to strip.
 * This is intentional - cross-subdomain sharing only applies when backend is on a subdomain.
 * 
 * Limitation: ccTLDs (e.g., 'api.example.co.uk') may produce incorrect domain (.co.uk instead of .example.co.uk).
 * This is a known hard problem without a perfect solution without a public suffix list.
 */
function getCookieDomain(hostname: string): string | undefined {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return undefined;
  }
  const hostnameParts = hostname.split('.');
  if (hostnameParts.length > 2) {
    const domain = '.' + hostnameParts.slice(-2).join('.');
    // Heuristic: bail if result looks like a bare TLD pair (each part < 4 chars)
    // This catches some ccTLD cases like .co.uk, .com.au, etc.
    const parts = domain.slice(1).split('.');
    if (parts.length === 2 && parts.every(p => p.length < 4)) {
      return undefined;
    }
    return domain;
  }
  return undefined;
}

/**
 * Determines if the request is cross-origin (different top-level domains)
 */
function isCrossOriginRequest(backendHostname: string): boolean {
  return !!(FRONTEND_HOSTNAME &&
           backendHostname &&
           FRONTEND_HOSTNAME !== backendHostname &&
           !FRONTEND_HOSTNAME.endsWith('.' + backendHostname.replace(/^www\./, '')) &&
           !backendHostname.endsWith('.' + FRONTEND_HOSTNAME.replace(/^www\./, '')));
}

/**
 * Creates a new guest user in the database with race condition protection
 * 
 * @param retryCount - Current retry attempt (internal)
 * @returns The guest user ID
 * @throws Error if creation fails after max retries
 */
async function createGuestUser(retryCount = 0): Promise<string> {
  const guestId = generateId();

  try {
    await dbWrite.insert(users).values({
      userId: guestId,
      isGuest: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    // If insertion fails (e.g., duplicate key), generate a new ID and retry
    if (retryCount >= MAX_GUEST_CREATION_RETRIES) {
      throw new Error(`Failed to create guest user after ${MAX_GUEST_CREATION_RETRIES} retries`, { cause: error });
    }
    console.warn(`[guest] ⚠️ Guest user creation failed (attempt ${retryCount + 1}/${MAX_GUEST_CREATION_RETRIES}), retrying with new ID:`, error);
    return createGuestUser(retryCount + 1);
  }

  return guestId;
}

/**
 * Migrates data from a guest user to an authenticated user
 * Transfers all books, sessions, and other data from guest to authenticated user
 * 
 * @param guestId - The guest user ID to migrate from
 * @param authenticatedUserId - The authenticated user ID to migrate to
 */
export async function migrateGuestData(guestId: string, authenticatedUserId: string): Promise<void> {
  // Import here to avoid circular dependencies
  const { books, userSessions } = await import('../db/schema.js');
  const { eq, and } = await import('drizzle-orm');

  // Verify guest user exists before migration
  const guestUser = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.userId, guestId), eq(users.isGuest, true)))
    .limit(1);

  if (!guestUser || guestUser.length === 0) {
    console.warn(`[guest] ⚠️ Guest user ${guestId} not found, skipping migration`);
    return;
  }

  // Migrate all books from guest to authenticated user
  await dbWrite
    .update(books)
    .set({ userId: authenticatedUserId })
    .where(eq(books.userId, guestId));

  // Migrate all sessions from guest to authenticated user
  await dbWrite
    .update(userSessions)
    .set({ userId: authenticatedUserId })
    .where(eq(userSessions.userId, guestId));

  // Delete guest user from database
  await dbWrite.delete(users).where(eq(users.userId, guestId));
}

/**
 * Middleware that handles both authenticated and guest users
 * Tries NextAuth authentication first, falls back to guest cookie
 * Creates new guest user if neither exists
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 * 
 * @example
 * ```typescript
 * router.post('/api/books', guestOrAuthMiddleware, async (req, res) => {
 *   const { isAuthenticated, userId, isGuest } = req.guestAuth!;
 *   const book = await createBook(req.body, userId!);
 *   res.json({ book, isGuest });
 * });
 * ```
 */
export async function guestOrAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Try NextAuth authentication first
    const user = await verifyNextAuthToken(req);

    if (user) {
      // Authenticated user
      req.guestAuth = {
        isAuthenticated: true,
        userId: user.id,
        isGuest: false,
        user,
      };
      req.user = user;
      next();
      return;
    }

    // Guest user - check for guest cookie
    const guestCookie = req.cookies?.[GUEST_COOKIE_NAME];
    let guestId = guestCookie;

    // Verify guest ID exists in database (handles stale cookies pointing to deleted guests)
    if (guestId) {
      const { eq } = await import('drizzle-orm');
      const existing = await dbRead
        .select({ userId: users.userId })
        .from(users)
        .where(eq(users.userId, guestId))
        .limit(1);

      if (!existing.length) {
        guestId = null; // Force re-creation below
      }
    }

    // Auto-detect backend hostname from request Host header
    const backendHostname = req.get('host')?.split(':')[0] || 'localhost'; // Remove port if present
    
    // Calculate cookie domain and cross-origin status
    const cookieDomain = getCookieDomain(backendHostname);
    const isCrossOrigin = isCrossOriginRequest(backendHostname);

    // Create new guest user
    guestId ??= await createGuestUser();

    // Refresh TTL on each request (sliding session)
    res.cookie(GUEST_COOKIE_NAME, guestId, {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: IS_PRODUCTION && isCrossOrigin ? 'none' : 'lax',
      maxAge: GUEST_COOKIE_TTL_MS,
      path: '/',
      domain: cookieDomain,
    });

    req.guestAuth = {
      isAuthenticated: false,
      userId: guestId,
      isGuest: true,
    };
    req.userId = guestId; // Set req.userId for rate limiting and route handlers

    next();
  } catch (error) {
    console.error('[guest] ❌ Guest middleware error:', error);
    // On error, create a fallback guest user to ensure userId is always a string
    try {
      const fallbackGuestId = await createGuestUser();
      req.guestAuth = {
        isAuthenticated: false,
        userId: fallbackGuestId,
        isGuest: true,
      };
      req.userId = fallbackGuestId;
    } catch (fallbackError) {
      console.error('[guest] ❌ Failed to create fallback guest user:', fallbackError);
      // If even fallback fails, let error middleware handle it
      return next(error);
    }
    next();
  }
}

/**
 * Middleware to migrate guest data to authenticated user
 * Should be used on login/callback endpoints
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next middleware function
 * 
 * @example
 * ```typescript
 * router.post('/api/auth/login/callback', migrateGuestMiddleware, async (req, res) => {
 *   // Guest data has been migrated if applicable
 *   res.json({ success: true });
 * });
 * ```
 */
export async function migrateGuestMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await verifyNextAuthToken(req);

    if (user) {
      const guestCookie = req.cookies?.[GUEST_COOKIE_NAME];

      if (guestCookie && user.id !== guestCookie) {
        // Migrate guest data to authenticated user
        await migrateGuestData(guestCookie, user.id);

        // Re-derive cookieDomain to match what was used when setting the cookie
        const backendHostname = req.get('host')?.split(':')[0] || 'localhost';
        const cookieDomain = getCookieDomain(backendHostname);

        // Remove guest cookie (must match domain from set() call)
        res.clearCookie(GUEST_COOKIE_NAME, {
          path: '/',
          domain: cookieDomain,
        });
      }
    }

    next();
  } catch (error) {
    console.error('[guest] ❌ Guest migration middleware error:', error);
    // Continue even if migration fails
    next();
  }
}
