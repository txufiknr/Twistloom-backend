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

const GUEST_COOKIE_NAME = 'twistloom_guest_id';
const MAX_GUEST_CREATION_RETRIES = 3;

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
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    // If insertion fails (e.g., duplicate key), generate a new ID and retry
    if (retryCount >= MAX_GUEST_CREATION_RETRIES) {
      throw new Error(`Failed to create guest user after ${MAX_GUEST_CREATION_RETRIES} retries`, { cause: error });
    }
    console.warn(`Guest user creation failed (attempt ${retryCount + 1}/${MAX_GUEST_CREATION_RETRIES}), retrying with new ID:`, error);
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
  const { eq } = await import('drizzle-orm');

  // Verify guest user exists before migration
  const guestUser = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.userId, guestId))
    .limit(1);

  if (!guestUser || guestUser.length === 0) {
    console.warn(`Guest user ${guestId} not found, skipping migration`);
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

    if (!guestId) {
      // Create new guest user
      guestId = await createGuestUser();
      
      // Set guest cookie in response
      // Use 'lax' for same-domain, 'none' only if cross-origin
      // Auto-detect backend hostname from request Host header
      const frontendHostname = process.env.FRONTEND_URL ? new URL(process.env.FRONTEND_URL).hostname : null;
      const backendHostname = req.get('host')?.split(':')[0] || 'localhost'; // Remove port if present
      const isCrossOrigin = frontendHostname && backendHostname && frontendHostname !== backendHostname;
      
      res.cookie(GUEST_COOKIE_NAME, guestId, {
        httpOnly: true, // Prevent XSS attacks
        secure: process.env.NODE_ENV === 'production',
        sameSite: (process.env.NODE_ENV === 'production' && isCrossOrigin) ? 'none' : 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
      });
    }

    req.guestAuth = {
      isAuthenticated: false,
      userId: guestId,
      isGuest: true,
    };
    req.userId = guestId; // Set req.userId for rate limiting and route handlers

    next();
  } catch (error) {
    console.error('Guest middleware error:', error);
    // On error, treat as unauthenticated guest
    req.guestAuth = {
      isAuthenticated: false,
      userId: null,
      isGuest: true,
    };
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

        // Remove guest cookie
        res.clearCookie(GUEST_COOKIE_NAME, {
          path: '/',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Guest migration middleware error:', error);
    // Continue even if migration fails
    next();
  }
}
