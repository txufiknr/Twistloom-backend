/**
 * Xendit business-logic service (credit packs v1 + subscriptions Phase 2b).
 *
 * Credit packs: create invoices for one-time purchases, award credits on
 *   `invoice.paid` webhooks.
 * Subscriptions: create recurring plans for VIP subscriptions, manage
 *   lifecycle via `recurring.*` webhooks.
 */

import { and, eq } from "drizzle-orm";
import {
  buildXenditCreditPackExternalId,
  buildXenditSubscriptionReferenceId,
  getXenditPackPriceIdr,
  parseXenditCreditPackExternalId,
  parseXenditSubscriptionReferenceId,
  XENDIT_CONFIG,
} from "../config/xendit.js";
import { CREDIT_PACKS, FIRST_PURCHASE_BONUS } from "../config/credits.js";
import { dbWrite } from "../db/client.js";
import { transactions, webhookDeliveries } from "../db/schema.js";
import { awardCredits } from "./credits.js";
import { createSubscription, renewSubscription, cancelSubscription } from "./subscription.js";
import {
  createXenditCustomer,
  createXenditInvoice,
  createXenditRecurringPlan,
  deactivateXenditPlan,
  isXenditConfigured,
  type XenditInvoice,
  type XenditRecurringPlan,
} from "../utils/xendit.js";
import { PAYMENT_GATEWAY, type PaymentGateway } from "../types/payment.js";

const XENDIT_GATEWAY = PAYMENT_GATEWAY.xendit;

/**
 * Creates a Xendit recurring plan checkout for VIP subscription.
 *
 * 1. Creates (or reuses) a Xendit customer
 * 2. Creates a recurring plan with immediate action type
 * 3. Returns the linking URL for the user to authorize their payment method
 *
 * @returns Linking URL + provider session/plan id + gateway
 */
export async function createXenditSubscriptionCheckout(params: {
  userId: string;
  email: string;
  name?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string; gateway: PaymentGateway }> {
  if (!isXenditConfigured()) {
    throw new Error("Xendit is not enabled or not configured");
  }

  // 1. Create a Xendit customer for this user
  const referenceId = buildXenditSubscriptionReferenceId(params.userId);
  const customer = await createXenditCustomer({
    referenceId,
    givenNames: params.name || "Twistloom User",
    email: params.email,
    metadata: { userId: params.userId },
  });

  if (!customer.id) {
    throw new Error("Xendit create customer returned no id");
  }

  // 2. Create recurring plan
  const plan = await createXenditRecurringPlan({
    referenceId,
    customerId: customer.id,
    amountIdr: XENDIT_CONFIG.subscription.amountIdr,
    description: `Twistloom VIP (${XENDIT_CONFIG.subscription.currency})`,
    successRedirectUrl: params.successUrl,
    failureRedirectUrl: params.cancelUrl,
    metadata: {
      userId: params.userId,
      referenceId,
      customerId: customer.id,
    },
  });

  const linkingUrl = plan.actions[0].url;

  return {
    url: linkingUrl,
    sessionId: plan.id,
    gateway: XENDIT_GATEWAY,
  };
}

/**
 * Handles `recurring.plan.activation` webhook — creates local subscription record.
 *
 * Maps the Xendit recurring plan to our gateway-agnostic `createSubscription()`.
 */
export async function handleXenditPlanActivated(plan: XenditRecurringPlan, eventId: string): Promise<void> {
  const metadata = plan.metadata || {};
  const userId =
    (typeof metadata.userId === "string" ? metadata.userId : undefined) ||
    parseUserIdFromReferenceId(plan.reference_id);

  if (!userId) {
    throw new Error(`Xendit plan activated missing userId (plan=${plan.id}, reference_id=${plan.reference_id})`);
  }

  const planId = plan.id;
  const customerId = plan.customer_id;
  const amount = plan.amount;

  // Parse anchor_date from schedule for period start
  const periodStart = new Date(plan.schedule?.anchor_date || plan.created);
  // Default period end to 30 days from start
  const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);

  await createSubscription({
    userId,
    gateway: XENDIT_GATEWAY,
    providerSubscriptionId: planId,
    providerCustomerId: customerId,
    providerPriceId: String(amount), // Use amount IDR as the "price ID"
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    isTrial: false,
    trialEnd: null,
    providerEventId: eventId,
  });

  console.log(`[xendit] ✅ Subscription activated for user ${userId} (plan ${planId})`);
}

/**
 * Handles `recurring.cycle.succeeded` webhook — renews subscription.
 */
export async function handleXenditCycleSucceeded(data: {
  plan_id: string;
  id: string;
  amount: number;
  scheduled_timestamp: string;
  paid_at?: string;
  status: string;
}, eventId: string): Promise<void> {
  const planId = data.plan_id;
  const cycleId = data.id;

  // The scheduled_timestamp is the next billing date — use it as the new period end
  const nextPeriodEnd = data.scheduled_timestamp
    ? new Date(data.scheduled_timestamp)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await renewSubscription({
    providerSubscriptionId: planId,
    providerInvoiceId: cycleId,
    currentPeriodEnd: nextPeriodEnd,
    gateway: XENDIT_GATEWAY,
    providerEventId: eventId,
  });

  console.log(`[xendit] 💳 Cycle ${cycleId} succeeded for plan ${planId}, renewed until ${nextPeriodEnd.toISOString()}`);
}

/**
 * Handles `recurring.cycle.failed` webhook — marks subscription past_due.
 */
export async function handleXenditCycleFailed(data: {
  plan_id: string;
  id: string;
  failure_code?: string;
  failure_message?: string;
}, _eventId: string): Promise<void> {
  const { updateSubscription } = await import("./subscription.js");

  await updateSubscription({
    providerSubscriptionId: data.plan_id,
    gateway: XENDIT_GATEWAY,
    status: "past_due",
  });

  console.log(`[xendit] ❌ Cycle ${data.id} failed for plan ${data.plan_id}: ${data.failure_code || data.failure_message || "unknown"}`);
}

/**
 * Handles `recurring.plan.deactivation` webhook — cancels subscription.
 */
export async function handleXenditPlanDeactivated(data: {
  id: string;
  deactivation_date?: string;
}, eventId: string): Promise<void> {
  await cancelSubscription({
    providerSubscriptionId: data.id,
    canceledAt: data.deactivation_date ? new Date(data.deactivation_date) : new Date(),
    gateway: XENDIT_GATEWAY,
    providerEventId: eventId,
  });

  console.log(`[xendit] ❌ Plan ${data.id} deactivated`);
}

/**
 * Cancels a Xendit subscription by deactivating the recurring plan at Xendit.
 *
 * @param providerSubscriptionId - Xendit recurring plan ID (repl_xxx)
 */
export async function cancelXenditSubscription(providerSubscriptionId: string): Promise<void> {
  await deactivateXenditPlan(providerSubscriptionId);
  console.log(`[xendit] 🔄 Deactivated plan ${providerSubscriptionId} at Xendit`);
}

/**
 * Extracts userId from a reference_id string.
 * Supports both `vip-sub-{userId}-{timestamp}` and raw UUID.
 */
function parseUserIdFromReferenceId(referenceId: string): string | null {
  const parsed = parseXenditSubscriptionReferenceId(referenceId);
  if (parsed) return parsed.userId;

  // Try raw UUID
  const uuidMatch = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(referenceId);
  if (uuidMatch) return uuidMatch[1];

  return null;
}

/**
 * Creates a Xendit hosted invoice for a credit pack purchase.
 *
 * @returns Checkout URL + provider session/invoice id
 */
export async function createXenditCreditPackCheckout(params: {
  userId: string;
  email: string;
  name?: string;
  packId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string; gateway: PaymentGateway }> {
  if (!isXenditConfigured()) {
    throw new Error("Xendit is not enabled or not configured");
  }

  const pack = CREDIT_PACKS.find((p) => p.id === params.packId);
  if (!pack) throw new Error("Credit pack not found");

  const amountIdr = getXenditPackPriceIdr(pack.id);
  if (amountIdr == null) throw new Error("Credit pack has no Xendit price");

  const externalId = buildXenditCreditPackExternalId(params.userId, pack.id);
  const invoice = await createXenditInvoice({
    externalId,
    amountIdr,
    description: `${pack.title} Pack (${pack.credits} credits)`,
    payerEmail: params.email,
    successRedirectUrl: params.successUrl,
    failureRedirectUrl: params.cancelUrl,
    customerName: params.name,
    metadata: {
      userId: params.userId,
      packId: pack.id,
      credits: String(pack.credits),
    },
  });

  return {
    url: invoice.invoice_url!,
    sessionId: invoice.id,
    gateway: XENDIT_GATEWAY,
  };
}

/**
 * Detects Postgres unique-constraint violation (SQLSTATE 23505).
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/**
 * Handles a paid Xendit invoice: awards pack credits (+ first-purchase bonus).
 *
 * Idempotent via `(gateway, providerEventId)` / `(gateway, providerPaymentId)`.
 *
 * @param invoice - Xendit invoice object from webhook body
 * @param eventId - Stable event key for delivery tracking (invoice id when event id absent)
 */
export async function handleXenditInvoicePaid(
  invoice: XenditInvoice,
  eventId: string
): Promise<{ duplicate: boolean }> {
  const status = (invoice.status || "").toUpperCase();
  if (status !== "PAID" && status !== "SETTLED") {
    console.log(`[xendit] ℹ️ Ignoring invoice ${invoice.id} with status=${invoice.status}`);
    return { duplicate: false };
  }

  const externalId = invoice.external_id;
  const parsed = externalId ? parseXenditCreditPackExternalId(externalId) : null;
  const meta = invoice.metadata || {};

  const userId =
    parsed?.userId ||
    (typeof meta.userId === "string" ? meta.userId : undefined);
  const packId =
    parsed?.packId ||
    (typeof meta.packId === "string" ? meta.packId : undefined);

  if (!userId || !packId) {
    throw new Error(`Xendit invoice missing userId/packId (external_id=${externalId})`);
  }

  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error(`Unknown credit pack: ${packId}`);

  const expectedAmount = getXenditPackPriceIdr(pack.id);
  const paidAmount = invoice.paid_amount ?? invoice.amount;
  if (expectedAmount != null && paidAmount !== expectedAmount) {
    throw new Error(
      `Xendit amount mismatch for pack ${packId}: expected ${expectedAmount}, got ${paidAmount}`
    );
  }

  const providerPaymentId = invoice.id;
  const providerEventId = eventId;
  const creditsAmount = pack.credits;
  // Store IDR as "cents-like" whole units (no fractional rupiah for these packs)
  const amountCents = paidAmount;

  try {
    await dbWrite.transaction(async (tx) => {
      const existing = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.gateway, XENDIT_GATEWAY),
            eq(transactions.providerEventId, providerEventId)
          )
        )
        .limit(1);

      if (existing.length > 0) return;

      const priorPurchase = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.type, "purchase")))
        .limit(1);

      await awardCredits(userId, creditsAmount, {
        type: "purchase",
        gateway: XENDIT_GATEWAY,
        notificationType: "payment_success",
        notificationTitle: "Payment Successful",
        notificationMessage: `Your purchase of ${creditsAmount} credits (${pack.title}) was successful`,
        notificationData: { amountIdr: paidAmount, providerPaymentId, packId },
        metadata: {
          providerPaymentId,
          providerEventId,
          amountIdr: paidAmount,
          packId,
          currency: "IDR",
        },
        amountCents,
        context: "credit_pack_purchase",
        providerPaymentId,
        providerEventId,
        tx,
      });

      if (priorPurchase.length === 0 && FIRST_PURCHASE_BONUS > 0) {
        try {
          await awardCredits(userId, FIRST_PURCHASE_BONUS, {
            type: "reward",
            gateway: XENDIT_GATEWAY,
            notificationType: "first_purchase_bonus",
            notificationTitle: "First Purchase Bonus",
            notificationMessage: `You received ${FIRST_PURCHASE_BONUS} credits for your first purchase`,
            notificationData: { amountIdr: paidAmount, packId, providerPaymentId },
            metadata: { providerEventId, providerPaymentId, packId, currency: "IDR" },
            tx,
          });
          console.log(
            `[xendit] 🎁 Awarded first-purchase bonus (${FIRST_PURCHASE_BONUS} credits) to user ${userId}`
          );
        } catch (err) {
          console.error(`[xendit] ❌ Failed to award first-purchase bonus to user ${userId}:`, err);
        }
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      console.log(`[xendit] 🔄 Duplicate invoice paid event: ${providerEventId}`);
      return { duplicate: true };
    }
    throw error;
  }

  console.log(
    `[xendit] ✅ Credited ${creditsAmount} to user ${userId} for pack ${packId} (invoice ${providerPaymentId})`
  );
  return { duplicate: false };
}

/**
 * Tracks or reuses a webhook delivery row for Xendit events.
 *
 * @returns Delivery row id
 */
export async function trackXenditWebhookDelivery(
  eventId: string,
  eventType: string
): Promise<{ deliveryId: string; alreadySuccess: boolean }> {
  const existing = await dbWrite
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.gateway, XENDIT_GATEWAY), eq(webhookDeliveries.eventId, eventId)))
    .limit(1);

  if (existing.length > 0) {
    return {
      deliveryId: existing[0].id,
      alreadySuccess: existing[0].status === "success",
    };
  }

  try {
    const [row] = await dbWrite
      .insert(webhookDeliveries)
      .values({
        gateway: XENDIT_GATEWAY,
        eventId,
        eventType,
        status: "retrying",
      })
      .returning();
    return { deliveryId: row.id, alreadySuccess: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const [dup] = await dbWrite
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.gateway, XENDIT_GATEWAY), eq(webhookDeliveries.eventId, eventId)))
        .limit(1);
      return {
        deliveryId: dup.id,
        alreadySuccess: dup.status === "success",
      };
    }
    throw error;
  }
}

/**
 * Marks a webhook delivery as success or failed.
 */
export async function finalizeXenditWebhookDelivery(
  deliveryId: string,
  status: "success" | "failed",
  errorMessage?: string
): Promise<void> {
  await dbWrite
    .update(webhookDeliveries)
    .set({
      status,
      errorMessage: errorMessage ?? null,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

export { XENDIT_CONFIG, isXenditConfigured };
