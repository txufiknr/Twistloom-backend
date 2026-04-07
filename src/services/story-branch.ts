/**
 * @overview Enhanced Story Service with Branch Traversal
 * 
 * Enhanced story service functions that integrate with the branch traversal system
 * for improved navigation, state reconstruction, and performance.
 */

import { dbWrite } from "../db/client.js";
import { storyStates } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import type { StoryState, StoryProgressWithBranch, PreviousPageResult, BranchValidationResult, BranchNavigationOptions, StoryStateCleanupResult, TraversalOptions, StateReconstructionDeps, BranchPath } from "../types/story.js";
import { getBookFromDB, getBookPages, getPageFromDB, getUserBooks } from "./book.js";
import { getBranchPath, getSiblingPages, getBranchStats, reconstructStoryState, preWarmBranchCache, createEmptyStoryState } from "../utils/branch-traversal.js";
import { getStoryPageById } from "./book.js";
import { getStoryStateFromDB, mapStoryStateFromDb, getStoryState, getStoryProgress, setActiveSession, getActiveSession } from "./story.js";
import { getStateSnapshot } from "./snapshots.js";
import { getStateDelta } from "./deltas.js";
import { getErrorMessage } from "../utils/error.js";

// ============================================================================
// ENHANCED STORY FUNCTIONS WITH BRANCH TRAVERSAL
// ============================================================================

/**
 * Gets story state with branch-aware reconstruction
 * 
 * This function enhances the standard story state retrieval by:
 * 1. Attempting to get the story state from database
 * 2. If not found, reconstructing from branch path
 * 3. Providing fallback state reconstruction for missing data
 * 
 * @param userId - User identifier for the story state
 * @param pageId - Page identifier for the story state
 * @param options - Branch traversal options
 * @returns Promise resolving to story state or null
 */
export async function getStoryStateWithBranch(
  userId: string,
  pageId: string,
  options: TraversalOptions = {}
): Promise<StoryState | null> {
  try {
    // First attempt: Get from database
    const dbState = await getStoryStateFromDB(userId, pageId);
    if (dbState) {
      return mapStoryStateFromDb(dbState);
    }

    // Second attempt: Reconstruct from branch path using advanced reconstruction
    console.log(`[getStoryStateWithBranch] 🔄 Reconstructing state for page ${pageId}`);
    
    // Get the target page first to determine its branchId
    const targetPage = await getPageFromDB(pageId);
    const targetBranchId = targetPage?.branchId || undefined;
    console.log(`[getStoryStateWithBranch] Target branchId for reconstruction: ${targetBranchId || 'main'}`);
    
    // Create dependencies for reconstruction with branch-aware page retrieval
    const reconstructionDeps: StateReconstructionDeps = {
      getPageById: async (id: string) => await getPageFromDB(id, targetBranchId),
      getBook: async (bookId: string) => await getBookFromDB(bookId),
      getSnapshot: async (id: string) => await getStateSnapshot(userId, id),
      getDelta: async (id: string) => await getStateDelta(userId, id),
      getStoryState: async (id: string) => await getStoryState(userId, id)
    };
    
    const reconstructionResult = await reconstructStoryState(pageId, userId, reconstructionDeps, options);
    const reconstructedState = reconstructionResult.state;
    
    // Get branch path for page number
    const branchPathData = await getBranchPath(pageId, userId, options);
    
    // Create minimal valid state
    const minimalState: StoryState = createEmptyStoryState(pageId, branchPathData.pages[branchPathData.pages.length - 1].page);

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
      getBranchPath(standardProgress.page.id, userId, options),
      getBranchStats(standardProgress.page.id, userId).catch(() => null),
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

/**
 * Enhanced previous page navigation with branch awareness
 * 
 * This function improves upon the standard goToPreviousPage by:
 * 1. Using branch traversal for validation
 * 2. Providing branch context
 * 3. Handling edge cases better
 * 
 * @param userId - User ID to navigate
 * @param options - Branch traversal options
 * @returns Promise resolving to previous page with branch context
 */
export async function goToPreviousPageWithBranch(
  userId: string,
  options: TraversalOptions = {}
): Promise<PreviousPageResult> {
  try {
    const progress = await getStoryProgressWithBranch(userId, options);
    
    if (!progress.page || !progress.session) {
      return {
        previousPage: null,
        branchPath: null,
        canGoBackFurther: false
      };
    }

    // Check if we can go back
    if (!progress.page.parentId) {
      console.log(`[goToPreviousPageWithBranch] 🚫 Already at root page ${progress.page.id}`);
      return {
        previousPage: progress.page,
        branchPath: progress.branchPath,
        canGoBackFurther: false
      };
    }

    // Get previous page using branch traversal for validation
    const previousPage = await getStoryPageById(userId, progress.session.bookId, progress.page.parentId);
    
    if (!previousPage) {
      console.error(`[goToPreviousPageWithBranch] ❌ Previous page ${progress.page.parentId} not found`);
      return {
        previousPage: null,
        branchPath: progress.branchPath,
        canGoBackFurther: true
      };
    }

    // Update session to point to previous page
    await setActiveSession(userId, progress.session.bookId, previousPage.id);
    
    // Get updated branch path from previous page
    const updatedBranchPath = await getBranchPath(previousPage.id, userId, options);

    console.log(`[goToPreviousPageWithBranch] ↩️ User ${userId} navigated to page ${previousPage.id}`);

    return {
      previousPage,
      branchPath: updatedBranchPath,
      canGoBackFurther: !!previousPage.parentId
    };
  } catch (error) {
    console.error(`[goToPreviousPageWithBranch] ❌ Failed to navigate back for user ${userId}:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Validates branch integrity for a given page
 * 
 * @param pageId - Page ID to validate
 * @returns Promise resolving to validation result
 */
export async function validateBranchIntegrity(pageId: string, userId: string): Promise<BranchValidationResult> {
  const issues: string[] = [];
  let path: BranchPath | null = null;

  try {
    path = await getBranchPath(pageId, userId, { validatePath: true });
    
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
export async function getBranchNavigationOptions(pageId: string, userId: string): Promise<BranchNavigationOptions> {
  try {
    const [branchPath, siblings] = await Promise.all([
      getBranchPath(pageId, userId),
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
      const session = await getActiveSession(userId);
      if (session?.pageId) {
        // Pre-warm cache for this specific user
        await preWarmBranchCache([session.pageId], userId);
        warmedUsers++;
      }
    } catch (error) {
      console.warn(`[preWarmBranchCacheForUsers] ⚠️ Failed to pre-warm cache for user ${userId}:`, getErrorMessage(error));
    }
  }
  
  console.log(`[preWarmBranchCacheForUsers] ✅ Cache warmed for ${warmedUsers} users`);
}

/**
 * Cleans up old story states with branch awareness
 * 
 * @param userId - User ID to cleanup
 * @param maxStatesToKeep - Maximum states to keep per user
 * @returns Promise resolving when cleanup is complete
 */
export async function cleanupOldStoryStates(
  userId: string,
  maxStatesToKeep: number = 10
): Promise<StoryStateCleanupResult> {
  try {
    // Get user's books to find all associated pages
    const userBooks = await getUserBooks(userId);
    
    let deletedCount = 0;
    let keptCount = 0;
    
    for (const book of userBooks) {
      // Get all pages for this book
      const bookPages = await getBookPages(book.id);
      
      // Sort by creation time (newest first)
      const sortedPages = bookPages.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      
      // Keep only the most recent pages
      const pagesToKeep = sortedPages.slice(0, maxStatesToKeep);
      const pagesToDelete = sortedPages.slice(maxStatesToKeep);
      
      // Delete old story states
      for (const page of pagesToDelete) {
        try {
          await dbWrite
            .delete(storyStates)
            .where(and(
              eq(storyStates.userId, userId),
              eq(storyStates.pageId, page.id)
            ));
          deletedCount++;
        } catch (error) {
          console.warn(`[cleanupOldStoryStates] ⚠️ Failed to delete state for page ${page.id}:`, getErrorMessage(error));
        }
      }
      
      keptCount += pagesToKeep.length;
    }
    
    console.log(`[cleanupOldStoryStates] 🧹 Cleaned up ${deletedCount} old states, kept ${keptCount} for user ${userId}`);
    
    return { deletedCount, keptCount };
  } catch (error) {
    console.error(`[cleanupOldStoryStates] ❌ Failed to cleanup old states for user ${userId}:`, getErrorMessage(error));
    return { deletedCount: 0, keptCount: 0 };
  }
}