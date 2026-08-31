/**
 * Creator Wallet Routes (Hono)
 *
 * Balance queries, earnings ledger, payout requests, and balance-to-credits
 * conversion. These routes are the SSOT for all wallet operations.
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/nextauth.js";
import { THANKS_CONFIG } from "../config/thanks.js";
import {
  getCreatorWallet,
  getCreatorEarnings,
  replyToCreatorEarning,
  initiatePayout,
  getCreatorPayouts,
  savePayoutMethod,
  convertBalanceToCredits,
} from "../services/wallet.js";
import {
  cApiError,
  cValidationError,
} from "../utils/error.js";
import type { AppEnv } from "../hono/env.js";
import type { EarningSource } from "../types/wallet.js";

const VALID_SOURCES: EarningSource[] = ["thanks", "revenue_share", "custom_action", "other"];

const router = new Hono<AppEnv>();

// ── GET /wallet ──────────────────────────────────────────────────────────────

/**
 * Returns the creator's wallet balance and earnings summary.
 */
router.get("/", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const wallet = await getCreatorWallet(userId);
    return c.json(wallet);
  } catch (error) {
    return cApiError(c, "Failed to fetch wallet", error);
  }
});

// ── GET /wallet/earnings ─────────────────────────────────────────────────────

/**
 * Returns the creator's earnings history with pagination.
 * Optional `source` query param to filter by earning source.
 */
router.get("/earnings", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20"), 1), 100);
    const offset = Math.max(parseInt(c.req.query("offset") || "0"), 0);
    const rawSource = c.req.query("source");
    const source = rawSource && VALID_SOURCES.includes(rawSource as EarningSource)
      ? (rawSource as EarningSource)
      : undefined;

    const result = await getCreatorEarnings(userId, limit, offset, source);
    return c.json(result);
  } catch (error) {
    return cApiError(c, "Failed to fetch earnings", error);
  }
});

// ── POST /wallet/earnings/:earningId/reply ───────────────────────────────────

/**
 * Sends a personal creator reply/acknowledgement to a reader's Thanks message.
 */
router.post("/earnings/:earningId/reply", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const earningId = c.req.param("earningId");
    const { reply } = c.get("body");

    if (!reply || typeof reply !== "string" || !reply.trim()) {
      return cValidationError(c, "Reply message cannot be empty");
    }

    if (reply.trim().length > 500) {
      return cValidationError(c, "Reply message cannot exceed 500 characters");
    }

    const result = await replyToCreatorEarning(userId, earningId, reply);
    return c.json(result);
  } catch (error: any) {
    if (error.message === "Unauthorized to reply to this earning") {
      return cValidationError(c, error.message);
    }
    if (error.message === "Earning record not found") {
      return cValidationError(c, error.message);
    }
    return cApiError(c, "Failed to send reply", error);
  }
});


// ── POST /wallet/withdraw ────────────────────────────────────────────────────

/**
 * Initiates a full-balance payout withdrawal for the creator.
 */
router.post("/withdraw", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  try {
    const payout = await initiatePayout(userId);
    return c.json({ success: true, payout });
  } catch (error: any) {
    if (error.message === "PAYOUT_NOT_VERIFIED") {
      return cValidationError(c, "Please set up your payout method first");
    }
    if (error.message === "BELOW_MINIMUM") {
      const wallet = await getCreatorWallet(userId);
      const minAmount = wallet.currency === "USD"
        ? THANKS_CONFIG.minimumWithdrawalUSD
        : THANKS_CONFIG.minimumWithdrawalIDR;
      return cValidationError(c, `Minimum withdrawal is ${minAmount} ${wallet.currency}`);
    }
    if (error.message === "INSUFFICIENT_BALANCE") {
      return cValidationError(c, "Insufficient balance for withdrawal");
    }
    return cApiError(c, "Failed to initiate withdrawal", error);
  }
});

// ── POST /wallet/convert-to-credits ──────────────────────────────────────────

/**
 * Converts wallet balance to credits at the configured rate.
 */
router.post("/convert-to-credits", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const { amount } = c.get("body");

    if (!amount || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return cValidationError(c, "amount must be a positive number (IDR)");
    }

    const result = await convertBalanceToCredits(userId, amount);
    return c.json(result);
  } catch (error: any) {
    if (error.message === "BELOW_MINIMUM") {
      return cValidationError(c, `Minimum conversion is ${THANKS_CONFIG.minConversionAmountIDR} IDR`);
    }
    if (error.message === "AMOUNT_TOO_LOW") {
      return cValidationError(c, "Amount too low to convert to any credits");
    }
    if (error.message === "INSUFFICIENT_BALANCE") {
      return cValidationError(c, "Insufficient wallet balance");
    }
    return cApiError(c, "Failed to convert balance to credits", error);
  }
});

// ── GET /wallet/payouts ──────────────────────────────────────────────────────

/**
 * Returns payout history for the creator.
 */
router.get("/payouts", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const limit = parseInt(c.req.query("limit") || "20");
    const payouts = await getCreatorPayouts(userId, limit);
    return c.json({ payouts });
  } catch (error) {
    return cApiError(c, "Failed to fetch payouts", error);
  }
});

// ── POST /wallet/payout-method ───────────────────────────────────────────────

/**
 * Saves or updates the creator's payout method (bank account).
 */
router.post("/payout-method", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const { methodType, bankName, accountNumber, accountName } = c.get("body");

    if (!methodType || !bankName || !accountNumber || !accountName) {
      return cValidationError(c, "All fields are required: methodType, bankName, accountNumber, accountName");
    }

    await savePayoutMethod(userId, methodType, bankName, accountNumber, accountName);
    return c.json({ success: true, message: "Payout method saved" });
  } catch (error) {
    return cApiError(c, "Failed to save payout method", error);
  }
});

export default router;
