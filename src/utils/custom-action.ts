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
    // Conservative per-action risk heuristic for reader-authored choices (no
    // extra AI call). Only clearly dangerous action types get flagged; benign
    // choices omit `risk` and fall back to the client's page-level derivation.
    ...deriveCustomActionRisk(params.actionType),
  };
}

/**
 * Maps a reader-authored action type to a per-action risk cue. Returns `{}`
 * (no `risk`) for types that aren't clearly high-stakes, so we never spam the
 * badge on benign custom choices.
 */
function deriveCustomActionRisk(actionType: ActionTypeStory): ActionRiskMetadata | Record<string, never> {
  if (actionType === 'attack' || actionType === 'risk' || actionType === 'escape') {
    return { isHighRisk: true, riskType: 'physical', severity: 'high' };
  }
  if (actionType === 'deceive') {
    return { isHighRisk: true, riskType: 'reality_slip', severity: 'high' };
  }
  return {};
}