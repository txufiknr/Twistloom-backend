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
 * - Social interactions (likes, favorites, comments)
 * 
 * Endpoints:
 * - GET /user - Get user profile
 * - POST /user - Create or fully replace user profile
 * - PUT /user - Partially update user profile
 * - DELETE /user - Delete user profile and all associated data
 * - POST /user/likes - Like a target item
 * - DELETE /user/likes - Unlike a target item
 * - GET /user/likes - Get user likes
 * - POST /user/favorites - Add book to favorites
 * - DELETE /user/favorites - Remove book from favorites
 * - GET /user/favorites - Get user favorites
 * - POST /user/comments - Create comment
 * - PUT /user/comments/:commentId - Update comment
 * - DELETE /user/comments/:commentId - Delete comment
 * - GET /user/comments - Get user comments
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { requireClientId } from "../middleware/auth.js";
import { users, userDevices, userSessions, userLikes, userFavorites, userComments, deletedImages } from "../db/schema.js";
import type { DBNewUser, DBNewUserLike, DBNewUserFavorite, DBNewUserComment } from "../types/schema.js";
import type { LikeTargetType } from "../types/user.js";
import { getErrorMessage, handleApiError, handleNotFoundError } from "../utils/error.js";
import { eq, and, desc } from "drizzle-orm";
import { updateUserLastActivity } from "../services/user.js";
import { invalidateCachePattern } from "../utils/cache.js";
import { invalidateExploreCache, invalidateUserBooksCache, invalidateUserProfileCache, withCache, CACHE_KEYS, CACHE_TTL } from "../services/cache.js";
import { getEnrichedUserSelect } from "../services/user-controller.js";
import { filterObjectEntries, normalizeGender } from "../utils/parser.js";
import { imageUpload, uploadUserProfile } from "../services/image.js";

const router = Router();

/**
 * GET /user
 * 
 * Retrieves the authenticated user's profile information.
 * Returns the complete user profile with liked and saved book counts, or null if no user exists.
 * 
 * @route GET /user
 * @description Get user profile with engagement counts
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
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
router.get("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
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

      return {
        success: true,
        data: userData,
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
 * POST /user
 * 
 * Creates a new user profile or fully replaces an existing user's profile.
 * Uses upsert operation to handle both creation and replacement scenarios.
 * 
 * @route POST /user
 * @description Create or replace user profile
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.post("/", requireClientId, async (req: Request, res: Response) => {
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
      success: true,
      message: "User created successfully",
      data: row,
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * @header Content-Type - multipart/form-data for file uploads or application/json
 * 
 * @body {Object} Partial user profile data (for JSON requests)
 * @body {string} [name] - User's display name (optional)
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
 * Headers: X-Client-Id: user123, Content-Type: multipart/form-data
 * Body: imageFile=<file>, name=John Doe
 * 
 * // Request with base64
 * PUT /user
 * Headers: X-Client-Id: user123
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
router.put("/", requireClientId, imageUpload.single('imageFile'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, gender, imageUrl } = req.body;

    // Check if user exists
    const existingUser = await dbRead
      .select({ 
        userId: users.userId,
        name: users.name,
        gender: users.gender,
        image: users.image,
        imageId: users.imageId,
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
      gender: normalizeGender(gender),
      image: newImageUrl || null,
      imageId: newImageId || null,
    });

    // Only proceed if there are actual updates
    if (Object.keys(updateData).length === 0) {
      return res.json({
        success: true,
        data: user,
        imageUploaded: !!newImageUrl,
        uploadSource: req.file ? 'file' : (imageUrl?.startsWith('data:') ? 'base64' : 'url'),
        oldImageQueuedForDeletion: oldImageIdQueued,
      });
    }

    // Perform partial update
    const result = await dbWrite
      .update(users)
      .set({
        ...updateData,
        updatedAt: new Date(),
      })
      .where(eq(users.userId, userId))
      .returning();

    res.json({
      success: true,
      data: result[0],
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
 * @route DELETE /user
 * @description Delete user profile and all associated data
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Deletion response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * @returns {Object} data - Summary of deleted records
 * 
 * @example
 * // Request
 * DELETE /user
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "User account deleted successfully",
 *   "data": {
 *     "deletedRecords": {
 *       "userProfile": 1,
 *       "userFavorites": 8,
 *       "userLikes": 15,
 *       "userSessions": 42,
 *       "userDevices": 2,
 *       "userComments": 5
 *     },
 *     "imageQueuedForDeletion": true
 *   }
 * }
 */
router.delete("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    // Get user information including imageId before deletion
    const existingUser = await dbRead
      .select({ 
        userId: users.userId,
        imageId: users.imageId
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return handleNotFoundError(res, "User profile not found");
    }

    const userToDelete = existingUser[0];

    // Queue image for deletion if imageId exists
    if (userToDelete.imageId) {
      await dbWrite
        .insert(deletedImages)
        .values({
          fileId: userToDelete.imageId,
          createdAt: new Date(),
        });
    }

    // Execute all delete operations in parallel for efficiency
    const [
      deletedProfile,
      deletedFavorites,
      deletedLikes,
      deletedSessions,
      deletedDevices,
      deletedComments
    ] = await Promise.all([
      dbWrite.delete(users).where(eq(users.userId, userId)).returning(),
      dbWrite.delete(userFavorites).where(eq(userFavorites.userId, userId)).returning(),
      dbWrite.delete(userLikes).where(eq(userLikes.userId, userId)).returning(),
      dbWrite.delete(userSessions).where(eq(userSessions.userId, userId)).returning(),
      dbWrite.delete(userDevices).where(eq(userDevices.userId, userId)).returning(),
      dbWrite.delete(userComments).where(eq(userComments.userId, userId)).returning(),
    ]);

    // Invalidate all relevant user cache entries
    await Promise.all([
      invalidateCachePattern(`user:${userId}%`),
    ]);

    res.json({
      success: true,
      message: "User account deleted successfully",
      data: {
        deletedRecords: {
          userProfile: deletedProfile.length,
          userFavorites: deletedFavorites.length,
          userLikes: deletedLikes.length,
          userSessions: deletedSessions.length,
          userDevices: deletedDevices.length,
          userComments: deletedComments.length,
        },
        imageQueuedForDeletion: !!userToDelete.imageId,
      },
    });

    // Invalidate user profile cache
    await invalidateUserProfileCache(userId);

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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.post("/likes", requireClientId, async (req: Request, res: Response) => {
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
    const result = row ? [row] : await dbRead
      .select()
      .from(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, targetType),
        eq(userLikes.targetId, targetId)
      ))
      .limit(1);

    res.status(201).json({
      success: true,
      message: "Like created successfully",
      data: result[0] || null,
    });

    // Invalidate caches when liking a book
    if (targetType === 'book') {
      await invalidateExploreCache(); // likesCount changed
      await invalidateUserBooksCache(userId); // isLiked flag changed
      await invalidateUserProfileCache(userId); // likedBooksCount changed
    }

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Like removed successfully"
 * }
 */
router.delete("/likes", requireClientId, async (req: Request, res: Response) => {
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
      success: true,
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.get("/likes", requireClientId, async (req: Request, res: Response) => {
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
      success: true,
      data: likes,
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.post("/favorites", requireClientId, async (req: Request, res: Response) => {
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
    const result = row ? [row] : await dbRead
      .select()
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, bookId)
      ))
      .limit(1);

    res.status(201).json({
      success: true,
      message: "Book added to favorites successfully",
      data: result[0],
    });

    // Invalidate user profile cache (savedBooksCount changed)
    await invalidateUserProfileCache(userId);

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Book removed from favorites successfully"
 * }
 */
router.delete("/favorites", requireClientId, async (req: Request, res: Response) => {
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
      success: true,
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.get("/favorites", requireClientId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { limit = "50", offset = "0" } = req.query;

    const favorites = await dbRead
      .select()
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId))
      .orderBy(desc(userFavorites.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({
      success: true,
      data: favorites,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve favorites", error);
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
 * Body: {
 *   "bookId": "book456",
 *   "content": "This story is amazing!"
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
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
router.post("/comments", requireClientId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId, parentCommentId, content } = req.body;

    if (!bookId) {
      return res.status(400).json({
        success: false,
        error: "Book ID is required",
      });
    }

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Comment content is required",
      });
    }

    // Prepare comment data
    const commentData: DBNewUserComment = {
      userId,
      bookId,
      parentCommentId: parentCommentId || null,
      content: content.trim(),
    };

    // Create the comment
    const [row] = await dbWrite
      .insert(userComments)
      .values(commentData)
      .returning();

    res.status(201).json({
      success: true,
      message: "Comment created successfully",
      data: row,
    });

    // Invalidate explore cache if parent comment (commentsCount changes)
    if (!parentCommentId) {
      await invalidateExploreCache();
    }

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * @returns {Object} data - Updated comment record
 * 
 * @example
 * // Request
 * PUT /user/comments/comment123
 * Headers: X-Client-Id: user123
 * Body: {
 *   "content": "Updated comment content"
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
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
router.put("/comments/:commentId", requireClientId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { commentId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "Comment content is required",
      });
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
      return res.status(403).json({
        success: false,
        error: "You can only edit your own comments",
      });
    }

    // Update comment
    const result = await dbWrite
      .update(userComments)
      .set({
        content: content.trim(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(userComments.id, commentId as string),
        eq(userComments.userId, userId)
      ))
      .returning();

    res.json({
      success: true,
      data: result[0],
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Comment deleted successfully"
 * }
 */
router.delete("/comments/:commentId", requireClientId, async (req: Request, res: Response) => {
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
      return res.status(403).json({
        success: false,
        error: "You can only delete your own comments",
      });
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
      success: true,
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
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
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
 * Headers: X-Client-Id: user123
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
router.get("/comments", requireClientId, async (req: Request, res: Response) => {
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
      success: true,
      data: comments,
    });

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
  } catch (error) {
    handleApiError(res, "Failed to retrieve comments", error);
  }
});

export default router;
