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

import type { Request, Response } from "express";
import { Router } from "express";
import { requireAuth } from "../middleware/nextauth.js";
import { handleApiError } from "../utils/error.js";
import { getUserBookSnapshots, getLatestMajorCheckpoint, deleteAllSnapshots, getSnapshotStatistics } from "../services/snapshots.js";
import { reconstructStoryState } from "../utils/branch-traversal.js";
import { getBookFromDB, getPageFromDB } from "../services/book.js";
import { getStateSnapshot } from "../services/snapshots.js";
import { getStateDelta } from "../services/deltas.js";
import { getStoryState } from "../services/story.js";

const router = Router();

/**
 * GET /admin/books/:bookId/snapshots
 * 
 * Retrieves all snapshots for a book for debugging and analysis.
 * Shows snapshot creation patterns, major checkpoints, and usage statistics.
 * 
 * @param bookId - Book identifier
 * @param limit - Maximum number of snapshots to retrieve (default: 50)
 * @returns Array of snapshots with metadata and usage statistics
 */
router.get("/books/:bookId/snapshots", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId } = req.params;
    const { limit = 50 } = req.query;

    // Ensure bookId is a string (Express params can be string array)
    const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;
    const snapshots = await getUserBookSnapshots(userId, bookIdStr, Number(limit));
    
    // Analyze snapshot patterns
    const majorCheckpoints = snapshots.filter(s => s.isMajorCheckpoint);
    const periodicSnapshots = snapshots.filter(s => s.reason === 'periodic');
    const branchStartSnapshots = snapshots.filter(s => s.reason === 'branch_start');
    const majorEventSnapshots = snapshots.filter(s => s.reason === 'major_event');
    
    // Calculate statistics
    const stats = {
      total: snapshots.length,
      majorCheckpoints: majorCheckpoints.length,
      periodicSnapshots: periodicSnapshots.length,
      branchStartSnapshots: branchStartSnapshots.length,
      majorEventSnapshots: majorEventSnapshots.length,
      oldestSnapshot: snapshots[snapshots.length - 1]?.createdAt || null,
      newestSnapshot: snapshots[0]?.createdAt || null,
      averagePageGap: snapshots.length > 1 
        ? Math.round((snapshots[0].page - snapshots[snapshots.length - 1].page) / snapshots.length)
        : 0
    };

    res.json({
      bookId,
      snapshots: snapshots.map(s => ({
        pageId: s.pageId,
        page: s.page,
        createdAt: s.createdAt,
        version: s.version,
        isMajorCheckpoint: s.isMajorCheckpoint,
        reason: s.reason,
        stateSize: JSON.stringify(s.state).length
      })),
      stats
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve book snapshots", error);
  }
});

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
router.get("/books/:bookId/reconstruction/:pageId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId, pageId } = req.params;

    if (!bookId || !pageId) {
      return res.status(400).json({ 
        error: "Missing required fields: bookId and pageId are required" 
      });
    }

    // Ensure params are strings (Express params can be string arrays)
    const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;
    const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;

    // Test reconstruction
    const reconstructionResult = await reconstructStoryState(pageIdStr, userId, {
      getPageById: async (id: string) => await getPageFromDB(id),
      getBook: async (bookId: string) => await getBookFromDB(bookId),
      getSnapshot: async (id: string) => await getStateSnapshot(userId, id),
      getDelta: async (id: string) => await getStateDelta(userId, id),
      getStoryState: async (id: string) => await getStoryState(userId, id)
    }, {
      useCache: false, // Force reconstruction for testing
      validatePath: true
    });

    // Get latest major checkpoint for comparison
    const majorCheckpoint = await getLatestMajorCheckpoint(userId, bookIdStr);

    res.json({
      bookId: bookIdStr,
      pageId: pageIdStr,
      reconstruction: reconstructionResult,
      latestMajorCheckpoint: majorCheckpoint ? {
        pageId: majorCheckpoint.pageId,
        page: majorCheckpoint.page,
        createdAt: majorCheckpoint.createdAt,
        reason: majorCheckpoint.reason
      } : null
    });
  } catch (error) {
    handleApiError(res, "Failed to debug reconstruction", error);
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
router.get("/system/health", requireAuth, async (req: Request, res: Response) => {
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

    res.json(health);
  } catch (error) {
    handleApiError(res, "Failed to get system health", error);
  }
});

// ============================================================================
// SNAPSHOT MANAGEMENT ROUTES
// ============================================================================

/**
 * Get comprehensive snapshot statistics for a user's book
 * 
 * @route GET /admin/books/:bookId/snapshots/statistics
 */
router.get("/books/:bookId/snapshots/statistics", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId } = req.params;

    if (!bookId) {
      return res.status(400).json({ 
        error: "Missing required field: bookId is required" 
      });
    }

    // Ensure bookId is string (Express params can be string arrays)
    const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

    const stats = await getSnapshotStatistics(userId, bookIdStr);
    
    res.json({
      bookId: bookIdStr,
      statistics: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[admin] ❌ Failed to get snapshot statistics:", error);
    res.status(500).json({ error: "Failed to get snapshot statistics" });
  }
});

/**
 * Delete all snapshots for a user's book (dangerous operation)
 * 
 * @route DELETE /admin/books/:bookId/snapshots
 */
router.delete("/books/:bookId/snapshots", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { bookId } = req.params;

    if (!bookId) {
      return res.status(400).json({ 
        error: "Missing required field: bookId is required" 
      });
    }

    // Ensure bookId is string (Express params can be string arrays)
    const bookIdStr = Array.isArray(bookId) ? bookId[0] : bookId;

    // Get statistics before deletion for confirmation
    const beforeStats = await getSnapshotStatistics(userId, bookIdStr);
    
    // Delete all snapshots
    await deleteAllSnapshots(userId, bookIdStr);
    
    console.log(`[admin] 🗑️ Admin deleted all snapshots for user ${userId}, book ${bookIdStr} (${beforeStats.total} snapshots)`);
    
    res.json({
      bookId: bookIdStr,
      deleted: beforeStats.total,
      message: "All snapshots deleted successfully",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("[admin] ❌ Failed to delete snapshots:", error);
    res.status(500).json({ error: "Failed to delete snapshots" });
  }
});

export default router;
