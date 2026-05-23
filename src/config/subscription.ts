import type { SubscriptionConfig } from "../types/subscription.js";

/**
 * VIP Subscription Configuration
 * @overview Configuration for VIP monthly subscription
 * 
 * Defines the VIP subscription plan with recurring benefits.
 * Users with active VIP subscriptions receive:
 * - VIP badge on profile
 * - 2x daily check-in bonus (separate claim button)
 * - +50 monthly credits automatically added
 */
export const VIP_SUBSCRIPTION: SubscriptionConfig = {
  id: "vip_monthly",
  name: "Twistloom VIP",
  description: "Monthly VIP membership with exclusive benefits",
  priceUSD: 9.99,
  priceId: process.env.STRIPE_VIP_PRICE_ID || "",
  productId: process.env.STRIPE_VIP_PRODUCT_ID || "",
  monthlyCredits: 50,
  checkInMultiplier: 2,
};

/**
 * VIP Benefits Configuration
 * @overview Environment-based configuration for VIP benefits
 * 
 * These values can be overridden via environment variables for flexibility.
 */
export const VIP_BENEFITS = {
  monthlyCredits: parseInt(process.env.VIP_MONTHLY_CREDITS || "50"),
  checkInMultiplier: parseInt(process.env.VIP_CHECKIN_MULTIPLIER || "2"),
} as const;