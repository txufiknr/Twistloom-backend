/**
 * @overview User Routes Module
 * 
 * Provides endpoints for managing user profile information and basic user data.
 * Implements CRUD operations for user profile storage and retrieval.
 * 
 * Architecture Features:
 * - User profile management
 * - Full replacement and partial update operations
 * - Conflict resolution with upsert patterns
 * - Consistent error handling and validation
 * - Analytics-friendly user tracking
 * 
 * Endpoints:
 * - GET /user - Get user profile
 * - POST /user - Create or fully replace user profile
 * - PUT /user - Partially update user profile
 * - DELETE /user - Delete user profile
 * - POST /user/reset - Reset all user data
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { requireClientId } from "../middleware/auth.js";
import { users, userDevices } from "../db/schema.js";
import type { NewUser } from "../types/schema.js";
import { handleApiError, handleNotFoundError } from "../utils/error.js";
import { eq, sql } from "drizzle-orm";
// import { invalidateCacheKey, invalidateCachePattern } from "../utils/cache.js";
import { filterObjectEntries, normalizeGender } from "../utils/parser.js";

const router = Router();

/**
 * GET /user
 * 
 * Retrieves the authenticated user's profile information.
 * Returns the complete user profile with liked and saved feed counts, or null if no user exists.
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
 * @returns {number} data.totalLiked - Number of liked articles
 * @returns {number} data.totalSaved - Number of saved articles
 * @returns {number} data.totalReads - Number of read articles
 * @returns {number} data.totalNotInterested - Number of articles marked as not interested
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
 *     "totalLiked": 15,
 *     "totalSaved": 8,
 *     "totalReads": 100,
 *     "totalNotInterested": 5,
 *     "lastActive": "2023-01-15T10:30:00.000Z",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.get("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const { userId } = req;

    // Single query with subqueries for counts
    const userWithCounts = await dbRead
      .select({
        userId: users.userId,
        name: users.name,
        gender: users.gender,
        lastActive: users.lastActive,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        totalLiked: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${userLikes}
          WHERE ${userLikes.userId} = ${userId}
        )`.as('totalLiked'),
        totalSaved: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${userFavorites}
          WHERE ${userFavorites.userId} = ${userId}
        )`.as('totalSaved'),
        totalReads: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${userHistory}
          WHERE ${userHistory.userId} = ${userId}
        )`.as('totalReads'),
        totalNotInterested: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${userNotInterested}
          WHERE ${userNotInterested.userId} = ${userId}
        )`.as('totalNotInterested'),
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    const userData = userWithCounts.length > 0 ? userWithCounts[0] : null;

    if (!userData) {
      return handleNotFoundError(res, "User profile not found");
    }

    res.json({
      success: true,
      data: userData,
    });
  } catch (error) {
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
    const { userId } = req;
    const { name, gender } = req.body;

    // Prepare user data for upsert (exclude timestamp fields from frontend)
    const userData: NewUser = {
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
  } catch (error) {
    handleApiError(res, "Failed to create/update user profile", error);
  }
});

/**
 * PUT /user
 * 
 * Partially updates the authenticated user's profile.
 * Only provided fields are updated, existing fields remain unchanged.
 * 
 * @route PUT /user
 * @description Partially update user profile
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @body {Object} Partial user profile data
 * @body {string} [name] - User's display name (optional)
 * @body {string} [gender] - User's gender (optional)
 * 
 * @returns {Object} Update response
 * @returns {boolean} success - Operation status
 * @returns {Object} data - Updated user profile
 * 
 * @example
 * // Request
 * PUT /user
 * Headers: X-Client-Id: user123
 * Body: {
 *   "name": "Jane Doe"
 * }
 * 
 * // Response
 * {
 *   "success": true,
 *   "data": {
 *     "userId": "user123",
 *     "name": "Jane Doe",
 *     "gender": "male",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T12:00:00.000Z"
 *   }
 * }
 */
router.put("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const { userId } = req;
    const { name, gender } = req.body;

    // Check if user exists
    const existingUser = await dbRead
      .select()
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return handleNotFoundError(res, "User profile not found");
    }

    // Only include non-null and non-empty values for update
    const updateData = filterObjectEntries({
      name: name?.trim() || null,
      gender: normalizeGender(gender),
    });

    // Only proceed if there are actual updates
    if (Object.keys(updateData).length === 0) {
      return res.json({
        success: true,
        data: existingUser[0],
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
    });
  } catch (error) {
    handleApiError(res, "Failed to update user profile", error);
  }
});

/**
 * DELETE /user
 * 
 * Deletes the authenticated user's profile from the system.
 * This operation is irreversible and will remove all user data.
 * 
 * @route DELETE /user
 * @description Delete user profile
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Deletion response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * DELETE /user
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "User profile deleted successfully"
 * }
 */
router.delete("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const { userId } = req;

    // Check if user exists before deletion
    const existingUser = await dbRead
      .select()
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return handleNotFoundError(res, "User profile not found");
    }

    // Delete user profile
    await dbWrite.delete(users).where(eq(users.userId, userId));

    res.json({
      success: true,
      message: "User profile deleted successfully",
    });
  } catch (error) {
    handleApiError(res, "Failed to delete user profile", error);
  }
});

/**
 * POST /user/reset
 * 
 * Resets all user data by clearing all user-related tables for the authenticated user.
 * This operation is irreversible and will remove all user preferences, favorites, likes,
 * history, settings, devices, and streaks data.
 * 
 * @route POST /user/reset
 * @description Reset all user data
 * @access Private (requires X-Client-Id header)
 * 
 * @header X-Client-Id - User identification header (required)
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Reset response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * @returns {Object} data - Summary of cleared data
 * 
 * @example
 * // Request
 * POST /user/reset
 * Headers: X-Client-Id: user123
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "User data reset successfully",
 *   "data": {
 *     "deletedRecords": {
 *       "userPreferences": 1,
 *       "userFavorites": 8,
 *       "userLikes": 15,
 *       "userHistory": 42,
 *       "userSettings": 1,
 *       "userDevices": 2,
 *       "userStreaks": 1
 *     }
 *   }
 * }
 */
router.post("/reset", requireClientId, async (req: Request, res: Response) => {
  try {
    const { userId } = req;

    // Check if user exists before reset
    const existingUser = await dbRead
      .select()
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (existingUser.length === 0) {
      return handleNotFoundError(res, "User profile not found");
    }

    // Execute all delete operations in parallel for efficiency
    const [
      deletedPreferences,
      deletedFavorites,
      deletedLikes,
      deletedHistory,
      deletedSettings,
      deletedDevices,
      deletedStreaks
    ] = await Promise.all([
      dbWrite.delete(userPreferences).where(eq(userPreferences.userId, userId)).returning(),
      dbWrite.delete(userFavorites).where(eq(userFavorites.userId, userId)).returning(),
      dbWrite.delete(userLikes).where(eq(userLikes.userId, userId)).returning(),
      dbWrite.delete(userHistory).where(eq(userHistory.userId, userId)).returning(),
      dbWrite.delete(userSettings).where(eq(userSettings.userId, userId)).returning(),
      dbWrite.delete(userDevices).where(eq(userDevices.userId, userId)).returning(),
      dbWrite.delete(userStreaks).where(eq(userStreaks.userId, userId)).returning(),
    ]);

    // Invalidate all relevant cache entries
    await Promise.all([
      // User-specific feed caches
      invalidateCacheKey(`feed:personalized:${userId}`),
      invalidateCacheKey(`feed:liked:${userId}`),
      invalidateCacheKey(`feed:saved:${userId}`),
      invalidateCacheKey(`feed:history:${userId}`),

      // Invalidate all collection caches
      invalidateCachePattern(`feed:saved:${userId}:collection:%`),
      
      // User-specific latest feed caches (all topics and general)
      invalidateCachePattern(`feed:latest:%:${userId}`),
    ]);

    res.json({
      success: true,
      message: "User data reset successfully",
      data: {
        deletedRecords: {
          userPreferences: deletedPreferences.length,
          userFavorites: deletedFavorites.length,
          userLikes: deletedLikes.length,
          userHistory: deletedHistory.length,
          userSettings: deletedSettings.length,
          userDevices: deletedDevices.length,
          userStreaks: deletedStreaks.length,
        },
      },
    });
  } catch (error) {
    handleApiError(res, "Failed to reset user data", error);
  }
});

export default router;
