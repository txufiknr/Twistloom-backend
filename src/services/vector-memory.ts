/**
 * @overview pgvector Semantic Memory — Retrieval & Write Service
 *
 * Two responsibilities, kept in one file because they're always used together
 * from the same page-generation call site:
 *
 * 1. WRITE — embed page text, character interactions, place events, and
 *    future notes into their respective embedding tables. Every write
 *    function here is meant to be called fire-and-forget, from the
 *    page-generation caller (generateNextPage / generateNextPages), AFTER
 *    persistPageWithState resolves — NEVER from inside applyStateDelta or
 *    the processXxx state-transition helpers it calls. Those run identically
 *    during live generation AND during delta-chain replay (confirmed against
 *    utils/story.ts / branch-traversal.ts: applyStateDelta's own docstring
 *    says it's reused "for reconstructing story states... when loading
 *    previously generated pages"), so hooking writes in there would silently
 *    re-embed the same history every time a pruned story_states row gets
 *    reconstructed. See PGVECTOR_SEMANTIC_MEMORY_ROADMAP.md §12 / Appendix
 *    D.3 for the full trace.
 *
 * 2. READ — cosine-similarity retrieval against each embedding table,
 *    scoped to the current book/branch and filtered to the past (never
 *    retrieves future pages/events relative to the caller's current page).
 */

import { and, cosineDistance, eq, lt, sql } from 'drizzle-orm';
import { dbWrite, dbRead } from '../db/client.js';
import { pageEmbeddings, characterEmbeddings, placeEmbeddings, futureNoteEmbeddings } from '../db/schema.js';
import { embedText } from '../utils/embedding.js';
import { getErrorMessage } from '../utils/error.js';
import { MAX_VECTOR_RESULTS_PER_QUERY, EMBEDDING_SIMILARITY_THRESHOLD } from '../config/embedding.js';
import type { PersistedStoryPage, FutureNote } from '../types/story.js';

// ============================================================================
// WRITE — page embeddings
// ============================================================================

/**
 * Builds the text that gets embedded for a page. Field names confirmed
 * against StoryPage/StoryScene in types/story.ts.
 */
export function buildPageEmbeddingText(page: PersistedStoryPage): string {
  return [
    `Page ${page.page}:`,
    `Scene: ${page.text}`,
    page.mood ? `Mood: ${page.mood}` : '',
    page.keyEvents?.length ? `Key events: ${page.keyEvents.join(', ')}` : '',
    page.charactersPresent?.length ? `Characters: ${page.charactersPresent.map(c => c.characterId).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Embeds a page's text. Fire-and-forget — call from generateNextPage /
 * generateNextPages right after persistPageWithState resolves. Never throws
 * to the caller; failures are logged and swallowed, since the page text
 * itself is already safely persisted and the embedding is a rebuildable
 * cache (see the backfill cron for how missing embeddings get filled in
 * later regardless).
 */
export async function embedPersistedPage(page: PersistedStoryPage): Promise<void> {
  try {
    const sourceText = buildPageEmbeddingText(page);
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await dbWrite.insert(pageEmbeddings).values({
      pageId: page.id,
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      embedding,
      sourceText,
    }).onConflictDoUpdate({
      target: pageEmbeddings.pageId,
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedPersistedPage] ⚠️ Failed to embed page ${page.page} (${page.id}):`, getErrorMessage(error));
  }
}

// ============================================================================
// WRITE — character interactions, place events, future notes
// ============================================================================

/**
 * Embeds new character interactions for one character on one page, joining
 * same-page interactions into a single row — mirrors how
 * formatCharactersForPrompt() already groups them for display.
 */
async function embedCharacterInteractions(
  page: PersistedStoryPage,
  characterId: string,
  interactions: string[]
): Promise<void> {
  if (!interactions.length) return;
  try {
    const sourceText = interactions.join(' ');
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await dbWrite.insert(characterEmbeddings).values({
      pageId: page.id,
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      characterId,
      embedding,
      sourceText,
    }).onConflictDoUpdate({
      target: [characterEmbeddings.pageId, characterEmbeddings.characterId],
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedCharacterInteractions] ⚠️ Failed for ${characterId} on page ${page.page}:`, getErrorMessage(error));
  }
}

/**
 * Embeds new place key events for one place on one page — same pattern as
 * embedCharacterInteractions, mirrors formatPlacesForPrompt()'s grouping.
 * Deliberately does NOT feed calculatePlaceFamiliarity() — that stays
 * deterministic and synchronous exactly as designed.
 */
async function embedPlaceEvents(
  page: PersistedStoryPage,
  placeId: string,
  events: string[]
): Promise<void> {
  if (!events.length) return;
  try {
    const sourceText = events.join(' ');
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await dbWrite.insert(placeEmbeddings).values({
      pageId: page.id,
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      placeId,
      embedding,
      sourceText,
    }).onConflictDoUpdate({
      target: [placeEmbeddings.pageId, placeEmbeddings.placeId],
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedPlaceEvents] ⚠️ Failed for ${placeId} on page ${page.page}:`, getErrorMessage(error));
  }
}

/**
 * Embeds a single future note, keyed by its stable `key` — not array
 * position. Call only for genuinely new/changed notes (from
 * StateDelta.futureNoteUpdates.add), never for notes that are merely
 * present in a page's futureNotes snapshot.
 */
async function embedFutureNote(page: PersistedStoryPage, note: FutureNote): Promise<void> {
  try {
    const embedding = await embedText(note.note, 'retrieval.passage');

    await dbWrite.insert(futureNoteEmbeddings).values({
      pageId: page.id,
      bookId: page.bookId,
      branchId: page.branchId,
      noteKey: note.key,
      embedding,
      sourceText: note.note,
    }).onConflictDoUpdate({
      target: [futureNoteEmbeddings.bookId, futureNoteEmbeddings.branchId, futureNoteEmbeddings.noteKey],
      set: { embedding, sourceText: note.note },
    });
  } catch (error) {
    console.error(`[embedFutureNote] ⚠️ Failed for note ${note.key}:`, getErrorMessage(error));
  }
}

/**
 * Embeds every character interaction, place event, and future note added by
 * this page's StateDelta — read directly off `page.stateDelta` (confirmed:
 * every persisted page carries its own delta, `pages.stateDelta` /
 * column "delta" in schema.ts), not a separately-threaded parameter. This
 * means the same function works identically whether called live (right
 * after persistPageWithState resolves) or from the backfill cron against an
 * old page loaded straight from the `pages` table — no extra plumbing needed
 * either way. Never re-derives anything from applyStateDelta's output.
 *
 * Fire-and-forget when called live; call alongside embedPersistedPage()
 * right after persistPageWithState resolves.
 *
 * Uses Promise.allSettled so one slow/failed embed (e.g. one character's
 * interaction failing to embed) never blocks or fails the others.
 */
export async function embedStateDeltaEntities(page: PersistedStoryPage): Promise<void> {
  const stateDelta = page.stateDelta;
  if (!stateDelta) return;

  const jobs: Promise<void>[] = [];

  for (const character of stateDelta.characterUpdates?.newCharacters ?? []) {
    if (character.pastInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, character.characterId, character.pastInteractions));
    }
  }
  for (const update of stateDelta.characterUpdates?.updatedCharacters ?? []) {
    if (update.newInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, update.characterId, update.newInteractions));
    }
  }

  for (const place of stateDelta.placeUpdates?.newPlaces ?? []) {
    if (place.keyEvents?.length) {
      jobs.push(embedPlaceEvents(page, place.placeId, place.keyEvents));
    }
  }
  for (const update of stateDelta.placeUpdates?.updatedPlaces ?? []) {
    if (update.addKeyEvents?.length) {
      jobs.push(embedPlaceEvents(page, update.placeId, update.addKeyEvents));
    }
  }

  for (const note of stateDelta.futureNoteUpdates?.add ?? []) {
    jobs.push(embedFutureNote(page, note));
  }

  await Promise.allSettled(jobs);
}

// ============================================================================
// READ — semantic retrieval
// ============================================================================

export interface SimilarPageResult {
  page: number;
  sourceText: string | null;
  similarity: number;
}

/**
 * Retrieves pages semantically similar to `query`, scoped to this book/
 * branch and strictly before `currentPage` — supplements (does not replace)
 * contextHistory's lossy running summary. Results below
 * EMBEDDING_SIMILARITY_THRESHOLD are filtered out so a "no good matches"
 * scene doesn't inject noise into the prompt.
 */
export async function retrieveSimilarPages(
  query: string,
  bookId: string,
  branchId: string,
  currentPage: number,
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY
): Promise<SimilarPageResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(pageEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ page: pageEmbeddings.page, sourceText: pageEmbeddings.sourceText, similarity })
    .from(pageEmbeddings)
    .where(and(
      eq(pageEmbeddings.bookId, bookId),
      eq(pageEmbeddings.branchId, branchId),
      lt(pageEmbeddings.page, currentPage),
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}

export interface SimilarInteractionResult {
  page: number;
  sourceText: string | null;
  similarity: number;
}

/**
 * Retrieves character interactions older than `oldestVisiblePage` (the
 * lowest page number still present in that character's live pastInteractions
 * sliding window) that are semantically relevant to `query`. Never
 * duplicates what formatCharactersForPrompt() is already showing in full.
 */
export async function retrieveCharacterInteractions(
  query: string,
  bookId: string,
  branchId: string,
  characterId: string,
  oldestVisiblePage: number,
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY
): Promise<SimilarInteractionResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(characterEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ page: characterEmbeddings.page, sourceText: characterEmbeddings.sourceText, similarity })
    .from(characterEmbeddings)
    .where(and(
      eq(characterEmbeddings.bookId, bookId),
      eq(characterEmbeddings.branchId, branchId),
      eq(characterEmbeddings.characterId, characterId),
      lt(characterEmbeddings.page, oldestVisiblePage),
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}

/**
 * Same shape as retrieveCharacterInteractions — oldestVisiblePage is the min
 * page among the entries formatPlacesForPrompt() is already showing for
 * this place (up to MAX_PLACE_EVENTS).
 */
export async function retrievePlaceEvents(
  query: string,
  bookId: string,
  branchId: string,
  placeId: string,
  oldestVisiblePage: number,
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY
): Promise<SimilarInteractionResult[]> {
  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(placeEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ page: placeEmbeddings.page, sourceText: placeEmbeddings.sourceText, similarity })
    .from(placeEmbeddings)
    .where(and(
      eq(placeEmbeddings.bookId, bookId),
      eq(placeEmbeddings.branchId, branchId),
      eq(placeEmbeddings.placeId, placeId),
      lt(placeEmbeddings.page, oldestVisiblePage),
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}

export interface RelevantFutureNoteResult {
  noteKey: string;
  sourceText: string | null;
  similarity: number;
}

/**
 * Ranks a set of candidate future notes by semantic similarity to `query`.
 * Only call this against the `unscheduled` bucket already computed by
 * formatFutureNotes() — `becomingRelevant` notes are time-critical and
 * should stay fully shown regardless of similarity score (see roadmap §4,
 * Use Case 3).
 */
export async function retrieveRelevantFutureNotes(
  query: string,
  bookId: string,
  branchId: string,
  candidateKeys: string[],
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY
): Promise<RelevantFutureNoteResult[]> {
  if (!candidateKeys.length) return [];

  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(futureNoteEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ noteKey: futureNoteEmbeddings.noteKey, sourceText: futureNoteEmbeddings.sourceText, similarity })
    .from(futureNoteEmbeddings)
    .where(and(
      eq(futureNoteEmbeddings.bookId, bookId),
      eq(futureNoteEmbeddings.branchId, branchId),
      sql`${futureNoteEmbeddings.noteKey} = ANY(${candidateKeys})`,
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}
