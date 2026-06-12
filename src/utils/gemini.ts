/**
 * Gemini Utilities
 *
 * Handles two concerns:
 *  1. Explicit Context Caching — `getOrCreateGeminiCache` / `invalidateGeminiCache`
 *  2. Schema Conversion — `convertToGeminiSchema`
 *
 * @overview Cache Storage Architecture
 *
 * Two-layer cache for Gemini context cache metadata:
 *
 *   L1 — In-memory Map (fast, same serverless instance, ephemeral)
 *        Avoids a Redis roundtrip for every page generation when the function
 *        instance is kept warm. Resets on cold start.
 *
 *   L2 — Redis via services/cache (persistent, cross-instance, cross-restart)
 *        Survives cold starts, Vercel instance recycling, and multi-region deploys.
 *        Populated from Gemini API on cold start, then written-through on every
 *        new cache creation.
 *
 * Read path:  L1 → L2 → create new Gemini cache
 * Write path: Gemini API → L2 → L1
 *
 * @overview Book Index
 *
 * `cachedContentId` is keyed on (bookId, characters, places). When characters
 * or places change — which happens on most page generations — a new
 * `cachedContentId` is computed. Without cleanup, the old Gemini cache on
 * Google's servers becomes an orphan.
 *
 * To prevent orphan accumulation, a book-scoped reverse index tracks the
 * current `cachedContentId` per book. Before creating a new cache, the
 * previous one is explicitly deleted via the Gemini API.
 *
 * Book index storage mirrors the entry storage: L1 Map + L2 Redis.
 */

import { getGeminiClient } from './ai-clients.js';
import { getFromCache, setCache, deleteCache } from '../services/cache.js';
import { hashContentDJB2 } from './cache.js';
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { classifyGenAIError } from './error.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeminiCacheEntry {
  /** Gemini cache resource name, e.g. "cachedContents/abc123" */
  cacheId: string;
  /** DJB2 hash of (systemInstruction + semiStaticContext) — used to detect content changes */
  prefixHash: string;
  /** Unix ms — when this entry was created */
  createdAt: number;
  /** Unix ms — when the Gemini-side cache expires */
  expiresAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** TTL sent to Gemini's API when creating a context cache (seconds). */
const GEMINI_CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Redis TTL for a cache entry.
 *
 * Slightly longer than GEMINI_CACHE_TTL_SECONDS so the Redis record doesn't
 * expire before the Gemini-side cache does. The validity check uses `expiresAt`
 * (from the stored entry), so a stale Redis record is harmless — we simply
 * skip it and create a fresh cache.
 */
const REDIS_ENTRY_TTL_SECONDS = GEMINI_CACHE_TTL_SECONDS + 300; // 1 hr + 5 min

/**
 * Redis TTL for the book → cachedContentId reverse index.
 *
 * Long enough to span several Gemini cache refreshes (e.g. 8 hours) so we
 * can still find and delete the previous cache even across multiple
 * character/place updates in a single session.
 */
const REDIS_BOOK_INDEX_TTL_SECONDS = GEMINI_CACHE_TTL_SECONDS * 8; // 8 hours

/**
 * Minimum combined length of (systemInstruction + semiStaticContext) in chars
 * before we attempt to create a Gemini explicit cache.
 *
 * Gemini requires roughly 1_024 input tokens. At ~4 chars/token that's ~4_096
 * chars. 8_000 gives a comfortable margin and ensures cache creation won't be
 * rejected.
 */
const GEMINI_CACHE_MIN_CHARS = 8_000;

/** Minimum ms before expiry — don't reuse a cache that's about to expire. */
const EXPIRY_BUFFER_MS = 60_000; // 1 minute

// ─── Redis Key Helpers ───────────────────────────────────────────────────────

/**
 * Redis key for a Gemini cache entry.
 *
 * Namespaced under `gemini:` to avoid collisions with other cache keys.
 * The `cachedContentId` is already a stable hash of (bookId, characters,
 * places) produced by `createCacheKey` in utils/cache.ts.
 */
const redisEntryKey = (cachedContentId: string) =>
  `gemini:content-cache:${cachedContentId}`;

/**
 * Redis key for the book → current cachedContentId reverse index.
 * One record per book, updated on every new cache creation.
 */
const redisBookIndexKey = (bookId: string) =>
  `gemini:book-index:${bookId}`;

// ─── L1 In-Memory Cache ───────────────────────────────────────────────────────
//
// A plain Map that lives inside the serverless function instance.
// Eliminates the Redis network roundtrip when the instance is warm.
// Automatically evicted when the instance is recycled (Vercel, Lambda, etc.).

/** L1 cache: cachedContentId → GeminiCacheEntry */
const l1Cache = new Map<string, GeminiCacheEntry>();

/** L1 book index: bookId → current cachedContentId */
const l1BookIndex = new Map<string, string>();

// ─── Internal Read / Write Helpers ───────────────────────────────────────────

/**
 * Reads a cache entry from L1 first, then L2 (Redis).
 * On a Redis hit, the entry is written back to L1 for subsequent reads
 * within the same function instance.
 */
async function readEntry(cachedContentId: string): Promise<GeminiCacheEntry | null> {
  // L1 hit — fastest path, no network
  const l1 = l1Cache.get(cachedContentId);
  if (l1) return l1;

  // L2 hit — Redis, one network hop
  const { data, hit } = await getFromCache<GeminiCacheEntry>(redisEntryKey(cachedContentId));
  if (hit && data) {
    l1Cache.set(cachedContentId, data); // warm L1 for next call
    return data;
  }

  return null;
}

/**
 * Writes a cache entry to L2 (Redis) first, then L1.
 * Writing L2 before L1 means other instances see the entry even if this
 * instance crashes before writing L1.
 */
async function writeEntry(cachedContentId: string, entry: GeminiCacheEntry): Promise<void> {
  await setCache(redisEntryKey(cachedContentId), entry, REDIS_ENTRY_TTL_SECONDS);
  l1Cache.set(cachedContentId, entry);
}

/**
 * Removes a cache entry from both L1 and L2.
 * Errors from Redis are swallowed — L1 is always cleaned up synchronously.
 */
async function removeEntry(cachedContentId: string): Promise<void> {
  l1Cache.delete(cachedContentId);
  await deleteCache(redisEntryKey(cachedContentId));
}

/**
 * Reads the current cachedContentId for a book from L1 then L2.
 * Returns null if no index entry exists (i.e. first cache for this book).
 */
async function readBookIndex(bookId: string): Promise<string | null> {
  // L1 hit
  const l1 = l1BookIndex.get(bookId);
  if (l1) return l1;

  // L2 hit
  const { data, hit } = await getFromCache<string>(redisBookIndexKey(bookId));
  if (hit && data) {
    l1BookIndex.set(bookId, data); // warm L1
    return data;
  }

  return null;
}

/**
 * Writes the current cachedContentId for a book to L2 (Redis) then L1.
 */
async function writeBookIndex(bookId: string, cachedContentId: string): Promise<void> {
  await setCache(redisBookIndexKey(bookId), cachedContentId, REDIS_BOOK_INDEX_TTL_SECONDS);
  l1BookIndex.set(bookId, cachedContentId);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a Gemini context cache resource name for the given content,
 * creating one if it doesn't exist or has expired/changed.
 *
 * **Cache lookup order:**
 *   1. L1 in-memory (same instance, no I/O)
 *   2. L2 Redis (cross-instance, ~1 ms roundtrip)
 *   3. Create new Gemini cache (~300–800 ms API call)
 *
 * **Stale cache cleanup (Bug 2 fix):**
 * When `bookId` is provided and a different `cachedContentId` is currently
 * registered for that book (i.e. characters or places changed), the previous
 * Gemini cache is deleted from Google's servers before the new one is created.
 * This prevents orphaned caches from accumulating.
 *
 * **Graceful degradation:**
 * All errors (Redis unavailability, Gemini API errors, prefix too short) return
 * `null`. Callers fall back to a standard (non-cached) Gemini request.
 *
 * @param cachedContentId - Stable hash of (bookId + characters + places),
 *   produced by `createCacheKey` in utils/cache.ts. Changes when the
 *   semi-static context changes.
 * @param model - Gemini model string, e.g. "gemini-2.5-flash"
 * @param systemInstruction - Fully static system prompt (PROMPT_SYSTEM + rules + schema).
 *   Must match what `geminiPrompt`/`geminiStreamGenerator` passes as `systemInstruction`.
 * @param semiStaticContext - Formatted book documents (BOOK META + KNOWN CHARACTERS + KNOWN PLACES).
 *   Changes when characters or places are updated.
 * @param bookId - Optional book ID. When provided, enables stale-cache cleanup so
 *   only one Gemini cache exists per book at any time.
 * @returns Gemini cache resource name to pass as `cachedContent`, or `null` if
 *   caching is unavailable or the prefix is too short.
 */
export async function getOrCreateGeminiCache(
  cachedContentId: string,
  model: string,
  systemInstruction: string,
  semiStaticContext: string,
  bookId?: string,
): Promise<string | null> {
  const prefixContent = systemInstruction + semiStaticContext;
  const prefixHash = hashContentDJB2(prefixContent);
  const now = Date.now();

  // ── 1. Check existing cache (L1 → L2) ─────────────────────────────────────
  const existing = await readEntry(cachedContentId);
  if (
    existing &&
    existing.prefixHash === prefixHash &&
    existing.expiresAt > now + EXPIRY_BUFFER_MS
  ) {
    return existing.cacheId;
  }

  // ── 2. Guard: prefix too short to cache ───────────────────────────────────
  // Gemini rejects cache creation below ~1 024 tokens. Skip gracefully.
  if (prefixContent.length < GEMINI_CACHE_MIN_CHARS) return null;

  // ── 3. Clean up stale cache for this book ─────────────────────────────────
  // Evict the previous Gemini cache when characters/places change, so orphaned
  // caches don't accumulate on Google's servers.
  if (bookId) {
    const previousId = await readBookIndex(bookId);
    if (previousId && previousId !== cachedContentId) {
      await invalidateGeminiCache(previousId);
    }
  }

  // ── 4. Create new Gemini context cache ────────────────────────────────────
  try {
    const ai = getGeminiClient();
    const cache = await ai.caches.create({
      model,
      config: {
        ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
        // systemInstruction → fully static content (PROMPT_SYSTEM + rules + schema)
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // contents → semi-static per book (book meta, characters, places)
        contents: [{
          role: 'user',
          parts: [{ text: semiStaticContext }],
        }],
      },
    });

    if (!cache.name) return null;

    const entry: GeminiCacheEntry = {
      cacheId: cache.name,
      prefixHash,
      createdAt: now,
      expiresAt: now + GEMINI_CACHE_TTL_SECONDS * 1_000,
    };

    // Write to L2 (Redis) then L1 — order matters for cross-instance consistency
    await writeEntry(cachedContentId, entry);

    if (bookId) await writeBookIndex(bookId, cachedContentId);

    console.log(`[gemini-cache] 🍪 Created Gemini content cache:`, {
      bookId,
      cachedContentId,
      cacheName: cache.name,
    });

    return cache.name;
  } catch (err) {
    // Non-fatal — caller falls back to a standard (non-cached) request
    console.warn(`[gemini-cache] ⚠️ Failed to create cache:`, classifyGenAIError(err));
    return null;
  }
}

/**
 * Explicitly deletes a Gemini context cache entry.
 *
 * Call this when a book is deleted or when you want to force a cache refresh
 * independent of the TTL. Both L1 and L2 are cleared; the Gemini-side cache
 * is deleted via the API.
 *
 * @param cachedContentId - The cache ID to invalidate
 */
export async function invalidateGeminiCache(cachedContentId: string): Promise<void> {
  const existing = await readEntry(cachedContentId);
  if (existing?.cacheId) {
    // Best-effort: Gemini's TTL will eventually clean it up.
    await getGeminiClient()
      .caches.delete({ name: existing.cacheId })
      .catch((err) =>
        console.warn(`[gemini-cache] ⚠️ Failed to delete cache ${existing.cacheId}:`, err)
      );
    console.log(`[gemini-cache] ✨ Evicted cache: ${existing.cacheId}`);
  }
  // Evict from L1 + L2 so we stop referencing it.
  await removeEntry(cachedContentId);
}

// ─── Schema Conversion ────────────────────────────────────────────────────────

const GEMINI_TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  object: Type.OBJECT,
  array: Type.ARRAY,
  null: Type.NULL,
};

/**
 * Converts a JSON Schema subset into Gemini's native `Schema` format.
 *
 * This utility is intended for structured-output generation with Gemini models.
 * It supports the most common schema constructs used by AI output schemas:
 *
 * - Primitive types
 * - Objects and nested properties
 * - Arrays
 * - Required fields
 * - Enums
 * - Numeric constraints
 * - String formats
 * - `anyOf` / `oneOf`
 * - Nullable types (`["string", "null"]`)
 *
 * When `minify` is enabled, non-essential constraints are removed to reduce
 * Gemini schema complexity and avoid "too many states for serving" errors.
 * The resulting schema preserves structural typing while discarding:
 *
 * - descriptions
 * - enums
 * - formats
 * - minimum / maximum
 * - minItems / maxItems
 * - propertyOrdering
 *
 * @param jsonSchema JSON Schema object to convert.
 * @param options Conversion options.
 * @param options.minify Removes expensive constraints to reduce schema size.
 */
export function convertToGeminiSchema(
  jsonSchema: any,
  options?: { minify?: boolean },
): Schema {
  const { minify = false } = options ?? {};

  if (typeof jsonSchema === 'boolean') return { type: Type.TYPE_UNSPECIFIED };
  if (!jsonSchema || typeof jsonSchema !== 'object') return { type: Type.TYPE_UNSPECIFIED };

  if (jsonSchema.anyOf) {
    return {
      anyOf: jsonSchema.anyOf.map((schema: any) => convertToGeminiSchema(schema, options)),
    } as Schema;
  }

  if (jsonSchema.oneOf) {
    return {
      anyOf: jsonSchema.oneOf.map((schema: any) => convertToGeminiSchema(schema, options)),
    } as Schema;
  }

  let type = jsonSchema.type;

  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');

    if (nonNull.length === 1) {
      type = nonNull[0];
    } else {
      return {
        anyOf: nonNull.map((t) =>
          convertToGeminiSchema(
            { ...jsonSchema, type: t },
            options,
          ),
        ),
      } as Schema;
    }
  }

  if (type === 'array') {
    const schema: Schema = { type: Type.ARRAY };

    if (jsonSchema.items) {
      schema.items = convertToGeminiSchema(jsonSchema.items, options);
    }

    if (!minify) {
      if (typeof jsonSchema.minItems === 'number') schema.minItems = jsonSchema.minItems;
      if (typeof jsonSchema.maxItems === 'number') schema.maxItems = jsonSchema.maxItems;
      if (jsonSchema.description) schema.description = jsonSchema.description;
    }

    return schema;
  }

  if (type === 'object') {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {},
      required: jsonSchema.required ?? [],
    };

    if (jsonSchema.properties) {
      schema.properties = Object.fromEntries(
        Object.entries(jsonSchema.properties).map(([key, value]) => [
          key,
          convertToGeminiSchema(value, options),
        ]),
      );
    }

    if (!minify) {
      if (jsonSchema.description) schema.description = jsonSchema.description;
      if (jsonSchema.propertyOrdering) schema.propertyOrdering = jsonSchema.propertyOrdering;
    }

    return schema;
  }

  const schema: Schema = { type: GEMINI_TYPE_MAP[type] ?? Type.TYPE_UNSPECIFIED };

  if (!minify) {
    if (jsonSchema.description) schema.description = jsonSchema.description;
    if (jsonSchema.enum) schema.enum = jsonSchema.enum;
    if (jsonSchema.format) schema.format = jsonSchema.format;
    if (typeof jsonSchema.minimum === 'number') schema.minimum = jsonSchema.minimum;
    if (typeof jsonSchema.maximum === 'number') schema.maximum = jsonSchema.maximum;
  }

  return schema;
}