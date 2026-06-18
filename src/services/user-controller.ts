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
import { sanitizeUserData, getUserIdByEmail, logUserActivity, updateUserLastActivity, invalidateByEmail } from './user.js';
import { uploadUserImage } from './image.js';
import { handleApiError, handleNotFoundError, handleValidationError } from '../utils/error.js';
import { sanitizeUsername } from '../utils/username.js';
import { invalidateUserProfileCache } from './cache.js';
import { REFERRAL_BONUS } from '../config/credits.js';
import { awardCredits } from './credits.js';
import type { Request, Response } from "express";
import type { DBNewUser } from '../types/schema.js';

/**
 * Returns enriched user select object with engagement metrics.
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
    userId:       users.userId,
    name:         users.name,
    username:     users.username,
    email:        users.email,
    bio:          users.bio,
    gender:       users.gender,
    image:        users.image,
    tier:         users.tier,
    credits:      users.credits,
    lastActive:   users.lastActive,
    createdAt:    users.createdAt,
    updatedAt:    users.updatedAt,
    // Consolidated counters: prefer values from `user_counters` (SSOT).
    // Keep fallbacks for metrics not yet tracked in the counters table.
    readsCount: sql<number>`COALESCE((
      SELECT COUNT(*) FROM user_sessions WHERE user_id = users.user_id
    ), 0)`,
    likedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) FROM user_likes WHERE user_id = users.user_id AND target_type = 'book'
    ), 0)`,
    savedBooksCount: sql<number>`COALESCE((
      SELECT COUNT(*) FROM user_favorites WHERE user_id = users.user_id
    ), 0)`,
    likesReceived: sql<number>`COALESCE((
      SELECT COUNT(*) FROM books
      INNER JOIN user_likes ON books.id = user_likes.target_id
      WHERE books.user_id = users.user_id AND user_likes.target_type = 'book'
    ), 0)`,
    accountDaysOld: sql<number>`COALESCE((NOW()::date - ${users.createdAt}::date), 0)`,
    // Email verification comes from the user_auth table
    emailVerified: sql<Date | null>`(
      SELECT ua.email_verified FROM user_auth ua
      WHERE ua.user_id = users.user_id LIMIT 1
    )`,
    // Whether the user has ever purchased credits (exists in `transactions`)
    havePurchased: sql<boolean>`EXISTS(
      SELECT 1 FROM transactions t
      WHERE t.user_id = users.user_id AND t.type = 'purchase'
    )`,
    // Expose the rest of the `user_counters` columns as SSOT-backed fields.
    booksGenerated: sql<number>`COALESCE((
      SELECT uc.books_generated FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    booksCompleted: sql<number>`COALESCE((
      SELECT uc.books_completed FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    pagesRead: sql<number>`COALESCE((
      SELECT uc.pages_read FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    branchesOpened: sql<number>`COALESCE((
      SELECT uc.branches_opened FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    topupCredits: sql<number>`COALESCE((
      SELECT uc.topup_credits FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    referredUsers: sql<number>`COALESCE((
      SELECT uc.referred_users FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    followersCount: sql<number>`COALESCE((
      SELECT uc.followers_count FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    activeCheckinStreak: sql<number>`COALESCE((
      SELECT uc.active_checkin_streak FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
    maxCheckinStreak: sql<number>`COALESCE((
      SELECT uc.max_checkin_streak FROM user_counters uc WHERE uc.user_id = users.user_id
    ), 0)`,
  };
}

// ---------------------------------------------------------------------------
// createOrUpdateOAuthUser
// ---------------------------------------------------------------------------

/**
 * Creates or updates a user from OAuth provider data (Google OAuth / One Tap).
 *
 * **Create path** (new user — email not in DB):
 *   Calls {@link sanitizeUserData} with `createNew: true` which:
 *     - Validates email uniqueness (hard 409 if taken)
 *     - Auto-deduplicates username with numeric suffix if needed
 *     - Validates username format
 *   Wraps the insert in a transaction to also create the user_auth record.
 *
 * **Update path** (returning user — email already in DB):
 *   Only updates `name` and `image` from the OAuth provider payload.
 *   Does NOT touch `username` (may have been customised by the user),
 *   `email` (immutable after creation), or any other fields.
 *
 * @param oAuthUser.email - User email from OAuth provider
 * @param oAuthUser.name - User display name from OAuth provider (optional)
 * @param oAuthUser.image - User profile image URL from OAuth provider (optional)
 * @returns The user ID (existing or newly created)
 */
export async function createOrUpdateOAuthUser(oAuthUser: {
  email: string;
  name?: string;
  image?: string;
}): Promise<string> {
  const cleanEmail = sanitizeTextForDB(String(oAuthUser.email).trim().toLowerCase());

  // ── Returning user path ────────────────────────────────────────────────────
  const existingUserId = await getUserIdByEmail(cleanEmail);

  if (existingUserId) {
    // Only update fields that come from the OAuth provider and can legitimately
    // change between sign-ins (display name, profile picture).
    // username and email are intentionally excluded.
    const updateData: Partial<Pick<DBNewUser, 'name' | 'image'>> = {};

    const { name: updateName, image: updateImage } = await sanitizeUserData(oAuthUser, { createNew: false }) ?? {};
    if (updateName) updateData.name = updateName;
    if (updateImage) updateData.image = updateImage;

    // if (oAuthUser.name) {
    //   updateData.name = sanitizeTextForDB(String(oAuthUser.name).trim());
    // }
    // if (oAuthUser.image !== undefined) {
    //   updateData.image = oAuthUser.image ? sanitizeTextForDB(String(oAuthUser.image)) : null;
    // }

    if (Object.keys(updateData).length) {
      await dbWrite
        .update(users)
        .set({ ...updateData, lastActive: new Date(), updatedAt: new Date() })
        .where(eq(users.userId, existingUserId));

      console.log(`[user-controller] ✅ Updated existing OAuth user: ${existingUserId}`);

      // Invalidate LRU cache so subsequent email→userId lookups are fresh
      invalidateByEmail(cleanEmail);
    }

    return existingUserId;
  }

  // ── New user path ──────────────────────────────────────────────────────────
  // sanitizeUserData handles: email uniqueness (race-condition guard),
  // username derivation, auto-deduplication, and format validation.
  const newUserData = await sanitizeUserData(oAuthUser, { createNew: true });

  if (!newUserData) {
    // sanitizeUserData already logged / responded; this path should be rare
    // (would require a race condition between getUserIdByEmail and the insert).
    throw new Error(`Failed to sanitize OAuth user data for ${cleanEmail}`);
  }

  // Persist Google/ OAuth profile image to ImageKit (if provided) and attach
  // the resulting URL and fileId to the new user data before insert.
  const newUserId = generateId();

  if (oAuthUser.image) {
    try {
      const uploadResult = await uploadUserImage(oAuthUser.image, newUserId);
      if (uploadResult) {
        // Mutate sanitized user data to include image fields returned by ImageKit
        newUserData.image = uploadResult.url;
        newUserData.imageId = uploadResult.fileId;
      }
    } catch (err) {
      console.error(`[user-controller] ❌ Failed to upload OAuth user image for ${cleanEmail}:`, err);
    }
  }

  const newUser = await dbWrite.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        userId: newUserId,
        ...newUserData,
        isNewUser: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastActive: new Date(),
      })
      .returning();

    await tx.insert(userAuth).values({ userId: user.userId });

    return user;
  });

  // Ensure the LRU cache maps this email to the new userId immediately,
  // so subsequent requests in the same warm instance don't re-query the DB.
  invalidateByEmail(cleanEmail); // clears any stale null-result; next lookup caches the new id

  console.log(`[user-controller] ✅ Created new OAuth user: ${newUser.userId}`);
  return newUser.userId;
}

// ---------------------------------------------------------------------------
// setReferrerForNewUser  (unchanged from original)
// ---------------------------------------------------------------------------

/**
 * Sets a referrer for a newly created user.
 * Validates, updates the user record, awards referral credits to both parties,
 * logs activity, invalidates caches, and updates last activity.
 *
 * Returns true on success, false on any validation / not-found error.
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
      if (handleResponse) handleNotFoundError(res, 'User not found');
      return false;
    }

    const user = currentUser[0];

    if (!user.isNewUser) {
      if (handleResponse) handleValidationError(res, 'Referrer can only be set for new users');
      return false;
    }

    if (user.referrerId) {
      if (handleResponse) handleValidationError(res, 'Referrer already set');
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
      if (handleResponse) handleNotFoundError(res, 'Referrer user not found');
      return false;
    }

    if (referrer.userId === userId) {
      if (handleResponse) handleValidationError(res, 'Cannot refer yourself');
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
        metadata: { referredUserId: userId },
      }),
      awardCredits(userId, REFERRAL_BONUS, {
        type: 'reward',
        notificationType: 'referral_bonus',
        notificationTitle: 'Referral Bonus',
        notificationMessage: `You received ${REFERRAL_BONUS} credits for using a referral code`,
        metadata: { referrerId: referrer.userId },
      }),
    ]);

    // Log activity
    await logUserActivity(
      {
        userId,
        activityType: 'referrer_set',
        targetType: 'user',
        targetId: referrer.userId,
        metadata: { referrerUsername },
      },
      { req }
    );

    // Invalidate caches for both users
    await Promise.all([
      invalidateUserProfileCache(userId),
      invalidateUserProfileCache(referrer.userId),
    ]);

    // Update last activity
    await updateUserLastActivity(userId);

    console.log(`[user-controller] ✅ Applied referrer ${userId} → ${referrerUsername}`);
    return true;
  } catch (error) {
    console.error('[user-controller] ❌ Failed to apply referrer:', error);
    if (handleResponse) handleApiError(res, 'Failed to apply referrer', error);
    return false;
  }
}
