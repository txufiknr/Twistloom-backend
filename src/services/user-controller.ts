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

import { users, userAuth, userCounters, userProviders } from '../db/schema.js';
import { sql, eq, and, type SQL } from 'drizzle-orm';
import { type DBClient, dbRead, dbWrite } from '../db/client.js';
import { generateId } from '../utils/uuid.js';
import { sanitizeTextForDB } from '../utils/text-processing.js';
import { sanitizeUserData, getUserIdByEmail, logUserActivity, updateUserLastActivity, invalidateByEmail, performDailyCheckIn } from './user.js';
import { uploadUserImage } from './image.js';
import { cApiError, cNotFoundError, cValidationError } from '../utils/error.js';
import { sanitizeUsername } from '../utils/username.js';
import { invalidateUserProfileCache } from './cache.js';
import { REFERRAL_BONUS } from '../config/credits.js';
import { CURRENT_TERMS_VERSION } from '../config/legal.js';
import { awardCredits } from './credits.js';
import type { Context } from 'hono';
import { getClientIp } from '../hono/express-shim.js';
import type { DBNewUser } from '../types/schema.js';
import type { CheckinClaimType, EnrichedUserSelect } from '../types/user.js';
import type { PgColumn } from 'drizzle-orm/pg-core';

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
    id: users.userId,
    name: users.name,
    username: users.username,
    email: users.email,
    bio: users.bio,
    gender: users.gender,
    imageUrl: users.imageUrl,
    tier: users.tier,
    credits: users.credits,
    lastActive: users.lastActive,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    source: users.source,
    preferredLocale: users.preferredLocale,
    termsAcceptedAt: users.termsAcceptedAt,
    termsVersion: users.termsVersion,
    emailVerified: userAuth.emailVerified,
    isNewUser: users.isNewUser,
    // SSOT for welcome-modal: hide referrer input when already set at signup
    hasReferrer: sql<boolean>`(${users.referrerId} IS NOT NULL)`,
    // Moderation state — banned accounts get their public profile noindexed.
    isBanned: sql<boolean>`(${users.bannedAt} IS NOT NULL)`,
    // Expose the rest of the `user_counters` columns as SSOT-backed fields.
    booksGenerated: sql<number>`COALESCE(${userCounters.booksGenerated},0)`,
    booksCompleted: sql<number>`COALESCE(${userCounters.booksCompleted},0)`,
    pagesRead: sql<number>`COALESCE(${userCounters.pagesRead},0)`,
    pagesGenerated: sql<number>`COALESCE(${userCounters.pagesGenerated},0)`,
    branchesOpened: sql<number>`COALESCE(${userCounters.branchesOpened},0)`,
    topupCredits: sql<number>`COALESCE(${userCounters.topupCredits},0)`,
    referredUsers: sql<number>`COALESCE(${userCounters.referredUsers},0)`,
    followersCount: sql<number>`COALESCE(${userCounters.followersCount},0)`,
    followingCount: sql<number>`COALESCE(${userCounters.followingCount},0)`,
    // Comments the user wrote (top-level, parent_comment_id IS NULL) — SSOT-backed
    // by the `user_comments_user_count_trigger` (see triggers.ts).
    commentsCount: sql<number>`COALESCE(${userCounters.commentsCount},0)`,
    // NOTE: check-in streaks are date-sensitive — the trigger-maintained
    // user_counters values can go stale when a day is skipped. These columns are
    // kept only to satisfy the EnrichedUserSelect shape; every consumer must
    // override them with live values from getCheckInStreaks() before responding.
    activeCheckinStreak: sql<number>`COALESCE(${userCounters.activeCheckinStreak},0)`,
    maxCheckinStreak: sql<number>`COALESCE(${userCounters.maxCheckinStreak},0)`,
    customActionsWritten: sql<number>`COALESCE(${userCounters.customActionsWritten},0)`,

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
    accountDaysOld: sql<number>`CURRENT_DATE - ${users.createdAt}::date`,
    // TODO(D4): totalWords — SQL approximation first (SUM of char_length(pages.text)
    // across the author's active books), served behind the profile cache. Shipping a
    // stored `books.word_count` generated column is an O(1) follow-up backfill. See
    // docs/roadmap/USER_PROFILE_ENHANCEMENT_ROADMAP.md Q7.
    havePurchased: sql<boolean>`EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.user_id = ${users.userId} AND t.type = 'purchase'
    )`,
  } satisfies Record<keyof EnrichedUserSelect, SQL | PgColumn>;
}

/**
 * Gets the base query for fetching enriched user data.
 * @returns The base query instance
 * @example
 * const [userData] = await getEnrichedUserBaseQuery()
 * .where(whereCondition)
 * .limit(1);
 */
export function getEnrichedUserBaseQuery() {
  console.log('[user-controller] 👤 getEnrichedUserBaseQuery called');
  return dbRead
    .select(getEnrichedUserSelect())
    .from(users)
    .leftJoin(userCounters, eq(userCounters.userId, users.userId))
    .leftJoin(userAuth, eq(userAuth.userId, users.userId));
}

/**
 * Gets enriched user data based on a WHERE condition.
 * @param where The WHERE condition for the query
 * @returns The enriched user data
 * 
 * @example
 * const [userData] = await getEnrichedUser(whereCondition);
 */
export function getEnrichedUser(where: SQL) {
  console.log('[user-controller] 👤 getEnrichedUser called');
  return getEnrichedUserBaseQuery().where(where).limit(1);
}

/**
 * Gets enriched user data by user ID.
 * @param userId The user ID
 * @returns The enriched user data
 * 
 * @example
 * const [userData] = await getEnrichedUserById(userId);
 */
export function getEnrichedUserById(userId: string) {
  return getEnrichedUser(eq(users.userId, userId));
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
  sub?: string;
}): Promise<string> {
  const cleanEmail = sanitizeTextForDB(String(oAuthUser.email).trim().toLowerCase());

  // ── Returning user path ────────────────────────────────────────────────────
  const existingUserId = await getUserIdByEmail(cleanEmail);

  if (existingUserId) {
    // Only update fields that come from the OAuth provider and can legitimately
    // change between sign-ins (display name, profile picture).
    // username and email are intentionally excluded.
    const updateData: Partial<Pick<DBNewUser, 'name' | 'imageUrl'>> = {};

    const { image: imageUrl, ...oAuthUserData } = oAuthUser;
    const { name: updateName } = await sanitizeUserData({ ...oAuthUserData, imageUrl }, { createNew: false }) ?? {};
    if (updateName) updateData.name = updateName;

    // The OAuth profile picture is intentionally NOT uploaded to ImageKit for
    // returning users. The image was already uploaded once during first-time
    // sign-in (see new-user path below). On subsequent logins we skip the
    // upload to avoid overwriting the user's custom avatar they may have set
    // via the platform's profile editor. Users who want to update their
    // profile picture are encouraged to do so inside Twistloom.

    if (Object.keys(updateData).length) {
      await dbWrite
        .update(users)
        .set({ ...updateData, lastActive: new Date(), updatedAt: new Date() })
        .where(eq(users.userId, existingUserId));

      console.log(`[user-controller] ✅ Updated existing OAuth user: ${existingUserId}`);

      // Invalidate LRU cache so subsequent email→userId lookups are fresh
      invalidateByEmail(cleanEmail);
    }

    // Upsert Google provider — insert if first sign-in, no-op if already recorded
    if (oAuthUser.sub) {
      await dbWrite
        .insert(userProviders)
        .values({
          userId: existingUserId,
          provider: 'google',
          providerAccountId: oAuthUser.sub,
        })
        .onConflictDoNothing({ target: [userProviders.userId, userProviders.provider] });
    }

    // Ensure emailVerified is set for existing user signing in via verified Google OAuth
    await dbWrite
      .insert(userAuth)
      .values({
        userId: existingUserId,
        emailVerified: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userAuth.userId,
        set: {
          emailVerified: sql`COALESCE(${userAuth.emailVerified}, NOW())`,
          emailVerificationToken: null,
          emailVerificationExpires: null,
          updatedAt: new Date(),
        },
      });

    // Form-signup users who linked a referrer but skipped OTP may qualify here
    await tryAwardReferralBonus(existingUserId);

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
        // TODO: insert into uploadedImages
        // newUserData.image = uploadResult.url;
        // newUserData.imageId = uploadResult.fileId;
        newUserData.imageUrl = uploadResult.url;
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
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        ageConfirmedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastActive: new Date(),
      })
      .returning();

    await tx.insert(userAuth).values({
      userId: user.userId,
      emailVerified: new Date(),
    });

    await tx.insert(userProviders).values({
      userId: user.userId,
      provider: 'google',
      providerAccountId: oAuthUser.sub ?? null,
    });

    return user;
  });

  // Ensure the LRU cache maps this email to the new userId immediately,
  // so subsequent requests in the same warm instance don't re-query the DB.
  invalidateByEmail(cleanEmail); // clears any stale null-result; next lookup caches the new id

  console.log(`[user-controller] ✅ Created new OAuth user: ${newUser.userId}`);
  return newUser.userId;
}

/**
 * Sets a referrer for a newly created user (attribution only).
 *
 * **Split model — link vs pay:**
 * 1. Always writes `users.referrerId` when valid (attribution).
 * 2. Does **not** pay credits unless the referred user already has
 *    `user_auth.email_verified` set (Google OAuth path).
 * 3. Form signups typically link here and pay later via
 *    {@link tryAwardReferralBonus} on `POST /auth/verify-email`.
 *
 * **Referrer eligibility:** the referrer's email must be verified. Unverified
 * accounts cannot share invite links (username rejected as not found / not eligible).
 *
 * **`referredUsers` counter:** the DB trigger increments
 * `user_counters.referred_users` only when `referral_rewarded_at` is first
 * set (same claim as credit payout) — not on bare `referrer_id` link.
 *
 * @param c - Hono context (IP / headers for activity log; optional error responses)
 * @param userId - Referred (new) user ID
 * @param referrerUsername - Referrer's username
 * @param opts.client - DB client (default: dbWrite)
 * @param opts.handleResponse - Whether to write HTTP errors onto `c` (default: true)
 * @returns true if referrerId was set; false on validation / not-found
 *
 * @example
 * ```typescript
 * // Signup / onboarding
 * await setReferrerForNewUser(c, newUserId, 'alice', { handleResponse: false });
 * // Credits pay only if newUser is already email-verified (e.g. Google)
 * ```
 */
export async function setReferrerForNewUser(
  c: Context,
  userId: string,
  referrerUsername: string,
  opts: {
    client?: DBClient;
    handleResponse?: boolean; // Whether to send API responses (default: true)
  } = {}
): Promise<boolean> {
  const { client = dbWrite, handleResponse = true } = opts;
  const res = c;

  try {
    // Ensure user exists and is new
    const [user] = await dbRead
      .select({ userId: users.userId, isNewUser: users.isNewUser, referrerId: users.referrerId })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!user) {
      console.warn('[setReferrerForNewUser] ⚠️ User not found:', userId);
      if (handleResponse) return !!cNotFoundError(res, 'User not found');
      return false;
    }

    if (!user.isNewUser) {
      console.warn('[setReferrerForNewUser] ⚠️ Referrer can only be set for new users, userId:', userId);
      if (handleResponse) return !!cValidationError(res, 'Referrer can only be set for new users');
      return false;
    }

    if (user.referrerId) {
      console.warn('[setReferrerForNewUser] ⚠️ Referrer already set, userId:', userId, 'referrerId:', user.referrerId);
      if (handleResponse) return !!cValidationError(res, 'Referrer already set');
      return false;
    }

    // Find referrer by username — must have verified email to be eligible
    const cleanReferrer = sanitizeUsername(referrerUsername);
    const [referrer] = await dbRead
      .select({
        userId: users.userId,
        username: users.username,
        emailVerified: userAuth.emailVerified,
      })
      .from(users)
      .leftJoin(userAuth, eq(userAuth.userId, users.userId))
      .where(eq(users.username, cleanReferrer))
      .limit(1);

    if (!referrer) {
      console.warn('[setReferrerForNewUser] ⚠️ Referrer user not found:', referrerUsername);
      if (handleResponse) return !!cNotFoundError(res, 'Referrer user not found');
      return false;
    }

    if (!referrer.emailVerified) {
      console.warn('[setReferrerForNewUser] ⚠️ Referrer email not verified:', referrerUsername);
      // Same outward message as not-found — avoid leaking account state
      if (handleResponse) return !!cNotFoundError(res, 'Referrer user not found');
      return false;
    }

    if (referrer.userId === userId) {
      console.warn('[setReferrerForNewUser] ⚠️ Cannot refer yourself, userId:', userId);
      if (handleResponse) return !!cValidationError(res, 'Cannot refer yourself');
      return false;
    }

    // Record referrer only — do NOT flip isNewUser; onboarding still owns that flag
    await client
      .update(users)
      .set({ referrerId: referrer.userId, updatedAt: new Date() })
      .where(eq(users.userId, userId));

    // Pay only if referred user is already verified (Google / already-verified path).
    // Form signup: email still unverified → tryAwardReferralBonus no-ops until verify-email.
    await tryAwardReferralBonus(userId);

    // Log activity
    await logUserActivity(
      {
        userId,
        activityType: 'referrer_set',
        targetType: 'user',
        targetId: referrer.userId,
        metadata: { referrerUsername },
      },
      { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } }
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
    if (handleResponse) return !!cApiError(res, 'Failed to apply referrer', error);
    return false;
  }
}

/**
 * Pays the mutual referral bonus once the referred user qualifies.
 *
 * **Qualification (v1):**
 * - `users.referrer_id` is set
 * - `user_auth.email_verified` is set
 * - `users.referral_rewarded_at` is still null (idempotency claim)
 *
 * **Idempotency:** atomically sets `referral_rewarded_at` before awarding.
 * Concurrent callers / re-verify / re-entry cannot double-pay.
 * That same column transition fires `users_referral_trigger` (+1
 * `referred_users` for the referrer) inside the payout transaction.
 *
 * **Not re-paid** when the user later changes email (verification reset) —
 * the first successful claim sticks forever.
 *
 * Call sites:
 * - {@link setReferrerForNewUser} when referred user is already verified
 * - `POST /auth/verify-email` after token verification succeeds
 * - Google OAuth paths that mark email verified while a pending referrer exists
 *   (covered if set-referrer runs after verify, or verify runs after set-referrer)
 *
 * @param userId - Referred user who may now qualify for payout
 * @returns true if credits were awarded this call; false if skipped / already paid
 *
 * @example
 * ```typescript
 * // After email verification
 * const userId = await verifyEmailToken(token);
 * if (userId) await tryAwardReferralBonus(userId);
 * ```
 */
export async function tryAwardReferralBonus(userId: string): Promise<boolean> {
  try {
    // Fast pre-checks (non-authoritative — claim below is the real guard)
    const [row] = await dbRead
      .select({
        referrerId: users.referrerId,
        referralRewardedAt: users.referralRewardedAt,
        emailVerified: userAuth.emailVerified,
      })
      .from(users)
      .leftJoin(userAuth, eq(userAuth.userId, users.userId))
      .where(eq(users.userId, userId))
      .limit(1);

    if (!row?.referrerId) {
      return false;
    }
    if (row.referralRewardedAt) {
      return false;
    }
    if (!row.emailVerified) {
      console.log(`[tryAwardReferralBonus] ⏳ Deferred — email not verified yet: ${userId}`);
      return false;
    }

    // Claim + both credit awards in one transaction so a failed award rolls back the claim
    const referrerId = await dbWrite.transaction(async (tx) => {
      const claimed = await tx
        .update(users)
        .set({ referralRewardedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(users.userId, userId),
            sql`${users.referrerId} IS NOT NULL`,
            sql`${users.referralRewardedAt} IS NULL`,
          ),
        )
        .returning({ referrerId: users.referrerId });

      if (claimed.length === 0 || !claimed[0].referrerId) {
        return null;
      }

      const rid = claimed[0].referrerId;

      await awardCredits(rid, REFERRAL_BONUS, {
        type: 'reward',
        notificationType: 'referral_bonus',
        notificationTitle: 'Referral Bonus',
        notificationMessage: `You received ${REFERRAL_BONUS} credits for referring a new user`,
        metadata: { referredUserId: userId },
        context: 'referral_bonus',
        tx,
      });
      await awardCredits(userId, REFERRAL_BONUS, {
        type: 'reward',
        notificationType: 'referral_bonus',
        notificationTitle: 'Referral Bonus',
        notificationMessage: `You received ${REFERRAL_BONUS} credits for using a referral code`,
        metadata: { referrerId: rid },
        context: 'referral_bonus',
        tx,
      });

      return rid;
    });

    if (!referrerId) {
      return false;
    }

    await Promise.all([
      invalidateUserProfileCache(userId),
      invalidateUserProfileCache(referrerId),
    ]);

    console.log(`[tryAwardReferralBonus] ✅ Paid referral bonus ${referrerId} ↔ ${userId}`);
    return true;
  } catch (error) {
    console.error('[tryAwardReferralBonus] ❌ Failed to award referral bonus:', error);
    // Do not rethrow — callers (verify-email, set-referrer) should not fail the primary action.
    // Claim + awards share one transaction; on failure referral_rewarded_at stays null for retry.
    return false;
  }
}

/**
 * Shared request handler for daily check-in and VIP double claim.
 *
 * @param c - Hono context
 * @param claimType - 'regular' (default) or 'vip_2x'
 */
export async function handleCheckIn(
  c: Context,
  claimType: CheckinClaimType = 'regular'
): Promise<Response> {
  const label = claimType === 'vip_2x' ? 'VIP double claim' : 'daily check-in';
  const userId = c.get('userId')!;
  try {
    const result = await performDailyCheckIn(userId, claimType);

    if (result.success) {
      c.status(201);
    } else {
      console.log(`[checkin] ❌ User ${userId} failed ${label}`);
      c.status(400);
    }

    // Invalidate user cache and update last activity
    await Promise.all([
      invalidateUserProfileCache(userId),
      updateUserLastActivity(userId),
    ]);

    return c.json(result);
  } catch (error) {
    return cApiError(c, `Failed to perform ${label}`, error);
  }
}
