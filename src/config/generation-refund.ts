import type { StoryGenerationStep, BookMode } from "../types/book.js";
import { getBookModeCreditCostForUser } from "./credits.js";

/**
 * Fraction of the mode's generation cost refunded at each stage.
 *
 * Refunds are PROPORTIONAL to what the user was actually charged for the
 * book's mode (novel 2 / interactive 5 / multiverse 10), so "full refund"
 * always means the full mode price. For interactive books this resolves to
 * the legacy 5 / 3 / 1 tiers.
 *
 * `null` means cancellation is not available at this stage (point of no
 * return). Mirrors the frontend config in
 * twistloom-web/src/lib/utils/generation-refund.ts — keep both in sync.
 */
const STAGE_REFUND_RATIO: Record<StoryGenerationStep, number | null> = {
  theme_validation: 1,
  book_initialization: 1,
  ai_generation: 0.6,
  ai_evaluation: 0.2,
  finalizing: null,
  complete: null,
};

/**
 * Returns the refund amount for a given generation step, proportional to the
 * mode cost the user actually paid (0 during the free-demo phase or for the
 * demo user).
 *
 * @param step   - Current generation step, or null (not yet started → full refund)
 * @param mode   - The book's mode (determines the base cost)
 * @param userId - The user whose demo status affects the base cost
 * @returns Refund amount in credits, or null if cancellation is not available
 */
export function getRefundForStep(
  step: StoryGenerationStep | null,
  mode: BookMode | null | undefined,
  userId: string | null | undefined,
): number | null {
  const ratio = step ? STAGE_REFUND_RATIO[step] ?? null : 1;
  if (ratio === null) return null;
  return Math.round(getBookModeCreditCostForUser(userId, mode) * ratio);
}

/**
 * Returns true when generation has reached the finalizing stage where
 * cancellation is disabled and the workflow should finish in the background.
 */
export function isAtPointOfNoReturn(step: StoryGenerationStep | null): boolean {
  return step === 'finalizing';
}
