/**
 * Credit reservation leak sweeper (roadmap §3.1 step 4).
 *
 * Reservations are supposed to be settled (success) or released (failure)
 * within seconds. When the process crashes between `reserveCredits` and
 * settle/release, the `type='reserve'` row — and with it the author's
 * deducted credits — would leak forever. This sweeper refunds every reserve
 * row older than `CREDIT_RESERVATION_TTL_MS`.
 *
 * Idempotency: the guarded claim inside `claimAndRefundReservationTx`
 * (`UPDATE … WHERE type = 'reserve'`) makes double-refunds impossible even if
 * this job races a live release or overlaps a previous run — whoever flips
 * the row first issues the refund; everyone else no-ops.
 *
 * Run by `src/cron/sweep-credit-reservations.ts` (GitHub Actions, every
 * 10 minutes). Safe to run repeatedly and concurrently.
 */

import { dbWrite } from "../db/client.js";
import { transactions } from "../db/schema.js";
import { and, eq, lt, asc } from "drizzle-orm";
import { CREDIT_RESERVATION_TTL_MS, CREDIT_RESERVATION_SWEEP_LIMIT } from "../config/credits.js";
import { claimAndRefundReservationTx } from "./credits.js";

/** Result summary of one sweeper run. */
export interface CreditReservationSweepResult {
  /** Stale reserve rows found (oldest first, up to the batch limit) */
  scanned: number;
  /** Rows this run claimed and refunded */
  refunded: number;
  /** Rows already handled by a concurrent settle/release (idempotent no-op) */
  alreadyHandled: number;
  /** Rows whose refund transaction failed (retried on the next run) */
  failed: number;
}

/**
 * Refunds leaked `type='reserve'` credit reservations older than the TTL.
 *
 * @param options.ttlMs  - Override the reservation TTL (tests / manual runs)
 * @param options.limit  - Max rows to process this run (bounds batch size)
 * @returns Counts for logging / alerting
 */
export async function sweepExpiredCreditReservations(
  options: { ttlMs?: number; limit?: number } = {}
): Promise<CreditReservationSweepResult> {
  const ttlMs = options.ttlMs ?? CREDIT_RESERVATION_TTL_MS;
  const limit = options.limit ?? CREDIT_RESERVATION_SWEEP_LIMIT;
  const cutoff = new Date(Date.now() - ttlMs);

  const stale = await dbWrite
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.type, "reserve"), lt(transactions.createdAt, cutoff)))
    .orderBy(asc(transactions.createdAt))
    .limit(limit);

  const result: CreditReservationSweepResult = {
    scanned: stale.length,
    refunded: 0,
    alreadyHandled: 0,
    failed: 0,
  };

  for (const row of stale) {
    try {
      const claimed = await dbWrite.transaction((tx) =>
        claimAndRefundReservationTx(tx, row.id, "expired_reservation")
      );
      if (claimed) {
        result.refunded += 1;
        console.warn(`[sweepCreditReservations] ↩️ Refunded leaked reservation ${row.id}`);
      } else {
        result.alreadyHandled += 1;
      }
    } catch (error) {
      // Transient (connection/lock) — the next run retries it.
      result.failed += 1;
      console.error(`[sweepCreditReservations] ❌ Failed to refund reservation ${row.id}:`, error);
    }
  }

  return result;
}
