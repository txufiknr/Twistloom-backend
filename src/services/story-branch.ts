/**
 * @overview Enhanced Story Service with Branch Traversal
 * 
 * Enhanced story service functions that integrate with the branch traversal system
 * for improved navigation, state reconstruction, and performance.
 */

import { dbRead, dbWrite } from "../db/client.js";
import { storyStates } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import type { StoryState, StoryProgressWithBranch, BranchValidationResult, BranchNavigationOptions, TraversalOptions, StateReconstructionDeps } from "../types/story.js";
import { getBookFromDB, getPageFromDB } from "./book.js";
import { getBranchPath, getSiblingPages, getBranchStats, reconstructStoryState, preWarmBranchCache } from "../utils/branch-traversal.js";
import { getStoryState, getStoryProgress, getUserSession } from "./story.js";
import { setDeletedState } from "./story-state-cache.js";
import { getErrorMessage } from "../utils/error.js";
import { MIN_PAGES_FOR_MIDDLE, SNAPSHOT_INTERVAL } from "../config/story.js";
import { generateId } from "../utils/uuid.js";
import { createEmptyStoryState } from "../utils/story.js";

// ============================================================================
// ENHANCED STORY FUNCTIONS WITH BRANCH TRAVERSAL
// ============================================================================

export function generateBranchId(): string {
  return generateId(); // uuid v7
}

/**
 * Gets story state with branch-aware reconstruction
 * 
 * This function enhances the standard story state retrieval by:
 * 1. Attempting to get the story state from database
 * 2. If not found, reconstructing from branch path using snapshots/deltas
 * 3. Providing fallback state reconstruction for missing data
 * 4. Creating minimal valid state with branch context
 * 
 * @param userId - User identifier for the story state
 * @param pageId - Page identifier for the story state
 * @param options - Branch traversal options for cache and validation control
 * @returns Promise resolving to story state or null
 * 
 * Behavior:
 * - First attempts database lookup via getStoryStateFromDB()
 * - If database lookup fails, reconstructs using branch traversal
 * - Uses snapshots and deltas for efficient reconstruction
 * - Applies branch path context and minimal state creation
 * - Provides comprehensive fallback mechanisms for data integrity
 * 
 * @example
 * ```typescript
 * // Enhanced state retrieval with branch awareness
 * const state = await getStoryStateWithBranch("user123", "book456", "page789", {
 *   useCache: true,
 *   validatePath: true
 * });
 * if (state) {
 *   console.log(`State reconstructed for page ${state.page}`);
 * } else {
 *   console.log("State reconstruction failed");
 * }
 * ```
 */
export async function getStoryStateWithBranch(
  userId: string,
  bookId: string,
  pageId: string,
  options: TraversalOptions = {}
): Promise<StoryState | null> {
  try {
    console.log(`[getStoryStateWithBranch] 🌳 Getting story state for:`, { userId, pageId, bookId });

    // First attempt: Get from database & cache
    const persistedState = await getStoryState(pageId);
    if (persistedState) return persistedState;

    // Second attempt: Reconstruct from branch path using advanced reconstruction
    console.log(`[getStoryStateWithBranch] 🔄 Reconstructing state for page ${pageId}`);
    
    // Create dependencies for reconstruction with branch-aware page retrieval
    const reconstructionDeps: StateReconstructionDeps = {
      getPageById: async (id: string) => await getPageFromDB(id),
      getBook: async (bookId: string) => await getBookFromDB(bookId),
      getStoryState: async (id: string) => await getStoryState(id)
    };
    
    const reconstructionResult = await reconstructStoryState(pageId, reconstructionDeps, options);
    const reconstructedState = reconstructionResult.state;
    
    // Get branch path for page number
    const branchPathData = await getBranchPath(pageId, options);

    const book = await getBookFromDB(bookId);
    if (!book) throw new Error("Book not found");

    // Create minimal valid state
    const minimalState: StoryState = createEmptyStoryState(
      pageId,
      branchPathData.pages[branchPathData.pages.length - 1].page,
      book.totalPages
    );

    return { ...minimalState, ...reconstructedState };
  } catch (error) {
    console.error(`[getStoryStateWithBranch] ❌ Failed to get/reconstruct state for page ${pageId}:`, getErrorMessage(error));
    return null;
  }
}

/**
 * Gets complete story progress with branch context
 * 
 * Enhanced version of getStoryProgress that includes:
 * 1. Standard story progress data
 * 2. Branch path information
 * 3. Branch statistics
 * 4. Sibling pages for navigation context
 * 
 * @param userId - User identifier
 * @param options - Branch traversal options
 * @returns Promise resolving to enhanced story progress
 */
export async function getStoryProgressWithBranch(
  userId: string,
  options: TraversalOptions = {}
): Promise<StoryProgressWithBranch> {
  try {
    // Get standard story progress
    const standardProgress = await getStoryProgress(userId);
    
    if (!standardProgress.session || !standardProgress.page) {
      return {
        ...standardProgress,
        branchPath: null,
        branchStats: null,
        siblings: []
      };
    }

    // Get branch information
    const [branchPath, branchStats, siblings] = await Promise.all([
      getBranchPath(standardProgress.page.id, options),
      getBranchStats(standardProgress.page.id).catch(() => null),
      getSiblingPages(standardProgress.page.id)
    ]);

    return {
      ...standardProgress,
      branchPath,
      branchStats,
      siblings
    };
  } catch (error) {
    console.error(`[getStoryProgressWithBranch] ❌ Failed to get enhanced progress for user ${userId}:`, getErrorMessage(error));
    throw error;
  }
}

// /**
//  * Enhanced previous page navigation with branch awareness
//  * 
//  * This function improves upon the standard goToPreviousPage by:
//  * 1. Using branch traversal for validation
//  * 2. Providing branch context
//  * 3. Handling edge cases better
//  * 
//  * @param userId - User ID to navigate
//  * @param options - Branch traversal options
//  * @returns Promise resolving to previous page with branch context
//  */
// export async function goToPreviousPageWithBranch(
//   userId: string,
//   options: TraversalOptions = {}
// ): Promise<PreviousPageResult> {
//   try {
//     const progress = await getStoryProgressWithBranch(userId, options);
    
//     if (!progress.page || !progress.session) {
//       return {
//         previousPage: null,
//         branchPath: null,
//         canGoBackFurther: false
//       };
//     }

//     // Check if we can go back
//     if (!progress.page.parentId) {
//       console.log(`[goToPreviousPageWithBranch] 🚫 Already at root page ${progress.page.id}`);
//       return {
//         previousPage: progress.page,
//         branchPath: progress.branchPath,
//         canGoBackFurther: false
//       };
//     }

//     // Get previous page using branch traversal for validation
//     const previousPage = await getStoryPageById(userId, progress.session.bookId, progress.page.parentId);
    
//     if (!previousPage) {
//       console.error(`[goToPreviousPageWithBranch] ❌ Previous page ${progress.page.parentId} not found`);
//       return {
//         previousPage: null,
//         branchPath: progress.branchPath,
//         canGoBackFurther: true
//       };
//     }

//     // Update session to point to previous page
//     await setActiveSession({userId, bookId: progress.session.bookId, pageId: previousPage.id});
    
//     // Get updated branch path from previous page
//     const updatedBranchPath = await getBranchPath(previousPage.id, userId, options);

//     console.log(`[goToPreviousPageWithBranch] ↩️ User ${userId} navigated to page ${previousPage.id}`);

//     return {
//       previousPage,
//       branchPath: updatedBranchPath,
//       canGoBackFurther: !!previousPage.parentId
//     };
//   } catch (error) {
//     console.error(`[goToPreviousPageWithBranch] ❌ Failed to navigate back for user ${userId}:`, getErrorMessage(error));
//     throw error;
//   }
// }

/**
 * Validates branch integrity for a given page
 * 
 * @param pageId - Page ID to validate
 * @returns Promise resolving to validation result
 */
export async function validateBranchIntegrity(pageId: string): Promise<BranchValidationResult> {
  const issues: string[] = [];

  try {
    const path = await getBranchPath(pageId, { validatePath: true });
    
    // Additional validation checks
    if (path.depth > 50) {
      issues.push(`Branch depth (${path.depth}) exceeds recommended maximum (50)`);
    }

    if (path.pages.some(page => !page.text || page.text.trim() === '')) {
      issues.push('Branch contains pages with empty text');
    }

    // Check for duplicate page numbers
    const pageNumbers = path.pages.map(p => p.page);
    const uniquePageNumbers = new Set(pageNumbers);
    if (pageNumbers.length !== uniquePageNumbers.size) {
      issues.push('Branch contains duplicate page numbers');
    }

    return {
      isValid: issues.length === 0,
      issues,
      path
    };
  } catch (error) {
    issues.push(`Failed to traverse branch: ${getErrorMessage(error)}`);
    return {
      isValid: false,
      issues,
      path: null
    };
  }
}

/**
 * Gets branch navigation options for current page
 * 
 * @param pageId - Current page ID
 * @returns Promise resolving to navigation options
 */
export async function getBranchNavigationOptions(pageId: string): Promise<BranchNavigationOptions> {
  try {
    const [branchPath, siblings] = await Promise.all([
      getBranchPath(pageId),
      getSiblingPages(pageId)
    ]);

    const canGoBack = !!branchPath.pages[0]?.parentId;
    const canGoForward = siblings.length > 1; // Has options to move forward
    
    return {
      canGoBack,
      canGoForward,
      siblingPages: siblings,
      branchDepth: branchPath.depth,
      totalBranches: siblings.length
    };
  } catch (error) {
    console.error(`[getBranchNavigationOptions] ❌ Failed to get navigation options for page ${pageId}:`, getErrorMessage(error));
    return {
      canGoBack: false,
      canGoForward: false,
      siblingPages: [],
      branchDepth: 0,
      totalBranches: 0
    };
  }
}

// ============================================================================
// BATCH OPERATIONS FOR PERFORMANCE
// ============================================================================

/**
 * Pre-warms branch cache for multiple users
 * 
 * @param userIds - Array of user IDs
 * @returns Promise resolving when cache is warmed
 */
export async function preWarmBranchCacheForUsers(userIds: string[]): Promise<void> {
  console.log(`[preWarmBranchCacheForUsers] 🔥 Warming cache for ${userIds.length} users`);
  
  let warmedUsers = 0;
  
  // Pre-warm cache for each user individually
  for (const userId of userIds) {
    try {
      const session = await getUserSession(userId);
      if (session?.pageId) {
        // Pre-warm cache for this specific page
        await preWarmBranchCache([session.pageId]);
        warmedUsers++;
      }
    } catch (error) {
      console.warn(`[preWarmBranchCacheForUsers] ⚠️ Failed to pre-warm cache for user ${userId}:`, getErrorMessage(error));
    }
  }
  
  console.log(`[preWarmBranchCacheForUsers] ✅ Cache warmed for ${warmedUsers} users`);
}

/**
 * Strategic cleanup of story states using hybrid retention strategy
 * 
 * Combines fixed checkpoints with interval snapshots for optimal performance:
 * 1. Always keep: First page, Last page (current)
 * 2. Keep every Nth page: page % SNAPSHOT_INTERVAL === 0  
 * 3. Keep middle page: If totalPages >= MIN_PAGES_FOR_MIDDLE
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @returns Promise that resolves when cleanup is complete
 * 
 * Performance: Max 10 delta applications between snapshots
 * Storage: ~13 states per 100-page book vs 3 states in simple strategy
 */
export async function cleanupStoryStatesWithStrategy(bookId: string): Promise<void> {
  try {
    // Get book information to retrieve totalPages
    const bookInfo = await getBookFromDB(bookId);
    if (!bookInfo) {
      console.log(`[cleanupStoryStatesWithStrategy] ⚠️ Book not found for id: ${bookId}`);
      return;
    }

    const totalPages = bookInfo.totalPages;
    console.log(`[cleanupStoryStatesWithStrategy] 📚 Using totalPages from book schema: ${totalPages}`);
    
    // Get all story states for this book, ordered by page number
    // Branch-based cleanup: states are unique per page, not per user
    const allStates = await dbRead
      .select({ 
        pageId: storyStates.pageId,
        page: storyStates.page,
        updatedAt: storyStates.updatedAt 
      })
      .from(storyStates)
      .where(eq(storyStates.bookId, bookId))
      .orderBy(storyStates.page);

    if (allStates.length === 0) {
      console.log(`[cleanupStoryStatesWithStrategy] ℹ️ No states to cleanup for book ${bookId}`);
      return;
    }
    const pagesToKeep = new Set<string>();
    
    // 1. Always keep first page
    pagesToKeep.add(allStates[0].pageId);
    console.log(`[cleanupStoryStatesWithStrategy] 📍 Keeping first page: ${allStates[0].pageId} (page ${allStates[0].page})`);
    
    // 2. Always keep last page (current)
    const lastState = allStates[allStates.length - 1];
    pagesToKeep.add(lastState.pageId);
    console.log(`[cleanupStoryStatesWithStrategy] 📍 Keeping last page: ${lastState.pageId} (page ${lastState.page})`);
    
    // 3. Keep middle page for substantial books
    if (totalPages >= MIN_PAGES_FOR_MIDDLE) {
      const middleIndex = Math.floor(allStates.length / 2);
      const middleState = allStates[middleIndex];
      pagesToKeep.add(middleState.pageId);
      console.log(`[cleanupStoryStatesWithStrategy] 📍 Keeping middle page: ${middleState.pageId} (page ${middleState.page})`);
    }
    
    // 4. Keep interval snapshots
    const intervalStates = allStates.filter(state => state.page % SNAPSHOT_INTERVAL === 0);
    for (const state of intervalStates) {
      pagesToKeep.add(state.pageId);
    }
    console.log(`[cleanupStoryStatesWithStrategy] 📍 Keeping ${intervalStates.length} interval snapshots (every ${SNAPSHOT_INTERVAL} pages)`);
    
    // 5. Identify states to delete
    const statesToDelete = allStates.filter(state => !pagesToKeep.has(state.pageId));
    
    if (statesToDelete.length > 0) {
      console.log(`[cleanupStoryStatesWithStrategy] 🗑️ Preparing to delete ${statesToDelete.length} states, keeping ${pagesToKeep.size} states`);
      
      for (const stateToDelete of statesToDelete) {
        // Cache the state before deletion for safety net
        const fullState = await getStoryState(stateToDelete.pageId);
        if (fullState) {
          setDeletedState(stateToDelete.pageId, fullState);
          console.log(`[cleanupStoryStatesWithStrategy] 💾 Cached state before deletion for page ${stateToDelete.pageId} (page ${stateToDelete.page})`);
        }
        
        await dbWrite
          .delete(storyStates)
          .where(and(
            eq(storyStates.bookId, bookId),
            eq(storyStates.pageId, stateToDelete.pageId)
          ));
      }
      
      console.log(`[cleanupStoryStatesWithStrategy] ✨ Strategic cleanup complete: ${statesToDelete.length} deleted, ${pagesToKeep.size} kept for book ${bookId}`);
    } else {
      console.log(`[cleanupStoryStatesWithStrategy] ✅ No cleanup needed: all ${pagesToKeep.size} states are strategic checkpoints`);
    }
    
    // Log performance metrics
    const keepRatio = (pagesToKeep.size / allStates.length * 100).toFixed(1);
    console.log(`[cleanupStoryStatesWithStrategy] 📊 Storage efficiency: ${keepRatio}% of states retained (${pagesToKeep.size}/${allStates.length})`);
    
  } catch (error) {
    console.error(`Failed to cleanup story states for book ${bookId}:`, getErrorMessage(error));
    // Don't throw error here - cleanup failure shouldn't break the main operation
  }
}