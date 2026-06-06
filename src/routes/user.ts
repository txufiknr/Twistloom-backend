/**
 * @overview User Routes Module
 * 
 * Provides endpoints for managing user profile information, likes, favorites, and comments.
 * Implements CRUD operations for user profile storage and retrieval, plus social features.
 * 
 * Architecture Features:
 * - User profile management
 * - Full replacement and partial update operations
 * - Conflict resolution with upsert patterns
 * - Consistent error handling and validation
 * - Analytics-friendly user tracking
 * - Social interactions (likes, favorites, comments, follows)
 * 
 * Endpoints:
 * - GET /user - Get authenticated user profile
 * - GET /users/:identifier - Get user profile by UUID or username (public)
 * - POST /user - Create or fully replace user profile
 * - PUT /user - Partially update user profile
 * - DELETE /user - Delete user profile and all associated data
 * - POST /user/likes - Like a target item
 * - DELETE /user/likes - Unlike a target item
 * - GET /user/likes - Get user likes
 * - POST /user/favorites - Add book to favorites
 * - DELETE /user/favorites - Remove book from favorites
 * - GET /user/favorites - Get user favorites
 * - GET /user/collections - Get user collection names
 * - POST /user/comments - Create comment
 * - PUT /user/comments/:commentId - Update comment
 * - DELETE /user/comments/:commentId - Delete comment
 * - GET /user/comments - Get user comments
 * - POST /users/:id/follow - Follow a user
 * - DELETE /users/:id/follow - Unfollow a user
 * - GET /users/:id/followers - Get user followers
 * - GET /users/:id/following - Get user following
 * - GET /user/followers - Get authenticated user's followers
 * - GET /user/following - Get authenticated user's following
 * - GET /user/checkin/status - Get daily check-in status
 * - POST /user/checkin - Perform daily check-in and claim free credits
 */

import type { Request, Response, Router as RouterType } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { requireAuth } from "../middleware/nextauth.js";
import { users, userLikes, userFavorites, userComments, userFollows, deletedImages, userActivityLogs } from "../db/schema.js";
import type { DBNewUser, DBNewUserLike, DBNewUserFavorite, DBNewUserComment } from "../types/schema.js";
import type { LikeTargetType, User, UserActivityType } from "../types/user.js";
import { getErrorMessage, handleApiError, handleForbiddenError, handleNotFoundError, handleValidationError } from "../utils/error.js";
import { sanitizeTextForDB } from '../utils/text-processing.js';
import { eq, and, desc, sql } from "drizzle-orm";
import { calculatePaginationMeta } from "../utils/pagination.js";
import { updateUserLastActivity, performDailyCheckIn, getCheckInStatus, logUserActivity } from "../services/user.js";
import { invalidateCachePattern } from "../utils/cache.js";
import { invalidateExploreCache, invalidateUserBooksCache, invalidateUserProfileCache, withCache, CACHE_KEYS, CACHE_TTL } from "../services/cache.js";
import { getEnrichedUserSelect, setReferrerForNewUser } from "../services/user-controller.js";
import { filterObjectEntries, normalizeGender } from "../utils/parser.js";
import { imageUpload, uploadUserProfile } from "../services/image.js";
import { isValidUuid } from "../utils/uuid.js";
import { optionalAuth } from "../middleware/nextauth.js";

const router: RouterType = Router();

/**
 * GET /user
 * 
 * Retrieves the authenticated user's profile information.
 * Returns the complete user profile with liked and saved book counts, or null if no user exists.
 * 
 * @route GET /user
 * @description Get user profile with engagement counts
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} User profile response
 * @returns {boolean} success - Operation status
 * @returns {Object|null} data - User profile object or null
 * @returns {string} data.userId - User's unique identifier
 * @returns {string|null} data.name - User's display name
 * @returns {string|null} data.gender - User's gender
 * @returns {string|null} data.image - User's profile image URL
 * @returns {number} data.credits - User's available credits
 * @returns {number} data.totalLiked - Number of liked articles
 * @returns {number} data.totalSaved - Number of saved articles
 * @returns {number} data.totalReads - Number of read articles
 * @returns {string} data.lastActive - Last activity timestamp
 * @returns {string} data.createdAt - Account creation timestamp
 * @returns {string} data.updatedAt - Last update timestamp
 * 
 * @example
 * // Request
 * GET /user
 * 
 * // Response
 * {
 *   "user": {
 *     "userId": "user123",
 *     "name": "John Doe",
 *     "gender": "male",
 *     "image": "https://ik.imagekit.io/abc123/profile.jpg",
 *     "totalLiked": 15,
 *     "totalSaved": 8,
 *     "totalReads": 100,
 *     "lastActive": "2023-01-15T10:30:00.000Z",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.get("/", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    
    // If no userId (unauthenticated), return null user profile
    if (!userId) {
      res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
      return res.json({ user: null });
    }
    
    const cacheKey = CACHE_KEYS.USER_PROFILE(userId);
    
    // Fetch function for cache
    const fetchUserProfile = async () => {
      const userWithCounts = await dbRead
        .select(getEnrichedUserSelect())
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);

      const userData = userWithCounts.length > 0 ? userWithCounts[0] : null;

      if (!userData) {
        throw new Error("User profile not found");
      }

      // Format response to match frontend expectations
      const formattedUser: User = {
        id: userData.userId,
        username: userData.username,
        name: userData.name,
        email: userData.email,
        bio: userData.bio,
        image: userData.image,
        tier: userData.tier,
        credits: userData.credits,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        stats: {
          booksCount: userData.booksCount,
          readsCount: userData.readsCount,
          likedBooksCount: userData.likedBooksCount,
          savedBooksCount: userData.savedBooksCount,
          followersCount: userData.followersCount,
          likesReceived: userData.likesReceived,
          accountDaysOld: userData.accountDaysOld,
          emailVerified: userData.emailVerified,
          havePurchased: userData.havePurchased,
        },
      };

      return {
        user: formattedUser,
      };
    };
    
    // Use cache with fallback to database
    const result = await withCache(cacheKey, fetchUserProfile, CACHE_TTL.USER_PROFILE);
    
    // Add HTTP cache headers for CDN/edge caching
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=30');
    
    res.json(result);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    if (getErrorMessage(error) === "User profile not found") {
      return handleNotFoundError(res, "User profile not found");
    }
    handleApiError(res, "Failed to retrieve user profile", error);
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
 * @returns {Object} user - User profile object
 * @returns {string} user.id - User's unique identifier
 * @returns {string} user.username - User's username
 * @returns {string} user.name - User's display name
 * @returns {string|null} user.bio - User's bio
 * @returns {string|null} user.image - User's profile image URL
 * @returns {string} user.createdAt - Account creation timestamp
 * @returns {Object} user.stats - User statistics
 * @returns {number} user.stats.booksCount - Number of books created
 * @returns {number} user.stats.likesReceived - Total likes received on user's books
 * @returns {number} user.stats.followersCount - Number of followers
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
 *     "bio": "User bio",
 *     "image": "https://...",
 *     "createdAt": "2024-01-01T00:00:00Z",
 *     "stats": {
 *       "booksCount": 10,
 *       "likesReceived": 500,
 *       "followersCount": 100
 *     }
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
      const userWithCounts = await dbRead
        .select(getEnrichedUserSelect())
        .from(users)
        .where(whereCondition)
        .limit(1);

      const userData = userWithCounts.length > 0 ? userWithCounts[0] : null;

      if (!userData) {
        throw new Error("User profile not found");
      }

      // Format response to match frontend expectations
      const formattedUser: User = {
        id: userData.userId,
        username: userData.username,
        email: userData.email,
        name: userData.name,
        bio: userData.bio,
        image: userData.image,
        tier: userData.tier,
        credits: userData.credits,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        stats: {
          booksCount: userData.booksCount,
          readsCount: userData.readsCount,
          likedBooksCount: userData.likedBooksCount,
          savedBooksCount: userData.savedBooksCount,
          followersCount: userData.followersCount,
          likesReceived: userData.likesReceived,
          accountDaysOld: userData.accountDaysOld,
          emailVerified: userData.emailVerified,
          havePurchased: userData.havePurchased,
        },
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
 * POST /user
 * 
 * Creates a new user profile or fully replaces an existing user's profile.
 * Uses upsert operation to handle both creation and replacement scenarios.
 * 
 * @route POST /user
 * @description Create or replace user profile
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} User profile data
 * @body {string} [name] - User's display name
 * @body {string} [gender] - User's gender (e.g., "male", "female", "other")
 * @body {string} [image] - User's profile image URL
 * 
 * @returns {Object} Creation/replacement response
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Created/updated user profile
 * 
 * @example
 * // Request
 * POST /user
 * Body: {
 *   "name": "John Doe",
 *   "gender": "male",
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
 *     "userId": "user123",
 *     "name": "John Doe",
 *     "gender": "male",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, gender } = req.body;

    // Prepare user data for upsert (exclude timestamp fields from frontend)
    const userData: DBNewUser = {
      userId,
      name: name?.trim() || null,
      gender: normalizeGender(gender),
    };

    // Perform upsert operation (create or replace)
    const [row] = await dbWrite
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.userId,
        set: {
          name: userData.name,
          gender: userData.gender,
          lastActive: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    res.status(201).json({
      user: row,
    });

    // Invalidate user profile cache
    await invalidateUserProfileCache(userId);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to create/update user profile", error);
  }
});

/**
 * PUT /user
 * 
 * Partially updates the authenticated user's profile.
 * Only provided fields are updated, existing fields remain unchanged.
 * Supports multiple image upload methods: URL, base64, or multipart file.
 * 
 * @route PUT /user
 * @description Partially update user profile
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * @header Content-Type - multipart/form-data for file uploads or application/json
 * 
 * @body {Object} Partial user profile data (for JSON requests)
 * @body {string} [name] - User's display name (optional)
 * @body {string} [bio] - User's bio/description (optional)
 * @body {string} [gender] - User's gender (optional)
 * @body {string} [imageUrl] - User's profile image URL to upload (optional)
 * @body {File} [imageFile] - User's profile image file (multipart) (optional)
 * 
 * @returns {Object} Update response
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Updated user profile
 * @returns {string} uploadSource - Image upload method used
 * @returns {boolean} imageUploaded - Whether image was uploaded
 * @returns {boolean} oldImageQueuedForDeletion - Whether old image was queued for deletion
 * 
 * @example
 * // Request with file upload
 * PUT /user
 * Headers: Content-Type: multipart/form-data
 * Body: imageFile=<file>, name=John Doe
 * 
 * // Request with base64
 * PUT /user
 * Body: {
 *   "imageUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
 *   "name": "John Doe"
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
 *     "userId": "user123",
 *     "name": "John Doe",
 *     "gender": "male",
 *     "image": "https://ik.imagekit.io/abc123/user-user123-profile.jpg",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T12:00:00.000Z"
 *   },
 *   "imageUploaded": true,
 *   "uploadSource": "file",
 *   "oldImageQueuedForDeletion": false
 * }
 */
router.put("/", requireAuth, imageUpload.single('imageFile'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, bio, gender, imageUrl, isNewUser } = req.body;

    // Check if user exists
    const existingUser = await dbRead
      .select({ 
        userId: users.userId,
        name: users.name,
        bio: users.bio,
        gender: users.gender,
        image: users.image,
        imageId: users.imageId,
        isNewUser: users.isNewUser,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return handleNotFoundError(res, "User profile not found");
    }

    const user = existingUser[0];
    let newImageUrl: string | undefined;
    let newImageId: string | undefined;
    let oldImageIdQueued = false;

    // Handle image upload from different sources
    let imageSource: string | Buffer | { buffer: ArrayBuffer; originalname: string; mimetype: string } | undefined;

    if (req.file) {
      // Multipart file upload
      imageSource = {
        buffer: req.file.buffer as unknown as ArrayBuffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype
      };
    } else if (imageUrl) {
      // URL or base64 string upload
      imageSource = imageUrl;
    }

    // Process image upload if source is provided
    if (imageSource) {
      const uploadResult = await uploadUserProfile(imageSource, userId);

      if (uploadResult) {
        newImageUrl = uploadResult.url;
        newImageId = uploadResult.fileId;

        // Queue old image for deletion if it exists
        if (user.imageId) {
          await dbWrite
            .insert(deletedImages)
            .values({
              fileId: user.imageId,
              createdAt: new Date(),
            });
          oldImageIdQueued = true;
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "Failed to upload profile image"
        });
      }
    }

    // Only include non-null and non-empty values for update
    const updateData = filterObjectEntries({
      name: name?.trim() || null,
      bio: bio?.trim() || null,
      gender: normalizeGender(gender),
      image: newImageUrl || null,
      imageId: newImageId || null,
      isNewUser: isNewUser || false,
    });

    // Only proceed if there are actual updates
    if (Object.keys(updateData).length === 0) {
      return res.json({
        user,
        imageUploaded: !!newImageUrl,
        uploadSource: req.file ? 'file' : (imageUrl?.startsWith('data:') ? 'base64' : 'url'),
        oldImageQueuedForDeletion: oldImageIdQueued,
      });
    }

    // Perform partial update
    const [updatedUser] = await dbWrite
      .update(users)
      .set({
        ...updateData,
        updatedAt: new Date(),
      })
      .where(eq(users.userId, userId))
      .returning();

    res.json({
      user: updatedUser,
      imageUploaded: !!newImageUrl,
      uploadSource: req.file ? 'file' : (imageUrl?.startsWith('data:') ? 'base64' : 'url'),
      oldImageQueuedForDeletion: oldImageIdQueued,
    });

    // Invalidate user profile cache
    await invalidateUserProfileCache(userId);
  } catch (error) {
    handleApiError(res, "Failed to update user profile", error);
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
 * - userAuth, temporarySessions, sessionDataAssociations, userPageProgress
 * - userFollows, userCompletedBooks, userActivityLogs, transactions
 * - userNotifications, user_checkins, userLikes, userFavorites, userComments, userSessions
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
 * @returns {boolean} imageQueuedForDeletion - Whether profile image was queued for deletion
 * 
 * @example
 * // Request
 * DELETE /user
 * 
 * // Response
 * {
 *   "message": "User account deleted successfully",
 *   "imageQueuedForDeletion": true
 * }
 */
router.delete("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Get user information including imageId before deletion
    const [userToDelete] = await dbRead
      .select({ 
        userId: users.userId,
        imageId: users.imageId
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!userToDelete) {
      return handleNotFoundError(res, "User profile not found");
    }

    // Queue image for deletion if imageId exists
    if (userToDelete.imageId) {
      await dbWrite
        .insert(deletedImages)
        .values({
          fileId: userToDelete.imageId,
          createdAt: new Date(),
        });
    }

    // Delete user - cascade delete will handle all related tables automatically
    // Tables with cascade delete on userId:
    // - userAuth, userPageProgress
    // - userFollows, userCompletedBooks, userActivityLogs, transactions
    // - userNotifications, userCheckins, userLikes, userFavorites, userComments, userSessions
    await dbWrite
      .delete(users)
      .where(eq(users.userId, userId))
      .returning();

    // Invalidate all relevant user cache entries
    await Promise.all([
      invalidateCachePattern(`user:${userId}%`),
      invalidateUserProfileCache(userId),
    ]);

    res.json({
      message: "User account deleted successfully",
      imageQueuedForDeletion: !!userToDelete.imageId,
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
 * Uses upsert operation to handle both creation and idempotent likes.
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
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Created like record
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
 *   "success": true,
 *   "data": {
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

    // Invalidate caches when liking a book
    if (targetType === 'book') {
      await invalidateExploreCache(); // likesCount changed
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

    // Invalidate caches when unliking a book
    if (targetType === 'book') {
      await invalidateExploreCache(); // likesCount changed
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
 * @returns {boolean} success - Operation status
 * @returns {Array} data - Array of like records
 * 
 * @example
 * // Request
 * GET /user/likes?targetType=book&limit=10
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": [
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
 * Uses upsert operation to handle both creation and idempotent favorites.
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
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Created favorite record
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
 *   "success": true,
 *   "data": {
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
 * GET /user/favorites
 * 
 * Get all favorite books for the authenticated user.
 * 
 * @route GET /user/favorites
 * @description Get user favorites
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Favorites response
 * @returns {boolean} success - Operation status
 * @returns {Array} data - Array of favorite records
 * 
 * @example
 * // Request
 * GET /user/favorites?limit=10
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": [
 *     {
 *       "userId": "user123",
 *       "bookId": "book456",
 *       "createdAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/favorites", optionalAuth, async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) return res.json({ favorites: [] });

  try {
    const { limit = "50", offset = "0" } = req.query;

    const favorites = await dbRead
      .select()
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId))
      .orderBy(desc(userFavorites.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({ favorites, });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve favorites", error);
  }
});

/**
 * GET /user/collections
 * 
 * Get all collection names for the authenticated user's favorite books.
 * Returns a list of distinct collection names used to organize favorites.
 * 
 * @route GET /user/collections
 * @description Get user collection names
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Collections response
 * @returns {boolean} success - Operation status
 * @returns {Array} data - Array of collection names
 * 
 * @example
 * // Request
 * GET /user/collections
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": [
 *     "Thriller",
 *     "Mystery",
 *     "To Read Later",
 *     "Favorites"
 *   ]
 * }
 */
router.get("/collections", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    // Return empty response for unauthenticated users (handles auth timing race conditions)
    if (!userId) return res.json({ collections: [] });

    // Get distinct collection names for the user
    const collections = await dbRead
      .selectDistinct({ collection: userFavorites.collection })
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        sql`${userFavorites.collection} IS NOT NULL`
      ))
      .orderBy(userFavorites.collection);

    const collectionNames = collections.map((c: { collection: string | null }) => c.collection).filter((c: string | null): c is string => c !== null);

    res.json({
      collections: collectionNames,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve collections", error);
  }
});

// ===== USER COMMENTS ROUTES =====

/**
 * POST /user/comments
 * 
 * Create a comment on a book or reply to another comment.
 * 
 * @route POST /user/comments
 * @description Create comment
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Comment data
 * @body {string} bookId - ID of the book to comment on
 * @body {string} [parentCommentId] - ID of parent comment (for replies)
 * @body {string} content - Comment content
 * 
 * @returns {Object} Comment creation response
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Created comment record
 * 
 * @example
 * // Request
 * POST /user/comments
 * Body: {
 *   "bookId": "book456",
 *   "content": "This story is amazing!"
 * }
 * 
 * // Response
 * {
 *   "comment": {
 *     "id": "comment123",
 *     "userId": "user123",
 *     "bookId": "book456",
 *     "parentCommentId": null,
 *     "content": "This story is amazing!",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/comments", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId, parentCommentId, content } = req.body;

    if (!bookId) return handleValidationError(res, "Book ID is required");

    if (!content || content.trim().length === 0) {
      return handleValidationError(res, "Comment content is required");
    }

    // Sanitize content before storing
    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return handleValidationError(res, "Comment content is empty after sanitization");
    }

    // Prepare comment data
    const commentData: DBNewUserComment = {
      userId,
      bookId,
      parentCommentId: parentCommentId || null,
      content: cleanContent,
    };

    // Create the comment
    const [comment] = await dbWrite
      .insert(userComments)
      .values(commentData)
      .returning();

    res.status(201).json({ comment });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'commented',
      targetType: 'comment',
      targetId: comment.id,
      metadata: { bookId, parentCommentId },
    }, { req });

    // Invalidate explore cache if parent comment (commentsCount changes)
    if (!parentCommentId) {
      await invalidateExploreCache();
    }
  } catch (error) {
    handleApiError(res, "Failed to create comment", error);
  }
});

/**
 * PUT /user/comments/:commentId
 * 
 * Update an existing comment (only by the original author).
 * 
 * @route PUT /user/comments/:commentId
 * @description Update comment
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} commentId - ID of the comment to update
 * 
 * @body {Object} Comment update data
 * @body {string} content - Updated comment content
 * 
 * @returns {Object} Comment update response
 * @returns {boolean} success - Operation status
 * @returns {Object} comment - Updated comment record
 * 
 * @example
 * // Request
 * PUT /user/comments/comment123
 * Body: {
 *   "content": "Updated comment content"
 * }
 * 
 * // Response
 * {
 *   "comment": {
 *     "id": "comment123",
 *     "userId": "user123",
 *     "bookId": "book456",
 *     "parentCommentId": null,
 *     "content": "Updated comment content",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T12:00:00.000Z"
 *   }
 * }
 */
router.put("/comments/:commentId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { commentId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return handleValidationError(res, "Comment content is required");
    }

    // Sanitize content before storing
    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return handleValidationError(res, "Comment content is empty after sanitization");
    }

    // Check if comment exists and belongs to user
    const existingComment = await dbRead
      .select()
      .from(userComments)
      .where(eq(userComments.id, commentId as string))
      .limit(1);

    if (existingComment.length === 0) {
      return handleNotFoundError(res, "Comment not found");
    }

    if (existingComment[0].userId !== userId) {
      return handleForbiddenError(res, "You can only edit your own comments");
    }

    // Update comment
    const [comment] = await dbWrite
      .update(userComments)
      .set({
        content: cleanContent,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userComments.id, commentId as string),
        eq(userComments.userId, userId)
      ))
      .returning();

    res.json({
      comment,
    });
  } catch (error) {
    handleApiError(res, "Failed to update comment", error);
  }
});

/**
 * DELETE /user/comments/:commentId
 * 
 * Delete a comment (only by the original author).
 * 
 * @route DELETE /user/comments/:commentId
 * @description Delete comment
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @param {string} commentId - ID of the comment to delete
 * 
 * @returns {Object} Comment deletion response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /user/comments/comment123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Comment deleted successfully"
 * }
 */
router.delete("/comments/:commentId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { commentId } = req.params;

    // Check if comment exists and belongs to user
    const existingComment = await dbRead
      .select()
      .from(userComments)
      .where(eq(userComments.id, commentId as string))
      .limit(1);

    if (existingComment.length === 0) {
      return handleNotFoundError(res, "Comment not found");
    }

    if (existingComment[0].userId !== userId) {
      return handleForbiddenError(res, "You can only delete your own comments");
    }

    // Delete comment
    await dbWrite
      .delete(userComments)
      .where(and(
        eq(userComments.id, commentId as string),
        eq(userComments.userId, userId)
      ));

    // Invalidate explore cache if parent comment (commentsCount changes)
    if (!existingComment[0].parentCommentId) {
      await invalidateExploreCache();
    }

    res.json({
      message: "Comment deleted successfully",
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to delete comment", error);
  }
});

/**
 * GET /user/comments
 * 
 * Get all comments by the authenticated user, optionally filtered by book.
 * 
 * @route GET /user/comments
 * @description Get user comments
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} [bookId] - Filter by book ID
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Comments response
 * @returns {boolean} success - Operation status
 * @returns {Array} data - Array of comment records
 * 
 * @example
 * // Request
 * GET /user/comments?bookId=book456&limit=10
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": [
 *     {
 *       "id": "comment123",
 *       "userId": "user123",
 *       "bookId": "book456",
 *       "parentCommentId": null,
 *       "content": "This story is amazing!",
 *       "createdAt": "2023-01-01T00:00:00.000Z",
 *       "updatedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/comments", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId, limit = "50", offset = "0" } = req.query;

    // Build base query conditions
    const baseConditions = [eq(userComments.userId, userId)];
    
    // Add book filter if provided
    if (bookId) {
      baseConditions.push(eq(userComments.bookId, bookId as string));
    }

    const comments = await dbRead
      .select()
      .from(userComments)
      .where(and(...baseConditions))
      .orderBy(desc(userComments.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({
      comments,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve comments", error);
  }
});

// ===== USER FOLLOWS ROUTES =====

/**
 * POST /users/:id/follow
 * 
 * Follow a user. Uses upsert operation to handle both creation and idempotent follows.
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
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Created follow record
 * 
 * @example
 * // Request
 * POST /users/user456/follow
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "User followed successfully",
 *   "data": {
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
 *       "image": "https://example.com/avatar.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "total": 100,
 *     "totalPages": 10
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
        image: users.image,
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
 *       "image": "https://example.com/avatar2.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "total": 50,
 *     "totalPages": 5
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
        image: users.image,
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
 *       "image": "https://example.com/avatar.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "total": 100,
 *     "totalPages": 10
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
        image: users.image,
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
 *       "image": "https://example.com/avatar2.jpg",
 *       "followedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 10,
 *     "total": 50,
 *     "totalPages": 5
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
        image: users.image,
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
 * Returns check-in status, last check-in date, and total check-in history.
 * 
 * @route GET /user/checkin/status
 * @description Get daily check-in status
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Check-in status response
 * @returns {boolean} canCheckIn - Whether user can check-in today
 * @returns {string|null} lastCheckInDate - Last check-in date (YYYY-MM-DD) or null
 * @returns {number} totalCheckIns - Total number of check-ins
 * @returns {number} totalCreditsClaimed - Total credits claimed from check-ins
 * @returns {Array} recentCheckIns - Recent check-in history (last 30 days)
 * 
 * @example
 * // Request
 * GET /user/checkin/status
 * 
 * // Response (can check-in)
 * {
 *   "canCheckIn": true,
 *   "lastCheckInDate": "2026-05-03",
 *   "totalCheckIns": 5,
 *   "totalCreditsClaimed": 150,
 *   "recentCheckIns": [
 *     {
 *       "checkInDate": "2026-05-03",
 *       "creditsClaimed": 30,
 *       "createdAt": "2026-05-03T00:00:00.000Z"
 *     }
 *   ]
 * }
 * 
 * // Response (already checked in)
 * {
 *   "canCheckIn": false,
 *   "lastCheckInDate": "2026-05-04",
 *   "totalCheckIns": 6,
 *   "totalCreditsClaimed": 180,
 *   "recentCheckIns": [
 *     {
 *       "checkInDate": "2026-05-04",
 *       "creditsClaimed": 30,
 *       "createdAt": "2026-05-04T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/checkin/status", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    
    // Return null response for unauthenticated users (handles auth timing race conditions)
    if (!userId) {
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
 * Each check-in awards 5 free credits (configurable via DAILY_CHECKIN_BONUS).
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
router.post("/checkin", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    
    const result = await performDailyCheckIn(userId);
    
    if (result.success) {
      console.log(`[checkin] ✅ User ${userId} checked in and received ${result.creditsAwarded} credits`);
      res.status(201).json(result);
    } else {
      console.log(`[checkin] ❌ User ${userId} failed to check in`);
      res.status(400).json(result);
    }

    // Invalidate user cache and update last activity
    await Promise.all([
      invalidateUserProfileCache(userId),
      updateUserLastActivity(userId)
    ]);
  } catch (error) {
    handleApiError(res, "Failed to perform daily check-in", error);
  }
});

/**
 * POST /user/referrer
 * 
 * Sets the referrer for the authenticated user by username.
 * Only allowed for new users (isNewUser = true).
 * After setting referrer, isNewUser is set to false to prevent multiple updates.
 * 
 * @route POST /user/referrer
 * @description Set referrer by username
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Referrer data
 * @body {string} username - Username of the referrer
 * 
 * @returns {Object} Referrer set response
 * @returns {boolean} success - Operation status
 * @returns {string} referrerId - ID of the referrer user
 * @returns {string} message - Status message
 * 
 * @example
 * // Request
 * POST /user/referrer
 * Body: {
 *   "username": "john-doe"
 * }
 * 
 * // Response (success)
 * {
 *   "success": true,
 *   "referrerId": "user456",
 *   "message": "Referrer set successfully"
 * }
 * 
 * // Response (not new user)
 * {
 *   "success": false,
 *   "error": "Referrer can only be set for new users"
 * }
 */
router.post("/referrer", requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { username } = req.body;

  if (!username || typeof username !== 'string') {
    return handleValidationError(res, "Username is required");
  }

  await setReferrerForNewUser(req, res, userId, username);
});

/**
 * GET /user/activity-logs
 * 
 * Get activity logs for the authenticated user with optional filtering.
 * 
 * @route GET /user/activity-logs
 * @description Get user activity logs
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} [activityType] - Filter by activity type (e.g., "book_created", "liked", "commented")
 * @query {string} [targetType] - Filter by target type (e.g., "book", "comment", "user")
 * @query {number} [limit] - Maximum number of results (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * 
 * @returns {Object} Activity logs response
 * @returns {Array} logs - Array of activity log records
 * 
 * @example
 * // Request
 * GET /user/activity-logs?activityType=liked&limit=10
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
 *       "createdAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/activity-logs", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.json({ logs: [] });
    }

    const { activityType, targetType, limit = "50", offset = "0" } = req.query;

    // Build base query conditions
    const baseConditions = [eq(userActivityLogs.userId, userId)];
    
    // Add activity type filter if provided
    if (activityType) {
      baseConditions.push(eq(userActivityLogs.activityType, activityType as UserActivityType));
    }
    
    // Add target type filter if provided
    if (targetType) {
      baseConditions.push(eq(userActivityLogs.targetType, targetType as string));
    }

    const logs = await dbRead
      .select()
      .from(userActivityLogs)
      .where(and(...baseConditions))
      .orderBy(desc(userActivityLogs.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({
      logs,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve activity logs", error);
  }
});

export default router;
