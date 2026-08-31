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
 */
export type TransactionType = "purchase" | "usage" | "refund" | "reward" | "conversion";

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