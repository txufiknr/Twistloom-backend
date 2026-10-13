import { sendRefundProcessedEmail } from '../../utils/email.js';
import { dispatchEmailWorkers } from '../email-dispatch.js';
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
import { dbWrite } from "../../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications } from "../../db/schema.js";
import { CREDIT_PACKS, FIRST_PURCHASE_BONUS } from "../../config/credits.js";
import { PAYMENT_GATEWAY } from "../../types/payment.js";
import { createSubscription, updateSubscription, renewSubscription, cancelSubscription, handleTrialWillEnd } from "../subscription.js";
import { awardCredits, awardFirstPurchaseBonusOnce } from "../credits.js";
import { isUniqueConstraintError } from "../../utils/retry.js";

// ── Extended Types (Stripe SDK gaps) ────────────────────────────────────────

interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  current_period_start: number;
  current_period_end: number;
}

interface StripeInvoiceWithSubscription extends Stripe.Invoice {
  subscription?: string | Stripe.Subscription;
}

function isSubscriptionWithPeriods(obj: unknown): obj is StripeSubscriptionWithPeriods {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
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
    paymentFailureEventId: event.id,
  });
  console.log(`[stripe] ❌ Payment failed for subscription ${subscriptionId}`);

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
      // First-purchase bonus: claimed through the partial unique index
      // `transactions_user_first_purchase_bonus_unique` (see
      // awardFirstPurchaseBonusOnce), not through a check-then-insert — two
      // concurrent distinct purchases cannot both pass an INSERT, and the
      // loser simply reports `inserted: false` without failing the webhook.
      const bonus = await awardFirstPurchaseBonusOnce(userId, FIRST_PURCHASE_BONUS, {
        gateway: PAYMENT_GATEWAY.stripe,
        notificationData: { amountCents: session.amount_total, packId, providerPaymentId },
        metadata: { providerEventId, providerPaymentId, packId },
        tx,
      });
      if (bonus.inserted) {
        console.log(`[stripe] 🎁 Awarded first-purchase bonus (${FIRST_PURCHASE_BONUS} credits) to user ${userId}`);
      }
      if (webhookDeliveryId) {
        await tx.update(webhookDeliveries).set({ status: "success", processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    });
  } catch (txError) {
    if (isUniqueConstraintError(txError)) {
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
        const [recipient] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.userId, transaction.userId)).limit(1);
        if (recipient?.email) await sendRefundProcessedEmail(recipient.email, recipient.name || 'there', creditsToDeduct,
          { userId: transaction.userId, tx, requestKey: `refund/stripe/${providerEventId}` });
      }
      if (webhookDeliveryId) {
        await tx.update(webhookDeliveries).set({ status: "success", processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    });
  } catch (txError) {
    if (isUniqueConstraintError(txError)) {
      console.log(`[stripe] 🔄 Concurrent duplicate refund delivery detected via unique constraint: ${providerEventId}`);
      isDuplicateTx = true;
    } else {
      throw txError;
    }
  }

  if (!isDuplicateTx) await dispatchEmailWorkers('refund/' + providerEventId);

  return { duplicate: isDuplicateTx };
}
