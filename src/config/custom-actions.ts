import type { StoryPhase } from "../types/story.js";

/**
 * Configuration constants for the custom actions system
 */

// ============================================================================
// GATE 0 — Eligibility & Rate Limits
// ============================================================================

/** Credit cost for a custom action submission */
export const CUSTOM_ACTION_CREDIT_COST = 3;

/** Max custom-action attempts per page (free retries on rejection) */
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE = 3;

/** Max custom-action attempts per hour per user */
export const CUSTOM_ACTION_RATE_LIMIT_PER_HOUR = 10;

/** Story phases where custom actions are disabled */
export const CUSTOM_ACTION_DISABLED_PHASES: StoryPhase[] = ['FINALE'];

// ============================================================================
// GATE 1 — Deterministic Security Filter
// ============================================================================

/** Regex patterns to detect prompt injection / jailbreak attempts */
export const CUSTOM_ACTION_SECURITY_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /reveal\s+.*(prompt|system|instructions)/i,
  /show\s+.*(system\s*prompt|hidden\s*state|raw\s*json)/i,
  /you\s+are\s+now/i,
  /pretend\s+(you('re|\s+are)|to\s+be)/i,
  /\b(assistant|system|developer)\s*:/i,
  /<\s*(system|assistant|developer)\s*>/i,
  /print\s+(the\s+)?(story\s*)?state/i,
  /reveal\s+(the\s+)?(hidden|viable)\s+ending/i,
] as const;

/** Denylist keywords for explicit content heuristic first pass */
export const CUSTOM_ACTION_DENYLIST_KEYWORDS: string[] = [];

/** Minimum characters for a custom action */
export const MIN_CUSTOM_ACTION_CHARS = 3;

/** Maximum characters for a custom action */
export const MAX_CUSTOM_ACTION_CHARS = 60;

/**
 * Valid text pattern — rejects emoji, control characters, and most non-Latin-script noise.
 * Only allows Unicode letters, numbers, spaces, and basic punctuation.
 */
export const CUSTOM_ACTION_VALID_TEXT_PATTERN = /^[\p{L}\p{N}\s.,!?'"-]+$/u;

// ============================================================================
// GATE 2 — AI Interpreter Thresholds
// ============================================================================

/** Minimum plausibility score for 'allow' outcome (0-1) */
export const CUSTOM_ACTION_PLAUSIBILITY_THRESHOLD = 0.5;

/** Minimum progression score for 'allow' outcome (0-1) */
export const CUSTOM_ACTION_PROGRESSION_THRESHOLD = 0.5;

// ============================================================================
// REUSE — Template Pool
// ============================================================================

/** Cost for reusing a cached near-duplicate action (Tier 1) */
export const EXPANDED_COMMUNITY_ACTION_COST = 1;

// ============================================================================
// RATE LIMITING
// ============================================================================

/** Max actions per page — free retries */
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE_LIMIT = 3;
