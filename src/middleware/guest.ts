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

import type { Request, Response, NextFunction, CookieOptions } from 'express';
import { eq, and } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users, books, userSessions } from '../db/schema.js';
import { verifyNextAuthToken } from './nextauth.js';
import { generateId } from '../utils/uuid.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GUEST_COOKIE_NAME = 'twistloom_guest_id';
const GUEST_COOKIE_TTL_MS = 60 * 60 * 24 * 30 * 1000; // 30 days in ms
const MAX_GUEST_CREATION_RETRIES = 3;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Production frontend and backend are on different Vercel subdomains,
 * so cookies must be sameSite:'none' + secure in production.
 * In dev, both run on localhost — sameSite:'lax' is sufficient.
 * 
 * frontend urls:
 * - https://twistloom-web.vercel.app (production)
 * - http://localhost:3001 (dev)
 * - https://localhost:3002 (dev https)
 * 
 * backend urls:
 * - https://twistloom-backend.vercel.app (production)
 * - http://localhost:3000 (dev)
 */
const GUEST_COOKIE_OPTIONS: CookieOptions = IS_PRODUCTION
  ? { httpOnly: true, secure: true, sameSite: 'none', maxAge: GUEST_COOKIE_TTL_MS, path: '/' }
  : { httpOnly: true, secure: false, sameSite: 'lax', maxAge: GUEST_COOKIE_TTL_MS, path: '/' };

const GUEST_COOKIE_CLEAR_OPTIONS: CookieOptions = { path: '/' };

// ---------------------------------------------------------------------------
// Guest user creation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Guest data migration
// ---------------------------------------------------------------------------

/**
 * Migrates data from a guest user to an authenticated user
 * Transfers all books, sessions, and other data from guest to authenticated user
 * 
 * @param guestId - The guest user ID to migrate from
 * @param authenticatedUserId - The authenticated user ID to migrate to
 */
export async function migrateGuestData(guestId: string, authenticatedUserId: string): Promise<void> {
  // Verify guest user exists before migration
  const guestUser = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.userId, guestId), eq(users.isGuest, true)))
    .limit(1);

  if (!guestUser.length) {
    console.warn(`[guest] ⚠️ Guest user ${guestId} not found, skipping migration`);
    return;
  }

  // Migrate all user data from guest to authenticated user
  await dbWrite.update(books).set({ userId: authenticatedUserId }).where(eq(books.userId, guestId));
  await dbWrite.update(userSessions).set({ userId: authenticatedUserId }).where(eq(userSessions.userId, guestId));

  // Delete guest user from database
  await dbWrite.delete(users).where(eq(users.userId, guestId));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

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
      req.guestAuth = { isAuthenticated: true, userId: user.id, isGuest: false, user };
      req.user = user;
      next();
      return;
    }

    // Resolve guest ID from cookie, validating it still exists in DB
    const guestId = await resolveGuestId(req.cookies?.[GUEST_COOKIE_NAME]) ?? await createGuestUser();

    // Always refresh TTL on each request (sliding expiry)
    res.cookie(GUEST_COOKIE_NAME, guestId, GUEST_COOKIE_OPTIONS);

    req.guestAuth = { isAuthenticated: false, userId: guestId, isGuest: true };
    req.userId = guestId; // Set req.userId for rate limiting and route handlers

    next();
  } catch (error) {
    console.error('[guest] ❌ Guest middleware error:', error);
    next(error); // Propagate — don't forward null userId to route handlers
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
        res.clearCookie(GUEST_COOKIE_NAME, GUEST_COOKIE_CLEAR_OPTIONS);
      }
    }

    next();
  } catch (error) {
    console.error('[guest] ❌ Guest migration middleware error:', error);
    next(); // Non-fatal — user is authenticated regardless
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates a guest cookie value against the DB.
 * Returns the guestId if valid, null if missing or stale.
 */
async function resolveGuestId(cookieValue: string | undefined): Promise<string | null> {
  if (!cookieValue) return null;

  const existing = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.userId, cookieValue), eq(users.isGuest, true)))
    .limit(1);

  return existing.length ? cookieValue : null;
}