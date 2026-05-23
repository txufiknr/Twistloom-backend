/**
 * Subscription status for VIP subscriptions
 */
export type SubscriptionStatus = 
  | 'active' 
  | 'past_due' 
  | 'canceled' 
  | 'unpaid' 
  | 'trialing';

/**
 * Subscription transaction type for tracking subscription-related credit allocations
 */
export type SubscriptionTransactionType = 
  | 'activation' 
  | 'renewal' 
  | 'cancellation';

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