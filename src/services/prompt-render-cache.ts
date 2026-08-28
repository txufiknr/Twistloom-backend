/**
 * Render cache for expensive prompt-context serialization.
 *
 * Several prompt builders re-serialize the same large, page-stable story context
 * (canonical state, lore, companion page context) on every AI request. During a
 * single page's writing/chat session that context is immutable until the page is
 * published (which rotates the page id), so the rendered string can be safely
 * memoized.
 *
 * Cache keys MUST be derived from a page-scoped identifier (e.g. `${bookId}:${pageId}`)
 * so a published page immediately gets a fresh entry — this prevents serving a
 * stale canonical block. The TTL is a secondary safety net against long-lived
 * instances holding entries for pages that will never be touched again.
 */

import { LRUCache } from "lru-cache";

/** Max cached rendered strings (each is a multi-KB prompt section). */
const MAX_ENTRIES = 500;
/** Entries live 2 minutes — longer than any single page-session burst. */
const TTL_MS = 2 * 60 * 1000;

const renderCache = new LRUCache<string, string>({
  max: MAX_ENTRIES,
  ttl: TTL_MS,
  updateAgeOnGet: true,
});

/**
 * Returns a cached render for `key`, computing and storing it on a miss.
 *
 * @param key - Must be page-scoped (e.g. `comp:${bookId}:${pageId}` or
 *   `canon:${pageId}`). Callers MUST pass `undefined` when no stable key is
 *   available, in which case caching is skipped and `compute()` runs directly.
 * @param compute - Produces the (potentially expensive) string to cache.
 */
export function cachedRender(key: string | undefined, compute: () => string): string {
  if (!key) return compute();
  const hit = renderCache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  renderCache.set(key, value);
  return value;
}
