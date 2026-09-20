import type { Action, ActionRiskMetadata, ActionType as ActionTypeStory, ActionHintType, GenreCategory } from "../types/story.js";
import { ucfirst } from "./formatter.js";
import { GENRE_CONTEXT_CONFIGS } from "./genre-detection.js";

/**
 * Shared factory for building a reader-authored custom `Action`.
 *
 * Single source of truth for the shape both build-call-sites produce:
 * - `buildCanonicalAction` (fresh AI validation result, custom-actions.ts)
 * - `mapCustomActionRowToAction` (persisted row reload, book.ts)
 *
 * Rules (applied identically everywhere):
 * - Display text = the AI's interpreted intent; falls back to raw reader text.
 * - Hint text = the AI's consequence hint; falls back to the display text.
 * - `originalText` always carries the reader's verbatim request (generation fidelity).
 * - `destinationPageIds` only exists when a generated destination is backfilled.
 */
export function buildCustomActionAction(params: {
  originalText: string;
  interpretedIntent: string;
  hintText: string;
  hintType: ActionHintType;
  actionType: ActionTypeStory;
  nextPageId?: string | null;
  customActionId?: string;
}): Action {
  const raw = params.originalText.trim();
  const interpretedText = params.interpretedIntent.trim();
  const label = interpretedText || raw;

  // hint = consequence (never blunt), AI-written; degrade to the label/raw only
  // when the interpreter produced nothing usable.
  const hintText = params.hintText.trim() || label;

  return {
    text: ucfirst(label),
    type: params.actionType,
    hint: { text: ucfirst(hintText), type: params.hintType },
    destinationPageIds: params.nextPageId ? [params.nextPageId] : [],
    source: 'custom',
    ...(params.customActionId ? { customActionId: params.customActionId } : {}),
    originalText: raw,
    // Per-action risk cue derived in the engine (no AI authoring). Clearly
    // dangerous action types get flagged; benign choices omit `risk` and fall
    // back to the client's page-level derivation.
    ...(deriveActionRisk(params.actionType) ?? {}),
  };
}

/**
 * Engine-derived per-action risk cue. Pure, deterministic — maps the
 * (already AI-classified) `actionType` to a risk category. This is the single
 * source of truth for `Action.risk` on BOTH AI-generated and reader-authored
 * actions; the frontend prefers it and falls back to its own page-level
 * `deriveActionRisk` only when this is absent. Returns `undefined` for benign
 * types so we never spam the badge.
 */
export function deriveActionRisk(actionType: ActionTypeStory): ActionRiskMetadata | undefined {
  switch (actionType) {
    case 'attack':
    case 'risk':
    case 'escape':
      return { isHighRisk: true, riskType: 'physical', severity: 'high' };
    case 'deceive':
      return { isHighRisk: true, riskType: 'reality_slip', severity: 'high' };
    default:
      return undefined;
  }
}

// ============================================================================
// GENRE CONTEXT — Prompt Builder
// ============================================================================

/**
 * Universal content policy guardrails applied to all genres.
 * Extracted to maintain a Single Source of Truth (SSOT).
 */
const UNIVERSAL_CONTENT_POLICY = `CRITICAL RESTRAINT: The ONLY valid content_policy reasons for rejection are real-world CSAM, terrorism, weapons synthesis, non-consensual violence against real people, self-harm encouragement, or doxxing.`;

/**
 * Builds a concise genre context block for the evaluator prompt.
 * Uses configs to inject only the detected genre's rule plus a generic fallback, 
 * keeping the system prompt lean and preventing over-censorship.
 *
 * @param genreCategory - Detected genre key from `detectGenre()`
 * @returns Formatted genre context block string
 */
export function buildGenreContextBlock(genreCategory: GenreCategory): string {
  if (genreCategory === 'general') {
    return `GENRE CONTEXT (MULTI-GENRE/GENERAL): Fiction inherently explores conflict, violence, and mature themes. NEVER reject fictional combat, genre-appropriate violence, horror atmosphere, or dramatic tension as a policy violation.
${UNIVERSAL_CONTENT_POLICY}`;
  }

  const config = GENRE_CONTEXT_CONFIGS[genreCategory];
  // Formats array into "A, B, or C" for clean prompt injection
  const formattedExamples = config.examples.length > 1 
    ? `${config.examples.slice(0, -1).join(', ')}, or ${config.examples[config.examples.length - 1]}`
    : config.examples[0];

  return `GENRE CONTEXT (${genreCategory.toUpperCase()}): ${config.rule}
Example standard actions: ${formattedExamples}.
${UNIVERSAL_CONTENT_POLICY}`;
}
