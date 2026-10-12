/**
 * @overview Story Reset eligibility & cost evaluation
 *
 * Single definition of "does this reader have anything to reset, and what does
 * it cost". Extracted from the route so the SAME rule can be evaluated twice:
 *
 * 1. **Pre-flight** on `dbRead` — a cheap fast-fail for "nothing to reset"
 *    before any lock or transaction is opened (unchanged UX).
 * 2. **Authoritatively** inside the `executeWithCredits` charge transaction,
 *    on `tx` (the write primary, user row locked). This is the decision that
 *    actually governs the charge.
 *
 * Why twice: the pre-flight reads the replica with no lock held, so replica lag
 * or a concurrent writer committing in between can make it wrong. Costing the
 * charge from that snapshot is how a reader gets billed twice for one reset.
 * Evaluating inside the transaction — after `executeWithCredits` has taken the
 * `users` row lock — reads state no concurrent credit operation can still be
 * mutating. See the `CreditCostResolver` contract in `types/credits.ts`.
 *
 * The evaluator must therefore always be given the client that matches the
 * call site's intent: `dbRead` for the pre-flight, `tx` for the authoritative
 * in-transaction pass.
 */

import { and, eq } from "drizzle-orm";
import type { DBClient } from "../db/client.js";
import { userCompletedBooks, userPageProgress, userSessions } from "../db/schema.js";
import { calculateBranchSwitchCost, getCreditCostForUser } from "../config/credits.js";
import type { BookMode } from "../types/book.js";

/**
 * The authoritative answer to "may this reader reset, and at what price?".
 */
export interface StoryResetEvaluation {
  /** The reader's session row, or null when none exists yet. */
  session: { status: string; frontierPageNumber: number } | null;
  /** True when a reset has something to discard (progress or a rewound frontier). */
  eligible: boolean;
  /** True when the reader already completed the book or closed the session (cost 0). */
  isFreeReplay: boolean;
  /** The session's frontier page number (1 when no session exists). */
  frontier: number;
  /** The authoritative credit cost of this reset. */
  cost: number;
}

/**
 * Thrown inside the charge transaction when the authoritative state says the
 * reset has already been applied — progress gone and the frontier back at 1.
 *
 * `executeWithCredits` rolls the transaction back, so nothing is deducted.
 * Routes should map this to **409 Conflict** (the operation the caller asked
 * for already happened), not 400 or 500.
 */
export class StoryResetAlreadyAppliedError extends Error {
  constructor(message = "This story has already been reset") {
    super(message);
    this.name = "StoryResetAlreadyAppliedError";
  }
}

/**
 * Evaluates reset eligibility and cost against the supplied database client.
 *
 * Eligibility rule (unchanged from the original route): a reset is worth doing
 * when the reader has an action-selection history to discard (`user_page_progress`)
 * OR their frontier has advanced past page 1. A reader sitting on page 1 with no
 * progress has nothing to reset.
 *
 * Cost rule (server-derived, never client-supplied):
 * - completed (`user_completed_books`) or `status = 'past'` → 0 (free replay)
 * - `novel` mode → flat `STORY_RESET` cost key (0 for the demo account)
 * - `interactive` / `multiverse` → distance formula from the frontier to page 1
 *
 * @param client   - `dbRead` for the pre-flight, `tx` for the in-transaction pass
 * @param userId   - The reader resetting the story
 * @param bookId   - The book being reset
 * @param bookMode - The book's mode (selects the cost formula)
 * @returns The evaluation: eligibility, free-replay flag, frontier, and cost
 */
export async function evaluateStoryReset(
  client: DBClient,
  userId: string,
  bookId: string,
  bookMode: BookMode,
): Promise<StoryResetEvaluation> {
  const [session] = await client
    .select({
      status: userSessions.status,
      frontierPageNumber: userSessions.frontierPageNumber,
    })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), eq(userSessions.bookId, bookId)))
    .limit(1);

  const [progressRow] = await client
    .select({ id: userPageProgress.id })
    .from(userPageProgress)
    .where(and(eq(userPageProgress.userId, userId), eq(userPageProgress.bookId, bookId)))
    .limit(1);

  const frontier = session?.frontierPageNumber ?? 1;
  const eligible = Boolean(progressRow) || frontier > 1;

  // Free replay is server-derived — a client cannot claim it.
  const [completedRow] = await client
    .select({ id: userCompletedBooks.id })
    .from(userCompletedBooks)
    .where(and(eq(userCompletedBooks.userId, userId), eq(userCompletedBooks.bookId, bookId)))
    .limit(1);
  const isFreeReplay = session?.status === "past" || Boolean(completedRow);

  const cost = isFreeReplay
    ? 0
    : bookMode === "novel"
      ? getCreditCostForUser(userId, "STORY_RESET")
      : calculateBranchSwitchCost(frontier, 1, userId);

  return {
    session: session
      ? { status: session.status, frontierPageNumber: session.frontierPageNumber ?? 1 }
      : null,
    eligible,
    isFreeReplay,
    frontier,
    cost,
  };
}
