/**
 * @overview pgvector Semantic Memory — Retrieval & Write Service
 *
 * Two responsibilities, kept in one file because they're always used together
 * from the same page-generation call site:
 *
 * 1. WRITE — embed page text, character interactions, place events, future
 *    notes, and thread clues into their respective embedding tables. Every
 *    write function here is meant to be called fire-and-forget, from the
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
 *
 * Kill-switch: every exported function here checks PGVECTOR_MEMORY_ENABLED
 * (config/embedding.ts) first and no-ops (void / []) if disabled — set
 * PGVECTOR_MEMORY_ENABLED=false to turn off all embedding writes and
 * retrieval without a code change, if Jina misbehaves in production.
 */

import { and, cosineDistance, eq, inArray, lt, sql } from 'drizzle-orm';
import { dbWrite, dbRead } from '../db/client.js';
import { pages, pageEmbeddings, characterEmbeddings, placeEmbeddings, futureNoteEmbeddings, clueEmbeddings } from '../db/schema.js';
import { embedText } from '../utils/embedding.js';
import { getErrorMessage } from '../utils/error.js';
import { MAX_VECTOR_RESULTS_PER_QUERY, EMBEDDING_SIMILARITY_THRESHOLD, PGVECTOR_MEMORY_ENABLED } from '../config/embedding.js';
import type { PersistedStoryPage, FutureNote } from '../types/story.js';

// ============================================================================
// WRITE — page embeddings
// ============================================================================

/**
 * Builds the text that gets embedded for a page. Field names confirmed
 * against StoryPage/StoryScene in types/story.ts.
 *
 * Deliberately NOT prefixed with a "Page N:" label — the page number already
 * lives in the structured `page` column (used for `page < currentPage`
 * filtering) and is added contextually when the retrieved sourceText is
 * rendered into a prompt (e.g. "- Page 18 (similarity: 0.91): Scene: …").
 * Baking it into the embedded string would duplicate a display concern into
 * what should be pure semantic content.
 */
export function buildPageEmbeddingText(page: PersistedStoryPage): string {
  return [
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
  if (!PGVECTOR_MEMORY_ENABLED) return;
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
 * StateDelta.futureNoteAdd), never for notes that are merely
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
 * Embeds new clues for one thread on one page, joining same-page clues into
 * a single row — mirrors embedCharacterInteractions/embedPlaceEvents. Unlike
 * those two, StoryThread.clues is never trimmed at storage time
 * (processThreadUpdates just .push()es); the trim happens at DISPLAY time in
 * formatActiveThreads (MAX_THREADS_CLUES). Functionally the same recall gap
 * though: older clues become invisible once display-time trimming drops them.
 */
async function embedClues(page: PersistedStoryPage, threadId: string, clues: string[]): Promise<void> {
  if (!clues.length) return;
  try {
    const sourceText = clues.join(' ');
    const embedding = await embedText(sourceText, 'retrieval.passage');

    await dbWrite.insert(clueEmbeddings).values({
      pageId: page.id,
      bookId: page.bookId,
      branchId: page.branchId,
      page: page.page,
      threadId,
      embedding,
      sourceText,
    }).onConflictDoUpdate({
      target: [clueEmbeddings.pageId, clueEmbeddings.threadId],
      set: { embedding, sourceText },
    });
  } catch (error) {
    console.error(`[embedClues] ⚠️ Failed for thread ${threadId} on page ${page.page}:`, getErrorMessage(error));
  }
}

/**
 * Embeds every character interaction, place event, future note, and clue
 * added by this page's StateDelta — read directly off `page.stateDelta` (confirmed:
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
  if (!PGVECTOR_MEMORY_ENABLED) return;

  const stateDelta = page.stateDelta;
  if (!stateDelta) return;

  const jobs: Promise<void>[] = [];

  for (const character of stateDelta.newCharacters ?? []) {
    if (character.pastInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, character.characterId, character.pastInteractions));
    }
  }
  for (const update of stateDelta.updatedCharacters ?? []) {
    if (update.newInteractions?.length) {
      jobs.push(embedCharacterInteractions(page, update.characterId, update.newInteractions));
    }
  }

  for (const place of stateDelta.newPlaces ?? []) {
    if (place.keyEvents?.length) {
      jobs.push(embedPlaceEvents(page, place.placeId, place.keyEvents));
    }
  }
  for (const update of stateDelta.updatedPlaces ?? []) {
    if (update.addKeyEvents?.length) {
      jobs.push(embedPlaceEvents(page, update.placeId, update.addKeyEvents));
    }
  }

  for (const note of stateDelta.futureNoteAdd ?? []) {
    jobs.push(embedFutureNote(page, note));
  }

  // Clues come from two sources: bundled with new thread creation, or added
  // to an existing thread later. addClues is a flat array that can span
  // multiple threadIds in one page, so group by threadId first — otherwise
  // two clues added to the same thread on the same page would race on the
  // same (pageId, threadId) upsert target instead of getting joined into
  // one row like embedClues expects.
  for (const newThread of stateDelta.newThreads ?? []) {
    if (newThread.clues?.length) {
      jobs.push(embedClues(page, newThread.threadId, newThread.clues.map(c => c.clue)));
    }
  }
  const addCluesByThread = new Map<string, string[]>();
  for (const added of stateDelta.addClues ?? []) {
    const existing = addCluesByThread.get(added.threadId) ?? [];
    existing.push(added.clue);
    addCluesByThread.set(added.threadId, existing);
  }
  for (const [threadId, clues] of addCluesByThread) {
    jobs.push(embedClues(page, threadId, clues));
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
 *
 * @param options.prioritizeMajorEvents - Use Case 8 (finale callbacks):
 * boosts pages where `StateDelta.isMajorEvent` is true — read directly off
 * `pages.stateDelta` (the AI's own per-page judgment call, already captured
 * during generation; no new column or write-side change needed) — to the
 * front of the ranking via `ORDER BY isMajorEvent DESC, distance ASC`. This
 * doesn't exclude non-major pages, so a book that never racked up many
 * major-event pages still gets its remaining slots filled by the next-best
 * similarity matches instead of coming back emptier than a normal query.
 */
export async function retrieveSimilarPages(
  query: string,
  bookId: string,
  branchId: string,
  currentPage: number,
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY,
  options?: { prioritizeMajorEvents?: boolean }
): Promise<SimilarPageResult[]> {
  if (!PGVECTOR_MEMORY_ENABLED) return [];

  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(pageEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  if (options?.prioritizeMajorEvents) {
    const isMajorEvent = sql<boolean>`COALESCE((${pages.stateDelta}->>'isMajorEvent')::boolean, false)`;

    const rows = await dbRead
      .select({ page: pageEmbeddings.page, sourceText: pageEmbeddings.sourceText, similarity })
      .from(pageEmbeddings)
      .innerJoin(pages, eq(pageEmbeddings.pageId, pages.id))
      .where(and(
        eq(pageEmbeddings.bookId, bookId),
        eq(pageEmbeddings.branchId, branchId),
        lt(pageEmbeddings.page, currentPage),
      ))
      .orderBy(sql`${isMajorEvent} DESC`, distance)
      .limit(limit);

    return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
  }

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
  if (!PGVECTOR_MEMORY_ENABLED) return [];

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
  if (!PGVECTOR_MEMORY_ENABLED) return [];

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
  if (!candidateKeys.length || !PGVECTOR_MEMORY_ENABLED) return [];

  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(futureNoteEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ noteKey: futureNoteEmbeddings.noteKey, sourceText: futureNoteEmbeddings.sourceText, similarity })
    .from(futureNoteEmbeddings)
    .where(and(
      eq(futureNoteEmbeddings.bookId, bookId),
      eq(futureNoteEmbeddings.branchId, branchId),
       inArray(futureNoteEmbeddings.noteKey, candidateKeys),
     ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}

/**
 * Retrieves clues for one thread, older than `oldestVisiblePage` (the lowest
 * discoveredAtPage among the clues formatActiveThreads() is already showing
 * for that thread, up to MAX_THREADS_CLUES), semantically relevant to
 * `query`. Same pattern as retrieveCharacterInteractions/retrievePlaceEvents
 * — never duplicates what's already displayed in full.
 */
export async function retrieveClues(
  query: string,
  bookId: string,
  branchId: string,
  threadId: string,
  oldestVisiblePage: number,
  limit: number = MAX_VECTOR_RESULTS_PER_QUERY
): Promise<SimilarInteractionResult[]> {
  if (!PGVECTOR_MEMORY_ENABLED) return [];

  const queryEmbedding = await embedText(query, 'retrieval.query');
  const distance = cosineDistance(clueEmbeddings.embedding, queryEmbedding);
  const similarity = sql<number>`1 - (${distance})`;

  const rows = await dbRead
    .select({ page: clueEmbeddings.page, sourceText: clueEmbeddings.sourceText, similarity })
    .from(clueEmbeddings)
    .where(and(
      eq(clueEmbeddings.bookId, bookId),
      eq(clueEmbeddings.branchId, branchId),
      eq(clueEmbeddings.threadId, threadId),
      lt(clueEmbeddings.page, oldestVisiblePage),
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.filter(r => r.similarity >= EMBEDDING_SIMILARITY_THRESHOLD);
}
