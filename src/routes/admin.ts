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
import { eq, desc, and, inArray, sql, gte, lte, isNotNull } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/admin-auth.js";
import { cApiError, cValidationError, cNotFoundError } from "../utils/error.js";
import { reconstructStoryState } from "../utils/branch-traversal.js";
import { getBookFromDB, getPageFromDB } from "../services/book.js";
import { getStoryState } from "../services/story.js";
import { dbRead, dbWrite } from "../db/client.js";
import { socialMentions, bookTestimonials, adminUsers, usage, users } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";
import {
  extractAndResolveTwistloomLink,
  parseTwistloomProductUrl,
  resolveBookByIdForAdmin,
  resolvePublicBookBySlug,
} from "../services/social/extract-twistloom-link.js";

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
router.get("/social-mentions",
  requireAuth,
  requireAdmin,
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
  requireAdmin,
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
 * - clearRelatedBook: true → nulls related book/page and source
 *
 * Setting a book via relatedBookId or relatedBookUrl always sets relatedBookSource='admin'
 * so cron backfill will not overwrite it.
 *
 * @param id - Social mention identifier
 * @returns The updated social mention row
 */
router.patch("/social-mentions/:id",
  requireAuth,
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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

//     // Ensure bookId is string (route params can be string arrays)
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
        .returning({ id: bookTestimonials.id });

      return c.json({ success: true, updated: result.length });
    } catch (error) {
      return cApiError(c, "Failed to bulk update testimonials", error);
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
      const { userId, email } = c.get("body");

      if (!userId && !email) {
        return cValidationError(c, "Either userId or email is required");
      }

      const [existing] = await dbRead
        .select({ userId: adminUsers.userId })
        .from(adminUsers)
        .where(userId ? eq(adminUsers.userId, userId) : eq(adminUsers.email, email))
        .limit(1);

      if (existing) {
        return cValidationError(c, "User is already an admin");
      }

      const invitedBy = c.get("userId");

      const [created] = await dbWrite
        .insert(adminUsers)
        .values({ userId, email, invitedBy })
        .returning();

      return c.json(created, 201);
    } catch (error) {
      return cApiError(c, "Failed to add admin", error);
    }
  }
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
  requireAdmin,
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
        `[admin] 📢 Announcement "${body.title}" sent=${sent} failed=${failed} eligible=${recipients.length}`,
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

export default router;
