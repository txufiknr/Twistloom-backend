/**
 * @overview User Controller Service
 * 
 * Provides enriched user profile queries with engagement metrics.
 * Centralizes user data selection logic with aggregated counts.
 * 
 * Features:
 * - User profile fields with engagement counts
 * - Optimized subqueries for book/read/like/favorite counts
 * - Reusable select builder for consistency across routes
 * - Performance considerations with indexed columns
 * - OAuth user creation
 */

import { users, userAuth } from '../db/schema.js';
import { sql, eq } from 'drizzle-orm';
import { type DBClient, dbRead, dbWrite } from '../db/client.js';
import { generateId } from '../utils/uuid.js';
import { sanitizeTextForDB } from '../utils/text-processing.js';
import { getUserIdByEmail, logUserActivity, updateUserLastActivity } from './user.js';
import { handleApiError, handleNotFoundError, handleValidationError } from '../utils/error.js';
import { sanitizeUsername } from '../utils/username.js';
import { invalidateUserProfileCache } from './cache.js';
import { REFERRAL_BONUS } from '../config/credits.js';
import { awardCredits } from './credits.js';
import type { Request, Response } from "express";

/**
 * Returns enriched user select object with engagement metrics
 * 
 * Provides user profile fields with aggregated counts for books, reads, likes, and favorites.
 * Uses correlated subqueries for performance with proper indexes.
 * 
 * Performance Analysis:
 * - books table: indexed on userId for fast COUNT
 * - userSessions table: indexed on userId for fast COUNT
 * - userLikes table: indexed on userId for fast COUNT
 * - userFavorites table: indexed on userId for fast COUNT
 * - Correlated subqueries are optimal for single-row user profile queries
 * - Alternative CTE approach would be overkill for single-user lookups
 * 
 * @returns Select object with user fields and engagement counts
 * 
 * @example
 * ```typescript
 * const result = await dbRead
 *   .select(getEnrichedUserSelect())
 *   .from(users)
 *   .where(eq(users.userId, userId))
 *   .limit(1);
 * ```
 */
export function getEnrichedUserSelect() {
  return {
    // Basic user fields
    userId: users.userId,
    name: users.name,
    username: users.username,
    email: users.email,
    bio: users.bio,
    gender: users.gender,
    image: users.image,
    tier: users.tier,
    credits: users.credits,
    lastActive: users.lastActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    // Engagement metrics using SQL subqueries (indexed by userId)
    booksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM books 
      WHERE user_id = users.user_id
    ), 0)`,
    readsCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_sessions 
      WHERE user_id = users.user_id
    ), 0)`,
    likedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_likes 
      WHERE user_id = users.user_id AND target_type = 'book'
    ), 0)`,
    savedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_favorites 
      WHERE user_id = users.user_id
    ), 0)`,
    followersCount: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM user_follows 
      WHERE following_id = users.user_id
    ), 0)`,
    likesReceived: sql<number>`COALESCE((
      SELECT COUNT(*) 
      FROM books 
      INNER JOIN user_likes ON books.id = user_likes.target_id
      WHERE books.user_id = users.user_id AND user_likes.target_type = 'book'
    ), 0)`,
    accountDaysOld: sql<number>`COALESCE((NOW()::date - ${users.createdAt}::date), 0)`,
    // Email verification comes from the user_auth table
    emailVerified: sql<Date | null>`(
      SELECT ua.email_verified
      FROM user_auth ua
      WHERE ua.user_id = users.user_id
      LIMIT 1
    )`,
    // Whether the user has ever purchased credits (exists in `transactions`)
    havePurchased: sql<boolean>`EXISTS(
      SELECT 1 FROM transactions t
      WHERE t.user_id = users.user_id AND t.type = 'purchase'
    )`,
  };
}

// ---------------------------------------------------------------------------
// OAuth User Creation
// ---------------------------------------------------------------------------

/**
 * Creates or updates a user from OAuth provider data (e.g., Google)
 * 
 * This function handles first-time OAuth logins by creating a user record
 * in the database. If the user already exists (by email), it updates their
 * profile data from the OAuth provider.
 * 
 * @param email - User email from OAuth provider
 * @param name - User display name from OAuth provider (optional)
 * @param image - User profile image URL from OAuth provider (optional)
 * @returns The user ID (existing or newly created)
 * 
 * @example
 * ```typescript
 * // First-time Google login
 * const userId = await createOrUpdateOAuthUser('user@example.com', 'John Doe', 'https://google.com/photo.jpg');
 * 
 * // Returning user with updated profile
 * const userId = await createOrUpdateOAuthUser('user@example.com', 'John Smith', 'https://google.com/new-photo.jpg');
 * ```
 */
export async function createOrUpdateOAuthUser(
  email: string,
  name?: string,
  image?: string
): Promise<string> {
  // Check if user already exists by email
  const userId = await getUserIdByEmail(email);

  if (userId) {
    // User exists - update profile data from OAuth provider
    await dbWrite
      .update(users)
      .set({
        ...(name && { name: sanitizeTextForDB(String(name)) }),
        ...(image && { image: sanitizeTextForDB(String(image)) }),
        lastActive: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.userId, userId));
    
    console.log(`[user-controller] ✅ Updated existing OAuth user: ${userId}`);
    return userId;
  }

  // New user - create account from OAuth data
    const cleanEmail = sanitizeTextForDB(String(email).trim().toLowerCase());
    const cleanName = name ? sanitizeTextForDB(String(name)) : null;
    const cleanImage = image ? sanitizeTextForDB(String(image)) : null;

    const newUser = await dbWrite.transaction(async (tx) => {
    // Create user record
    const userRecord = await tx.insert(users).values({
      userId: generateId(),
      email: cleanEmail,
      name: cleanName || null,
      image: cleanImage || null,
      isNewUser: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActive: new Date(),
    }).returning();

    // Create user_auth record
    await tx.insert(userAuth).values({
      userId: userRecord[0].userId,
    });

    return userRecord;
  });

  console.log(`[user-controller] ✅ Created new OAuth user: ${newUser[0].userId}`);
  return newUser[0].userId;
}

/**
 * Sets a referrer for a newly created user (used at signup and by /user/referrer).
 * Performs validation, updates the user record, awards referral credits to both
 * parties, logs activity, invalidates caches, and updates last activity.
 *
 * Returns an object with `success` and either `referrerId` or `error`.
 */
export async function setReferrerForNewUser(
  req: Request,
  res: Response,
  userId: string,
  referrerUsername: string,
  opts: {
    client?: DBClient;
    handleResponse?: boolean; // Whether to send API responses (default: true)
  } = {}
): Promise<boolean> {
  const { client = dbWrite, handleResponse = true } = opts;

  try {
    // Ensure user exists and is new
    const currentUser = await dbRead
      .select({ userId: users.userId, isNewUser: users.isNewUser, referrerId: users.referrerId })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (currentUser.length === 0) {
      if (handleResponse) {
        handleNotFoundError(res, "User not found");
      }
      return false;
    }

    const user = currentUser[0];

    if (!user.isNewUser) {
      if (handleResponse) {
        handleValidationError(res, "Referrer can only be set for new users");
      }
      return false;
    }

    if (user.referrerId) {
      if (handleResponse) {
        handleValidationError(res, "Referrer already set");
      }
      return false;
    }

    // Find referrer by username (sanitize input)
    const cleanReferrer = sanitizeUsername(referrerUsername);
    const [referrer] = await dbRead
      .select({ userId: users.userId, username: users.username })
      .from(users)
      .where(eq(users.username, cleanReferrer))
      .limit(1);

    if (!referrer) {
      if (handleResponse) {
        handleNotFoundError(res, "Referrer user not found");
      }
      return false;
    }

    if (referrer.userId === userId) {
      if (handleResponse) {
        handleValidationError(res, "Cannot refer yourself");
      }
      return false;
    }

    // Update user to record referrer
    await client
      .update(users)
      .set({ referrerId: referrer.userId, isNewUser: false, updatedAt: new Date() })
      .where(eq(users.userId, userId));

    // Award referral bonus to both users
    await Promise.all([
      awardCredits(referrer.userId, REFERRAL_BONUS, {
        type: 'reward',
        notificationType: 'referral_bonus',
        notificationTitle: 'Referral Bonus',
        notificationMessage: `You received ${REFERRAL_BONUS} credits for referring a new user`,
        metadata: { referredUserId: userId }
      }),
      awardCredits(userId, REFERRAL_BONUS, {
        type: 'reward',
        notificationType: 'referral_bonus',
        notificationTitle: 'Referral Bonus',
        notificationMessage: `You received ${REFERRAL_BONUS} credits for using a referral code`,
        metadata: { referrerId: referrer.userId }
      })
    ]);

    // Log activity
    await logUserActivity({
      userId,
      activityType: 'referrer_set',
      targetType: 'user',
      targetId: referrer.userId,
      metadata: { referrerUsername },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      platform: req.get('x-platform'),
      appVersion: req.get('x-app-version'),
    });

    // Invalidate caches for both users
    await Promise.all([
      invalidateUserProfileCache(userId),
      invalidateUserProfileCache(referrer.userId)
    ]);

    // Update last activity
    await updateUserLastActivity(userId);

    console.log(`[user] ✅ Applied referrer for ${userId} -> ${referrerUsername}`);
    return true;
  } catch (error) {
    console.error('[user] ❌ Failed to apply referrer:', error);
    if (handleResponse) {
      handleApiError(res, "Failed to apply referrer", error);
    }
    return false;
  }
}