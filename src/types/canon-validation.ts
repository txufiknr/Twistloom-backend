/**
 * Generation-time canon / consistency validation (roadmap 1.1).
 *
 * Mirrors the custom-action three-outcome pattern, applied to full-page
 * generation instead of reader action classification.
 */

/** Final disposition of a page against established lore */
export type CanonValidationOutcome = 'passed' | 'revised' | 'rejected';

/**
 * Primary violation category when outcome is not a clean pass.
 * Prefer the single most severe type for indexing; details live in `violations`.
 */
export type CanonViolationType =
  | 'timeline'
  | 'character_knowledge'
  | 'character_presence'
  | 'character_behavior'
  | 'established_fact'
  | 'place_state'
  | 'relationship'
  | 'inventory'
  | 'other';

export type CanonViolation = {
  type: CanonViolationType;
  /** Internal-only; never shown verbatim to readers */
  description: string;
  /** 0–1 relative severity within this violation */
  severity: number;
};

/**
 * Structured result from the canon validation AI call.
 * When `outcome === 'revised'`, `revisedText` should contain corrected prose.
 */
export type CanonValidationResult = {
  outcome: CanonValidationOutcome;
  /** Dominant violation type (nullable when passed with no issues) */
  violationType?: CanonViolationType | null;
  violations: CanonViolation[];
  /** 0–1 overall severity (0 = clean, 1 = critical contradiction) */
  severityScore: number;
  /** Short internal summary of the judgment */
  description: string;
  /**
   * Corrected page prose when outcome is `revised`.
   * Must preserve narrative voice and story trajectory; fix only contradictions.
   */
  revisedText?: string | null;
};

/** Row shape returned on enriched pages (reader-facing subset) */
export type CanonValidationSummary = {
  outcome: CanonValidationOutcome;
  violationType?: CanonViolationType;
  severityScore?: number;
  /** Whether a rewrite pass was applied before persist */
  wasRevised: boolean;
};
