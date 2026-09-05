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
import { purchaseConsumableBatch, getUserItemCount } from "../services/consumables.js";
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

export default router;
