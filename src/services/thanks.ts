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

  const platformFee = calculatePlatformFee(grossAmount);
  const creatorAmount = calculateCreatorAmount(grossAmount);

  // 1. Quick idempotency check before entering transaction
  const existing = await dbRead
    .select({ id: creatorEarnings.id })
    .from(creatorEarnings)
    .where(eq(creatorEarnings.stripeEventId, eventId))
    .limit(1);

  if (existing.length > 0) {
    return { duplicate: true };
  }

  try {
    await dbWrite.transaction(async (tx) => {
      // 2. Insert earnings record (source='thanks')
      await tx.insert(creatorEarnings).values({
        creatorId,
        bookId,
        pageId: pageId !== undefined ? pageId : null,
        readerId,
        source: "thanks",
        grossAmount,
        platformFee,
        creatorAmount,
        currency,
        stripeSessionId: sessionId,
        stripePaymentIntent: paymentIntentId,
        stripeEventId: eventId,
        status: "completed",
        message: message || null,
        metadata: {
          gateway,
          providerPaymentId: options.providerPaymentId || null,
          providerEventId: options.providerEventId || null,
        },
      });

      // 3. Upsert wallet (atomic increment, with currency for lazy-create)
      await tx
        .insert(creatorWallets)
        .values({
          creatorId,
          availableAmount: creatorAmount,
          currency,
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

  // 4. Notifications (non-blocking, best-effort, outside financial transaction)
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
        grossAmount,
        creatorAmount,
        currency,
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
}> {
  const [result] = await dbRead
    .select({
      thanksCount: sql<number>`count(*)::int`,
      totalAmount: sql<number>`coalesce(sum(${creatorEarnings.creatorAmount}), 0)::int`,
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
  };
}

/**
 * Checks if a reader has already sent Thanks to a creator for a specific book.
 */
export async function getMyThanksForBook(
  readerId: string,
  bookId: string,
): Promise<{ hasThanked: boolean; totalAmount: number }> {
  const [result] = await dbRead
    .select({
      hasThanked: sql<boolean>`count(*) > 0`,
      totalAmount: sql<number>`coalesce(sum(${creatorEarnings.creatorAmount}), 0)::int`,
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
  };
}
