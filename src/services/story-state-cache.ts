import type { DBStoryState } from "../types/schema.js";
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
// STORY STATE CACHE CONFIGURATION
// ============================================================================

/** Cache entry for story states */
export interface StoryStateCacheEntry {
  state: DBStoryState;
  cachedAt: number;
}

// Hit/miss tracking variables for story states
let storyStateCacheHits = 0;
let storyStateCacheMisses = 0;

/** LRU cache for story states with TTL support */
export const storyStateCache = new LRUCache<string, StoryStateCacheEntry>({
  max: MAX_STATE_CACHE_SIZE,
  ttl: STATE_CACHE_TTL,
  allowStale: false,
  updateAgeOnGet: true,
  // Custom dispose method for logging
  dispose: (value: StoryStateCacheEntry, key: string) => {
    console.log(`[StoryStateCache] 🗑️ Evicted expired entry: ${key} (age: ${Date.now() - value.cachedAt}ms)`);
  }
});

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
    console.log(`[story-state] 🗑️ Evicted expired entry: ${key} (age: ${Date.now() - value.deletedAt}ms)`);
  }
});

/**
 * Helper functions for story state cache
 */

/**
 * Generates cache key for page ID
 */
export function getStoryStateCacheKey(pageId: string): string {
  return pageId;
}

/**
 * Gets a cached story state if valid
 */
export function getStoryStateCache(pageId: string): DBStoryState | null {
  const key = getStoryStateCacheKey(pageId);
  const entry = storyStateCache.get(key);
  
  if (!entry) {
    storyStateCacheMisses++;
    return null;
  }
  
  storyStateCacheHits++;
  console.log(`[StoryStateCache] 🍪 Cache hit for ${key} (age: ${Date.now() - entry.cachedAt}ms)`);
  return entry.state;
}

/**
 * Caches a story state
 */
export function setStoryStateCache(pageId: string, state: DBStoryState): void {
  const key = getStoryStateCacheKey(pageId);
  
  const entry: StoryStateCacheEntry = {
    state,
    cachedAt: Date.now()
  };
  
  storyStateCache.set(key, entry);
  console.log(`[StoryStateCache] 🍪 Cached state for ${key} (TTL: ${STATE_CACHE_TTL}ms)`);
}

/**
 * Gets cache statistics for story states
 */
export function getStoryStateCacheStats(): { 
  size: number; 
  maxSize: number; 
  hitRate: number; 
  hits: number; 
  misses: number; 
  totalRequests: number 
} {
  const size = storyStateCache.size;
  const maxSize = storyStateCache.max;
  const totalRequests = storyStateCacheHits + storyStateCacheMisses;
  const hitRate = totalRequests > 0 ? (storyStateCacheHits / totalRequests) * 100 : 0;
  
  return {
    size,
    maxSize,
    hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
    hits: storyStateCacheHits,
    misses: storyStateCacheMisses,
    totalRequests
  };
}

/**
 * Clears all story state cache entries
 */
export function clearStoryStateCache(): void {
  storyStateCache.clear();
  console.log(`[StoryStateCache] ✨ Cache cleared`);
}

/**
 * Resets cache statistics without clearing cache data
 */
export function resetStoryStateCacheStats(): void {
  storyStateCacheHits = 0;
  storyStateCacheMisses = 0;
  console.log(`[StoryStateCache] 📊 Statistics reset`);
}

/**
 * Helper functions for deleted state cache operations
 */

/**
 * Generates cache key for page (branch-based architecture)
 */
export function getDeletedStateCacheKey(pageId: string): string {
  return pageId;
}

/**
 * Gets a cached deleted state if valid
 */
export function getDeletedState(pageId: string): StoryState | null {
  const key = getDeletedStateCacheKey(pageId);
  const entry = deletedStateCache.get(key);
  
  if (!entry) {
    cacheMisses++;
    return null;
  }
  
  cacheHits++;
  console.log(`[story-state] 🍪 Cache hit for ${key} (age: ${Date.now() - entry.deletedAt}ms)`);
  return entry.state;
}

/**
 * Caches a story state before deletion
 */
export function setDeletedState(pageId: string, state: StoryState): void {
  const key = getDeletedStateCacheKey(pageId);
  
  const entry: DeletedStateCacheEntry = {
    state,
    deletedAt: Date.now()
  };
  
  deletedStateCache.set(key, entry);
  console.log(`[story-state] 🍪 Cached deleted state for ${key} (TTL: ${DELETED_STATE_CACHE_TTL}ms)`);
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
  console.log(`[story-state] ✨ Cache cleared`);
}

/**
 * Resets cache statistics without clearing cache data
 */
export function resetDeletedStateCacheStats(): void {
  cacheHits = 0;
  cacheMisses = 0;
  console.log(`[story-state] 📊 Cache statistics reset`);
}
