/**
 * @overview 🛒 Consumable Items Routes
 *
 * Generic, registry-driven purchase + catalog endpoints for credit-bought
 * consumables (e.g. the 📣 Megaphone). Decoupled from the broadcast feature so
 * any future item can be bought through the same surface.
 *
 * Endpoints:
 * - GET  /api/consumables        — public catalog of purchasable items
 * - POST /api/consumables/purchase — buy one or more units with credits (auth)
 *
 * Prices, names, and availability live in `CONSUMABLES_REGISTRY`
 * (`src/config/consumables.ts`) — the single source of truth. Purchasing debits
 * `creditsPrice` credits via `executeWithCredits` and increments the user's
 * `user_inventory`; spending the item later only decrements inventory.
 *
 * @see src/services/broadcast.ts (`purchaseConsumable`)
 * @see src/config/consumables.ts
 */

import { Hono } from "hono";
import type { AppEnv } from "../hono/env.js";
import { requireAuth } from "../middleware/nextauth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { cApiError, cValidationError } from "../utils/error.js";
import { isValidUuid } from "../utils/uuid.js";
import {
  purchaseConsumableBatch,
  getUserItemCount,
  checkDivergence,
  dropMemoryAnchor,
  getStoryAnchors,
  deleteStoryAnchor,
  activateDangerSight,
  getDangerSightStatus,
  ConsumableError,
  cConsumableError,
} from "../services/consumables.js";
import { CONSUMABLES_REGISTRY, CONSUMABLES_BY_TYPE } from "../config/consumables.js";
import type { InventoryItemType } from "../types/consumable.js";
import { CONSUMABLE_PURCHASE_RATE_LIMIT } from "../config/ai-rate-limits.js";

const router = new Hono<AppEnv>();

/**
 * GET /api/consumables
 *
 * Public catalog of every purchasable consumable, in registry display order.
 * Clients use this to render the shop; the `available` flag hides disabled
 * items. Credit prices shown are the registry defaults (demo users still pay 0
 * at purchase time, handled upstream by `getCreditCostForUser`).
 *
 * @route GET /api/consumables
 * @auth None
 *
 * @returns {Array} items - One entry per registry item
 * @returns {string} items[].type - Inventory item key
 * @returns {string} items[].name - Display name
 * @returns {string} items[].description - User-facing description
 * @returns {string|undefined} items[].icon - Glyph
 * @returns {number} items[].creditsPrice - Credit cost to buy one unit
 * @returns {boolean} items[].available - Currently purchasable?
 * @returns {number|undefined} items[].maxPerUser - Optional per-user cap
 */
router.get("/", async (c) => {
  try {
    const purchasableItems = CONSUMABLES_REGISTRY.filter((def) => def.available);
    return c.json({ items: purchasableItems });
  } catch (error) {
    console.error("[GET /api/consumables] ❌ Error:", error);
    return cApiError(c, "Failed to load consumables catalog", error);
  }
});

/**
 * POST /api/consumables/purchase
 *
 * Buys one or more units of the requested consumable. Charges the registry-defined
 * credit price × quantity via `executeWithCredits` (atomic) and increments the
 * user's `user_inventory` in a single DB transaction. If the inventory write fails,
 * `executeWithCredits` auto-refunds the credits. Rejected/unavailable items cost
 * nothing.
 *
 * @route POST /api/consumables/purchase
 * @auth Required
 * @body {string} itemType - Registry item key (e.g. `"megaphone"`)
 * @body {number} [quantity=1] - Units to purchase (1–99)
 * @returns `{ itemType, quantity, purchased }` — new owned quantity and units bought
 *
 * @example
 * POST /api/consumables/purchase
 * { "itemType": "megaphone", "quantity": 2 }
 * // Response
 * { "itemType": "megaphone", "quantity": 4, "purchased": 2 }
 */
router.post(
  "/purchase",
  requireAuth,
  rateLimit(CONSUMABLE_PURCHASE_RATE_LIMIT),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const { itemType, quantity: rawQty } = c.get("body") as {
        itemType?: unknown;
        quantity?: unknown;
      };

      if (
        typeof itemType !== "string" ||
        !Object.prototype.hasOwnProperty.call(CONSUMABLES_BY_TYPE, itemType)
      ) {
        return cValidationError(c, "itemType is required and must be a valid consumable");
      }

      const type = itemType as InventoryItemType;
      const def = CONSUMABLES_BY_TYPE[type];

      if (!def.available) {
        return cValidationError(c, `${def.name} is not available for purchase`);
      }

      const quantity = Math.max(1, Math.min(99, Number(rawQty) || 1));

      if (def.maxPerUser !== undefined) {
        const owned = await getUserItemCount(userId, type);
        if (owned + quantity > def.maxPerUser) {
          return cValidationError(
            c,
            `Cannot buy ${quantity} × ${def.name} — you already own ${owned}, max is ${def.maxPerUser}`,
          );
        }
      }

      const newQuantity = await purchaseConsumableBatch(userId, type, quantity);
      return c.json({ itemType: type, quantity: newQuantity, purchased: quantity });
    } catch (error) {
      console.error("[POST /api/consumables/purchase] ❌ Error:", error);
      return cApiError(c, "Failed to purchase consumable", error);
    }
  }
);

/**
 * POST /api/consumables/divergence-check
 *
 * Evaluates which branch choices on the current page have not yet been explored.
 * Deducts 1 Divergence Compass and returns unvisited choice indices/texts.
 *
 * @route POST /api/consumables/divergence-check
 * @auth Required
 * @body {string} bookId - Book ID
 * @body {string} pageId - Page ID
 */
router.post(
  "/divergence-check",
  requireAuth,
  rateLimit({
    windowSeconds: 60,
    maxRequests: 20,
    message: "Please wait before using another Divergence Compass.",
    prefix: "divergence-check",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const body = ((c.get("body") as Record<string, unknown>) ||
        (await c.req.json().catch(() => ({})))) as { bookId?: unknown; pageId?: unknown };

      const { bookId, pageId } = body;

      if (!bookId || typeof bookId !== "string") {
        return cValidationError(c, "bookId is required");
      }
      if (!pageId || typeof pageId !== "string") {
        return cValidationError(c, "pageId is required");
      }
      if (!isValidUuid(bookId)) {
        return cValidationError(c, "bookId must be a valid UUID");
      }
      if (!isValidUuid(pageId)) {
        return cValidationError(c, "pageId must be a valid UUID");
      }

      const result = await checkDivergence(userId, bookId, pageId);
      return c.json(result);
    } catch (error) {
      if (error instanceof ConsumableError) {
        return cConsumableError(c, error);
      }
      console.error("[POST /api/consumables/divergence-check] ❌ Error:", error);
      return cApiError(c, "Failed to check divergence", error);
    }
  }
);

/**
 * POST /api/consumables/anchors
 *
 * Drops a Memory Anchor bookmark at the current page/fork.
 * Deducts 1 Memory Anchor item. Stores up to 3 anchors per book.
 *
 * @route POST /api/consumables/anchors
 * @auth Required
 * @body {string} bookId - Book ID
 * @body {string} pageId - Page ID
 * @body {number} pageNumber - Page number
 * @body {string} [choicePrompt] - Optional choice description
 */
router.post(
  "/anchors",
  requireAuth,
  rateLimit({
    windowSeconds: 60,
    maxRequests: 20,
    message: "Please wait before dropping another Memory Anchor.",
    prefix: "drop-anchor",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const body = ((c.get("body") as Record<string, unknown>) ||
        (await c.req.json().catch(() => ({})))) as {
        bookId?: unknown;
        pageId?: unknown;
        pageNumber?: unknown;
        choicePrompt?: unknown;
      };

      const { bookId, pageId, pageNumber: rawPageNumber, choicePrompt } = body;

      if (!bookId || typeof bookId !== "string") {
        return cValidationError(c, "bookId is required");
      }
      if (!pageId || typeof pageId !== "string") {
        return cValidationError(c, "pageId is required");
      }
      if (!isValidUuid(bookId)) {
        return cValidationError(c, "bookId must be a valid UUID");
      }
      if (!isValidUuid(pageId)) {
        return cValidationError(c, "pageId must be a valid UUID");
      }

      const pageNumber = Number(rawPageNumber) || 1;
      const prompt = typeof choicePrompt === "string" ? choicePrompt : undefined;

      const result = await dropMemoryAnchor(userId, bookId, pageId, pageNumber, prompt);
      return c.json(result);
    } catch (error) {
      if (error instanceof ConsumableError) {
        return cConsumableError(c, error);
      }
      console.error("[POST /api/consumables/anchors] ❌ Error:", error);
      return cApiError(c, "Failed to drop Memory Anchor", error);
    }
  }
);

/**
 * GET /api/consumables/anchors
 *
 * Retrieves all saved Memory Anchors for the user in the specified book.
 *
 * @route GET /api/consumables/anchors
 * @auth Required
 * @query {string} bookId - Book ID
 */
router.get("/anchors", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const bookId = c.req.query("bookId");

    if (!bookId) {
      return cValidationError(c, "bookId is required query parameter");
    }
    // A malformed uuid would reach Postgres and surface as a cast error
    // (500). Reject as a validation failure first (isValidUuid convention).
    if (!isValidUuid(bookId)) {
      return cValidationError(c, "bookId must be a valid UUID");
    }

    const anchors = await getStoryAnchors(userId, bookId);
    return c.json({ anchors });
  } catch (error) {
    console.error("[GET /api/consumables/anchors] ❌ Error:", error);
    return cApiError(c, "Failed to fetch memory anchors", error);
  }
});

/**
 * DELETE /api/consumables/anchors/:anchorId
 *
 * Removes a saved Memory Anchor.
 *
 * @route DELETE /api/consumables/anchors/:anchorId
 * @auth Required
 */
router.delete("/anchors/:anchorId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const anchorId = c.req.param("anchorId");

    if (!anchorId) {
      return cValidationError(c, "anchorId is required");
    }
    if (!isValidUuid(anchorId)) {
      return cValidationError(c, "anchorId must be a valid UUID");
    }

    const result = await deleteStoryAnchor(userId, anchorId);
    return c.json(result);
  } catch (error) {
    console.error("[DELETE /api/consumables/anchors/:anchorId] ❌ Error:", error);
    return cApiError(c, "Failed to delete memory anchor", error);
  }
});

/**
 * POST /api/consumables/danger-sight/activate
 *
 * Activates 1 Danger Sight for a book session: rejects with a code-driven
 * conflict while the stored page range still covers the activation page (no
 * stacking / no double-spend), deducts 1 `item_danger_sight`, and stamps
 * `user_sessions.danger_sight_from_page` so the covered window becomes the
 * positional range `[page, page + DANGER_SIGHT_DURATION_PAGES - 1]` of that
 * book. Reader-context only — `bookId` + `pageId` are required (page numbers
 * are meaningless outside one book, which is why Dashboard → Inventory shows
 * the "activate in the reader" fallback instead of a Use handler).
 *
 * The error body is code-driven: the client translates `code` via next-intl
 * (`consumables.errors.<key>`); the English `error` field is fallback only.
 *
 * @route POST /api/consumables/danger-sight/activate
 * @auth Required
 * @body {string} bookId - Book whose reading session the range binds to
 * @body {string} pageId - Current page; its page number becomes the range start
 * @returns `{ fromPage, toPage, remainingItems }`
 */
router.post(
  "/danger-sight/activate",
  requireAuth,
  rateLimit({
    windowSeconds: 60,
    maxRequests: 10,
    message: "Please wait before activating another Danger Sight.",
    prefix: "danger-sight-activate",
  }),
  async (c) => {
    try {
      const userId = c.get("userId")!;
      const body = ((c.get("body") as Record<string, unknown>) ||
        (await c.req.json().catch(() => ({})))) as { bookId?: unknown; pageId?: unknown };

      const { bookId, pageId } = body;
      if (!bookId || typeof bookId !== "string") {
        return cValidationError(c, "bookId is required");
      }
      if (!pageId || typeof pageId !== "string") {
        return cValidationError(c, "pageId is required");
      }
      // Malformed uuids would reach Postgres and surface as a cast error
      // (500). Reject them here as validation failures, matching the
      // isValidUuid convention used across books.ts/user.ts.
      if (!isValidUuid(bookId)) {
        return cValidationError(c, "bookId must be a valid UUID");
      }
      if (!isValidUuid(pageId)) {
        return cValidationError(c, "pageId must be a valid UUID");
      }

      const result = await activateDangerSight(userId, bookId, pageId);
      return c.json(result);
    } catch (error) {
      if (error instanceof ConsumableError) {
        return cConsumableError(c, error);
      }
      console.error("[POST /api/consumables/danger-sight/activate] ❌ Error:", error);
      return cApiError(c, "Failed to activate Danger Sight", error);
    }
  }
);

/**
 * GET /api/consumables/danger-sight/status
 *
 * Reads the Danger Sight page range for one book's reading session. The
 * client derives the badge gate purely from its current page number against
 * `[fromPage, toPage]` — no countdown timers, no polling loop, no per-page
 * server write. The range is returned **as stored**, even when the reader is
 * already past `toPage` (the server does not know the current page), so
 * non-null never implies active — only the client's in-range check does.
 *
 * @route GET /api/consumables/danger-sight/status
 * @auth Required
 * @query {string} bookId - Book whose session to read
 * @returns `{ fromPage, toPage }` (both `null` only when no window is stored)
 */
router.get("/danger-sight/status", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const bookId = c.req.query("bookId");
    if (!bookId) {
      return cValidationError(c, "bookId is required query parameter");
    }
    if (!isValidUuid(bookId)) {
      return cValidationError(c, "bookId must be a valid UUID");
    }
    const result = await getDangerSightStatus(userId, bookId);
    return c.json(result);
  } catch (error) {
    console.error("[GET /api/consumables/danger-sight/status] ❌ Error:", error);
    return cApiError(c, "Failed to get Danger Sight status", error);
  }
});

export default router;

