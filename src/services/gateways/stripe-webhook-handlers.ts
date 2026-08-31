/**
 * Stripe webhook event handlers.
 *
 * Extracted from `routes/payments.ts` to isolate Stripe-specific webhook
 * business logic from the gateway-agnostic route layer.
 *
 * Each handler processes a specific Stripe event type and delegates to the
 * shared subscription/credit services.
 */

import type Stripe from "stripe";
import { eq, and, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications, subscriptions } from "../../db/schema.js";
import { CREDIT_PACKS, FIRST_PURCHASE_BONUS } from "../../config/credits.js";
import { PAYMENT_GATEWAY } from "../../types/payment.js";
import { createSubscription, updateSubscription, renewSubscription, cancelSubscription, handleTrialWillEnd } from "../subscription.js";
import { awardCredits } from "../credits.js";

// ── Extended Types (Stripe SDK gaps) ────────────────────────────────────────

interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  current_period_start: number;
  current_period_end: number;
}

interface StripeInvoiceWithSubscription extends Stripe.Invoice {
  subscription?: string | Stripe.Subscription;
}

function isSubscriptionWithPeriods(obj: unknown): obj is StripeSubscriptionWithPeriods {
  const o = obj as Record<string, unknown>;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.current_period_start === "number" &&
    typeof o.current_period_end === "number"
  );
}

function getInvoiceSubscriptionId(
  invoice: StripeInvoiceWithSubscription | Stripe.Invoice
): string | null {
  const withSub = invoice as StripeInvoiceWithSubscription;
  const raw =
    withSub.subscription ??
    invoice.parent?.subscription_details?.subscription ??
    null;
  if (!raw) return null;
  return typeof raw === "object" ? raw.id ?? null : raw;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

// ── Subscription Handlers ───────────────────────────────────────────────────

export async function handleSubscriptionCreated(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object;
  if (!isSubscriptionWithPeriods(subscription)) {
    return console.error("[stripe] ❌ Invalid subscription object: missing period properties");
  }
  const userId = subscription.metadata?.userId;
  if (!userId) {
    return console.error("[stripe] ❌ Missing userId in subscription metadata");
  }
  const isTrial = subscription.status === "trialing";
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  const priceId = subscription.items.data[0].price.id;
  await createSubscription({
    userId,
    gateway: PAYMENT_GATEWAY.stripe,
    providerSubscriptionId: subscription.id,
    providerCustomerId: subscription.customer as string,
    providerPriceId: priceId,
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    isTrial,
    trialEnd,
    providerEventId: event.id,
  });
  console.log(`[stripe] ✅ Created subscription for user ${userId}${isTrial ? " (trial)" : ""}`);
}

export async function handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object;
  if (!isSubscriptionWithPeriods(subscription)) {
    return console.error("[stripe] ❌ Invalid subscription object: missing period properties");
  }
  await updateSubscription({
    gateway: PAYMENT_GATEWAY.stripe,
    providerSubscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
  console.log(`[stripe] 🔄 Updated subscription ${subscription.id}`);
}

export async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  await cancelSubscription({
    gateway: PAYMENT_GATEWAY.stripe,
    providerSubscriptionId: subscription.id,
    canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : new Date(),
    providerEventId: event.id,
  });
  console.log(`[stripe] ❌ Canceled subscription ${subscription.id}`);

  try {
    const [row] = await dbRead
      .select({
        userId: users.userId,
        email: users.email,
        name: users.name,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.userId))
      .where(and(eq(subscriptions.providerSubscriptionId, subscription.id), eq(subscriptions.gateway, PAYMENT_GATEWAY.stripe)))
      .limit(1);
    if (row?.email) {
      const { sendSubscriptionCanceledEmail, sendEmailSafe } = await import("../../utils/email.js");
      sendEmailSafe("subscription.deleted", () =>
        sendSubscriptionCanceledEmail(row.email, row.name || "there", row.currentPeriodEnd ?? undefined, { userId: row.userId }),
      );
    }
  } catch (emailError) {
    console.error("[stripe] ❌ Failed to send subscription-canceled email:", emailError);
  }
}

export async function handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as StripeInvoiceWithSubscription;
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return console.error("[stripe] ❌ Missing subscriptionId in invoice");
  }
  if (invoice.billing_reason !== "subscription_cycle") {
    console.log(`[stripe] ℹ️ Skipping credit grant for invoice ${invoice.id} (billing_reason=${invoice.billing_reason})`);
    return;
  }
  const periodEnd = invoice.lines?.data[0]?.period?.end;
  if (!periodEnd) {
    return console.error("[stripe] ❌ Could not determine period end from invoice");
  }
  await renewSubscription({
    gateway: PAYMENT_GATEWAY.stripe,
    providerSubscriptionId: subscriptionId,
    providerInvoiceId: invoice.id,
    currentPeriodEnd: new Date(periodEnd * 1000),
    providerEventId: event.id,
  });
  console.log(`[stripe] 💳 Renewed subscription ${subscriptionId}`);
}

export async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as StripeInvoiceWithSubscription;
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return console.error("[stripe] ❌ Missing subscriptionId in failed invoice");
  }
  await updateSubscription({
    gateway: PAYMENT_GATEWAY.stripe,
    providerSubscriptionId: subscriptionId,
    status: "past_due",
  });
  console.log(`[stripe] ❌ Payment failed for subscription ${subscriptionId}`);

  try {
    const [row] = await dbRead
      .select({ userId: users.userId, email: users.email, name: users.name })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.userId))
      .where(and(eq(subscriptions.providerSubscriptionId, subscriptionId), eq(subscriptions.gateway, PAYMENT_GATEWAY.stripe)))
      .limit(1);
    if (row?.email) {
      const { sendPaymentFailedEmail, sendEmailSafe } = await import("../../utils/email.js");
      const portalUrl = process.env.FRONTEND_URL
        ? `${process.env.FRONTEND_URL.replace(/\/$/, "")}/dashboard/account/subscription`
        : undefined;
      sendEmailSafe("invoice.payment_failed", () =>
        sendPaymentFailedEmail(row.email, row.name || "there", portalUrl, { userId: row.userId }),
      );
    }
  } catch (emailError) {
    console.error("[stripe] ❌ Failed to send payment-failed email:", emailError);
  }
}

export async function handleTrialWillEndEvent(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  await handleTrialWillEnd(subscription.id);
  console.log(`[stripe] ⏰ Trial ending soon for subscription ${subscription.id}`);
}

// ── Credit Pack Purchase Handler ────────────────────────────────────────────

export async function handleCheckoutSessionCompleted(
  event: Stripe.Event,
  webhookDeliveryId: string | null
): Promise<{ duplicate: boolean }> {
  const session = event.data.object as Stripe.Checkout.Session;
  const providerEventId = event.id;
  const providerPaymentId = session.payment_intent as string;
  if (!providerPaymentId) throw new Error("Missing payment intent");

  const userId = session.metadata?.userId;
  const credits = session.metadata?.credits;
  const packId = session.metadata?.packId;
  if (!userId || !credits || !packId) throw new Error("Invalid session metadata");

  const creditsAmount = Number(credits);
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error("Invalid credit pack");
  if (session.amount_total !== Math.round(pack.priceUSD * 100)) {
    throw new Error("Amount validation failed");
  }

  let isDuplicateTx = false;
  try {
    await dbWrite.transaction(async (tx) => {
      const existingTransaction = await tx.select().from(transactions).where(and(eq(transactions.gateway, PAYMENT_GATEWAY.stripe), eq(transactions.providerEventId, providerEventId))).limit(1);
      if (existingTransaction.length > 0) {
        isDuplicateTx = true;
        return;
      }
      const priorPurchase = await tx.select().from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.type, "purchase"))).limit(1);
      await awardCredits(userId, creditsAmount, {
        type: "purchase",
        gateway: PAYMENT_GATEWAY.stripe,
        notificationType: "payment_success",
        notificationTitle: "Payment Successful",
        notificationMessage: `Your purchase of ${creditsAmount} credits (${pack.title}) was successful`,
        notificationData: { amountCents: session.amount_total, providerPaymentId, packId },
        metadata: { providerPaymentId, providerEventId, amountCents: session.amount_total, packId },
        amountCents: session.amount_total ?? undefined,
        context: "credit_pack_purchase",
        providerPaymentId,
        providerEventId,
        tx,
      });
      if (priorPurchase.length === 0 && FIRST_PURCHASE_BONUS > 0) {
        try {
          await awardCredits(userId, FIRST_PURCHASE_BONUS, {
            type: "reward",
            gateway: PAYMENT_GATEWAY.stripe,
            notificationType: "first_purchase_bonus",
            notificationTitle: "First Purchase Bonus",
            notificationMessage: `You received ${FIRST_PURCHASE_BONUS} credits for your first purchase`,
            notificationData: { amountCents: session.amount_total, packId, providerPaymentId },
            metadata: { providerEventId, providerPaymentId, packId },
            tx,
          });
          console.log(`[stripe] 🎁 Awarded first-purchase bonus (${FIRST_PURCHASE_BONUS} credits) to user ${userId}`);
        } catch (err) {
          console.error(`[stripe] ❌ Failed to award first-purchase bonus to user ${userId}:`, err);
        }
      }
      if (webhookDeliveryId) {
        await tx.update(webhookDeliveries).set({ status: "success", processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    });
  } catch (txError) {
    if (isUniqueViolation(txError)) {
      console.log(`[stripe] 🔄 Concurrent duplicate delivery detected via unique constraint: ${providerEventId}`);
      isDuplicateTx = true;
    } else {
      throw txError;
    }
  }

  return { duplicate: isDuplicateTx };
}

// ── Refund Handler ──────────────────────────────────────────────────────────

export async function handleChargeRefunded(
  event: Stripe.Event,
  webhookDeliveryId: string | null
): Promise<{ duplicate: boolean }> {
  const charge = event.data.object as Stripe.Charge;
  const providerPaymentId = charge.payment_intent as string;
  const providerEventId = event.id;
  if (!providerPaymentId) throw new Error("Missing payment intent");

  const refundEmailMeta: { userId: string; credits: number }[] = [];
  let isDuplicateTx = false;

  try {
    await dbWrite.transaction(async (tx) => {
      const existingRefund = await tx.select().from(transactions).where(and(eq(transactions.gateway, PAYMENT_GATEWAY.stripe), eq(transactions.providerEventId, providerEventId))).limit(1);
      if (existingRefund.length > 0) {
        isDuplicateTx = true;
        return;
      }
      const originalTransaction = await tx.select().from(transactions).where(and(eq(transactions.gateway, PAYMENT_GATEWAY.stripe), eq(transactions.providerPaymentId, providerPaymentId))).limit(1);
      if (!originalTransaction.length) {
        console.warn(`[stripe] ⚠️ charge.refunded for paymentIntent ${providerPaymentId} has no matching credit-pack transaction — likely a subscription charge. Skipping credit clawback.`);
        if (webhookDeliveryId) {
          await tx.update(webhookDeliveries).set({ status: "success", processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
        }
        return;
      }
      const transaction = originalTransaction[0];
      const refundCents = charge.amount_refunded ?? 0;
      const originalCents = transaction.amountCents!;
      const creditsToDeduct = Number(
        (BigInt(refundCents) * BigInt(transaction.credits) + (BigInt(originalCents) - 1n)) / BigInt(originalCents)
      );
      if (creditsToDeduct > 0) {
        await tx.update(users).set({ credits: sql`GREATEST(0, ${users.credits} - ${creditsToDeduct})` }).where(eq(users.userId, transaction.userId));
        await tx.insert(transactions).values({
          userId: transaction.userId,
          type: "refund",
          credits: -creditsToDeduct,
          amountCents: -refundCents,
          gateway: PAYMENT_GATEWAY.stripe,
          providerPaymentId,
          providerEventId: event.id,
        });
        await tx.insert(userNotifications).values({
          userId: transaction.userId,
          type: "refund",
          title: "Refund Processed",
          message: `${creditsToDeduct} credits have been deducted from your account due to a refund`,
          data: { creditsDeducted: creditsToDeduct, refundCents, refundAmount: refundCents / 100, originalPaymentId: providerPaymentId },
        });
        refundEmailMeta.push({ userId: transaction.userId, credits: creditsToDeduct });
      }
      if (webhookDeliveryId) {
        await tx.update(webhookDeliveries).set({ status: "success", processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    });
  } catch (txError) {
    if (isUniqueViolation(txError)) {
      console.log(`[stripe] 🔄 Concurrent duplicate refund delivery detected via unique constraint: ${providerEventId}`);
      isDuplicateTx = true;
    } else {
      throw txError;
    }
  }

  const refundMeta = refundEmailMeta[0];
  if (refundMeta) {
    try {
      const [u] = await dbRead
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.userId, refundMeta.userId))
        .limit(1);
      if (u?.email) {
        const { sendRefundProcessedEmail, sendEmailSafe } = await import("../../utils/email.js");
        sendEmailSafe("charge.refunded", () =>
          sendRefundProcessedEmail(u.email, u.name || "there", refundMeta.credits, { userId: refundMeta.userId }),
        );
      }
    } catch (emailError) {
      console.error("[stripe] ❌ Failed to send refund email:", emailError);
    }
  }

  return { duplicate: isDuplicateTx };
}
