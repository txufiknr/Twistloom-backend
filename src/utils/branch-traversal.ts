/**
 * @overview Enhanced Branch Traversal Algorithm Module
 * 
 * Implements high-performance, resilient branch traversal for story navigation with
 * advanced caching, intelligent state reconstruction, and enterprise-grade reliability.
 * 
 * Core Architecture:
 * - Hybrid delta + checkpoint state reconstruction system
 * - Multi-level caching with TTL management
 * - Circuit breaker pattern for database resilience
 * - Exponential backoff retry logic with error classification
 * - Performance monitoring and metrics collection
 * 
 * Key Features:
 * - Backward traversal from current page to root with depth limiting
 * - Intelligent snapshot selection (interval, first, middle, last)
 * - Delta-based state reconstruction with fallback mechanisms
 * - Configurable reliability parameters via branch-traversal.ts config
 * - Graceful degradation under system stress
 * - Comprehensive error handling and logging
 * 
 * Performance Optimizations:
 * - Branch path caching with 5-minute TTL
 * - State reconstruction caching with 10-minute TTL
 * - Batch database operations for efficiency
 * - Circuit breakers prevent cascade failures
 * - Retry logic for transient errors only
 * 
 * Reliability Features:
 * - Error classification (transient, critical, data_corruption)
 * - Circuit breakers for all database operations
 * - Exponential backoff retry with configurable limits
 * - Enhanced error logging with full context
 * - Ultimate fallback to minimal state
 * 
 * Usage Examples:
 * ```typescript
 * // Basic reconstruction
 * const result = await reconstructStoryState(pageId, userId, deps);
 * 
 * // With options
 * const result = await reconstructStoryState(pageId, userId, deps, {
 *   useCache: true,
 *   validatePath: true
 * });
 * 
 * // Batch operations
 * const paths = await getBranchPathsBatch(pageIds, userId);
 * ```
 */

import { dbRead } from "../db/client.js";
import { pages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { SNAPSHOT_INTERVAL, MIN_PAGES_FOR_MIDDLE, BOOK_MIN_PAGES } from "../config/story.js";
import type { DBPage, DBStoryState } from "../types/schema.js";
import type { StoryStateSnapshotType } from "../types/story-branch.js";
import type { PersistedStoryPage, StoryState, StateReconstructionResult, BranchStats, TraversalOptions, BranchPath, StateReconstructionDeps, StateCacheEntry } from "../types/story.js";
import { branchCache, stateCache, BRANCH_CACHE_TTL, STATE_CACHE_TTL, MAX_CACHE_SIZE, MAX_STATE_CACHE_SIZE } from "../services/story-state-cache.js";
import { 
  GET_STORY_STATE_CIRCUIT_THRESHOLD,
  GET_STORY_STATE_CIRCUIT_TIMEOUT,
  GET_BRANCH_PATH_CIRCUIT_THRESHOLD,
  GET_BRANCH_PATH_CIRCUIT_TIMEOUT,
  GET_PAGE_BY_ID_CIRCUIT_THRESHOLD,
  GET_PAGE_BY_ID_CIRCUIT_TIMEOUT,
  GET_BOOK_CIRCUIT_THRESHOLD,
  GET_BOOK_CIRCUIT_TIMEOUT,
  BRANCH_PATH_MAX_RETRIES,
  BRANCH_PATH_BASE_DELAY,
  SNAPSHOT_SELECTION_MAX_RETRIES,
  SNAPSHOT_SELECTION_BASE_DELAY,
  RECONSTRUCTION_MAX_RETRIES,
  RECONSTRUCTION_BASE_DELAY,
  GET_STORY_STATE_KEY_PREFIX,
  GET_BRANCH_PATH_KEY_PREFIX,
  GET_PAGE_BY_ID_KEY_PREFIX,
  GET_BOOK_KEY_PREFIX,
  MAX_TRAVERSAL_DEPTH} from "../config/branch-traversal.js";
import { retryOperation, withCircuitBreaker, createReliabilityMeasurement, completeReliabilityMeasurement } from "./reliability.js";
// import { getUserBookSnapshots } from "../services/snapshots.bak.js";
// import { shouldCreateSnapshot, createStateSnapshot } from '../services/snapshots.bak.js';
// import { createStateDelta, applyStateDelta } from '../services/deltas.bak.js';
import { getErrorMessage } from "./error.js";
import { getPageFromDB, mapToPersistedStoryPage } from "../services/book.js";
import { applyStateDelta, createEmptyStoryState } from "./story.js";

/**
 * Gets cached branch path if valid
 * 
 * @param pageId - Page ID to check in cache
 * @returns Cached branch path or null if not found
 */
function getCachedPath(pageId: string): BranchPath | null {
  const cacheKey = pageId;
  const entry = branchCache.get(cacheKey);
  if (!entry) return null;
  
  return entry.path;
}

/**
 * Sets branch path in cache with TTL
 * 
 * @param pageId - Page ID to cache
 * @param path - Branch path to cache
 */
function setCachedPath(pageId: string, path: BranchPath): void {
  const cacheKey = pageId;
  branchCache.set(cacheKey, {
    path,
    expiresAt: Date.now() + BRANCH_CACHE_TTL
  });
}

/**
 * Gets cached reconstructed state if valid
 * 
 * @param pageId - Page ID to check in cache
 * @returns Cached state entry or null if not found
 */
function getCachedState(pageId: string): StateCacheEntry | null {
  // Cache key is just pageId since state is unique per page (branch-based architecture)
  const cacheKey = pageId;
  const entry = stateCache.get(cacheKey);
  if (!entry) return null;
  
  return entry;
}

/**
 * Sets reconstructed state in cache with TTL
 * 
 * @param pageId - Page ID to cache
 * @param state - Story state to cache
 * @param result - Reconstruction result metadata
 */
function setCachedState(pageId: string, state: StoryState, result: StateReconstructionResult): void {
  const cacheKey = pageId;
  stateCache.set(cacheKey, {
    state,
    result,
    expiresAt: Date.now() + STATE_CACHE_TTL
  });
}

/**
 * Clears all cached branch paths
 */
export function clearBranchCache(): void {
  branchCache.clear();
}

/**
 * Clears all cached reconstructed states
 */
export function clearStateCache(): void {
  stateCache.clear();
}

/**
 * Gets cache statistics for monitoring
 * 
 * @returns Cache statistics object
 */
export function getCacheStats(): {
  branchCache: { size: number; maxSize: number; hitRate?: number };
  stateCache: { size: number; maxSize: number; hitRate?: number };
} {
  return {
    branchCache: {
      size: branchCache.size,
      maxSize: MAX_CACHE_SIZE
    },
    stateCache: {
      size: stateCache.size,
      maxSize: MAX_STATE_CACHE_SIZE
    }
  };
}

// ============================================================================
// CORE BRANCH TRAVERSAL ALGORITHM
// ============================================================================

/**
 * Core branch traversal algorithm - walks backwards from current to root
 * 
 * @param currentPageId - Starting page ID (current page)
 * @param options - Traversal configuration options
 * @returns Promise resolving to branch path from root to current
 * 
 * Performance optimizations:
 * - Early termination on missing parent
 * - Depth limiting to prevent infinite loops
 * - Optional caching for repeated requests
 * - Batch validation for path integrity
 * 
 * @example
 * ```typescript
 * const path = await getBranchPath("page123");
 * console.log(`Branch depth: ${path.depth}`);
 * console.log(`Root page: ${path.pages[0].text}`);
 * console.log(`Current page: ${path.pages[path.depth - 1].text}`);
 * ```
 */
export async function getBranchPath(
  currentPageId: string,
  options: TraversalOptions = {}
): Promise<BranchPath> {
  const {
    maxDepth = MAX_TRAVERSAL_DEPTH,
    useCache = true,
    validatePath = true
  } = options;

  // Check cache first if enabled
  if (useCache) {
    const cachedPath = getCachedPath(currentPageId);
    if (cachedPath) {
      console.log(`[getBranchPath] 🎯 Cache hit for page ${currentPageId}`);
      return cachedPath;
    }
  }

  console.log(`[getBranchPath] 🌳 Traversing branch from page ${currentPageId}`);
  
  const path: DBPage[] = [];
  let cursor: DBPage | null = await getPageFromDB(currentPageId);
  // let targetBranchId: string | undefined;
  
  // // Capture the branchId from the first page to ensure consistency
  // if (cursor) {
  //   targetBranchId = cursor.branchId || undefined;
  //   console.log(`[getBranchPath] 🌱 get branchId: ${targetBranchId || 'main'}`);
  // }
  
  let depth = 0;

  // Walk backwards from current page to root
  while (cursor && depth < maxDepth) {
    path.push(cursor);
    depth++;

    // Stop if we've reached the root (no parent)
    if (!cursor.parentId) {
      break;
    }

    // Move to parent page
    // cursor = await getPageById(cursor.parentId, targetBranchId);
    cursor = await getPageFromDB(cursor.parentId);
  }

  // Validate we found a complete path
  if (path.length === 0) {
    throw new Error(`Branch traversal failed: Page ${currentPageId} not found`);
  }

  // Reverse to get root → current order
  const reversedPath = path.reverse();
  
  // Convert to PersistedStoryPage format
  const persistedPages: PersistedStoryPage[] = reversedPath.map(page => mapToPersistedStoryPage(page));

  const branchPath: BranchPath = {
    pages: persistedPages,
    rootId: reversedPath[0].id,
    currentId: currentPageId,
    depth: path.length
  };

  // Optional path validation
  if (validatePath) {
    validateBranchPath(branchPath);
  }

  // Cache the result if enabled
  if (useCache) {
    setCachedPath(currentPageId, branchPath);
  }

  console.log(`[getBranchPath] ✅ Traversed ${branchPath.depth} pages: ${branchPath.rootId} → ${branchPath.currentId}`);
  
  return branchPath;
}

/**
 * Validates branch path integrity
 * 
 * @param path - Branch path to validate
 * @throws Error if path is invalid
 */
function validateBranchPath(path: BranchPath): void {
  if (!path.pages || path.pages.length === 0) {
    throw new Error('Invalid branch path: No pages found');
  }

  // Check parent-child relationships
  for (let i = 1; i < path.pages.length; i++) {
    const current = path.pages[i];
    const parent = path.pages[i - 1];
    
    if (current.parentId !== parent.id) {
      throw new Error(
        `Invalid branch path: Page ${current.id} has parent ${current.parentId} but expected ${parent.id}`
      );
    }
  }

  // Check root page has no parent
  const root = path.pages[0];
  if (root.parentId !== null) {
    throw new Error(`Invalid branch path: Root page ${root.id} should have no parent`);
  }

  // Check current page matches
  const lastPage = path.pages[path.pages.length - 1];
  if (lastPage.id !== path.currentId) {
    throw new Error(
      `Invalid branch path: Current ID ${path.currentId} doesn't match last page ${lastPage.id}`
    );
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Gets all sibling pages (pages with same parent)
 * 
 * @param pageId - Page ID to find siblings for
 * @returns Promise resolving to array of sibling pages
 */
export async function getSiblingPages(pageId: string): Promise<PersistedStoryPage[]> {
  const page = await getPageFromDB(pageId);
  if (!page || !page.parentId) {
    return [];
  }

  try {
    const siblings = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.parentId, page.parentId));

    return siblings.map(sibling => mapToPersistedStoryPage(sibling));
  } catch (error) {
    console.error(`[getSiblingPages] ❌ Failed to get siblings for page ${pageId}:`, getErrorMessage(error));
    return [];
  }
}

/**
 * Gets branch statistics for analytics
 * 
 * @param pageId - Page ID to analyze
 * @returns Promise resolving to branch statistics
 */
export async function getBranchStats(pageId: string): Promise<BranchStats> {
  const path = await getBranchPath(pageId);
  
  // Count branches at each level
  const branchCounts: number[] = [];
  
  for (const page of path.pages) {
    const siblings = await getSiblingPages(page.id);
    branchCounts.push(siblings.length);
  }

  const totalBranches = branchCounts.reduce((sum, count) => sum + count, 0);
  const avgBranchingFactor = branchCounts.length > 0 ? totalBranches / branchCounts.length : 0;

  return {
    depth: path.depth,
    totalBranches,
    avgBranchingFactor
  };
}

/**
 * Finds the optimal snapshot for state reconstruction using hybrid strategy
 * 
 * Strategy: Combine fixed checkpoints with interval snapshots for optimal performance:
 * 1. Prefer interval snapshots (every 10 pages) - maximum 10 delta applications
 * 2. Fall back to first/middle/last checkpoints if no interval snapshot available
 * 3. Choose the snapshot that minimizes delta applications
 * 
 * @param branchPath - Complete branch path from root to current
 * @param currentPageIndex - Index of the current page in the branch path
 * @param deps - Reconstruction dependencies
 * @param totalPages - Total pages from book schema (not calculated from states)
 * @returns Promise resolving to optimal snapshot info
 */
async function findOptimalSnapshot(
  branchPath: BranchPath,
  currentPageIndex: number,
  deps: StateReconstructionDeps,
  totalPages: number
): Promise<{
  snapshotIndex: number;
  baseState: StoryState;
  snapshotPageId: string;
  snapshotType: StoryStateSnapshotType | 'none';
  deltasNeeded: number;
}> {
  // Collect all available snapshots with their metadata
  const availableSnapshots: Array<{
    index: number;
    pageId: string;
    page: number;
    state: StoryState;
    type: StoryStateSnapshotType;
    deltasNeeded: number;
    isMajorEvent: boolean;
  }> = [];
  
  // Check each page for snapshots
  for (let i = 0; i <= currentPageIndex; i++) {
    const page = branchPath.pages[i];
    const storyState = await deps.getStoryState?.(page.id);
    if (!storyState) continue;

    const deltasNeeded = currentPageIndex - i;

    let type: StoryStateSnapshotType;
    if (i === 0) {
      type = "first";
    } else if (i === currentPageIndex) {
      type = "last";
    } else if (page.page % SNAPSHOT_INTERVAL === 0) {
      type = "interval";
    } else if (
      totalPages >= MIN_PAGES_FOR_MIDDLE &&
      Math.abs(page.page - totalPages / 2) <= SNAPSHOT_INTERVAL
    ) {
      type = "middle";
    } else {
      // Generic persisted snapshot (e.g. saved mid-story by cleanup strategy)
      type = "checkpoint";
    }

    availableSnapshots.push({
      index: i,
      pageId: page.id,
      page: page.page,
      state: storyState,
      type,
      deltasNeeded,
      isMajorEvent: storyState.isMajorEvent ?? false,
    });
  }
  
  if (availableSnapshots.length === 0) {
    // No snapshot found - return empty state
    const currentPageInBranch = branchPath.pages[currentPageIndex];
    const emptyState = createEmptyStoryState(
      currentPageInBranch.id,
      currentPageInBranch.page,
      totalPages
    );
    
    return {
      snapshotIndex: 0,
      baseState: emptyState,
      snapshotPageId: branchPath.pages[0].id,
      snapshotType: 'none',
      deltasNeeded: currentPageIndex
    };
  }

  // Priority order — proximity first, type quality second,
  // isMajorEvent as a tiebreaker within the same delta count.
  //
  // Previous order (isMajorEvent → interval → deltasNeeded) forced the
  // algorithm to start from page-1 major-events even when a page-99 snapshot
  // was available for page-100 reconstruction (99 unnecessary delta applies).
  //
  // New order:
  //   1. Fewest deltas (closest snapshot to target)
  //   2. Among equal deltas: prefer isMajorEvent (more reliable baseline)
  //   3. Among equal deltas + same isMajorEvent: prefer "interval" type
  //   4. Prefer "last" over "middle"/"checkpoint"/"first" as final tiebreaker
  const sorted = [...availableSnapshots].sort((a, b) => {
    // 1. Fewest deltas needed — primary efficiency metric
    if (a.deltasNeeded !== b.deltasNeeded) return a.deltasNeeded - b.deltasNeeded;

    // 2. Major-event snapshots are more reliable baselines (tiebreaker)
    if (a.isMajorEvent !== b.isMajorEvent) return a.isMajorEvent ? -1 : 1;

    // 3. Named snapshot types by reliability
    const typeRank: Record<StoryStateSnapshotType, number> = {
      last: 0,
      interval: 1,
      middle: 2,
      checkpoint: 3,
      first: 4,
    };
    return typeRank[a.type] - typeRank[b.type];
  });

  const optimal = sorted[0];

  console.log(
    `[findOptimalSnapshot] 🎯 Selected ${optimal.type} snapshot at page ${optimal.page} ` +
    `(index ${optimal.index}), needs ${optimal.deltasNeeded} deltas` +
    (optimal.isMajorEvent ? " [major-event]" : "")
  );

  return {
    snapshotIndex: optimal.index,
    baseState: structuredClone(optimal.state),
    snapshotPageId: optimal.pageId,
    snapshotType: optimal.type,
    deltasNeeded: optimal.deltasNeeded
  };
}

/**
 * Reconstructs story state from branch path using hybrid delta + checkpoint system
 * 
 * This advanced reconstruction system uses a combination of snapshots (checkpoints)
 * and deltas to efficiently rebuild the complete story state at any point in the branch.
 * 
 * Incremental Delta Application Principle:
 * The reconstruction follows a strict chronological approach where deltas are applied
 * incrementally from the oldest available base state to the current page:
 * 
 * Example Case (Reconstructing page 3):
 * ```
 * 1. Find optimal snapshot: page 1 (oldest with stored state)
 * 2. Build branch path: [page1, page2, page3]
 * 3. Apply deltas chronologically:
 *    - Start with page1 base state
 *    - Apply page2.stateDelta → intermediate state
 *    - Apply page3.stateDelta → final state
 * 4. Result: page1(base) + page2(delta) + page3(delta) = reconstructed state
 * ```
 * 
 * Key Principles:
 * - Oldest Base: Always start with earliest available stored state
 * - Chronological Order: Apply deltas in the order they occurred in the story
 * - Incremental Accumulation: Each delta builds upon the result of the previous one
 * - State Integrity: Ensures accurate state reconstruction matching actual story progression
 * 
 * Strategy:
 * 1. Try direct state retrieval (fastest)
 * 2. Find optimal snapshot using hybrid first/middle/last + interval strategy
 * 3. Apply deltas forward from snapshot to current page in chronological order
 * 4. Fallback to basic reconstruction if no snapshot/deltas available
 * 
 * Delta Application Process:
 * - Loop from `snapshotInfo.snapshotIndex + 1` to `currentPageIndex`
 * - Each iteration: `currentState = applyStateDelta(currentState, page.stateDelta)`
 * - Ensures proper state accumulation from oldest to newest
 * - Includes error handling for individual delta failures
 * 
 * @param currentPageId - Current page ID to reconstruct state for
 * @param deps - Dependencies for state reconstruction
 * @param options - Traversal options
 * @returns Promise resolving to complete reconstruction result
 * 
 * @example
 * ```typescript
 * const result = await reconstructStoryState('page123', {
 *   getPageById: (id) => dbPageService.getPage(id),
 *   getStoryState: (id) => stateService.getState(id)
 * });
 * 
 * console.log(`Reconstructed state with ${result.deltasApplied} deltas using ${result.snapshotsUsed} snapshots`);
 * console.log(`Method used: ${result.method}`);
 * 
 * // Reconstruction with custom options
 * const result = await reconstructStoryState('page456', deps, {
 *   useCache: false,
 *   maxTraversalDepth: 10
 * });
 * ```
 */
export async function reconstructStoryState(
  currentPageId: string,
  deps: StateReconstructionDeps,
  options: TraversalOptions = {}
): Promise<StateReconstructionResult> {
  const measurement = createReliabilityMeasurement(
    "reconstruction",
    "state_reconstruction",
    currentPageId,
    { currentPageId, useCache: options.useCache, validatePath: options.validatePath }
  );

  let totalPages = BOOK_MIN_PAGES;
  // Track actual page number so the fallback state is correct
  let actualPageNumber = 1;

  try {
    // Check cache first (no retry needed for cache operations)
    if (options.useCache !== false) {
      const cached = getCachedState(currentPageId);
      if (cached) {
        console.log(`[reconstructStoryState] 🎯 Cache hit for page ${currentPageId}`);
        const result = cached.result;
        completeReliabilityMeasurement(measurement, true, {
          method: result.method,
          cached: true,
          snapshotsUsed: result.snapshotsUsed,
          deltasApplied: result.deltasApplied
        });
        return result;
      }
    }
    
    console.log(`[reconstructStoryState] 🔄 Reconstructing state for page ${currentPageId}`);
    
    // Wrap entire reconstruction in retry logic
    const result = await retryOperation(async () => {
      // Strategy 1: Direct state retrieval (fastest)
      if (deps.getStoryState) {
        try {
          const directState = await withCircuitBreaker(
            () => deps.getStoryState!(currentPageId),
            `${GET_STORY_STATE_KEY_PREFIX}:${currentPageId}`,
            GET_STORY_STATE_CIRCUIT_THRESHOLD,
            GET_STORY_STATE_CIRCUIT_TIMEOUT
          );
          
          if (directState) {
            const result: StateReconstructionResult = {
              state: directState,
              snapshotsUsed: 0,
              deltasApplied: 0,
              method: 'direct',
              reconstructionTimeMs: 0
            };
            
            if (options.useCache !== false) {
              setCachedState(currentPageId, directState, result);
            }
            
            console.log(`[reconstructStoryState] ✅ Direct state retrieval for ${currentPageId}`);
            completeReliabilityMeasurement(measurement, true, {
              method: 'direct',
              cached: false,
              snapshotsUsed: 0,
              deltasApplied: 0
            });
            return result;
          }
        } catch (error) {
          console.warn(
            `[reconstructStoryState] ⚠️ Direct retrieval failed, falling back to hybrid:`,
            getErrorMessage(error)
          );
        }
      }

      // Strategy 2: Hybrid delta + checkpoint reconstruction
      const branchPath = await retryOperation(
        () =>
          withCircuitBreaker(
            () => getBranchPath(currentPageId, options),
            `${GET_BRANCH_PATH_KEY_PREFIX}:${currentPageId}`,
            GET_BRANCH_PATH_CIRCUIT_THRESHOLD,
            GET_BRANCH_PATH_CIRCUIT_TIMEOUT
          ),
        BRANCH_PATH_MAX_RETRIES,
        BRANCH_PATH_BASE_DELAY
      );
      
      // Find the actual index of currentPageId in the branch path
      const currentPageIndex = branchPath.pages.findIndex(p => p.id === currentPageId);
      if (currentPageIndex === -1) {
        throw new Error(`Current page ${currentPageId} not found in branch path`);
      }

      // Get current page in the branch path
      const currentPageInBranch = branchPath.pages[currentPageIndex];
      // Capture actual page number now that we have it
      actualPageNumber = currentPageInBranch.page;

      // Resolve totalPages from book
      if (deps.getBook) {
        try {
          const currentPage = await withCircuitBreaker(
            () => deps.getPageById!(currentPageId),
            `${GET_PAGE_BY_ID_KEY_PREFIX}:${currentPageId}`,
            GET_PAGE_BY_ID_CIRCUIT_THRESHOLD,
            GET_PAGE_BY_ID_CIRCUIT_TIMEOUT
          );

          if (currentPage?.bookId) {
            const book = await withCircuitBreaker(
              () => deps.getBook!(currentPage.bookId),
              `${GET_BOOK_KEY_PREFIX}:${currentPage.bookId}`,
              GET_BOOK_CIRCUIT_THRESHOLD,
              GET_BOOK_CIRCUIT_TIMEOUT
            );

            if (book?.totalPages) {
              totalPages = book.totalPages;
              console.log(`[reconstructStoryState] 📚 totalPages from book: ${totalPages}`);
            } else {
              totalPages = Math.max(...branchPath.pages.map(p => p.page));
              console.log(`[reconstructStoryState] ⚠️ No book found, inferred totalPages: ${totalPages}`);
            }
          } else {
            totalPages = Math.max(...branchPath.pages.map(p => p.page));
            console.log(`[reconstructStoryState] ⚠️ No bookId found, using branch path totalPages: ${totalPages}`);
          }
        } catch (error) {
          console.warn(`[reconstructStoryState] ⚠️ Failed to get book info:`, getErrorMessage(error));
          totalPages = Math.max(...branchPath.pages.map(p => p.page));
        }
      }

      // Find the optimal base snapshot
      const snapshotInfo = await retryOperation(
        () => findOptimalSnapshot(branchPath, currentPageIndex, deps, totalPages),
        SNAPSHOT_SELECTION_MAX_RETRIES,
        SNAPSHOT_SELECTION_BASE_DELAY
      );

      // Apply deltas chronologically from snapshot → current page
      let currentState = snapshotInfo.baseState;
      let deltasApplied = 0;
      
      // Apply deltas forward from snapshot position
      for (let i = snapshotInfo.snapshotIndex + 1; i <= currentPageIndex; i++) {
        const page = branchPath.pages[i];
        const delta = page.stateDelta;

        if (!delta) {
          console.warn(`[reconstructStoryState] ⚠️ No delta for page ${page.id} (page ${page.page}), state may be incomplete`);
          continue;
        }

        try {
          console.log(`[reconstructStoryState] 🧩 Applying delta from page ${page.page}`);

          // Note: Do NOT wrap applyStateDelta in retryOperation.
          // It is a pure function (no shared-reference mutations),
          // so retrying is safe — but retrying a step inside an accumulation loop
          // is semantically wrong: each retry would re-apply the same delta to the
          // same base, giving correct output only because it's now pure. Keeping it
          // simple and direct is clearer and avoids any future confusion.
          currentState = applyStateDelta(currentState, delta, page.place);
          deltasApplied++;

          console.log(`[reconstructStoryState] 🔄 Applied delta ${i - snapshotInfo.snapshotIndex}/${snapshotInfo.deltasNeeded} (page ${page.page})`);
        } catch (error) {
          // Non-fatal: log and continue with the current (partially-updated) state
          console.warn(`[reconstructStoryState] ⚠️ Delta for page ${page.id} failed, continuing:`, { error: getErrorMessage(error), pageId: page.id, pageIndex: i, deltasApplied });
        }
      }

      // Pin pageId / page / maxPage to the target page
      currentState.pageId = currentPageId;
      currentState.page = currentPageInBranch.page;
      currentState.maxPage = totalPages;

      // Rebuild actionsHistory from branch path
      // The snapshot's actionsHistory only covers pages up to the snapshot;
      // we need to extend it through the delta pages.
      currentState.actionsHistory = [];
      for (let i = 1; i <= currentPageIndex; i++) {
        const page = branchPath.pages[i];
        const parentPage = branchPath.pages[i - 1];
        
        // Find the action in parent page that led to this page
        const selectedAction = parentPage.actions?.find(action => action.destinationPageIds?.some(p => p === page.id));
        
        if (selectedAction) {
          currentState.actionsHistory.push({
            text: selectedAction.text,
            type: selectedAction.type,
            hint: selectedAction.hint,
            page: parentPage.page, // Page where action was taken, not destination
            pageId: parentPage.id, // Page where action was taken, not destination
            nextPageId: page.id,
          });
        } else {
          console.warn(`[reconstructStoryState] ⚠️ No matching action found for page ${page.id} from parent ${parentPage.id}`);
        }
      }

      // Ensure threads array is initialised
      if (!currentState.threads || currentState.threads.length === 0) {
        if (currentPageInBranch.page > 1) {
          console.warn(`[reconstructStoryState] ⚠️ No threads for page ${currentPageId}, initialising empty array`);
        }
        currentState.threads = [];
      }
      
      const result: StateReconstructionResult = {
        state: currentState,
        snapshotsUsed: snapshotInfo.snapshotType === 'none' ? 0 : 1,
        deltasApplied,
        method: snapshotInfo.snapshotType === 'none' ? 'fallback' : 'snapshot_plus_deltas',
        reconstructionTimeMs: 0, // Will be set by measurement.end()
        baseSnapshotPageId: snapshotInfo.snapshotType === 'none' ? undefined : snapshotInfo.snapshotPageId
      };
      
      // Cache the result
      if (options.useCache !== false) {
        setCachedState(currentPageId, currentState, result);
      }
      
      console.log(`[reconstructStoryState] ✅ Reconstruction complete: ${result.method}, ${deltasApplied} deltas, snapshot: ${snapshotInfo.snapshotType}`);
      return result;
      
    }, RECONSTRUCTION_MAX_RETRIES, RECONSTRUCTION_BASE_DELAY);

    completeReliabilityMeasurement(measurement, true, {
      method: result.method,
      cached: false,
      snapshotsUsed: result.snapshotsUsed,
      deltasApplied: result.deltasApplied,
    });

    return result;
  } catch (error) {
    console.warn(
      `[reconstructStoryState] ❌ All reconstruction strategies failed, using fallback state`,
      { error: getErrorMessage(error), currentPageId, options }
    );

    // Use actualPageNumber captured earlier instead of hardcoded 1
    const fallbackState = createEmptyStoryState(currentPageId, actualPageNumber, totalPages);
    const result: StateReconstructionResult = {
      state: fallbackState,
      snapshotsUsed: 0,
      deltasApplied: 0,
      method: 'fallback',
      reconstructionTimeMs: 0
    };

    completeReliabilityMeasurement(measurement, false, {
      method: 'fallback',
      error: getErrorMessage(error),
      cached: false,
      snapshotsUsed: 0,
      deltasApplied: 0
    });
    
    return result;
  }
}

// ============================================================================
// SNAPSHOT CREATION STRATEGY
// ============================================================================

// /**
//  * Analyzes snapshot usage patterns for cleanup optimization
//  * 
//  * This function provides detailed analysis of snapshot patterns
//  * to inform cleanup decisions and identify optimization opportunities.
//  * 
//  * @param userId - User identifier
//  * @param bookId - Book identifier
//  * @returns Snapshot analysis with recommendations
//  */
// export async function analyzeSnapshotUsage(
//   userId: string,
//   bookId: string
// ): Promise<{
//   totalSnapshots: number;
//   majorCheckpoints: number;
//   periodicSnapshots: number;
//   branchStartSnapshots: number;
//   majorEventSnapshots: number;
//   averagePageGap: number;
//   oldestSnapshot: Date | null;
//   newestSnapshot: Date | null;
//   recommendations: string[];
// }> {
//   const snapshots = await getUserBookSnapshots(userId, bookId, 100); // Get more for analysis
  
//   const majorCheckpoints = snapshots.filter(s => s.isMajorCheckpoint);
//   const periodicSnapshots = snapshots.filter(s => s.reason === 'periodic');
//   const branchStartSnapshots = snapshots.filter(s => s.reason === 'branch_start');
//   const majorEventSnapshots = snapshots.filter(s => s.reason === 'major_event');
  
//   const averagePageGap = snapshots.length > 1 
//     ? Math.round((snapshots[0].page - snapshots[snapshots.length - 1].page) / snapshots.length)
//     : 0;
  
//   const recommendations: string[] = [];
  
//   // Generate recommendations based on patterns
//   if (averagePageGap > 10) {
//     recommendations.push("Consider more frequent periodic snapshots (current gap > 10 pages)");
//   }
  
//   if (majorCheckpoints.length < snapshots.length * 0.2) {
//     recommendations.push("Few major checkpoints detected - consider marking more significant events");
//   }
  
//   if (periodicSnapshots.length > majorCheckpoints.length * 3) {
//     recommendations.push("High ratio of periodic to major checkpoints - cleanup may be needed");
//   }
  
//   return {
//     totalSnapshots: snapshots.length,
//     majorCheckpoints: majorCheckpoints.length,
//     periodicSnapshots: periodicSnapshots.length,
//     branchStartSnapshots: branchStartSnapshots.length,
//     majorEventSnapshots: majorEventSnapshots.length,
//     averagePageGap,
//     oldestSnapshot: snapshots[snapshots.length - 1]?.createdAt || null,
//     newestSnapshot: snapshots[0]?.createdAt || null,
//     recommendations
//   };
// }

/**
 * Selects optimal snapshots to keep based on importance and page progression
 * 
 * This is a pure algorithmic function that determines which snapshots should be
 * retained based on their importance (major checkpoints) and recency. It does
 * NOT perform any database operations - only selection logic.
 * 
 * Purpose: Used by reconstruction algorithms to choose the best snapshot
 * as a starting point for state reconstruction from a given set of snapshots.
 * 
 * Algorithm Strategy:
 * 1. Always keep major checkpoints (branch_start, major_event) - these are
 *    critical for story integrity and cannot be deleted
 * 2. For regular snapshots, keep the newest ones up to the remaining limit
 * 3. Return snapshots sorted by page number for sequential processing
 * 
 * Use Case: Called during story reconstruction when multiple snapshots
 * are available and we need to select the optimal base snapshot.
 * 
 * @param snapshots - Array of available snapshots to analyze
 * @param maxSnapshots - Maximum number of snapshots to keep (default: 20)
 * @returns Array of selected snapshots sorted by page number
 * 
 * @example
 * ```typescript
 * // During reconstruction, select best snapshot from available options
 * const availableSnapshots = await getSnapshotsInRange(startPage, endPage);
 * const selectedSnapshots = selectOptimalSnapshots(availableSnapshots, 15);
 * 
 * // Use the newest selected snapshot as reconstruction base
 * const baseSnapshot = selectedSnapshots[selectedSnapshots.length - 1];
 * ```
 */
export function selectOptimalSnapshots(
  snapshots: DBStoryState[],
  maxSnapshots: number = 20
): DBStoryState[] {
  if (snapshots.length <= maxSnapshots) {
    return snapshots;
  }
  
  // Sort by creation time (newest first) to prioritize recent snapshots
  const sorted = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  
  // Always keep major checkpoints - these are critical for story integrity
  const majorCheckpoints = sorted.filter(s => s.isMajorEvent);
  const regularSnapshots = sorted.filter(s => !s.isMajorEvent);
  
  // Calculate how many regular snapshots we can keep after reserving space for checkpoints
  const remainingSlots = maxSnapshots - majorCheckpoints.length;
  
  if (remainingSlots <= 0) {
    // Only major checkpoints fit, keep the newest ones up to limit
    return majorCheckpoints.slice(0, maxSnapshots);
  }
  
  // Keep all major checkpoints + newest regular snapshots within remaining slots
  const keptRegular = regularSnapshots.slice(0, remainingSlots);
  
  // Return final selection sorted by page number for sequential processing
  return [...majorCheckpoints, ...keptRegular].sort((a, b) => a.page - b.page);
}

/**
 * Gets multiple branch paths in parallel for efficiency
 * 
 * @param pageIds - Array of page IDs to traverse
 * @param options - Traversal options
 * @returns Promise resolving to array of branch paths
 */
export async function getBranchPathsBatch(
  pageIds: string[],
  options: TraversalOptions = {}
): Promise<BranchPath[]> {
  console.log(`[getBranchPathsBatch] 📦 Processing ${pageIds.length} branch paths`);
  
  // Process in parallel batches to avoid overwhelming the database
  const batchSize = 5;
  const results: BranchPath[] = [];
  
  for (let i = 0; i < pageIds.length; i += batchSize) {
    const batch = pageIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(pageId => getBranchPath(pageId, options))
    );
    results.push(...batchResults);
  }
  
  console.log(`[getBranchPathsBatch] ✅ Completed ${results.length} branch paths`);
  return results;
}

/**
 * Pre-warms cache with commonly accessed branch paths
 * 
 * @param pageIds - Array of page IDs to pre-cache
 */
export async function preWarmBranchCache(pageIds: string[]): Promise<void> {
  console.log(`[preWarmBranchCache] 🔥 Pre-warming cache with ${pageIds.length} pages`);
  
  await getBranchPathsBatch(pageIds, { useCache: true });
  
  console.log(`[preWarmBranchCache] ✅ Cache pre-warmed`);
}
