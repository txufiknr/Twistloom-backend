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
import { eq } from "drizzle-orm";
import type { DBPage } from "../types/schema.js";
import type { PersistedStoryPage, StoryState, StateDelta, StateSnapshot, StateReconstructionResult, PsychologicalFlags, PsychologicalProfile, HiddenState, MemoryIntegrity, Difficulty, Ending, Action } from "../types/story.js";
import type { CharacterMemory } from "../types/character.js";
import type { PlaceMemory } from "../types/places.js";
import { LRUCache } from "lru-cache";

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum traversal depth to prevent infinite loops */
export const MAX_TRAVERSAL_DEPTH = 100;

/** Cache TTL for branch paths (5 minutes) */
export const BRANCH_CACHE_TTL = 5 * 60 * 1000;

/** Maximum number of paths to cache */
export const MAX_CACHE_SIZE = 1000;

/** Snapshot creation intervals */
export const SNAPSHOT_INTERVAL_PAGES = 5; // Create snapshot every 5 pages
export const MAJOR_EVENT_SNAPSHOT_INTERVAL = 10; // For major events

/** Cache TTL for reconstructed states (2 minutes) */
export const STATE_CACHE_TTL = 2 * 60 * 1000;

/** Maximum number of reconstructed states to cache */
export const MAX_STATE_CACHE_SIZE = 500;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Branch path with full timeline information
 */
export type BranchPath = {
  /** Ordered array of pages from root to current */
  pages: PersistedStoryPage[];
  /** Root page ID (first page in the branch) */
  rootId: string;
  /** Current page ID (last page in the branch) */
  currentId: string;
  /** Total depth/length of the branch */
  depth: number;
  /** Timestamp when path was cached */
  cachedAt?: number;
};

/**
 * Cache entry for branch paths
 */
type CacheEntry = {
  path: BranchPath;
  expiresAt: number;
};

/**
 * Cache entry for reconstructed states
 */
type StateCacheEntry = {
  state: StoryState;
  result: StateReconstructionResult;
  expiresAt: number;
};

/**
 * Traversal options for performance tuning
 */
export type TraversalOptions = {
  /** Maximum depth to traverse (default: MAX_TRAVERSAL_DEPTH) */
  maxDepth?: number;
  /** Whether to use cache (default: true) */
  useCache?: boolean;
  /** Whether to validate path integrity (default: true) */
  validatePath?: boolean;
};

/**
 * State reconstruction dependencies
 */
export type StateReconstructionDeps = {
  /** Get page by ID */
  getPageById: (pageId: string) => Promise<DBPage | null>;
  /** Get state snapshot by page ID */
  getSnapshot: (pageId: string) => Promise<StateSnapshot | null>;
  /** Get state delta by page ID */
  getDelta: (pageId: string) => Promise<StateDelta | null>;
  /** Get story state by page ID (fallback) */
  getStoryState?: (pageId: string) => Promise<StoryState | null>;
};

// ============================================================================
// LRU CACHE IMPLEMENTATION
// ============================================================================

/** LRU cache for branch paths with TTL support */
const branchCache = new LRUCache<string, CacheEntry>({
  max: MAX_CACHE_SIZE,
  ttl: BRANCH_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true
});

/** LRU cache for reconstructed states with TTL support */
const stateCache = new LRUCache<string, StateCacheEntry>({
  max: MAX_STATE_CACHE_SIZE,
  ttl: STATE_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true
});

/**
 * Gets cached branch path if valid
 * 
 * @param pageId - Page ID to check in cache
 * @returns Cached branch path or null if not found
 */
function getCachedPath(pageId: string): BranchPath | null {
  const entry = branchCache.get(pageId);
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
  branchCache.set(pageId, {
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
  const entry = stateCache.get(pageId);
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
  stateCache.set(pageId, {
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
 * Retrieves page by ID with error handling
 * 
 * @param pageId - Page ID to retrieve
 * @returns Page data or null if not found
 */
async function getPageById(pageId: string): Promise<DBPage | null> {
  try {
    const result = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`[getPageById] ❌ Failed to retrieve page ${pageId}:`, error);
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
  let cursor: DBPage | null = await getPageById(currentPageId);
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
    cursor = await getPageById(cursor.parentId);
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
    page: page.page,
    text: page.text,
    mood: page.mood,
    place: page.place,
    characters: page.characters || [],
    keyEvents: page.keyEvents || [],
    importantObjects: page.importantObjects || [],
    actions: page.actions || [],
    addTraumaTag: page.addTraumaTag || undefined,
    characterUpdates: page.characterUpdates || undefined,
    placeUpdates: page.placeUpdates || undefined,
  }));

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
  const page = await getPageById(pageId);
  if (!page || !page.parentId) {
    return [];
  }

  try {
    const siblings = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.parentId, page.parentId));

    return siblings.map(sibling => ({
      id: sibling.id,
      bookId: sibling.bookId,
      parentId: sibling.parentId,
      page: sibling.page,
      text: sibling.text,
      mood: sibling.mood,
      place: sibling.place,
      characters: sibling.characters || [],
      keyEvents: sibling.keyEvents || [],
      importantObjects: sibling.importantObjects || [],
      actions: sibling.actions || [],
      addTraumaTag: sibling.addTraumaTag || undefined,
      characterUpdates: sibling.characterUpdates || undefined,
      placeUpdates: sibling.placeUpdates || undefined,
    }));
  } catch (error) {
    console.error(`[getSiblingPages] ❌ Failed to get siblings for page ${pageId}:`, error);
    return [];
  }
}

/**
 * Gets branch statistics for analytics
 * 
 * @param pageId - Page ID to analyze
 * @returns Promise resolving to branch statistics
 */
export async function getBranchStats(pageId: string): Promise<{
  depth: number;
  totalBranches: number;
  avgBranchingFactor: number;
}> {
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
 * Reconstructs story state from branch path using hybrid delta + checkpoint system
 * 
 * This advanced reconstruction system uses a combination of snapshots (checkpoints)
 * and deltas to efficiently rebuild the complete story state at any point in the branch.
 * 
 * Strategy:
 * 1. Try direct state retrieval (fastest)
 * 2. Find nearest snapshot backwards from current page
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
 * const result = await reconstructStoryStateAdvanced('page123', {
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
  deps: StateReconstructionDeps,
  options: TraversalOptions = {}
): Promise<StateReconstructionResult> {
  const startTime = Date.now();
  
  try {
    // Check cache first
    if (options.useCache !== false) {
      const cached = getCachedState(currentPageId);
      if (cached) {
        console.log(`[reconstructStoryState] 🎯 Cache hit for page ${currentPageId}`);
        return cached.result;
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
          reconstructionTimeMs: Date.now() - startTime
        };
        
        if (options.useCache !== false) {
          setCachedState(currentPageId, directState, result);
        }
        
        console.log(`[reconstructStoryState] ✅ Direct state retrieval for ${currentPageId}`);
        return result;
      }
    }
    
    // Strategy 2: Hybrid delta + checkpoint reconstruction
    const branchPath = await getBranchPath(currentPageId, options);
    
    // Find nearest snapshot (from bottom/end of path)
    let snapshotIndex = -1;
    let baseState: StoryState | null = null;
    let baseSnapshotPageId: string | undefined;
    
    for (let i = branchPath.pages.length - 1; i >= 0; i--) {
      const page = branchPath.pages[i];
      const snapshot = await deps.getSnapshot(page.id);
      
      if (snapshot) {
        snapshotIndex = i;
        baseState = structuredClone(snapshot.state);
        baseSnapshotPageId = page.id;
        console.log(`[reconstructStoryState] 📸 Found snapshot at page ${page.id} (index ${i})`);
        break;
      }
    }
    
    // Fallback: Create empty base state if no snapshot found
    if (!baseState) {
      baseState = createEmptyStoryState(currentPageId, branchPath.pages[branchPath.pages.length - 1].page);
      snapshotIndex = 0;
      console.log(`[reconstructStoryState] ⚠️ No snapshot found, using empty base state`);
    }
    
    // Apply deltas forward from snapshot position
    let deltasApplied = 0;
    for (let i = snapshotIndex + 1; i < branchPath.pages.length; i++) {
      const page = branchPath.pages[i];
      const delta = await deps.getDelta(page.id);
      
      if (delta) {
        applyStateDelta(baseState, delta);
        deltasApplied++;
        console.log(`[reconstructStoryState] 🔄 Applied delta for page ${page.id}`);
      }
    }
    
    // Ensure final state matches current page
    baseState.pageId = currentPageId;
    baseState.page = branchPath.pages[branchPath.pages.length - 1].page;
    
    const result: StateReconstructionResult = {
      state: baseState,
      snapshotsUsed: baseSnapshotPageId ? 1 : 0,
      deltasApplied,
      method: baseSnapshotPageId ? 'snapshot_plus_deltas' : 'fallback',
      reconstructionTimeMs: Date.now() - startTime,
      baseSnapshotPageId
    };
    
    // Cache the result
    if (options.useCache !== false) {
      setCachedState(currentPageId, baseState, result);
    }
    
    console.log(`[reconstructStoryState] ✅ Reconstruction complete: ${result.method}, ${deltasApplied} deltas, ${result.reconstructionTimeMs}ms`);
    
    return result;
    
  } catch (error) {
    console.error(`[reconstructStoryState] ❌ Failed to reconstruct state for ${currentPageId}:`, error);
    
    // Ultimate fallback: minimal state
    const fallbackState = createEmptyStoryState(currentPageId, 1);
    return {
      state: fallbackState,
      snapshotsUsed: 0,
      deltasApplied: 0,
      method: 'fallback',
      reconstructionTimeMs: Date.now() - startTime
    };
  }
}

/**
 * Creates an empty story state with default values
 * 
 * @param pageId - Page ID for the state
 * @param pageNumber - Page number
 * @returns Empty story state
 */
function createEmptyStoryState(pageId: string, pageNumber: number): StoryState {
  return {
    pageId,
    page: pageNumber,
    maxPage: 150,
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
    cachedEndingArchetype: undefined,
    characters: {},
    places: {},
    pageHistory: [],
    actionsHistory: [],
    contextHistory: ''
  };
}

/**
 * Applies a state delta to a base story state
 * 
 * This function incrementally updates the story state by applying
 * all changes defined in the delta. It handles all state fields
 * including characters, places, trauma, psychological profile, etc.
 * 
 * @param state - Base story state to modify
 * @param delta - State delta to apply
 * 
 * @example
 * ```typescript
 * applyStateDelta(baseState, {
 *   pageId: 'page123',
 *   page: 5,
 *   addedTraumaTags: ['heard_voice', 'saw_shadow'],
 *   flagsDelta: { fear: 'high' }
 * });
 * ```
 */
export function applyStateDelta(state: StoryState, delta: StateDelta): void {
  // Characters management
  if (delta.addedCharacters) {
    state.characters = { ...state.characters, ...delta.addedCharacters };
  }
  
  if (delta.updatedCharacters) {
    for (const [charId, updates] of Object.entries(delta.updatedCharacters)) {
      if (state.characters[charId]) {
        state.characters[charId] = { ...state.characters[charId], ...updates };
      }
    }
  }
  
  if (delta.removedCharacters) {
    for (const charId of delta.removedCharacters) {
      delete state.characters[charId];
    }
  }
  
  // Places management
  if (delta.addedPlaces) {
    state.places = { ...state.places, ...delta.addedPlaces };
  }
  
  if (delta.updatedPlaces) {
    for (const [placeId, updates] of Object.entries(delta.updatedPlaces)) {
      if (state.places[placeId]) {
        state.places[placeId] = { ...state.places[placeId], ...updates };
      }
    }
  }
  
  if (delta.removedPlaces) {
    for (const placeId of delta.removedPlaces) {
      delete state.places[placeId];
    }
  }
  
  // Trauma tags management
  if (delta.addedTraumaTags) {
    state.traumaTags = [...state.traumaTags, ...delta.addedTraumaTags];
  }
  
  if (delta.removedTraumaTags) {
    state.traumaTags = state.traumaTags.filter(tag => !delta.removedTraumaTags!.includes(tag));
  }
  
  // Psychological flags
  if (delta.flagsDelta) {
    state.flags = { ...state.flags, ...delta.flagsDelta };
  }
  
  // Psychological profile
  if (delta.profileDelta) {
    state.psychologicalProfile = { ...state.psychologicalProfile, ...delta.profileDelta };
  }
  
  // Hidden state
  if (delta.hiddenStateDelta) {
    state.hiddenState = { ...state.hiddenState, ...delta.hiddenStateDelta };
  }
  
  // Memory integrity
  if (delta.memoryIntegrity) {
    state.memoryIntegrity = delta.memoryIntegrity;
  }
  
  // Difficulty
  if (delta.difficulty) {
    state.difficulty = delta.difficulty;
  }
  
  // Ending archetype
  if (delta.endingArchetype) {
    state.cachedEndingArchetype = delta.endingArchetype;
  }
  
  // Context history
  if (delta.contextHistoryAddition) {
    state.contextHistory = state.contextHistory + '\n' + delta.contextHistoryAddition;
  }
  
  // Actions history
  if (delta.addedActions) {
    state.actionsHistory = [...state.actionsHistory, ...delta.addedActions];
  }
  
  // Update page information
  state.pageId = delta.pageId;
  state.page = delta.page;
}

// ============================================================================
// SNAPSHOT CREATION STRATEGY
// ============================================================================

/**
 * Determines if a snapshot should be created for the current page
 * 
 * This function implements the snapshot creation strategy based on:
 * - Periodic intervals (every N pages)
 * - Major events (death, betrayal, reveals)
 * - Branch starts
 * - Performance considerations
 * 
 * @param currentPage - Current page data
 * @param previousPage - Previous page data (if available)
 * @param lastSnapshotPage - Page number of last snapshot
 * @param isMajorEvent - Whether this is a major story event
 * @returns Whether to create a snapshot and the reason
 */
export function shouldCreateSnapshot(
  currentPage: PersistedStoryPage,
  previousPage: PersistedStoryPage | null,
  lastSnapshotPage: number,
  isMajorEvent: boolean = false
): { shouldCreate: boolean; reason: 'periodic' | 'major_event' | 'branch_start' | 'none' } {
  // Check for major event
  if (isMajorEvent) {
    return { shouldCreate: true, reason: 'major_event' };
  }
  
  // Check for branch start (no parent page)
  if (!currentPage.parentId) {
    return { shouldCreate: true, reason: 'branch_start' };
  }
  
  // Check periodic interval
  const pagesSinceLastSnapshot = currentPage.page - lastSnapshotPage;
  if (pagesSinceLastSnapshot >= SNAPSHOT_INTERVAL_PAGES) {
    return { shouldCreate: true, reason: 'periodic' };
  }
  
  return { shouldCreate: false, reason: 'none' };
}

/**
 * Creates a state snapshot at the specified page
 * 
 * @param pageId - Page ID to create snapshot for
 * @param state - Complete story state to snapshot
 * @param reason - Reason for snapshot creation
 * @returns Created state snapshot
 */
export function createStateSnapshot(
  pageId: string,
  state: StoryState,
  reason: 'periodic' | 'major_event' | 'branch_start' | 'user_request'
): StateSnapshot {
  return {
    pageId,
    page: state.page,
    state: structuredClone(state), // Deep clone to prevent mutations
    createdAt: new Date(),
    version: 1,
    isMajorCheckpoint: reason === 'major_event' || reason === 'branch_start',
    reason
  };
}

/**
 * Creates a state delta representing changes between two states
 * 
 * This function analyzes two story states and creates a delta
 * containing only the differences, enabling efficient storage
 * and reconstruction.
 * 
 * @param fromState - Previous story state
 * @param toState - New story state
 * @param pageId - Page ID where delta was created
 * @returns State delta representing the changes
 */
export function createStateDelta(
  fromState: StoryState,
  toState: StoryState,
  pageId: string
): StateDelta {
  const delta: StateDelta = {
    pageId,
    page: toState.page
  };
  
  // Compare characters
  const fromCharIds = new Set(Object.keys(fromState.characters));
  const toCharIds = new Set(Object.keys(toState.characters));
  
  // Added characters
  const addedCharacters: Record<string, CharacterMemory> = {};
  for (const charId of toCharIds) {
    if (!fromCharIds.has(charId)) {
      addedCharacters[charId] = toState.characters[charId];
    }
  }
  if (Object.keys(addedCharacters).length > 0) {
    delta.addedCharacters = addedCharacters;
  }
  
  // Removed characters
  const removedCharacters: string[] = [];
  for (const charId of fromCharIds) {
    if (!toCharIds.has(charId)) {
      removedCharacters.push(charId);
    }
  }
  if (removedCharacters.length > 0) {
    delta.removedCharacters = removedCharacters;
  }
  
  // Updated characters
  const updatedCharacters: Record<string, Partial<CharacterMemory>> = {};
  for (const charId of fromCharIds) {
    if (toCharIds.has(charId)) {
      const fromChar = fromState.characters[charId];
      const toChar = toState.characters[charId];
      
      // Find differences
      const updates: Partial<CharacterMemory> = {};
      for (const key of Object.keys(toChar) as (keyof CharacterMemory)[]) {
        if (fromChar[key] !== toChar[key]) {
          (updates as any)[key] = toChar[key];
        }
      }
      
      if (Object.keys(updates).length > 0) {
        updatedCharacters[charId] = updates;
      }
    }
  }
  if (Object.keys(updatedCharacters).length > 0) {
    delta.updatedCharacters = updatedCharacters;
  }
  
  // Compare places (similar logic to characters)
  const fromPlaceIds = new Set(Object.keys(fromState.places));
  const toPlaceIds = new Set(Object.keys(toState.places));
  
  const addedPlaces: Record<string, PlaceMemory> = {};
  for (const placeId of toPlaceIds) {
    if (!fromPlaceIds.has(placeId)) {
      addedPlaces[placeId] = toState.places[placeId];
    }
  }
  if (Object.keys(addedPlaces).length > 0) {
    delta.addedPlaces = addedPlaces;
  }
  
  const removedPlaces: string[] = [];
  for (const placeId of fromPlaceIds) {
    if (!toPlaceIds.has(placeId)) {
      removedPlaces.push(placeId);
    }
  }
  if (removedPlaces.length > 0) {
    delta.removedPlaces = removedPlaces;
  }
  
  const updatedPlaces: Record<string, Partial<PlaceMemory>> = {};
  for (const placeId of fromPlaceIds) {
    if (toPlaceIds.has(placeId)) {
      const fromPlace = fromState.places[placeId];
      const toPlace = toState.places[placeId];
      
      const updates: Partial<PlaceMemory> = {};
      for (const key of Object.keys(toPlace) as (keyof PlaceMemory)[]) {
        if (fromPlace[key] !== toPlace[key]) {
          (updates as any)[key] = toPlace[key];
        }
      }
      
      if (Object.keys(updates).length > 0) {
        updatedPlaces[placeId] = updates;
      }
    }
  }
  if (Object.keys(updatedPlaces).length > 0) {
    delta.updatedPlaces = updatedPlaces;
  }
  
  // Compare trauma tags
  const addedTraumaTags = toState.traumaTags.filter(tag => !fromState.traumaTags.includes(tag));
  if (addedTraumaTags.length > 0) {
    delta.addedTraumaTags = addedTraumaTags;
  }
  
  const removedTraumaTags = fromState.traumaTags.filter(tag => !toState.traumaTags.includes(tag));
  if (removedTraumaTags.length > 0) {
    delta.removedTraumaTags = removedTraumaTags;
  }
  
  // Compare psychological flags
  const flagsDelta: Partial<PsychologicalFlags> = {};
  for (const key of Object.keys(toState.flags) as (keyof PsychologicalFlags)[]) {
    if (fromState.flags[key] !== toState.flags[key]) {
      (flagsDelta as any)[key] = toState.flags[key];
    }
  }
  if (Object.keys(flagsDelta).length > 0) {
    delta.flagsDelta = flagsDelta;
  }
  
  // Compare psychological profile
  const profileDelta: Partial<PsychologicalProfile> = {};
  for (const key of Object.keys(toState.psychologicalProfile) as (keyof PsychologicalProfile)[]) {
    if (fromState.psychologicalProfile[key] !== toState.psychologicalProfile[key]) {
      (profileDelta as any)[key] = toState.psychologicalProfile[key];
    }
  }
  if (Object.keys(profileDelta).length > 0) {
    delta.profileDelta = profileDelta;
  }
  
  // Compare hidden state
  const hiddenStateDelta: Partial<HiddenState> = {};
  for (const key of Object.keys(toState.hiddenState) as (keyof HiddenState)[]) {
    if (fromState.hiddenState[key] !== toState.hiddenState[key]) {
      (hiddenStateDelta as any)[key] = toState.hiddenState[key];
    }
  }
  if (Object.keys(hiddenStateDelta).length > 0) {
    delta.hiddenStateDelta = hiddenStateDelta;
  }
  
  // Compare simple fields
  if (fromState.memoryIntegrity !== toState.memoryIntegrity) {
    delta.memoryIntegrity = toState.memoryIntegrity;
  }
  
  if (fromState.difficulty !== toState.difficulty) {
    delta.difficulty = toState.difficulty;
  }
  
  if (fromState.cachedEndingArchetype !== toState.cachedEndingArchetype) {
    delta.endingArchetype = toState.cachedEndingArchetype;
  }
  
  // Compare context history (check for additions)
  if (toState.contextHistory.length > fromState.contextHistory.length) {
    const addition = toState.contextHistory.substring(fromState.contextHistory.length);
    if (addition.trim()) {
      delta.contextHistoryAddition = addition.trim();
    }
  }
  
  // Compare actions history
  const addedActions = toState.actionsHistory.slice(fromState.actionsHistory.length);
  if (addedActions.length > 0) {
    delta.addedActions = addedActions;
  }
  
  return delta;
}

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
