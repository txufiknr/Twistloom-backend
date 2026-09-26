/**
 * Companion cache coherence tests (generation-stamped invalidation, Redis-less mode).
 *
 * These run against the process-LRU + Redis-less fallback path by design: no
 * Redis env vars are required, and even if a client were configured but
 * unreachable, every Redis call in companion-cache.ts fails soft and the same
 * assertions hold (local prefix delete path).
 */
import { describe, expect, it } from 'bun:test';
import {
  getCachedPageQuestions,
  getCachedSuggestions,
  invalidateSuggestionsCache,
  setCachedPageQuestions,
  setCachedSuggestions,
} from '../src/services/companion-cache.js';

function uniqueIds(): { bookId: string; pageId: string } {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { bookId: `book-${token}`, pageId: `page-${token}` };
}

describe('suggestions cache round-trip', () => {
  it('returns the stored questions on a hit and null for a different query', async () => {
    const { bookId, pageId } = uniqueIds();
    await setCachedSuggestions(bookId, pageId, 'why the key', 5, ['Why the key?']);

    const hit = await getCachedSuggestions(bookId, pageId, 'why the key', 5);
    expect(hit).toEqual(['Why the key?']);

    const miss = await getCachedSuggestions(bookId, pageId, 'another question', 5);
    expect(miss).toBeNull();
  });

  it('normalizes null / blank queries to the same empty-query key', async () => {
    const { bookId, pageId } = uniqueIds();
    await setCachedSuggestions(bookId, pageId, '', 5, ['Suggestion A']);

    const fromNull = await getCachedSuggestions(bookId, pageId, null, 5);
    const fromWhitespace = await getCachedSuggestions(bookId, pageId, '   ', 5);
    expect(fromNull).toEqual(['Suggestion A']);
    expect(fromWhitespace).toEqual(['Suggestion A']);
  });
});

describe('page-question pool round-trip', () => {
  it('stores and returns the aggregated candidate pool', async () => {
    const { bookId, pageId } = uniqueIds();
    const pool = [
      { original: 'Who took the key?', count: 4, lastAsked: 1_700_000_000_000 },
      { original: 'Why did she leave?', count: 2, lastAsked: 1_700_000_100_000 },
    ];
    await setCachedPageQuestions(bookId, pageId, pool);

    const hit = await getCachedPageQuestions(bookId, pageId);
    expect(hit).toEqual(pool);

    expect(await getCachedPageQuestions(bookId, `${pageId}-other`)).toBeNull();
  });
});

describe('invalidateSuggestionsCache', () => {
  it('clears suggestion results for the page', async () => {
    const { bookId, pageId } = uniqueIds();
    await setCachedSuggestions(bookId, pageId, 'q', 5, ['Question?']);
    expect(await getCachedSuggestions(bookId, pageId, 'q', 5)).toEqual(['Question?']);

    await invalidateSuggestionsCache(bookId, pageId);

    expect(await getCachedSuggestions(bookId, pageId, 'q', 5)).toBeNull();
  });

  it('clears the page-question pool through the same generation bump', async () => {
    const { bookId, pageId } = uniqueIds();
    await setCachedPageQuestions(bookId, pageId, [
      { original: 'Q?', count: 1, lastAsked: 1 },
    ]);
    expect(await getCachedPageQuestions(bookId, pageId)).not.toBeNull();

    await invalidateSuggestionsCache(bookId, pageId);

    expect(await getCachedPageQuestions(bookId, pageId)).toBeNull();
  });

  it('does not touch entries belonging to another page', async () => {
    const a = uniqueIds();
    const b = uniqueIds();
    await setCachedSuggestions(a.bookId, a.pageId, 'q', 5, ['A?']);
    await setCachedSuggestions(b.bookId, b.pageId, 'q', 5, ['B?']);

    await invalidateSuggestionsCache(a.bookId, a.pageId);

    expect(await getCachedSuggestions(a.bookId, a.pageId, 'q', 5)).toBeNull();
    expect(await getCachedSuggestions(b.bookId, b.pageId, 'q', 5)).toEqual(['B?']);
  });
});
