/**
 * Consumable Items & User Inventory shared types.
 *
 * Models every purchasable, credit-bought, inventory-backed consumable
 * (e.g. 📣 Megaphone today, potions, custom themes, tokens in the future).
 */

/**
 * Kinds of consumable items a user can own in `user_inventory`.
 * Extensible union — add new purchasable item keys here AND in the registry
 * (`src/config/consumables.ts`).
 */
export type InventoryItemType =
  | "megaphone"
  | "easter_egg"
  // Exploration Consumables (Step 10 Pillar 1)
  | "item_divergence_compass"
  | "item_memory_anchor"
  | "item_resonance_prism"
  | "item_curator_quill"
  // Scribe Vault Dual-Gated Frames (Step 10 Pillar 3)
  | "cyber_grid"
  | "gothic_bramble"
  | "astral_void"
  | "ancient_runes";

export type ConsumableCategory = "broadcast" | "exploration" | "vault" | "tribute";

/**
 * Defines narrative milestone criteria required before a user is permitted
 * to purchase a Scribe's Vault item (Dual-Gate Architecture).
 *
 * NOTE (Client-Facing by Design): This interface is serialized in public
 * catalog payloads to enable storefront progress indicators (`18/30 Pages Read`).
 * Security is enforced server-side inside `purchaseConsumable` with row locks.
 */
export interface ConsumableHonorGate {
  /** Metric key in user_counters (e.g. 'pagesRead', 'highRiskChoicesTaken') */
  metric: string;
  /** Minimum threshold needed to unlock purchase */
  threshold: number;
  /** User-facing explanation of the honor requirement */
  description: string;
}

/**
 * A consumable definition in the registry (SSOT).
 */
export interface ConsumableItemDefinition {
  /** Stable inventory key; must match {@link InventoryItemType}. */
  type: InventoryItemType;
  /** Human-readable name shown in the UI (emoji-friendly). */
  name: string;
  /** Short, user-facing description of what the item does. */
  description: string;
  /** Credit cost to buy ONE unit. SSOT for the price. (0 for non-purchasables) */
  creditsPrice: number;
  /** When `false`, the item cannot be purchased (hidden/disabled in shop). */
  available: boolean;
  /** Whether the item is non-transferable / account-bound. */
  accountBound?: boolean;
  /** Optional glyph shown next to the name. */
  icon?: string;
  /** Optional purchase cap per user (undefined = unlimited). */
  maxPerUser?: number;
  /** Catalog category for storefront tab organization */
  category?: ConsumableCategory;
  /** Dual-gate honor requirement: buyer must meet this feat to purchase */
  honorGate?: ConsumableHonorGate;
}

/**
 * Public catalog payload returned to clients for store & inventory views.
 */
export interface PublicConsumableItem extends ConsumableItemDefinition {
  /** Currently-owned count for the authenticated user (0 when unowned). */
  quantity: number;
}

export interface UserInventoryResponse {
  items: PublicConsumableItem[];
  /** Legacy convenience alias for the 📣 Megaphone count. */
  megaphones?: number;
}
