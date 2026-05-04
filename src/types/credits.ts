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
  /** Whether to highlight this pack as recommended */
  highlight: boolean;
  /** Optional badge text (e.g., "Most Popular") */
  badge: string | null;
  /** Approximate number of choices/uses */
  valueTag: string;
  /** Color theme for UI display */
  color: "gray" | "blue" | "purple" | "green" | "yellow" | "red";
}

/**
 * Transaction type for credit operations
 * - purchase: User buys credits (amountUsd is set)
 * - usage: User consumes or receives credits (amountUsd is null)
 * - refund: Credits refunded to user (amountUsd is set)
 * - reward: Free credits awarded (daily check-in, promotions)
 */
export type TransactionType = "purchase" | "usage" | "refund" | "reward";