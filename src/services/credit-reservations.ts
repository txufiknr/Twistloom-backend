/**
 * Credit reservation leak sweeper (roadmap §3.1 step 4).
 *
 * Reservations are supposed to be settled (success) or released (failure)
 * within seconds. When the process crashes between `reserveCredits` and
 * settle/release, the `type='reserve'` row — and with it the author's
 * deducted credits — would leak forever. This module refunds every reserve
 * row older than `CREDIT_RESERVATION_TTL_MS`.
 *
 * Idempotency: the guarded claim inside `claimAndRefundReservationTx`
 * (`UPDATE … WHERE type = 'reserve'`) makes double-refunds impossible even if
 * a sweep races a live release or overlaps a previous run — whoever flips the
 * row first issues the refund; everyone else no-ops. Both triggers are safe to
 * run repeatedly and concurrently.
 *
 * Two deliberately redundant triggers:
 * 1. {@link sweepExpiredReservationsOpportunistically} — request path (before
 *    `reserveCredits` deducts), Redis-throttled to at most one run per
 *    `CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_INTERVAL_SECONDS`. Catches the
 *    crashed request's own user within minutes because that user retries.
 * 2. {@link runCreditReservationSweep} — Upstash QStash schedule →
 *    `POST /api/cron/sweep-credit-reservations` every 10 minutes. Safety net
 *    for users who never return, plus backlogs. See
 *    `docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md` §4.
 */

import { dbWrite } from "../db/client.js";
import { transactions } from "../db/schema.js";
import { and, eq, lt, asc } from "drizzle-orm";
import {
  CREDIT_RESERVATION_TTL_MS,
  CREDIT_RESERVATION_SWEEP_LIMIT,
  CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_LIMIT,
  CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_INTERVAL_SECONDS,
} from "../config/credits.js";
import { claimAndRefundReservationTx } from "./credits.js";
import { getRedisClient } from "../utils/redis.js";
import { getErrorMessage } from "../utils/error.js";

/** Redis key holding the last opportunistic-sweep timestamp (SET NX EX throttle). */
const OPPORTUNISTIC_SWEEP_THROTTLE_KEY = "credit-reservation-sweep:last-run";

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

/**
 * Scheduled sweeper body — invoked by the cron endpoint
 * (`POST|GET /api/cron/sweep-credit-reservations`, driven by an Upstash QStash
 * schedule) and by the manual CLI (`src/cron/sweep-credit-reservations.ts`).
 *
 * Logs a summary and returns the counts; it deliberately does **not** throw on
 * `failed > 0` so callers can decide the transport-level response (the HTTP
 * endpoint answers 500 so QStash retries; the CLI exits non-zero).
 *
 * @returns Per-run counts for logging / alerting
 */
export async function runCreditReservationSweep(): Promise<CreditReservationSweepResult> {
  const startedAt = Date.now();
  console.log("[sweep-credit-reservations] 🔍 Sweeping leaked credit reservations...");

  const result = await sweepExpiredCreditReservations();

  const durationMs = Date.now() - startedAt;
  console.log(`[sweep-credit-reservations] ✅ Sweep completed in ${durationMs}ms:`, {
    scanned: result.scanned,
    refunded: result.refunded,
    alreadyHandled: result.alreadyHandled,
    failed: result.failed,
  });

  return result;
}

/**
 * Opportunistic request-path sweep (roadmap §3.1 step 4, option 1).
 *
 * Called from `reserveCredits` **before** the deduction so a user's own leaked
 * reservation from a crashed run is restored to their balance before this very
 * charge is applied. Guarded by a Redis `SET NX EX` throttle so at most one
 * sweep runs per `CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_INTERVAL_SECONDS`
 * across all concurrent requests, and bounded to
 * `CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_LIMIT` rows.
 *
 * **Never throws and never blocks a charge**: an unavailable Redis or a failed
 * sweep is logged and swallowed (fail-open) — the scheduled sweeper
 * (`runCreditReservationSweep`) remains the safety net.
 */
export async function sweepExpiredReservationsOpportunistically(): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis) return; // Redis unconfigured — fall back to the scheduled sweeper only

    const won = await redis.set(
      OPPORTUNISTIC_SWEEP_THROTTLE_KEY,
      Date.now().toString(),
      { nx: true, ex: CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_INTERVAL_SECONDS }
    );
    if (won !== "OK") return; // another request swept within the throttle window

    const result = await sweepExpiredCreditReservations({
      limit: CREDIT_RESERVATION_OPPORTUNISTIC_SWEEP_LIMIT,
    });
    if (result.refunded > 0 || result.failed > 0) {
      console.warn(
        `[sweepExpiredReservationsOpportunistically] 🧹 Opportunistic sweep: refunded=${result.refunded} failed=${result.failed}`
      );
    }
  } catch (error) {
    // Fail-open: a sweep problem must never fail or delay the charge path.
    console.error(
      `[sweepExpiredReservationsOpportunistically] ❌ Sweep skipped (fail-open): ${getErrorMessage(error)}`
    );
  }
}
