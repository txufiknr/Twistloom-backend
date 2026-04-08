/**
 * Story State Snapshots Service
 * 
 * Provides functionality for creating, retrieving, and managing story state snapshots.
 * Snapshots are complete checkpoints of the story state at specific points in the narrative,
 * enabling efficient state reconstruction using the Branch Traversal Algorithm.
 * 
 * Key Features:
 * - Automatic snapshot creation at strategic points
 * - Efficient snapshot retrieval for reconstruction
 * - Storage optimization and cleanup
 * - Version tracking and conflict resolution
 */

import { dbRead, dbWrite } from "../db/client.js";
import { storyStateSnapshots } from "../db/schema.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import type { PersistedStoryPage, SnapshotCreationDecision, StateSnapshot, StoryState } from "../types/story.js";
import { getErrorMessage } from "../utils/error.js";
import { getStoryPageById } from "./book.js";
import { 
  GET_SNAPSHOT_CIRCUIT_THRESHOLD,
  GET_SNAPSHOT_CIRCUIT_TIMEOUT,
  CREATE_SNAPSHOT_CIRCUIT_THRESHOLD,
  CREATE_SNAPSHOT_CIRCUIT_TIMEOUT,
  GET_SNAPSHOT_KEY_PREFIX,
  CREATE_SNAPSHOT_KEY_PREFIX
} from "../config/branch-traversal.js";
import { retryOperation, withCircuitBreaker, createReliabilityMeasurement, completeReliabilityMeasurement } from "../utils/reliability.js";

// ============================================================================
// SNAPSHOT RETRIEVAL
// ============================================================================

/**
 * Gets state snapshot for a specific page
 * 
 * @param userId - User identifier
 * @param pageId - Page identifier
 * @returns Promise resolving to snapshot or null if not found
 * 
 * @example
 * ```typescript
 * const snapshot = await getStateSnapshot("user123", "page456");
 * if (snapshot) {
 *   console.log(`Found snapshot from ${snapshot.createdAt}`);
 *   console.log(`State page: ${snapshot.page}`);
 * }
 * ```
 */
export async function getStateSnapshot(
  userId: string, 
  pageId: string
): Promise<StateSnapshot | null> {
  const measurement = createReliabilityMeasurement('snapshot_retrieval', 'snapshot_service', userId, {
    userId,
    pageId,
    operation: 'getStateSnapshot'
  });

  try {
    const snapshot = await withCircuitBreaker(
      () => retryOperation(async () => {
        const result = await dbRead
          .select()
          .from(storyStateSnapshots)
          .where(and(
            eq(storyStateSnapshots.userId, userId),
            eq(storyStateSnapshots.pageId, pageId)
          ))
          .limit(1);
          
        return result[0] || null;
      }),
      `${GET_SNAPSHOT_KEY_PREFIX}:${userId}`,
      GET_SNAPSHOT_CIRCUIT_THRESHOLD,
      GET_SNAPSHOT_CIRCUIT_TIMEOUT
    );
      
    if (!snapshot) {
      completeReliabilityMeasurement(measurement, true, {
        cached: false,
        snapshotFound: false
      });
      return null;
    }
    
    const result = {
      pageId: snapshot.pageId,
      page: snapshot.state.page,
      state: snapshot.state,
      createdAt: snapshot.createdAt,
      version: snapshot.version,
      isMajorCheckpoint: snapshot.isMajorCheckpoint,
      reason: snapshot.reason as 'periodic' | 'major_event' | 'branch_start' | 'user_request'
    };

    completeReliabilityMeasurement(measurement, true, {
      cached: false,
      snapshotFound: true,
      isMajorCheckpoint: result.isMajorCheckpoint,
      snapshotVersion: result.version
    });

    return result;
  } catch (error) {
    console.error(`[getStateSnapshot] ❌ Failed to get snapshot for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    
    completeReliabilityMeasurement(measurement, false, {
      error: getErrorMessage(error),
      cached: false,
      snapshotFound: false
    });

    return null;
  }
}

/**
 * Gets all snapshots for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param limit - Maximum number of snapshots to retrieve (default: 50)
 * @returns Promise resolving to array of snapshots ordered by creation date
 */
export async function getUserBookSnapshots(
  userId: string,
  bookId: string,
  limit: number = 50
): Promise<StateSnapshot[]> {
  try {
    const snapshots = await dbRead
      .select()
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId)
      ))
      .orderBy(desc(storyStateSnapshots.createdAt))
      .limit(limit);
      
    return snapshots.map(snapshot => ({
      pageId: snapshot.pageId,
      page: snapshot.state.page,
      state: snapshot.state,
      createdAt: snapshot.createdAt,
      version: snapshot.version,
      isMajorCheckpoint: snapshot.isMajorCheckpoint,
      reason: snapshot.reason as 'periodic' | 'major_event' | 'branch_start' | 'user_request'
    }));
  } catch (error) {
    console.error(`[getUserBookSnapshots] ❌ Failed to get snapshots:`, {userId, bookId, error: getErrorMessage(error)});
    return [];
  }
}

/**
 * Gets the most recent snapshot page for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving to the page where last snapshot was created, or null if not found
 */
export async function getLastSnapshotPage(
  userId: string,
  bookId: string
): Promise<PersistedStoryPage | null> {
  try {
    const snapshot = await dbRead
      .select()
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId)
      ))
      .orderBy(desc(storyStateSnapshots.createdAt))
      .limit(1);

    if (snapshot[0]) {
      // Get the full page data for the snapshot
      const page = await getStoryPageById(userId, bookId, snapshot[0].pageId);
      return page;
    }

    return null;
  } catch (error) {
    console.error(`[getLastSnapshotPage] Failed to get last snapshot page:`, {userId, bookId, error: getErrorMessage(error)});
    return null;
  }
}

/**
 * Gets the most recent major checkpoint snapshot for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving to major checkpoint snapshot or null if not found
 */
export async function getLatestMajorCheckpoint(
  userId: string,
  bookId: string
): Promise<StateSnapshot | null> {
  try {
    const snapshot = await dbRead
      .select()
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId),
        eq(storyStateSnapshots.isMajorCheckpoint, true)
      ))
      .orderBy(desc(storyStateSnapshots.createdAt))
      .limit(1);
      
    if (!snapshot[0]) {
      return null;
    }
    
    return {
      pageId: snapshot[0].pageId,
      page: snapshot[0].state.page,
      state: snapshot[0].state,
      createdAt: snapshot[0].createdAt,
      version: snapshot[0].version,
      isMajorCheckpoint: snapshot[0].isMajorCheckpoint,
      reason: snapshot[0].reason as 'periodic' | 'major_event' | 'branch_start' | 'user_request'
    };
  } catch (error) {
    console.error(`[getLatestMajorCheckpoint] ❌ Failed to get major checkpoint:`, {userId, bookId, error: getErrorMessage(error)});
    return null;
  }
}

// ============================================================================
// SNAPSHOT CREATION
// ============================================================================

/**
 * Creates a state snapshot at the specified page
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param pageId - Page identifier
 * @param state - Complete story state to snapshot
 * @param reason - Reason for snapshot creation
 * @returns Promise resolving when snapshot is created
 * 
 * @example
 * ```typescript
 * await createStateSnapshot(
 *   "user123", 
 *   "book456", 
 *   "page789", 
 *   storyState, 
 *   "major_event"
 * );
 * ```
 */
export async function createStateSnapshot(
  userId: string,
  bookId: string, 
  pageId: string, 
  state: StoryState, 
  reason: 'periodic' | 'major_event' | 'branch_start' | 'user_request'
): Promise<void> {
  const measurement = createReliabilityMeasurement('snapshot_creation', 'snapshot_service', userId, {
    userId,
    bookId,
    pageId,
    reason,
    operation: 'createStateSnapshot'
  });

  try {
    console.log(`[createStateSnapshot] 📸 Creating snapshot for user ${userId}, page ${pageId} (${reason})`);
    
    await withCircuitBreaker(
      () => retryOperation(async () => {
        await dbWrite
          .insert(storyStateSnapshots)
          .values({
            userId,
            bookId,
            pageId,
            state,
            version: 1,
            isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
            reason,
          })
          .onConflictDoUpdate({
            target: [storyStateSnapshots.userId, storyStateSnapshots.bookId, storyStateSnapshots.pageId],
            set: {
              state,
              version: sql`${storyStateSnapshots.version} + 1`,
              createdAt: new Date(),
              updatedAt: new Date(),
              isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
              reason,
            }
          });
      }),
      `${CREATE_SNAPSHOT_KEY_PREFIX}:${userId}`,
      CREATE_SNAPSHOT_CIRCUIT_THRESHOLD,
      CREATE_SNAPSHOT_CIRCUIT_TIMEOUT
    );
      
    measurement.end({
      success: true,
      cached: false,
      isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
      snapshotReason: reason
    });
    
    console.log(`[createStateSnapshot] ✅ Snapshot created for page ${pageId}`);
  } catch (error) {
    console.error(`[createStateSnapshot] ❌ Failed to create snapshot for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    
    measurement.end({
      success: false,
      error: getErrorMessage(error),
      cached: false,
      isMajorCheckpoint: false,
      snapshotReason: reason
    });

    throw new Error(`Unable to create state snapshot: ${getErrorMessage(error)}`);
  }
}

/**
 * Determines if a snapshot should be created based on current conditions
 * 
 * @param currentPage - Current page data
 * @param previousPage - Previous page data (if available)
 * @param lastSnapshotPage - Last page where snapshot was created
 * @param isMajorEvent - Whether this is a major story event
 * @returns Decision object indicating whether to create snapshot and why
 */
export function shouldCreateSnapshot(
  currentPage: PersistedStoryPage,
  previousPage: PersistedStoryPage | null,
  lastSnapshotPage: PersistedStoryPage | null,
  isMajorEvent: boolean
): SnapshotCreationDecision {
  const currentNumber = currentPage.page || 0;
  const lastSnapshotNumber = lastSnapshotPage?.page || 0;
  const pagesSinceSnapshot = currentNumber - lastSnapshotNumber;
  
  // Major events always get snapshots
  if (isMajorEvent) {
    return {
      shouldCreate: true,
      reason: 'major_event',
      priority: 100
    };
  }
  
  // Create snapshot every 5 pages (periodic)
  if (pagesSinceSnapshot >= 5) {
    return {
      shouldCreate: true,
      reason: 'periodic',
      priority: 50
    };
  }

  // Branch start (current page is a root page or different branch from previous)
  if (!currentPage.parentId) {
    // Current page is a root page (no parent) - always a branch start
    return {
      shouldCreate: true,
      reason: 'branch_start',
      priority: 75
    };
  }
  
  // Check if we're switching to a different branch (different parent than previous page)
  if (previousPage && currentPage.parentId !== previousPage.parentId) {
    return {
      shouldCreate: true,
      reason: 'branch_start',
      priority: 75
    };
  }
  
  return {
    shouldCreate: false,
    reason: 'periodic', // Default reason for consistency
    priority: 0
  };
}

// ============================================================================
// SNAPSHOT MANAGEMENT
// ============================================================================

/**
 * Optimizes snapshot storage by cleaning up excess snapshots in the database
 * 
 * This is a database operation function that manages snapshot storage limits
 * by loading snapshots from the database, applying selection algorithm, and
 * deleting excess snapshots. It performs actual database read/write operations.
 * 
 * Purpose: Used by cleanup jobs and maintenance tasks to ensure snapshot
 * storage doesn't exceed configured limits while preserving important checkpoints.
 * 
 * Operation Strategy:
 * 1. Load all snapshots for the specified user/book from database
 * 2. Apply selection algorithm to determine which snapshots to keep
 * 3. Delete excess snapshots from database in batch operation
 * 4. Return operation statistics for monitoring and logging
 * 
 * Use Case: Called by cron jobs, admin cleanup tools, or when snapshot
 * limits are exceeded to maintain optimal storage usage.
 * 
 * Note: This function performs database operations and should NOT be used
 * during time-sensitive operations like story reconstruction. For algorithmic
 * snapshot selection only, use `selectOptimalSnapshots` from branch-traversal.
 * 
 * @param userId - User identifier whose snapshots to optimize
 * @param bookId - Book identifier whose snapshots to optimize  
 * @param maxSnapshots - Maximum number of snapshots to keep (default: 20)
 * @returns Promise resolving to cleanup operation results
 * 
 * @example
 * ```typescript
 * // Cleanup old snapshots during maintenance
 * const result = await optimizeSnapshots("user123", "book456", 15);
 * console.log(`Deleted ${result.deleted} snapshots, kept ${result.kept}`);
 * 
 * // Automated cleanup job
 * for (const book of userBooks) {
 *   await optimizeSnapshots(book.userId, book.id);
 * }
 * ```
 */
export async function optimizeSnapshots(
  userId: string,
  bookId: string,
  maxSnapshots: number = 20
): Promise<{ deleted: number; kept: number }> {
  try {
    console.log(`[optimizeSnapshots] 🧹 Optimizing snapshots for user ${userId}, book ${bookId} (max: ${maxSnapshots})`);
    
    const snapshots = await dbRead
      .select()
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId)
      ))
      .orderBy(desc(storyStateSnapshots.createdAt));
    
    if (snapshots.length <= maxSnapshots) {
      console.log(`[optimizeSnapshots] ✅ No cleanup needed (${snapshots.length} <= ${maxSnapshots})`);
      return { deleted: 0, kept: snapshots.length };
    }
    
    // Convert DB snapshots to StateSnapshot format for algorithm
    const stateSnapshots: StateSnapshot[] = snapshots.map(db => ({
      pageId: db.pageId,
      page: 0, // Will be populated from page data if needed
      state: db.state as StoryState,
      createdAt: db.createdAt,
      version: db.version,
      isMajorCheckpoint: db.isMajorCheckpoint,
      reason: db.reason
    }));
    
    // Use the selection algorithm from branch-traversal (dynamic import to avoid circular deps)
    const { selectOptimalSnapshots } = await import("../utils/branch-traversal.js");
    const selectedSnapshots = selectOptimalSnapshots(stateSnapshots, maxSnapshots);
    
    // Determine which snapshots to delete (those not in selected set)
    const selectedPageIds = new Set(selectedSnapshots.map(s => s.pageId));
    const toDelete = snapshots.filter(s => !selectedPageIds.has(s.pageId));
    
    if (toDelete.length > 0) {
      await dbWrite
        .delete(storyStateSnapshots)
        .where(
          inArray(
            storyStateSnapshots.id, 
            toDelete.map(s => s.id)
          )
        );
      
      console.log(`[optimizeSnapshots] 🗑️ Deleted ${toDelete.length} old snapshots`);
    }
    
    const result = { 
      deleted: toDelete.length, 
      kept: snapshots.length - toDelete.length 
    };
    
    console.log(`[optimizeSnapshots] ✅ Cleanup complete: ${result.kept} kept, ${result.deleted} deleted`);
    return result;
  } catch (error) {
    console.error(`[optimizeSnapshots] ❌ Failed to optimize snapshots for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to optimize snapshots: ${getErrorMessage(error)}`);
  }
}

// ============================================================================
// SNAPSHOT MANAGEMENT
// ============================================================================

/**
 * Deletes all snapshots for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving when snapshots are deleted
 */
export async function deleteAllSnapshots(
  userId: string,
  bookId: string
): Promise<void> {
  try {
    console.log(`[deleteAllSnapshots] 🗑️ Deleting all snapshots for user ${userId}, book ${bookId}`);
    
    await dbWrite
      .delete(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId)
      ));
      
    console.log(`[deleteAllSnapshots] ✅ All snapshots deleted`);
  } catch (error) {
    console.error(`[deleteAllSnapshots] ❌ Failed to delete snapshots for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to delete snapshots: ${getErrorMessage(error)}`);
  }
}

/**
 * Gets snapshot statistics for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving to snapshot statistics
 */
export async function getSnapshotStatistics(
  userId: string,
  bookId: string
): Promise<{
  total: number;
  majorCheckpoints: number;
  periodic: number;
  branchStart: number;
  userRequest: number;
  oldest?: Date;
  newest?: Date;
}> {
  try {
    const snapshots = await dbRead
      .select({
        reason: storyStateSnapshots.reason,
        isMajorCheckpoint: storyStateSnapshots.isMajorCheckpoint,
        createdAt: storyStateSnapshots.createdAt
      })
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.bookId, bookId)
      ));
    
    const stats = {
      total: snapshots.length,
      majorCheckpoints: snapshots.filter(s => s.isMajorCheckpoint).length,
      periodic: snapshots.filter(s => s.reason === 'periodic').length,
      branchStart: snapshots.filter(s => s.reason === 'branch_start').length,
      userRequest: snapshots.filter(s => s.reason === 'user_request').length,
      oldest: snapshots.length > 0 ? new Date(Math.min(...snapshots.map(s => s.createdAt.getTime()))) : undefined,
      newest: snapshots.length > 0 ? new Date(Math.max(...snapshots.map(s => s.createdAt.getTime()))) : undefined
    };
    
    return stats;
  } catch (error) {
    console.error(`[getSnapshotStatistics] ❌ Failed to get statistics for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to get snapshot statistics: ${getErrorMessage(error)}`);
  }
}
