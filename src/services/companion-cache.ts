/**
 * Companion Suggestion & Page-Question Caching Layer
 *
 * Provides a high-performance, two-tiered cache (in-process LRU + optional Upstash Redis)
 * for two companion read paths:
 *
 *   1. Suggestion results scoped to `(bookId, pageId, query, limit)` — the
 *      response of `GET /companion/suggestions`.
 *   2. Page question candidates — the aggregated, spoiler-safe question pool for
 *      `(bookId, pageId)` that suggestion scoring runs against. Cached so a
 *      typing burst reuses one story-state build + one candidate query instead
 *      of repeating both per keystroke.
 *
 * ## Coherent invalidation (generation-stamped keys)
 *
 * Invalidation bumps a per-page generation counter (Redis `INCR`) instead of
 * scanning/deleting keys. Every value key embeds the generation, so a bump
 * atomically orphans all current entries for that page across ALL instances:
 *
 *   companion:sug:v2:<gen>:<bookId>:<pageId>:<query>:<limit>
 *   companion:pageq:v2:<gen>:<bookId>:<pageId>
 *   companion:sug:v2:gen:<bookId>:<pageId>   ← the counter itself
 *
 * Properties (why this shape):
 * - **No Redis `KEYS`/`SCAN` ever runs** — `KEYS` is O(keyspace) and blocks the
 *   single-threaded Redis server; at scale it causes latency spikes for every
 *   tenant. Orphaned keys are simply never read again and expire via TTL.
 * - **No sliding TTL** — the process LRU does not use `updateAgeOnGet`, so an
 *   entry ages out on an absolute TTL and can never be kept alive forever by
 *   traffic. The Redis tier always used an absolute `EX`.
 * - **Cross-instance coherence** — the counter is read through a short local
 *   memo (15 s), bounding cross-instance invalidation latency to ≤ 15 s while
 *   keeping the hot path RTT-free; the invalidating instance drops its own memo
 *   immediately so it observes the bump synchronously.
 * - **Redis outage / Redis-less mode** — the generation falls back to a constant
 *   and invalidation degrades to a bounded prefix delete over the (max 1000
 *   entry) process LRU only; Redis value reads/writes already fail soft. Worst
 *   case during an outage, other instances may serve values stale for at most
 *   the value TTL (5 min).
 *
 * A reader that captured a generation just before a bump may write one
 * orphaned key (harmless) and serve at most one stale read window (≤ memo TTL).
 */

import { LRUCache } from "lru-cache";
import { getRedisClient } from "../utils/redis.js";

/** Absolute TTL for cached suggestion results and page-question pools */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 1000;

/** Local memo window for the per-page generation counter (bounds cross-instance invalidation latency) */
const GENERATION_MEMO_TTL_MS = 15_000;
const GENERATION_MEMO_MAX_SIZE = 5000;

/** Redis TTL for generation counters — must greatly exceed CACHE_TTL_MS so a
 *  counter reset (expiry) can never collide with still-alive value keys. */
const GENERATION_REDIS_TTL_SECONDS = 24 * 60 * 60;

/**
 * One aggregated candidate question for a page (frequency + recency stats used
 * by the suggestion ranking).
 */
export interface CompanionPageQuestion {
  original: string;
  count: number;
  lastAsked: number;
}

/** In-process LRU for suggestion results. Absolute TTL (no sliding refresh). */
const suggestionsLruCache = new LRUCache<string, string[]>({
  max: CACHE_MAX_SIZE,
  ttl: CACHE_TTL_MS,
});

/** In-process LRU for page question candidates. Absolute TTL (no sliding refresh). */
const pageQuestionsLruCache = new LRUCache<string, CompanionPageQuestion[]>({
  max: CACHE_MAX_SIZE,
  ttl: CACHE_TTL_MS,
});

/** Short-lived memo of the per-page generation counter. */
const generationMemo = new LRUCache<string, number>({
  max: GENERATION_MEMO_MAX_SIZE,
  ttl: GENERATION_MEMO_TTL_MS,
});

const PAGE_KEY_VERSION = "v2";

function generationMemoKey(bookId: string, pageId: string): string {
  return `gen:${bookId}:${pageId}`;
}

function generationRedisKey(bookId: string, pageId: string): string {
  return `companion:sug:${PAGE_KEY_VERSION}:gen:${bookId}:${pageId}`;
}

function suggestionsCacheKey(
  bookId: string,
  pageId: string,
  generation: number,
  query?: string | null,
  limit: number = 5
): string {
  const normalizedQuery = query && query.trim() ? query.trim().toLowerCase() : "_empty_";
  return `companion:sug:${PAGE_KEY_VERSION}:${generation}:${bookId}:${pageId}:${normalizedQuery}:${limit}`;
}

function pageQuestionsCacheKey(bookId: string, pageId: string, generation: number): string {
  return `companion:pageq:${PAGE_KEY_VERSION}:${generation}:${bookId}:${pageId}`;
}

/**
 * Whether a process-LRU key belongs to one specific page (degraded-path
 * invalidation). Covers both key shapes:
 *   - suggestions: `…:<bookId>:<pageId>:<query>:<limit>` (has trailing segments)
 *   - page questions: `…:<bookId>:<pageId>` (ends at the pageId, so a bare
 *     `:bookId:pageId:` substring test would never match it)
 */
function isPageKey(key: string, bookId: string, pageId: string): boolean {
  const pageSegment = `:${bookId}:${pageId}`;
  return key.includes(`${pageSegment}:`) || key.endsWith(pageSegment);
}

/**
 * Reads the current generation for a page: memo → Redis → fallback `1`.
 * Never throws; Redis failures degrade to the constant fallback.
 */
async function getGeneration(bookId: string, pageId: string): Promise<number> {
  const memoKey = generationMemoKey(bookId, pageId);
  const memoized = generationMemo.get(memoKey);
  if (memoized !== undefined) return memoized;

  let generation = 1;
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get<number | string>(generationRedisKey(bookId, pageId));
      const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
      if (Number.isFinite(parsed) && parsed > 0) generation = parsed;
    } catch {
      // Redis unavailable — fall back to generation 1 (values are TTL-bounded anyway).
    }
  }

  generationMemo.set(memoKey, generation);
  return generation;
}

/**
 * Invalidates all cached suggestions AND page-question candidates for a
 * specific book page (called when a new Q&A pair is persisted on that page).
 *
 * Primary path: Redis `INCR` on the page's generation counter — atomic,
 * O(1), and globally coherent for every instance. The invalidating instance
 * drops its local memo so it observes the new generation immediately.
 *
 * Degraded path (no Redis / `INCR` failed): delete this instance's own LRU
 * entries for the page. The scan is bounded by the LRU's max size (1000).
 */
export async function invalidateSuggestionsCache(bookId: string, pageId: string): Promise<void> {
  generationMemo.delete(generationMemoKey(bookId, pageId));

  const redis = getRedisClient();
  let bumped = false;
  if (redis) {
    try {
      const next = await redis.incr(generationRedisKey(bookId, pageId));
      if (next === 1) {
        // Fresh counter — attach the TTL (INCR preserves TTL on existing keys).
        await redis.expire(generationRedisKey(bookId, pageId), GENERATION_REDIS_TTL_SECONDS);
      }
      bumped = true;
    } catch {
      // INCR failed — fall through to the bounded local delete below.
    }
  }

  if (bumped) return;

  // Redis-less / Redis-down fallback: orphan the entries held by THIS instance.
  for (const key of suggestionsLruCache.keys()) {
    if (isPageKey(key, bookId, pageId)) suggestionsLruCache.delete(key);
  }
  for (const key of pageQuestionsLruCache.keys()) {
    if (isPageKey(key, bookId, pageId)) pageQuestionsLruCache.delete(key);
  }
}

/**
 * Retrieves cached suggestion questions for `(bookId, pageId, query, limit)`
 * if available (process LRU first, then Redis).
 */
export async function getCachedSuggestions(
  bookId: string,
  pageId: string,
  query?: string | null,
  limit: number = 5
): Promise<string[] | null> {
  const generation = await getGeneration(bookId, pageId);
  const key = suggestionsCacheKey(bookId, pageId, generation, query, limit);

  const memResult = suggestionsLruCache.get(key);
  if (memResult) return memResult;

  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get<string[]>(key);
      if (cached && Array.isArray(cached)) {
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
 * Persists suggestion questions for `(bookId, pageId, query, limit)` in both
 * cache tiers (process LRU + Redis with absolute TTL).
 */
export async function setCachedSuggestions(
  bookId: string,
  pageId: string,
  query: string | null | undefined,
  limit: number,
  questions: string[]
): Promise<void> {
  const generation = await getGeneration(bookId, pageId);
  const key = suggestionsCacheKey(bookId, pageId, generation, query, limit);

  suggestionsLruCache.set(key, questions);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(questions), { ex: Math.ceil(CACHE_TTL_MS / 1000) });
    } catch {
      // Ignore Redis error
    }
  }
}

/**
 * Retrieves the aggregated, spoiler-safe question pool for a page — the shared
 * input to suggestion ranking, cached so keystroke bursts reuse one story-state
 * build + one candidate query. Returns `null` on a miss.
 */
export async function getCachedPageQuestions(
  bookId: string,
  pageId: string
): Promise<CompanionPageQuestion[] | null> {
  const generation = await getGeneration(bookId, pageId);
  const key = pageQuestionsCacheKey(bookId, pageId, generation);

  const memResult = pageQuestionsLruCache.get(key);
  if (memResult) return memResult;

  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get<CompanionPageQuestion[]>(key);
      if (cached && Array.isArray(cached)) {
        pageQuestionsLruCache.set(key, cached);
        return cached;
      }
    } catch {
      // Ignore Redis errors and continue
    }
  }

  return null;
}

/**
 * Persists the aggregated question pool for a page in both cache tiers.
 * Shares the page's generation with the suggestion cache, so
 * {@link invalidateSuggestionsCache} invalidates it too.
 */
export async function setCachedPageQuestions(
  bookId: string,
  pageId: string,
  questions: CompanionPageQuestion[]
): Promise<void> {
  const generation = await getGeneration(bookId, pageId);
  const key = pageQuestionsCacheKey(bookId, pageId, generation);

  pageQuestionsLruCache.set(key, questions);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(questions), { ex: Math.ceil(CACHE_TTL_MS / 1000) });
    } catch {
      // Ignore Redis error
    }
  }
}
