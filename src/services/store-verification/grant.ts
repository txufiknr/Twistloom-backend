/**
 * Store purchase grant orchestration.
 *
 * Turns a store-confirmed receipt into the durable entitlement the app reads:
 * a `subscriptions` row (VIP) or a `transactions` row (credit pack). Every path
 * is idempotent — a repeated verification of the same purchase is expected
 * (the client retries on resume, and there is no store notification yet, see
 * owner gate OG-4) and must return the same answer rather than grant twice.
 *
 * Idempotency comes from the schema's unique constraints, not from an
 * application-level flag:
 * - subscriptions: unique `(gateway, provider_subscription_id)`
 * - renewals: unique `(gateway, provider_invoice_id)`
 * - purchases: unique `(gateway, provider_payment_id)`
 * - audit ledger: unique `(gateway, event_id)` on `webhook_deliveries`
 * - first-purchase bonus: partial unique `user_id` where
 *   `type = 'first_purchase_bonus'` (one bonus per account, claimed via
 *   `awardFirstPurchaseBonusOnce`)
 *
 * The store's own API is the only authority for `entitled`; nothing here
 * recomputes it from a clock the client controls.
 *
 * Ownership: the store API proves the *purchase*, never which local account
 * owns it — a Play purchase token or an Apple `originalTransactionId` is only
 * as private as the device it lives on (two app accounts can share one device,
 * and a token can leak). Every path below therefore refuses to touch a row
 * whose `user_id` is someone else's instead of relinking it to the caller, and
 * the VIP path additionally honours the account the *store* bound the purchase
 * to when it reports one ({@link storeAccountBindingMatches}).
 */

import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client.js";
import { getErrorMessage } from "../../utils/error.js";
import { subscriptions, transactions, users, webhookDeliveries } from "../../db/schema.js";
import { FIRST_PURCHASE_BONUS } from "../../config/credits.js";
import { VIP_BENEFITS } from "../../config/subscription.js";
import type { PaymentGateway } from "../../types/payment.js";
import { isUniqueConstraintError } from "../../utils/retry.js";
import { awardCredits, awardFirstPurchaseBonusOnce } from "../credits.js";
import { cancelSubscription, createSubscription, renewSubscription, updateSubscription } from "../subscription.js";
import { storeGatewayFor, type ResolvedStoreProduct } from "./index.js";
import type { StoreReceipt } from "./types.js";

/** Subscription echo — the same shape `GET /payments/subscription` returns. */
export interface SubscriptionEcho {
  id: string;
  gateway: string;
  providerSubscriptionId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  monthlyCredits: number;
  isTrial: boolean;
  trialEnd: string | null;
}

export type VipGrantOutcome =
  | {
      status: "verified";
      subscription: SubscriptionEcho;
      renewed: boolean;
      /** Account balance read on the primary *after* the grant committed. */
      credits: number;
    }
  | { status: "denied"; reason: string };

export interface StoreCreditGrantOutcome {
  granted: boolean;
  alreadyGranted: boolean;
  bonusCredits: number;
  newBalance: number;
  /**
   * Set only when the purchase token resolves to a `transactions` row another
   * account already owns: `granted`/`alreadyGranted` are both `false` and
   * nothing was written for this caller.
   */
  deniedReason?: string;
}

/**
 * Reads the echo back on the primary connection.
 *
 * Every call site runs immediately after a write (`createSubscription` /
 * `renewSubscription` / `updateSubscription` commit in their own transaction),
 * so a replica read could answer "not found" and turn a grant that *did*
 * succeed into a 500.
 */
async function readSubscriptionEcho(gateway: PaymentGateway, providerSubscriptionId: string): Promise<SubscriptionEcho | null> {
  const rows = await dbWrite
    .select({
      id: subscriptions.id,
      gateway: subscriptions.gateway,
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      isTrial: subscriptions.isTrial,
      trialEnd: subscriptions.trialEnd,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.gateway, gateway), eq(subscriptions.providerSubscriptionId, providerSubscriptionId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    gateway: row.gateway,
    providerSubscriptionId: row.providerSubscriptionId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    monthlyCredits: VIP_BENEFITS.monthlyCredits,
    isTrial: row.isTrial,
    trialEnd: row.trialEnd?.toISOString() ?? null,
  };
}

/**
 * Keeps `users.subscription_id` pointing at the row this purchase just proved,
 * so `GET /subscription` (which joins through the user) reports the verified
 * store row rather than a stale hosted-checkout one.
 *
 * Ownership is re-checked here against the primary: `subscriptionId` may name a
 * row a concurrent verification from a *different* account inserted (the
 * unique `(gateway, provider_subscription_id)` constraint makes exactly one of
 * them the winner), and writing the link unconditionally would repoint this
 * caller at another user's subscription — silently unlinking whatever they had
 * and handing `downgradeUserFromVip` a row it must not touch.
 *
 * @returns `true` when the row exists, is owned by `userId`, and the link now
 * points at it; `false` when the row is missing or owned by someone else — in
 * which case **nothing was written**.
 */
async function ensureUserLinkedToSubscription(userId: string, subscriptionId: string): Promise<boolean> {
  const owned = await dbWrite
    .select({ id: subscriptions.id, userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  const row = owned[0];
  if (!row) return false;
  if (row.userId !== userId) return false;

  const viewers = await dbWrite
    .select({ subscriptionId: users.subscriptionId })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (viewers[0]?.subscriptionId === subscriptionId) return true;
  await dbWrite.update(users).set({ subscriptionId }).where(eq(users.userId, userId));
  return true;
}

/** Post-grant balance on the primary, so the client sees its own write. */
async function readUserCredits(userId: string): Promise<number> {
  const rows = await dbWrite.select({ credits: users.credits }).from(users).where(eq(users.userId, userId)).limit(1);
  return rows[0]?.credits ?? 0;
}

/** Standard denial for a purchase token that resolves to another account's row. */
function foreignOwnershipDenial(userId: string, gateway: PaymentGateway, providerSubscriptionId: string): VipGrantOutcome {
  console.warn(
    `[store-verification] ⚠️ Refused ${gateway}:${providerSubscriptionId} for user ${userId} — row is owned by another account`,
  );
  return { status: "denied", reason: "store_subscription_owned_by_other_account" };
}

/**
 * Whether a receipt's store-side account binding names the presenting account.
 *
 * Play echoes the obfuscated account id the purchase was made under (our
 * client sets it to the user id when it starts a Play purchase). When it is
 * present and names a different account, the proof is not this account's to
 * claim: the row-ownership gates below only protect rows that already exist,
 * so without this check the **first** claimant would win a token they never
 * paid for (audit F2 — two app accounts can share one device, and a purchase
 * token can leak).
 *
 * A receipt with no binding (Apple returns no equivalent — `applicationUsername`
 * is write-only on the StoreKit side — and Play can omit it) falls through to
 * the row-ownership gates instead of failing closed, because denying every
 * unbound purchase would lock out real customers without adding a guarantee
 * against a store that says nothing.
 *
 * @param userId - Authenticated account presenting the proof
 * @param receipt - Store-confirmed purchase facts
 * @returns `false` only when the store explicitly bound the purchase elsewhere
 */
export function storeAccountBindingMatches(userId: string, receipt: StoreReceipt): boolean {
  const bound = receipt.metadata.obfuscatedAccountId;
  return typeof bound !== "string" || bound.length === 0 || bound === userId;
}

/**
 * Best-effort audit row for a completed store verification.
 *
 * A unique `(gateway, event_id)` conflict means this period was already
 * recorded — the grant itself is already idempotent, so the conflict is
 * swallowed rather than surfaced.
 *
 * Every other failure is swallowed too: this row is written *after* the grant
 * transaction has committed, so surfacing it would answer a successful grant
 * with a 500. Audit coverage degrades, entitlement never does.
 */
export async function recordStoreVerification(
  gateway: PaymentGateway,
  eventId: string,
  outcome: "granted" | "renewed" | "replayed",
): Promise<void> {
  try {
    await dbWrite.insert(webhookDeliveries).values({
      gateway,
      eventId,
      eventType: `store_verification_${outcome}`,
      status: "success",
      processedAt: new Date(),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return;
    console.warn(`[store-verification] ⚠️ Audit row for ${eventId} not recorded: ${getErrorMessage(error)}`);
  }
}

/**
 * Applies a store-verified VIP purchase.
 *
 * @param userId - Authenticated owner of the purchase
 * @param receipt - Store-confirmed purchase; `entitled` is the store's call
 * @returns The verified subscription echo plus the post-grant balance, or
 * `denied` when the store no longer grants entitlement **or** when the token
 * resolves to a row another account owns (a real answer, not an error)
 */
export async function grantVipFromStore(userId: string, receipt: StoreReceipt): Promise<VipGrantOutcome> {
  const gateway = storeGatewayFor(receipt.platform);
  const providerSubscriptionId = receipt.purchaseKey;
  const now = new Date();

  // Account-binding gate (audit F2): refuse a purchase the store explicitly
  // bound to another account *before* any read or write, so a foreign proof
  // changes no state at all — not even the lapsed-period cleanup below.
  if (!storeAccountBindingMatches(userId, receipt)) {
    console.warn(
      `[store-verification] ⚠️ Refused ${gateway}:${providerSubscriptionId} for user ${userId} — purchase is bound to another store account`,
    );
    return { status: "denied", reason: "store_account_binding_mismatch" };
  }

  const existing = await dbRead
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      currentPeriodStart: subscriptions.currentPeriodStart,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.gateway, gateway), eq(subscriptions.providerSubscriptionId, providerSubscriptionId)))
    .limit(1);

  if (!receipt.entitled || !receipt.entitlementEnd) {
    // Real purchase, lapsed period: stop serving it here and let the VIP
    // expiration cron reconcile the user's tier, exactly as it does for
    // hosted gateways. No credits are granted.
    //
    // No ownership gate here on purpose: the store — not the caller — just
    // said this *purchase* is no longer entitled, and the row is keyed by that
    // purchase. Letting it stay active would be the bug.
    if (existing.length > 0 && existing[0].status !== "canceled") {
      await cancelSubscription({ providerSubscriptionId, canceledAt: now, gateway });
    }
    await recordStoreVerification(gateway, providerSubscriptionId, "replayed");
    return { status: "denied", reason: `store_subscription_${receipt.state.toLowerCase()}` };
  }

  // Ownership gate: from here on the caller is asking to *gain* something from
  // this token, so the token must resolve to their own row. A second account
  // presenting the same token must be refused rather than repointed here.
  if (existing.length > 0 && existing[0].userId !== userId) {
    return foreignOwnershipDenial(userId, gateway, providerSubscriptionId);
  }

  const periodEnd = receipt.entitlementEnd;
  const periodStart =
    receipt.entitlementStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (existing.length === 0) {
    await createSubscription({
      userId,
      gateway,
      providerSubscriptionId,
      // Play has no customer object; Apple's is the original transaction id.
      // The purchase chain handle doubles as the customer handle so a later
      // notification can find this row.
      providerCustomerId: providerSubscriptionId,
      providerPriceId: receipt.productId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      metadata: {
        platform: receipt.platform,
        storeState: receipt.state,
        environment: receipt.environment,
        autoRenewing: receipt.autoRenewing,
        ...receipt.metadata,
      },
    });
    // `createSubscription` swallows the unique violation and returns as if it
    // succeeded, so the "row did not exist" read above can be stale: another
    // account may have inserted this exact row between the read and the
    // insert. The link — and the verdict — therefore come from the row as it
    // stands now, not from our (possibly lost) race.
    const echo = await readSubscriptionEcho(gateway, providerSubscriptionId);
    if (!echo) throw new Error("Store subscription grant did not persist");
    if (!(await ensureUserLinkedToSubscription(userId, echo.id))) {
      return foreignOwnershipDenial(userId, gateway, providerSubscriptionId);
    }
    await recordStoreVerification(gateway, `${providerSubscriptionId}@${periodEnd.toISOString()}`, "granted");
    return { status: "verified", subscription: echo, renewed: false, credits: await readUserCredits(userId) };
  }

  const current = existing[0];
  const isLaterPeriod = periodEnd.getTime() > current.currentPeriodEnd.getTime() + 60_000;

  if (isLaterPeriod) {
    // A new paid period: the deterministic invoice id (gateway + product +
    // period end) makes the renewal — and its +200 credits — at-most-once even
    // when the client resubmits the same proof many times.
    await renewSubscription({
      providerSubscriptionId,
      gateway,
      providerInvoiceId: `${gateway}:${receipt.productId}:${periodEnd.toISOString()}`,
      currentPeriodEnd: periodEnd,
    });
    const echo = await readSubscriptionEcho(gateway, providerSubscriptionId);
    if (!echo) throw new Error("Store subscription renewal did not persist");
    if (!(await ensureUserLinkedToSubscription(userId, echo.id))) {
      return foreignOwnershipDenial(userId, gateway, providerSubscriptionId);
    }
    await recordStoreVerification(gateway, `${providerSubscriptionId}@${periodEnd.toISOString()}`, "renewed");
    return { status: "verified", subscription: echo, renewed: true, credits: await readUserCredits(userId) };
  }

  // Replay inside the current period (or a repair of a stale row): re-confirm
  // without granting anything again.
  if (current.status !== "active") {
    await updateSubscription({ providerSubscriptionId, gateway, status: "active" });
  }
  const echo = await readSubscriptionEcho(gateway, providerSubscriptionId);
  if (!echo) throw new Error("Store subscription not found after replay");
  if (!(await ensureUserLinkedToSubscription(userId, echo.id))) {
    return foreignOwnershipDenial(userId, gateway, providerSubscriptionId);
  }
  await recordStoreVerification(gateway, `${providerSubscriptionId}@${periodEnd.toISOString()}`, "replayed");
  return { status: "verified", subscription: echo, renewed: false, credits: await readUserCredits(userId) };
}

/**
 * Applies a store-verified credit pack purchase.
 *
 * No store-side account binding exists to check here: Play's product endpoint
 * returns no obfuscated account id and Apple returns no equivalent for us, so
 * the row-ownership gate below is the protection available for credit packs
 * (unlike VIP subscriptions, where Play's binding is honoured).
 *
 * @param userId - Authenticated owner of the purchase
 * @param receipt - Store-confirmed purchase
 * @param resolved - Pack the server's registry matched to this product id
 * @returns Grant result; `alreadyGranted` is a normal, repeatable answer, and
 * `deniedReason` means the token belongs to another account (nothing written)
 */
export async function grantStoreCreditPurchase(
  userId: string,
  receipt: StoreReceipt,
  resolved: Extract<ResolvedStoreProduct, { kind: "consumable" }>,
): Promise<StoreCreditGrantOutcome> {
  const gateway = storeGatewayFor(receipt.platform);
  const providerPaymentId = receipt.orderId ?? receipt.purchaseKey;

  // Primary connection: the answer is always produced right after a write, so
  // a replica could report the pre-grant balance.
  const currentBalance = async (): Promise<number> => {
    const rows = await dbWrite.select({ credits: users.credits }).from(users).where(eq(users.userId, userId)).limit(1);
    return rows[0]?.credits ?? 0;
  };

  const readOwner = async (): Promise<string | null> => {
    const rows = await dbWrite
      .select({ userId: transactions.userId })
      .from(transactions)
      .where(and(eq(transactions.gateway, gateway), eq(transactions.providerPaymentId, providerPaymentId)))
      .limit(1);
    return rows[0]?.userId ?? null;
  };

  const existing = await dbRead
    .select({ id: transactions.id, userId: transactions.userId })
    .from(transactions)
    .where(and(eq(transactions.gateway, gateway), eq(transactions.providerPaymentId, providerPaymentId)))
    .limit(1);
  if (existing.length > 0) {
    // A repeated *own* verification is idempotent; another account presenting
    // this token must not be told "already granted" (it was never theirs).
    if (existing[0].userId !== userId) {
      console.warn(
        `[store-verification] ⚠️ Refused credit pack ${gateway}:${providerPaymentId} for user ${userId} — row is owned by another account`,
      );
      return {
        granted: false,
        alreadyGranted: false,
        bonusCredits: 0,
        newBalance: await currentBalance(),
        deniedReason: "store_purchase_owned_by_other_account",
      };
    }
    return { granted: false, alreadyGranted: true, bonusCredits: 0, newBalance: await currentBalance() };
  }

  let bonusCredits = 0;
  try {
    const newBalance = await dbWrite.transaction(async (tx) => {
      await awardCredits(userId, resolved.credits, {
        type: "purchase",
        gateway,
        notificationType: "payment_success",
        notificationTitle: "Payment Successful",
        notificationMessage: `Your purchase of ${resolved.credits} credits (${resolved.title}) was successful`,
        notificationData: { packId: resolved.packId, providerPaymentId },
        metadata: {
          providerPaymentId,
          storeOrderId: receipt.orderId,
          platform: receipt.platform,
          packId: resolved.packId,
          // Reference price: the store charges a localized amount we do not
          // receive from either store API, so the pack's USD price is recorded.
          amountCents: Math.round(resolved.priceUSD * 100),
        },
        amountCents: Math.round(resolved.priceUSD * 100),
        context: "credit_pack_purchase",
        providerPaymentId,
        providerEventId: providerPaymentId,
        tx,
      });

      // The one-time bonus is claimed through the partial unique index
      // `transactions_user_first_purchase_bonus_unique` (see
      // awardFirstPurchaseBonusOnce), not through a check-then-insert: two
      // concurrent distinct purchases cannot both pass an INSERT, and the
      // loser reports `inserted: false` without rolling back its purchase.
      const bonus = await awardFirstPurchaseBonusOnce(userId, FIRST_PURCHASE_BONUS, {
        gateway,
        notificationData: { packId: resolved.packId },
        tx,
      });
      if (bonus.inserted) bonusCredits = FIRST_PURCHASE_BONUS;

      // The balance returned to the client must be the one *after* every award
      // in this transaction, including the bonus.
      return bonus.balance;
    });
    await recordStoreVerification(gateway, providerPaymentId, "granted");
    return { granted: true, alreadyGranted: false, bonusCredits, newBalance };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Lost a race with a concurrent verification of the same purchase; the
      // winning transaction committed. Re-read the winner on the primary — a
      // lagging replica read above is exactly how we got here — and only call
      // it "already granted" when that winner is this same account.
      const owner = await readOwner();
      if (!owner) throw error;
      if (owner !== userId) {
        console.warn(
          `[store-verification] ⚠️ Refused credit pack ${gateway}:${providerPaymentId} for user ${userId} — row is owned by another account`,
        );
        return {
          granted: false,
          alreadyGranted: false,
          bonusCredits: 0,
          newBalance: await currentBalance(),
          deniedReason: "store_purchase_owned_by_other_account",
        };
      }
      return { granted: false, alreadyGranted: true, bonusCredits: 0, newBalance: await currentBalance() };
    }
    throw error;
  }
}
