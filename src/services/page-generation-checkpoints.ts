/**
 * @overview Page Generation Checkpoint Service
 *
 * Turn-A (StoryPage) result cache for multi-turn (stage-split) page
 * generation — MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 2.6, Phase 6.
 *
 * NOT a task/retry ledger — the existing retry machinery already
 * guarantees eventual success on any generation failure (the
 * `retry-pending-generations` cron + `ensureCandidatesForPageWithStrategy`'s
 * in-process backoff, both driven off `pages.pendingGenerationCount`). This
 * service exists purely so a retried attempt can skip Turn A when a valid
 * one was already produced on a prior attempt whose Turn B failed — a cost
 * optimization, not a correctness fix.
 *
 * ### Architectural Determinism & Keying Rationale
 * Keyed strictly on `(actionedPageId, actionText, fateIndex)` without a TTL
 * or context hash because Turn A's input prompt is mathematically and
 * relationally deterministic across all retries:
 * 1. `advanceStoryState(currentState, actionedPage)` is a pure state transition
 *    function with zero I/O and zero random dependencies.
 * 2. Ancestor pages ($1 \dots \text{actionedPage.page}$) are committed and immutable.
 * 3. All pgvector semantic recall queries strictly filter on
 *    `lt(page, actionedPage.page)` and `eq(branchId, branchId)`. Parallel sibling
 *    candidates at $\text{actionedPage.page} + 1$ or on other branches are structurally
 *    excluded, guaranteeing identical semantic recall across all retry attempts.
 * 4. Checkpoints are automatically deleted immediately after successful page persistence,
 *    and orphaned rows from abandoned actions are reclaimed by the 7-day sweep.
 *
 * All functions here are deliberately narrow — a lookup, an upsert,
 * a delete, and a periodic sweep. Callers (`generateStoryGenerationMultiTurn`
 * in `utils/prompt.ts`) treat writes as best-effort: a failed checkpoint write
 * never aborts a generation that otherwise succeeded.
 */

import { dbRead, dbWrite } from "../db/client.js";
import { pageGenerationCheckpoints } from "../db/schema.js";
import { and, eq, lt } from "drizzle-orm";
import type { AIChatProvider } from "../types/ai-chat.js";
import type { StoryPageGeneration } from "../types/story.js";

export type PageGenerationCheckpoint = {
  id: string;
  bookId: string;
  actionedPageId: string;
  actionText: string;
  fateIndex: number;
  storyPageJson: StoryPageGeneration;
  storyPageProvider: AIChatProvider | "none" | null;
  storyPageModel: string | null;
};

/**
 * Looks up a cached Turn A (StoryPage) result for a specific action + fate
 * slot. Returns `null` on a cache miss (no row, or the row failed to read)
 * — callers should treat a `null` return as "run Turn A fresh," the exact
 * same behavior as before this cache existed, never a hard failure.
 */
export async function getPageGenerationCheckpoint(
  actionedPageId: string,
  actionText: string,
  fateIndex: number,
): Promise<PageGenerationCheckpoint | null> {
  try {
    const [row] = await dbRead
      .select()
      .from(pageGenerationCheckpoints)
      .where(and(
        eq(pageGenerationCheckpoints.actionedPageId, actionedPageId),
        eq(pageGenerationCheckpoints.actionText, actionText),
        eq(pageGenerationCheckpoints.fateIndex, fateIndex),
      ))
      .limit(1);

    return row ?? null;
  } catch (error) {
    console.warn(`[getPageGenerationCheckpoint] ⚠️ Lookup failed (treating as cache miss):`, error);
    return null;
  }
}

/**
 * Inserts or updates the checkpoint for a (actionedPageId, actionText,
 * fateIndex) triple. A losing race on the unique constraint just overwrites
 * with an equally-valid Turn A result — both are valid completions of the
 * same deterministic input (`prepareNextPageGenerationSetup`'s reconstructed
 * `advancedState`), so no conflict-resolution logic beyond the upsert
 * itself is needed.
 *
 * Best-effort by design: failures are logged, not thrown — a checkpoint
 * write failing should never fail the generation it's trying to make
 * cheaper to retry. Callers should `void`/fire-and-forget this or await it
 * without letting a rejection propagate.
 */
export async function upsertPageGenerationCheckpoint(params: {
  bookId: string;
  actionedPageId: string;
  actionText: string;
  fateIndex: number;
  storyPageJson: StoryPageGeneration;
  storyPageProvider?: AIChatProvider | "none";
  storyPageModel?: string;
}): Promise<void> {
  const { bookId, actionedPageId, actionText, fateIndex, storyPageJson, storyPageProvider, storyPageModel } = params;

  try {
    await dbWrite
      .insert(pageGenerationCheckpoints)
      .values({ bookId, actionedPageId, actionText, fateIndex, storyPageJson, storyPageProvider, storyPageModel })
      .onConflictDoUpdate({
        target: [pageGenerationCheckpoints.actionedPageId, pageGenerationCheckpoints.actionText, pageGenerationCheckpoints.fateIndex],
        set: { storyPageJson, storyPageProvider, storyPageModel, updatedAt: new Date() },
      });
  } catch (error) {
    console.warn(`[upsertPageGenerationCheckpoint] ⚠️ Write failed (non-fatal — next retry just won't skip Turn A):`, error);
  }
}

/**
 * Deletes a checkpoint once its merged page has persisted successfully —
 * called by `generateNextPage`/`generateNextPages` right after
 * `persistPageWithState` succeeds, not by `generateStoryGenerationMultiTurn`
 * itself (which runs before persistence and has no way to know it
 * succeeded). A no-op (not an error) if no checkpoint exists for this key
 * — the legacy (non-multi-turn) path never creates one, so calling this
 * unconditionally is always safe, just occasionally a wasted round-trip.
 *
 * Best-effort by design, same rationale as the upsert above: a failed
 * delete just leaves a harmless stale-but-otherwise-inert row (Part 2.6's
 * "orphan" case, cleaned up by the optional Step 6.4 sweep) — never a
 * reason to fail an otherwise-successful persist.
 */
export async function deletePageGenerationCheckpoint(
  actionedPageId: string,
  actionText: string,
  fateIndex: number,
): Promise<void> {
  try {
    await dbWrite
      .delete(pageGenerationCheckpoints)
      .where(and(
        eq(pageGenerationCheckpoints.actionedPageId, actionedPageId),
        eq(pageGenerationCheckpoints.actionText, actionText),
        eq(pageGenerationCheckpoints.fateIndex, fateIndex),
      ));
  } catch (error) {
    console.warn(`[deletePageGenerationCheckpoint] ⚠️ Delete failed (non-fatal — leaves a harmless orphaned row):`, error);
  }
}

/**
 * Audit Q6 (Step 6.4): periodically reclaims orphaned checkpoint rows that
 * were never deleted on successful persist — e.g. a surviving Turn A
 * checkpoint for a fate slot whose page was later replaced, or the narrow
 * top-up fate-slot edge. These rows are harmless (the cache lookup is keyed
 * and the table is tiny) but accumulate over time, so a lightweight sweep
 * keeps them bounded without a TTL column or schema change.
 *
 * Best-effort and non-throwing: a sweep failure must never break the cron
 * that calls it. Uses `createdAt` (no extra index needed beyond the one
 * already present for observability).
 *
 * @param olderThanDays - Remove checkpoints created more than this many days ago (default 7).
 */
export async function deleteOldPageGenerationCheckpoints(olderThanDays: number = 7): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    await dbWrite
      .delete(pageGenerationCheckpoints)
      .where(lt(pageGenerationCheckpoints.createdAt, cutoff));
    console.log(`[deleteOldPageGenerationCheckpoints] 🧹 Swept checkpoints older than ${olderThanDays}d`);
  } catch (error) {
    console.warn(`[deleteOldPageGenerationCheckpoints] ⚠️ Sweep failed (non-fatal):`, error);
  }
}
