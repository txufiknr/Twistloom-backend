/**
 * Shared Companion Ask helpers — the single implementation of charge / refund /
 * persist / cache-hit bookkeeping used by BOTH ask routes
 * (`POST /:identifier/:pageId/companion/ask` and `.../companion/ask/stream`).
 *
 * ## Why charge-then-run instead of `executeWithCredits` wrapping the LLM call
 *
 * `executeWithCredits` keeps ONE Postgres transaction — and therefore the
 * `SELECT … FOR UPDATE` row lock on the user's credits row plus a pooled
 * connection — open for the ENTIRE operation. For an SSE stream that operation
 * is the whole generation (10–60 s), during which ANY other credit operation
 * for the same user (a second ask, a purchase, another generation) blocks until
 * the stream finishes, and a connection is held hostage per concurrent stream.
 *
 * These helpers therefore charge in a millisecond-scale transaction
 * ({@link chargeCompanionAsk}), run generation outside any transaction, and
 * refund on failure ({@link refundCompanionAsk}) — preserving the "never
 * charged for a failed ask" business rule without holding locks across streams.
 *
 * Known tradeoff (accepted): a hard process crash between commit and refund
 * strands one credit for that ask (no automatic reconciliation yet), versus the
 * prior behavior where a crash mid-stream rolled the charge back. Soft failures
 * (provider errors, aborted streams, validation failures) still net to zero.
 */

import { dbWrite } from "../db/client.js";
import { companionAnswers } from "../db/schema.js";
import { executeWithCredits, refundCredits } from "./credits.js";
import { getCreditCostForUser } from "../config/credits.js";
import { invalidateSuggestionsCache } from "./companion-cache.js";
import { getErrorMessage } from "../utils/error.js";
import type { CompanionResult } from "../utils/companion-prompt.js";

/** Wire-shape of a companion answer — identical for cached and fresh turns. */
export interface CompanionAnswerPayload {
  answer: string;
  sources: string[];
  suggestedFollowUps: string[];
}

/** The subset of a cached `companion_answers` row the ask routes consume. */
export interface CompanionCacheHitRow {
  userId: string;
  /** Legacy rows may carry `null` — the insert below then always runs. */
  sessionId: string | null;
  answer: string;
  sources: string[];
  suggestedFollowUps: string[];
}

/** Turn coordinates shared by cache-hit bookkeeping and turn persistence. */
export interface CompanionTurnCoordinates {
  userId: string;
  sessionId: string;
  bookId: string;
  pageId: string;
  /** Raw (pre-hash) question text as asked by the reader. */
  question: string;
  /** `sha256(lowercase + trimmed question)` — matches the cache lookup key. */
  questionHash: string;
}

/**
 * Normalizes the raw AI result into the wire shape. Handles both the structured
 * `CompanionResult` and a plain-string fallback (schema-less provider reply),
 * plus a nullish result (no answer field) via the pre-existing default text.
 */
export function normalizeCompanionResult(
  result: string | CompanionResult | null | undefined,
): CompanionAnswerPayload {
  const answer =
    typeof result === "string"
      ? result
      : (result?.answer ?? "I couldn't find an answer based on the current story context.");
  const sources = typeof result === "string" ? [] : (result?.sources ?? []);
  const suggestedFollowUps = typeof result === "string" ? [] : (result?.suggestedFollowUps ?? []);
  return { answer, sources, suggestedFollowUps };
}

/**
 * Charges `COMPANION_ASK` in a SHORT, dedicated transaction and returns the
 * charge's `correlationId` for a possible later refund. See the module header
 * for why the charge is deliberately NOT wrapped around the LLM call.
 *
 * Throws the usual credit errors (insufficient credits, fraud flag) — callers
 * let those propagate so the pre-existing 402 / error-event handling applies.
 *
 * @param chargeContext - Transaction context for analytics (e.g.
 *   `companion_ask`, `companion_ask_stream`).
 */
export async function chargeCompanionAsk(
  userId: string,
  chargeContext: string,
  metadata: { bookId: string; pageId: string; question: string },
): Promise<string> {
  const { correlationId } = await executeWithCredits(
    userId,
    "COMPANION_ASK",
    async () => null,
    { context: chargeContext, metadata },
  );
  return correlationId;
}

/**
 * Refunds a committed `COMPANION_ASK` charge after the generation that it paid
 * for failed. Best-effort by design: NEVER throws — a refund failure must not
 * mask the original stream error, so it logs loudly (correlationId included)
 * for manual reconciliation instead.
 *
 * @param chargeContext - The context originally passed to
 *   {@link chargeCompanionAsk}; the refund is recorded under
 *   `${chargeContext}_failed` so the idempotency lookup can never mistake the
 *   charge row for a prior refund.
 */
export async function refundCompanionAsk(
  userId: string,
  correlationId: string,
  chargeContext: string,
): Promise<void> {
  try {
    await refundCredits(userId, "COMPANION_ASK", {
      correlationId,
      context: `${chargeContext}_failed`,
      metadata: { chargeContext },
    });
    console.log(`[companion] 💰 Refunded failed ${chargeContext} charge (user ${userId}, ${correlationId})`);
  } catch (refundError) {
    console.error(`[companion] ❌ REFUND FAILED — manual review required:`, {
      userId,
      correlationId,
      chargeContext,
      error: getErrorMessage(refundError),
    });
  }
}

/**
 * Persists a freshly generated turn to `companion_answers` and invalidates the
 * page's suggestion caches so the new question joins the suggestion pool.
 *
 * Failures are logged, never thrown — a cache/history miss must not fail the
 * answer the reader already received (pre-existing best-effort semantics).
 */
export async function persistCompanionTurn(
  turn: CompanionTurnCoordinates,
  payload: CompanionAnswerPayload,
  logPrefix: string,
): Promise<void> {
  try {
    await dbWrite.insert(companionAnswers).values({
      sessionId: turn.sessionId,
      userId: turn.userId,
      bookId: turn.bookId,
      pageId: turn.pageId,
      question: turn.question,
      answer: payload.answer,
      sources: payload.sources,
      suggestedFollowUps: payload.suggestedFollowUps,
      questionHash: turn.questionHash,
      costCredits: getCreditCostForUser(turn.userId, "COMPANION_ASK"),
    }).onConflictDoNothing();

    await invalidateSuggestionsCache(turn.bookId, turn.pageId);
  } catch (insertError) {
    console.warn(`${logPrefix} ⚠️ Failed to cache companion answer:`, insertError);
  }
}

/**
 * Cache-hit bookkeeping shared by both ask routes: charges `COMPANION_ASK`
 * (short transaction — the payload is served immediately after, so no refund
 * path exists here) and, when the cached row belongs to ANOTHER user or
 * session, inserts a row under the active reader's `(userId, sessionId)` so the
 * hit appears in their personal history drawer (`onConflictDoNothing`).
 */
export async function recordCompanionCacheHit(
  turn: CompanionTurnCoordinates,
  cached: CompanionCacheHitRow,
  chargeContext: string,
): Promise<void> {
  await executeWithCredits(
    turn.userId,
    "COMPANION_ASK",
    async () => cached,
    {
      context: chargeContext,
      metadata: {
        bookId: turn.bookId,
        pageId: turn.pageId,
        question: turn.question.slice(0, 100),
      },
    },
  );

  if (cached.userId !== turn.userId || cached.sessionId !== turn.sessionId) {
    try {
      await dbWrite.insert(companionAnswers).values({
        sessionId: turn.sessionId,
        userId: turn.userId,
        bookId: turn.bookId,
        pageId: turn.pageId,
        question: turn.question,
        answer: cached.answer,
        sources: cached.sources,
        suggestedFollowUps: cached.suggestedFollowUps,
        questionHash: turn.questionHash,
        costCredits: getCreditCostForUser(turn.userId, "COMPANION_ASK"),
      }).onConflictDoNothing();
    } catch {
      // Ignore conflict — the row already exists for this user/session.
    }
  }
}
