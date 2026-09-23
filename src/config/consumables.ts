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
  // ── Broadcast & Core Utilities ──
  {
    type: "megaphone",
    name: "Megaphone",
    description:
      "Broadcast a short message to every reader for a few seconds. Runs AI moderation before it goes live.",
    creditsPrice: 100,
    available: true,
    accountBound: false,
    icon: "📣",
    category: "broadcast",
  },
  {
    type: "easter_egg",
    name: "Easter Egg",
    description:
      "A mysterious egg uncovered from the depths of a story. Crack it open to reveal credits, consumables, or rare lore rewards.",
    creditsPrice: 0,
    available: false,
    accountBound: true,
    icon: "🥚",
    category: "exploration",
  },

  // ── Narrative Exploration Utilities (Step 10 Pillar 1) ──
  {
    type: "item_divergence_compass",
    name: "Divergence Compass",
    description:
      "A delicate brass astrolabe that senses shifting probabilities. Highlights whether upcoming choices lead to unexplored vs visited timelines.",
    creditsPrice: 40,
    available: true,
    accountBound: false,
    icon: "🧭",
    category: "exploration",
  },
  {
    type: "item_memory_anchor",
    name: "Memory Anchor",
    description:
      "Crystallized temporal quartz. Anchors your consciousness to a decision fork, allowing instant returns without re-reading from chapter start.",
    creditsPrice: 60,
    available: true,
    accountBound: false,
    icon: "⚓",
    category: "exploration",
  },
  {
    type: "item_resonance_prism",
    name: "Resonance Prism",
    description:
      "An amethyst prism tuned to the multiverse. Increases Easter Egg and thread fragment discovery rates (+50%) for your next 15 pages.",
    creditsPrice: 35,
    available: true,
    accountBound: false,
    icon: "🔮",
    category: "exploration",
  },
  {
    type: "item_danger_sight",
    name: "Danger Sight",
    description:
      "A crimson lens attuned to peril. Reveals hazardous-choice indicators on story actions for 15 minutes.",
    creditsPrice: 40,
    available: true,
    accountBound: false,
    icon: "👁️",
    category: "exploration",
  },
  {
    type: "item_curator_quill",
    name: "Curator's Quill",
    description:
      "Gilded scribe feather. Endorses an author on the Wall with a radiant golden calligraphy glow and tips 35 credits to their wallet.",
    creditsPrice: 50,
    available: true,
    accountBound: false,
    icon: "✒️",
    category: "tribute",
  },

  // ── Scribe's Vault: Dual-Gated Avatar Frames (Step 10 Pillar 3) ──
  {
    type: "cyber_grid",
    name: "Cyber Grid Frame",
    description:
      "A pulsing cyan neon circuitry frame for readers who walk the bleeding edge of synthetic realities.",
    creditsPrice: 150,
    available: true,
    accountBound: true,
    maxPerUser: 1,
    icon: "⚡",
    category: "vault",
    honorGate: {
      metric: "pagesRead",
      threshold: 30,
      description: "Read at least 30 chapters or pages across the Loom.",
    },
  },
  {
    type: "gothic_bramble",
    name: "Gothic Bramble Frame",
    description:
      "Entwined thorned iron vines studded with dark crimson blood-roses. Borne only by those who flirt with disaster.",
    creditsPrice: 200,
    available: true,
    accountBound: true,
    maxPerUser: 1,
    icon: "🥀",
    category: "vault",
    honorGate: {
      metric: "highRiskChoicesTaken",
      threshold: 3,
      description: "Survive at least 3 high-risk perilous decisions.",
    },
  },
  {
    type: "astral_void",
    name: "Astral Void Frame",
    description:
      "A deep indigo cosmic event-horizon with shimmering constellation lines, reflecting mastery over alternate truths.",
    creditsPrice: 250,
    available: true,
    accountBound: true,
    maxPerUser: 1,
    icon: "🌌",
    category: "vault",
    honorGate: {
      metric: "alternateEndingsDiscovered",
      threshold: 3,
      description: "Discover at least 3 alternate endings in completed stories.",
    },
  },
  {
    type: "ancient_runes",
    name: "Ancient Runes Frame",
    description:
      "Weathered granite glyphs inscribed with radiant ancient runes, granted to chroniclers who untangle intricate conspiracies.",
    creditsPrice: 300,
    available: true,
    accountBound: true,
    maxPerUser: 1,
    icon: "ᚱ",
    category: "vault",
    honorGate: {
      metric: "threadsResolved",
      threshold: 5,
      description: "Bring at least 5 complex narrative threads to ultimate closure.",
    },
  },
];

/**
 * Duration of one Danger Sight activation, in seconds (15 minutes).
 *
 * SSOT for the buff window: the registry description mentions "15 minutes",
 * the `user_consumable_effects.expires_at` row is set to
 * `now + DANGER_SIGHT_DURATION_SECONDS` at activation, and the client-side
 * countdown derives from the server-issued remaining seconds — none of them
 * hardcode the number independently.
 * Account-global (unlike the page-based Resonance Prism), because the hazard
 * badge it reveals is presentational only and not tied to a book session.
 */
export const DANGER_SIGHT_DURATION_SECONDS = 15 * 60;

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
