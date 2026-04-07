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
import type { SnapshotCreationDecision, StateSnapshot, StoryState } from "../types/story.js";
import { getErrorMessage } from "../utils/error.js";

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
  try {
    const snapshot = await dbRead
      .select()
      .from(storyStateSnapshots)
      .where(and(
        eq(storyStateSnapshots.userId, userId),
        eq(storyStateSnapshots.pageId, pageId)
      ))
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
    console.error(`[getStateSnapshot] ❌ Failed to get snapshot for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve state snapshot: ${getErrorMessage(error)}`);
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
    console.error(`[getUserBookSnapshots] ❌ Failed to get snapshots for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve user snapshots: ${getErrorMessage(error)}`);
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
    console.error(`[getLatestMajorCheckpoint] ❌ Failed to get major checkpoint for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve major checkpoint: ${getErrorMessage(error)}`);
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
  try {
    console.log(`[createStateSnapshot] 📸 Creating snapshot for user ${userId}, page ${pageId} (${reason})`);
    
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
      
    console.log(`[createStateSnapshot] ✅ Snapshot created for page ${pageId}`);
  } catch (error) {
    console.error(`[createStateSnapshot] ❌ Failed to create snapshot for user ${userId}, page ${pageId}:`, getErrorMessage(error));
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
  currentPage: any,
  previousPage: any | null,
  lastSnapshotPage: any | null,
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

  // TODO: should it consider currentPage.branchId too?
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
 * Optimizes snapshot storage by cleaning up old snapshots
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param maxSnapshots - Maximum number of snapshots to keep (default: 20)
 * @returns Promise resolving to cleanup results
 * 
 * @example
 * ```typescript
 * const result = await optimizeSnapshots("user123", "book456", 15);
 * console.log(`Deleted ${result.deleted} snapshots, kept ${result.kept}`);
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
    
    // Always keep major checkpoints
    const majorCheckpoints = snapshots.filter(s => s.isMajorCheckpoint);
    const regularSnapshots = snapshots.filter(s => !s.isMajorCheckpoint);
    
    const remainingSlots = maxSnapshots - majorCheckpoints.length;
    const toDelete = regularSnapshots.slice(remainingSlots);
    
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
