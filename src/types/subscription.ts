import type Stripe from 'stripe';

/**
 * Subscription transaction type for tracking subscription-related credit allocations
 */
export type SubscriptionTransactionType = 
  | 'activation' 
  | 'renewal' 
  | 'cancellation';

/**
 * Re-export Stripe's Subscription.Status for convenience
 * Use Stripe.Subscription.Status directly for type safety
 */
export type SubscriptionStatus = Stripe.Subscription.Status;

/**
 * Subscription configuration for VIP plans
 */
export interface SubscriptionConfig {
  /** Unique identifier for the subscription plan */
  id: string;
  /** Display name shown to users */
  name: string;
  /** Description of the subscription benefits */
  description: string;
  /** Monthly price in USD */
  priceUSD: number;
  /** Stripe Price ID for checkout */
  priceId: string;
  /** Stripe Product ID for reference */
  productId: string;
  /** Number of credits awarded monthly */
  monthlyCredits: number;
  /** Check-in bonus multiplier for VIP users */
  checkInMultiplier: number;
}