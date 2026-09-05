import type { StoryGenerationStep } from "../types/book.js";
import { FEATURE_FREE_DEMO } from "./credits.js";

/** Total cost of a book generation */
export const BOOK_GENERATION_COST = FEATURE_FREE_DEMO ? 0 : 5;

/**
 * Stage-based refund mapping.
 *
 * null means cancellation is not available at this stage (point of no return).
 * Matches the frontend config in twistloom-web/src/lib/utils/generation-refund.ts.
 */
export const STAGE_REFUND: Record<StoryGenerationStep, number | null> = {
  theme_validation: FEATURE_FREE_DEMO ? 0 : 5,
  book_initialization: FEATURE_FREE_DEMO ? 0 : 5,
  ai_generation: FEATURE_FREE_DEMO ? 0 : 3,
  ai_evaluation: FEATURE_FREE_DEMO ? 0 : 1,
  finalizing: null,
  complete: null,
};

/**
 * Returns the refund amount for a given generation step.
 *
 * @param step - Current generation step, or null (not yet started)
 * @returns Refund amount in credits, or null if cancellation is not available
 */
export function getRefundForStep(step: StoryGenerationStep | null): number | null {
  if (!step) return BOOK_GENERATION_COST;
  return STAGE_REFUND[step] ?? null;
}

/**
 * Returns true if the generation is at the finalizing stage where
 * cancellation is disabled and the workflow should finish in the background.
 */
export function isAtPointOfNoReturn(step: StoryGenerationStep | null): boolean {
  return step === 'finalizing';
}
