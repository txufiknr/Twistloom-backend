import type Stripe from "stripe";
import type { PaymentGateway } from "./payment.js";

/**
 * Subscription transaction type for tracking subscription-related credit allocations
 */
export type SubscriptionTransactionType = 
  | 'activation' 
  | 'renewal' 
  | 'cancellation'
  | 'trial_started' // Trial-start credit allocation, kept distinct from 'activation' for analytics (conversion rate, credits-during-trial reporting)
  | 'trial_expired'; // Trial ended without converting — creditsAllocated is 0; metadata carries the credits-remaining snapshot. See VIP_FREE_TRIAL_ROADMAP.md Q4.

/**
 * Subscription status for VIP subscriptions
 * Matches Stripe's Subscription.Status type for type safety
 * Not using Stripe.Subscription.Status directly as TypeScript couldn't properly serialize for the build.
 */
export const subscriptionStatuses = [
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'trialing',
  'paused'
] satisfies Stripe.Subscription.Status[];

// export type SubscriptionStatus = typeof subscriptionStatuses[number];
// see node_modules\stripe\esm\resources\Subscriptions.d.ts (line 473)
export type SubscriptionStatus = typeof subscriptionStatuses[number] | string & Record<never, never>;

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
  /** Monthly price in USD (Stripe) */
  priceUSD: number;
  /** Monthly price in IDR (Xendit) — optional until Phase 2b */
  priceIdr?: number;
  /** Display currency for this plan config */
  currency?: "USD" | "IDR";
  /** Payment gateway this plan config targets */
  gateway?: PaymentGateway;
  /** Stripe Price ID for checkout (Stripe gateway) */
  priceId: string;
  /** Stripe Product ID for reference (Stripe gateway) */
  productId: string;
  /** Number of credits awarded monthly */
  monthlyCredits: number;
  /** Check-in bonus multiplier for VIP users */
  checkInMultiplier: number;
}