/**
 * Subscription Service Module
 *
 * Handles subscription lifecycle, credit allocation, and tier management.
 * This service manages VIP subscriptions including:
 * - Creating new subscriptions and allocating initial credits
 * - Processing monthly renewals and adding recurring credits
 * - Handling subscription cancellations and scheduling tier downgrades
 * - Checking user VIP status and expiration
 * - Downgrading expired VIP users to standard tier
 *
 * Stripe Integration:
 * Subscription lifecycle is driven by Stripe webhooks:
 * - `customer.subscription.created` → createSubscription()
 * - `invoice.payment_succeeded` → renewSubscription()
 * - `customer.subscription.deleted` → cancelSubscription()
 *
 * Credit Allocation:
 * Credits are allocated atomically within database transactions:
 * - Activation: +50 credits on subscription creation
 * - Renewal: +50 credits on each monthly payment
 * - All allocations create both transaction and subscription_transaction records
 */

import { dbWrite, dbRead } from "../db/client.js";
import { subscriptions, subscriptionTransactions, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { addCredits } from "./credits.js";
import { VIP_BENEFITS } from "../config/subscription.js";
import type { SubscriptionStatus } from "../types/subscription.js";

/**
 * Creates a new subscription record and allocates initial credits
 *
 * Called when a user subscribes to VIP via Stripe checkout.
 * This function runs within a database transaction to ensure atomicity.
 *
 * @param params - Subscription creation parameters
 * @param params.userId - User ID who is subscribing
 * @param params.stripeSubscriptionId - Stripe subscription ID
 * @param params.stripeCustomerId - Stripe customer ID
 * @param params.stripePriceId - Stripe price ID for the subscription
 * @param params.currentPeriodStart - Start of current billing period
 * @param params.currentPeriodEnd - End of current billing period
 *
 * @example
 * ```typescript
 * await createSubscription({
 *   userId: 'user-123',
 *   stripeSubscriptionId: 'sub_1234567890',
 *   stripeCustomerId: 'cus_1234567890',
 *   stripePriceId: 'price_1234567890',
 *   currentPeriodStart: new Date('2023-01-01'),
 *   currentPeriodEnd: new Date('2023-02-01'),
 * });
 * ```
 */
export async function createSubscription(params: {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Create subscription record
    const [subscription] = await tx.insert(subscriptions).values({
      userId: params.userId,
      stripeSubscriptionId: params.stripeSubscriptionId,
      stripeCustomerId: params.stripeCustomerId,
      stripePriceId: params.stripePriceId,
      status: 'active',
      currentPeriodStart: params.currentPeriodStart,
      currentPeriodEnd: params.currentPeriodEnd,
    }).returning();

    if (!subscription) {
      throw new Error('Failed to create subscription record');
    }

    // Set user tier to VIP
    await tx.update(users)
      .set({
        tier: 'vip',
        subscriptionId: subscription.id,
        vipExpiresAt: params.currentPeriodEnd,
      })
      .where(eq(users.userId, params.userId));

    // Allocate initial monthly credits — passes `tx` so credits are part of the
    // same atomic operation. addCredits now correctly honours the provided tx.
    await addCredits(params.userId, VIP_BENEFITS.monthlyCredits, {
      context: "subscription_activation",
      metadata: { subscriptionId: subscription.id },
      tx
    });

    // Create subscription transaction record
    await tx.insert(subscriptionTransactions).values({
      subscriptionId: subscription.id,
      userId: params.userId,
      type: 'activation',
      creditsAllocated: VIP_BENEFITS.monthlyCredits,
    });
  });
}

/**
 * Updates subscription status (and optionally period/cancelAtPeriodEnd).
 *
 * Called when subscription details change (e.g., plan change, cancellation scheduled,
 * or payment failure — in which case only `status` needs updating).
 *
 * @param params - Subscription update parameters
 * @param params.stripeSubscriptionId - Stripe subscription ID
 * @param params.status - New subscription status
 * @param params.currentPeriodEnd - End of current billing period (optional — omit when
 *   only the status is changing, e.g. marking as past_due)
 * @param params.cancelAtPeriodEnd - Whether to cancel at period end
 *
 * @example
 * ```typescript
 * // Update status and period after a plan change
 * await updateSubscription({
 *   stripeSubscriptionId: 'sub_1234567890',
 *   status: 'active',
 *   currentPeriodEnd: new Date('2023-03-01'),
 *   cancelAtPeriodEnd: true,
 * });
 *
 * // Only update status (e.g., payment_failed → past_due)
 * await updateSubscription({
 *   stripeSubscriptionId: 'sub_1234567890',
 *   status: 'past_due',
 * });
 * ```
 */
export async function updateSubscription(params: {
  stripeSubscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodEnd?: Date; // Omit when only status is being updated
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  await dbWrite
    .update(subscriptions)
    .set({
      status: params.status,
      // Conditionally include fields that were actually provided
      ...(params.currentPeriodEnd !== undefined && { currentPeriodEnd: params.currentPeriodEnd }),
      ...(params.cancelAtPeriodEnd !== undefined && { cancelAtPeriodEnd: params.cancelAtPeriodEnd }),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId));
}

/**
 * Handles subscription renewal - allocates monthly credits
 *
 * Called when a monthly payment succeeds via Stripe webhook.
 * Allocates recurring credits and updates subscription period.
 *
 * @param params - Subscription renewal parameters
 * @param params.stripeSubscriptionId - Stripe subscription ID
 * @param params.stripeInvoiceId - Stripe invoice ID for the payment
 * @param params.currentPeriodEnd - End of new billing period (from Stripe invoice, not DB)
 *
 * @example
 * ```typescript
 * await renewSubscription({
 *   stripeSubscriptionId: 'sub_1234567890',
 *   stripeInvoiceId: 'in_1234567890',
 *   currentPeriodEnd: new Date('2023-03-01'),
 * });
 * ```
 */
export async function renewSubscription(params: {
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
  currentPeriodEnd: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Get subscription
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId))
      .limit(1);

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Update subscription period
    await tx.update(subscriptions)
      .set({
        currentPeriodEnd: params.currentPeriodEnd,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));

    // Update user VIP expiration
    await tx.update(users)
      .set({ vipExpiresAt: params.currentPeriodEnd })
      .where(eq(users.userId, subscription.userId));

    // Allocate monthly credits atomically within this transaction
    await addCredits(subscription.userId, VIP_BENEFITS.monthlyCredits, {
      context: "subscription_renewal",
      metadata: { subscriptionId: subscription.id },
      tx
    });

    // Create subscription transaction record
    await tx.insert(subscriptionTransactions).values({
      subscriptionId: subscription.id,
      userId: subscription.userId,
      type: 'renewal',
      creditsAllocated: VIP_BENEFITS.monthlyCredits,
      stripeInvoiceId: params.stripeInvoiceId,
    });
  });
}

/**
 * Handles subscription cancellation - schedules tier downgrade
 *
 * Called when a subscription is canceled via Stripe webhook.
 * VIP benefits continue until the current billing period ends.
 * The cron job will handle the actual tier downgrade.
 *
 * @param params - Subscription cancellation parameters
 * @param params.stripeSubscriptionId - Stripe subscription ID
 * @param params.canceledAt - When the subscription was canceled
 *
 * @example
 * ```typescript
 * await cancelSubscription({
 *   stripeSubscriptionId: 'sub_1234567890',
 *   canceledAt: new Date('2023-01-15'),
 * });
 * ```
 */
export async function cancelSubscription(params: {
  stripeSubscriptionId: string;
  canceledAt: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Get subscription
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId))
      .limit(1);

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Update subscription status
    await tx.update(subscriptions)
      .set({
        status: 'canceled',
        canceledAt: params.canceledAt,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));

    // Note: User tier remains 'vip' until currentPeriodEnd
    // This will be handled by the cron job
  });
}

/**
 * Checks if user has active VIP subscription
 *
 * A user has active VIP if:
 * - Their tier is 'vip'
 * - Their vipExpiresAt is in the future
 *
 * @param userId - User ID to check
 * @returns true if user has active VIP subscription, false otherwise
 *
 * @example
 * ```typescript
 * const isActive = await hasActiveVipSubscription('user-123');
 * if (isActive) {
 *   // User has VIP benefits
 * }
 * ```
 */
export async function hasActiveVipSubscription(userId: string): Promise<boolean> {
  const user = await dbRead
    .select({ tier: users.tier, vipExpiresAt: users.vipExpiresAt })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (user.length === 0) return false;

  const userData = user[0];

  // Check if user is VIP and subscription hasn't expired
  if (userData.tier !== 'vip') return false;
  if (!userData.vipExpiresAt) return false;

  return new Date(userData.vipExpiresAt) > new Date();
}

/**
 * Downgrades user from VIP to standard (called by cron job)
 *
 * Removes VIP status and clears subscription reference.
 * Called when a VIP subscription has expired.
 *
 * @param userId - User ID to downgrade
 *
 * @example
 * ```typescript
 * await downgradeUserFromVip('user-123');
 * ```
 */
export async function downgradeUserFromVip(userId: string): Promise<void> {
  await dbWrite.update(users)
    .set({
      tier: 'standard',
      vipExpiresAt: null,
      subscriptionId: null,
    })
    .where(eq(users.userId, userId));
}
