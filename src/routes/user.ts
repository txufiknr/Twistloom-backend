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
 * 
 * Note: Comment CRUD endpoints are in books.ts, not this file.
 */

import type { Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import type { DBNewUserLike, DBNewUserFavorite } from "../types/schema.js";
import type { LikeTargetType, User, UserAchievement, UserActivityType, UserStats } from "../types/user.js";
import { Router } from 'express';
import { dbRead, dbWrite } from '../db/client.js';
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { users, books, userLikes, userFavorites, userFollows, userActivityLogs, userAchievements, uploadedImages } from "../db/schema.js";
import { getErrorMessage, handleApiError, handleNotFoundError, handleValidationError } from "../utils/error.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { calculatePaginationMeta } from "../utils/pagination.js";
import { updateUserLastActivity, getCheckInStatus, logUserActivity, sanitizeProfileUpdate, enrichActivityLogs } from "../services/user.js";
import { invalidateCachePattern } from "../utils/cache.js";
import { invalidateExploreCache, invalidateUserBooksCache, invalidateUserProfileCache, withCache, CACHE_KEYS, CACHE_TTL } from "../services/cache.js";
import { getEnrichedUser, getEnrichedUserById, setReferrerForNewUser, handleCheckIn } from "../services/user-controller.js";
import { uploadUserImage } from "../services/image.js";
import { isValidUuid } from "../utils/uuid.js";
import { getStoryProgressWithBranch } from '../services/story-branch.js';
import { checkAndAwardAchievements, getUserAchievements, getUserMetrics } from '../services/achievements.js';
import type { PaginationMeta } from '../types/api.js';
import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';

const router: RouterType = Router();

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
 * @returns {string|null} user.tier - User's subscription tier
 * @returns {number} user.credits - Available credits
 * @returns {boolean} user.isNewUser - Onboarding completed flag
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
 * @returns {string|null} user.subscription.tier - User's tier
 * @returns {string|null} user.subscription.vipExpiresAt - VIP expiration
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
 *     "tier": null,
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
 *       "vipExpiresAt": null
 *     },
 *     "lastActive": "2024-01-15T10:30:00.000Z",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2024-01-15T10:30:00.000Z"
 *   }
 * }
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const [user] = await getEnrichedUserById(userId);

    if (!user) return handleNotFoundError(res, 'User not found');

    res.json({ user });
  } catch (error) {
    console.error('[GET /api/user] ❌', error);
    handleApiError(res, 'Failed to fetch user profile', error);
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
 * @body {Object} Onboarding data
 * @body {string} [name] - User's display name
 * @body {string} [gender] - User's gender (e.g., "male", "female", "unknown")
 * @body {string} [referrer] - Referrer username or user ID
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
 *   "gender": "male"
 * }
 * 
 * // Response
 * {
 *   "message": "Onboarding complete",
 *   "isNewUser": false,
 *   "username": "johndoe"
 * }
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const [current] = await dbRead
      .select({ isNewUser: users.isNewUser, username: users.username })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!current) return handleNotFoundError(res, 'User not found');
    if (!current.isNewUser) return handleValidationError(res, 'Onboarding already completed');

    // 1. Sanitize payload via SSOT
    const updateData = await sanitizeProfileUpdate(userId, req.body, res);
    if (!updateData) return;

    // 2. Append route-specific data
    updateData.isNewUser = false;
    updateData.updatedAt = new Date();

    // 3. Apply update
    await dbWrite
      .update(users)
      .set(updateData)
      .where(eq(users.userId, userId));

    // 4. Handle Referrer
    if (req.body.referrer && typeof req.body.referrer === 'string') {
      await setReferrerForNewUser(req, res, userId, req.body.referrer, { handleResponse: false });
    }

    await invalidateUserProfileCache(userId);
    await updateUserLastActivity(userId);
    await logUserActivity(
      { userId, activityType: 'onboarding_complete', targetType: 'user', targetId: userId },
      { req }
    );

    res.json({
      message:   'Onboarding complete',
      isNewUser: false,
      username:  (updateData.username as string | undefined) ?? current.username,
    });
  } catch (error) {
    console.error('[POST /api/user] ❌', error);
    handleApiError(res, 'Failed to complete onboarding', error);
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
 * @body {string} [referrer] - Referrer username (only applies if isNewUser and no referrer set)
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
router.put('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // 1. Sanitize payload via SSOT
    const updateData = await sanitizeProfileUpdate(userId, req.body, res);
    if (!updateData) return;

    // Require at least one valid field to update
    if (Object.keys(updateData).length === 0) {
      return handleValidationError(res, 'At least one valid field must be provided');
    }

    // 2. Upload profile image to ImageKit if it's base64 data
    if (updateData.imageUrl?.startsWith('data:')) {
      const uploadResult = await uploadUserImage(updateData.imageUrl, userId);
      if (!uploadResult?.url) {
        handleApiError(res, 'Failed to upload profile image', new Error('ImageKit upload returned no URL'));
        return;
      }

      // Insert into uploaded_images — DB trigger auto-sets users.image_url.
      // Old user images are cleaned up by daily cron (cleanupStaleUserUploads).
      await dbWrite.insert(uploadedImages).values({
        imageId: uploadResult.fileId!,
        imageUrl: uploadResult.url!,
        type: 'user',
        userId,
      });

      // Remove from updateData — trigger handles users.image_url
      delete updateData.imageUrl;
    }

    // 3. Append route-specific data
    updateData.updatedAt = new Date();

    // 4. Apply update and return updated row
    const [user] = await dbWrite
      .update(users)
      .set(updateData)
      .where(eq(users.userId, userId))
      .returning();

    await invalidateUserProfileCache(userId);
    await updateUserLastActivity(userId);

    // 5. Handle Referrer (only if isNewUser and referrerId is empty — enforced by setReferrerForNewUser)
    if (req.body.referrer && typeof req.body.referrer === 'string') {
      await setReferrerForNewUser(req, res, userId, req.body.referrer, { handleResponse: false });
    }

    // Rename userId → id for frontend consistency
    const { userId: id, ...rest } = user;
    res.json({ success: true, user: { id, ...rest } });
  } catch (error) {
    console.error('[PUT /api/user] ❌', error);
    handleApiError(res, 'Failed to update profile', error);
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
 *       "vipExpiresAt": null
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
router.get("/users/:identifier", async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    // Ensure identifier is a string (Express params can be string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;
    
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

      if (!userData) throw new Error("User profile not found");

      // Format response to match frontend expectations
      const formattedUser: User = {
        id: userData.id,
        username: userData.username,
        email: userData.email,
        name: userData.name,
        bio: userData.bio,
        gender: userData.gender,
        lastActive: userData.lastActive,
        isNewUser: userData.isNewUser,
        imageUrl: userData.imageUrl,
        credits: userData.credits,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        
        subscription: {
          tier: userData.tier,
          vipExpiresAt: userData.vipExpiresAt,
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
          activeCheckinStreak: userData.activeCheckinStreak,
          maxCheckinStreak: userData.maxCheckinStreak,
          customActionsWritten: userData.customActionsWritten,
        } satisfies UserStats,
      };

      return {
        user: formattedUser,
      };
    };
    
    // Use cache with fallback to database
    const result = await withCache(cacheKey, fetchUserProfile, CACHE_TTL.USER_PROFILE);
    
    // Add HTTP cache headers for CDN/edge caching
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    
    res.json(result);
  } catch (error) {
    if (getErrorMessage(error) === "User profile not found") {
      return handleNotFoundError(res, "User profile not found");
    }
    handleApiError(res, "Failed to retrieve user profile", error);
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
router.delete("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Delete user - cascade delete will handle all related tables automatically
    // Tables with cascade delete on userId:
    // - userAuth, userPageProgress
    // - userFollows, userCompletedBooks, userActivityLogs, transactions
    // - userNotifications, userCheckins, userLikes, userFavorites, userComments, userSessions
    await dbWrite.delete(users).where(eq(users.userId, userId));

    // Invalidate all relevant user cache entries
    await Promise.all([
      invalidateCachePattern(`user:${userId}%`),
      invalidateUserProfileCache(userId),
    ]);

    res.json({
      message: "User account deleted successfully",
      // imageQueuedForDeletion: !!imageToDelete.imageId,
    });

  } catch (error) {
    handleApiError(res, "Failed to delete user account", error);
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
router.post("/likes", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { targetType, targetId } = req.body;

    // Validate target type
    if (!["book", "comment", "user"].includes(targetType)) {
      return res.status(400).json({
        success: false,
        error: "Invalid target type. Must be 'book', 'comment', or 'user'",
      });
    }

    if (!targetId) {
      return res.status(400).json({
        success: false,
        error: "Target ID is required",
      });
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

    res.status(201).json({
      like,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'liked',
      targetType,
      targetId,
    }, { req });

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
  } catch (error) {
    handleApiError(res, "Failed to create like", error);
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
router.delete("/likes", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { targetType, targetId } = req.query;

    // Validate target type
    if (!targetType || !["book", "comment", "user"].includes(targetType as string)) {
      return res.status(400).json({
        success: false,
        error: "Valid target type is required. Must be 'book', 'comment', or 'user'",
      });
    }

    if (!targetId) {
      return res.status(400).json({
        success: false,
        error: "Target ID is required",
      });
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
      return handleNotFoundError(res, "Like not found");
    }

    res.json({
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
  } catch (error) {
    handleApiError(res, "Failed to remove like", error);
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
router.get("/likes", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { targetType, limit = "50", offset = "0" } = req.query;

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

    res.json({
      likes,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve likes", error);
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
router.post("/favorites", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId } = req.body;

    if (!bookId) {
      return res.status(400).json({
        success: false,
        error: "Book ID is required",
      });
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

    res.status(201).json({
      favorite,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'favorited',
      targetType: 'book',
      targetId: bookId,
    }, { req });

    // Invalidate user profile cache (savedBooksCount changed)
    await invalidateUserProfileCache(userId);
  } catch (error) {
    handleApiError(res, "Failed to add book to favorites", error);
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
router.delete("/favorites", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId } = req.query;

    if (!bookId) {
      return res.status(400).json({
        success: false,
        error: "Book ID is required",
      });
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
      return handleNotFoundError(res, "Favorite not found");
    }

    res.json({
      message: "Book removed from favorites successfully",
    });

    // Invalidate user profile cache (savedBooksCount changed)
    await invalidateUserProfileCache(userId);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to remove book from favorites", error);
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
router.get("/collections", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    // Return empty response for unauthenticated users (handles auth timing race conditions)
    if (!userId) return res.json({ collections: [] });

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

    res.json({ collections });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve collections", error);
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
router.post("/users/:id/follow", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { id: followingId } = req.params;

    // Ensure followingId is a string (Express params can be string[])
    const followingIdStr = Array.isArray(followingId) ? followingId[0] : followingId;

    if (userId === followingIdStr) {
      return handleValidationError(res, "You cannot follow yourself");
    }

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, followingIdStr))
      .limit(1);

    if (targetUser.length === 0) {
      return handleNotFoundError(res, "User not found");
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

    res.status(201).json({
      follow,
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'followed',
      targetType: 'user',
      targetId: followingIdStr,
    }, { req });

    // Invalidate user profile cache (followersCount changed)
    await invalidateUserProfileCache(followingIdStr);
  } catch (error) {
    handleApiError(res, "Failed to follow user", error);
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
router.delete("/users/:id/follow", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { id: followingId } = req.params;

    // Ensure followingId is a string (Express params can be string[])
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
      return handleNotFoundError(res, "Follow relationship not found");
    }

    res.json({
      message: "User unfollowed successfully",
    });

    // Invalidate user profile cache (followersCount changed)
    await invalidateUserProfileCache(followingIdStr);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to unfollow user", error);
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
router.get("/users/:id/followers", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = "50", offset = "0" } = req.query;

    // Ensure id is a string
    const idStr = Array.isArray(id) ? id[0] : id;

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, idStr))
      .limit(1);

    if (targetUser.length === 0) {
      return handleNotFoundError(res, "User not found");
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

    res.json({
      followers,
      pagination
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve followers", error);
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
router.get("/users/:id/following", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = "50", offset = "0" } = req.query;

    // Ensure id is a string
    const idStr = Array.isArray(id) ? id[0] : id;

    // Check if user exists
    const targetUser = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, idStr))
      .limit(1);

    if (targetUser.length === 0) {
      return handleNotFoundError(res, "User not found");
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

    res.json({
      following,
      pagination
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve following", error);
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
router.get("/followers", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { limit = "50", offset = "0" } = req.query;

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

    res.json({
      followers,
      pagination
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve followers", error);
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
router.get("/following", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { limit = "50", offset = "0" } = req.query;

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

    res.json({
      following,
      pagination
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve following", error);
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
router.get("/checkin/status", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    
    // Return null response for unauthenticated users (handles auth timing race conditions)
    if (!userId) {
      console.log(`[GET /user/checkin/status] 👀 No userId, returning null check-in status`);
      return res.json({
        eligible: false,
        lastCheckIn: null,
        streak: 0,
        totalCheckIns: 0,
        creditsClaimed: 0,
        recentCheckIns: [],
      });
    }
    
    const status = await getCheckInStatus(userId);
    res.json(status);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to get check-in status", error);
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
router.post("/checkin", requireAuth, (req, res) => handleCheckIn(req, res));

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
router.post("/checkin/double", requireAuth, (req, res) => handleCheckIn(req, res, 'vip_2x'));

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
router.get("/activity-logs", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.json({
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

    const { activityType, targetType } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
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

    res.json({
      logs: enriched,
      pagination,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve activity logs", error);
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
router.get("/progress", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req;
    const progress = userId ? await getStoryProgressWithBranch(userId) : {
      book: null,
      page: null,
      state: null,
      session: null,
      branchPath: null,
      branchStats: null,
      siblings: []
    };

    res.json(progress);
  } catch (error) {
    handleApiError(res, "Failed to retrieve story progress", error);
  }
});

/**
 * GET /api/user/achievements
 * Returns detailed view of unlocked and locked achievements with progress calculations.
 *
 * @query {number} page - Page number for pagination (default: 1)
 * @query {number} limit - Items per page (default: 50)
 */
router.get('/achievements', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const badges = await getUserAchievements(userId);

    // Apply pagination if params provided
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || badges.length;
    const offset = (page - 1) * limit;
    const pagedBadges = badges.slice(offset, offset + limit);
    const pagination = calculatePaginationMeta(page, limit, badges.length);

    res.json({ success: true, badges: pagedBadges, pagination });
  } catch (error) {
    handleApiError(res, 'Failed to fetch achievements layout', error);
  }
});

/**
 * GET /api/user/achievements/unnotified
 * Ultra-fast endpoint to check, award, and return newly unlocked badges.
 * Designed to be called by the frontend immediately after taking actions.
 */
router.get('/achievements/unnotified', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

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
      return res.json({ success: true, badges: [] });
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

    res.json({ success: true, badges });
  } catch (error) {
    handleApiError(res, 'Failed to fetch unnotified achievements', error);
  }
});

/**
 * POST /api/user/achievements/acknowledge
 * Updates status after frontend triggers notification toast.
 */
router.post('/achievements/acknowledge', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { achievementIds } = req.body; // Expects array string: ["gen_50"]

    if (!Array.isArray(achievementIds) || achievementIds.length === 0) {
      return handleValidationError(res, 'Invalid payload elements');
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

    res.json({ success: true, message: 'Badges flagged as viewed' });
  } catch (error) {
    handleApiError(res, 'Failed to clear banner states', error);
  }
});

export default router;