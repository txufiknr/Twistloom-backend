/**
 * Companion Suggestion Caching Layer
 *
 * Provides a high-performance, two-tiered cache (in-memory LRU + optional Upstash Redis)
 * for companion question suggestions (`GET /companion/suggestions`).
 *
 * Scoped to `(bookId, pageId, query, limit)` with automatic invalidation when
 * new companion Q&A pairs are generated on that page.
 */

import { LRUCache } from "lru-cache";
import { getRedisClient } from "../utils/redis.js";

/** 5 minutes TTL for question suggestion results */
const SUGGESTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const SUGGESTIONS_CACHE_MAX_SIZE = 1000;

/** In-memory LRU cache for ultra-fast (sub-millisecond) retrieval */
const suggestionsLruCache = new LRUCache<string, string[]>({
  max: SUGGESTIONS_CACHE_MAX_SIZE,
  ttl: SUGGESTIONS_CACHE_TTL_MS,
  updateAgeOnGet: true,
});

/**
 * Builds a deterministic cache key for suggestion queries
 */
function buildSuggestionsCacheKey(
  bookId: string,
  pageId: string,
  query?: string | null,
  limit: number = 5
): string {
  const normalizedQuery = query && query.trim() ? query.trim().toLowerCase() : "_empty_";
  return `companion:sug:${bookId}:${pageId}:${normalizedQuery}:${limit}`;
}

/**
 * Prefix used for invalidating all suggestion keys for a given book and page
 */
function buildSuggestionsPagePrefix(bookId: string, pageId: string): string {
  return `companion:sug:${bookId}:${pageId}:`;
}

/**
 * Retrieves cached suggestions if available (checks in-memory LRU, then Redis)
 */
export async function getCachedSuggestions(
  bookId: string,
  pageId: string,
  query?: string | null,
  limit: number = 5
): Promise<string[] | null> {
  const key = buildSuggestionsCacheKey(bookId, pageId, query, limit);

  // 1. Check in-memory LRU cache first
  const memResult = suggestionsLruCache.get(key);
  if (memResult) {
    return memResult;
  }

  // 2. Check Redis if available
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get<string[]>(key);
      if (cached && Array.isArray(cached)) {
        // Populate in-memory LRU for subsequent hits
        suggestionsLruCache.set(key, cached);
        return cached;
      }
    } catch {
      // Ignore Redis errors and continue
    }
  }

  return null;
}

/**
 * Persists suggestion questions in cache (in-memory LRU + Redis)
 */
export async function setCachedSuggestions(
  bookId: string,
  pageId: string,
  query: string | null | undefined,
  limit: number,
  questions: string[]
): Promise<void> {
  const key = buildSuggestionsCacheKey(bookId, pageId, query, limit);

  // 1. Set in-memory LRU cache
  suggestionsLruCache.set(key, questions);

  // 2. Set in Redis with TTL if configured
  const redis = getRedisClient();
  if (redis) {
    try {
      const ttlSeconds = Math.ceil(SUGGESTIONS_CACHE_TTL_MS / 1000);
      await redis.set(key, JSON.stringify(questions), { ex: ttlSeconds });
    } catch {
      // Ignore Redis error
    }
  }
}

/**
 * Invalidates all cached suggestions for a specific book page (called when a new question is asked)
 */
export async function invalidateSuggestionsCache(bookId: string, pageId: string): Promise<void> {
  const prefix = buildSuggestionsPagePrefix(bookId, pageId);

  // 1. Invalidate in-memory LRU cache entries
  for (const key of suggestionsLruCache.keys()) {
    if (key.startsWith(prefix)) {
      suggestionsLruCache.delete(key);
    }
  }

  // 2. Invalidate Redis entries if available
  const redis = getRedisClient();
  if (redis) {
    try {
      // Scan and delete keys with matching prefix
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // Ignore Redis error
    }
  }
}
