/**
 * Canon validation configuration (roadmap 1.1).
 *
 * Kill-switch: set CANON_VALIDATION_ENABLED=false to skip the generation-time
 * check entirely (fail-open to prior behavior).
 */
export const CANON_VALIDATION_ENABLED = process.env['CANON_VALIDATION_ENABLED'] !== 'false';

/**
 * Max rewrite attempts after a hard `rejected` outcome.
 * 1 = validate → (if rejected) one targeted rewrite → re-validate once → persist.
 */
export const CANON_VALIDATION_MAX_REWRITE_ATTEMPTS = 1;

/** Max tokens for the structured validation judgment */
export const CANON_VALIDATION_MAX_OUTPUT_TOKEN = 800;

/** Max tokens for a targeted prose rewrite */
export const CANON_REWRITE_MAX_OUTPUT_TOKEN = 4096;
