/**
 * Rarity tier classification for story endings.
 *
 * Shared between services/book.ts (server-side classification) and
 * the frontend's src/lib/config/ending-rarity.ts (client-side display).
 *
 * Thresholds must stay in sync with the frontend SSOT. Cross-reference:
 * Twistloom-web/src/lib/config/ending-rarity.ts → RARITY_THRESHOLDS
 */

export type RarityTier = 'legendary' | 'very_rare' | 'rare' | 'uncommon' | 'common';

/**
 * Rarity tier thresholds — the upper bound (inclusive) for each tier.
 * Evaluated top-down: first match wins.
 *
 * | Tier       | Threshold  | Design Rationale |
 * |------------|------------|------------------|
 * | Legendary  | ≤1%        | Genuinely extraordinary — <1 in 100 readers. |
 * | Very Rare  | ≤5%        | Elite path — 1 in 20. |
 * | Rare       | ≤15%       | Uncommon enough to feel special — 1 in ~7. |
 * | Uncommon   | ≤40%       | Noticeable minority — up to 2 in 5. |
 * | Common     | >40%       | The majority path. |
 */
export const RARITY_THRESHOLDS: { tier: RarityTier; maxPercentage: number }[] = [
  { tier: 'legendary', maxPercentage: 1 },
  { tier: 'very_rare', maxPercentage: 5 },
  { tier: 'rare',      maxPercentage: 15 },
  { tier: 'uncommon',  maxPercentage: 40 },
  { tier: 'common',    maxPercentage: Infinity },
];

/**
 * Classify an ending's rarity based on percentage and sample size.
 *
 * Sample-size guards prevent misleading labels on tiny pools:
 * - 1 reader ever → "legendary" (they ARE the first)
 * - <5 total readers → "uncommon" (percentage too volatile to trust)
 *
 * Must produce identical output to the frontend's `classifyRarity()` in
 * `Twistloom-web/src/lib/config/ending-rarity.ts`.
 */
export function classifyRarity(
  percentage: number,
  totalReaders: number,
  endingReaders: number,
): RarityTier {
  if (endingReaders <= 1) return 'legendary';
  if (totalReaders < 5) return 'uncommon';
  for (const { tier, maxPercentage } of RARITY_THRESHOLDS) {
    if (percentage <= maxPercentage) return tier;
  }
  return 'common';
}
