/**
 * User Routes
 * 
 * Provides endpoints for managing user profile information, likes, favorites, and follows.
 * Implements CRUD operations for user profile storage and retrieval, plus social features.
 * 
 * Architecture Features:
 * - User profile management
 * - Partial update operations
 * - Conflict resolution with upsert patterns
 * - Consistent error handling and validation
 * - Analytics-friendly user tracking
 * - Social interactions (likes, favorites, follows)
 * - Daily check-in and referral system
 * - Activity logging, reading progress, and achievements
 * 
 * Endpoints:
 * - GET /user - Get authenticated user profile
 * - GET /users/:identifier - Get user profile by UUID or username (public)
 * - POST /user - Complete onboarding
 * - PUT /user - Partially update user profile
 * - DELETE /user - Delete user profile and all associated data
 * - POST /user/likes - Like a target item
 * - DELETE /user/likes - Unlike a target item
 * - GET /user/likes - Get user likes
 * - POST /user/favorites - Add book to favorites
 * - DELETE /user/favorites - Remove book from favorites
 * - GET /user/collections - Get user collection names
 * - POST /users/:id/follow - Follow a user
 * - DELETE /users/:id/follow - Unfollow a user
 * - GET /users/:id/followers - Get user followers
 * - GET /users/:id/following - Get user following
 * - GET /user/followers - Get authenticated user's followers
 * - GET /user/following - Get authenticated user's following
 * - GET /user/checkin/status - Get daily check-in status
 * - POST /user/checkin - Perform daily check-in and claim free credits
 * - POST /user/checkin/double - VIP double claim
 * - GET /user/activity-logs - Get user activity logs
 * - GET /user/progress - Get story reading progress
 * - GET /user/achievements - Get user achievements
 * - GET /user/achievements/unnotified - Get newly unlocked badges
 * - POST /user/achievements/acknowledge - Mark achievements as viewed
 * - GET /user/quests - Get the user's quest log ("The Prologue")
 * - POST /user/quests/recheck - Re-evaluate quest completion
 * - POST /user/quests/claim-all - Claim all completed quest rewards at once
 * - POST /user/quests/:questId/claim - Claim a completed quest's credit reward
 * 
 * Note: Comment CRUD endpoints are in books.ts, not this file.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { DBNewUserFeedback, DBNewUserLike, DBNewUserFavorite } from "../types/schema.js";
import type { FeedbackCategory, LikeTargetType, Source, User, UserAchievement, UserActivityType, UserStats } from "../types/user.js";
import { feedbackCategories, sources } from "../types/user.js";
import { dbRead, dbWrite } from "../db/client.js";
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { users, books, userAuth, userLikes, userFavorites, userFollows, userActivityLogs, userAchievements, userSessions, userCompletedBooks, userComments, transactions, userProviders, userFeedbacks, bookTestimonials, uploadedImages, userReports, userBlocks } from "../db/schema.js";
import { getErrorMessage, cApiError, cNotFoundError, cConflictError, cValidationError, cUnauthorizedError } from "../utils/error.js";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { calculatePaginationMeta, extractPaginationParams } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { updateUserLastActivity, getCheckInStatus, getCheckInStreaks, logUserActivity, sanitizeProfileUpdate, enrichActivityLogs } from "../services/user.js";
import { invalidateCachePattern } from "../utils/cache.js";
import { invalidateExploreCache, invalidateUserBooksCache, invalidateUserProfileCache, withCache, CACHE_KEYS, CACHE_TTL } from "../services/cache.js";
import { getEnrichedUser, getEnrichedUserById, setReferrerForNewUser, handleCheckIn, joinBetaTesterProgram } from "../services/user-controller.js";
import { uploadUserImage, uploadFeedbackScreenshot, persistUploadedImage } from "../services/image.js";
import { isValidUuid } from "../utils/uuid.js";
import { getStoryProgressWithBranch } from '../services/story-branch.js';
import { checkAndAwardAchievements, getUserAchievements, getUserMetrics } from '../services/achievements.js';
import { getUserQuests, summarizeQuests, recheckQuests, claimQuestRewardAndInvalidate, claimAllQuestRewardsAndInvalidate } from '../services/quests.js';
import { verifyPassword } from "../utils/password.js";
import { OAuth2Client } from "google-auth-library";
import type { PaginationMeta } from '../types/api.js';
import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';
import type { AppEnv } from "../hono/env.js";
import { getClientIp } from "../hono/express-shim.js";

const router = new Hono<AppEnv>();

// Google OAuth client used to re-verify a Google ID token during the
// account-deletion re-authentication gate (see DELETE /user below).
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * GET /api/user
 *
 * Returns the authenticated user's full enriched profile, including engagement
 * metrics (books generated, reads count, likes received, etc.) and subscription info.
 *
 * @route GET /api/user
 * @description Get authenticated user profile with engagement counts
 * 
 * @returns {Object} User profile
 * @returns {string} user.id - User's unique identifier
 * @returns {string} user.username - User's username
 * @returns {string|null} user.name - User's display name
 * @returns {string|null} user.email - User's email
 * @returns {string|null} user.bio - User's bio
 * @returns {string|null} user.gender - User's gender
 * @returns {string|null} user.imageUrl - User's profile image URL
 * @returns {number} user.credits - Available credits
 * @returns {boolean} user.isNewUser - Onboarding completed flag
 * @returns {boolean} user.hasReferrer - Whether a referrer is already set (SSOT for welcome modal)
 * @returns {boolean} user.emailVerified - Whether email is verified
 * @returns {boolean} user.havePurchased - Whether user has made purchases
 * @returns {number} user.booksGenerated - Books generated count
 * @returns {number} user.booksCompleted - Books completed count
 * @returns {number} user.readsCount - Reading sessions count
 * @returns {number} user.pagesRead - Total pages read
 * @returns {number} user.pagesGenerated - AI-generated pages
 * @returns {number} user.branchesOpened - Story branches explored
 * @returns {number} user.likedBooksCount - Books user liked
 * @returns {number} user.savedBooksCount - Books saved to favorites
 * @returns {number} user.followersCount - Number of followers
 * @returns {number} user.likesReceived - Total likes received on user's books
 * @returns {number} user.accountDaysOld - Days since account creation
 * @returns {number} user.topupCredits - Total credits topped up
 * @returns {number} user.referredUsers - Referred users count
 * @returns {number} user.activeCheckinStreak - Current check-in streak
 * @returns {number} user.maxCheckinStreak - Longest check-in streak
 * @returns {number} user.customActionsWritten - Custom actions authored
 * @returns {Object} user.subscription - Subscription info
 * @returns {string|null} user.subscription.tier - User's subscription tier (SSOT for VIP gating)
 * @returns {Date} user.lastActive - Last activity timestamp
 * @returns {Date} user.createdAt - Account creation timestamp
 * @returns {Date} user.updatedAt - Last update timestamp
 * 
 * @example
 * // Request
 * GET /api/user
 * 
 * // Response
 * {
 *   "user": {
 *     "id": "user-uuid",
 *     "name": "John Doe",
 *     "username": "johndoe",
 *     "email": "john@example.com",
 *     "bio": "Thriller enthusiast",
 *     "gender": "male",
 *     "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
 *     "credits": 500,
 *     "isNewUser": false,
 *     "emailVerified": "2024-01-01T00:00:00.000Z",
 *     "havePurchased": true,
 *     "booksGenerated": 5,
 *     "booksCompleted": 3,
 *     "readsCount": 150,
 *     "pagesRead": 350,
 *     "pagesGenerated": 80,
 *     "branchesOpened": 15,
 *     "likedBooksCount": 25,
 *     "savedBooksCount": 8,
 *     "followersCount": 42,
 *     "likesReceived": 156,
 *     "accountDaysOld": 380,
 *     "topupCredits": 200,
 *     "referredUsers": 3,
 *     "activeCheckinStreak": 5,
 *     "maxCheckinStreak": 12,
 *     "customActionsWritten": 2,
 *     "subscription": {
 *       "tier": null,
 *     },
 *     "lastActive": "2024-01-15T10:30:00.000Z",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2024-01-15T10:30:00.000Z"
 *   }
 * }
 */
router.get('/', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const [user] = await getEnrichedUserById(userId);

    if (!user) return cNotFoundError(c, 'User not found');

    // Streaks are date-sensitive — always recompute live from the check-in
    // history instead of trusting the trigger-backed user_counters columns.
    const streaks = await getCheckInStreaks(userId);

    const providers = await dbRead
      .select({ provider: userProviders.provider })
      .from(userProviders)
      .where(eq(userProviders.userId, userId));

    // Normalize: move tier into subscription sub-object for consistent API shape
    // with GET /api/users/:identifier. The frontend reads user.subscription.tier
    // for VIP gating — keeping it as a single authoritative field prevents SSOT drift.
    const { tier, ...restUser } = user;
    return c.json({
      user: {
        ...restUser,
        activeCheckinStreak: streaks.activeStreak,
        maxCheckinStreak: streaks.longestStreak,
        subscription: { tier },
        linkedMethods: providers.map(p => p.provider),
      }
    });
  } catch (error) {
    console.error('[GET /api/user] ❌', error);
    return cApiError(c, 'Failed to fetch user profile', error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/user/export
// ---------------------------------------------------------------------------

/**
 * GET /api/user/export
 *
 * Exports all of the authenticated user's personal data in a structured JSON
 * format. Fulfils GDPR Art. 20 (right to data portability) and CCPA (right
 * to know / right to request disclosure).
 *
 * @route GET /api/user/export
 * @description Export all user data for GDPR portability
 * @auth Required
 *
 * @returns {Object} JSON object containing all user data
 * @returns {string} exportedAt - ISO timestamp of when the export was generated
 * @returns {Object} profile - User profile record
 * @returns {Object|null} auth - Auth metadata (emailVerified, createdAt)
 * @returns {Array} books - Books authored by the user
 * @returns {Array} sessions - Reading sessions
 * @returns {Array} completedBooks - Books the user completed
 * @returns {Array} comments - Comments the user made
 * @returns {Array} likes - Likes the user made
 * @returns {Array} favorites - Books the user favorited
 * @returns {Array} transactions - Credit transactions
 * @returns {Array} activityLogs - User activity log (last 1000 entries)
 * @returns {Array} achievements - Unlocked achievements
 *
 * @example
 * // Request
 * GET /api/user/export
 *
 * // Response (200)
 * {
 *   "exportedAt": "2026-07-22T12:00:00.000Z",
 *   "profile": { "userId": "...", "name": "John Doe", ... },
 *   "auth": { "emailVerified": "2026-01-01T00:00:00.000Z", "createdAt": "2026-01-01T00:00:00.000Z" },
 *   "books": [...],
 *   ...
 * }
 */
router.get('/export', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;

    // Fetch all user data in parallel for performance
    const [
      profileResult,
      authResult,
      booksResult,
      sessionsResult,
      completedBooksResult,
      commentsResult,
      likesResult,
      favoritesResult,
      transactionsResult,
      activityLogsResult,
      achievementsResult,
    ] = await Promise.all([
      dbRead
        .select({
          // Explicit column allow-list (NOT `select().from(users)`): per GDPR/CCPA
          // rules, an export should contain the user's *personal data*, not auth
          // internals. The full `users` row includes passwordHash, tokenVersion,
          // customerId (Stripe/Xendit), subscriptionId, referrerId and imageId —
          // all of which are stripped here. The bcrypt hash in particular has no
          // legitimate use for the user and would become a credential-stuffing
          // aid if the exported file ever leaked.
          userId: users.userId,
          name: users.name,
          username: users.username,
          email: users.email,
          credits: users.credits,
          penName: users.penName,
          bio: users.bio,
          gender: users.gender,
          imageUrl: users.imageUrl,
          tier: users.tier,
          isNewUser: users.isNewUser,
          source: users.source,
          preferredLocale: users.preferredLocale,
          emailPreferences: users.emailPreferences,
          referralRewardedAt: users.referralRewardedAt,
          vipExpiresAt: users.vipExpiresAt,
          vipTrialUsedAt: users.vipTrialUsedAt,
          termsAcceptedAt: users.termsAcceptedAt,
          termsVersion: users.termsVersion,
          ageConfirmedAt: users.ageConfirmedAt,
          isBetaTester: users.isBetaTester,
          betaTesterJoinedAt: users.betaTesterJoinedAt,
          lastActive: users.lastActive,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.userId, userId)),
      dbRead.select().from(userAuth).where(eq(userAuth.userId, userId)),
      dbRead.select().from(books).where(eq(books.userId, userId)),
      dbRead.select().from(userSessions).where(eq(userSessions.userId, userId)),
      dbRead.select().from(userCompletedBooks).where(eq(userCompletedBooks.userId, userId)),
      dbRead.select().from(userComments).where(eq(userComments.userId, userId)),
      dbRead.select().from(userLikes).where(eq(userLikes.userId, userId)),
      dbRead.select().from(userFavorites).where(eq(userFavorites.userId, userId)),
      dbRead.select().from(transactions).where(eq(transactions.userId, userId)),
      dbRead.select().from(userActivityLogs).where(eq(userActivityLogs.userId, userId)).limit(1000),
      dbRead.select().from(userAchievements).where(eq(userAchievements.userId, userId)),
    ]);

    const profile = profileResult[0] ?? null;
    const auth = authResult[0] ?? null;

    return c.json({
      exportedAt: new Date().toISOString(),
      profile,
      auth: auth ? { emailVerified: auth.emailVerified, createdAt: auth.createdAt } : null,
      books: booksResult,
      sessions: sessionsResult,
      completedBooks: completedBooksResult,
      comments: commentsResult,
      likes: likesResult,
      favorites: favoritesResult,
      transactions: transactionsResult,
      activityLogs: activityLogsResult,
      achievements: achievementsResult,
    });
  } catch (error) {
    console.error('[GET /api/user/export] ❌', error);
    return cApiError(c, 'Failed to export user data', error);
  }
});

/**
 * POST /api/user
 * 
 * Completes the onboarding flow for a new user. Sets isNewUser = false.
 * Should be called exactly once, after the onboarding wizard is submitted.
 *
 * All fields are optional. If omitted, the existing auto-generated values
 * (username derived from name/email, empty bio, etc.) are kept.
 * 
 * @route POST /api/user
 * @description Complete onboarding for new user
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Onboarding data (all optional; empty body still completes onboarding)
 * @body {string} [name] - User's display name
 * @body {string} [username] - Desired username
 * @body {string} [imageUrl] - Profile image URL or base64 data
 * @body {string} [gender] - User's gender (e.g., "male", "female", "unknown")
 * @body {string} [source] - How the user found Twistloom
 * @body {string} [referrer] - Referrer username
 * 
 * @returns {Object} Onboarding completion response
 * @returns {string} message - Confirmation message
 * @returns {boolean} isNewUser - Always false after onboarding
 * @returns {string} username - User's username
 * 
 * @example
 * // Request
 * POST /user
 * Body: {
 *   "name": "John Doe",
 *   "source": "friend"
 * }
 * 
 * // Response
 * {
 *   "message": "Onboarding complete",
 *   "isNewUser": false,
 *   "username": "johndoe"
 * }
 */
router.post('/', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const body = c.get("body") ?? {};

    const [current] = await dbRead
      .select({ isNewUser: users.isNewUser, username: users.username })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!current) return cNotFoundError(c, 'User not found');

    // Idempotent: already finished — success so fire-and-forget clients don't error
    if (!current.isNewUser) {
      return c.json({
        message: 'Onboarding already completed',
        isNewUser: false,
        username: current.username,
      });
    }

    // 1. Sanitize payload via SSOT (all fields optional; empty body is valid)
    const updateData = await sanitizeProfileUpdate(userId, body, c);
    if (!updateData) return;

    // 2. Avatar base64 → ImageKit (same path as PUT /user)
    if (updateData.imageUrl?.startsWith('data:')) {
      const uploadResult = await uploadUserImage(updateData.imageUrl, userId);
      if (!uploadResult?.url) {
        console.warn('[POST /api/user] ⚠️ Failed to upload profile image');
        return cApiError(c, 'Failed to upload profile image', new Error('ImageKit upload returned no URL'));
      }
      await persistUploadedImage({
        imageId: uploadResult.fileId!,
        imageUrl: uploadResult.url!,
        type: 'user',
        userId,
      });
      // Trigger sets users.image_url
      delete updateData.imageUrl;
    }

    // 3. Complete onboarding
    updateData.isNewUser = false;
    updateData.updatedAt = new Date();

    if (body.source && typeof body.source === 'string' && sources.includes(body.source as Source)) {
      updateData.source = body.source;
    }

    await dbWrite
      .update(users)
      .set(updateData)
      .where(eq(users.userId, userId));

    // 4. Referrer (optional; no-ops if already set)
    if (body.referrer && typeof body.referrer === 'string') {
      await setReferrerForNewUser(c, userId, body.referrer, { handleResponse: false });
    }

    await invalidateUserProfileCache(userId);
    await updateUserLastActivity(userId);
    await logUserActivity(
      { userId, activityType: 'onboarding_complete', targetType: 'user', targetId: userId },
      { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } }
    );

    // Default engagement prefs (opt-out) + optional preferredLocale from client UI cookie
    const { ensureDefaultEmailPreferences, updatePreferredLocale } = await import('../services/email-preferences.js');
    await ensureDefaultEmailPreferences(userId);

    const { isEmailLocale } = await import('../types/email-locale.js');
    if (body.preferredLocale && isEmailLocale(body.preferredLocale)) {
      await updatePreferredLocale(userId, body.preferredLocale);
    }

    const [userRow] = await dbRead
      .select({ email: users.email, username: users.username })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (userRow?.email) {
      const { sendWelcomeEmail, sendEmailSafe } = await import('../utils/email.js');
      const username =
        (updateData.username as string | undefined) ?? userRow.username ?? current.username;
      sendEmailSafe('POST /api/user welcome', () =>
        sendWelcomeEmail(userRow.email, username, { userId }),
      );
    }

    return c.json({
      message:   'Onboarding complete',
      isNewUser: false,
      username:  (updateData.username as string | undefined) ?? current.username,
    });
  } catch (error) {
    console.error('[POST /api/user] ❌', error);
    return cApiError(c, 'Failed to complete onboarding', error);
  }
});

/**
 * PUT /api/user
 * 
 * Partially updates the authenticated user's profile.
 * Only provided fields are updated, existing fields remain unchanged.
 * Image upload is handled via the sanitizeProfileUpdate service.
 * 
 * @route PUT /api/user
 * @description Partially update user profile
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Partial user profile data
 * @body {string} [name] - User's display name
 * @body {string} [bio] - User's bio/description
 * @body {string} [gender] - User's gender
 * @body {string} [imageUrl] - User's profile image URL or base64 data
 *
 * Note: `referrer` and onboarding `source` belong on POST /user (complete onboarding),
 * not here. PUT never flips isNewUser.
 * 
 * @returns {Object} Update response
 * @returns {boolean} success - Operation status
 * @returns {Object} user - Updated user profile
 * 
 * @example
 * // Request
 * PUT /user
 * Body: {
 *   "name": "John Doe",
 *   "bio": "Thriller enthusiast",
 *   "gender": "male"
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "user": {
 *     "id": "user-uuid",
 *     "name": "John Doe",
 *     "bio": "Thriller enthusiast",
 *     "gender": "male",
 *     "imageUrl": null,
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-15T12:00:00.000Z"
 *   }
 * }
 */
router.put('/', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const body = c.get("body") ?? {};

    // 1. Sanitize payload via SSOT
    const updateData = await sanitizeProfileUpdate(userId, body, c);
    if (!updateData) return;

    // Require at least one valid field to update
    if (Object.keys(updateData).length === 0) {
      console.warn('[PUT /api/user] ⚠️ At least one valid field must be provided');
      return cValidationError(c, 'At least one valid field must be provided');
    }

    // 2. Upload profile image to ImageKit if it's base64 data
    if (updateData.imageUrl?.startsWith('data:')) {
      const uploadResult = await uploadUserImage(updateData.imageUrl, userId);
      if (!uploadResult?.url) {
        console.warn('[PUT /api/user] ⚠️ Failed to upload profile image - ImageKit upload returned no URL');
        return cApiError(c, 'Failed to upload profile image', new Error('ImageKit upload returned no URL'));
      }

      // Old user images are cleaned up by daily cron (cleanupStaleUserUploads).
      await persistUploadedImage({
        imageId: uploadResult.fileId!,
        imageUrl: uploadResult.url!,
        type: 'user',
        userId,
      });

      // Remove from updateData — trigger handles users.image_url
      delete updateData.imageUrl;
    }

    // 3. Apply partial profile update (does not complete onboarding)
    updateData.updatedAt = new Date();

    const [user] = await dbWrite
      .update(users)
      .set(updateData)
      .where(eq(users.userId, userId))
      .returning();

    await invalidateUserProfileCache(userId);
    await updateUserLastActivity(userId);

    // Rename userId → id for frontend consistency
    // Normalize: move tier into subscription sub-object (consistent with GET /api/user)
    // Expose hasReferrer (boolean SSOT); never leak raw referrerId UUID to clients
    const { userId: id, tier: putTier, referrerId, ...putRest } = user;
    return c.json({
      success: true,
      user: {
        id,
        ...putRest,
        hasReferrer: !!referrerId,
        subscription: { tier: putTier },
      },
    });
  } catch (error) {
    console.error('[PUT /api/user] ❌', error);
    return cApiError(c, 'Failed to update profile', error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/user/users/top-creators
// ---------------------------------------------------------------------------

/** Length of the "this week" window (7 days) used by the top creators query. */
const TOP_CREATORS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/user/users/top-creators
 *
 * Returns the users who created the most books in the last 7 days. Powers the
 * "Creators writing this week" section on the homepage.
 *
 * Only books with `status = 'active'` and `visibility = 'public'` are counted,
 * so the ranking reflects creators actively publishing stories visible to the
 * community, not private drafts or archived books.
 *
 * Results are ordered by `booksCreated` descending and capped by `limit`.
 * The query result is cached (30 min TTL) since the weekly window changes
 * slowly and this endpoint is served on the high-traffic homepage.
 *
 * @route GET /api/user/users/top-creators
 * @description Get top creators by books created in the last 7 days
 *
 * @query {number} [limit] - Maximum number of creators to return (default: 10, max: 50)
 *
 * @returns {Object} Top creators response
 * @returns {Array} creators - Array of top creators, ordered by booksCreated desc
 * @returns {string} creators[].userId - Creator's unique identifier
 * @returns {string} creators[].name - Creator's display name
 * @returns {string} creators[].username - Creator's username
 * @returns {string|null} creators[].imageUrl - Creator's profile image URL
 * @returns {number} creators[].booksCreated - Number of public books created in the last 7 days
 *
 * @example
 * // Request
 * GET /api/user/users/top-creators?limit=5
 *
 * // Response
 * {
 *   "creators": [
 *     { "userId": "uuid", "name": "John Doe", "username": "johndoe", "imageUrl": "https://...", "booksCreated": 3 }
 *   ]
 * }
 */
router.get("/users/top-creators", async (c: Context<AppEnv>) => {
  try {
    const rawLimit = parseInt(c.req.query("limit") || "10", 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 10, 1), 50);

    const cutoff = new Date(Date.now() - TOP_CREATORS_WINDOW_MS);
    const cacheKey = CACHE_KEYS.TOP_CREATORS(limit);

    const fetchTopCreators = async () => {
      const rows = await dbRead
        .select({
          userId: users.userId,
          name: users.name,
          username: users.username,
          imageUrl: users.imageUrl,
          booksCreated: sql<number>`COUNT(${books.id})::int`,
        })
        .from(users)
        .innerJoin(books, eq(books.userId, users.userId))
        .where(
          and(
            gte(books.createdAt, cutoff),
            eq(books.status, 'active'),
            eq(books.visibility, 'public'),
          )
        )
        .groupBy(users.userId, users.name, users.username, users.imageUrl)
        .orderBy(sql`COUNT(${books.id})::int DESC`)
        .limit(limit);

      return rows;
    };

    const creators = await withCache(cacheKey, fetchTopCreators, CACHE_TTL.THIRTY_MINUTES);

    c.header('Cache-Control', 'public, max-age=1800, stale-while-revalidate=300');
    return c.json({ creators });
  } catch (error) {
    console.error('[GET /api/user/users/top-creators] ❌', error);
    return cApiError(c, 'Failed to retrieve top creators', error);
  }
});

/**
 * GET /users/:identifier
 * 
 * Fetch user profile by identifier (UUID or username).
 * Industry standard implementation (Twitter/X, Instagram, GitHub, LinkedIn):
 * - Backend accepts both UUID and username in single endpoint
 * - Backend resolves UUID-to-username server-side
 * - Returns user data directly with single API call
 * - Frontend optionally redirects to canonical username URL for SEO
 * - Eliminates double API call penalty
 * 
 * @route GET /users/:identifier
 * @description Get user profile by UUID or username
 * 
 * @param identifier - UUID or username
 * 
 * @returns {Object} User profile response
 * @returns {Object} user - User profile object (see GET /user for full field listing)
 * @returns {Object} user.subscription - Subscription info
 * @returns {Object} user.stats - User statistics (all UserStats fields)
 * 
 * @example
 * // Request with UUID
 * GET /users/123e4567-e89b-12d3-a456-426614174000
 * 
 * // Request with username
 * GET /users/john-doe
 * 
 * // Response
 * {
 *   "user": {
 *     "id": "uuid",
 *     "username": "john-doe",
 *     "name": "John Doe",
 *     "email": "john@example.com",
 *     "bio": "User bio",
 *     "gender": "male",
 *     "imageUrl": "https://...",
 *     "credits": 500,
 *     "isNewUser": false,
 *     "lastActive": "2024-01-15T10:30:00.000Z",
 *     "subscription": {
 *       "tier": null,
 *     },
 *     "stats": {
 *       "readsCount": 150,
 *       "likedBooksCount": 25,
 *       "savedBooksCount": 8,
 *       "likesReceived": 500,
 *       "accountDaysOld": 380,
 *       "emailVerified": null,
 *       "havePurchased": false,
 *       "booksGenerated": 10,
 *       "booksCompleted": 5,
 *       "pagesRead": 350,
 *       "pagesGenerated": 80,
 *       "branchesOpened": 15,
 *       "topupCredits": 200,
 *       "referredUsers": 3,
 *       "followersCount": 100,
 *       "activeCheckinStreak": 3,
 *       "maxCheckinStreak": 10,
 *       "customActionsWritten": 1
 *     },
 *     "createdAt": "2024-01-01T00:00:00Z",
 *     "updatedAt": "2024-01-15T10:30:00Z"
 *   }
 * }
 */
router.get("/users/:identifier", optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const viewerId = c.get("userId") || null;
    const { identifier } = c.req.param();

    // Ensure identifier is a string (Hono params can be string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;
    console.log(`[GET /users/${identifierStr}] 👤 Fetching user profile (identifier: ${identifierStr})`);

    // Determine if identifier is UUID or username
    const isUuid = isValidUuid(identifierStr);

    // Build query based on identifier type
    const whereCondition = isUuid
      ? eq(users.userId, identifierStr)
      : eq(users.username, identifierStr);

    const cacheKey = CACHE_KEYS.USER_PROFILE(isUuid ? identifierStr : `username:${identifierStr}`);

    // Fetch function for cache
    const fetchUserProfile = async () => {
      const [userData] = await getEnrichedUser(whereCondition);

      // TODO: is there any better approach rather than using string matching in catch?
      if (!userData) throw new Error("User profile not found");

      // Format response to match frontend expectations.
      // Intentionally omit hasReferrer — private to own profile (GET /user).
      const formattedUser: User = {
        id: userData.id,
        username: userData.username,
        name: userData.name,
        bio: userData.bio,
        gender: userData.gender,
        source: userData.source,
        lastActive: userData.lastActive,
        isNewUser: userData.isNewUser,
        imageUrl: userData.imageUrl,
        credits: userData.credits,
        termsAcceptedAt: userData.termsAcceptedAt,
        termsVersion: userData.termsVersion,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,

        subscription: {
          tier: userData.tier,
        },

        stats: {
          readsCount: userData.readsCount,
          likedBooksCount: userData.likedBooksCount,
          savedBooksCount: userData.savedBooksCount,
          likesReceived: userData.likesReceived,
          accountDaysOld: userData.accountDaysOld,
          emailVerified: userData.emailVerified,
          havePurchased: userData.havePurchased,
          booksGenerated: userData.booksGenerated,
          booksCompleted: userData.booksCompleted,
          pagesRead: userData.pagesRead,
          pagesGenerated: userData.pagesGenerated,
          branchesOpened: userData.branchesOpened,
          topupCredits: userData.topupCredits,
          referredUsers: userData.referredUsers,
          followersCount: userData.followersCount,
          followingCount: userData.followingCount,
          commentsCount: userData.commentsCount,
          activeCheckinStreak: userData.activeCheckinStreak,
          maxCheckinStreak: userData.maxCheckinStreak,
          customActionsWritten: userData.customActionsWritten,
        } satisfies UserStats,
      };

      // Check if the viewer follows this user
      let isFollowing = false;
      let isBlocked = false;
      if (viewerId && viewerId !== formattedUser.id) {
        const [followRow] = await dbRead
          .select({ id: userFollows.followerId })
          .from(userFollows)
          .where(and(
            eq(userFollows.followerId, viewerId),
            eq(userFollows.followingId, formattedUser.id)
          ))
          .limit(1);
        isFollowing = !!followRow;

        const [blockRow] = await dbRead
          .select({ id: userBlocks.userId })
          .from(userBlocks)
          .where(and(
            eq(userBlocks.userId, viewerId),
            eq(userBlocks.blockedUserId, formattedUser.id)
          ))
          .limit(1);
        isBlocked = !!blockRow;
      }
      formattedUser.isFollowing = isFollowing;
      formattedUser.isBlocked = isBlocked;
      formattedUser.isBanned = userData.isBanned;
      formattedUser.isBetaTester = userData.isBetaTester;

      console.log(`[GET /users/${identifierStr}] ✅ Fetched user profile from DB:`, formattedUser);
      return {
        user: formattedUser,
      };
    };

    // Use cache with fallback to database
    const result = await withCache(cacheKey, fetchUserProfile, CACHE_TTL.USER_PROFILE);

    // Streak fields are date-sensitive, so they must never be served from the
    // profile cache. Recompute them live and overlay onto a fresh object (never
    // mutate the cached entry, which may be reused by other viewers).
    const liveStreaks = await getCheckInStreaks(result.user.id);
    const liveUser = {
      ...result.user,
      stats: {
        ...result.user.stats,
        activeCheckinStreak: liveStreaks.activeStreak,
        maxCheckinStreak: liveStreaks.longestStreak,
      },
    };

    // Add HTTP cache headers for CDN/edge caching
    c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');

    return c.json({ user: liveUser });
  } catch (error) {
    if (getErrorMessage(error) === "User profile not found") {
      return cNotFoundError(c, "User profile not found");
    }
    return cApiError(c, "Failed to retrieve user profile", error);
  }
});

/**
 * DELETE /user
 * 
 * Deletes the authenticated user's profile and all associated data from the system.
 * This operation is irreversible and will remove all user data including:
 * - Profile information and image
 * - User preferences and settings
 * - Favorites, likes, and comments
 * - Reading sessions and history
 * - Device registrations
 * 
 * The deletion uses database cascade deletes to automatically remove all related data:
 * - userAuth, userPageProgress
 * - userFollows, userCompletedBooks, userActivityLogs, transactions
 * - userNotifications, userCheckins, userLikes, userFavorites, userComments, userSessions
 * 
 * Books created by the user are preserved (userId set to null) to maintain content availability.
 * 
 * @route DELETE /user
 * @description Delete user profile and all associated data
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Deletion response
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /user
 * 
 * // Response
 * {
 *   "message": "User account deleted successfully"
 * }
 */
router.delete("/", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;

    // ── Account-deletion re-authentication gate ───────────────────────────
    // Per Q1 of GDPR_FEATURES_BUG_REPORT.md, deletion is an irreversible,
    // high-value action and must NOT be a one-click operation on an open
    // session (anyone with a live session could otherwise destroy the account,
    // including credits/purchases/VIP). We require proof of ownership:
    //  - credentials-linked users → the current password (bcrypt-verified)
    //  - Google-only users        → a fresh Google ID token whose `sub` matches
    //    the linked provider account id (a genuine Google re-auth)
    // The client-side typed "DELETE" phrase is UX-only (guards against
    // accidental clicks) and is deliberately NOT validated here — a literal
    // string cannot act as a security proof.
    const { currentPassword, idToken } = c.get("body") as {
      currentPassword?: string;
      idToken?: string;
    };

    const [authUser] = await dbRead
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    const providers = await dbRead
      .select({
        provider: userProviders.provider,
        providerAccountId: userProviders.providerAccountId,
      })
      .from(userProviders)
      .where(eq(userProviders.userId, userId));

    const hasCredentials = !!authUser?.passwordHash;
    const googleProvider = providers.find((p) => p.provider === 'google');

    if (hasCredentials) {
      // Credentials-linked: password is the proof of ownership.
      if (!currentPassword) {
        return cUnauthorizedError(c, 'Current password is required to delete your account');
      }
      const isValid = await verifyPassword(currentPassword, authUser!.passwordHash!);
      if (!isValid) {
        return cUnauthorizedError(c, 'Current password is incorrect');
      }
    } else if (googleProvider?.providerAccountId) {
      // Google-only: re-verify a fresh Google ID token and require its `sub`
      // to match the provider account this user is actually linked to.
      if (!idToken) {
        return cUnauthorizedError(c, 'Google re-authentication is required to delete your account');
      }
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || payload.sub !== googleProvider.providerAccountId) {
          return cUnauthorizedError(c, 'Google re-authentication failed');
        }
      } catch {
        return cUnauthorizedError(c, 'Google re-authentication failed');
      }
    } else {
      // No known provider record — cannot prove ownership, refuse to delete.
      return cUnauthorizedError(c, 'Unable to verify account ownership');
    }

    // Capture contact + locale before cascade delete for confirmation email
    const { resolveEmailLocale } = await import('../services/email-preferences.js');
    const deleteLocale = await resolveEmailLocale(userId);
    const [userRow] = await dbRead
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    // Delete user - cascade delete will handle all related tables automatically
    // Tables with cascade delete on userId:
    // - userAuth, userPageProgress
    // - userFollows, userCompletedBooks, userActivityLogs, transactions
    // - userNotifications, userCheckins, userLikes, userFavorites, userComments, userSessions
    await dbWrite.delete(users).where(eq(users.userId, userId));

    if (userRow?.email) {
      const { sendAccountDeletedEmail, sendEmailSafe } = await import('../utils/email.js');
      sendEmailSafe('DELETE /user', () =>
        sendAccountDeletedEmail(userRow.email, userRow.name || 'there', { locale: deleteLocale }),
      );
    }

    // Invalidate all relevant user cache entries
    await Promise.all([
      invalidateCachePattern(`user:${userId}%`),
      invalidateUserProfileCache(userId),
    ]);

    return c.json({
      message: "User account deleted successfully",
      // imageQueuedForDeletion: !!imageToDelete.imageId,
    });

  } catch (error) {
    return cApiError(c, "Failed to delete user account", error);
  }
});

// ===== USER LIKES ROUTES =====

/**
 * POST /user/likes
 * 
 * Like a book, comment, or another user.
 * Uses upsert (onConflictDoNothing) to handle idempotent likes.
 * 
 * @route POST /user/likes
 * @description Like a target item
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Like data
 * @body {string} targetType - Type of target ("book" | "comment" | "user")
 * @body {string} targetId - ID of the target to like
 * 
 * @returns {Object} Like creation response
 * @returns {Object} like - Created or existing like record
 * 
 * @example
 * // Request
 * POST /user/likes
 * Body: {
 *   "targetType": "book",
 *   "targetId": "book456"
 * }
 * 
 * // Response
 * {
 *   "like": {
 *     "userId": "user123",
 *     "targetType": "book",
 *     "targetId": "book456",
 *     "createdAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/likes", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const body = c.get("body");
    const { targetType, targetId } = body;

    // Validate target type
    if (!["book", "comment", "user"].includes(targetType)) {
      return c.json({
        success: false,
        error: "Invalid target type. Must be 'book', 'comment', or 'user'",
      }, 400);
    }

    if (!targetId) {
      return c.json({
        success: false,
        error: "Target ID is required",
      }, 400);
    }

    // Prepare like data for upsert
    const likeData: DBNewUserLike = {
      userId,
      targetType,
      targetId,
    };

    // Perform upsert operation (create or return existing)
    const [row] = await dbWrite
      .insert(userLikes)
      .values(likeData)
      .onConflictDoNothing()
      .returning();

    // If row is null, like already existed - fetch it
    const [like] = row ? [row] : await dbRead
      .select()
      .from(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, targetType),
        eq(userLikes.targetId, targetId)
      ))
      .limit(1);

    c.status(201);
    const response = c.json({
      like,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'liked',
      targetType,
      targetId,
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    // Invalidate caches when liking a book (only if publicly visible)
    if (targetType === 'book') {
      const [likedBook] = await dbRead
        .select({ status: books.status, visibility: books.visibility })
        .from(books)
        .where(eq(books.id, targetId))
        .limit(1);
      if (likedBook) {
        await invalidateExploreCache({ book: likedBook });
      }
      await invalidateUserBooksCache(userId); // isLiked flag changed
      await invalidateUserProfileCache(userId); // likedBooksCount changed
    }

    return response;
  } catch (error) {
    return cApiError(c, "Failed to create like", error);
  }
});

/**
 * DELETE /user/likes
 * 
 * Unlike a book, comment, or another user.
 * 
 * @route DELETE /user/likes
 * @description Unlike a target item
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} targetType - Type of target ("book" | "comment" | "user")
 * @query {string} targetId - ID of the target to unlike
 * 
 * @returns {Object} Unlike response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /user/likes?targetType=book&targetId=book456
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Like removed successfully"
 * }
 */
router.delete("/likes", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { targetType, targetId } = c.req.query();

    // Validate target type
    if (!targetType || !["book", "comment", "user"].includes(targetType as string)) {
      return c.json({
        success: false,
        error: "Valid target type is required. Must be 'book', 'comment', or 'user'",
      }, 400);
    }

    if (!targetId) {
      return c.json({
        success: false,
        error: "Target ID is required",
      }, 400);
    }

    // Delete the like
    const result = await dbWrite
      .delete(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, targetType as LikeTargetType),
        eq(userLikes.targetId, targetId as string)
      ))
      .returning();

    if (result.length === 0) {
      return cNotFoundError(c, "Like not found");
    }

    const response = c.json({
      message: "Like removed successfully",
    });

    // Invalidate caches when unliking a book (only if publicly visible)
    if (targetType === 'book') {
      const [unlikedBook] = await dbRead
        .select({ status: books.status, visibility: books.visibility })
        .from(books)
        .where(eq(books.id, targetId as string))
        .limit(1);
      if (unlikedBook) {
        await invalidateExploreCache({ book: unlikedBook });
      }
      await invalidateUserBooksCache(userId); // isLiked flag changed
      await invalidateUserProfileCache(userId); // likedBooksCount changed
    }

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to remove like", error);
  }
});

/**
 * GET /user/likes
 * 
 * Get all likes for the authenticated user, optionally filtered by target type.
 * 
 * @route GET /user/likes
 * @description Get user likes
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} [targetType] - Filter by target type ("book" | "comment" | "user")
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Likes response
 * @returns {Array} likes - Array of like records
 * 
 * @example
 * // Request
 * GET /user/likes?targetType=book&limit=10
 * 
 * // Response
 * {
 *   "likes": [
 *     {
 *       "userId": "user123",
 *       "targetType": "book",
 *       "targetId": "book456",
 *       "createdAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/likes", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { targetType, limit = "50", offset = "0" } = c.req.query();

    // Build base query conditions
    const baseConditions = [eq(userLikes.userId, userId)];

    // Add target type filter if provided
    if (targetType && ["book", "comment", "user"].includes(targetType as string)) {
      baseConditions.push(eq(userLikes.targetType, targetType as LikeTargetType));
    }

    const likes = await dbRead
      .select()
      .from(userLikes)
      .where(and(...baseConditions))
      .orderBy(desc(userLikes.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    const response = c.json({
      likes,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to retrieve likes", error);
  }
});

// ===== USER FAVORITES ROUTES =====

/**
 * POST /user/favorites
 * 
 * Add a book to user favorites (to read later).
 * Uses upsert (onConflictDoNothing) to handle idempotent favorites.
 * 
 * @route POST /user/favorites
 * @description Add book to favorites
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Favorite data
 * @body {string} bookId - ID of the book to favorite
 * 
 * @returns {Object} Favorite creation response
 * @returns {Object} favorite - Created or existing favorite record
 * 
 * @example
 * // Request
 * POST /user/favorites
 * Body: {
 *   "bookId": "book456"
 * }
 * 
 * // Response
 * {
 *   "favorite": {
 *     "userId": "user123",
 *     "bookId": "book456",
 *     "createdAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/favorites", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { bookId } = c.get("body");

    if (!bookId) {
      return c.json({
        success: false,
        error: "Book ID is required",
      }, 400);
    }

    // Prepare favorite data for upsert
    const favoriteData: DBNewUserFavorite = {
      userId,
      bookId,
    };

    // Perform upsert operation (create or return existing)
    const [row] = await dbWrite
      .insert(userFavorites)
      .values(favoriteData)
      .onConflictDoNothing()
      .returning();

    // If row is null, the favorite already existed - fetch it
    const [favorite] = row ? [row] : await dbRead
      .select()
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, bookId)
      ))
      .limit(1);

    c.status(201);
    const response = c.json({
      favorite,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'favorited',
      targetType: 'book',
      targetId: bookId,
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    // Invalidate user profile cache (savedBooksCount changed)
    await invalidateUserProfileCache(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to add book to favorites", error);
  }
});

/**
 * DELETE /user/favorites
 * 
 * Remove a book from user favorites.
 * 
 * @route DELETE /user/favorites
 * @description Remove book from favorites
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} bookId - ID of the book to remove from favorites
 * 
 * @returns {Object} Remove favorite response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /user/favorites?bookId=book456
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Book removed from favorites successfully"
 * }
 */
router.delete("/favorites", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { bookId } = c.req.query();

    if (!bookId) {
      return c.json({
        success: false,
        error: "Book ID is required",
      }, 400);
    }

    // Delete the favorite
    const result = await dbWrite
      .delete(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, bookId as string)
      ))
      .returning();

    if (result.length === 0) {
      return cNotFoundError(c, "Favorite not found");
    }

    const response = c.json({
      message: "Book removed from favorites successfully",
    });

    // Invalidate user profile cache (savedBooksCount changed)
    await invalidateUserProfileCache(userId);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to remove book from favorites", error);
  }
});

/**
 * GET /user/collections
 * 
 * Get all collections for the authenticated user's favorite books.
 * Returns an array of objects with the collection name and total book count.
 * 
 * @route GET /user/collections
 * @description Get user collections with book counts
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Collections response
 * @returns {Array} collections - Array of collection objects
 * @returns {string} collections[].name - Collection name
 * @returns {number} collections[].totalBooks - Number of books in the collection
 * 
 * @example
 * // Request
 * GET /user/collections
 * 
 * // Response
 * {
 *   "collections": [
 *     { "name": "Thriller", "totalBooks": 5 },
 *     { "name": "Mystery", "totalBooks": 3 },
 *     { "name": "To Read Later", "totalBooks": 12 },
 *     { "name": "Favorites", "totalBooks": 8 }
 *   ]
 * }
 */
router.get("/collections", optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId");

    // Return empty response for unauthenticated users (handles auth timing race conditions)
    if (!userId) return c.json({ collections: [] });

    // Get collections with book counts grouped by collection name
    const collections = await dbRead
      .select({
        name: userFavorites.collection,
        totalBooks: sql<number>`COUNT(*)::int`,
      })
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        sql`${userFavorites.collection} IS NOT NULL`
      ))
      .groupBy(userFavorites.collection)
      .orderBy(userFavorites.collection);

    const response = c.json({ collections });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to retrieve collections", error);
  }
});

// ===== USER FOLLOWS ROUTES =====

/**
 * POST /users/:id/follow
 * 
 * Follow a user. Uses upsert (onConflictDoNothing) to handle idempotent follows.
 * 
 * @route POST /users/:id/follow
 * @description Follow a user
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} id - ID of the user to follow
 * 
 * @returns {Object} Follow creation response
 * @returns {Object} follow - Created or existing follow record
 * 
 * @example
 * // Request
 * POST /users/user456/follow
 * 
 * // Response
 * {
 *   "follow": {
 *     "followerId": "user123",
 *     "followingId": "user456",
 *     "createdAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/users/:id/follow", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { id: followingId } = c.req.param();

    // Ensure followingId is a string (Hono params can be string[])
    const followingIdStr = Array.isArray(followingId) ? followingId[0] : followingId;

    if (userId === followingIdStr) {
      return cValidationError(c, "You cannot follow yourself");
    }

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, followingIdStr))
      .limit(1);

    if (targetUser.length === 0) {
      return cNotFoundError(c, "User not found");
    }

    // Perform upsert operation (create or return existing)
    const [row] = await dbWrite
      .insert(userFollows)
      .values({
        followerId: userId,
        followingId: followingIdStr,
      })
      .onConflictDoNothing()
      .returning();

    // If row is null, follow already existed - fetch it
    const [follow] = row ? [row] : await dbRead
      .select()
      .from(userFollows)
      .where(and(
        eq(userFollows.followerId, userId),
        eq(userFollows.followingId, followingIdStr)
      ))
      .limit(1);

    c.status(201);
    const response = c.json({
      follow,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'followed',
      targetType: 'user',
      targetId: followingIdStr,
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    // Invalidate user profile cache (followersCount changed)
    await invalidateUserProfileCache(followingIdStr);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to follow user", error);
  }
});

/**
 * DELETE /users/:id/follow
 * 
 * Unfollow a user.
 * 
 * @route DELETE /users/:id/follow
 * @description Unfollow a user
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} id - ID of the user to unfollow
 * 
 * @returns {Object} Unfollow response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /users/user456/follow
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "User unfollowed successfully"
 * }
 */
router.delete("/users/:id/follow", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { id: followingId } = c.req.param();

    // Ensure followingId is a string (Hono params can be string[])
    const followingIdStr = Array.isArray(followingId) ? followingId[0] : followingId;

    // Delete the follow
    const result = await dbWrite
      .delete(userFollows)
      .where(and(
        eq(userFollows.followerId, userId),
        eq(userFollows.followingId, followingIdStr)
      ))
      .returning();

    if (result.length === 0) {
      return cNotFoundError(c, "Follow relationship not found");
    }

    const response = c.json({
      message: "User unfollowed successfully",
    });

    // Invalidate user profile cache (followersCount changed)
    await invalidateUserProfileCache(followingIdStr);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to unfollow user", error);
  }
});

/**
 * GET /users/:id/followers
 * 
 * Get all followers of a specific user.
 * 
 * @route GET /users/:id/followers
 * @description Get user's followers
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} id - ID of the user
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Followers response
 * @returns {Array} followers - Array of follower user profiles
 * @returns {Object} pagination - Pagination metadata
 * 
 * @example
 * // Request
 * GET /users/user456/followers?limit=10
 * 
 * // Response
 * {
 *   "followers": [
 *     {
 *       "userId": "user123",
 *       "name": "John Doe",
 *       "username": "john-doe",
 *       "imageUrl": "https://example.com/avatar.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "totalCount": 100,
 *     "totalPages": 10,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/users/:id/followers", async (c: Context<AppEnv>) => {
  try {
    const { id } = c.req.param();
    const { limit = "50", offset = "0" } = c.req.query();

    // Ensure id is a string
    const idStr = Array.isArray(id) ? id[0] : id;

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, idStr))
      .limit(1);

    if (targetUser.length === 0) {
      return cNotFoundError(c, "User not found");
    }

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followingId, idStr));
    const totalCount = countResult[0].count;

    // Get followers with user info
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const followers = await dbRead
      .select({
        userId: users.userId,
        name: users.name,
        username: users.username,
        imageUrl: users.imageUrl,
        followedAt: userFollows.createdAt
      })
      .from(userFollows)
      .leftJoin(users, eq(userFollows.followerId, users.userId))
      .where(eq(userFollows.followingId, idStr))
      .orderBy(desc(userFollows.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    return c.json({
      followers,
      pagination
    });
  } catch (error) {
    return cApiError(c, "Failed to retrieve followers", error);
  }
});

/**
 * GET /users/:id/following
 * 
 * Get all users that a specific user is following.
 * 
 * @route GET /users/:id/following
 * @description Get who the user is following
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} id - ID of the user
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Following response
 * @returns {Array} following - Array of user profiles being followed
 * @returns {Object} pagination - Pagination metadata
 * 
 * @example
 * // Request
 * GET /users/user456/following?limit=10
 * 
 * // Response
 * {
 *   "following": [
 *     {
 *       "userId": "user789",
 *       "name": "Jane Smith",
 *       "username": "jane-smith",
 *       "imageUrl": "https://example.com/avatar2.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "totalCount": 50,
 *     "totalPages": 5,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/users/:id/following", async (c: Context<AppEnv>) => {
  try {
    const { id } = c.req.param();
    const { limit = "50", offset = "0" } = c.req.query();

    // Ensure id is a string
    const idStr = Array.isArray(id) ? id[0] : id;

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, idStr))
      .limit(1);

    if (targetUser.length === 0) {
      return cNotFoundError(c, "User not found");
    }

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followerId, idStr));
    const totalCount = countResult[0].count;

    // Get following with user info
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const following = await dbRead
      .select({
        userId: users.userId,
        name: users.name,
        username: users.username,
        imageUrl: users.imageUrl,
        followedAt: userFollows.createdAt
      })
      .from(userFollows)
      .leftJoin(users, eq(userFollows.followingId, users.userId))
      .where(eq(userFollows.followerId, idStr))
      .orderBy(desc(userFollows.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    return c.json({
      following,
      pagination
    });
  } catch (error) {
    return cApiError(c, "Failed to retrieve following", error);
  }
});

/**
 * GET /user/followers
 * 
 * Get all followers of the authenticated user.
 * 
 * @route GET /user/followers
 * @description Get authenticated user's followers
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Followers response
 * @returns {Array} followers - Array of follower user profiles
 * @returns {Object} pagination - Pagination metadata
 * 
 * @example
 * // Request
 * GET /user/followers?limit=10
 * 
 * // Response
 * {
 *   "followers": [
 *     {
 *       "userId": "user123",
 *       "name": "John Doe",
 *       "username": "john-doe",
 *       "imageUrl": "https://example.com/avatar.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "totalCount": 100,
 *     "totalPages": 10,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/followers", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { limit = "50", offset = "0" } = c.req.query();

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followingId, userId));
    const totalCount = countResult[0].count;

    // Get followers with user info
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const followers = await dbRead
      .select({
        userId: users.userId,
        name: users.name,
        username: users.username,
        imageUrl: users.imageUrl,
        followedAt: userFollows.createdAt
      })
      .from(userFollows)
      .leftJoin(users, eq(userFollows.followerId, users.userId))
      .where(eq(userFollows.followingId, userId))
      .orderBy(desc(userFollows.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    const response = c.json({
      followers,
      pagination
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to retrieve followers", error);
  }
});

/**
 * GET /user/following
 * 
 * Get all users that the authenticated user is following.
 * 
 * @route GET /user/following
 * @description Get who authenticated user is following
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Following response
 * @returns {Array} following - Array of user profiles being followed
 * @returns {Object} pagination - Pagination metadata
 * 
 * @example
 * // Request
 * GET /user/following?limit=10
 * 
 * // Response
 * {
 *   "following": [
 *     {
 *       "userId": "user789",
 *       "name": "Jane Smith",
 *       "username": "jane-smith",
 *       "imageUrl": "https://example.com/avatar2.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "totalCount": 50,
 *     "totalPages": 5,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/following", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { limit = "50", offset = "0" } = c.req.query();

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId));
    const totalCount = countResult[0].count;

    // Get following with user info
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const following = await dbRead
      .select({
        userId: users.userId,
        name: users.name,
        username: users.username,
        imageUrl: users.imageUrl,
        followedAt: userFollows.createdAt
      })
      .from(userFollows)
      .leftJoin(users, eq(userFollows.followingId, users.userId))
      .where(eq(userFollows.followerId, userId))
      .orderBy(desc(userFollows.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    const response = c.json({
      following,
      pagination
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to retrieve following", error);
  }
});

// ===== DAILY CHECK-IN ROUTES =====

/**
 * GET /user/checkin/status
 * 
 * Checks if the authenticated user can perform daily check-in today.
 * Returns check-in status, current streak, totals, and recent history.
 * 
 * @route GET /user/checkin/status
 * @description Get daily check-in status with streak info
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Check-in status response
 * @returns {boolean} canCheckIn - Whether user can check-in today
 * @returns {string|null} lastCheckInDate - Last check-in date (YYYY-MM-DD) or null
 * @returns {number} totalCheckIns - Total number of check-ins
 * @returns {number} totalCreditsClaimed - Total credits claimed from check-ins
 * @returns {number} currentStreak - Current consecutive check-in streak
 * @returns {number} longestStreak - Longest check-in streak
 * @returns {number} todayCycleDay - 0-based grid slot index for today's cycle position (0-6)
 * @returns {Array} recentCheckIns - Recent check-in history (last 30 days)
 * @returns {boolean} isVip - Whether user has VIP tier
 * @returns {number} regularClaimAmount - Regular daily claim amount
 * @returns {number} vipClaimAmount - VIP daily claim amount
 * @returns {string[]} claimedRewards - Array of claimed reward types today
 * 
 * @example
 * // Request
 * GET /user/checkin/status
 * 
 * // Response (authenticated — can check-in)
 * {
 *   "canCheckIn": true,
 *   "lastCheckInDate": "2026-05-03",
 *   "totalCheckIns": 12,
 *   "totalCreditsClaimed": 360,
 *   "currentStreak": 5,
 *   "longestStreak": 12,
 *   "todayCycleDay": 4,
 *   "recentCheckIns": [
 *     {
 *       "checkInDate": "2026-05-03",
 *       "creditsClaimed": 30,
 *       "createdAt": "2026-05-03T00:00:00.000Z"
 *     }
 *   ],
 *   "isVip": false,
 *   "regularClaimAmount": 30,
 *   "vipClaimAmount": 60,
 *   "claimedRewards": []
 * }
 * 
 * // Response (unauthenticated)
 * {
 *   "eligible": false,
 *   "lastCheckIn": null,
 *   "streak": 0,
 *   "totalCheckIns": 0,
 *   "creditsClaimed": 0,
 *   "recentCheckIns": []
 * }
 */
router.get("/checkin/status", optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId");

    // Return null response for unauthenticated users (handles auth timing race conditions)
    if (!userId) {
      console.log(`[GET /user/checkin/status] 👀 No userId, returning null check-in status`);
      return c.json({
        eligible: false,
        lastCheckIn: null,
        streak: 0,
        totalCheckIns: 0,
        creditsClaimed: 0,
        recentCheckIns: [],
      });
    }

    const status = await getCheckInStatus(userId);
    const response = c.json(status);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to get check-in status", error);
  }
});

/**
 * POST /user/checkin
 * 
 * Performs daily check-in and awards free credits to the authenticated user.
 * Each check-in awards free credits (configurable via DAILY_CHECKIN_CREDITS, default 30).
 * Users can only check-in once per UTC day.
 * 
 * @route POST /user/checkin
 * @description Perform daily check-in and claim free credits
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Check-in response
 * @returns {boolean} success - Whether check-in was successful
 * @returns {number} creditsAwarded - Number of credits awarded (30 or 0 if already checked in)
 * @returns {string} checkInDate - Check-in date in YYYY-MM-DD format
 * @returns {string} message - Status message
 * 
 * @example
 * // Request
 * POST /user/checkin
 * 
 * // Response (successful check-in)
 * {
 *   "success": true,
 *   "creditsAwarded": 30,
 *   "checkInDate": "2026-05-04",
 *   "message": "Successfully claimed 30 daily credits"
 * }
 * 
 * // Response (already checked in)
 * {
 *   "success": false,
 *   "creditsAwarded": 0,
 *   "checkInDate": "2026-05-04",
 *   "message": "Already checked in today"
 * }
 */
router.post("/checkin", requireAuth, (c) => handleCheckIn(c));

/**
 * POST /user/checkin/double
 * 
 * VIP-only double claim that awards 2x the daily check-in credits.
 * Can be claimed in addition to the regular check-in on the same day.
 * Requires VIP subscription tier; returns 403 if the user is not VIP.
 * 
 * @route POST /user/checkin/double
 * @description VIP double claim — 2x daily check-in credits
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Check-in response
 * @returns {boolean} success - Whether the double claim was successful
 * @returns {number} creditsAwarded - Number of bonus credits awarded
 * @returns {string} checkInDate - Check-in date in YYYY-MM-DD format
 * @returns {string} message - Status message
 * 
 * @example
 * // Request
 * POST /user/checkin/double
 * 
 * // Response (successful VIP double claim)
 * {
 *   "success": true,
 *   "creditsAwarded": 30,
 *   "checkInDate": "2026-05-04",
 *   "message": "Successfully claimed 30 VIP 2x daily credits"
 * }
 * 
 * // Response (not a VIP user)
 * {
 *   "success": false,
 *   "creditsAwarded": 0,
 *   "currentStreak": 0,
 *   "totalCreditsClaimed": 0,
 *   "checkInDate": "2026-05-04",
 *   "message": "VIP 2x claim is only available to VIP subscribers"
 * }
 */
router.post("/checkin/double", requireAuth, (c) => handleCheckIn(c, 'vip_2x'));

// ===== BETA TESTER PROGRAM =====

/**
 * POST /user/beta-tester
 *
 * Joins the authenticated user to the beta tester program and awards a one-time
 * credit bonus ({@link BETA_TESTER_REWARD_CREDITS} = 500).
 *
 * The join and the reward are atomic (single transaction): the flag claim is an
 * `UPDATE ... WHERE is_beta_tester = false`, so a user can only join — and be
 * rewarded — exactly once, even under concurrent requests. A second attempt
 * returns HTTP 409 with `creditsAwarded: 0`.
 *
 * @route POST /user/beta-tester
 * @description Join the beta tester program and claim the one-time reward
 * @auth Required
 *
 * @returns {Object} Beta tester join response
 * @returns {boolean} success - Whether the join was newly processed
 * @returns {string} message - Status message
 * @returns {boolean} isBetaTester - Always true after this call
 * @returns {number} creditsAwarded - Credits added (500 on first join, 0 if already joined)
 * @returns {number} credits - New credit balance
 *
 * @example
 * // Request
 * POST /user/beta-tester
 *
 * // Response (201 Created — first join)
 * {
 *   "success": true,
 *   "message": "Welcome to the beta tester program! 500 credits added",
 *   "isBetaTester": true,
 *   "creditsAwarded": 500,
 *   "credits": 550
 * }
 *
 * // Response (409 Conflict — already joined)
 * {
 *   "success": false,
 *   "message": "You are already a beta tester",
 *   "isBetaTester": true,
 *   "creditsAwarded": 0,
 *   "credits": 550
 * }
 */
router.post("/beta-tester", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const result = await joinBetaTesterProgram(userId);

    await Promise.all([
      invalidateUserProfileCache(userId),
      updateUserLastActivity(userId),
    ]);

    if (result.status === 'already_joined') {
      return c.json({
        success: false,
        message: 'You are already a beta tester',
        isBetaTester: result.isBetaTester,
        creditsAwarded: result.creditsAwarded,
        credits: result.newBalance,
      }, 409);
    }

    await logUserActivity(
      {
        userId,
        activityType: 'beta_tester_joined',
        targetType: 'user',
        targetId: userId,
        metadata: { creditsAwarded: result.creditsAwarded },
      },
      { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } },
    );

    return c.json({
      success: true,
      message: `Welcome to the beta tester program! ${result.creditsAwarded} credits added`,
      isBetaTester: result.isBetaTester,
      creditsAwarded: result.creditsAwarded,
      credits: result.newBalance,
    }, 201);
  } catch (error) {
    console.error('[POST /user/beta-tester] ❌', error);
    return cApiError(c, 'Failed to join beta tester program', error);
  }
});

/**
 * GET /user/activity-logs
 * 
 * Get activity logs for the authenticated user with optional filtering and pagination.
 * Each log is enriched with a human-readable `title` and `detail` based on its target.
 * 
 * @route GET /user/activity-logs
 * @description Get user activity logs with pagination
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} [activityType] - Filter by activity type (e.g., "book_created", "liked", "commented")
 * @query {string} [targetType] - Filter by target type (e.g., "book", "comment", "user")
 * @query {number} [page] - Page number (1-based, default: 1)
 * @query {number} [limit] - Items per page (default: 50, max: 100)
 * 
 * @returns {Object} Activity logs response
 * @returns {Array} logs - Array of enriched activity log records with title and detail
 * @returns {Object} pagination - Pagination metadata
 * @returns {number} pagination.page - Current page
 * @returns {number} pagination.limit - Items per page
 * @returns {number} pagination.totalCount - Total matching records
 * @returns {number} pagination.totalPages - Total pages
 * @returns {boolean} pagination.hasNext - Whether there is a next page
 * @returns {boolean} pagination.hasPrevious - Whether there is a previous page
 * 
 * @example
 * // Request
 * GET /user/activity-logs?activityType=liked&page=1&limit=10
 * 
 * // Response
 * {
 *   "logs": [
 *     {
 *       "id": "log123",
 *       "userId": "user123",
 *       "activityType": "liked",
 *       "targetType": "book",
 *       "targetId": "book456",
 *       "metadata": null,
 *       "ipAddress": "192.168.1.1",
 *       "userAgent": "Mozilla/5.0...",
 *       "platform": "android",
 *       "appVersion": "1.0.0",
 *       "createdAt": "2023-01-01T00:00:00.000Z",
 *       "title": "The Haunting",
 *       "detail": "A mysterious ghost haunts an old mansion..."
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "totalCount": 42,
 *     "totalPages": 5,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/activity-logs", optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({
        logs: [],
        pagination: {
          page: 1,
          limit: 50,
          totalCount: 0,
          totalPages: 0,
          hasNext: false,
          hasPrevious: false,
        } satisfies PaginationMeta,
      });
    }

    const { activityType, targetType } = c.req.query();
    const page = Math.max(1, parseInt(c.req.query("page") as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") as string) || 50));
    const offset = (page - 1) * limit;

    // Build base query conditions
    const baseConditions = [
      eq(userActivityLogs.userId, userId),
      sql`${userActivityLogs.activityType} NOT IN ('credits_consumed', 'credits_added')`,
    ];

    // Add activity type filter if provided
    if (activityType) {
      baseConditions.push(eq(userActivityLogs.activityType, activityType as UserActivityType));
    }

    // Add target type filter if provided
    if (targetType) {
      baseConditions.push(eq(userActivityLogs.targetType, targetType as string));
    }

    const where = and(...baseConditions);

    // Get total count for pagination
    const [countResult] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userActivityLogs)
      .where(where);

    const totalCount = countResult?.count ?? 0;

    // Fetch page of logs
    const logs = await dbRead
      .select()
      .from(userActivityLogs)
      .where(where)
      .orderBy(desc(userActivityLogs.createdAt))
      .limit(limit)
      .offset(offset);

    const enriched = await enrichActivityLogs(logs);
    const pagination = calculatePaginationMeta(page, limit, totalCount);

    const response = c.json({
      logs: enriched,
      pagination,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);

    return response;
  } catch (error) {
    return cApiError(c, "Failed to retrieve activity logs", error);
  }
});

/**
 * GET /api/user/progress
 *
 * Provides the authenticated user's current reading progress enriched with
 * full branch context. Intended for:
 *
 *  1. Resume reading — the client navigates directly to the current book +
 *     page without needing a separate book/page lookup.
 *  2. Branch history viewer — branchPath exposes the user's chosen story
 *     path from root to the current page, enabling "your journey so far"
 *     and "explore alternative branches" UI.
 * 
 * Returns the authenticated user's current reading progress with full branch
 * context. All top-level fields are nullable — a user with no active session
 * receives the "empty" shape shown below rather than an error.
 *
 * @authentication Optional — returns all-null shape for unauthenticated users
 *
 * ---
 * **Response shape** (`StoryProgressWithBranch`):
 *
 * | Field          | Type                        | Description                                         |
 * |----------------|-----------------------------|-----------------------------------------------------|
 * | `book`         | `EnrichedBookData \| null`  | Full book record for the active session             |
 * | `page`         | `UserStoryPage \| null`     | Current page with text, actions, selectedActions    |
 * | `state`        | `StoryState \| null`        | Accumulated story state (actionsHistory, plotFlags…)|
 * | `session`      | `UserSession \| null`       | Active session linking user → book → page           |
 * | `branchPath`   | `BranchPath \| null`        | Ordered pages from root to current (depth, pages[]) |
 * | `branchStats`  | `BranchStats \| null`       | Depth + branching-factor analytics                  |
 * | `siblings`     | `PersistedStoryPage[]`      | Alternative pages at the same depth (for "explore") |
 *
 * ---
 * @example Response — active session, currently on page 7:
 * ```json
 * {
 *   "book": {
 *     "id": "01j2k3m4n5p6q7r8s9t0",
 *     "title": "The Lost Kingdom",
 *     "language": "en",
 *     "totalPages": 24,
 *     "stats": { "readCount": 312, "likesCount": 87 }
 *   },
 *   "page": {
 *     "id": "01j2k3page7xxxxxxxx",
 *     "page": 7,
 *     "text": "The gate creaks open…",
 *     "actions": [
 *       { "text": "Step inside.", "type": "brave" },
 *       { "text": "Turn back.",   "type": "cautious" }
 *     ],
 *     "selectedActions": [
 *       { "text": "Step inside.", "page": 7, "pageId": "01j2k3page7xxxxxxxx" }
 *     ]
 *   },
 *   "state": {
 *     "actionsHistory": [
 *       { "page": 1, "pageId": "page1id", "text": "Follow the stranger.", "nextPageId": "page2id" },
 *       { "page": 2, "pageId": "page2id", "text": "Agree to help.",       "nextPageId": "page3id" },
 *       { "page": 6, "pageId": "page6id", "text": "Take the key.",        "nextPageId": "page7id" }
 *     ],
 *     "plotFlags": [
 *       { "page": 2, "fact": "MC accepted the quest.",     "type": "commitment",  "isMajorEvent": true  },
 *       { "page": 5, "fact": "The key belongs to a vault.", "type": "discovery",  "isMajorEvent": false }
 *     ],
 *     "contextHistory": "The MC followed a stranger into the old district…"
 *   },
 *   "session": {
 *     "bookId": "01j2k3m4n5p6q7r8s9t0",
 *     "pageId": "01j2k3page7xxxxxxxx",
 *     "previousPageId": "01j2k3page6xxxxxxxx",
 *     "status": "active"
 *   },
 *   "branchPath": {
 *     "depth": 7,
 *     "pages": [
 *       { "id": "page1id", "page": 1, "branchId": "main" },
 *       { "id": "page2id", "page": 2, "branchId": "main" },
 *       { "id": "page7id", "page": 7, "branchId": "branch-a3f" }
 *     ]
 *   },
 *   "branchStats": {
 *     "totalBranches": 3,
 *     "branchingFactor": 1.4
 *   },
 *   "siblings": [
 *     { "id": "page7alt1", "page": 7, "branchId": "branch-b9c", "text": "She ran instead…" }
 *   ]
 * }
 * ```
 *
 * @example
 * ```typescript
 * const { book, page, session, branchPath, siblings } =
 *   await fetch('/api/story/progress', {
 *     headers: { Authorization: `Bearer ${token}` }
 *   }).then(r => r.json());
 *
 * // Resume reading
 * if (session && book && page) {
 *   router.push(`/books/${book.slug}/${page.id}`);
 * }
 *
 * // Show branch history
 * const pathPageIds = branchPath?.pages.map(p => p.id) ?? [];
 *
 * // Show "other paths you could have taken"
 * const alternateBranches = siblings.filter(s => s.id !== page?.id);
 * ```
 */
router.get("/progress", optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId");
    const progress = userId ? await getStoryProgressWithBranch(userId) : {
      book: null,
      page: null,
      state: null,
      session: null,
      branchPath: null,
      branchStats: null,
      siblings: []
    };

    return c.json(progress);
  } catch (error) {
    return cApiError(c, "Failed to retrieve story progress", error);
  }
});

/**
 * GET /api/user/achievements
 * Returns all available achievements with user progress, unfiltered.
 */
router.get('/achievements', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const badges = await getUserAchievements(userId);

    return c.json({ success: true, badges });
  } catch (error) {
    return cApiError(c, 'Failed to fetch achievements layout', error);
  }
});

/**
 * GET /api/users/:id/achievements
 * Returns public achievements for a given user (profile view).
 * Unauthenticated — any visitor can see another user's badges.
 */
router.get('/users/:id/achievements', async (c: Context<AppEnv>) => {
  try {
    const { id } = c.req.param();
    const userIdStr = Array.isArray(id) ? id[0] : id;

    const badges = await getUserAchievements(userIdStr);

    return c.json({ success: true, badges });
  } catch (error) {
    return cApiError(c, 'Failed to fetch user achievements', error);
  }
});

/**
 * Shared helper: resolve a user by UUID or username to their userId.
 *
 * Mirrors the `/users/:identifier` profile route's identifier handling so the
 * public testimonial/comments endpoints accept both forms.
 */
async function resolveProfileUserId(c: Context<AppEnv>): Promise<{ userId: string } | null> {
  const { identifier } = c.req.param();
  const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

  const isUuid = isValidUuid(identifierStr);
  const whereCondition = isUuid ? eq(users.userId, identifierStr) : eq(users.username, identifierStr);

  const [row] = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(whereCondition)
    .limit(1);

  if (!row) return null;
  return { userId: row.userId };
}

/**
 * GET /api/users/:identifier/testimonials
 * Public testimonials the author RECEIVED across all their books.
 *
 * - Public viewers see only `approved` testimonials.
 * - The profile owner (authenticated viewer === target user) sees all statuses,
 *   mirroring the book-scoped endpoint's owner privilege.
 * - Includes a ratingSummary (count, avg, 5→1 distribution) computed over the
 *   same visible set.
 */
router.get('/users/:identifier/testimonials', optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const resolved = await resolveProfileUserId(c);
    if (!resolved) return cNotFoundError(c, 'User not found');

    const viewerId = c.get('userId');
    const isOwner = viewerId === resolved.userId;
    const { limit = DEFAULT_ITEMS_PER_PAGE, page = 1 } = extractPaginationParams(c.req.query());
    const offset = (page - 1) * limit;

    const conditions = [
      eq(books.userId, resolved.userId),
      eq(bookTestimonials.bookId, books.id),
    ];
    if (!isOwner) conditions.push(eq(bookTestimonials.status, 'approved'));

    const rows = await dbRead
      .select({
        id: bookTestimonials.id,
        userId: bookTestimonials.userId,
        bookId: bookTestimonials.bookId,
        rating: bookTestimonials.rating,
        content: bookTestimonials.content,
        status: bookTestimonials.status,
        featured: bookTestimonials.featured,
        createdAt: bookTestimonials.createdAt,
        updatedAt: bookTestimonials.updatedAt,
        name: users.name,
        imageUrl: users.imageUrl,
        bookTitle: books.title,
        bookSlug: books.slug,
        bookImageUrl: uploadedImages.imageUrl,
      })
      .from(bookTestimonials)
      .innerJoin(books, eq(bookTestimonials.bookId, books.id))
      .innerJoin(users, eq(bookTestimonials.userId, users.userId))
      .leftJoin(uploadedImages, eq(books.imageId, uploadedImages.imageId))
      .where(and(...conditions))
      .orderBy(desc(bookTestimonials.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(bookTestimonials)
      .innerJoin(books, eq(bookTestimonials.bookId, books.id))
      .where(and(...conditions));

    // Rating summary over the same visible set (ignores the `featured` flag).
    const summaryRows = await dbRead
      .select({ rating: bookTestimonials.rating })
      .from(bookTestimonials)
      .innerJoin(books, eq(bookTestimonials.bookId, books.id))
      .where(and(...conditions, sql`${bookTestimonials.rating} IS NOT NULL`));

    const distribution: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let total = 0;
    let rated = 0;
    for (const { rating } of summaryRows) {
      const r = Number(rating);
      total += r;
      rated += 1;
      distribution[r] = (distribution[r] ?? 0) + 1;
    }

    const ratingSummary = {
      count: rated,
      avg: rated > 0 ? Number((total / rated).toFixed(1)) : 0,
      distribution,
    };

    const pagination = calculatePaginationMeta(page, limit, count);
    c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    return c.json({
      testimonials: rows,
      ratingSummary,
      pagination,
    });
  } catch (error) {
    return cApiError(c, 'Failed to fetch user testimonials', error);
  }
});

/**
 * GET /api/users/:identifier/testimonials/given
 * Public testimonials the user has WRITTEN on other people's books.
 *
 * - Public viewers see only `approved` testimonials.
 * - The profile owner (authenticated viewer === target user) sees all statuses.
 */
router.get('/users/:identifier/testimonials/given', optionalAuth, async (c: Context<AppEnv>) => {
  try {
    const resolved = await resolveProfileUserId(c);
    if (!resolved) return cNotFoundError(c, 'User not found');

    const viewerId = c.get('userId');
    const isOwner = viewerId === resolved.userId;
    const { limit = DEFAULT_ITEMS_PER_PAGE, page = 1 } = extractPaginationParams(c.req.query());
    const offset = (page - 1) * limit;

    const conditions = [eq(bookTestimonials.userId, resolved.userId)];
    if (!isOwner) conditions.push(eq(bookTestimonials.status, 'approved'));

    const rows = await dbRead
      .select({
        id: bookTestimonials.id,
        userId: bookTestimonials.userId,
        bookId: bookTestimonials.bookId,
        rating: bookTestimonials.rating,
        content: bookTestimonials.content,
        status: bookTestimonials.status,
        featured: bookTestimonials.featured,
        createdAt: bookTestimonials.createdAt,
        updatedAt: bookTestimonials.updatedAt,
        name: users.name,
        imageUrl: users.imageUrl,
        bookTitle: books.title,
        bookSlug: books.slug,
        bookImageUrl: uploadedImages.imageUrl,
      })
      .from(bookTestimonials)
      .innerJoin(books, eq(bookTestimonials.bookId, books.id))
      .leftJoin(users, eq(bookTestimonials.userId, users.userId))
      .leftJoin(uploadedImages, eq(books.imageId, uploadedImages.imageId))
      .where(and(...conditions))
      .orderBy(desc(bookTestimonials.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(bookTestimonials)
      .where(and(...conditions));

    const pagination = calculatePaginationMeta(page, limit, count);
    c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    return c.json({ testimonials: rows, pagination });
  } catch (error) {
    return cApiError(c, 'Failed to fetch user given testimonials', error);
  }
});

/**
 * POST /api/users/:identifier/report
 * Report a user profile to the moderation queue.
 *
 * @access Private (requires auth)
 * @param {string} c.req.param().identifier - UUID or username of the reported user
 * @param {string} c.get("body").reportType - spam | harassment | impersonation | inappropriate | other
 * @param {string} [c.get("body").message] - Optional detail message (≤ 2000 chars)
 * @returns {Object} 201 - Created report
 * @returns {Error} 400 - Validation error
 * @returns {Error} 401 - Unauthorized
 */
router.post('/users/:identifier/report', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const reporterId = c.get('userId')!;
    const resolved = await resolveProfileUserId(c);
    if (!resolved) return cNotFoundError(c, 'User not found');
    if (resolved.userId === reporterId) {
      return cValidationError(c, 'You cannot report yourself');
    }

    const { reportType, message } = c.get('body') as { reportType?: string; message?: string };
    const validTypes = ['spam', 'harassment', 'impersonation', 'inappropriate', 'other'];
    if (!reportType || !validTypes.includes(reportType)) {
      return cValidationError(c, `reportType must be one of: ${validTypes.join(', ')}`);
    }
    const cleanMessage = typeof message === 'string' ? message.trim() : '';
    if (cleanMessage.length > 2000) {
      return cValidationError(c, 'Message must be at most 2000 characters');
    }

    const [report] = await dbWrite
      .insert(userReports)
      .values({
        reporterId,
        reportedUserId: resolved.userId,
        reportType: reportType as 'spam' | 'harassment' | 'impersonation' | 'inappropriate' | 'other',
        message: cleanMessage || null,
        status: 'open',
      })
      .returning({ id: userReports.id });

    c.status(201);
    return c.json({ success: true, report: { id: report.id } });
  } catch (error) {
    return cApiError(c, 'Failed to submit report', error);
  }
});

/**
 * POST /api/users/:identifier/block
 * Block a user so their content is hidden from you.
 *
 * @access Private (requires auth)
 * @returns {Object} 200 - Success
 */
router.post('/users/:identifier/block', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get('userId')!;
    const resolved = await resolveProfileUserId(c);
    if (!resolved) return cNotFoundError(c, 'User not found');
    if (resolved.userId === userId) {
      return cValidationError(c, 'You cannot block yourself');
    }

    await dbWrite
      .insert(userBlocks)
      .values({ userId, blockedUserId: resolved.userId })
      .onConflictDoNothing();

    // A block implicitly removes any follow relationship between the two.
    await dbWrite
      .delete(userFollows)
      .where(and(
        eq(userFollows.followerId, userId),
        eq(userFollows.followingId, resolved.userId),
      ));

    await invalidateUserProfileCache(resolved.userId);
    return c.json({ success: true, message: 'User blocked' });
  } catch (error) {
    return cApiError(c, 'Failed to block user', error);
  }
});

/**
 * DELETE /api/users/:identifier/block
 * Unblock a user.
 *
 * @access Private (requires auth)
 * @returns {Object} 200 - Success
 */
router.delete('/users/:identifier/block', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get('userId')!;
    const resolved = await resolveProfileUserId(c);
    if (!resolved) return cNotFoundError(c, 'User not found');

    await dbWrite
      .delete(userBlocks)
      .where(and(
        eq(userBlocks.userId, userId),
        eq(userBlocks.blockedUserId, resolved.userId),
      ));

    return c.json({ success: true, message: 'User unblocked' });
  } catch (error) {
    return cApiError(c, 'Failed to unblock user', error);
  }
});

/**
 * GET /api/user/achievements/unnotified
 * Ultra-fast endpoint to check, award, and return newly unlocked badges.
 * Designed to be called by the frontend immediately after taking actions.
 */
router.get('/achievements/unnotified', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;

    // 1. Evaluate counters against the TS Registry. 
    // This will INSERT into user_achievements if thresholds are met.
    await checkAndAwardAchievements(userId);

    // 2. Fetch only badges the user hasn't seen yet
    const unnotifiedRows = await dbRead
      .select({
        id: userAchievements.id,
        achievementId: userAchievements.achievementId,
      })
      .from(userAchievements)
      .where(
        and(
          eq(userAchievements.userId, userId),
          eq(userAchievements.isNotified, false)
        )
      );

    if (unnotifiedRows.length === 0) {
      return c.json({ success: true, badges: [] });
    }

    // 3. Fetch current counter values for progress data
    const metrics = await getUserMetrics(userId);

    // 4. Map to full UserAchievement shape (same format as getUserAchievements)
    const badges = unnotifiedRows.map(row => {
      const rule = ACHIEVEMENT_REGISTRY.find(r => r.id === row.achievementId);
      if (!rule) return null;
      const currentValue = metrics[rule.metric];
      const progressPercent = Math.round((Math.min(currentValue, rule.threshold) / rule.threshold) * 100);
      return {
        id: rule.id,
        title: rule.title,
        description: rule.description,
        badgeImageUrl: rule.badgeImageUrl,
        tier: rule.tier,
        currentProgress: currentValue,
        threshold: rule.threshold,
        progressPercent,
        isUnlocked: true,
        unlockedAt: null,
        isNotified: false,
      } satisfies UserAchievement;
    }).filter((b): b is NonNullable<typeof b> => b != null);

    return c.json({ success: true, badges });
  } catch (error) {
    return cApiError(c, 'Failed to fetch unnotified achievements', error);
  }
});

/**
 * POST /api/user/achievements/acknowledge
 * Updates status after frontend triggers notification toast.
 */
router.post('/achievements/acknowledge', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { achievementIds } = c.get("body"); // Expects array string: ["gen_50"]

    if (!Array.isArray(achievementIds) || achievementIds.length === 0) {
      return cValidationError(c, 'Invalid payload elements');
    }

    await dbWrite
      .update(userAchievements)
      .set({ isNotified: true })
      .where(
        and(
          eq(userAchievements.userId, userId),
          sql`${userAchievements.achievementId} IN ${achievementIds}`
        )
      );

    return c.json({ success: true, message: 'Badges flagged as viewed' });
  } catch (error) {
    return cApiError(c, 'Failed to clear banner states', error);
  }
});

// ===== USER FEEDBACK ROUTES =====

/**
 * POST /user/feedbacks
 * 
 * Submit user feedback with optional screenshot attachment.
 * If a base64 screenshot is provided, it is uploaded to ImageKit and stored
 * as a feedback_screenshot in the uploaded_images table before persisting the feedback.
 * 
 * @route POST /user/feedbacks
 * @description Submit user feedback with optional screenshot
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Feedback data
 * @body {string} category - Feedback category ("feedback" | "bug_report" | "feature_request" | "other")
 * @body {string} message - Feedback message content
 * @body {string} [imageUrl] - Base64 screenshot data URL (optional)
 * 
 * @returns {Object} Feedback creation response
 * @returns {Object} feedback - Created feedback record
 * 
 * @example
 * // Request (text only)
 * POST /user/feedbacks
 * Body: {
 *   "category": "bug_report",
 *   "message": "The app crashes when I try to open book settings"
 * }
 * 
 * // Request (with screenshot)
 * POST /user/feedbacks
 * Body: {
 *   "category": "bug_report",
 *   "message": "The UI is broken on the editor screen",
 *   "imageUrl": "data:image/png;base64,iVBORw0KGgo..."
 * }
 * 
 * // Response
 * {
 *   "feedback": {
 *     "id": "fb-uuid",
 *     "userId": "user-uuid",
 *     "category": "bug_report",
 *     "message": "The app crashes when I try to open book settings",
 *     "imageId": "ik_file_id",
 *     "imageUrl": "https://ik.imagekit.io/...",
 *     "status": "success",
 *     "createdAt": "2026-07-10T00:00:00.000Z",
 *     "updatedAt": "2026-07-10T00:00:00.000Z"
 *   }
 * }
 * 
 * @example Error
 * // Response (400 — invalid category)
 * {
 *   "success": false,
 *   "error": "Invalid category. Must be one of: feedback, bug_report, feature_request, other"
 * }
 * 
 * // Response (400 — missing message)
 * {
 *   "success": false,
 *   "error": "Message is required"
 * }
 */
router.post("/feedbacks", requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { category, message, imageUrl } = c.get("body");

    // Validate category
    if (!category || !feedbackCategories.includes(category as FeedbackCategory)) {
      return c.json({
        success: false,
        error: `Invalid category. Must be one of: ${feedbackCategories.join(', ')}`,
      }, 400);
    }

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return c.json({
        success: false,
        error: 'Message is required',
      }, 400);
    }

    let imageId: string | undefined;
    let imageUrlResult: string | undefined;

    // Upload screenshot to ImageKit if provided as base64
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
      const uploadResult = await uploadFeedbackScreenshot(imageUrl, userId);
      if (uploadResult?.url && uploadResult?.fileId) {
        imageId = uploadResult.fileId;
        imageUrlResult = uploadResult.url;

        await persistUploadedImage({
          imageId,
          imageUrl: imageUrlResult,
          type: 'feedback',
          userId,
        });
      }
    }

    const feedbackData: DBNewUserFeedback = {
      userId,
      category: category as FeedbackCategory,
      message: message.trim(),
      imageId: imageId ?? null,
      imageUrl: imageUrlResult ?? null,
      status: 'success',
    };

    const [feedback] = await dbWrite
      .insert(userFeedbacks)
      .values(feedbackData)
      .returning();

    // Non-blocking: user ack + optional internal ops alert
    const [userRow] = await dbRead
      .select({ email: users.email, name: users.name, username: users.username })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (userRow?.email) {
      const {
        sendFeedbackAcknowledgmentEmail,
        sendFeedbackInternalEmail,
        sendEmailSafe,
      } = await import('../utils/email.js');
      sendEmailSafe('POST /user/feedbacks ack', () =>
        sendFeedbackAcknowledgmentEmail(userRow.email, userRow.name || 'there', { userId }),
      );

      const feedbackInbox = process.env.FEEDBACK_INBOX;
      if (feedbackInbox) {
        sendEmailSafe('POST /user/feedbacks internal', () =>
          sendFeedbackInternalEmail(feedbackInbox, {
            category: category as string,
            message: message.trim(),
            userId,
            username: userRow.username,
            email: userRow.email,
            imageUrl: imageUrlResult ?? null,
          }),
        );
      }
    }

    c.status(201);
    return c.json({ feedback });
  } catch (error) {
    console.error('[POST /user/feedbacks] ❌', error);
    return cApiError(c, 'Failed to submit feedback', error);
  }
});

// ===== EMAIL PREFERENCES =====

/**
 * GET /user/email-preferences
 *
 * Returns optional product/engagement email flags. Security and billing mail
 * are always on and are not included in this payload.
 */
router.get('/email-preferences', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get('userId')!;
    const {
      getEmailPreferences,
      ensureDefaultEmailPreferences,
    } = await import('../services/email-preferences.js');

    let prefs = await getEmailPreferences(userId);
    if (!prefs) return cNotFoundError(c, 'User not found');

    // Lazy-apply defaults for users onboarded before prefs existed
    if (prefs) {
      await ensureDefaultEmailPreferences(userId);
      prefs = (await getEmailPreferences(userId)) ?? prefs;
    }

    return c.json({ preferences: prefs });
  } catch (error) {
    console.error('[GET /user/email-preferences] ❌', error);
    return cApiError(c, 'Failed to fetch email preferences', error);
  }
});

/**
 * PATCH /user/email-preferences
 *
 * Partial update of engagement email flags. Unknown keys rejected.
 */
router.patch('/email-preferences', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get('userId')!;
    const body = c.get('body');
    const {
      sanitizeEmailPreferencesUpdate,
      updateEmailPreferences,
      ensureDefaultEmailPreferences,
    } = await import('../services/email-preferences.js');

    const patch = sanitizeEmailPreferencesUpdate(body);
    if (!patch) {
      return cValidationError(
        c,
        'Provide at least one field: weeklyRecommendations, monthlyActivitySummary, productAnnouncements, emailLocale',
      );
    }

    await ensureDefaultEmailPreferences(userId);
    const prefs = await updateEmailPreferences(userId, patch);
    if (!prefs) return cNotFoundError(c, 'User not found');

    return c.json({ preferences: prefs });
  } catch (error) {
    console.error('[PATCH /user/email-preferences] ❌', error);
    return cApiError(c, 'Failed to update email preferences', error);
  }
});

/**
 * PATCH /user/preferred-locale
 *
 * Fire-and-forget friendly update of account UI language (preferredLocale).
 * Email language follows this unless emailLocale override is set.
 */
router.patch('/preferred-locale', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get('userId')!;
    const body = c.get('body') as { preferredLocale?: string };
    const { isEmailLocale } = await import('../types/email-locale.js');
    const { updatePreferredLocale } = await import('../services/email-preferences.js');

    if (!body?.preferredLocale || !isEmailLocale(body.preferredLocale)) {
      return cValidationError(c, 'preferredLocale must be "en" or "id"');
    }

    const preferredLocale = await updatePreferredLocale(userId, body.preferredLocale);
    if (!preferredLocale) return cNotFoundError(c, 'User not found');

    return c.json({ preferredLocale });
  } catch (error) {
    console.error('[PATCH /user/preferred-locale] ❌', error);
    return cApiError(c, 'Failed to update preferred locale', error);
  }
});

// ===== QUESTS ROUTES ("The Prologue") =====

/**
 * GET /user/quests
 *
 * Returns the authenticated user's quest log ("The Prologue") — every enabled
 * registry quest with its current progress, status, and reward, plus a summary
 * used to derive the nav badge.
 *
 * Mirrors `GET /user/achievements`: quests are evaluated on read, so newly-met
 * goals are recorded before the response is assembled.
 *
 * @route GET /user/quests
 * @description Get the user's quest log and summary
 * @auth Required
 *
 * @returns {Object} Quest log response
 * @returns {boolean} success - Always true
 * @returns {Array} quests - Ordered list of UserQuest states
 * @returns {Object} summary - completed / claimable / totalReward / unclaimedReward
 *
 * @example
 * GET /user/quests
 * {
 *   "success": true,
 *   "quests": [
 *     {
 *       "id": "qs_01_1",
 *       "chapterId": "ch1",
 *       "title": "Complete your profile",
 *       "description": "Who you are makes your stories yours.",
 *       "rewardCredits": 10,
 *       "currentProgress": 1,
 *       "threshold": 1,
 *       "progressPercent": 100,
 *       "status": "completed",
 *       "completedAt": "2026-08-06T00:00:00.000Z",
 *       "claimedAt": null,
 *       "enabled": true
 *     }
 *   ],
 *   "summary": {
 *     "completed": 1,
 *     "claimable": 1,
 *     "totalReward": 385,
 *     "unclaimedReward": 10
 *   }
 * }
 */
router.get('/quests', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const quests = await getUserQuests(userId);
    const summary = summarizeQuests(quests);
    return c.json({ success: true, quests, summary });
  } catch (error) {
    return cApiError(c, 'Failed to fetch quest log', error);
  }
});

/**
 * POST /user/quests/recheck
 *
 * Explicitly re-evaluates all quests against the user's live data and returns
 * the ids of any quests newly marked `completed`. Call after events that don't
 * move `user_counters` (e.g. favoriting, following, finishing a branch).
 *
 * @route POST /user/quests/recheck
 * @description Re-evaluate quest completion and return newly-completed ids
 * @auth Required
 *
 * @returns {boolean} success - Always true
 * @returns {Array} newlyCompleted - Quest ids completed by this re-check
 */
router.post('/quests/recheck', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const newlyCompleted = await recheckQuests(userId);
    return c.json({ success: true, newlyCompleted });
  } catch (error) {
    return cApiError(c, 'Failed to re-check quests', error);
  }
});

/**
 * POST /user/quests/claim-all
 *
 * Atomically claims EVERY currently-completed quest in a single transaction —
 * the user's aggregate claim button in "The Prologue". Payout is the sum of
 * the registry rewards for the claimed quests, added in one `addCredits` call,
 * so the user gets one balance bump instead of N. Idempotent: with nothing
 * claimable it returns `status: 'none_claimable'` and no writes occur.
 *
 * @route POST /user/quests/claim-all
 * @description Claim all completed quest rewards at once
 * @auth Required
 *
 * @returns {boolean} success - Always true
 * @returns {string} status - 'claimed' | 'none_claimable'
 * @returns {number} claimedCount - Number of quests claimed in this batch
 * @returns {number} creditsAwarded - Total credits paid out (0 when none)
 * @returns {number} newBalance - User's credit balance after the claims
 */
router.post('/quests/claim-all', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const result = await claimAllQuestRewardsAndInvalidate(userId);
    return c.json({ success: true, ...result });
  } catch (error) {
    return cApiError(c, 'Failed to claim quest rewards', error);
  }
});

/**
 * POST /user/quests/:questId/claim
 *
 * Atomically claims a completed quest's credit reward. Idempotent: a quest that
 * is already claimed returns `already_claimed` with no credit change; a quest
 * that is not yet completed returns `not_completed`.
 *
 * @route POST /user/quests/:questId/claim
 * @description Claim a completed quest's credit reward
 * @auth Required
 *
 * @returns {boolean} success - Operation status
 * @returns {string} questId - The claimed quest id
 * @returns {string} status - 'claimed' | 'already_claimed' | 'not_completed' | 'not_found'
 * @returns {number} creditsAwarded - Credits paid out (0 when not claimed)
 * @returns {number} newBalance - User's credit balance after the claim
 */
router.post('/quests/:questId/claim', requireAuth, async (c: Context<AppEnv>) => {
  try {
    const userId = c.get("userId")!;
    const { questId } = c.req.param();

    const result = await claimQuestRewardAndInvalidate(userId, questId);

    if (result.status === 'not_found') {
      return cNotFoundError(c, 'Quest not found');
    }
    if (result.status === 'already_claimed') {
      return cConflictError(c, 'Quest reward already claimed');
    }

    return c.json({
      success: result.status === 'claimed',
      questId,
      status: result.status,
      creditsAwarded: result.creditsAwarded,
      newBalance: result.newBalance,
    }, result.status === 'claimed' ? 200 : 400);
  } catch (error) {
    console.error('[POST /user/quests/:questId/claim] ❌', error);
    return cApiError(c, 'Failed to claim quest reward', error);
  }
});

export default router;
