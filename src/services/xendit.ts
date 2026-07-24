/**
 * Xendit business-logic service (credit packs v1).
 *
 * Creates invoices for one-time pack purchases and awards credits on
 * `invoice.paid` webhooks via the shared gateway-agnostic credit helpers.
 */

import { and, eq } from "drizzle-orm";
import {
  buildXenditCreditPackExternalId,
  getXenditPackPriceIdr,
  parseXenditCreditPackExternalId,
  XENDIT_CONFIG,
} from "../config/xendit.js";
import { CREDIT_PACKS, FIRST_PURCHASE_BONUS } from "../config/credits.js";
import { dbWrite } from "../db/client.js";
import { transactions, webhookDeliveries } from "../db/schema.js";
import { awardCredits } from "./credits.js";
import {
  createXenditInvoice,
  isXenditConfigured,
  type XenditInvoice,
} from "../utils/xendit.js";
import { PAYMENT_GATEWAY, type PaymentGateway } from "../types/payment.js";

const XENDIT_GATEWAY = PAYMENT_GATEWAY.xendit;

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
