/**
 * @overview Branch Traversal Algorithm Module
 * 
 * Implements efficient branch traversal for story navigation with caching,
 * path reconstruction, and performance optimizations.
 * 
 * Features:
 * - Backward traversal from current page to root
 * - Path reconstruction with proper ordering
 * - Caching for performance optimization
 * - Depth limiting to prevent infinite loops
 * - Batch queries for database efficiency
 */

import { dbRead } from "../db/client.js";
import { pages } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { SNAPSHOT_INTERVAL, MIN_PAGES_FOR_MIDDLE } from "../config/story.js";
import type { DBPage } from "../types/schema.js";
import type { PersistedStoryPage, StoryState, StateSnapshot, StateReconstructionResult, BranchStats, TraversalOptions, BranchPath, StateReconstructionDeps, CacheEntry, StateCacheEntry } from "../types/story.js";
import { branchCache, stateCache, BRANCH_CACHE_TTL, STATE_CACHE_TTL, MAX_CACHE_SIZE, MAX_STATE_CACHE_SIZE } from "../services/story-state-cache.js";
import { startPerformanceMeasurement } from "../services/performance-monitoring.js";

// Re-export centralized cache constants for backward compatibility
export { BRANCH_CACHE_TTL, STATE_CACHE_TTL, MAX_CACHE_SIZE, MAX_STATE_CACHE_SIZE } from "../services/story-state-cache.js";

// Re-export centralized functions for use within this module
import { shouldCreateSnapshot, createStateSnapshot } from '../services/snapshots.js';
import { createStateDelta, applyStateDelta } from '../services/deltas.js';
import { getErrorMessage } from "./error.js";
import { DEFAULT_BOOK_MAX_PAGES } from "../config/story.js";

// Re-export for backward compatibility
export { shouldCreateSnapshot, createStateSnapshot, createStateDelta, applyStateDelta };

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum traversal depth to prevent infinite loops */
export const MAX_TRAVERSAL_DEPTH = 100;

/** Snapshot creation intervals */
export const SNAPSHOT_INTERVAL_PAGES = 5; // Create snapshot every 5 pages
export const MAJOR_EVENT_SNAPSHOT_INTERVAL = 10; // For major events

/**
 * Gets cached branch path if valid
 * 
 * @param userId - User ID for cache key isolation
 * @param pageId - Page ID to check in cache
 * @returns Cached branch path or null if not found
 */
function getCachedPath(userId: string, pageId: string): BranchPath | null {
  const cacheKey = `${userId}:${pageId}`;
  const entry = branchCache.get(cacheKey);
  if (!entry) return null;
  
  return entry.path;
}

/**
 * Sets branch path in cache with TTL
 * 
 * @param userId - User ID for cache key isolation
 * @param pageId - Page ID to cache
 * @param path - Branch path to cache
 */
function setCachedPath(userId: string, pageId: string, path: BranchPath): void {
  const cacheKey = `${userId}:${pageId}`;
  branchCache.set(cacheKey, {
    path,
    expiresAt: Date.now() + BRANCH_CACHE_TTL
  });
}

/**
 * Gets cached reconstructed state if valid
 * 
 * @param userId - User ID for cache key isolation
 * @param pageId - Page ID to check in cache
 * @returns Cached state entry or null if not found
 */
function getCachedState(userId: string, pageId: string): StateCacheEntry | null {
  const cacheKey = `${userId}:${pageId}`;
  const entry = stateCache.get(cacheKey);
  if (!entry) return null;
  
  return entry;
}

/**
 * Sets reconstructed state in cache with TTL
 * 
 * @param userId - User ID for cache key isolation
 * @param pageId - Page ID to cache
 * @param state - Story state to cache
 * @param result - Reconstruction result metadata
 */
function setCachedState(userId: string, pageId: string, state: StoryState, result: StateReconstructionResult): void {
  const cacheKey = `${userId}:${pageId}`;
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
 * Retrieves page by ID with error handling and branch validation
 * 
 * @param pageId - Page ID to retrieve
 * @param targetBranchId - Target branch ID to ensure branch consistency (optional)
 * @returns Page data or null if not found
 */
async function getPageById(pageId: string, targetBranchId?: string): Promise<DBPage | null> {
  try {
    const conditions = [eq(pages.id, pageId)];
    
    // If targetBranchId is provided, add branch condition
    if (targetBranchId !== undefined) {
      conditions.push(eq(pages.branchId, targetBranchId));
    }
    
    const result = await dbRead
      .select()
      .from(pages)
      .where(and(...conditions))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`[getPageById] ❌ Failed to retrieve page ${pageId}:`, getErrorMessage(error));
    return null;
  }
}

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
  userId: string,
  options: TraversalOptions = {}
): Promise<BranchPath> {
  const {
    maxDepth = MAX_TRAVERSAL_DEPTH,
    useCache = true,
    validatePath = true
  } = options;

  // Check cache first if enabled
  if (useCache) {
    const cachedPath = getCachedPath(userId, currentPageId);
    if (cachedPath) {
      console.log(`[getBranchPath] 🎯 Cache hit for page ${currentPageId}`);
      return cachedPath;
    }
  }

  console.log(`[getBranchPath] 🌳 Traversing branch from page ${currentPageId}`);
  
  const path: DBPage[] = [];
  let cursor: DBPage | null = await getPageById(currentPageId);
  let targetBranchId: string | undefined;
  
  // Capture the branchId from the first page to ensure consistency
  if (cursor) {
    targetBranchId = cursor.branchId || undefined;
    console.log(`[getBranchPath] 🌱 get branchId: ${targetBranchId || 'main'}`);
  }
  
  let depth = 0;

  // Walk backwards from current page to root
  while (cursor && depth < maxDepth) {
    path.push(cursor);
    depth++;

    // Stop if we've reached the root (no parent)
    if (!cursor.parentId) {
      break;
    }

    // Move to parent page, ensuring we stay in the same branch
    cursor = await getPageById(cursor.parentId, targetBranchId);
  }

  // Validate we found a complete path
  if (path.length === 0) {
    throw new Error(`Branch traversal failed: Page ${currentPageId} not found`);
  }

  // Reverse to get root → current order
  const reversedPath = path.reverse();
  
  // Convert to PersistedStoryPage format
  const persistedPages: PersistedStoryPage[] = reversedPath.map(page => ({
    id: page.id,
    bookId: page.bookId,
    parentId: page.parentId,
    branchId: page.branchId,
    page: page.page,
    text: page.text,
    mood: page.mood || undefined,
    place: page.place || undefined,
    timeOfDay: page.timeOfDay || undefined,
    charactersPresent: page.charactersPresent || [],
    keyEvents: page.keyEvents || [],
    importantObjects: page.importantObjects || [],
    actions: page.actions || [],
    addTraumaTag: page.addTraumaTag || undefined,
    characterUpdates: page.characterUpdates || undefined,
    placeUpdates: page.placeUpdates || undefined,
  } satisfies PersistedStoryPage));

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
    setCachedPath(userId, currentPageId, branchPath);
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
  const page = await getPageById(pageId);
  if (!page || !page.parentId) {
    return [];
  }

  try {
    const siblings = await dbRead
      .select()
      .from(pages)
      .where(and(eq(pages.parentId, page.parentId), eq(pages.branchId, page.branchId || '')));

    return siblings.map(sibling => ({
      id: sibling.id,
      bookId: sibling.bookId,
      parentId: sibling.parentId,
      branchId: sibling.branchId,
      page: sibling.page,
      text: sibling.text,
      mood: sibling.mood || undefined,
      place: sibling.place || undefined,
      timeOfDay: sibling.timeOfDay || undefined,
      charactersPresent: sibling.charactersPresent || [],
      keyEvents: sibling.keyEvents || [],
      importantObjects: sibling.importantObjects || [],
      actions: sibling.actions || [],
      addTraumaTag: sibling.addTraumaTag || undefined,
      characterUpdates: sibling.characterUpdates || undefined,
      placeUpdates: sibling.placeUpdates || undefined,
    } satisfies PersistedStoryPage));
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
export async function getBranchStats(pageId: string, userId: string): Promise<BranchStats> {
  const path = await getBranchPath(pageId, userId);
  
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
  snapshotType: 'interval' | 'first' | 'middle' | 'last' | 'none';
  deltasNeeded: number;
}> {
  // Collect all available snapshots with their metadata
  const availableSnapshots: Array<{
    index: number;
    pageId: string;
    page: number;
    state: StoryState;
    type: 'interval' | 'first' | 'middle' | 'last';
    deltasNeeded: number;
  }> = [];
  
  // Check each page for snapshots
  for (let i = 0; i <= currentPageIndex; i++) {
    const page = branchPath.pages[i];
    const snapshot = await deps.getSnapshot(page.id);
    
    if (snapshot) {
      const deltasNeeded = currentPageIndex - i;
      let type: 'interval' | 'first' | 'middle' | 'last';
      
      // Determine snapshot type
      if (i === 0) {
        type = 'first';
      } else if (i === currentPageIndex) {
        type = 'last';
      } else if (page.page % SNAPSHOT_INTERVAL === 0) {
        type = 'interval';
      } else {
        // Check if this could be considered a middle snapshot using book's totalPages
        if (totalPages >= MIN_PAGES_FOR_MIDDLE && Math.abs(page.page - totalPages / 2) <= SNAPSHOT_INTERVAL) {
          type = 'middle';
        } else {
          type = 'interval'; // Treat as interval for selection purposes
        }
      }
      
      availableSnapshots.push({
        index: i,
        pageId: page.id,
        page: page.page,
        state: snapshot.state,
        type,
        deltasNeeded
      });
    }
  }
  
  if (availableSnapshots.length === 0) {
    // No snapshot found - return empty state
    const emptyState = createEmptyStoryState(
      branchPath.pages[currentPageIndex].id,
      branchPath.pages[currentPageIndex].page
    );
    
    return {
      snapshotIndex: 0,
      baseState: emptyState,
      snapshotPageId: branchPath.pages[0].id,
      snapshotType: 'none',
      deltasNeeded: currentPageIndex
    };
  }
  
  // Prioritize snapshots by type and deltas needed
  const prioritizedSnapshots = availableSnapshots.sort((a, b) => {
    // First priority: Interval snapshots (optimal performance)
    if (a.type === 'interval' && b.type !== 'interval') return -1;
    if (b.type === 'interval' && a.type !== 'interval') return 1;
    
    // Second priority: Fewer deltas needed
    if (a.deltasNeeded !== b.deltasNeeded) return a.deltasNeeded - b.deltasNeeded;
    
    // Third priority: Last snapshot (most recent)
    if (a.type === 'last' && b.type !== 'last') return -1;
    if (b.type === 'last' && a.type !== 'last') return 1;
    
    // Fourth priority: First snapshot (good baseline)
    if (a.type === 'first' && b.type !== 'first') return -1;
    if (b.type === 'first' && a.type !== 'first') return 1;
    
    return 0;
  });
  
  const optimal = prioritizedSnapshots[0];
  
  console.log(`[findOptimalSnapshot] 🎯 Selected ${optimal.type} snapshot at page ${optimal.page} (index ${optimal.index}), needs ${optimal.deltasNeeded} deltas`);
  
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
 * Strategy:
 * 1. Try direct state retrieval (fastest)
 * 2. Find optimal snapshot using hybrid first/middle/last + interval strategy
 * 3. Apply deltas forward from snapshot to current page
 * 4. Fallback to basic reconstruction if no snapshot/deltas available
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
 *   getSnapshot: (id) => snapshotService.getSnapshot(id),
 *   getDelta: (id) => deltaService.getDelta(id),
 *   getStoryState: (id) => stateService.getState(id)
 * });
 * 
 * console.log(`Reconstructed state with ${result.deltasApplied} deltas`);
 * console.log(`Method used: ${result.method}`);
 * ```
 */
export async function reconstructStoryState(
  currentPageId: string,
  userId: string,
  deps: StateReconstructionDeps,
  options: TraversalOptions = {}
): Promise<StateReconstructionResult> {
  const measurement = startPerformanceMeasurement('reconstruction', 'state_reconstruction', userId, {
    currentPageId,
    useCache: options.useCache,
    validatePath: options.validatePath
  });
  
  try {
    // Check cache first
    if (options.useCache !== false) {
      const cached = getCachedState(userId, currentPageId);
      if (cached) {
        console.log(`[reconstructStoryState] 🎯 Cache hit for page ${currentPageId}`);
        const result = cached.result;
        measurement.end({ 
          method: result.method, 
          cached: true,
          snapshotsUsed: result.snapshotsUsed,
          deltasApplied: result.deltasApplied
        });
        return result;
      }
    }
    
    console.log(`[reconstructStoryState] 🔄 Reconstructing state for page ${currentPageId}`);
    
    // Strategy 1: Try direct state retrieval (fastest)
    if (deps.getStoryState) {
      const directState = await deps.getStoryState(currentPageId);
      if (directState) {
        const result: StateReconstructionResult = {
          state: directState,
          snapshotsUsed: 0,
          deltasApplied: 0,
          method: 'direct',
          reconstructionTimeMs: 0
        };
        
        if (options.useCache !== false) {
          setCachedState(userId, currentPageId, directState, result);
        }
        
        console.log(`[reconstructStoryState] ✅ Direct state retrieval for ${currentPageId}`);
        measurement.end({ 
          method: 'direct', 
          cached: false,
          snapshotsUsed: 0,
          deltasApplied: 0
        });
        return result;
      }
    }
    
    // Strategy 2: Hybrid delta + checkpoint reconstruction with optimal snapshot selection
    const branchPath = await getBranchPath(currentPageId, userId, options);
    const currentPageIndex = branchPath.pages.length - 1;
    
    // Get book information to retrieve totalPages for optimal snapshot selection
    let totalPages = DEFAULT_BOOK_MAX_PAGES; // Fallback to default
    if (deps.getBook) {
      try {
        const currentPage = await deps.getPageById(currentPageId);
        if (currentPage?.bookId) {
          const book = await deps.getBook(currentPage.bookId);
          if (book?.totalPages) {
            totalPages = book.totalPages;
            console.log(`[reconstructStoryState] 📚 Using totalPages from book schema: ${totalPages}`);
          } else {
            totalPages = Math.max(...branchPath.pages.map(p => p.page));
            console.log(`[reconstructStoryState] ⚠️ Book not found, using branch path totalPages: ${totalPages}`);
          }
        } else {
          totalPages = Math.max(...branchPath.pages.map(p => p.page));
          console.log(`[reconstructStoryState] ⚠️ No bookId found, using branch path totalPages: ${totalPages}`);
        }
      } catch (error) {
        totalPages = Math.max(...branchPath.pages.map(p => p.page));
        console.log(`[reconstructStoryState] ⚠️ Could not get book info, using branch path totalPages: ${totalPages}`);
      }
    } else {
      totalPages = Math.max(...branchPath.pages.map(p => p.page));
      console.log(`[reconstructStoryState] ⚠️ getBook not available, using branch path totalPages: ${totalPages}`);
    }
    
    // Find optimal snapshot using hybrid strategy
    const snapshotInfo = await findOptimalSnapshot(branchPath, currentPageIndex, deps, totalPages);
    
    // Apply deltas forward from snapshot position
    let deltasApplied = 0;
    for (let i = snapshotInfo.snapshotIndex + 1; i <= currentPageIndex; i++) {
      const page = branchPath.pages[i];
      const delta = await deps.getDelta(page.id);
      
      if (delta) {
        applyStateDelta(snapshotInfo.baseState, delta);
        deltasApplied++;
        console.log(`[reconstructStoryState] 🔄 Applied delta for page ${page.id} (${i - snapshotInfo.snapshotIndex}/${snapshotInfo.deltasNeeded})`);
      } else {
        console.log(`[reconstructStoryState] ⚠️ No delta found for page ${page.id}, state may be incomplete`);
      }
    }
    
    // Ensure final state matches current page
    snapshotInfo.baseState.pageId = currentPageId;
    snapshotInfo.baseState.page = branchPath.pages[currentPageIndex].page;
    
    const result: StateReconstructionResult = {
      state: snapshotInfo.baseState,
      snapshotsUsed: snapshotInfo.snapshotType === 'none' ? 0 : 1,
      deltasApplied,
      method: snapshotInfo.snapshotType === 'none' ? 'fallback' : 'snapshot_plus_deltas',
      reconstructionTimeMs: 0, // Will be set by measurement.end()
      baseSnapshotPageId: snapshotInfo.snapshotType === 'none' ? undefined : snapshotInfo.snapshotPageId
    };
    
    // Cache the result
    if (options.useCache !== false) {
      setCachedState(userId, currentPageId, snapshotInfo.baseState, result);
    }
    
    console.log(`[reconstructStoryState] ✅ Reconstruction complete: ${result.method}, ${deltasApplied} deltas, snapshot: ${snapshotInfo.snapshotType}`);
    
    const metric = measurement.end({ 
      method: result.method, 
      cached: false,
      snapshotsUsed: result.snapshotsUsed,
      deltasApplied: result.deltasApplied,
      snapshotType: snapshotInfo.snapshotType,
      branchDepth: branchPath.depth
    });
    
    // Update reconstruction time from actual measurement
    result.reconstructionTimeMs = metric.durationMs;
    
    return result;
    
  } catch (error) {
    console.error(`[reconstructStoryState] ❌ Failed to reconstruct state for ${currentPageId}:`, getErrorMessage(error));
    
    // Ultimate fallback: minimal state
    const fallbackState = createEmptyStoryState(currentPageId, 1);
    const result: StateReconstructionResult = {
      state: fallbackState,
      snapshotsUsed: 0,
      deltasApplied: 0,
      method: 'fallback',
      reconstructionTimeMs: 0
    };
    
    measurement.end({ 
      method: 'fallback', 
      error: getErrorMessage(error),
      cached: false,
      snapshotsUsed: 0,
      deltasApplied: 0
    });
    
    return result;
  }
}

/**
 * Creates an empty story state with default values
 * 
 * @param pageId - Page ID for the state
 * @param pageNumber - Page number
 * @returns Empty story state
 */
export function createEmptyStoryState(pageId: string, pageNumber: number): StoryState {
  return {
    pageId,
    page: pageNumber,
    maxPage: DEFAULT_BOOK_MAX_PAGES,
    flags: {
      trust: 'medium',
      fear: 'low',
      guilt: 'low',
      curiosity: 'medium'
    },
    traumaTags: [],
    psychologicalProfile: {
      archetype: 'survivor',
      stability: 'stable',
      dominantTraits: ['curious', 'cautious'],
      manipulationAffinity: 'emotional'
    },
    hiddenState: {
      truthLevel: 'ambiguous',
      threatProximity: 'distant',
      realityStability: 'stable'
    },
    memoryIntegrity: 'stable',
    difficulty: 'medium',
    viableEnding: undefined,
    characters: {},
    places: {},
    pageHistory: [],
    actionsHistory: [],
    contextHistory: ''
  };
}


// ============================================================================
// SNAPSHOT CREATION STRATEGY
// ============================================================================

/**
 * Optimizes snapshot storage by cleaning up old snapshots
 * 
 * This function implements a cleanup strategy to maintain
 * optimal snapshot density while preserving important checkpoints.
 * 
 * @param snapshots - Array of existing snapshots
 * @param maxSnapshots - Maximum number of snapshots to keep
 * @returns Array of snapshots to keep
 */
export function optimizeSnapshots(
  snapshots: StateSnapshot[],
  maxSnapshots: number = 20
): StateSnapshot[] {
  if (snapshots.length <= maxSnapshots) {
    return snapshots;
  }
  
  // Sort by creation time (newest first)
  const sorted = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  
  // Always keep major checkpoints
  const majorCheckpoints = sorted.filter(s => s.isMajorCheckpoint);
  const regularSnapshots = sorted.filter(s => !s.isMajorCheckpoint);
  
  // Calculate how many regular snapshots we can keep
  const remainingSlots = maxSnapshots - majorCheckpoints.length;
  
  if (remainingSlots <= 0) {
    // Keep only major checkpoints, newest first
    return majorCheckpoints.slice(0, maxSnapshots);
  }
  
  // Keep major checkpoints + newest regular snapshots
  const keptRegular = regularSnapshots.slice(0, remainingSlots);
  
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
  userId: string,
  options: TraversalOptions = {}
): Promise<BranchPath[]> {
  console.log(`[getBranchPathsBatch] 📦 Processing ${pageIds.length} branch paths for user ${userId}`);
  
  // Process in parallel batches to avoid overwhelming the database
  const batchSize = 5;
  const results: BranchPath[] = [];
  
  for (let i = 0; i < pageIds.length; i += batchSize) {
    const batch = pageIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(pageId => getBranchPath(pageId, userId, options))
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
 * @param userId - User ID for cache key isolation
 */
export async function preWarmBranchCache(pageIds: string[], userId: string): Promise<void> {
  console.log(`[preWarmBranchCache] 🔥 Pre-warming cache with ${pageIds.length} pages for user ${userId}`);
  
  await getBranchPathsBatch(pageIds, userId, { useCache: true });
  
  console.log(`[preWarmBranchCache] ✅ Cache pre-warmed for user ${userId}`);
}
