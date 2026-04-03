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
  ttl: number; // Time to live in milliseconds
}

/**
 * LRU cache for recently deleted story states
 * Provides safety net for states that might be needed shortly after cleanup
 */
export class DeletedStateLRUCache {
  private cache = new Map<string, DeletedStateCacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtl: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 100, defaultTtl: number = 30 * 60 * 1000) { // 30 minutes default TTL
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
  }

  /**
   * Generates cache key for user+page combination
   */
  private getKey(userId: string, pageId: string): string {
    return `${userId}:${pageId}`;
  }

  /**
   * Gets a cached deleted state if valid
   */
  get(userId: string, pageId: string): StoryState | null {
    const key = this.getKey(userId, pageId);
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.misses++;
      return null;
    }
    
    // Check if entry has expired
    if (Date.now() - entry.deletedAt > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      console.log(`[DeletedStateLRUCache] 🕐 Cache expired for ${key}`);
      return null;
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    this.hits++;
    console.log(`[DeletedStateLRUCache] 🎯 Cache hit for ${key} (age: ${Date.now() - entry.deletedAt}ms)`);
    return entry.state;
  }

  /**
   * Caches a story state before deletion
   */
  set(userId: string, pageId: string, state: StoryState, ttl?: number): void {
    const key = this.getKey(userId, pageId);
    
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        console.log(`[DeletedStateLRUCache] 🗑️ Evicted oldest entry: ${oldestKey}`);
      }
    }
    
    const entry: DeletedStateCacheEntry = {
      state,
      deletedAt: Date.now(),
      ttl: ttl || this.defaultTtl
    };
    
    this.cache.set(key, entry);
    console.log(`[DeletedStateLRUCache] 💾 Cached deleted state for ${key} (TTL: ${entry.ttl}ms)`);
  }

  /**
   * Clears expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.deletedAt > entry.ttl) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
    
    if (keysToDelete.length > 0) {
      console.log(`[DeletedStateLRUCache] 🧹 Cleaned up ${keysToDelete.length} expired entries`);
    }
  }

  /**
   * Gets cache statistics
   */
  getStats(): { size: number; maxSize: number; hitRate: number; hits: number; misses: number; totalRequests: number } {
    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? (this.hits / totalRequests) * 100 : 0;
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
      hits: this.hits,
      misses: this.misses,
      totalRequests
    };
  }

  /**
   * Clears all entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    console.log(`[DeletedStateLRUCache] 🧹 Cache cleared (stats reset)`);
  }

  /**
   * Resets hit/miss statistics without clearing cache
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    console.log(`[DeletedStateLRUCache] 📊 Statistics reset`);
  }
}

// Global cache instance for deleted story states
export const deletedStateCache = new DeletedStateLRUCache(DELETED_STATE_CACHE_SIZE, DELETED_STATE_DEFAULT_TTL);
