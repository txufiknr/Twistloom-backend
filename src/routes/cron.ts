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
import type { AppEnv } from "../hono/env.js";
import { cApiError } from "../utils/error.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { maturePendingEarnings } from "../services/maturation.js";
import { processPendingPayouts } from "../services/disbursement.js";

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

export default router;
