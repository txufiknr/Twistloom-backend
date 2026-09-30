/**
 * @overview Custom-action orphan recovery — shared detection + on-demand dispatch
 *
 * Submitting a custom action charges credits and hands generation to the on-demand
 * GitHub workflow ({@link triggerCandidateGenerationWorkflow}). When that dispatch
 * dies — network failure, GitHub outage, or a runner killed mid-generation — the row
 * is charged with no destination page, and the reader may already have closed the
 * tab. Nothing in the request path can observe that, so a scheduled sweep is the
 * only safety net for those "charged but never delivered" rows.
 *
 * Two deliberately different executors sit on ONE shared predicate
 * ({@link findStaleCustomActions}):
 *
 * 1. {@link recoverStaleCustomActionsByDispatch} — **detect + dispatch**. Served by
 *    `POST|GET /api/cron/sweep-custom-actions` (Upstash QStash, every 5 minutes).
 *    It never generates inline: a single custom-action page takes ~30–50s and a
 *    batch takes up to {@link MAX_BRANCHING_PREGENERATION_LIMIT}× that, which blows
 *    past a Vercel serverless function's `maxDuration`. It only queries and hands
 *    work to the same worker the submit path already uses, so the function stays in
 *    the low single-digit seconds.
 * 2. `sweepStaleCustomActions()` in `src/cron/retry-pending-generations.ts` —
 *    **generate inline**. Still runs first in the 12-hour GitHub Actions batch,
 *    where a 30-minute job timeout comfortably fits AI generation. It is the
 *    backstop for anything dispatch cannot (see "known no-op" below).
 *
 * ## Staleness model
 *
 * Two independent clocks, both already established elsewhere in the codebase:
 *
 * | Signal | Threshold | Meaning |
 * |---|---|---|
 * | `custom_actions.generation_started_at IS NULL` and `created_at` older than {@link CUSTOM_ACTION_UNSTARTED_THRESHOLD_MS} | 30s | On-demand dispatcher never picked the row up |
 * | `custom_actions.generation_started_at` older than {@link CUSTOM_ACTION_GENERATION_STALE_MS} | 3min | Worker crashed mid-generation (a page takes ~30–50s) |
 * | `pages.is_generating_started_at` older than {@link CUSTOM_ACTION_GENERATION_STALE_MS} | 3min | The dispatcher claim taken at submit was never released, so {@link triggerCandidateGenerationWorkflow} would no-op — release it first |
 *
 * ## Duplicate-safety
 *
 * Releasing a claim and re-dispatching is guarded by four independent mechanisms,
 * so overlapping runs cannot double-generate:
 * 1. `releaseGenerationClaim` is **compare-and-clear** — it only clears the exact
 *    timestamp it read, so a fresher claim taken meanwhile survives untouched.
 * 2. {@link triggerCandidateGenerationWorkflow} re-takes the claim with an atomic
 *    `UPDATE ... WHERE is_generating_started_at IS NULL`; a loser sees
 *    `alreadyInProgress` and stops.
 * 3. The workflow's GitHub `concurrency` group keys on `page_id` and never
 *    cancels in-flight runs, so a duplicate dispatch queues instead of racing.
 * 4. `generatePageForCustomAction` takes a per-`(page, user)` Redis lock plus a
 *    per-row `generation_started_at` staleness re-check.
 *
 * ## Known no-op (bounded)
 *
 * {@link triggerCandidateGenerationWorkflow} early-returns without dispatching when
 * a **novel-mode** page already has its linear destination — such a row is reported
 * as `dispatched` but no worker runs. It is not spun on forever: the 12-hour batch's
 * inline `sweepStaleCustomActions()` still reaches it, which either generates it or
 * refunds the charge and flips `outcome` to `reject`, ending the row's life.
 *
 * @see src/cron/ensure-qstash-schedules.ts — registers the schedule
 * @see src/routes/cron.ts — the HTTP surface
 */

import { dbRead, dbWrite } from "../db/client.js";
import { books, customActions, pages } from "../db/schema.js";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { MAX_BRANCHING_PREGENERATION_LIMIT } from "../config/story.js";
import { getErrorMessage } from "../utils/error.js";
import {
  releaseGenerationClaim,
  triggerCandidateGenerationWorkflow,
} from "../utils/candidate-generation.js";
import { CUSTOM_ACTION_GENERATION_STALE_MS } from "./custom-actions.js";

/**
 * Logging/dispatch context reported to the workflow dispatcher, so traces of a
 * sweep-initiated run are distinguishable from submit- and poll-initiated ones.
 */
const SWEEP_CONTEXT = "cron/sweep-custom-actions";

/**
 * Custom-action recovery only needs the immediate next page — the same depth the
 * submit route uses (`maxDepth: 1`, "custom actions only require immediate next
 * page"). Canon pre-generation depth is irrelevant here and would only burn AI
 * tokens on a row whose reader is already gone.
 */
const RECOVERY_MAX_DEPTH = 1;

/**
 * Rows whose `generation_started_at` is still `NULL` are given this long for the
 * on-demand GitHub runner to pick them up before the sweep considers the dispatch
 * abandoned. A runner spends most of that window on checkout + `bun install`.
 */
export const CUSTOM_ACTION_UNSTARTED_THRESHOLD_MS = 30_000;

/**
 * A public, non-pen book's unfulfilled, non-rejected custom action that no live
 * worker has touched within the windows documented at the top of this module.
 */
export interface StaleCustomActionRow {
  /** `custom_actions.id` — the charged row to recover */
  id: string;
  /** Owner of the row; also the `triggered_by` attribution sent to the workflow */
  userId: string;
  bookId: string;
  pageId: string;
  /** Book title, required by {@link triggerCandidateGenerationWorkflow} */
  bookTitle: string;
}

/**
 * Outcome of one dispatch sweep, reported verbatim as the cron endpoint's payload
 * so QStash retries and humans reading the DLQ see the same numbers.
 */
export interface CustomActionDispatchSweepResult {
  /** Rows matching the stale predicate — 0 in the overwhelmingly common case */
  scanned: number;
  /**
   * Rows handed to the on-demand dispatcher. Includes the novel-mode early return
   * described in the module doc, which reports success without running a worker.
   */
  dispatched: number;
  /** Rows whose page claim is held by a live dispatcher — deliberately untouched */
  inFlight: number;
  /** Rows whose claim release or dispatch threw — drives the endpoint's 500 */
  failed: number;
}

/**
 * Detects charged custom-action rows whose on-demand generation died or never
 * started.
 *
 * Single indexed pass (`custom_actions_created_at_idx` for the `created_at`
 * predicate, joined to `books` for visibility). Never fatal: callers decide how to
 * treat an empty result, which is the norm.
 *
 * Shared verbatim by both executors so the QStash sweep and the GitHub batch can
 * never drift into disagreeing about which rows are orphaned.
 *
 * @param limit - Max rows to return; defaults to the batch's processing limit
 * @returns Stale rows, newest recovery candidates first (scan order)
 * @throws Drizzle/DB errors — callers wrap as appropriate
 */
export async function findStaleCustomActions(
  limit: number = MAX_BRANCHING_PREGENERATION_LIMIT
): Promise<StaleCustomActionRow[]> {
  const now = Date.now();
  const staleHeartbeatThreshold = new Date(now - CUSTOM_ACTION_GENERATION_STALE_MS);
  const unstartedThreshold = new Date(now - CUSTOM_ACTION_UNSTARTED_THRESHOLD_MS);

  return dbRead
    .select({
      id: customActions.id,
      userId: customActions.userId,
      bookId: customActions.bookId,
      pageId: customActions.pageId,
      bookTitle: books.title,
    })
    .from(customActions)
    .innerJoin(books, eq(customActions.bookId, books.id))
    .where(and(
      eq(books.isPenBook, false),
      eq(books.visibility, 'public'),
      isNull(customActions.nextPageId),
      ne(customActions.outcome, 'reject'),
      or(
        // 1. Unstarted rows old enough that the on-demand runner's own window
        //    (checkout + install + dispatch) has closed without it picking up.
        and(isNull(customActions.generationStartedAt), lt(customActions.createdAt, unstartedThreshold)),
        // 2. Started rows whose heartbeat is older than the stale threshold
        //    (crashed / orphaned worker).
        lt(customActions.generationStartedAt, staleHeartbeatThreshold)
      )
    ))
    .limit(limit);
}

/**
 * Clears a dispatcher claim that outlived {@link CUSTOM_ACTION_GENERATION_STALE_MS}.
 *
 * The claim is set by the submit route's dispatch and released by the workflow
 * when it finishes. If the runner died, the column stays set forever and
 * {@link triggerCandidateGenerationWorkflow} short-circuits with
 * `alreadyInProgress`, so recovery would silently never happen — this is what makes
 * case (2) above reachable at all.
 *
 * Compare-and-clear: only the exact timestamp read here is cleared, so a claim
 * reclaimed by a dispatcher that got there first is left alone. A claim younger
 * than the stale window is left alone too, because a live run is still plausible.
 *
 * Best-effort: a failed read or update logs and returns so the caller still gets to
 * attempt the dispatch (the dispatcher will simply re-observe the claim itself).
 *
 * @param pageId - Page whose claim should be reaped
 * @param context - Log prefix for diagnostics
 */
async function releaseStalePageClaim(pageId: string, context: string): Promise<void> {
  try {
    const [row] = await dbWrite
      .select({ claimAt: pages.isGeneratingStartedAt })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);

    const claimAt = row?.claimAt ?? null;
    if (!claimAt) return;
    if (Date.now() - claimAt.getTime() <= CUSTOM_ACTION_GENERATION_STALE_MS) return;

    const released = await releaseGenerationClaim(pageId, claimAt, context);
    if (released) {
      console.log(`[${context}] ♻️ Released stale generation claim on page ${pageId} (claimed ${claimAt.toISOString()})`);
    }
  } catch (error) {
    console.warn(`[${context}] ⚠️ Could not reap generation claim on page ${pageId} (will still attempt dispatch):`, getErrorMessage(error));
  }
}

/**
 * Detects orphaned custom actions and re-dispatches them to the on-demand GitHub
 * worker — the trigger used by `POST|GET /api/cron/sweep-custom-actions`.
 *
 * Deliberately **never** generates in-process: the caller runs inside a Vercel
 * serverless function whose `maxDuration` is far below one AI generation, let alone
 * a batch of them. Work is handed back to the same dispatcher the submit and poll
 * paths use, so recovery and first-attempt delivery are the exact same code path.
 *
 * Idempotent and safe to run concurrently: a row already claimed by a live
 * dispatcher counts as `inFlight` and is left untouched, and a re-dispatch after a
 * partial failure is absorbed by the claim CAS + the workflow's concurrency group.
 *
 * @returns Per-outcome counts; `failed > 0` means the endpoint should answer 500 so
 * QStash retries (its 3-attempt budget, then the DLQ)
 * @throws Only if detection itself fails — per-row errors are counted, not thrown
 */
export async function recoverStaleCustomActionsByDispatch(): Promise<CustomActionDispatchSweepResult> {
  const staleRows = await findStaleCustomActions();
  const result: CustomActionDispatchSweepResult = {
    scanned: staleRows.length,
    dispatched: 0,
    inFlight: 0,
    failed: 0,
  };
  if (staleRows.length === 0) return result;

  console.log(`[${SWEEP_CONTEXT}] 🎨 Found ${staleRows.length} orphaned custom action(s) to re-dispatch`);

  for (const staleRow of staleRows) {
    try {
      await releaseStalePageClaim(staleRow.pageId, SWEEP_CONTEXT);

      const dispatch = await triggerCandidateGenerationWorkflow({
        bookTitle: staleRow.bookTitle,
        bookId: staleRow.bookId,
        pageId: staleRow.pageId,
        userId: staleRow.userId,
        maxDepth: RECOVERY_MAX_DEPTH,
        context: SWEEP_CONTEXT,
      });

      if (dispatch.alreadyInProgress) {
        result.inFlight++;
        console.log(`[${SWEEP_CONTEXT}] ⏳ Custom action ${staleRow.id}: page claim held by a live dispatcher, left alone`);
      } else if (dispatch.success) {
        result.dispatched++;
        console.log(`[${SWEEP_CONTEXT}] 🎨 Custom action ${staleRow.id} re-dispatched for book ${staleRow.bookId} page ${staleRow.pageId}`);
      } else {
        result.failed++;
        console.error(`[${SWEEP_CONTEXT}] ❌ Custom action ${staleRow.id} dispatch failed: ${dispatch.error ?? "unknown error"}`);
      }
    } catch (error) {
      result.failed++;
      console.error(`[${SWEEP_CONTEXT}] ❌ Custom action ${staleRow.id} recovery failed:`, getErrorMessage(error));
    }
  }

  console.log(`[${SWEEP_CONTEXT}] ✅ Sweep finished: ${JSON.stringify(result)}`);
  return result;
}
