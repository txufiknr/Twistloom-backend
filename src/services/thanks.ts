/**
 * Thanks (Creator Tipping) Service
 *
 * Business logic for recording Thanks tips, querying book-level stats,
 * and checking reader tipping status. This service handles the INTAKE
 * flow only — wallet balance management lives in wallet.ts.
 *
 * @see docs/architecture/THANKS_SYSTEM_ARCHITECTURE.md
 */

import { eq, sql, and } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import {
  creatorEarnings,
  creatorWallets,
  users,
  books,
  userNotifications,
} from "../db/schema.js";
import { calculatePlatformFee, calculateCreatorAmount } from "../config/thanks.js";
import { XENDIT_CONFIG } from "../config/xendit.js";
import { getErrorMessage } from "../utils/error.js";
import { isUniqueConstraintError } from "../utils/retry.js";

import { PAYMENT_GATEWAY, type PaymentGateway } from "../types/payment.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RecordThanksOptions {
  readerId: string;
  creatorId: string;
  bookId: string;
  pageId?: string;
  grossAmount: number;
  currency: string;
  gateway?: PaymentGateway;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeEventId?: string;
  providerPaymentId?: string;
  providerEventId?: string;
  message?: string;
}

// ── Record Thanks ───────────────────────────────────────────────────────────

/**
 * Records a successful Thanks tip from a reader to a creator.
 * Called from Stripe or Xendit webhook handlers after payment confirmation.
 *
 * Operations (all within a single DB transaction):
 * 1. Idempotency check on eventId
 * 2. Insert earnings record (source='thanks')
 * 3. Upsert wallet balance (atomic increment)
 * 4. Send in-app notification to creator (best-effort)
 */
export async function recordThanks(options: RecordThanksOptions): Promise<{ duplicate: boolean }> {
  const {
    readerId, creatorId, bookId, pageId,
    grossAmount, currency,
    message,
  } = options;

  const eventId = options.providerEventId || options.stripeEventId || `event-${Date.now()}`;
  const sessionId = options.stripeSessionId || options.providerPaymentId || null;
  const paymentIntentId = options.stripePaymentIntentId || null;
  const gateway = options.gateway || (options.stripeSessionId ? PAYMENT_GATEWAY.stripe : PAYMENT_GATEWAY.xendit);

  // Only populate stripeEventId for Stripe events; use providerEventId for all gateways
  const stripeEventId = gateway === PAYMENT_GATEWAY.stripe ? eventId : null;

  // 1. Quick idempotency check before entering transaction
  const existing = await dbRead
    .select({ id: creatorEarnings.id })
    .from(creatorEarnings)
    .where(
      and(
        eq(creatorEarnings.gateway, gateway),
        eq(creatorEarnings.providerEventId, eventId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { duplicate: true };
  }

  // 2. Determine target creator's settlement currency
  const [existingWallet] = await dbRead
    .select({ currency: creatorWallets.currency })
    .from(creatorWallets)
    .where(eq(creatorWallets.creatorId, creatorId))
    .limit(1);

  let targetCurrency: "IDR" | "USD" = "IDR";
  if (existingWallet?.currency) {
    targetCurrency = existingWallet.currency === "USD" ? "USD" : "IDR";
  } else {
    // New wallet: check creator's preferredLocale
    const [creatorUser] = await dbRead
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.userId, creatorId))
      .limit(1);
    targetCurrency = creatorUser?.preferredLocale === "id" ? "IDR" : "USD";
  }

  // 3. Multi-currency normalization
  const normalizedIntakeCurrency = (currency || (gateway === PAYMENT_GATEWAY.stripe ? "USD" : "IDR")).toUpperCase() as "IDR" | "USD";
  const fxRate = XENDIT_CONFIG.usdToIdrRate || 15500;
  let appliedFxRate = 1.0;
  let settlementGross: number;

  if (normalizedIntakeCurrency === "USD" && targetCurrency === "IDR") {
    // Reader paid USD cents ($10.00 = 1000 cents) -> Creator settles in whole IDR
    appliedFxRate = fxRate;
    settlementGross = Math.round((grossAmount / 100) * fxRate);
  } else if (normalizedIntakeCurrency === "IDR" && targetCurrency === "USD") {
    // Reader paid whole IDR (155,000 IDR) -> Creator settles in USD cents (1000 cents)
    appliedFxRate = 1 / fxRate;
    settlementGross = Math.round((grossAmount / fxRate) * 100);
  } else {
    // Matching currency
    appliedFxRate = 1.0;
    settlementGross = grossAmount;
  }

  const platformFee = calculatePlatformFee(settlementGross);
  const creatorAmount = calculateCreatorAmount(settlementGross);

  try {
    await dbWrite.transaction(async (tx) => {
      // 4. Insert normalized earnings record (source='thanks')
      await tx.insert(creatorEarnings).values({
        creatorId,
        bookId,
        pageId: pageId !== undefined ? pageId : null,
        readerId,
        source: "thanks",
        intakeAmount: grossAmount,
        intakeCurrency: normalizedIntakeCurrency,
        fxRate: appliedFxRate,
        settlementAmount: settlementGross,
        grossAmount: settlementGross,
        platformFee,
        creatorAmount,
        currency: targetCurrency,
        gateway,
        providerPaymentId: sessionId,
        providerEventId: eventId,
        stripeSessionId: sessionId,
        stripePaymentIntent: paymentIntentId,
        stripeEventId,
        status: "completed",
        message: message || null,
        metadata: {
          gateway,
          providerPaymentId: sessionId,
          providerEventId: eventId,
        },
      });

      // 5. Upsert creator wallet (atomic increment in creator's settlement currency)
      await tx
        .insert(creatorWallets)
        .values({
          creatorId,
          availableAmount: creatorAmount,
          currency: targetCurrency,
        })
        .onConflictDoUpdate({
          target: creatorWallets.creatorId,
          set: {
            availableAmount: sql`${creatorWallets.availableAmount} + ${creatorAmount}`,
            updatedAt: new Date(),
          },
        });
    });
  } catch (error) {
    // Handle race condition: another webhook processed the same event concurrently
    if (isUniqueConstraintError(error)) {
      return { duplicate: true };
    }
    throw error;
  }

  // 6. Notifications (non-blocking, best-effort, outside financial transaction)
  try {
    const [reader, book] = await Promise.all([
      dbRead.select({ name: users.name }).from(users).where(eq(users.userId, readerId)).limit(1),
      dbRead.select({ title: books.title }).from(books).where(eq(books.id, bookId)).limit(1),
    ]);

    const readerName = reader[0]?.name || "A reader";
    const bookTitle = book[0]?.title || "your story";

    await dbRead.insert(userNotifications).values({
      userId: creatorId,
      type: "thanks_received",
      title: "Thanks Received!",
      message: `${readerName} sent you a Thanks for "${bookTitle}"`,
      data: {
        readerId,
        readerName,
        bookId,
        bookTitle,
        grossAmount: settlementGross,
        creatorAmount,
        currency: targetCurrency,
        intakeAmount: grossAmount,
        intakeCurrency: normalizedIntakeCurrency,
      },
    });
  } catch (notifError) {
    console.error("[thanks] ⚠️ Failed to send notification:", getErrorMessage(notifError));
  }

  return { duplicate: false };
}

// ── Thanks Queries ──────────────────────────────────────────────────────────

/**
 * Gets aggregate Thanks stats for a book (public endpoint).
 * Only counts completed thanks with source='thanks'.
 */
export async function getBookThanksStats(bookId: string): Promise<{
  thanksCount: number;
  totalAmount: number;
  currency: "IDR" | "USD" | null;
}> {
  const [result] = await dbRead
    .select({
      thanksCount: sql<number>`count(*)::int`,
      totalAmount: sql<number>`coalesce(sum(${creatorEarnings.creatorAmount}), 0)::int`,
      currency: sql<"IDR" | "USD">`min(${creatorEarnings.currency})`,
    })
    .from(creatorEarnings)
    .where(
      and(
        eq(creatorEarnings.bookId, bookId),
        eq(creatorEarnings.status, "completed"),
        eq(creatorEarnings.source, "thanks"),
      ),
    );

  return {
    thanksCount: result?.thanksCount ?? 0,
    totalAmount: result?.totalAmount ?? 0,
    currency: result?.currency ?? null,
  };
}

/**
 * Checks if a reader has already sent Thanks to a creator for a specific book.
 */
export async function getMyThanksForBook(
  readerId: string,
  bookId: string,
): Promise<{ hasThanked: boolean; totalAmount: number; currency: "IDR" | "USD" | null }> {
  const [result] = await dbRead
    .select({
      hasThanked: sql<boolean>`count(*) > 0`,
      totalAmount: sql<number>`coalesce(sum(${creatorEarnings.creatorAmount}), 0)::int`,
      currency: sql<"IDR" | "USD">`min(${creatorEarnings.currency})`,
    })
    .from(creatorEarnings)
    .where(
      and(
        eq(creatorEarnings.readerId, readerId),
        eq(creatorEarnings.bookId, bookId),
        eq(creatorEarnings.status, "completed"),
        eq(creatorEarnings.source, "thanks"),
      ),
    );

  return {
    hasThanked: result?.hasThanked ?? false,
    totalAmount: result?.totalAmount ?? 0,
    currency: result?.currency ?? null,
  };
}
