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
import { eq, desc, and, or, inArray, sql, gte, lte, isNotNull, isNull, ilike, count, countDistinct, avg, sum } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { requireSuperAdmin, requirePermission, resolveAdminAccess, normalizePermissions, isSuperAdminUserId, ADMIN_PERMISSIONS } from "../middleware/admin-auth.js";
import { cApiError, cValidationError, cNotFoundError } from "../utils/error.js";
import { reconstructStoryState } from "../utils/branch-traversal.js";
import { getBookAnalytics, getCommunityAnalytics } from "../services/analytics.js";
import { getAdminBusinessMetrics } from "../services/admin-business-analytics.js";
import { getBookFromDB, getPageFromDB, invalidateEnrichedBookCache } from "../services/book.js";
import { getStoryState } from "../services/story.js";
import { dbRead, dbWrite } from "../db/client.js";
import { socialMentions, bookTestimonials, adminUsers, adminSettings, usage, users, userFeedbacks, books, portalBlogPosts, platformTestimonials, pages, userPageProgress, creatorPayouts, creatorWallets, creatorPayoutMethods, transactions, subscriptions } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";
import { bookStatuses, bookVisibilities, type BookStatus, type BookVisibility } from "../types/book.js";
import { feedbackAdminStatuses, feedbackCategories, type FeedbackAdminStatus, type FeedbackCategory } from "../types/user.js";
import { extractAndResolveTwistloomLink, parseTwistloomProductUrl, resolveBookByIdForAdmin, resolvePublicBookBySlug } from "../services/social/extract-twistloom-link.js";
import { sanitizeBlogHtml } from "../utils/sanitize-html.js";
import { notifyForumUserBanned, notifyForumUserUnbanned } from "../services/forum-queue.js";
import { invalidateUserProfileCache } from "../services/cache.js";
import { getNeonProjectUsage, NeonApiError } from "../services/neon-usage.js";
import { applyEnforcementAction, revokeEnforcementAction, getActiveEnforcementsForUser } from "../services/trust-safety.js";
import { parsePaymentGateway, formatPaymentAmount, getGatewayCurrency, getSubscriptionPlanName } from "../utils/payment.js";

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

//     // Ensure bookId is a string (route params can be string arrays)
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
        uptime: typeof process.uptime === "function" ? process.uptime() : null,
        memoryUsage: typeof process.memoryUsage === "function" ? process.memoryUsage() : null,
        nodeVersion: process.version ?? null
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
 * status, platform, linked state, and pagination. Results are ordered by
 * relevance score (highest first) so the best candidates surface at the top.
 *
 * @param status - Optional filter: "pending" | "approved" | "rejected"
 * @param platform - Optional filter: e.g. "reddit" | "hackernews" | "web"
 * @param linked - Optional: "true" | "false" | "auto" | "admin" for related book filters
 * @param limit - Maximum rows to return (default: 50, max: 200)
 * @param offset - Number of rows to skip for pagination (default: 0)
 * @returns Array of social mentions and a total count for the applied filter
 */
/**
 * GET /admin/me
 * Current admin session capabilities (for sidebar / UI). Not a security boundary.
 */
router.get("/me", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const access = await resolveAdminAccess(userId);
    if (!access.isAdmin) {
      return c.json({ error: "Forbidden: admin access required" }, 403);
    }
    return c.json({
      userId,
      isSuperAdmin: access.isSuperAdmin,
      permissions: access.permissions,
      availablePermissions: ADMIN_PERMISSIONS,
    });
  } catch (error) {
    return cApiError(c, "Failed to resolve admin session", error);
  }
});

router.get("/social-mentions",
  requireAuth,
  requirePermission("social_mentions"),
  async (c) => {
    try {
      const { status, platform, linked, limit = "50", offset = "0" } = c.req.query();

      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (isSocialMentionStatus(status)) {
        conditions.push(eq(socialMentions.status, status));
      }
      if (typeof platform === "string" && platform.length > 0) {
        conditions.push(eq(socialMentions.platform, platform));
      }
      if (linked === "true") {
        conditions.push(sql`${socialMentions.relatedBookId} IS NOT NULL`);
      } else if (linked === "false") {
        conditions.push(sql`${socialMentions.relatedBookId} IS NULL`);
      } else if (linked === "auto") {
        conditions.push(eq(socialMentions.relatedBookSource, "auto"));
      } else if (linked === "admin") {
        conditions.push(eq(socialMentions.relatedBookSource, "admin"));
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
  requirePermission("social_mentions"),
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
 * score, displayed title/content, featured, and related book linkage).
 *
 * Linkage fields (D1 link-only v1, D4):
 * - relatedBookId: book UUID, or null to unlink
 * - relatedPageId: optional page UUID, or null to clear
 * - relatedBookUrl: paste Twistloom /books or /share URL (resolved server-side; sets admin source)
 * - clearRelatedBook: true â†’ nulls related book/page and source
 *
 * Setting a book via relatedBookId or relatedBookUrl always sets relatedBookSource='admin'
 * so cron backfill will not overwrite it.
 *
 * @param id - Social mention identifier
 * @returns The updated social mention row
 */
router.patch("/social-mentions/:id",
  requireAuth,
  requirePermission("social_mentions"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const {
        status,
        featured,
        relevanceScore,
        sentimentScore,
        title,
        content,
        relatedBookId,
        relatedPageId,
        relatedBookUrl,
        clearRelatedBook,
      } = c.get("body");

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

      if (clearRelatedBook === true) {
        updates.relatedBookId = null;
        updates.relatedPageId = null;
        updates.relatedBookSource = null;
      } else if (typeof relatedBookUrl === "string" && relatedBookUrl.trim().length > 0) {
        const parsed = parseTwistloomProductUrl(relatedBookUrl.trim());
        if (!parsed) {
          return cValidationError(c, "relatedBookUrl is not a valid Twistloom /books or /share URL");
        }
        // Admin may link any existing book; wall CTAs still require public+active at read time
        const bySlug = await resolvePublicBookBySlug(parsed.slug);
        if (bySlug) {
          updates.relatedBookId = bySlug.bookId;
          updates.relatedPageId = parsed.pageId;
          updates.relatedBookSource = "admin";
        } else {
          // Fall back: resolve slug without public gate for admin storage
          const { books } = await import("../db/schema.js");
          const [anyBook] = await dbRead
            .select({ id: books.id })
            .from(books)
            .where(eq(books.slug, parsed.slug))
            .limit(1);
          if (!anyBook) {
            return cValidationError(c, `No book found for slug "${parsed.slug}"`);
          }
          updates.relatedBookId = anyBook.id;
          updates.relatedPageId = parsed.pageId;
          updates.relatedBookSource = "admin";
        }
      } else if (relatedBookId === null) {
        updates.relatedBookId = null;
        updates.relatedPageId = null;
        updates.relatedBookSource = null;
      } else if (typeof relatedBookId === "string" && relatedBookId.length > 0) {
        const book = await resolveBookByIdForAdmin(relatedBookId);
        if (!book) {
          return cValidationError(c, "relatedBookId does not match an existing book");
        }
        updates.relatedBookId = book.bookId;
        updates.relatedBookSource = "admin";
        if (relatedPageId === null) {
          updates.relatedPageId = null;
        } else if (typeof relatedPageId === "string") {
          updates.relatedPageId = relatedPageId;
        }
      } else if (relatedPageId === null) {
        updates.relatedPageId = null;
      } else if (typeof relatedPageId === "string") {
        updates.relatedPageId = relatedPageId;
      }

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
  requirePermission("social_mentions"),
  async (c) => {
    try {
      const {
        platform, author, content, url, title, authorAvatar,
        score, sentimentScore, relevanceScore, status, featured, publishedAt,
        relatedBookId, relatedPageId, relatedBookUrl,
      } = c.get("body");

      if (!platform || !author || !content || !url) {
        return cValidationError(c, "Missing required fields: platform, author, content, and url are required");
      }
      if (status !== undefined && !isSocialMentionStatus(status)) {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      let linkBookId: string | null = null;
      let linkPageId: string | null = null;
      let linkSource: "auto" | "admin" | null = null;

      if (typeof relatedBookUrl === "string" && relatedBookUrl.trim().length > 0) {
        const parsed = parseTwistloomProductUrl(relatedBookUrl.trim());
        if (!parsed) {
          return cValidationError(c, "relatedBookUrl is not a valid Twistloom /books or /share URL");
        }
        const { books } = await import("../db/schema.js");
        const [anyBook] = await dbRead
          .select({ id: books.id })
          .from(books)
          .where(eq(books.slug, parsed.slug))
          .limit(1);
        if (!anyBook) {
          return cValidationError(c, `No book found for slug "${parsed.slug}"`);
        }
        linkBookId = anyBook.id;
        linkPageId = parsed.pageId;
        linkSource = "admin";
      } else if (typeof relatedBookId === "string" && relatedBookId.length > 0) {
        const book = await resolveBookByIdForAdmin(relatedBookId);
        if (!book) {
          return cValidationError(c, "relatedBookId does not match an existing book");
        }
        linkBookId = book.bookId;
        linkPageId = typeof relatedPageId === "string" ? relatedPageId : null;
        linkSource = "admin";
      } else {
        // Best-effort auto extract from pasted content (public books only)
        const resolved = await extractAndResolveTwistloomLink(title, content, "auto");
        if (resolved) {
          linkBookId = resolved.bookId;
          linkPageId = resolved.pageId;
          linkSource = "auto";
        }
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
          relatedBookId: linkBookId,
          relatedPageId: linkPageId,
          relatedBookSource: linkSource,
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
  requirePermission("social_mentions"),
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
  requirePermission("social_mentions"),
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

//     // Ensure bookId is string (route params can be string arrays)
//     const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

//     const stats = await getSnapshotStatistics(userId, bookIdStr);
    
//     res.json({
//       bookId: bookIdStr,
//       statistics: stats,
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     console.error("[admin] âŒ Failed to get snapshot statistics:", error);
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

//     // Ensure bookId is string (route params can be string arrays)
//     const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

//     // Get statistics before deletion for confirmation
//     const beforeStats = await getSnapshotStatistics(userId, bookIdStr);
    
//     // Delete all snapshots
//     await deleteAllSnapshots(userId, bookIdStr);
    
//     console.log(`[admin] ðŸ—‘ï¸ Admin deleted all snapshots for user ${userId}, book ${bookIdStr} (${beforeStats.total} snapshots)`);
    
//     res.json({
//       bookId: bookIdStr,
//       deleted: beforeStats.total,
//       message: "All snapshots deleted successfully",
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     console.error("[admin] âŒ Failed to delete snapshots:", error);
//     res.status(500).json({ error: "Failed to delete snapshots" });
//   }
// });

// ============================================================================
// BOOK TESTIMONIALS ADMIN ROUTES
// ============================================================================

/**
 * GET /admin/testimonials
 *
 * Lists all book testimonials for the admin curation queue. Supports filtering
 * by status and pagination.
 */
router.get("/testimonials",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { status, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (status === "pending" || status === "approved" || status === "rejected") {
        conditions.push(eq(bookTestimonials.status, status));
      }

      const rows = await dbRead
        .select()
        .from(bookTestimonials)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(bookTestimonials.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(bookTestimonials)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, testimonials: rows });
    } catch (error) {
      return cApiError(c, "Failed to list testimonials", error);
    }
  }
);

/**
 * PATCH /admin/testimonials/:id
 *
 * Updates moderation fields of a book testimonial (status, featured).
 */
router.patch("/testimonials/:id",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const { status, featured } = c.get("body");

      if (status !== undefined && status !== "pending" && status !== "approved" && status !== "rejected") {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const [existing] = await dbRead
        .select({ id: bookTestimonials.id })
        .from(bookTestimonials)
        .where(eq(bookTestimonials.id, id))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "Testimonial not found");
      }

      const updates: Partial<typeof bookTestimonials.$inferInsert> = {};
      if (status !== undefined) updates.status = status;
      if (typeof featured === "boolean") updates.featured = featured;

      const [updated] = await dbWrite
        .update(bookTestimonials)
        .set(updates)
        .where(eq(bookTestimonials.id, id))
        .returning();

      // Status flips (pending → approved) change the public rating/count
      // aggregates → drop the affected book's enriched-book LRU entry.
      invalidateEnrichedBookCache(updated.bookId);

      return c.json(updated);
    } catch (error) {
      return cApiError(c, "Failed to update testimonial", error);
    }
  }
);

/**
 * POST /admin/testimonials/bulk-status
 *
 * Bulk updates the status of multiple testimonials.
 */
router.post("/testimonials/bulk-status",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { ids, status } = c.get("body");

      if (!Array.isArray(ids) || ids.length === 0) {
        return cValidationError(c, "ids must be a non-empty array");
      }
      if (status !== "pending" && status !== "approved" && status !== "rejected") {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const validIds = ids.filter((value): value is string => typeof value === "string" && value.length > 0);

      const result = await dbWrite
        .update(bookTestimonials)
        .set({ status })
        .where(inArray(bookTestimonials.id, validIds))
        .returning({ id: bookTestimonials.id, bookId: bookTestimonials.bookId });

      // Status flips change the public rating/count aggregates → drop the
      // enriched-book LRU entry for every affected book.
      for (const row of result) {
        invalidateEnrichedBookCache(row.bookId);
      }

      return c.json({ success: true, updated: result.length });
    } catch (error) {
      return cApiError(c, "Failed to bulk update testimonials", error);
    }
  }
);

// ============================================================================
// PLATFORM TESTIMONIALS (BETA TESTERS) ROUTES
// ============================================================================

/**
 * GET /admin/platform-testimonials
 *
 * Lists platform-wide testimonials (beta testers' submissions about the
 * platform itself) for the admin curation queue. Supports filtering by status
 * and pagination, newest first, with the author's name/avatar joined in.
 *
 * @query {string} [status] - Optional filter: "pending" | "approved" | "rejected"
 * @query {number} [limit] - Maximum rows to return (default: 50, max: 200)
 * @query {number} [offset] - Number of rows to skip (default: 0)
 *
 * @returns {Object} List response
 * @returns {number} total - Total rows matching the filter
 * @returns {Array} testimonials - Platform testimonial rows (with author info)
 */
router.get("/platform-testimonials",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { status, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (status === "pending" || status === "approved" || status === "rejected") {
        conditions.push(eq(platformTestimonials.status, status));
      }

      const rows = await dbRead
        .select({
          id: platformTestimonials.id,
          userId: platformTestimonials.userId,
          rating: platformTestimonials.rating,
          content: platformTestimonials.content,
          status: platformTestimonials.status,
          featured: platformTestimonials.featured,
          createdAt: platformTestimonials.createdAt,
          updatedAt: platformTestimonials.updatedAt,
          userName: users.name,
          userAvatar: users.imageUrl,
        })
        .from(platformTestimonials)
        .leftJoin(users, eq(platformTestimonials.userId, users.userId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(platformTestimonials.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [countRow] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(platformTestimonials)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return c.json({
        total: Number(countRow.count),
        limit: limitNum,
        offset: offsetNum,
        testimonials: rows,
      });
    } catch (error) {
      return cApiError(c, "Failed to list platform testimonials", error);
    }
  }
);

/**
 * PATCH /admin/platform-testimonials/:id
 *
 * Updates moderation fields of a platform testimonial (status, featured).
 * Approving a beta tester's platform endorsement surfaces it on the public
 * homepage testimonial wall.
 */
router.patch("/platform-testimonials/:id",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const { status, featured } = c.get("body");

      if (status !== undefined && status !== "pending" && status !== "approved" && status !== "rejected") {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const [existing] = await dbRead
        .select({ id: platformTestimonials.id })
        .from(platformTestimonials)
        .where(eq(platformTestimonials.id, id))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "Platform testimonial not found");
      }

      const updates: Partial<typeof platformTestimonials.$inferInsert> = {};
      if (status !== undefined) updates.status = status;
      if (typeof featured === "boolean") updates.featured = featured;

      const [updated] = await dbWrite
        .update(platformTestimonials)
        .set(updates)
        .where(eq(platformTestimonials.id, id))
        .returning();

      return c.json(updated);
    } catch (error) {
      return cApiError(c, "Failed to update platform testimonial", error);
    }
  }
);

/**
 * POST /admin/platform-testimonials/bulk-status
 *
 * Bulk updates the status of multiple platform testimonials.
 */
router.post("/platform-testimonials/bulk-status",
  requireAuth,
  requirePermission("testimonials"),
  async (c) => {
    try {
      const { ids, status } = c.get("body");

      if (!Array.isArray(ids) || ids.length === 0) {
        return cValidationError(c, "ids must be a non-empty array");
      }
      if (status !== "pending" && status !== "approved" && status !== "rejected") {
        return cValidationError(c, "Invalid status. Must be 'pending', 'approved', or 'rejected'");
      }

      const validIds = ids.filter((value): value is string => typeof value === "string" && value.length > 0);

      const result = await dbWrite
        .update(platformTestimonials)
        .set({ status })
        .where(inArray(platformTestimonials.id, validIds))
        .returning({ id: platformTestimonials.id });

      return c.json({ success: true, updated: result.length });
    } catch (error) {
      return cApiError(c, "Failed to bulk update platform testimonials", error);
    }
  }
);

// ============================================================================
// ADMIN USER MANAGEMENT ROUTES (P1.5)
// ============================================================================

/**
 * GET /admin/admins
 *
 * Lists all admin users. Super admin only.
 */
router.get("/admins",
  requireAuth,
  requireSuperAdmin,
  async (c) => {
    try {
      const rows = await dbRead
        .select()
        .from(adminUsers)
        .orderBy(desc(adminUsers.createdAt));

      return c.json({ admins: rows });
    } catch (error) {
      return cApiError(c, "Failed to list admins", error);
    }
  }
);

/**
 * POST /admin/admins
 *
 * Invites a new admin user by userId or email. Super admin only.
 */
router.post("/admins",
  requireAuth,
  requireSuperAdmin,
  async (c) => {
    try {
      const { userId, email, permissions } = c.get("body") as {
        userId?: string;
        email?: string;
        permissions?: unknown;
      };

      if (!userId && !email) {
        return cValidationError(c, "Either userId or email is required");
      }

      let resolvedUserId = typeof userId === "string" && userId.length > 0 ? userId : null;
      let resolvedEmail = typeof email === "string" && email.length > 0 ? email : null;

      if (!resolvedUserId && resolvedEmail) {
        const [platformUser] = await dbRead
          .select({ userId: users.userId, email: users.email })
          .from(users)
          .where(eq(users.email, resolvedEmail))
          .limit(1);
        if (!platformUser) {
          return cValidationError(c, "No platform user found for that email");
        }
        resolvedUserId = platformUser.userId;
        resolvedEmail = platformUser.email ?? resolvedEmail;
      }

      if (!resolvedUserId) {
        return cValidationError(c, "userId is required");
      }

      const [existing] = await dbRead
        .select({ userId: adminUsers.userId })
        .from(adminUsers)
        .where(eq(adminUsers.userId, resolvedUserId))
        .limit(1);

      if (existing) {
        return cValidationError(c, "User is already an admin");
      }

      const invitedBy = c.get("userId");
      const perms = normalizePermissions(permissions ?? []);

      const [created] = await dbWrite
        .insert(adminUsers)
        .values({
          userId: resolvedUserId,
          email: resolvedEmail,
          invitedBy,
          permissions: perms,
        })
        .returning();

      return c.json(created, 201);
    } catch (error) {
      return cApiError(c, "Failed to add admin", error);
    }
  }
);

/**
 * PATCH /admin/admins/:userId/permissions
 *
 * Replace capability list for an invited admin. Super admin only.
 * Body: { permissions: string[] } — only known keys are kept.
 */
router.patch(
  "/admins/:userId/permissions",
  requireAuth,
  requireSuperAdmin,
  async (c) => {
    try {
      const { userId } = c.req.param();
      const body = c.get("body") as { permissions?: unknown };

      if (isSuperAdminUserId(userId)) {
        return cValidationError(c, "Cannot set permissions on the super admin account");
      }

      const [existing] = await dbRead
        .select({ userId: adminUsers.userId })
        .from(adminUsers)
        .where(eq(adminUsers.userId, userId))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "Admin not found");
      }

      const perms = normalizePermissions(body?.permissions ?? []);

      const [updated] = await dbWrite
        .update(adminUsers)
        .set({ permissions: perms })
        .where(eq(adminUsers.userId, userId))
        .returning();

      return c.json(updated);
    } catch (error) {
      return cApiError(c, "Failed to update admin permissions", error);
    }
  },
);

/**
 * DELETE /admin/admins/:userId
 *
 * Removes an admin user. Super admin only.
 */
router.delete("/admins/:userId",
  requireAuth,
  requireSuperAdmin,
  async (c) => {
    try {
      const { userId } = c.req.param();

      const [deleted] = await dbWrite
        .delete(adminUsers)
        .where(eq(adminUsers.userId, userId))
        .returning({ userId: adminUsers.userId });

      if (!deleted) {
        return cNotFoundError(c, "Admin not found");
      }

      return c.json({ success: true, userId: deleted.userId });
    } catch (error) {
      return cApiError(c, "Failed to remove admin", error);
    }
  }
);

// ============================================================================
// AI USAGE CHART ROUTE (P5)
// ============================================================================

/**
 * GET /admin/usage/chart
 *
 * Returns aggregated AI usage data for charting. Supports date range, provider
 * filter, and granularity (data is stored per-day; week granularity is
 * computed client-side).
 *
 * @param from - Start date (ISO string, default: 30 days ago)
 * @param to - End date (ISO string, default: today)
 * @param provider - Optional provider filter
 * @returns Array of daily usage records
 */
router.get("/usage/chart",
  requireAuth,
  requirePermission("usage"),
  async (c) => {
    try {
      const { from, to, provider } = c.req.query();

      const now = new Date();
      const fromDate = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const toDate = to ? new Date(to) : now;

      const conditions = [
        gte(usage.date, fromDate.toISOString().split("T")[0]),
        lte(usage.date, toDate.toISOString().split("T")[0]),
      ];
      if (typeof provider === "string" && provider.length > 0) {
        conditions.push(eq(usage.provider, provider as (typeof usage.$inferSelect)["provider"]));
      }

      const rows = await dbRead
        .select()
        .from(usage)
        .where(and(...conditions))
        .orderBy(usage.date);

      return c.json({ from: fromDate.toISOString(), to: toDate.toISOString(), records: rows });
    } catch (error) {
      return cApiError(c, "Failed to fetch usage chart data", error);
    }
  }
);

/**
 * GET /admin/usage
 *
 * Paginated raw usage rows feeding the admin data table (complement to the
 * aggregated `/usage/chart` endpoint used for charts). Supports date range and
 * provider filters. One row per (date, provider, context, model) from the
 * `usage` table.
 *
 * @param from - Start date (YYYY-MM-DD)
 * @param to - End date (YYYY-MM-DD)
 * @param provider - Optional provider filter
 * @param limit - Maximum rows to return (default: 50, max: 200)
 * @param offset - Number of rows to skip (default: 0)
 * @returns { total, limit, offset, usage } row envelope
 */
router.get("/usage",
  requireAuth,
  requirePermission("usage"),
  async (c) => {
    try {
      const { from, to, provider, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (typeof from === "string" && from.length > 0) {
        conditions.push(gte(usage.date, from));
      }
      if (typeof to === "string" && to.length > 0) {
        conditions.push(lte(usage.date, to));
      }
      if (typeof provider === "string" && provider.length > 0) {
        conditions.push(eq(usage.provider, provider as (typeof usage.$inferSelect)["provider"]));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await dbRead
        .select()
        .from(usage)
        .where(whereClause)
        .orderBy(desc(usage.date))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(usage)
        .where(whereClause);

      return c.json({
        total: Number(count),
        limit: limitNum,
        offset: offsetNum,
        usage: rows,
      });
    } catch (error) {
      return cApiError(c, "Failed to list usage", error);
    }
  }
);

// ============================================================================
// NEON PROJECT CONSUMPTION (control-plane usage telemetry)
// ============================================================================

/**
 * GET /admin/usage/neon
 *
 * Returns Neon project consumption metrics (compute time, active time, storage,
 * data transfer) and the start of the current consumption period, pulled from
 * the Neon console control-plane API. Cached for 5 minutes to respect Neon API
 * rate limits. Requires the `usage` admin permission.
 *
 * Note: this is billing/usage telemetry — NOT a DB connectivity probe. Keep
 * `/health/db` for liveness/uptime checks.
 */
router.get("/usage/neon",
  requireAuth,
  requirePermission("usage"),
  async (c) => {
    try {
      const usage = await getNeonProjectUsage();
      return c.json(usage);
    } catch (error) {
      if (error instanceof NeonApiError) {
        return cApiError(c, error.message, undefined, error.status ?? 502);
      }
      return cApiError(c, "Failed to fetch Neon usage", error);
    }
  }
);

// ============================================================================
// READER ENGAGEMENT ANALYTICS (roadmap 1.9 / P6)
// ============================================================================

/**
 * GET /admin/analytics
 *
 * Internal reader-engagement analytics. Book-level table:
 * reads, unique readers, avg page reached, completion rate, reread rate.
 * Aggregates computed via two grouped sub-queries joined in JS (no N+1).
 */
router.get("/analytics",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const { search, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const bookConditions = [];
      if (typeof search === "string" && search.length > 0) {
        bookConditions.push(ilike(books.title, `%${search}%`));
      }
      const bookWhere = bookConditions.length > 0 ? and(...bookConditions) : undefined;

      const bookRows = await dbRead
        .select({
          id: books.id,
          title: books.title,
          slug: books.slug,
          readCount: books.readCount,
          totalPages: books.totalPages,
        })
        .from(books)
        .where(bookWhere)
        .orderBy(desc(books.readCount))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count: totalRows }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(books)
        .where(bookWhere);

      const bookIds = bookRows.map((b) => b.id);
      const progressAgg: Record<string, { uniqueReaders: number; progressEvents: number; avgPage: number }> = {};
      const visitAgg: Record<string, number> = {};

      if (bookIds.length > 0) {
        const pAgg = await dbRead
          .select({
            bookId: userPageProgress.bookId,
            uniqueReaders: countDistinct(userPageProgress.userId),
            progressEvents: count(),
            avgPage: avg(pages.page),
          })
          .from(userPageProgress)
          .innerJoin(pages, eq(userPageProgress.actionedPageId, pages.id))
          .where(inArray(userPageProgress.bookId, bookIds))
          .groupBy(userPageProgress.bookId);

        for (const row of pAgg) {
          progressAgg[row.bookId] = {
            uniqueReaders: Number(row.uniqueReaders ?? 0),
            progressEvents: Number(row.progressEvents ?? 0),
            avgPage: row.avgPage != null ? Number(row.avgPage) : 0,
          };
        }

        const vAgg = await dbRead
          .select({ bookId: pages.bookId, visitSum: sum(pages.visitCount) })
          .from(pages)
          .where(inArray(pages.bookId, bookIds))
          .groupBy(pages.bookId);

        for (const row of vAgg) {
          visitAgg[row.bookId] = Number(row.visitSum ?? 0);
        }
      }

      const analytics = bookRows.map((b) => {
        const pa = progressAgg[b.id];
        const visitSum = visitAgg[b.id] ?? 0;
        const uniqueReaders = pa?.uniqueReaders ?? 0;
        const avgPage = pa?.avgPage ?? 0;
        const completionRate = b.totalPages > 0 ? Math.min(1, avgPage / b.totalPages) : 0;
        const rereadRate = visitSum > 0 ? Math.max(0, (visitSum - uniqueReaders) / visitSum) : 0;
        return {
          bookId: b.id,
          title: b.title,
          slug: b.slug,
          reads: b.readCount,
          totalPages: b.totalPages,
          uniqueReaders,
          progressEvents: pa?.progressEvents ?? 0,
          avgPageReached: Math.round(avgPage),
          completionRate,
          rereadRate,
        };
      });

      return c.json({ total: Number(totalRows), limit: limitNum, offset: offsetNum, books: analytics });
    } catch (error) {
      return cApiError(c, "Failed to list analytics", error);
    }
  }
);

/**
 * GET /admin/analytics/business
 *
 * Platform-wide business, financial, revenue (ARR/MRR, credit packs),
 * DAU/MAU engagement, and churn metrics.
 */
router.get("/analytics/business",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const data = await getAdminBusinessMetrics();
      return c.json(data);
    } catch (error) {
      return cApiError(c, "Failed to load business analytics", error);
    }
  }
);

/**
 * GET /admin/payments/transactions
 *
 * Platform-wide credit pack purchases and one-time payment ledger.
 */
router.get("/payments/transactions",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const { search, gateway, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [eq(transactions.type, "purchase")];

      const resolvedGateway = parsePaymentGateway(gateway);
      if (resolvedGateway) {
        conditions.push(eq(transactions.gateway, resolvedGateway));
      }

      if (search && search.trim().length > 0) {
        const query = `%${search.trim()}%`;
        conditions.push(
          or(
            ilike(users.email, query),
            ilike(users.name, query),
            ilike(users.username, query),
            ilike(transactions.providerPaymentId, query),
            ilike(transactions.context, query)
          )!
        );
      }

      const countResult = await dbRead
        .select({ total: count() })
        .from(transactions)
        .innerJoin(users, eq(transactions.userId, users.userId))
        .where(and(...conditions));

      const total = Number(countResult[0]?.total ?? 0);

      const rows = await dbRead
        .select({
          id: transactions.id,
          userId: transactions.userId,
          type: transactions.type,
          credits: transactions.credits,
          amountCents: transactions.amountCents,
          gateway: transactions.gateway,
          providerPaymentId: transactions.providerPaymentId,
          providerEventId: transactions.providerEventId,
          context: transactions.context,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          user: {
            name: users.name,
            email: users.email,
            username: users.username,
            imageUrl: users.imageUrl,
          },
        })
        .from(transactions)
        .innerJoin(users, eq(transactions.userId, users.userId))
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const formatted = rows.map((r) => ({
        ...r,
        amountFormatted: formatPaymentAmount(r.amountCents, r.gateway),
        currency: getGatewayCurrency(r.gateway),
      }));

      return c.json({
        total,
        limit: limitNum,
        offset: offsetNum,
        transactions: formatted,
      });
    } catch (error) {
      return cApiError(c, "Failed to list transactions", error);
    }
  }
);

/**
 * GET /admin/payments/subscriptions
 *
 * Platform-wide VIP subscription ledger.
 */
router.get("/payments/subscriptions",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const { search, status, gateway, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];

      if (status && status.trim().length > 0) {
        conditions.push(eq(subscriptions.status, status));
      }

      const resolvedGateway = parsePaymentGateway(gateway);
      if (resolvedGateway) {
        conditions.push(eq(subscriptions.gateway, resolvedGateway));
      }

      if (search && search.trim().length > 0) {
        const query = `%${search.trim()}%`;
        conditions.push(
          or(
            ilike(users.email, query),
            ilike(users.name, query),
            ilike(users.username, query),
            ilike(subscriptions.providerSubscriptionId, query),
            ilike(subscriptions.providerCustomerId, query)
          )!
        );
      }

      const countResult = await dbRead
        .select({ total: count() })
        .from(subscriptions)
        .innerJoin(users, eq(subscriptions.userId, users.userId))
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = Number(countResult[0]?.total ?? 0);

      const rows = await dbRead
        .select({
          id: subscriptions.id,
          userId: subscriptions.userId,
          gateway: subscriptions.gateway,
          providerSubscriptionId: subscriptions.providerSubscriptionId,
          providerCustomerId: subscriptions.providerCustomerId,
          providerPriceId: subscriptions.providerPriceId,
          status: subscriptions.status,
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          canceledAt: subscriptions.canceledAt,
          isTrial: subscriptions.isTrial,
          trialEnd: subscriptions.trialEnd,
          metadata: subscriptions.metadata,
          createdAt: subscriptions.createdAt,
          user: {
            name: users.name,
            email: users.email,
            username: users.username,
            imageUrl: users.imageUrl,
          },
        })
        .from(subscriptions)
        .innerJoin(users, eq(subscriptions.userId, users.userId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(subscriptions.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const formatted = rows.map((r) => ({
        ...r,
        planName: getSubscriptionPlanName(r.gateway),
      }));

      return c.json({
        total,
        limit: limitNum,
        offset: offsetNum,
        subscriptions: formatted,
      });
    } catch (error) {
      return cApiError(c, "Failed to list subscriptions", error);
    }
  }
);

/**
 * GET /admin/analytics/community
 *
 * Platform-wide community analytics (roadmap 3.5). Aggregates from
 * trigger-maintained `books` columns + `userPageProgress`/`pageReactions`.
 */
router.get("/analytics/community",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const data = await getCommunityAnalytics();
      return c.json(data);
    } catch (error) {
      return cApiError(c, "Failed to load community analytics", error);
    }
  }
);

/**
 * GET /admin/analytics/:bookId
 *
 * Per-page drop-off + momentum curve for a single book.
 */
router.get("/analytics/:bookId",
  requireAuth,
  requirePermission("analytics"),
  async (c) => {
    try {
      const { bookId } = c.req.param();
      const detail = await getBookAnalytics(bookId, true);
      if (!detail) return cNotFoundError(c, "Book not found");
      return c.json(detail);
    } catch (error) {
      return cApiError(c, "Failed to load book analytics", error);
    }
  }
);

// ============================================================================
// EMAIL ANNOUNCEMENTS (super-admin)
// ============================================================================

/**
 * POST /admin/email/announcements
 *
 * Sends a product announcement to users with productAnnouncements=true.
 * Super-admin only. Body: { title, bodyHtml, cta?: { url, text }, dryRun?: boolean }
 */
router.post(
  "/email/announcements",
  requireAuth,
  requireSuperAdmin,
  async (c) => {
    try {
      const body = c.get("body") as {
        title?: string;
        bodyHtml?: string;
        cta?: { url: string; text: string };
        dryRun?: boolean;
      };

      if (!body?.title || typeof body.title !== "string" || !body.title.trim()) {
        return cValidationError(c, "title is required");
      }
      if (!body?.bodyHtml || typeof body.bodyHtml !== "string" || !body.bodyHtml.trim()) {
        return cValidationError(c, "bodyHtml is required");
      }

      const { normalizeEmailPreferences } = await import("../services/email-preferences.js");
      const { sendAnnouncementEmail } = await import("../utils/email.js");

      const rows = await dbRead
        .select({
          userId: users.userId,
          email: users.email,
          emailPreferences: users.emailPreferences,
          isNewUser: users.isNewUser,
        })
        .from(users)
        .where(and(eq(users.isNewUser, false), isNotNull(users.email)));

      const recipients = rows.filter((r) => {
        const prefs = normalizeEmailPreferences(r.emailPreferences);
        return prefs.productAnnouncements && !!r.email;
      });

      if (body.dryRun) {
        return c.json({
          dryRun: true,
          recipientCount: recipients.length,
          title: body.title.trim(),
        });
      }

      let sent = 0;
      let failed = 0;
      for (const r of recipients) {
        const ok = await sendAnnouncementEmail(
          r.email,
          body.title.trim(),
          body.bodyHtml.trim(),
          body.cta,
          { userId: r.userId },
        );
        if (ok) sent++;
        else failed++;
      }

      console.log(
        `[admin] ðŸ“¢ Announcement "${body.title}" sent=${sent} failed=${failed} eligible=${recipients.length}`,
      );

      return c.json({
        success: true,
        title: body.title.trim(),
        recipientCount: recipients.length,
        sent,
        failed,
      });
    } catch (error) {
      return cApiError(c, "Failed to send announcement", error);
    }
  },
);

// ============================================================================
// FEEDBACKS ADMIN ROUTES (P3)
// ============================================================================

const feedbackSelect = {
  id: userFeedbacks.id,
  userId: userFeedbacks.userId,
  category: userFeedbacks.category,
  message: userFeedbacks.message,
  status: userFeedbacks.status,
  adminStatus: userFeedbacks.adminStatus,
  imageUrl: userFeedbacks.imageUrl,
  createdAt: userFeedbacks.createdAt,
  updatedAt: userFeedbacks.updatedAt,
  userName: users.name,
  userEmail: users.email,
};

function isFeedbackAdminStatus(value: unknown): value is FeedbackAdminStatus {
  return typeof value === "string" && (feedbackAdminStatuses as readonly string[]).includes(value);
}

/**
 * GET /admin/feedbacks
 *
 * Lists user feedbacks for the admin inbox. Filters by adminStatus (resolution),
 * category, and pagination. User submission `status` is returned but not the
 * primary admin filter (see admin_status column).
 */
router.get("/feedbacks",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const { adminStatus, category, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (isFeedbackAdminStatus(adminStatus)) {
        conditions.push(eq(userFeedbacks.adminStatus, adminStatus));
      }
      if (
        typeof category === "string" &&
        (feedbackCategories as readonly string[]).includes(category)
      ) {
        conditions.push(eq(userFeedbacks.category, category as FeedbackCategory));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await dbRead
        .select(feedbackSelect)
        .from(userFeedbacks)
        .leftJoin(users, eq(userFeedbacks.userId, users.userId))
        .where(whereClause)
        .orderBy(desc(userFeedbacks.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(userFeedbacks)
        .where(whereClause);

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, feedbacks: rows });
    } catch (error) {
      return cApiError(c, "Failed to list feedbacks", error);
    }
  }
);

/**
 * GET /admin/feedbacks/:id
 *
 * Single feedback with submitter join (image URL included when present).
 */
router.get("/feedbacks/:id",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const { id } = c.req.param();

      const [row] = await dbRead
        .select(feedbackSelect)
        .from(userFeedbacks)
        .leftJoin(users, eq(userFeedbacks.userId, users.userId))
        .where(eq(userFeedbacks.id, id))
        .limit(1);

      if (!row) {
        return cNotFoundError(c, "Feedback not found");
      }

      return c.json(row);
    } catch (error) {
      return cApiError(c, "Failed to get feedback", error);
    }
  }
);

/**
 * PATCH /admin/feedbacks/:id
 *
 * Updates admin_status only (unread | read | solved). Does not mutate user
 * submission lifecycle `status`.
 */
router.patch("/feedbacks/:id",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const body = c.get("body") as { adminStatus?: unknown };
      const adminStatus = body?.adminStatus;

      if (!isFeedbackAdminStatus(adminStatus)) {
        return cValidationError(c, "Invalid adminStatus. Must be 'unread', 'read', or 'solved'");
      }

      const [existing] = await dbRead
        .select({ id: userFeedbacks.id })
        .from(userFeedbacks)
        .where(eq(userFeedbacks.id, id))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "Feedback not found");
      }

      const [updated] = await dbWrite
        .update(userFeedbacks)
        .set({ adminStatus, updatedAt: new Date() })
        .where(eq(userFeedbacks.id, id))
        .returning();

      const [row] = await dbRead
        .select(feedbackSelect)
        .from(userFeedbacks)
        .leftJoin(users, eq(userFeedbacks.userId, users.userId))
        .where(eq(userFeedbacks.id, updated.id))
        .limit(1);

      return c.json(row ?? updated);
    } catch (error) {
      return cApiError(c, "Failed to update feedback", error);
    }
  }
);

/**
 * POST /admin/feedbacks/bulk-status
 *
 * Bulk-update admin_status for multiple feedback rows.
 * Body: { ids: string[], adminStatus: 'unread' | 'read' | 'solved' }
 */
router.post("/feedbacks/bulk-status",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const body = c.get("body") as { ids?: unknown; adminStatus?: unknown };
      const { ids, adminStatus } = body ?? {};

      if (!Array.isArray(ids) || ids.length === 0) {
        return cValidationError(c, "ids must be a non-empty array");
      }
      if (!isFeedbackAdminStatus(adminStatus)) {
        return cValidationError(c, "Invalid adminStatus. Must be 'unread', 'read', or 'solved'");
      }

      const validIds = ids.filter((value): value is string => typeof value === "string" && value.length > 0);
      if (validIds.length === 0) {
        return cValidationError(c, "ids must contain at least one string id");
      }

      const result = await dbWrite
        .update(userFeedbacks)
        .set({ adminStatus, updatedAt: new Date() })
        .where(inArray(userFeedbacks.id, validIds))
        .returning({ id: userFeedbacks.id });

      return c.json({ success: true, updated: result.length });
    } catch (error) {
      return cApiError(c, "Failed to bulk update feedbacks", error);
    }
  }
);

// ============================================================================
// BOOKS ADMIN ROUTES (P2)
// ============================================================================

/**
 * Build shared WHERE conditions for admin book list / summary.
 * Explore "originals" public shelf ≈ isOriginal + hasCover + status=active + visibility=public.
 */
function buildAdminBookConditions(query: {
  search?: string;
  isOriginal?: string;
  hasCover?: string;
  status?: string;
  visibility?: string;
}) {
  const conditions = [];

  if (typeof query.search === "string" && query.search.length > 0) {
    conditions.push(or(
      ilike(books.title, `%${query.search}%`),
      ilike(books.slug, `%${query.search}%`),
    ));
  }

  if (query.isOriginal === "true") {
    conditions.push(eq(books.isOriginal, true));
  } else if (query.isOriginal === "false") {
    conditions.push(eq(books.isOriginal, false));
  }

  if (query.hasCover === "true") {
    conditions.push(isNotNull(books.imageId));
  } else if (query.hasCover === "false") {
    conditions.push(isNull(books.imageId));
  }

  if (typeof query.status === "string" && bookStatuses.includes(query.status as BookStatus)) {
    conditions.push(eq(books.status, query.status as BookStatus));
  }

  if (typeof query.visibility === "string" && bookVisibilities.includes(query.visibility as BookVisibility)) {
    conditions.push(eq(books.visibility, query.visibility as BookVisibility));
  }

  return conditions;
}

/**
 * GET /admin/books
 *
 * Lists books with metrics for admin ops. Supports search, pagination, and
 * filters aligned with roadmap Decision A2:
 * - isOriginal: "true" | "false"
 * - hasCover: "true" | "false" (imageId present)
 * - status: active | draft | archived
 * - visibility: private | unlisted | followers | public
 *
 * Public explore originals shelf ≈ isOriginal=true&hasCover=true&status=active&visibility=public
 *
 * Optional includeSummary=true adds aggregate KPIs for the same filter set.
 */
router.get("/books",
  requireAuth,
  requirePermission("books"),
  async (c) => {
    try {
      const {
        search,
        isOriginal,
        hasCover,
        status,
        visibility,
        includeSummary,
        limit = "50",
        offset = "0",
      } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = buildAdminBookConditions({
        search,
        isOriginal,
        hasCover,
        status,
        visibility,
      });
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await dbRead
        .select({
          id: books.id,
          title: books.title,
          slug: books.slug,
          status: books.status,
          visibility: books.visibility,
          isOriginal: books.isOriginal,
          hasCover: sql<boolean>`${books.imageId} IS NOT NULL`,
          language: books.language,
          readCount: books.readCount,
          totalPages: books.totalPages,
          branchesCount: books.branchesCount,
          likesCount: books.likesCount,
          completeCount: books.completeCount,
          completionRate: books.completionRate,
          createdAt: books.createdAt,
          updatedAt: books.updatedAt,
        })
        .from(books)
        .where(whereClause)
        .orderBy(desc(books.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(books)
        .where(whereClause);

      const total = Number(count);
      const payload: {
        total: number;
        limit: number;
        offset: number;
        books: typeof rows;
        summary?: {
          totalBooks: number;
          totalReads: number;
          totalPages: number;
          totalBranches: number;
          totalLikes: number;
          avgCompletionRate: number | null;
        };
      } = { total, limit: limitNum, offset: offsetNum, books: rows };

      if (includeSummary === "true") {
        const [agg] = await dbRead
          .select({
            totalReads: sql<number>`coalesce(sum(${books.readCount}), 0)`,
            totalPages: sql<number>`coalesce(sum(${books.totalPages}), 0)`,
            totalBranches: sql<number>`coalesce(sum(${books.branchesCount}), 0)`,
            totalLikes: sql<number>`coalesce(sum(${books.likesCount}), 0)`,
            avgCompletionRate: sql<number | null>`avg(${books.completionRate})`,
          })
          .from(books)
          .where(whereClause);

        payload.summary = {
          totalBooks: total,
          totalReads: Number(agg?.totalReads ?? 0),
          totalPages: Number(agg?.totalPages ?? 0),
          totalBranches: Number(agg?.totalBranches ?? 0),
          totalLikes: Number(agg?.totalLikes ?? 0),
          avgCompletionRate:
            agg?.avgCompletionRate == null ? null : Number(agg.avgCompletionRate),
        };
      }

      return c.json(payload);
    } catch (error) {
      return cApiError(c, "Failed to list books", error);
    }
  }
);

// ============================================================================
// USERS ADMIN ROUTES (P4)
// ============================================================================

/**
 * GET /admin/users
 *
 * Lists platform users with search, banned filter, and pagination.
 * Query: search, banned=true|false, limit, offset
 */
router.get("/users",
  requireAuth,
  requirePermission("users"),
  async (c) => {
    try {
      const { search, banned, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (typeof search === "string" && search.length > 0) {
        conditions.push(or(
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
          ilike(users.username, `%${search}%`),
        ));
      }
      if (banned === "true") {
        conditions.push(isNotNull(users.bannedAt));
      } else if (banned === "false") {
        conditions.push(isNull(users.bannedAt));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await dbRead
        .select({
          userId: users.userId,
          name: users.name,
          username: users.username,
          email: users.email,
          tier: users.tier,
          credits: users.credits,
          isNewUser: users.isNewUser,
          lastActive: users.lastActive,
          createdAt: users.createdAt,
          bannedAt: users.bannedAt,
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(whereClause);

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, users: rows });
    } catch (error) {
      return cApiError(c, "Failed to list users", error);
    }
  }
);

/**
 * PATCH /admin/users/:userId/ban
 *
 * Sets banned_at, bumps token_version, deletes auth sessions (immediate lockout).
 * Cannot ban SYSTEM_USER_ID (super admin).
 */
router.patch(
  "/users/:userId/ban",
  requireAuth,
  requirePermission("users"),
  async (c) => {
    try {
      const { userId } = c.req.param();
      if (!userId) {
        return cValidationError(c, "userId is required");
      }
      if (isSuperAdminUserId(userId)) {
        return cValidationError(c, "Cannot ban the super admin account");
      }

      const [existing] = await dbRead
        .select({ userId: users.userId, bannedAt: users.bannedAt })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "User not found");
      }
      if (existing.bannedAt) {
        return c.json({
          userId,
          bannedAt: existing.bannedAt,
          alreadyBanned: true,
        });
      }

      const adminId = c.get("userId");
      const body = c.get("body") as {
        reason?: string;
        violationType?: string;
        severity?: string;
        internalNotes?: string;
      } | undefined;

      const reason = body?.reason?.trim() || "Account banned by system administrator";
      const violationType = (body?.violationType as any) || "other";
      const severity = (body?.severity as any) || "critical";
      const internalNotes = body?.internalNotes?.trim() || null;

      // Apply enforcement action into disciplinary ledger (SSOT & dual-writes users.bannedAt)
      const actionRow = await applyEnforcementAction({
        userId,
        action: "permanent_ban",
        violationType,
        severity,
        reason,
        internalNotes,
        createdBy: adminId,
      });

      // Best-effort session wipe (tokenVersion already invalidates JWTs)
      try {
        const { logoutFromAllDevices } = await import("../services/session-manager.js");
        await logoutFromAllDevices(userId);
      } catch (err) {
        console.error(`[admin] ⚠️ Ban session wipe failed for ${userId}:`, err);
      }

      // Apply configurable content takedowns based on admin settings
      const appliedTakedowns: string[] = [];
      try {
        const settingsRows = await dbRead.select().from(adminSettings);
        const settings: Record<string, unknown> = {};
        for (const row of settingsRows) {
          settings[row.key] = row.value;
        }

        // Hide books from public pages
        if (settings["ban.hide_books"] === true) {
          await dbWrite
            .update(books)
            .set({ visibility: "private", updatedAt: new Date() })
            .where(eq(books.userId, userId));
          appliedTakedowns.push("hide_books");
          console.log(`[admin] 📚 Books hidden for banned user: ${userId}`);
        }

        // Anonymize comments (replace with [deleted])
        if (settings["ban.anonymize_comments"] === true) {
          // Comments table not imported - skip if not available
          // await dbWrite.update(comments).set({ content: "[deleted]" }).where(eq(comments.userId, userId));
          appliedTakedowns.push("anonymize_comments");
          console.log(`[admin] 💬 Comments anonymization queued for banned user: ${userId}`);
        }

        // Reject pending testimonials
        if (settings["ban.reject_testimonials"] === true) {
          await dbWrite
            .update(bookTestimonials)
            .set({ status: "rejected", updatedAt: new Date() })
            .where(eq(bookTestimonials.userId, userId));
          appliedTakedowns.push("reject_testimonials");
          console.log(`[admin] ⭐ Testimonials rejected for banned user: ${userId}`);
        }

        // Revoke sessions (already done above via logoutFromAllDevices)
        if (settings["ban.revoke_sessions"] === true) {
          appliedTakedowns.push("revoke_sessions");
        }
      } catch (takedownError) {
        console.error(`[admin] ⚠️ Content takedown partially failed for ${userId}:`, takedownError);
        // Don't fail the ban - takedowns are best-effort
      }

      console.log(`[admin] 🚫 User banned: ${userId} by ${adminId} (takedowns: ${appliedTakedowns.join(", ") || "none"})`);
      notifyForumUserBanned(userId, "admin_ban");
      await invalidateUserProfileCache(userId);

      return c.json({ userId, bannedAt: actionRow.createdAt, alreadyBanned: false, appliedTakedowns });
    } catch (error) {
      return cApiError(c, "Failed to ban user", error);
    }
  },
);

/**
 * PATCH /admin/users/:userId/unban
 *
 * Clears banned_at and revokes active ban actions in enforcement ledger.
 * Does not restore old sessions (user must sign in again).
 */
router.patch(
  "/users/:userId/unban",
  requireAuth,
  requirePermission("users"),
  async (c) => {
    try {
      const { userId } = c.req.param();
      if (!userId) {
        return cValidationError(c, "userId is required");
      }

      const [existing] = await dbRead
        .select({ userId: users.userId, bannedAt: users.bannedAt })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);

      if (!existing) {
        return cNotFoundError(c, "User not found");
      }
      if (!existing.bannedAt) {
        return c.json({ userId, bannedAt: null, alreadyUnbanned: true });
      }

      const adminId = c.get("userId");
      const body = c.get("body") as { notes?: string } | undefined;
      const reviewNotes = body?.notes?.trim() || "Unbanned by system administrator";

      // Revoke any active ban/suspension enforcement actions in ledger
      const activeActions = await getActiveEnforcementsForUser(userId);
      for (const act of activeActions) {
        if (act.action === "permanent_ban" || act.action === "suspend") {
          await revokeEnforcementAction(act.id, adminId, reviewNotes);
        }
      }

      // Ensure users.bannedAt is cleared (dual-write bridge)
      const [updated] = await dbWrite
        .update(users)
        .set({
          bannedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.userId, userId))
        .returning({
          userId: users.userId,
          bannedAt: users.bannedAt,
        });

      console.log(`[admin] ✅ User unbanned: ${userId} by ${adminId}`);
      notifyForumUserUnbanned(userId);
      await invalidateUserProfileCache(userId);

      return c.json({ userId: updated.userId, bannedAt: updated.bannedAt, alreadyUnbanned: false });
    } catch (error) {
      return cApiError(c, "Failed to unban user", error);
    }
  },
);

// ============================================================================
// PORTAL BLOG POSTS CMS (portal.twistloom.com/blog)
// ============================================================================

function isBlogPostStatus(value: unknown): value is "draft" | "published" | "archived" {
  return value === "draft" || value === "published" || value === "archived";
}

function slugifyBlogTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || `post-${Date.now()}`;
}

/**
 * GET /admin/blog-posts
 *
 * Lists portal blog posts for the CMS. Filter by status; paginate with limit/offset.
 */
router.get(
  "/blog-posts",
  requireAuth,
  requirePermission("blog"),
  async (c) => {
    try {
      const { status, limit = "50", offset = "0", search } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (isBlogPostStatus(status)) {
        conditions.push(eq(portalBlogPosts.status, status));
      }
      if (typeof search === "string" && search.length > 0) {
        conditions.push(
          or(
            ilike(portalBlogPosts.title, `%${search}%`),
            ilike(portalBlogPosts.slug, `%${search}%`),
          ),
        );
      }

      const rows = await dbRead
        .select()
        .from(portalBlogPosts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(portalBlogPosts.updatedAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(portalBlogPosts)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, posts: rows });
    } catch (error) {
      return cApiError(c, "Failed to list blog posts", error);
    }
  },
);

/**
 * GET /admin/blog-posts/:id
 */
router.get(
  "/blog-posts/:id",
  requireAuth,
  requirePermission("blog"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const [post] = await dbRead
        .select()
        .from(portalBlogPosts)
        .where(eq(portalBlogPosts.id, id))
        .limit(1);
      if (!post) return cNotFoundError(c, "Blog post not found");
      return c.json(post);
    } catch (error) {
      return cApiError(c, "Failed to get blog post", error);
    }
  },
);

/**
 * POST /admin/blog-posts
 *
 * Creates a draft (or published) portal blog post.
 */
router.post(
  "/blog-posts",
  requireAuth,
  requirePermission("blog"),
  async (c) => {
    try {
      const body = c.get("body") as {
        slug?: string;
        title?: string;
        description?: string;
        excerpt?: string;
        bodyHtml?: string;
        coverUrl?: string;
        authorName?: string;
        status?: string;
        publishedAt?: string | null;
      };

      if (!body?.title || typeof body.title !== "string" || !body.title.trim()) {
        return cValidationError(c, "title is required");
      }
      if (!body?.bodyHtml || typeof body.bodyHtml !== "string" || !body.bodyHtml.trim()) {
        return cValidationError(c, "bodyHtml is required");
      }
      if (body.status !== undefined && !isBlogPostStatus(body.status)) {
        return cValidationError(c, "Invalid status. Must be draft | published | archived");
      }

      const status = isBlogPostStatus(body.status) ? body.status : "draft";
      const slugRaw =
        typeof body.slug === "string" && body.slug.trim().length > 0
          ? body.slug.trim().toLowerCase()
          : slugifyBlogTitle(body.title);
      const slug = slugRaw.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

      let publishedAt: Date | null = null;
      if (status === "published") {
        publishedAt = body.publishedAt ? new Date(body.publishedAt) : new Date();
      } else if (body.publishedAt) {
        publishedAt = new Date(body.publishedAt);
      }

      const bodyHtml = await sanitizeBlogHtml(body.bodyHtml);
      if (!bodyHtml.trim()) {
        return cValidationError(c, "bodyHtml is empty after sanitization");
      }

      const [created] = await dbWrite
        .insert(portalBlogPosts)
        .values({
          slug,
          title: body.title.trim(),
          description: body.description?.trim() || null,
          excerpt: body.excerpt?.trim() || null,
          bodyHtml,
          coverUrl: body.coverUrl?.trim() || null,
          authorName: body.authorName?.trim() || null,
          authorId: c.get("userId") ?? null,
          status,
          publishedAt,
        })
        .returning();

      return c.json(created, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (msg.includes("portal_blog_posts_slug_unique") || msg.includes("unique")) {
        return cValidationError(c, "A post with this slug already exists");
      }
      return cApiError(c, "Failed to create blog post", error);
    }
  },
);

/**
 * PATCH /admin/blog-posts/:id
 */
router.patch(
  "/blog-posts/:id",
  requireAuth,
  requirePermission("blog"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const body = c.get("body") as {
        slug?: string;
        title?: string;
        description?: string | null;
        excerpt?: string | null;
        bodyHtml?: string;
        coverUrl?: string | null;
        authorName?: string | null;
        status?: string;
        publishedAt?: string | null;
      };

      const [existing] = await dbRead
        .select()
        .from(portalBlogPosts)
        .where(eq(portalBlogPosts.id, id))
        .limit(1);
      if (!existing) return cNotFoundError(c, "Blog post not found");

      if (body.status !== undefined && !isBlogPostStatus(body.status)) {
        return cValidationError(c, "Invalid status. Must be draft | published | archived");
      }

      const updates: Partial<typeof portalBlogPosts.$inferInsert> = {};
      if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
      if (typeof body.bodyHtml === "string") {
        const cleaned = await sanitizeBlogHtml(body.bodyHtml);
        if (!cleaned.trim()) {
          return cValidationError(c, "bodyHtml is empty after sanitization");
        }
        updates.bodyHtml = cleaned;
      }
      if (body.description !== undefined) {
        updates.description = body.description === null ? null : String(body.description).trim() || null;
      }
      if (body.excerpt !== undefined) {
        updates.excerpt = body.excerpt === null ? null : String(body.excerpt).trim() || null;
      }
      if (body.coverUrl !== undefined) {
        updates.coverUrl = body.coverUrl === null ? null : String(body.coverUrl).trim() || null;
      }
      if (body.authorName !== undefined) {
        updates.authorName = body.authorName === null ? null : String(body.authorName).trim() || null;
      }
      if (typeof body.slug === "string" && body.slug.trim()) {
        updates.slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
      }
      if (isBlogPostStatus(body.status)) {
        updates.status = body.status;
        if (body.status === "published" && !existing.publishedAt && body.publishedAt === undefined) {
          updates.publishedAt = new Date();
        }
      }
      if (body.publishedAt !== undefined) {
        updates.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
      }

      if (Object.keys(updates).length === 0) {
        return c.json(existing);
      }

      const [updated] = await dbWrite
        .update(portalBlogPosts)
        .set(updates)
        .where(eq(portalBlogPosts.id, id))
        .returning();

      return c.json(updated);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (msg.includes("portal_blog_posts_slug_unique") || msg.includes("unique")) {
        return cValidationError(c, "A post with this slug already exists");
      }
      return cApiError(c, "Failed to update blog post", error);
    }
  },
);

/**
 * DELETE /admin/blog-posts/:id
 */
router.delete(
  "/blog-posts/:id",
  requireAuth,
  requirePermission("blog"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const [deleted] = await dbWrite
        .delete(portalBlogPosts)
        .where(eq(portalBlogPosts.id, id))
        .returning({ id: portalBlogPosts.id });
      if (!deleted) return cNotFoundError(c, "Blog post not found");
      return c.json({ success: true, id: deleted.id });
    } catch (error) {
      return cApiError(c, "Failed to delete blog post", error);
    }
  },
);

// ── Voucher Campaigns (admin) ────────────────────────────────────────────────

router.get("/vouchers", requireAuth, requirePermission("vouchers"), async (c) => {
  try {
    const { listCampaigns } = await import("../services/voucher.js");
    const campaigns = await listCampaigns();
    return c.json(campaigns);
  } catch (error) {
    return cApiError(c, "Failed to list voucher campaigns", error);
  }
});

router.get("/vouchers/:id", requireAuth, requirePermission("vouchers"), async (c) => {
  try {
    const { id } = c.req.param();
    const { getCampaign } = await import("../services/voucher.js");
    const campaign = await getCampaign(id);
    if (!campaign) return cNotFoundError(c, "Campaign not found");
    return c.json(campaign);
  } catch (error) {
    return cApiError(c, "Failed to get voucher campaign", error);
  }
});

router.post("/vouchers", requireAuth, requirePermission("vouchers"), async (c) => {
  try {
    const userId = c.get("userId");
    const body = c.get("body") as Record<string, unknown>;
    if (!body?.slug || !body?.displayName || !body?.creditsPerRedemption || !body?.maxRedemptions) {
      return cValidationError(c, "slug, displayName, creditsPerRedemption, and maxRedemptions are required");
    }
    const { createCampaign } = await import("../services/voucher.js");
    const campaign = await createCampaign({
      slug: body.slug as string,
      displayName: body.displayName as string,
      internalPurpose: (body.internalPurpose as string) ?? "",
      creditsPerRedemption: body.creditsPerRedemption as number,
      maxRedemptions: body.maxRedemptions as number,
      maxRedemptionsPerUser: (body.maxRedemptionsPerUser as number) ?? 1,
      startsAt: body.startsAt ? new Date(body.startsAt as string) : null,
      endsAt: body.endsAt ? new Date(body.endsAt as string) : null,
      eligibilityPolicy: (body.eligibilityPolicy as string) ?? "open",
      distributionType: (body.distributionType as string) ?? "single_use_batch",
      createdByUserId: userId!,
    });
    return c.json(campaign, 201);
  } catch (error) {
    return cApiError(c, "Failed to create voucher campaign", error);
  }
});

router.patch("/vouchers/:id", requireAuth, requirePermission("vouchers"), async (c) => {
  try {
    const { id } = c.req.param();
    const body = c.get("body") as Record<string, unknown>;
    const { updateCampaign } = await import("../services/voucher.js");
    const campaign = await updateCampaign(id, {
      displayName: body.displayName as string | undefined,
      internalPurpose: body.internalPurpose as string | undefined,
      status: body.status as string | undefined,
      creditsPerRedemption: body.creditsPerRedemption as number | undefined,
      maxRedemptions: body.maxRedemptions as number | undefined,
      maxRedemptionsPerUser: body.maxRedemptionsPerUser as number | undefined,
      startsAt: body.startsAt !== undefined ? (body.startsAt ? new Date(body.startsAt as string) : null) : undefined,
      endsAt: body.endsAt !== undefined ? (body.endsAt ? new Date(body.endsAt as string) : null) : undefined,
    });
    if (!campaign) return cNotFoundError(c, "Campaign not found");
    return c.json(campaign);
  } catch (error) {
    return cApiError(c, "Failed to update voucher campaign", error);
  }
});

router.post("/vouchers/generate-codes", requireAuth, requirePermission("vouchers"), async (c) => {
  try {
    const body = c.get("body") as { campaignId?: string; count?: number };
    if (!body?.campaignId || !body?.count) {
      return cValidationError(c, "campaignId and count are required");
    }
    if (body.count < 1 || body.count > 1000) {
      return cValidationError(c, "count must be between 1 and 1000");
    }
    const { generateCodes } = await import("../services/voucher.js");
    const result = await generateCodes(body.campaignId, body.count);
    return c.json(result, 201);
  } catch (error) {
    return cApiError(c, "Failed to generate voucher codes", error);
  }
});

// ── Admin Payout Management ─────────────────────────────────────────────────

/**
 * GET /admin/payouts
 *
 * Lists payout requests with creator details. Filters by status.
 * Joins with creator_wallets for available balance and creator_payout_methods
 * for bank details. Also joins users for creator name/email.
 */
router.get("/payouts",
  requireAuth,
  requirePermission("payouts"),
  async (c) => {
    try {
      const { status, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const conditions = [];
      if (status === "pending" || status === "processing" || status === "completed" || status === "failed") {
        conditions.push(eq(creatorPayouts.status, status));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Get payouts with creator info
      const rows = await dbRead
        .select({
          id: creatorPayouts.id,
          creatorId: creatorPayouts.creatorId,
          amount: creatorPayouts.amount,
          fee: creatorPayouts.fee,
          netAmount: creatorPayouts.netAmount,
          currency: creatorPayouts.currency,
          status: creatorPayouts.status,
          providerPayoutId: creatorPayouts.providerPayoutId,
          failureReason: creatorPayouts.failureReason,
          createdAt: creatorPayouts.createdAt,
          updatedAt: creatorPayouts.updatedAt,
          // Creator info
          creatorName: users.name,
          creatorEmail: users.email,
          // Wallet info
          walletAvailable: creatorWallets.availableAmount,
          walletPending: creatorWallets.pendingAmount,
          walletWithdrawn: creatorWallets.withdrawnAmount,
          walletCurrency: creatorWallets.currency,
        })
        .from(creatorPayouts)
        .leftJoin(users, eq(creatorPayouts.creatorId, users.userId))
        .leftJoin(creatorWallets, eq(creatorPayouts.creatorId, creatorWallets.creatorId))
        .where(whereClause)
        .orderBy(desc(creatorPayouts.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(creatorPayouts)
        .where(whereClause);

      // Enrich with payout method details (bank info)
      const creatorIds = [...new Set(rows.map((r) => r.creatorId))];
      const payoutMethods = creatorIds.length > 0
        ? await dbRead
            .select()
            .from(creatorPayoutMethods)
            .where(sql`${creatorPayoutMethods.creatorId} IN ${creatorIds} AND ${creatorPayoutMethods.isDefault} = true`)
        : [];
      const payoutMethodMap = new Map(payoutMethods.map((pm) => [pm.creatorId, pm]));

      const enriched = rows.map((r) => ({
        ...r,
        payoutMethod: payoutMethodMap.get(r.creatorId) ?? null,
      }));

      return c.json({ total: Number(count), limit: limitNum, offset: offsetNum, payouts: enriched });
    } catch (error) {
      return cApiError(c, "Failed to list payouts", error);
    }
  }
);

/**
 * GET /admin/payouts/:id
 *
 * Single payout with full creator + payout method details.
 */
router.get("/payouts/:id",
  requireAuth,
  requirePermission("payouts"),
  async (c) => {
    try {
      const { id } = c.req.param();

      const [row] = await dbRead
        .select({
          id: creatorPayouts.id,
          creatorId: creatorPayouts.creatorId,
          amount: creatorPayouts.amount,
          fee: creatorPayouts.fee,
          netAmount: creatorPayouts.netAmount,
          currency: creatorPayouts.currency,
          status: creatorPayouts.status,
          providerPayoutId: creatorPayouts.providerPayoutId,
          failureReason: creatorPayouts.failureReason,
          metadata: creatorPayouts.metadata,
          createdAt: creatorPayouts.createdAt,
          updatedAt: creatorPayouts.updatedAt,
          creatorName: users.name,
          creatorEmail: users.email,
          walletAvailable: creatorWallets.availableAmount,
          walletPending: creatorWallets.pendingAmount,
          walletWithdrawn: creatorWallets.withdrawnAmount,
        })
        .from(creatorPayouts)
        .leftJoin(users, eq(creatorPayouts.creatorId, users.userId))
        .leftJoin(creatorWallets, eq(creatorPayouts.creatorId, creatorWallets.creatorId))
        .where(eq(creatorPayouts.id, id))
        .limit(1);

      if (!row) {
        return cNotFoundError(c, "Payout not found");
      }

      // Get payout method
      const [payoutMethod] = await dbRead
        .select()
        .from(creatorPayoutMethods)
        .where(and(
          eq(creatorPayoutMethods.creatorId, row.creatorId),
          eq(creatorPayoutMethods.isDefault, true),
        ))
        .limit(1);

      return c.json({ ...row, payoutMethod: payoutMethod ?? null });
    } catch (error) {
      return cApiError(c, "Failed to get payout", error);
    }
  }
);

/**
 * PATCH /admin/payouts/:id
 *
 * Update payout status. Supports:
 * - processing: Admin has started processing the payout
 * - completed: Payout sent successfully
 * - failed: Payout failed (requires failureReason)
 */
router.patch("/payouts/:id",
  requireAuth,
  requirePermission("payouts"),
  async (c) => {
    try {
      const { id } = c.req.param();
      const body = c.get("body") as { status?: string; failureReason?: string; providerPayoutId?: string };

      if (!body.status || !["processing", "completed", "failed"].includes(body.status)) {
        return cValidationError(c, "status must be one of: processing, completed, failed");
      }

      const newStatus = body.status as "processing" | "completed" | "failed";

      // Validate status transitions
      const validTransitions: Record<string, string[]> = {
        pending: ["processing", "failed"],
        processing: ["completed", "failed"],
      };

      // Atomic read-validate-write inside a transaction with row-level lock
      const updated = await dbWrite.transaction(async (tx) => {
        // Lock the row to prevent concurrent status transitions
        const [existing] = await tx
          .select()
          .from(creatorPayouts)
          .where(eq(creatorPayouts.id, id))
          .for('update')
          .limit(1);

        if (!existing) {
          return null;
        }

        if (!validTransitions[existing.status]?.includes(newStatus)) {
          throw new Error(`Cannot transition from '${existing.status}' to '${newStatus}'`);
        }

        // If marking as failed, refund the wallet (pending -> available)
        if (newStatus === "failed") {
          await tx
            .update(creatorWallets)
            .set({
              availableAmount: sql`${creatorWallets.availableAmount} + ${existing.amount}`,
              pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${existing.amount})`,
              updatedAt: new Date(),
            })
            .where(eq(creatorWallets.creatorId, existing.creatorId));
        }

        // If marking as completed, finalize the withdrawal (pending -> withdrawn)
        if (newStatus === "completed") {
          await tx
            .update(creatorWallets)
            .set({
              pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${existing.amount})`,
              withdrawnAmount: sql`${creatorWallets.withdrawnAmount} + ${existing.amount}`,
              updatedAt: new Date(),
            })
            .where(eq(creatorWallets.creatorId, existing.creatorId));
        }

        // Update with conditional WHERE to detect concurrent modifications
        const [result] = await tx
          .update(creatorPayouts)
          .set({
            status: newStatus,
            ...(newStatus === "failed"
              ? { failureReason: body.failureReason || null }
              : { providerPayoutId: body.providerPayoutId || existing.providerPayoutId, failureReason: null }),
            updatedAt: new Date(),
          })
          .where(and(eq(creatorPayouts.id, id), eq(creatorPayouts.status, existing.status)))
          .returning();

        return result ?? null;
      });

      if (!updated) {
        return cValidationError(c, "Concurrent modification detected; please retry.");
      }

      return c.json(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update payout";
      if (message.startsWith("Cannot transition")) {
        return cValidationError(c, message);
      }
      return cApiError(c, "Failed to update payout", error);
    }
  }
);

/**
 * GET /admin/payouts/stats
 *
 * Aggregate payout stats for the admin dashboard.
 */
router.get("/payouts/stats",
  requireAuth,
  requirePermission("payouts"),
  async (c) => {
    try {
      const [stats] = await dbRead
        .select({
          totalPending: sql<number>`COALESCE(SUM(CASE WHEN ${creatorPayouts.status} = 'pending' THEN ${creatorPayouts.amount} ELSE 0 END), 0)`,
          totalProcessing: sql<number>`COALESCE(SUM(CASE WHEN ${creatorPayouts.status} = 'processing' THEN ${creatorPayouts.amount} ELSE 0 END), 0)`,
          totalCompleted: sql<number>`COALESCE(SUM(CASE WHEN ${creatorPayouts.status} = 'completed' THEN ${creatorPayouts.amount} ELSE 0 END), 0)`,
          totalFailed: sql<number>`COALESCE(SUM(CASE WHEN ${creatorPayouts.status} = 'failed' THEN ${creatorPayouts.amount} ELSE 0 END), 0)`,
          countPending: sql<number>`COUNT(CASE WHEN ${creatorPayouts.status} = 'pending' THEN 1 END)`,
          countProcessing: sql<number>`COUNT(CASE WHEN ${creatorPayouts.status} = 'processing' THEN 1 END)`,
          countCompleted: sql<number>`COUNT(CASE WHEN ${creatorPayouts.status} = 'completed' THEN 1 END)`,
          countFailed: sql<number>`COUNT(CASE WHEN ${creatorPayouts.status} = 'failed' THEN 1 END)`,
        })
        .from(creatorPayouts);

      return c.json(stats);
    } catch (error) {
      return cApiError(c, "Failed to fetch payout stats", error);
    }
  }
);

// ── Admin Settings (super admin only) ───────────────────────────────────────

/**
 * Default settings seed (used for upsert on first access).
 */
const DEFAULT_ADMIN_SETTINGS: Record<string, unknown> = {
  "ban.hide_books": false,
  "ban.anonymize_comments": false,
  "ban.reject_testimonials": false,
  "ban.revoke_sessions": false,
  "moderation.auto_reject_testimonial_score": 3.0,
  "moderation.auto_approve_mention_score": 4.0,
};

/**
 * GET /admin/settings
 *
 * List all admin settings. Super admin only.
 * Auto-seeds default settings if table is empty.
 */
router.get("/settings", requireAuth, requireSuperAdmin, async (c) => {
  try {
    let rows = await dbRead.select().from(adminSettings);

    // Auto-seed defaults if empty
    if (rows.length === 0) {
      const seedRows = Object.entries(DEFAULT_ADMIN_SETTINGS).map(([key, value]) => ({
        key,
        value,
        updatedBy: null,
      }));
      rows = await dbWrite.insert(adminSettings).values(seedRows).onConflictDoNothing().returning();
    }

    // Convert to key-value record for frontend consumption
    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }

    return c.json({ settings });
  } catch (error) {
    return cApiError(c, "Failed to list settings", error);
  }
});

/**
 * GET /admin/settings/:key
 *
 * Get a single setting by key. Super admin only.
 */
router.get("/settings/:key", requireAuth, requireSuperAdmin, async (c) => {
  try {
    const { key } = c.req.param();

    const [row] = await dbRead
      .select()
      .from(adminSettings)
      .where(eq(adminSettings.key, key))
      .limit(1);

    if (!row) {
      // Return default if exists
      if (key in DEFAULT_ADMIN_SETTINGS) {
        return c.json({ key, value: DEFAULT_ADMIN_SETTINGS[key] });
      }
      return cNotFoundError(c, "Setting not found");
    }

    return c.json({ key: row.key, value: row.value });
  } catch (error) {
    return cApiError(c, "Failed to get setting", error);
  }
});

/**
 * PATCH /admin/settings/:key
 *
 * Update a single setting. Super admin only.
 * Creates the setting if it doesn't exist (upsert).
 */
router.patch("/settings/:key", requireAuth, requireSuperAdmin, async (c) => {
  try {
    const { key } = c.req.param();
    const body = c.get("body") as { value?: unknown };

    if (body.value === undefined) {
      return cValidationError(c, "value is required");
    }

    // Validate known setting keys and their types
    const validKeys = Object.keys(DEFAULT_ADMIN_SETTINGS);
    if (!validKeys.includes(key)) {
      return cValidationError(c, `Invalid setting key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    }

    // Type validation for specific keys
    if (key.startsWith("ban.")) {
      if (typeof body.value !== "boolean") {
        return cValidationError(c, `Setting ${key} must be a boolean`);
      }
    } else if (key.startsWith("moderation.")) {
      if (typeof body.value !== "number" || body.value < 0 || body.value > 5) {
        return cValidationError(c, `Setting ${key} must be a number between 0 and 5`);
      }
    }

    const userId = c.get("userId");

    // Upsert: insert or update
    const [result] = await dbWrite
      .insert(adminSettings)
      .values({
        key,
        value: body.value,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: adminSettings.key,
        set: {
          value: body.value,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      })
      .returning();

    return c.json({ key: result.key, value: result.value });
  } catch (error) {
    return cApiError(c, "Failed to update setting", error);
  }
});

/**
 * PATCH /admin/settings
 *
 * Bulk update multiple settings at once. Super admin only.
 */
router.patch("/settings", requireAuth, requireSuperAdmin, async (c) => {
  try {
    const body = c.get("body") as { settings?: Record<string, unknown> };

    if (!body.settings || typeof body.settings !== "object") {
      return cValidationError(c, "settings object is required");
    }

    const userId = c.get("userId");
    const validKeys = Object.keys(DEFAULT_ADMIN_SETTINGS);
    const results: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body.settings)) {
      if (!validKeys.includes(key)) {
        continue; // Skip invalid keys silently
      }

      // Type validation
      if (key.startsWith("ban.") && typeof value !== "boolean") {
        continue;
      }
      if (key.startsWith("moderation.") && (typeof value !== "number" || value < 0 || value > 5)) {
        continue;
      }

      const [result] = await dbWrite
        .insert(adminSettings)
        .values({ key, value, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: adminSettings.key,
          set: { value, updatedBy: userId, updatedAt: new Date() },
        })
        .returning();

      results[result.key] = result.value;
    }

    return c.json({ settings: results });
  } catch (error) {
    return cApiError(c, "Failed to update settings", error);
  }
});

// ============================================================================
// HELP CENTER FEEDBACK ADMIN ROUTES
// ============================================================================

/**
 * GET /admin/help-feedbacks
 *
 * Lists help center article feedback votes for admin review. Supports
 * vote filter and pagination. Joins with users for the voter's name.
 *
 * @query {string} [vote] - Optional filter: "helpful" | "not_helpful"
 * @query {number} [limit] - Max rows (default: 50, max: 200)
 * @query {number} [offset] - Rows to skip (default: 0)
 */
router.get("/help-feedbacks",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const { vote, limit = "50", offset = "0" } = c.req.query();
      const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const offsetNum = Math.max(Number(offset) || 0, 0);

      const { helpArticleFeedback } = await import("../db/schema.js");

      const conditions = [];
      if (vote === "helpful" || vote === "not_helpful") {
        conditions.push(eq(helpArticleFeedback.vote, vote));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await dbRead
        .select({
          articleId: helpArticleFeedback.articleId,
          userId: helpArticleFeedback.userId,
          vote: helpArticleFeedback.vote,
          createdAt: helpArticleFeedback.createdAt,
          userName: users.name,
        })
        .from(helpArticleFeedback)
        .leftJoin(users, eq(helpArticleFeedback.userId, users.userId))
        .where(whereClause)
        .orderBy(desc(helpArticleFeedback.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      const [{ count }] = await dbRead
        .select({ count: sql<number>`count(*)` })
        .from(helpArticleFeedback)
        .where(whereClause);

      return c.json({
        total: Number(count),
        limit: limitNum,
        offset: offsetNum,
        feedbacks: rows,
      });
    } catch (error) {
      return cApiError(c, "Failed to list help feedbacks", error);
    }
  }
);

/**
 * DELETE /admin/help-feedbacks/:articleId/:userId
 *
 * Deletes a single help feedback entry. Used to remove spam or
 * administrative corrections.
 */
router.delete("/help-feedbacks/:articleId/:userId",
  requireAuth,
  requirePermission("feedbacks"),
  async (c) => {
    try {
      const { articleId, userId } = c.req.param();

      const { helpArticleFeedback } = await import("../db/schema.js");

      const [deleted] = await dbWrite
        .delete(helpArticleFeedback)
        .where(
          and(
            eq(helpArticleFeedback.articleId, articleId),
            eq(helpArticleFeedback.userId, userId),
          ),
        )
        .returning({ id: helpArticleFeedback.id });

      if (!deleted) {
        return cNotFoundError(c, "Help feedback not found");
      }

      return c.json({ success: true });
    } catch (error) {
      return cApiError(c, "Failed to delete help feedback", error);
    }
  }
);

export default router;
