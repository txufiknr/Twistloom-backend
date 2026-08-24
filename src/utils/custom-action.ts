import type { Action, ActionRiskMetadata, ActionType as ActionTypeStory, ActionHintType } from "../types/story.js";
import { ucfirst } from "./formatter.js";

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