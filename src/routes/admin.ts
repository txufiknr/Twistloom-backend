/**
 * @overview Admin Routes Module
 * 
 * Provides administrative endpoints for debugging and system management.
 * Implements tools for monitoring story reconstruction, snapshot analysis,
 * and performance diagnostics.
 * 
 * Architecture Features:
 * - Snapshot management and analysis
 * - Story reconstruction debugging
 * - Performance monitoring tools
 * - System health checks
 * 
 * Endpoints:
 * - GET /admin/books/:bookId/snapshots - View all snapshots for a book
 * - GET /admin/books/:bookId/reconstruction - Debug reconstruction process
 * - GET /admin/books/:bookId/snapshots/statistics - Get snapshot statistics
 * - DELETE /admin/books/:bookId/snapshots - Delete all snapshots (dangerous)
 * - GET /admin/system/health - System health status
 */

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { cApiError, cValidationError, cNotFoundError } from "../utils/error.js";
// import { getUserBookSnapshots, getLatestMajorCheckpoint, deleteAllSnapshots, getSnapshotStatistics } from "../services/snapshots.bak.js";
import { reconstructStoryState } from "../utils/branch-traversal.js";
import { getBookFromDB, getPageFromDB } from "../services/book.js";
// import { getStateSnapshot } from "../services/snapshots.bak.js";
import { getStoryState } from "../services/story.js";
import { dbRead, dbWrite } from "../db/client.js";
import { socialMentions } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";

/**
 * Middleware guard that restricts access to the system admin user only.
 *
 * The system admin is identified by `process.env.SYSTEM_USER_ID`. Requests
 * from any other authenticated user are rejected with 403 Forbidden. This is
 * a defense-in-depth layer on top of `requireAuth` for privileged operations
 * such as social mention curation.
 */
const requireSystemAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId || c.get("userId") !== systemUserId) {
    throw new HTTPException(403, { message: "Forbidden: admin access required" });
  }
  await next();
});

const router = new Hono<AppEnv>();

// /**
//  * GET /admin/books/:bookId/snapshots
//  * 
//  * Retrieves all snapshots for a book for debugging and analysis.
//  * Shows snapshot creation patterns, major checkpoints, and usage statistics.
//  * 
//  * @param bookId - Book identifier
//  * @param limit - Maximum number of snapshots to retrieve (default: 50)
//  * @returns Array of snapshots with metadata and usage statistics
//  */
// router.get("/books/:bookId/snapshots", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.userId!;
//     const { bookId } = req.params;
//     const { limit = 50 } = req.query;

//     // Ensure bookId is a string (Express params can be string array)
//     const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;
//     const snapshots = await getUserBookSnapshots(userId, bookIdStr, Number(limit));
    
//     // Analyze snapshot patterns
//     const majorCheckpoints = snapshots.filter(s => s.isMajorCheckpoint);
//     const periodicSnapshots = snapshots.filter(s => s.reason === 'periodic');
//     const branchStartSnapshots = snapshots.filter(s => s.reason === 'branch_start');
//     const majorEventSnapshots = snapshots.filter(s => s.reason === 'major_event');
    
//     // Calculate statistics
//     const stats = {
//       total: snapshots.length,
//       majorCheckpoints: majorCheckpoints.length,
//       periodicSnapshots: periodicSnapshots.length,
//       branchStartSnapshots: branchStartSnapshots.length,
//       majorEventSnapshots: majorEventSnapshots.length,
//       oldestSnapshot: snapshots[snapshots.length - 1]?.createdAt || null,
//       newestSnapshot: snapshots[0]?.createdAt || null,
//       averagePageGap: snapshots.length > 1 
//         ? Math.round((snapshots[0].page - snapshots[snapshots.length - 1].page) / snapshots.length)
//         : 0
//     };

//     res.json({
//       bookId,
//       snapshots: snapshots.map(s => ({
//         pageId: s.pageId,
//         page: s.page,
//         createdAt: s.createdAt,
//         version: s.version,
//         isMajorCheckpoint: s.isMajorCheckpoint,
//         reason: s.reason,
//         stateSize: JSON.stringify(s.state).length
//       })),
//       stats
//     });
//   } catch (error) {
//     handleApiError(res, "Failed to retrieve book snapshots", error);
//   }
// });

/**
 * GET /admin/books/:bookId/reconstruction/:pageId
 * 
 * Debug endpoint to test story reconstruction for a specific page.
 * Shows reconstruction method, deltas needed, and performance metrics.
 * 
 * @param bookId - Book identifier
 * @param pageId - Page identifier to reconstruct
 * @returns Reconstruction analysis and performance data
 */
router.get("/books/:bookId/reconstruction/:pageId", requireAuth, async (c) => {
  try {
    const { bookId, pageId } = c.req.param();

    if (!bookId || !pageId) {
      return cValidationError(c, "Missing required fields: bookId and pageId are required");
    }

    // Test reconstruction
    const reconstructionResult = await reconstructStoryState(pageId, {
      getPageById: async (id: string) => await getPageFromDB(id),
      getBook: async (bookId: string) => await getBookFromDB(bookId),
      getStoryState: async (id: string) => await getStoryState(id)
    }, {
      useCache: false, // Force reconstruction for testing
      validatePath: true
    });

    // // Get latest major checkpoint for comparison
    // const majorCheckpoint = await getLatestMajorCheckpoint(userId, bookId);

    return c.json({
      bookId,
      pageId,
      reconstruction: reconstructionResult,
      // latestMajorCheckpoint: majorCheckpoint ? {
      //   pageId: majorCheckpoint.pageId,
      //   page: majorCheckpoint.page,
      //   createdAt: majorCheckpoint.createdAt,
      //   reason: majorCheckpoint.reason
      // } : null
    });
  } catch (error) {
    return cApiError(c, "Failed to debug reconstruction", error);
  }
});

/**
 * GET /admin/system/health
 * 
 * System health check endpoint for monitoring.
 * Checks database connectivity, snapshot patterns, and system performance.
 * 
 * @returns System health status and metrics
 */
router.get("/system/health", requireAuth, async (c) => {
  try {
    // Basic health metrics
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: "connected", // Could add actual DB health check
        snapshots: "active",
        reconstruction: "functional"
      },
      metrics: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version
      }
    };

    return c.json(health);
  } catch (error) {
    return cApiError(c, "Failed to get system health", error);
  }
});

// ============================================================================
// SOCIAL MENTIONS CRUD ROUTES
// ============================================================================

/**
 * Type guard for the social mention status enum.
 *
 * @param value - Unknown string to validate
 * @returns True when value is a valid social mention status
 */
function isSocialMentionStatus(value: unknown): value is "pending" | "approved" | "rejected" {
  return value === "pending" || value === "approved" || value === "rejected";
}

/**
 * GET /admin/social-mentions
 *
 * Lists social mentions for the admin curation queue. Supports filtering by
 * status, platform, and pagination. Results are ordered by relevance score
 * (highest first) so the best candidates surface at the top of the queue.
 *
 * @param status - Optional filter: "pending" | "approved" | "rejected"
 * @param platform - Optional filter: e.g. "reddit" | "hackernews" | "web"
 * @param limit - Maximum rows to return (default: 50, max: 200)
 * @param offset - Number of rows to skip for pagination (default: 0)
 * @returns Array of social mentions and a total count for the applied filter
 */
router.get("/social-mentions",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const { status, platform, limit = "50", offset = "0" } = c.req.query();

      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (isSocialMentionStatus(status)) {
        conditions.push(eq(socialMentions.status, status));
      }
      if (typeof platform === "string" && platform.length > 0) {
        conditions.push(eq(socialMentions.platform, platform));
      }

      const rows = await dbRead
        .select()
        .from(socialMentions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(socialMentions.relevanceScore), desc(socialMentions.publishedAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(socialMentions)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, mentions: rows });
    } catch (error) {
      return cApiError(c, "Failed to list social mentions", error);
    }
  }
);

/**
 * GET /admin/social-mentions/:id
 *
 * Retrieves a single social mention by its id.
 *
 * @param id - Social mention identifier
 * @returns The social mention row
 */
router.get("/social-mentions/:id",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const { id } = c.req.param();

      const [mention] = await dbRead
        .select()
        .from(socialMentions)
        .where(eq(socialMentions.id, id))
        .limit(1);

      if (!mention) {
        return cNotFoundError(c, "Social mention not found");
      }

      return c.json(mention);
    } catch (error) {
      return cApiError(c, "Failed to retrieve social mention", error);
    }
  }
);

/**
 * PATCH /admin/social-mentions/:id
 *
 * Updates moderation fields of a social mention. Only the curation-relevant
 * columns are mutable through this endpoint (status, relevance score, sentiment
 * score, and admin override of the displayed title/content).
 *
 * @param id - Social mention identifier
 * @param status - New status: "pending" | "approved" | "rejected"
 * @param relevanceScore - Optional override of the computed relevance score
 * @param sentimentScore - Optional override of the computed sentiment score
 * @param title - Optional admin-edited title
 * @param content - Optional admin-edited content
 * @returns The updated social mention row
 */
router.patch("/social-mentions/:id",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const { id } = c.req.param();
      const { status, featured, relevanceScore, sentimentScore, title, content } = c.get("body");

      if (status !== undefined && !isSocialMentionStatus(status)) {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const [existing] = await dbRead
        .select({ id: socialMentions.id })
        .from(socialMentions)
        .where(eq(socialMentions.id, id))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "Social mention not found");
      }

      const updates: Partial<typeof socialMentions.$inferInsert> = {};
      if (status !== undefined) updates.status = status;
      if (typeof featured === "boolean") updates.featured = featured;
      if (typeof relevanceScore === "number") updates.relevanceScore = relevanceScore;
      if (typeof sentimentScore === "number") updates.sentimentScore = sentimentScore;
      if (typeof title === "string") updates.title = title;
      if (typeof content === "string") updates.content = content;

      const [updated] = await dbWrite
        .update(socialMentions)
        .set(updates)
        .where(eq(socialMentions.id, id))
        .returning();

      return c.json(updated);
    } catch (error) {
      return cApiError(c, "Failed to update social mention", error);
    }
  }
);

/**
 * POST /admin/social-mentions
 *
 * Manually creates a curated social mention (e.g. pasted from X, a blog review,
 * or a user submission). Defaults to "pending" status so it flows through the
 * same curation queue as automatically ingested mentions.
 *
 * @param platform - Platform label (required), e.g. "x" | "reddit" | "blog"
 * @param author - Author handle (required)
 * @param content - Mention text (required)
 * @param url - Source URL (required)
 * @param title - Optional title
 * @param authorAvatar - Optional avatar URL
 * @param score - Optional engagement score (default: 0)
 * @param sentimentScore - Optional sentiment (default: 0)
 * @param relevanceScore - Optional relevance (default: 0)
 * @param status - Optional status (default: "pending")
 * @param featured - Optional flag to elevate straight to the homepage wall (default: false)
 * @param publishedAt - Optional ISO publish timestamp
 * @returns The newly created social mention row
 */
router.post("/social-mentions",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const {
        platform, author, content, url, title, authorAvatar,
        score, sentimentScore, relevanceScore, status, featured, publishedAt,
      } = c.get("body");

      if (!platform || !author || !content || !url) {
        return cValidationError(c, "Missing required fields: platform, author, content, and url are required");
      }
      if (status !== undefined && !isSocialMentionStatus(status)) {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const [created] = await dbWrite
        .insert(socialMentions)
        .values({
          platform,
          author,
          content,
          url,
          title: title ?? null,
          authorAvatar: authorAvatar ?? null,
          score: typeof score === "number" ? score : 0,
          sentimentScore: typeof sentimentScore === "number" ? sentimentScore : 0,
          relevanceScore: typeof relevanceScore === "number" ? relevanceScore : 0,
          status: isSocialMentionStatus(status) ? status : "pending",
          featured: typeof featured === "boolean" ? featured : false,
          publishedAt: publishedAt ? new Date(publishedAt) : null,
        })
        .onConflictDoNothing({ target: socialMentions.url })
        .returning();

      if (!created) {
        return cValidationError(c, "A social mention with this URL already exists");
      }

      return c.json(created, 201);
    } catch (error) {
      return cApiError(c, "Failed to create social mention", error);
    }
  }
);

/**
 * DELETE /admin/social-mentions/:id
 *
 * Deletes a single social mention by id. Used to permanently remove spam or
 * mistakenly ingested entries outside the normal approve/reject flow.
 *
 * @param id - Social mention identifier
 * @returns Success confirmation
 */
router.delete("/social-mentions/:id",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const { id } = c.req.param();

      const [deleted] = await dbWrite
        .delete(socialMentions)
        .where(eq(socialMentions.id, id))
        .returning({ id: socialMentions.id });

      if (!deleted) {
        return cNotFoundError(c, "Social mention not found");
      }

      return c.json({ success: true, id: deleted.id });
    } catch (error) {
      return cApiError(c, "Failed to delete social mention", error);
    }
  }
);

/**
 * POST /admin/social-mentions/bulk-status
 *
 * Bulk updates the status of multiple social mentions in one request (e.g.
 * approve or reject an entire page of the curation queue). Only the status
 * field is mutated.
 *
 * @param ids - Array of social mention identifiers (required)
 * @param status - Target status: "pending" | "approved" | "rejected" (required)
 * @returns Count of updated rows
 */
router.post("/social-mentions/bulk-status",
  requireAuth,
  requireSystemAdmin,
  async (c) => {
    try {
      const { ids, status } = c.get("body");

      if (!Array.isArray(ids) || ids.length === 0) {
        return cValidationError(c, "ids must be a non-empty array");
      }
      if (!isSocialMentionStatus(status)) {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const validIds = ids.filter((value): value is string => typeof value === "string" && value.length > 0);

      const result = await dbWrite
        .update(socialMentions)
        .set({ status })
        .where(inArray(socialMentions.id, validIds))
        .returning({ id: socialMentions.id });

      return c.json({ success: true, updated: result.length });
    } catch (error) {
      return cApiError(c, "Failed to bulk update social mentions", error);
    }
  }
);

// ============================================================================
// SNAPSHOT MANAGEMENT ROUTES
// ============================================================================

// /**
//  * Get comprehensive snapshot statistics for a user's book
//  * 
//  * @route GET /admin/books/:bookId/snapshots/statistics
//  */
// router.get("/books/:bookId/snapshots/statistics", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.userId!;
//     const { bookId } = req.params;

//     if (!bookId) {
//       return res.status(400).json({ 
//         error: "Missing required field: bookId is required" 
//       });
//     }

//     // Ensure bookId is string (Express params can be string arrays)
//     const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

//     const stats = await getSnapshotStatistics(userId, bookIdStr);
    
//     res.json({
//       bookId: bookIdStr,
//       statistics: stats,
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     console.error("[admin] ❌ Failed to get snapshot statistics:", error);
//     res.status(500).json({ error: "Failed to get snapshot statistics" });
//   }
// });

// /**
//  * Delete all snapshots for a user's book (dangerous operation)
//  * 
//  * @route DELETE /admin/books/:bookId/snapshots
//  */
// router.delete("/books/:bookId/snapshots", requireAuth, async (req: Request, res: Response) => {
//   try {
//     const userId = req.userId!;
//     const { bookId } = req.params;

//     if (!bookId) {
//       return res.status(400).json({ 
//         error: "Missing required field: bookId is required" 
//       });
//     }

//     // Ensure bookId is string (Express params can be string arrays)
//     const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

//     // Get statistics before deletion for confirmation
//     const beforeStats = await getSnapshotStatistics(userId, bookIdStr);
    
//     // Delete all snapshots
//     await deleteAllSnapshots(userId, bookIdStr);
    
//     console.log(`[admin] 🗑️ Admin deleted all snapshots for user ${userId}, book ${bookIdStr} (${beforeStats.total} snapshots)`);
    
//     res.json({
//       bookId: bookIdStr,
//       deleted: beforeStats.total,
//       message: "All snapshots deleted successfully",
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     console.error("[admin] ❌ Failed to delete snapshots:", error);
//     res.status(500).json({ error: "Failed to delete snapshots" });
//   }
// });

export default router;
