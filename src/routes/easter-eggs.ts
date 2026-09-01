/**
 * @overview 🥚 Easter Egg Discovery Routes
 *
 * Authenticated endpoints for:
 * - GET  /api/easter-eggs/check — lightweight runtime dice roll on page navigation
 * - POST /api/easter-eggs/claim — claim an egg using a signed claim token
 * - POST /api/easter-eggs/crack — crack open an owned egg for a mystery reward
 *
 * Rate limiting:
 * - /check: max 2 requests / sec (defeat rapid flipping / crawler bots)
 * - /claim: max 5 requests / min
 * - /crack: max 10 requests / min
 *
 * @see src/services/easter-eggs.ts
 */

import { Hono } from "hono";
import type { AppEnv } from "../hono/env.js";
import { requireAuth } from "../middleware/nextauth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { cApiError, cValidationError } from "../utils/error.js";
import {
  checkEasterEgg,
  claimEasterEgg,
  crackEasterEgg,
} from "../services/easter-eggs.js";

const router = new Hono<AppEnv>();

/**
 * GET /api/easter-eggs/check
 *
 * Evaluates whether an Easter Egg appears on this page navigation.
 * Server rolls dice opacity-safe; returns signed claim token on hit.
 *
 * @route GET /api/easter-eggs/check
 * @auth Required
 * @query {string} bookId - Book ID
 * @query {string} pageId - Current page ID
 * @query {number} paragraphCount - Count of paragraphs rendered on page
 */
router.get(
  "/check",
  requireAuth,
  rateLimit({
    windowSeconds: 1,
    maxRequests: 2,
    message: "Too many page check requests. Please slow down.",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const bookId = c.req.query("bookId");
      const pageId = c.req.query("pageId");
      const rawCount = c.req.query("paragraphCount");
      const paragraphCount = rawCount ? parseInt(rawCount, 10) : 3;

      if (!bookId || !pageId) {
        return cValidationError(c, "bookId and pageId are required query parameters");
      }

      const result = await checkEasterEgg(userId, bookId, pageId, isNaN(paragraphCount) ? 3 : paragraphCount);
      return c.json(result);
    } catch (error) {
      console.error("[GET /api/easter-eggs/check] ❌ Error:", error);
      return cApiError(c, "Failed to evaluate Easter Egg spawn", error);
    }
  }
);

/**
 * POST /api/easter-eggs/claim
 *
 * Claims a discovered Easter Egg using a verified signed token.
 *
 * @route POST /api/easter-eggs/claim
 * @auth Required
 * @body {string} claimToken - Signed claim token returned by /check
 */
router.post(
  "/claim",
  requireAuth,
  rateLimit({
    windowSeconds: 60,
    maxRequests: 10,
    message: "Too many claim attempts. Please wait.",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const body = (await c.req.json().catch(() => ({}))) as { claimToken?: unknown };
      const { claimToken } = body;

      if (!claimToken || typeof claimToken !== "string") {
        return cValidationError(c, "claimToken is required");
      }

      const result = await claimEasterEgg(userId, claimToken);
      return c.json(result);
    } catch (error) {
      console.error("[POST /api/easter-eggs/claim] ❌ Error:", error);
      return cApiError(c, "Failed to claim Easter Egg", error);
    }
  }
);

/**
 * POST /api/easter-eggs/crack
 *
 * Cracks open 1 owned Easter Egg to draw a weighted mystery prize.
 *
 * @route POST /api/easter-eggs/crack
 * @auth Required
 */
router.post(
  "/crack",
  requireAuth,
  rateLimit({
    windowSeconds: 60,
    maxRequests: 20,
    message: "Please wait before cracking another egg.",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const result = await crackEasterEgg(userId);
      return c.json(result);
    } catch (error) {
      console.error("[POST /api/easter-eggs/crack] ❌ Error:", error);
      return cApiError(c, "Failed to crack Easter Egg", error);
    }
  }
);

export default router;
