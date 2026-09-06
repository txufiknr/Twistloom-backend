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

import { MIN_CHARS_PER_PAGE, MIN_CHARS_PER_PAGE_IMPORTED } from "../config/story.js";
import type { BookMode } from "../types/book.js";
import { hasDialogueMarkers } from "./dialogue-parser.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_ACTIONS_PER_PAGE = 6;
export const MAX_ACTIONS_PER_PAGE_IMPORTED = 12;
export { MIN_CHARS_PER_PAGE, MIN_CHARS_PER_PAGE_IMPORTED };

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
 * Threshold (exclusive) for `checkDialogueMarkerCoverage`'s quoted-line
 * count — see {@link checkDialogueMarkerCoverage} function's JSDoc for why 2 was chosen.
 */
const DIALOGUE_MARKER_COVERAGE_QUOTE_THRESHOLD = 2;

/**
 * Soft (non-blocking) signal: does this page have substantial quoted
 * dialogue but zero `[character_id]`/`[mc]`/`[???]` markers (see
 * RULES_DIALOGUE_ATTRIBUTION in utils/prompt.ts)?
 *
 * Heuristic, not authoritative — deliberately does NOT fail the page:
 * - A page can have 1-2 incidental quoted phrases (a sign, a remembered
 *   line) with no real spoken dialogue; that's not a coverage gap.
 * - The quote-counting regex can't tell dialogue from a quoted document,
 *   text message, or inner thought the writer chose to italicize/quote.
 * This exists purely to surface a prompt-quality signal in logs (has the
 * model been dropping markers on dialogue-heavy pages?) without ever
 * rejecting or retrying a page over it — that's why it's wired into
 * `checkGeneratedPage` but plays no part in that function's boolean result.
 */
export function checkDialogueMarkerCoverage(text: string, label?: string): void {
  const quotedLines = text.match(/"[^"]+"/g);
  if (quotedLines && quotedLines.length > DIALOGUE_MARKER_COVERAGE_QUOTE_THRESHOLD && !hasDialogueMarkers(text)) {
    console.warn(`⚠️ ${label ? `[${label}] ` : ''}Page has ${quotedLines.length} quoted lines but no dialogue-attribution markers`);
  }
}

/**
 * Soft (non-blocking) signal: is `imageImportance` outside its documented
 * 0.0-1.0 range?
 *
 * Never throws or fails the page — `imagePrompt`/`imageImportance` are an
 * optional, forward-looking field pair (see the `imageImportance` JSDoc on
 * `StoryScene` in types/story.ts for the still-open schema/persistence
 * wiring) with no downstream consumer yet to protect from a bad value, so
 * this exists purely to catch drift early in logs.
 */
export function checkImageImportanceRange(imageImportance: number, label?: string): void {
  if (imageImportance < 0 || imageImportance > 1) {
    console.warn(`⚠️ ${label ? `[${label}] ` : ''}imageImportance out of range (${imageImportance}, expected 0.0-1.0)`);
  }
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
export interface PageValidationOptions {
  allowEmpty?: boolean;
  isImported?: boolean;
  minChars?: number;
  maxActions?: number;
}

export function validatePageActions(
  actions: unknown,
  mode?: BookMode,
  label?: string,
  options?: PageValidationOptions,
): void {
  const tag = label ? `${label}: ` : '';

  if (!Array.isArray(actions)) {
    throw new Error(`${tag}Actions must be an array, got ${typeof actions}`);
  }
  if (actions.length < 1) {
    if (options?.allowEmpty) {
      return;
    }
    throw new Error(`${tag}Page must have at least 1 action, got 0`);
  }
  const maxActions = options?.maxActions ?? (
    mode === 'novel'
      ? 1
      : (options?.isImported ? MAX_ACTIONS_PER_PAGE_IMPORTED : MAX_ACTIONS_PER_PAGE)
  );
  if (mode && mode !== 'novel' && actions.length > maxActions) {
    throw new Error(
      `${tag}Mode "${mode}" allows at most ${maxActions} actions, got ${actions.length}`,
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
  options?: PageValidationOptions,
): boolean {
  const tag = label ? `[${label}] ` : '';

  if (!Array.isArray(actions) || actions.length < 1) {
    if (options?.allowEmpty) return true;
    console.warn(`⚠️ ${tag}Invalid or empty actions — skipping`);
    return false;
  }
  const maxActions = options?.maxActions ?? (
    mode === 'novel'
      ? 1
      : (options?.isImported ? MAX_ACTIONS_PER_PAGE_IMPORTED : MAX_ACTIONS_PER_PAGE)
  );
  if (mode && mode !== 'novel' && actions.length > maxActions) {
    console.warn(
      `⚠️ ${tag}Too many actions (${actions.length} > ${maxActions}) for mode "${mode}" — skipping`,
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
  isDeadEnd?: boolean;
  /** Optional — see `checkImageImportanceRange` below for why this is soft-checked only. */
  imageImportance?: number;
}

/**
 * Runs all validation checks, throwing on the first failure.
 * Convenience wrapper for hard-fail paths.
 */
export function validateGeneratedPage(
  page: PageCheckInput,
  mode?: BookMode,
  label?: string,
  options?: PageValidationOptions,
): void {
  const minChars = options?.minChars ?? (options?.isImported ? MIN_CHARS_PER_PAGE_IMPORTED : MIN_CHARS_PER_PAGE);
  validateTextLength(page.text, minChars, label);
  validateNoJsonLeak(page.text, label);
  const allowEmpty = options?.allowEmpty ?? page.isDeadEnd ?? false;
  validatePageActions(page.actions, mode, label, { ...options, allowEmpty });
}

/**
 * Runs all checks, returning `true` if every check passes.
 * Logs individual warnings for each failure so the caller can
 * `continue`/skip the page.
 *
 * Also runs `checkDialogueMarkerCoverage`/`checkImageImportanceRange` —
 * both are soft, log-only signals (see their own JSDoc) and are
 * deliberately excluded from the `checks` array below, so neither one can
 * ever flip this function's boolean result.
 */
export function checkGeneratedPage(
  page: PageCheckInput,
  mode?: BookMode,
  label?: string,
  options?: PageValidationOptions,
): boolean {
  const minChars = options?.minChars ?? (options?.isImported ? MIN_CHARS_PER_PAGE_IMPORTED : MIN_CHARS_PER_PAGE);
  const checks = [
    checkTextLength(page.text, minChars, label),
    checkNoJsonLeak(page.text, label),
    checkPageActions(page.actions, mode, label, options),
  ];
  checkDialogueMarkerCoverage(page.text, label);
  if (page.imageImportance !== undefined) {
    checkImageImportanceRange(page.imageImportance, label);
  }
  return checks.every(Boolean);
}
