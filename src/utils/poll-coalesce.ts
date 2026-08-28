/**
 * Poll coalescing for high-frequency status endpoints.
 *
 * Status/heartbeat routes (`GET /api/books/:bookId/status`,
 * `GET /api/books/:identifier/:pageId/candidates/status`, etc.) are polled by
 * the client every 1–2 seconds during generation. On Vercel Fluid Compute the
 * per-invocation cost is small, but the *request multiplier* (millions of
 * invocations/month) is the dominant Active CPU driver.
 *
 * This module collapses bursts of identical polls so that, at most once per
 * {@link POLL_COALESCE_TTL_MS} window per key, the expensive DB reads (and any
 * side effects such as stale-generation re-triggers) actually execute. Served
 * responses are also tagged with `Retry-After` so well-behaved clients back off.
 *
 * The cache is process-local (per serverless instance). That is intentional:
 * it only needs to dampen bursts hitting the *same* warm instance, not provide
 * global correctness — the underlying data is always re-read on a cache miss.
 */

import { LRUCache } from "lru-cache";
import { CPU_OPTIMIZATIONS_ENABLED } from "../config/cpu-optimizations.js";

/** Coalescing window: identical polls within this span share one computed result. */
export const POLL_COALESCE_TTL_MS = 2000;

/** Recommended `Retry-After` value (seconds) advertised on coalesced responses. */
export const POLL_RETRY_AFTER_SECONDS = Math.ceil(POLL_COALESCE_TTL_MS / 1000);

interface PollEntry {
  value: unknown;
  expiresAt: number;
}

const pollCache = new LRUCache<string, PollEntry>({
  max: 4000,
  ttl: POLL_COALESCE_TTL_MS,
});

/**
 * Returns a coalesced result for `key`. On a cache hit within the TTL window the
 * previously computed `value` is returned with `coalesced: true` (no `compute`
 * call). Otherwise `compute()` runs, its result is cached, and `coalesced` is
 * `false`.
 *
 * @param key - Stable per-resource identifier (e.g. `book-status:${userId}:${bookId}`)
 * @param compute - Async producer of the poll payload (DB reads, side effects)
 * @returns The (possibly cached) value and whether it was served from cache
 */
export async function coalescePoll<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<{ value: T; coalesced: boolean }> {
  // When CPU optimizations are disabled (e.g. Vercel Pro), always compute fresh
  // and never cache, restoring maximum data freshness.
  if (!CPU_OPTIMIZATIONS_ENABLED) {
    return { value: await compute(), coalesced: false };
  }
  const now = Date.now();
  const hit = pollCache.get(key);
  if (hit && hit.expiresAt > now) {
    return { value: hit.value as T, coalesced: true };
  }
  const value = await compute();
  pollCache.set(key, { value, expiresAt: now + POLL_COALESCE_TTL_MS });
  return { value, coalesced: false };
}

/** Retrieves a still-fresh coalesced payload, or `undefined` if absent/expired. */
export function getCoalesced<T>(key: string): T | undefined {
  if (!CPU_OPTIMIZATIONS_ENABLED) return undefined;
  const hit = pollCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  return undefined;
}

/** Stores a payload as the coalesced result for `key` (used by manual return sites). */
export function setCoalesced<T>(key: string, value: T): void {
  if (!CPU_OPTIMIZATIONS_ENABLED) return;
  pollCache.set(key, { value, expiresAt: Date.now() + POLL_COALESCE_TTL_MS });
}
