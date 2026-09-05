import type { SubscriptionConfig } from "../types/subscription.js";
import { VIP_MONTHLY_CREDITS } from "./credits.js";

export const STRIPE_MONTHLY_PRICE_USD = 9.99;
export const XENDIT_MONTHLY_PRICE_IDR = 150000;

/**
 * VIP Subscription Configuration
 * @overview Configuration for VIP monthly subscription
 * 
 * Defines the VIP subscription plan with recurring benefits.
 * Users with active VIP subscriptions receive:
 * - VIP badge on profile
 * - 2x daily check-in bonus (separate claim button)
 * - +200 monthly credits automatically added
 */
export const VIP_SUBSCRIPTION: SubscriptionConfig = {
  id: "vip_monthly",
  name: "Twistloom VIP",
  description: "Monthly VIP membership with exclusive benefits",
  priceUSD: STRIPE_MONTHLY_PRICE_USD,
  priceId: process.env.STRIPE_VIP_PRICE_ID || "",
  productId: process.env.STRIPE_VIP_PRODUCT_ID || "",
  monthlyCredits: VIP_MONTHLY_CREDITS,
  checkInMultiplier: 2,
};

/**
 * VIP Benefits Configuration
 * @overview Environment-based configuration for VIP benefits
 * 
 * These values can be overridden via environment variables for flexibility.
 * `monthlyCredits` defaults to the exported `VIP_MONTHLY_CREDITS` const.
 */
export const VIP_BENEFITS = {
  monthlyCredits: parseInt(process.env.VIP_MONTHLY_CREDITS || String(VIP_MONTHLY_CREDITS)),
  checkInMultiplier: parseInt(process.env.VIP_CHECKIN_MULTIPLIER || "2"),
} as const;

/**
 * VIP Free Trial Configuration
 * @overview Configuration for the 1-month VIP free trial (LinkedIn-style)
 *
 * The trial model requires a card upfront (Stripe default for subscription-mode
 * Checkout sessions). Users get full VIP benefits immediately, then auto-convert
 * to paid at day 30 unless canceled.
 *
 * Gate the whole feature behind `VIP_TRIAL.enabled` so it can be killed instantly
 * via env var/config without a deploy if conversion or abuse numbers look wrong
 * post-launch.
 *
 * @see VIP_FREE_TRIAL_ROADMAP.md for full design rationale and rollout sequencing.
 */
export const VIP_TRIAL = {
  /** Master kill-switch — when false, all trial endpoints/handlers are unreachable */
  enabled: process.env.VIP_TRIAL_ENABLED === 'true',
  /** Trial duration in days. Stripe's trial_period_days uses day-count, not calendar months */
  trialPeriodDays: parseInt(process.env.VIP_TRIAL_PERIOD_DAYS || "30"),
  /**
   * Behavior when the trial ends without a valid payment method.
   * - 'cancel': Stripe cancels the subscription immediately. User keeps VIP until
   *   the next vip-expiration cron run downgrades them. Simpler for v1.
   * - 'pause': Stripe pauses the subscription, letting the user resume later by
   *   adding a card. Requires a 'paused' state in downgrade/notification logic.
   */
  endBehavior: (process.env.VIP_TRIAL_END_BEHAVIOR || "cancel") as 'cancel' | 'pause',
} as const;