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
import { users } from '../db/schema.js';
import { verifyNextAuthToken } from './nextauth.js';
import { generateId, isValidUuid } from '../utils/uuid.js';
import { getFromCache, setCache } from '../services/cache.js';

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
// NOTE: Guest data migration is now handled automatically by verifyNextAuthToken()
// in src/middleware/nextauth.ts, which calls migrateGuestToAuthUser() from
// src/services/user-controller.ts. This ensures migration happens for both
// OAuth (Google) and email/password logins without requiring explicit middleware.

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
      req.userId = user.id;
      next();
      return;
    }

    // Resolve guest ID from cookie
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates a guest cookie value
 * 
 * Principle:
 * Trust the cookie, don't validate against DB on every request
 * 
 * Concerns:
 * - Transient database connection issue can result new ID in less than 1 day.
 * - Redis stingy free tier limitation
 * 
 * @param dbLookup validating it still exists in DB
 * 
 * @returns
 * - dbLookup false: the guestId if valid, null if invalid.
 * - dbLookup true: the guestId if valid, null if invalid, missing or stale.
 */
async function resolveGuestId(cookieValue: string | undefined, dbLookup: boolean = false): Promise<string | null> {
  if (!cookieValue) return null;

  // Format-only validation (no db & Redis)
  if (!dbLookup) return isValidUuid(cookieValue) ? cookieValue : null;

  // Uses Redis cache with 5-minute TTL to avoid DB connection issues
  // while maintaining security by validating against the database periodically.
  return resolveCachedGuestId(cookieValue);
}

/**
 * Validates a guest cookie value against the DB with caching.
 * 
 * Uses Redis cache with 5-minute TTL to avoid DB connection issues
 * while maintaining security by validating against the database periodically.
 * 
 * Security Critical:
 * - Guest validation is security-sensitive; shared cache using Redis ensures consistency
 * - Cache invalidation on guest deletion - only possible with Redis
 * 
 * @returns the guestId if valid, null if invalid, missing or stale.
 */
async function resolveCachedGuestId(cookieValue: string | undefined): Promise<string | null> {
  if (!cookieValue) return null;
  if (!isValidUuid(cookieValue)) return null;

  const cacheKey = `guest:valid:${cookieValue}`;

  // Check cache first (5-minute TTL)
  const cached = await getFromCache<boolean>(cacheKey);
  if (cached.hit && cached.data !== null) {
    return cached.data ? cookieValue : null;
  }

  // Validate against DB
  const existing = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(eq(users.userId, cookieValue), eq(users.isGuest, true)))
    .limit(1);

  const isValid = existing.length > 0;
  
  // Cache result for 5 minutes (300 seconds)
  // NOTE: This introduces potential cache staleness - if a guest user is deleted,
  // their ID will still be considered valid for up to 5 minutes until the cache expires.
  // This is an acceptable trade-off since guest users are rarely deleted and the
  // security impact is minimal. Consider cache invalidation on guest deletion if needed.
  await setCache(cacheKey, isValid, 300);
  
  return isValid ? cookieValue : null;
}