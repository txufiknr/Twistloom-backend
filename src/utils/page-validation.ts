/**
 * Shared validation helpers for AI-generated story pages.
 *
 * Consolidates text-length, actions-array, and heuristic JSON-leak checks
 * so every call site uses consistent rules with the same error messages.
 *
 * Two variants per check:
 *   - `validate*`   → throws Error on failure (use for hard-fail paths)
 *   - `check*`      → returns boolean, logs a warning (use for loop skips)
 */

import { MIN_CHARS_PER_PAGE } from "../config/story.js";
import type { BookMode } from "../types/book.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_ACTIONS_PER_PAGE = 6;

// ── JSON field leak detection ──────────────────────────────────────────────

/**
 * CamelCase JSON-schema field names that should never appear in narrative
 * prose.  Their presence (as a whole word followed by `:`) indicates the AI
 * failed to properly separate JSON structure from page text.
 */
const JSON_LEAK_FIELDS = [
  'charactersPresent', 'traumaTagAdd', 'traumaTagRemove',
  'addPlotFlags', 'addPlannedCharacters', 'futureNoteAdd',
  'futureNoteRemove', 'flagUpdates', 'factUpdates',
  'contextHistory', 'newCharacters', 'updatedCharacters',
  'newPlaces', 'updatedPlaces', 'newThreads', 'updateThreads',
  'addClues', 'closeThreads', 'branchNames', 'plannedCharacters',
  'initialThreads', 'initialPlace', 'initialCharacters',
  'initialRelationships', 'initialFacts',
  'characterId', 'sceneRole', 'sceneFocus', 'recognitionLevel',
  'memoryIntegrity', 'isMajorEvent', 'isRealNameKnown',
  'destinationPageId', 'changeReason',
  'changeViabilityBefore', 'changeViabilityAfter',
  'urgencyCorrection', 'parentPlaceId', 'newInteractions',
  'potentialTwist', 'storyPurpose', 'plannedIntro',
  'availabilityWindow', 'missedConsequence',
  'updateSchedules', 'removeSchedules',
  'familiarityCorrection', 'addKeyEvents', 'addHints',
  'removeHints', 'placeConnections', 'relationshipUpdates',
  'plotFlags', 'relatedThreadId', 'stateTrigger', 'mainCharacter',
  'addPlannedCharacters', 'updateTraits', 'removeTraits',
  'updateThreads', 'addThreadClues', 'addKeyEvents',
] as const;

/** Compiled regex — matches any JSON field name followed by `:` as a word. */
const JSON_LEAK_RE = new RegExp(
  `\\b(?:${JSON_LEAK_FIELDS.join('|')})\\s*:`,
  'gi',
);

/**
 * Checks whether `text` contains JSON schema field names that suggest the
 * AI's structured output leaked into the narrative prose.
 */
export function hasJsonLeak(text: string): boolean {
  JSON_LEAK_RE.lastIndex = 0;
  return JSON_LEAK_RE.test(text);
}

/**
 * Throws if the page text contains leaked JSON schema field names.
 */
export function validateNoJsonLeak(text: string, label?: string): void {
  if (hasJsonLeak(text)) {
    const tag = label ? `${label}: ` : '';
    throw new Error(`${tag}Page text contains leaked JSON schema fields`);
  }
}

/**
 * Returns `true` if no leak detected.  Logs a warning and returns `false`
 * when a leak is found — used in loop contexts where the page should be
 * skipped rather than aborting the entire batch.
 */
export function checkNoJsonLeak(text: string, label?: string): boolean {
  if (hasJsonLeak(text)) {
    console.warn(`⚠️ ${label ? `[${label}] ` : ''}Page text contains leaked JSON schema fields — skipping`);
    return false;
  }
  return true;
}

// ── Text-length validation ────────────────────────────────────────────────

/**
 * Throws if `text` is shorter than `minChars`.
 */
export function validateTextLength(
  text: string,
  minChars: number = MIN_CHARS_PER_PAGE,
  label?: string,
): void {
  if (text.length < minChars) {
    const tag = label ? `${label}: ` : '';
    throw new Error(
      `${tag}Page text too short (${text.length} < ${minChars} chars)`,
    );
  }
}

/**
 * Returns `true` if text meets the minimum length.  Logs a warning and
 * returns `false` otherwise.
 */
export function checkTextLength(
  text: string,
  minChars: number = MIN_CHARS_PER_PAGE,
  label?: string,
): boolean {
  if (text.length < minChars) {
    console.warn(
      `⚠️ ${label ? `[${label}] ` : ''}Page text too short (${text.length} < ${minChars} chars) — skipping`,
    );
    return false;
  }
  return true;
}

// ── Actions validation ────────────────────────────────────────────────────

/**
 * Throws if `actions` is not a non-empty array, or if the count exceeds the
 * hard cap (`MAX_ACTIONS_PER_PAGE`) for branching modes.
 *
 * Deliberately NOT mode-strict for `novel`: an AI that over-generates multiple
 * actions must not abort the whole generation. Novel's "exactly 1 action" rule
 * is enforced by `sanitizeActionsForMode` (silently strips to the first action)
 * and by the strict `validatePageActionsForMode` gate at persist/insert time.
 */
export function validatePageActions(
  actions: unknown,
  mode?: BookMode,
  label?: string,
): void {
  const tag = label ? `${label}: ` : '';

  if (!Array.isArray(actions)) {
    throw new Error(`${tag}Actions must be an array, got ${typeof actions}`);
  }
  if (actions.length < 1) {
    throw new Error(`${tag}Page must have at least 1 action, got 0`);
  }
  if (mode && mode !== 'novel' && actions.length > MAX_ACTIONS_PER_PAGE) {
    throw new Error(
      `${tag}Mode "${mode}" allows at most ${MAX_ACTIONS_PER_PAGE} actions, got ${actions.length}`,
    );
  }
}

/**
 * Returns `true` if actions are valid.  Logs a warning and returns `false`
 * otherwise (for loop skip contexts).
 *
 * Like `validatePageActions`, the `novel` mode's "exactly 1 action" rule is
 * intentionally not enforced here — excess actions are stripped silently by
 * `sanitizeActionsForMode` rather than skipping the page.
 */
export function checkPageActions(
  actions: unknown,
  mode?: BookMode,
  label?: string,
): boolean {
  const tag = label ? `[${label}] ` : '';

  if (!Array.isArray(actions) || actions.length < 1) {
    console.warn(`⚠️ ${tag}Invalid or empty actions — skipping`);
    return false;
  }
  if (mode && mode !== 'novel' && actions.length > MAX_ACTIONS_PER_PAGE) {
    console.warn(
      `⚠️ ${tag}Too many actions (${actions.length} > ${MAX_ACTIONS_PER_PAGE}) for mode "${mode}" — skipping`,
    );
    return false;
  }
  return true;
}

// ── Composite helpers ─────────────────────────────────────────────────────

/** Subset of a generated page needed for validation. */
export interface PageCheckInput {
  text: string;
  actions?: unknown;
}

/**
 * Runs all validation checks, throwing on the first failure.
 * Convenience wrapper for hard-fail paths.
 */
export function validateGeneratedPage(
  page: PageCheckInput,
  mode?: BookMode,
  label?: string,
): void {
  validateTextLength(page.text, MIN_CHARS_PER_PAGE, label);
  validateNoJsonLeak(page.text, label);
  validatePageActions(page.actions, mode, label);
}

/**
 * Runs all checks, returning `true` if every check passes.
 * Logs individual warnings for each failure so the caller can
 * `continue`/skip the page.
 */
export function checkGeneratedPage(
  page: PageCheckInput,
  mode?: BookMode,
  label?: string,
): boolean {
  const checks = [
    checkTextLength(page.text, MIN_CHARS_PER_PAGE, label),
    checkNoJsonLeak(page.text, label),
    checkPageActions(page.actions, mode, label),
  ];
  return checks.every(Boolean);
}
