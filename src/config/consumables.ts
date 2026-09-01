/**
 * Consumable Items Registry — Single Source of Truth (SSOT).
 *
 * Every purchasable, credit-bought consumable a user can own is defined here,
 * modelled after `CAST_REGISTRY` in `src/config/cast.ts`. The registry (not the
 * credits config) is the authoritative source for an item's `creditsPrice`,
 * display name, and availability. Purchasing debits `creditsPrice` credits via
 * `executeWithCredits` and increments the user's `user_inventory` row; spending
 * the item (e.g. broadcasting) only decrements inventory and never touches
 * credits again.
 *
 * @see src/db/schema.ts (`user_inventory`) for storage
 * @see src/services/broadcast.ts for the Megaphone purchase / spend flow
 */

import type { InventoryItemType, ConsumableItemDefinition } from "../types/consumable.js";
export type { ConsumableItemDefinition };

/**
 * The registry of all purchasable consumables. Keep entries ordered by
 * display priority. Add new items here (and to {@link InventoryItemType}).
 */
export const CONSUMABLES_REGISTRY: ConsumableItemDefinition[] = [
  {
    type: "megaphone",
    name: "📣 Megaphone",
    description:
      "Broadcast a short message to every reader for a few seconds. Runs AI moderation before it goes live.",
    creditsPrice: 100,
    available: true,
    accountBound: false,
    icon: "📣",
  },
  {
    type: "easter_egg",
    name: "🥚 Easter Egg",
    description:
      "A mysterious egg uncovered from the depths of a story. Crack it open to reveal credits, consumables, or rare lore rewards.",
    creditsPrice: 0,
    available: false,
    accountBound: true,
    icon: "🥚",
  },
];

/** Fast lookup by `type`. */
export const CONSUMABLES_BY_TYPE: Record<InventoryItemType, ConsumableItemDefinition> =
  Object.fromEntries(CONSUMABLES_REGISTRY.map((item) => [item.type, item])) as Record<
    InventoryItemType,
    ConsumableItemDefinition
  >;

/**
 * Returns a consumable definition by type.
 *
 * @throws Error if the type is unknown (defensive: registry must stay in sync
 *   with {@link InventoryItemType}).
 */
export function getConsumable(type: InventoryItemType): ConsumableItemDefinition {
  const def = CONSUMABLES_BY_TYPE[type];
  if (!def) {
    throw new Error(`Unknown consumable item type: ${type}`);
  }
  return def;
}

/**
 * Returns the credit price for one unit of a consumable (registry-driven).
 * Free-demo handling is applied upstream by `getCreditCostForUser`.
 */
export function getConsumableCreditsPrice(type: InventoryItemType): number {
  return getConsumable(type).creditsPrice;
}
