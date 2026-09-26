import type { DBTransaction } from "../db/client.js";

export interface CreditPack {
  /** Unique identifier for the credit pack */
  id: string;
  /** Display title shown to users */
  title: string;
  /** Short tagline for marketing */
  tagline: string;
  /** Detailed description of what the pack offers */
  description: string;
  /** Number of credits included in this pack */
  credits: number;
  /** Price in USD */
  priceUSD: number;
  /** Stripe Price ID for checkout */
  priceId: string;
  /** Stripe Product ID for reference */
  productId: string;
  /** Optional badge text (e.g., "Most Popular") */
  badge: string | null;
  /** Color theme for UI display */
  color: "gray" | "blue" | "purple" | "green" | "yellow" | "red";
}

/**
 * Transaction type for credit operations
 * - purchase: User buys credits (amountCents is set)
 * - usage: User consumes or receives credits (amountCents is null)
 * - refund: Credits refunded to user (amountCents is set)
 * - reward: Free credits awarded (daily check-in, promotions)
 * - conversion: Wallet balance converted to credits (amountCents = IDR amount)
 * - first_purchase_bonus: One-time bonus for first-time purchasers (idempotent via row existence)
 * - reserve: Two-phase reservation hold (roadmap §3.1) — deducts the balance up
 *   front, then flips to `usage` when the generation settles, or to `usage` +
 *   a paired `refund` row when it is released / swept. Transient by design.
 */
export type TransactionType = "purchase" | "usage" | "refund" | "reward" | "conversion" | "first_purchase_bonus" | "reserve";

/**
 * Options shared by credit consumption, addition, and refund helpers.
 */
export interface ConsumeCreditsOptions {
  /** Human-readable context label recorded in the transaction row */
  context?: string;
  /** Arbitrary metadata persisted alongside the transaction record */
  metadata?: Record<string, unknown>;
  /** Existing DB transaction to join (ensures atomicity with the caller's work) */
  tx?: DBTransaction;
  /** Correlation ID linking a consumption record to its potential refund */
  correlationId?: string;
  /** Incoming request context — forwarded to `logUserActivity` for analytics */
  req?: { ip?: string | null; get?: (header: string) => string | undefined | null };
}

/**
 * Return value from `executeWithCredits`.
 *
 * The `correlationId` should be stored by the caller so it can be passed to
 * `refundCreditsIdempotent` / `refundCredits` if the work done after the
 * transaction needs to be rolled back manually.
 */
export interface ConsumeCreditsResult<T> {
  /** Return value of the user-supplied `operation` */
  result: T;
  /** Idempotency key for a subsequent `refundCredits` call */
  correlationId: string;
  /** Primary key of the consumption `transactions` row */
  transactionId: string;
}

/**
 * A two-phase credit reservation (reserve → generate → settle/release).
 *
 * Returned by `reserveCredits`. The balance was already deducted in a
 * millisecond-scale transaction; `transactionId` references the transient
 * `type: 'reserve'` row that `settleReservation` flips to `usage` (or that
 * `releaseReservation` / the leak sweeper converts to `usage` + a persisted
 * `refund` row).
 */
export interface CreditReservation {
  /** User whose balance was held */
  userId: string;
  /** Resolved cost held by this reservation (0 for free/demo actions) */
  cost: number;
  /** Idempotency key — a retry with the same id reuses this reservation */
  correlationId: string;
  /** PK of the `type: 'reserve'` transactions row; `null` when cost is 0 */
  transactionId: string | null;
  /** Caller context/metadata forwarded to settle/release bookkeeping */
  options: ConsumeCreditsOptions;
}