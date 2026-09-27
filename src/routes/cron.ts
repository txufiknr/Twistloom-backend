/**
 * Cron / Scheduled Tasks Routes
 *
 * Exposes secured endpoints for scheduled platform maintenance,
 * risk maturation holds, and automated disbursement reconciliations.
 *
 * Secured by CRON_SECRET header (Authorization: Bearer <token> or x-cron-secret).
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 * @see docs/roadmap/CREATOR_PAYOUT_DISBURSEMENT_PIPELINE_ROADMAP.md
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { cApiError } from "../utils/error.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { maturePendingEarnings } from "../services/maturation.js";
import { processPendingPayouts } from "../services/disbursement.js";
import { evaluateTrustScores } from "../cron/evaluate-trust.js";
import { runCreditReservationSweep } from "../services/credit-reservations.js";

const router = new Hono<AppEnv>();

/**
 * Middleware: Verify CRON_SECRET header
 *
 * Enforces token authentication via Authorization: Bearer <token> or x-cron-secret header.
 * If CRON_SECRET is configured, constant-time validation is strictly enforced.
 * If CRON_SECRET is unset, access is strictly forbidden in all environments except
 * explicit local development or automated test runs.
 */
router.use("*", async (c, next) => {
  const cronSecret = process.env.CRON_SECRET;
  const isLocalDevOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

  // 1. If CRON_SECRET is configured, strictly authenticate the request with constant-time equality
  if (cronSecret) {
    const authHeader = c.req.header("authorization");
    const customHeader = c.req.header("x-cron-secret");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const providedToken = bearerToken || customHeader?.trim();

    if (!providedToken || !constantTimeEqual(providedToken, cronSecret)) {
      return c.json({ success: false, error: "Unauthorized: Invalid cron secret" }, 401);
    }
    return await next();
  }

  // 2. If CRON_SECRET is unset, strictly forbid execution outside development and test
  if (!isLocalDevOrTest) {
    return c.json(
      {
        success: false,
        error: "CRON_SECRET not configured on server",
      },
      500
    );
  }

  await next();
});

/**
 * GET /api/cron/probe
 *
 * Probe endpoint to verify cron service connectivity and header authentication
 * without triggering any state-mutating background jobs.
 */
router.get("/probe", (c) => {
  return c.json({
    success: true,
    message: "Cron service reachable",
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/cron/mature-earnings
 *
 * Runs the earnings maturation engine to transition mature held earnings
 * from 'pending' to 'completed' and atomically move funds from
 * creatorWallets.pendingAmount to creatorWallets.availableAmount.
 */
router.post("/mature-earnings", async (c) => {
  try {
    const result = await maturePendingEarnings();
    return c.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return cApiError(c, "Failed to mature pending earnings", error);
  }
});

/**
 * POST /api/cron/process-disbursements
 *
 * Runs the automated payout disbursement engine to batch pending payouts,
 * dispatch to payment rails (Xendit), and update tracking state.
 */
router.post("/process-disbursements", async (c) => {
  try {
    const result = await processPendingPayouts();
    return c.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return cApiError(c, "Failed to process payout disbursements", error);
  }
});

/**
 * POST /api/cron/evaluate-trust
 *
 * Runs the daily trust score evaluation engine to re-evaluate all users
 * with active enforcement actions or recent violation events. Applies
 * exponential time-decay, recalculates risk tiers, and sets probation periods.
 *
 * Schedule: Daily 04:00 UTC (off-peak)
 */
router.post("/evaluate-trust", async (c) => {
  try {
    await evaluateTrustScores();
    return c.json({
      success: true,
      message: "Trust score evaluation complete",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return cApiError(c, "Failed to evaluate trust scores", error);
  }
});

/**
 * POST|GET /api/cron/sweep-credit-reservations
 *
 * Refunds leaked `type='reserve'` credit reservations older than
 * CREDIT_RESERVATION_TTL_MS — the safety net for a process crash between
 * `reserveCredits` and settle/release (roadmap §3.1 step 4).
 *
 * Both methods are registered deliberately:
 * - `POST` — the Upstash QStash schedule (current trigger, every 10 min).
 * - `GET`  — Vercel Cron sends GET, ready for the Pro-plan migration.
 *
 * Responds 500 when any refund fails so the scheduler retries (QStash: 3
 * retries on the free plan, then the DLQ). `scanned > 0` still returns 200 —
 * it means leaks happened but were successfully refunded.
 *
 * @see docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md — §4 leak sweeper
 */
async function handleSweepCreditReservations(c: Context<AppEnv>) {
  try {
    const result = await runCreditReservationSweep();
    const timestamp = new Date().toISOString();

    if (result.failed > 0) {
      return c.json(
        {
          success: false,
          error: `Failed to refund ${result.failed} credit reservation(s) — will retry on the next run`,
          data: result,
          timestamp,
        },
        500
      );
    }

    return c.json({ success: true, data: result, timestamp });
  } catch (error) {
    return cApiError(c, "Failed to sweep credit reservations", error);
  }
}

router.post("/sweep-credit-reservations", handleSweepCreditReservations);
router.get("/sweep-credit-reservations", handleSweepCreditReservations);

export default router;
