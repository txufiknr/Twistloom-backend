import type { StoryState } from "../types/story.js";
import type { CacheEntry, StateCacheEntry } from "../types/story.js";
import { LRUCache } from "lru-cache";

// ============================================================================
// BRANCH TRAVERSAL CACHE CONFIGURATION
// ============================================================================

/** Cache TTL for branch paths (2 minutes) */
export const BRANCH_CACHE_TTL = 2 * 60 * 1000;

/** Cache TTL for reconstructed states (2 minutes) */
export const STATE_CACHE_TTL = 2 * 60 * 1000;

/** Maximum number of branch paths to cache */
export const MAX_CACHE_SIZE = 500;

/** Maximum number of reconstructed states to cache */
export const MAX_STATE_CACHE_SIZE = 500;

// ============================================================================
// DELETED STORY STATE CACHE CONFIGURATION
// ============================================================================

/** Maximum number of deleted states to cache */
export const DELETED_STATE_CACHE_SIZE = 200;

/** Cache TTL for deleted story states (30 minutes) */
export const DELETED_STATE_CACHE_TTL = 30 * 60 * 1000;

/** Default TTL for deleted story states (30 minutes) */
export const DELETED_STATE_DEFAULT_TTL = 30 * 60 * 1000;

// ============================================================================
// BRANCH TRAVERSAL LRU CACHES
// ============================================================================

/** LRU cache for branch paths with TTL support */
export const branchCache = new LRUCache<string, CacheEntry>({
  max: MAX_CACHE_SIZE,
  ttl: BRANCH_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true
});

/** LRU cache for reconstructed states with TTL support */
export const stateCache = new LRUCache<string, StateCacheEntry>({
  max: MAX_STATE_CACHE_SIZE,
  ttl: STATE_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true
});

// ============================================================================
// DELETED STORY STATE LRU CACHE
// ============================================================================

/**
 * Cache entry for deleted story states
 */
export interface DeletedStateCacheEntry {
  state: StoryState;
  deletedAt: number;
}

// Hit/miss tracking variables
let cacheHits = 0;
let cacheMisses = 0;

/**
 * LRU cache for recently deleted story states
 * Provides safety net for states that might be needed shortly after cleanup
 */
export const deletedStateCache = new LRUCache<string, DeletedStateCacheEntry>({
  max: DELETED_STATE_CACHE_SIZE,
  ttl: DELETED_STATE_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true,
  // Custom dispose method for logging
  dispose: (value: DeletedStateCacheEntry, key: string) => {
    console.log(`[DeletedStateCache] 🗑️ Evicted expired entry: ${key} (age: ${Date.now() - value.deletedAt}ms)`);
  }
});

/**
 * Helper functions for deleted state cache operations
 */

/**
 * Generates cache key for user+page combination
 */
export function getDeletedStateCacheKey(userId: string, pageId: string): string {
  return `${userId}:${pageId}`;
}

/**
 * Gets a cached deleted state if valid
 */
export function getDeletedState(userId: string, pageId: string): StoryState | null {
  const key = getDeletedStateCacheKey(userId, pageId);
  const entry = deletedStateCache.get(key);
  
  if (!entry) {
    cacheMisses++;
    return null;
  }
  
  cacheHits++;
  console.log(`[DeletedStateCache] \ud83c\udfaf Cache hit for ${key} (age: ${Date.now() - entry.deletedAt}ms)`);
  return entry.state;
}

/**
 * Caches a story state before deletion
 */
export function setDeletedState(userId: string, pageId: string, state: StoryState): void {
  const key = getDeletedStateCacheKey(userId, pageId);
  
  const entry: DeletedStateCacheEntry = {
    state,
    deletedAt: Date.now()
  };
  
  deletedStateCache.set(key, entry);
  console.log(`[DeletedStateCache] \ud83d\udcbe Cached deleted state for ${key} (TTL: ${DELETED_STATE_CACHE_TTL}ms)`);
}

/**
 * Gets cache statistics for deleted states
 */
export function getDeletedStateCacheStats(): { 
  size: number; 
  maxSize: number; 
  hitRate: number; 
  hits: number; 
  misses: number; 
  totalRequests: number 
} {
  const size = deletedStateCache.size;
  const maxSize = deletedStateCache.max;
  const totalRequests = cacheHits + cacheMisses;
  const hitRate = totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0;
  
  return {
    size,
    maxSize,
    hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
    hits: cacheHits,
    misses: cacheMisses,
    totalRequests
  };
}

/**
 * Clears all deleted state cache entries
 */
export function clearDeletedStateCache(): void {
  deletedStateCache.clear();
  console.log(`[DeletedStateCache] \ud83e\uddf9 Cache cleared`);
}

/**
 * Resets cache statistics without clearing cache data
 */
export function resetDeletedStateCacheStats(): void {
  cacheHits = 0;
  cacheMisses = 0;
  console.log(`[DeletedStateCache] \ud83d\udcca Statistics reset`);
}
