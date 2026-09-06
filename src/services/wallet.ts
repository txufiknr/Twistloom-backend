/**
 * Creator Wallet Service
 *
 * Core business logic for creator wallet operations — balance management,
 * earnings ledger, payouts, and balance-to-credits conversion.
 * All wallet mutations are atomic via Postgres transactions.
 *
 * This service is the SSOT for creator balance. It is independent of any
 * specific earning source (thanks, revenue_share, etc.).
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 */

import { eq, sql, and, desc } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import {
  creatorEarnings,
  creatorWallets,
  creatorPayouts,
  creatorPayoutMethods,
  users,
  books,
  transactions,
  userNotifications,
} from "../db/schema.js";
import { THANKS_CONFIG } from "../config/thanks.js";
import { getXenditPackPriceIdr } from "../config/xendit.js";
import { CREDIT_PACKS } from "../config/credits.js";
import type { CreatorWallet, CreatorEarning, CreatorPayout, ConvertToCreditsResult, EarningSource, WalletCurrency } from "../types/wallet.js";

// ── Balance ──────────────────────────────────────────────────────────────────

/**
 * Gets or creates a creator's wallet. Lazily creates on first access.
 * When called from recordThanks, pass the currency so the wallet is created with the correct currency.
 */
export async function getCreatorWallet(creatorId: string, currency?: string): Promise<CreatorWallet> {
  const [wallet] = await dbRead
    .select()
    .from(creatorWallets)
    .where(eq(creatorWallets.creatorId, creatorId))
    .limit(1);

  if (wallet) {
    // Only run the aggregate when the wallet already exists
    const [summary] = await dbRead
      .select({
        lifetimeGross: sql<number>`coalesce(sum(${creatorEarnings.grossAmount}), 0)::int`,
        lifetimeFee: sql<number>`coalesce(sum(${creatorEarnings.platformFee}), 0)::int`,
      })
      .from(creatorEarnings)
      .where(eq(creatorEarnings.creatorId, creatorId));

    return {
      creatorId: wallet.creatorId,
      availableAmount: wallet.availableAmount,
      pendingAmount: wallet.pendingAmount,
      withdrawnAmount: wallet.withdrawnAmount,
      lifetimeGrossAmount: summary?.lifetimeGross || 0,
      lifetimeFeeAmount: summary?.lifetimeFee || 0,
      currency: wallet.currency,
      payoutVerified: wallet.payoutVerified,
      stripeConnectAccountId: wallet.stripeConnectAccountId,
    };
  }

  // Lazily create wallet on first access. If currency not provided, inspect user's locale.
  let defaultCurrency: WalletCurrency;
  if (currency === "USD" || currency === "IDR") {
    defaultCurrency = currency;
  } else {
    const [user] = await dbRead
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.userId, creatorId))
      .limit(1);
    defaultCurrency = user?.preferredLocale === "id" ? "IDR" : "USD";
  }

  const [created] = await dbWrite
    .insert(creatorWallets)
    .values({ creatorId, currency: defaultCurrency })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    // Another concurrent transaction created the wallet — re-fetch
    return getCreatorWallet(creatorId);
  }

  return {
    creatorId: created.creatorId,
    availableAmount: created.availableAmount,
    pendingAmount: created.pendingAmount,
    withdrawnAmount: created.withdrawnAmount,
    lifetimeGrossAmount: 0,
    lifetimeFeeAmount: 0,
    currency: created.currency,
    payoutVerified: created.payoutVerified,
    stripeConnectAccountId: created.stripeConnectAccountId,
  };
}

// ── Earnings Ledger ──────────────────────────────────────────────────────────

/**
 * Gets a creator's earnings history with book titles and reply status.
 * Optionally filters by earning source.
 */
export async function getCreatorEarnings(
  creatorId: string,
  limit = 20,
  offset = 0,
  source?: EarningSource,
): Promise<{ earnings: CreatorEarning[]; hasMore: boolean }> {
  const conditions = [eq(creatorEarnings.creatorId, creatorId)];
  if (source) {
    conditions.push(eq(creatorEarnings.source, source));
  }

  const rows = await dbRead
    .select({
      id: creatorEarnings.id,
      bookId: creatorEarnings.bookId,
      bookTitle: books.title,
      source: creatorEarnings.source,
      intakeAmount: creatorEarnings.intakeAmount,
      intakeCurrency: creatorEarnings.intakeCurrency,
      fxRate: creatorEarnings.fxRate,
      settlementAmount: creatorEarnings.settlementAmount,
      grossAmount: creatorEarnings.grossAmount,
      platformFee: creatorEarnings.platformFee,
      creatorAmount: creatorEarnings.creatorAmount,
      currency: creatorEarnings.currency,
      readerId: creatorEarnings.readerId,
      message: creatorEarnings.message,
      metadata: creatorEarnings.metadata,
      createdAt: creatorEarnings.createdAt,
    })
    .from(creatorEarnings)
    .leftJoin(books, eq(creatorEarnings.bookId, books.id))
    .where(and(...conditions))
    .orderBy(desc(creatorEarnings.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const earnings = rows.slice(0, limit);

  // Resolve reader names (batch)
  const readerIds = [...new Set(earnings.map((r) => r.readerId))];
  const readers = readerIds.length > 0
    ? await dbRead
        .select({ userId: users.userId, name: users.name })
        .from(users)
        .where(sql`${users.userId} IN ${readerIds}`)
    : [];
  const readerMap = new Map(readers.map((r) => [r.userId, r.name]));

  return {
    earnings: earnings.map((e) => {
      const meta = e.metadata as { reply?: string; replyAt?: string } | null;
      return {
        id: e.id,
        bookId: e.bookId,
        bookTitle: e.bookTitle,
        source: e.source as EarningSource,
        intakeAmount: e.intakeAmount,
        intakeCurrency: e.intakeCurrency,
        fxRate: e.fxRate,
        settlementAmount: e.settlementAmount,
        grossAmount: e.grossAmount,
        platformFee: e.platformFee,
        creatorAmount: e.creatorAmount,
        currency: e.currency,
        readerId: e.readerId,
        readerName: readerMap.get(e.readerId) || "A reader",
        message: e.message,
        reply: meta?.reply || null,
        replyAt: meta?.replyAt || null,
        createdAt: e.createdAt,
      };
    }),
    hasMore,
  };
}

/**
 * Replies to a reader's Thanks message.
 * Updates earning metadata and sends an in-app notification to the reader.
 */
export async function replyToCreatorEarning(
  creatorId: string,
  earningId: string,
  replyMessage: string
): Promise<{ success: boolean; reply: string; replyAt: string }> {
  const trimmed = replyMessage.trim();
  if (!trimmed) {
    throw new Error("Reply message cannot be empty");
  }
  if (trimmed.length > 500) {
    throw new Error("Reply message cannot exceed 500 characters");
  }

  const [earning] = await dbRead
    .select({
      id: creatorEarnings.id,
      creatorId: creatorEarnings.creatorId,
      readerId: creatorEarnings.readerId,
      bookId: creatorEarnings.bookId,
      metadata: creatorEarnings.metadata,
    })
    .from(creatorEarnings)
    .where(eq(creatorEarnings.id, earningId))
    .limit(1);

  if (!earning) {
    throw new Error("Earning record not found");
  }
  if (earning.creatorId !== creatorId) {
    throw new Error("Unauthorized to reply to this earning");
  }

  const replyAt = new Date().toISOString();
  const existingMeta = (earning.metadata as Record<string, unknown>) || {};
  const updatedMeta = {
    ...existingMeta,
    reply: trimmed,
    replyAt,
  };

  await dbWrite
    .update(creatorEarnings)
    .set({
      metadata: updatedMeta,
      updatedAt: new Date(),
    })
    .where(eq(creatorEarnings.id, earningId));

  // Fetch creator and book details for notification
  const [creatorUser] = await dbRead
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, creatorId))
    .limit(1);

  const [book] = earning.bookId
    ? await dbRead
        .select({ title: books.title, slug: books.slug })
        .from(books)
        .where(eq(books.id, earning.bookId))
        .limit(1)
    : [null];

  // Send in-app notification to reader (best-effort)
  try {
    await dbWrite.insert(userNotifications).values({
      userId: earning.readerId,
      type: "thanks_reply",
      title: `${creatorUser?.name || "The author"} replied to your Thanks!`,
      message: `"${trimmed}"`,
      data: {
        earningId,
        bookId: earning.bookId,
        bookSlug: book?.slug,
        bookTitle: book?.title,
        creatorName: creatorUser?.name,
        reply: trimmed,
      },
    });
  } catch (notifErr) {
    console.error("[wallet] ⚠️ Failed to send thanks reply notification:", notifErr);
  }

  return {
    success: true,
    reply: trimmed,
    replyAt,
  };
}


// ── Payout ──────────────────────────────────────────────────────────────────

/**
 * Initiates a payout request. In v0.5, this creates a pending payout record
 * for manual admin processing or automated disbursement. Validates minimum balance and payout verification.
 */
export async function initiatePayout(creatorId: string): Promise<CreatorPayout> {
  const [payout] = await dbWrite.transaction(async (tx) => {
    // 1. Lock wallet row to prevent concurrent double-spend
    const [wallet] = await tx
      .select({
        availableAmount: creatorWallets.availableAmount,
        payoutVerified: creatorWallets.payoutVerified,
        currency: creatorWallets.currency,
      })
      .from(creatorWallets)
      .where(eq(creatorWallets.creatorId, creatorId))
      .for("update")
      .limit(1);

    if (!wallet) throw new Error("WALLET_NOT_FOUND");
    if (!wallet.payoutVerified) throw new Error("PAYOUT_NOT_VERIFIED");

    const minimum = wallet.currency === "USD"
      ? THANKS_CONFIG.minimumWithdrawalUSD
      : THANKS_CONFIG.minimumWithdrawalIDR;

    if (wallet.availableAmount < minimum) {
      throw new Error("BELOW_MINIMUM");
    }

    const amount = wallet.availableAmount;

    // 2. Deduct from available balance and increment pending balance atomically
    const [updated] = await tx
      .update(creatorWallets)
      .set({
        availableAmount: sql`${creatorWallets.availableAmount} - ${amount}`,
        pendingAmount: sql`${creatorWallets.pendingAmount} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(creatorWallets.creatorId, creatorId))
      .returning();

    if (!updated || updated.availableAmount < 0) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    // 3. Create payout record with appropriate provider routing
    const provider = wallet.currency === "USD" ? "stripe" : "xendit";
    const [payout] = await tx
      .insert(creatorPayouts)
      .values({
        creatorId,
        amount,
        fee: 0,
        netAmount: amount,
        currency: wallet.currency as WalletCurrency,
        status: "pending",
        provider,
      })
      .returning();

    return [payout];
  });

  return {
    id: payout.id,
    amount: payout.amount,
    fee: payout.fee,
    netAmount: payout.netAmount,
    currency: payout.currency,
    status: payout.status,
    provider: payout.provider,
    createdAt: payout.createdAt,
  };
}

/**
 * Gets payout history for a creator.
 */
export async function getCreatorPayouts(
  creatorId: string,
  limit = 20,
): Promise<CreatorPayout[]> {
  const rows = await dbRead
    .select()
    .from(creatorPayouts)
    .where(eq(creatorPayouts.creatorId, creatorId))
    .orderBy(desc(creatorPayouts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    fee: r.fee,
    netAmount: r.netAmount,
    currency: r.currency,
    status: r.status,
    provider: r.provider,
    createdAt: r.createdAt,
  }));
}

/**
 * Saves or updates a creator's payout method (bank account or provider account).
 */
export async function savePayoutMethod(
  creatorId: string,
  methodType: "bank_transfer" | "e_wallet" | "stripe_connect",
  bankName: string,
  accountNumber: string,
  accountName: string,
  currency: WalletCurrency = "IDR",
  bankCode?: string,
): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Mark payout as verified (inside transaction for atomicity)
    await tx
      .update(creatorWallets)
      .set({ payoutVerified: true, updatedAt: new Date() })
      .where(eq(creatorWallets.creatorId, creatorId));

    // Upsert payout method (set all others as non-default)
    await tx
      .update(creatorPayoutMethods)
      .set({ isDefault: false })
      .where(eq(creatorPayoutMethods.creatorId, creatorId));

    await tx.insert(creatorPayoutMethods).values({
      creatorId,
      methodType,
      bankName,
      bankCode: bankCode || null,
      accountNumberEncrypted: accountNumber, // Stored encrypted in prod
      accountName,
      currency,
      isDefault: true,
      isVerified: true,
    });
  });
}

// ── Balance → Credits Conversion ────────────────────────────────────────────

/**
 * Converts wallet balance to credits atomically.
 * Deducts from creator_wallets.available_amount, adds to users.credits,
 * and inserts a 'conversion' transaction record — all in one Postgres TX.
 *
 * Supports both USD and IDR wallets:
 * 1. Pack conversion (packId provided): Uses pack's pricing (USD or IDR) and credit count.
 * 2. Custom conversion (amount provided): Uses flat rate for flexible amounts.
 */
export async function convertBalanceToCredits(
  creatorId: string,
  amount: number,
  packId?: string,
): Promise<ConvertToCreditsResult> {
  return await dbWrite.transaction(async (tx) => {
    // 1. Lock and read wallet to identify balance and currency
    const [wallet] = await tx
      .select({ availableAmount: creatorWallets.availableAmount, currency: creatorWallets.currency })
      .from(creatorWallets)
      .where(eq(creatorWallets.creatorId, creatorId))
      .for("update")
      .limit(1);

    if (!wallet) throw new Error("WALLET_NOT_FOUND");

    let creditsToAdd: number;
    let deductedAmount: number;
    const resolvedPackId = packId;

    if (wallet.currency === "USD") {
      // ── USD Wallet Conversion ─────────────────────────────────────────────
      if (packId) {
        const pack = CREDIT_PACKS.find((p) => p.id === packId);
        if (!pack) {
          throw new Error("INVALID_PACK");
        }
        if (!pack.priceUSD) {
          throw new Error("PACK_NOT_AVAILABLE_IN_CURRENCY");
        }
        creditsToAdd = pack.credits;
        deductedAmount = Math.round(pack.priceUSD * 100); // USD cents
      } else {
        if (amount <= 0) throw new Error("INVALID_AMOUNT");
        if (amount < THANKS_CONFIG.minConversionAmountUSD) throw new Error("BELOW_MINIMUM");

        creditsToAdd = Math.floor(amount / THANKS_CONFIG.usdCentsPerCredit);
        if (creditsToAdd <= 0) throw new Error("AMOUNT_TOO_LOW");
        deductedAmount = Math.round(creditsToAdd * THANKS_CONFIG.usdCentsPerCredit);
      }
    } else {
      // ── IDR Wallet Conversion ─────────────────────────────────────────────
      if (packId) {
        const packCredits = CREDIT_PACKS.find((p) => p.id === packId)?.credits;
        const packPriceIdr = getXenditPackPriceIdr(packId);
        if (!packCredits) {
          throw new Error("INVALID_PACK");
        }
        if (!packPriceIdr) {
          throw new Error("PACK_NOT_AVAILABLE_IN_CURRENCY");
        }
        creditsToAdd = packCredits;
        deductedAmount = packPriceIdr;
      } else {
        if (amount <= 0) throw new Error("INVALID_AMOUNT");
        if (amount < THANKS_CONFIG.minConversionAmountIDR) throw new Error("BELOW_MINIMUM");

        creditsToAdd = Math.floor(amount / THANKS_CONFIG.idrPerCredit);
        if (creditsToAdd <= 0) throw new Error("AMOUNT_TOO_LOW");
        deductedAmount = creditsToAdd * THANKS_CONFIG.idrPerCredit;
      }
    }

    if (wallet.availableAmount < deductedAmount) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    // 2. Deduct from wallet
    await tx
      .update(creatorWallets)
      .set({
        availableAmount: sql`${creatorWallets.availableAmount} - ${deductedAmount}`,
        updatedAt: new Date(),
      })
      .where(eq(creatorWallets.creatorId, creatorId));

    // 3. Add credits to user
    const [user] = await tx
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, creatorId))
      .for("update")
      .limit(1);

    if (!user) throw new Error("USER_NOT_FOUND");

    await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${creditsToAdd}`, updatedAt: new Date() })
      .where(eq(users.userId, creatorId));

    // 4. Insert transaction record
    await tx.insert(transactions).values({
      userId: creatorId,
      type: "conversion",
      credits: creditsToAdd,
      amountCents: deductedAmount,
      context: "wallet_to_credits",
      metadata: {
        amount: deductedAmount,
        currency: wallet.currency,
        packId: resolvedPackId,
      },
      createdAt: new Date(),
    });

    return {
      converted: deductedAmount,
      creditsAdded: creditsToAdd,
      newBalance: wallet.availableAmount - deductedAmount,
      newCredits: (user.credits ?? 0) + creditsToAdd,
      packId: resolvedPackId,
    };
  });
}
