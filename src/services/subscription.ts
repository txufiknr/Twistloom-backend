/**
 * Subscription Service Module
 *
 * Handles subscription lifecycle, credit allocation, and tier management.
 * This service manages VIP subscriptions including:
 * - Creating new subscriptions (trial or immediate-paid) and allocating initial credits
 * - Processing monthly renewals and adding recurring credits
 * - Handling subscription cancellations and scheduling tier downgrades
 * - Checking user VIP status and expiration
 * - Downgrading expired VIP users to standard tier
 *
 * Gateway Integration:
 * Subscription lifecycle is driven by payment-gateway webhooks (Stripe today;
 * Xendit later). Both map into the same gateway-agnostic params:
 * - subscription created → createSubscription() (status may be 'trialing' or 'active')
 * - invoice/cycle payment succeeded (renewal only) → renewSubscription()
 * - subscription updated → updateSubscription()
 * - subscription deleted → cancelSubscription()
 *
 * Credit Allocation:
 * Credits are allocated atomically within database transactions, once per billing period:
 * - Trial start / Activation: +monthlyCredits on subscription creation (whether trial or paid)
 * - Renewal: +monthlyCredits on each subsequent 'subscription_cycle' invoice payment
 * - All allocations create both a `transactions` and a `subscriptionTransactions` record
 *
 * See VIP_FREE_TRIAL_ROADMAP.md for the reasoning behind the billing_reason filter in
 * handleInvoicePaymentSucceeded — without it, every new subscription (trial or not) was
 * credited twice on day one, since invoice.payment_succeeded fires for the first invoice
 * too, not just genuine renewals.
 */

import { dbWrite, dbRead } from "../db/client.js";
import { subscriptions, subscriptionTransactions, users, userNotifications } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { addCredits } from "./credits.js";
import { VIP_BENEFITS, VIP_TRIAL } from "../config/subscription.js";
import type { SubscriptionStatus } from "../types/subscription.js";
import { PAYMENT_GATEWAY, type PaymentGateway } from "../types/payment.js";

export type { PaymentGateway };

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * `subscriptions.(gateway, providerSubscriptionId)` and
 * `subscriptionTransactions.(gateway, providerInvoiceId)` are unique-constrained
 * specifically so that a redelivered webhook can't double-allocate credits. Without
 * catching this specific error, a redelivery would throw, mark the webhook 'failed',
 * and the provider would keep retrying an event that was already processed successfully.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Creates a new subscription record and allocates initial credits
 *
 * Called when a user subscribes to VIP via a payment-gateway checkout.
 * This function runs within a database transaction to ensure atomicity.
 *
 * @param params - Gateway-agnostic subscription creation parameters
 *
 * @example
 * ```typescript
 * await createSubscription({
 *   userId: 'user-123',
 *   gateway: 'stripe',
 *   providerSubscriptionId: 'sub_1234567890',
 *   providerCustomerId: 'cus_1234567890',
 *   providerPriceId: 'price_1234567890',
 *   currentPeriodStart: new Date('2023-01-01'),
 *   currentPeriodEnd: new Date('2023-02-01'),
 * });
 * ```
 */
export async function createSubscription(params: {
  userId: string;
  gateway?: PaymentGateway;
  /** Gateway subscription/plan ID (Stripe `sub_xxx`, Xendit plan ID) */
  providerSubscriptionId: string;
  /** Gateway customer ID (Stripe `cus_xxx`, Xendit customer ID) */
  providerCustomerId: string;
  /** Gateway price/plan ID */
  providerPriceId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  /** True when this subscription was created with a trial (status will be 'trialing') */
  isTrial?: boolean;
  /** Trial end date — required when isTrial is true. See VIP_FREE_TRIAL_ROADMAP.md */
  trialEnd?: Date | null;
  /** Gateway webhook event ID for idempotency tracking */
  providerEventId?: string;
}): Promise<void> {
  const isTrial = params.isTrial ?? false;
  const gateway = params.gateway ?? PAYMENT_GATEWAY.stripe;

  try {
    await dbWrite.transaction(async (tx) => {
      // Create subscription record
      const [subscription] = await tx.insert(subscriptions).values({
        userId: params.userId,
        gateway,
        providerSubscriptionId: params.providerSubscriptionId,
        providerCustomerId: params.providerCustomerId,
        providerPriceId: params.providerPriceId,
        status: isTrial ? 'trialing' : 'active',
        currentPeriodStart: params.currentPeriodStart,
        currentPeriodEnd: params.currentPeriodEnd,
        isTrial,
        trialEnd: isTrial ? (params.trialEnd ?? null) : null,
      }).returning();

      if (!subscription) {
        throw new Error('Failed to create subscription record');
      }

      // Set user tier to VIP.
      // For a trial, vipExpiresAt tracks the trial end (not currentPeriodEnd — Stripe sets
      // the period to span the whole trial, but we want vip-expiration.ts to correctly
      // downgrade a trial that ends without converting, at the same point Stripe itself
      // would cancel/pause it).
      await tx.update(users)
        .set({
          tier: 'vip',
          subscriptionId: subscription.id,
          vipExpiresAt: isTrial ? (params.trialEnd ?? params.currentPeriodEnd) : params.currentPeriodEnd,
          // Set once, permanently — this is what enforces one-trial-per-user regardless
          // of what later happens to this subscription (cancel, refund, deletion).
          ...(isTrial ? { vipTrialUsedAt: new Date() } : {}),
        })
        .where(eq(users.userId, params.userId));

      // Allocate initial credits — passes `tx` so credits are part of the
      // same atomic operation. addCredits now correctly honours the provided tx.
      await addCredits(params.userId, VIP_BENEFITS.monthlyCredits, {
        context: isTrial ? "vip_trial_started" : "subscription_activation",
        metadata: { subscriptionId: subscription.id, isTrial },
        tx
      });

      // Create subscription transaction record
      await tx.insert(subscriptionTransactions).values({
        subscriptionId: subscription.id,
        userId: params.userId,
        type: isTrial ? 'trial_started' : 'activation',
        creditsAllocated: VIP_BENEFITS.monthlyCredits,
        gateway,
        providerEventId: params.providerEventId ?? null,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // providerSubscriptionId already exists for this gateway — redelivered
      // subscription-created webhook for a subscription we already activated.
      console.log(`[subscription] 🔄 Duplicate createSubscription for ${params.providerSubscriptionId} — already activated, skipping.`);
      return;
    }
    throw error;
  }
}

/**
 * Updates subscription status (and optionally period/cancelAtPeriodEnd).
 *
 * Called when subscription details change (e.g., plan change, cancellation scheduled,
 * or payment failure — in which case only `status` needs updating).
 *
 * @param params - Subscription update parameters
 *
 * @example
 * ```typescript
 * await updateSubscription({
 *   providerSubscriptionId: 'sub_1234567890',
 *   status: 'active',
 *   currentPeriodEnd: new Date('2023-03-01'),
 *   cancelAtPeriodEnd: true,
 * });
 * ```
 */
export async function updateSubscription(params: {
  providerSubscriptionId: string;
  gateway?: PaymentGateway;
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
      // A status leaving 'trialing' means the trial converted (→ active) or ended some
      // other way (→ canceled/paused). Either way it's no longer "in trial" going forward.
      ...(params.status !== 'trialing' && { isTrial: false }),
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.providerSubscriptionId, params.providerSubscriptionId));
}

/**
 * Handles subscription renewal - allocates monthly credits
 *
 * Called when a monthly payment succeeds via payment-gateway webhook.
 * Allocates recurring credits and updates subscription period.
 *
 * @param params - Subscription renewal parameters
 *
 * @example
 * ```typescript
 * await renewSubscription({
 *   providerSubscriptionId: 'sub_1234567890',
 *   providerInvoiceId: 'in_1234567890',
 *   currentPeriodEnd: new Date('2023-03-01'),
 * });
 * ```
 */
export async function renewSubscription(params: {
  providerSubscriptionId: string;
  providerInvoiceId: string;
  currentPeriodEnd: Date;
  gateway?: PaymentGateway;
  providerEventId?: string;
}): Promise<void> {
  const gateway = params.gateway ?? PAYMENT_GATEWAY.stripe;

  try {
    await dbWrite.transaction(async (tx) => {
      // Get subscription
      const [subscription] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.providerSubscriptionId, params.providerSubscriptionId))
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

      // Create subscription transaction record. providerInvoiceId is unique per gateway,
      // so if this same invoice was already processed (redelivered webhook), the insert
      // below throws and the whole transaction — including the addCredits call above —
      // rolls back atomically. No double-crediting risk from a bare retry.
      await tx.insert(subscriptionTransactions).values({
        subscriptionId: subscription.id,
        userId: subscription.userId,
        type: 'renewal',
        creditsAllocated: VIP_BENEFITS.monthlyCredits,
        gateway,
        providerInvoiceId: params.providerInvoiceId,
        providerEventId: params.providerEventId ?? null,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // This invoice was already processed on a prior delivery of this webhook.
      // The transaction rolled back in full (including the credit allocation
      // above), so it's safe to just treat this as already-handled.
      console.log(`[subscription] 🔄 Duplicate renewSubscription for invoice ${params.providerInvoiceId} — already processed, skipping.`);
      return;
    }
    throw error;
  }
}

/**
 * Handles subscription cancellation - schedules tier downgrade
 *
 * Called when a subscription is canceled via payment-gateway webhook.
 * VIP benefits continue until the current billing period ends.
 * The cron job will handle the actual tier downgrade.
 *
 * Trial-specific behavior (see VIP_FREE_TRIAL_ROADMAP.md Q4): if this subscription
 * never converted to paid, records a `trial_expired` subscriptionTransactions row
 * snapshotting the user's credit balance at that moment. Decision was explicitly
 * NOT to claw back unused trial credits — the abuse surface is already bounded by
 * the permanent one-trial-per-user lockout, and clawback would only ever recover
 * partially-spent balances anyway. This snapshot exists purely so that decision
 * can be revisited later with real data instead of a guess, at zero cost to the
 * user experience.
 *
 * IMPORTANT: this checks subscriptionTransactions history (has a 'trial_started'
 * row, has no 'renewal' row), NOT the subscription's `isTrial` flag. For a trial
 * cancelled via `missing_payment_method: 'cancel'`, Stripe fires
 * customer.subscription.updated (trialing → canceled) before .deleted — by the
 * time this function runs, updateSubscription() has typically already cleared
 * isTrial to false on the status transition out of 'trialing', so isTrial can't
 * be trusted here. Transaction history is immutable and gives the right answer
 * regardless of event ordering.
 *
 * @param params - Subscription cancellation parameters
 *
 * @example
 * ```typescript
 * await cancelSubscription({
 *   providerSubscriptionId: 'sub_1234567890',
 *   canceledAt: new Date('2023-01-15'),
 * });
 * ```
 */
export async function cancelSubscription(params: {
  providerSubscriptionId: string;
  canceledAt: Date;
  gateway?: PaymentGateway;
  providerEventId?: string;
}): Promise<void> {
  const gateway = params.gateway ?? PAYMENT_GATEWAY.stripe;

  await dbWrite.transaction(async (tx) => {
    // Get subscription
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubscriptionId, params.providerSubscriptionId))
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

    // Trial-expired analytics snapshot (Q4) — see docstring above for why this
    // reads transaction history rather than the isTrial flag.
    const priorTransactions = await tx
      .select({ type: subscriptionTransactions.type })
      .from(subscriptionTransactions)
      .where(eq(subscriptionTransactions.subscriptionId, subscription.id));

    const wasTrial = priorTransactions.some((t) => t.type === 'trial_started');
    const everConverted = priorTransactions.some((t) => t.type === 'renewal');
    const alreadyLogged = priorTransactions.some((t) => t.type === 'trial_expired');

    if (wasTrial && !everConverted && !alreadyLogged) {
      const [user] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.userId, subscription.userId))
        .limit(1);

      await tx.insert(subscriptionTransactions).values({
        subscriptionId: subscription.id,
        userId: subscription.userId,
        type: 'trial_expired',
        creditsAllocated: 0,
        gateway,
        providerEventId: params.providerEventId ?? null,
        metadata: {
          creditsRemainingAtCancellation: user?.credits ?? null,
          trialEnd: subscription.trialEnd,
        },
      });

      console.log(`[subscription] 📊 Trial expired without converting for user ${subscription.userId} — ${user?.credits ?? 'unknown'} credits remaining`);
    }
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

/**
 * Checks whether a user is eligible to start a VIP free trial.
 *
 * A user is eligible if:
 * 1. They have never used a trial before (vipTrialUsedAt IS NULL)
 * 2. They do not already have an active VIP subscription
 *
 * This is the primary gate that enforces one-trial-per-user. The flag lives on
 * `users` rather than on the subscription because eligibility must survive
 * subscription deletion/cleanup/GDPR flows against the subscription record.
 *
 * Defense in depth: this check runs both at the eligibility endpoint (UX
 * convenience) AND at checkout-session creation (security boundary). A client
 * that bypasses the frontend gate will still be caught server-side.
 *
 * @param userId - The user to check eligibility for
 * @returns true if the user can start a new trial
 *
 * @see VIP_FREE_TRIAL_ROADMAP.md §4.2
 */
export async function isTrialEligible(userId: string): Promise<boolean> {
  if (!VIP_TRIAL.enabled) return false;

  // Check 1: Never used a trial before (most common reject reason — fast path)
  const [user] = await dbRead
    .select({ vipTrialUsedAt: users.vipTrialUsedAt })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!user) return false;
  if (user.vipTrialUsedAt) return false;

  // Check 2: No active VIP subscription (trial or paid)
  const hasActive = await hasActiveVipSubscription(userId);
  if (hasActive) return false;

  return true;
}

/**
 * Handles customer.subscription.trial_will_end webhook event.
 *
 * Stripe fires this event ~3 days before the trial ends (configurable in the
 * Stripe Dashboard). This creates a user notification reminding them to ensure
 * their payment method is up to date so the trial converts successfully, and
 * sends a branded reminder email via Resend (see VIP_FREE_TRIAL_ROADMAP.md Q5).
 *
 * Stripe's own email for this event ("Manage free trial messaging" in Dashboard)
 * is a zero-code safety net that stays on regardless — this is the branded,
 * in-app-consistent complement, since a generic Stripe-branded email is easy for
 * a user to not recognize as being from Twistloom specifically.
 *
 * The email send is deliberately non-blocking: a Resend outage or bad address
 * must not prevent the in-app notification from being created, and must not
 * fail the webhook (which would make Stripe retry an event that was otherwise
 * handled correctly).
 *
 * @param providerSubscriptionId - The gateway subscription ID that's ending its trial
 *
 * @see VIP_FREE_TRIAL_ROADMAP.md §4.4b, Q5
 */
export async function handleTrialWillEnd(providerSubscriptionId: string): Promise<void> {
  const [row] = await dbRead
    .select({
      subscriptionId: subscriptions.id,
      userId: subscriptions.userId,
      trialEnd: subscriptions.trialEnd,
      email: users.email,
      name: users.name,
    })
    .from(subscriptions)
    .innerJoin(users, eq(subscriptions.userId, users.userId))
    .where(eq(subscriptions.providerSubscriptionId, providerSubscriptionId))
    .limit(1);

  if (!row) {
    console.log(`[subscription] ⚠️ trial_will_end for unknown subscription ${providerSubscriptionId} — skipping`);
    return;
  }

  await dbWrite.insert(userNotifications).values({
    userId: row.userId,
    type: 'trial_ending_soon',
    title: 'Your VIP trial ends soon',
    message: 'Your free trial ends in 3 days. Make sure your payment method is up to date to keep your VIP benefits.',
    data: { trialEnd: row.trialEnd },
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log(`[subscription] 🔔 Sent trial-ending-soon notification for user ${row.userId}`);

  // Non-blocking: in-app notification already succeeded; Stripe email is a fallback.
  if (row.trialEnd && row.email) {
    const { sendTrialEndingEmail, sendEmailSafe } = await import("../utils/email.js");
    sendEmailSafe(`trial_will_end user=${row.userId}`, () =>
      sendTrialEndingEmail(row.email, row.name || "there", row.trialEnd!),
    );
  }
}
