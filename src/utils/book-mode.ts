/**
 * Book-mode enforcement helpers.
 *
 * These helpers centralise the HARD branching rules that depend on a book's
 * creation mode (`BookMode`). They are the single source of truth shared by:
 *   - `persistPageWithState` (services/book.ts) — enforced at page insertion
 *   - candidate generation (utils/candidate-generation.ts) — enforced when
 *     actions are matched to their pre-generated destination pages
 *
 * ── The branching contract ───────────────────────────────────────────────
 *   novel       : A strictly LINEAR story. Exactly ONE action per page, and
 *                 that single action resolves to exactly ONE destination page.
 *                 No branching, no alternate fates.
 *   interactive : Branching, but each action is a SINGLE fork — exactly ONE
 *                 destination page per action. Multiple actions are allowed,
 *                 but no action ever spawns parallel timelines.
 *   multiverse  : The original behaviour. Multiple actions, each allowed to
 *                 have MULTIPLE destination pages (parallel timelines).
 *
 * Violations are treated as programmer/AI errors: generation code must never
 * produce a page that breaks its book's mode. Helpers throw so the offending
 * page is rejected loudly rather than silently corrupting the story graph.
 */

import type { Action } from "../types/story.js";
import type { BookMode } from "../types/book.js";
import { bookModes } from "../types/book.js";

/** Hard cap on the number of actions a page may carry in any mode. */
export const MAX_ACTIONS_PER_PAGE = 6;

/**
 * Returns the maximum number of actions allowed on a page for the given mode.
 *
 * - `novel`       → exactly 1 (forced linear path)
 * - `interactive` → multiple allowed (the AI decides, capped at MAX_ACTIONS_PER_PAGE)
 * - `multiverse`  → multiple allowed (capped at MAX_ACTIONS_PER_PAGE)
 *
 * @param mode - The book's creation mode
 * @returns Maximum number of actions permitted on a single page
 */
export function maxActionsForMode(mode: BookMode): number {
  return mode === 'novel' ? 1 : MAX_ACTIONS_PER_PAGE;
}

/**
 * Returns the maximum number of destination pages (destinationPageIds) any
 * single action may have for the given mode.
 *
 * - `novel`       → 1 (the one action leads to exactly one page)
 * - `interactive` → 1 (each action is a single fork)
 * - `multiverse`  → unlimited (parallel timelines; capped only by the caller)
 *
 * @param mode - The book's creation mode
 * @returns Maximum number of destinations per action (Infinity for multiverse)
 */
export function maxDestinationsPerActionForMode(mode: BookMode): number {
  return mode === 'multiverse' ? Infinity : 1;
}

/**
 * Clamps a requested candidate-page count (pages generated per action) to the
 * limit imposed by the book's mode.
 *
 * - `novel` / `interactive` → at most 1 destination page per action, so only
 *   ONE candidate page should ever be generated per action.
 * - `multiverse`           → multiple candidate pages per action (unchanged).
 *
 * @param mode - The book's creation mode
 * @param requested - The candidate count the caller asked for
 * @returns The mode-appropriate candidate count (never exceeds the limit)
 */
export function clampCandidateCountForMode(mode: BookMode, requested: number): number {
  const max = maxDestinationsPerActionForMode(mode);
  // Infinity (multiverse) → keep the requested count; finite → cap at `max`.
  if (!Number.isFinite(max)) return requested;
  return Math.min(requested, max);
}

/**
 * Validates that a page's actions conform to its book's mode at INSERT time.
 *
 * This is the gate called from `persistPageWithState` BEFORE a freshly
 * AI-generated page is written to the database. At this point the page's
 * actions have NO destinations yet (destinations are filled later by candidate
 * generation), so this only checks the ACTION-COUNT rule:
 *
 *   - novel       : exactly 1 action
 *   - interactive : 1..MAX_ACTIONS_PER_PAGE actions
 *   - multiverse  : 1..MAX_ACTIONS_PER_PAGE actions
 *
 * The per-action destination count is enforced separately, when candidate
 * generation writes destinations back (see `enforceModeOnActionDestinations`).
 *
 * @param mode - The book's creation mode
 * @param actions - The actions array about to be persisted
 * @throws Error if the action count violates the mode's branching contract
 */
export function validatePageActionsForMode(mode: BookMode, actions: Action[]): void {
  if (!bookModes.includes(mode)) {
    throw new Error(`validatePageActionsForMode: unknown book mode "${mode}"`);
  }

  const maxActions = maxActionsForMode(mode);
  const actionCount = actions.length;

  if (actionCount < 1) {
    throw new Error(
      `Mode "${mode}" requires at least 1 action per page, but generated page has ${actionCount}.`,
    );
  }

  if (actionCount > maxActions) {
    // novel is the only mode with a strict 1-action cap.
    if (mode === 'novel') {
      throw new Error(
        `Mode "novel" requires EXACTLY 1 action per page (linear story), but generated page has ${actionCount} actions.`,
      );
    }
    throw new Error(
      `Mode "${mode}" allows at most ${maxActions} actions per page, but generated page has ${actionCount} actions.`,
    );
  }
}

/**
 * Sanitizes a page's actions to conform to its book's mode.
 *
 * Unlike `validatePageActionsForMode` which throws on violation, this function
 * gracefully truncates excess actions so the caller can proceed without error.
 * This is the **defence-in-depth** layer for candidate generation: if the AI
 * over-generates, the extra actions are silently dropped and a single action is
 * kept.
 *
 * Mode rules:
 *   - novel       : exactly 1 action (the kept action is picked at random so
 *                   over-generation never makes book/page creation deterministic)
 *   - interactive : 1..MAX_ACTIONS_PER_PAGE actions (unchanged)
 *   - multiverse  : 1..MAX_ACTIONS_PER_PAGE actions (unchanged)
 *
 * @param mode - The book's creation mode
 * @param actions - The actions to sanitize
 * @returns A new actions array that conforms to the mode's contract
 */
export function sanitizeActionsForMode(mode: BookMode, actions?: Action[]): Action[] {
  if (!actions) return [];
  if (mode === 'novel' && actions.length > 1) {
    const picked = actions[Math.floor(Math.random() * actions.length)];
    console.warn(
      `[sanitizeActionsForMode] ⚠️ Mode "${mode}" requires exactly 1 action; ` +
      `truncating from ${actions.length} to 1. Keeping: "${picked.text}"`,
    );
    return [picked];
  }
  return actions;
}

/**
 * Enforces the per-action destination limit for the book's mode.
 *
 * Called from candidate generation whenever destinations are about to be
 * written onto an action. It returns a NEW destination array capped to the
 * mode's limit:
 *
 *   - novel / interactive → at most 1 destinationPageId (extra candidates are
 *     dropped, and a warning is logged so the over-generation is visible).
 *   - multiverse          → all destinations kept (no cap).
 *
 * This guarantees the persisted `actions` JSONB can never violate the mode's
 * branching contract, regardless of how many candidate pages the AI produced.
 *
 * @param mode - The book's creation mode
 * @param existing - Destination page IDs already recorded on the action
 * @param incoming - Newly generated destination page IDs to merge in
 * @returns The merged, mode-compliant destination page ID list
 */
export function enforceModeOnActionDestinations(
  mode: BookMode,
  existing: string[] = [],
  incoming: string[] = [],
): string[] {
  const max = maxDestinationsPerActionForMode(mode);

  // multiverse: keep everything (unordered, de-duplicated).
  if (!Number.isFinite(max)) {
    return dedupe([...existing, ...incoming]);
  }

  // novel / interactive: at most `max` (== 1) destination. Prefer the first
  // existing destination; only add the first incoming one if none exist yet.
  const merged = dedupe([...existing, ...incoming]);
  if (merged.length <= max) return merged;

  console.warn(
    `[enforceModeOnActionDestinations] ⚠️ Mode "${mode}" allows only ${max} destination per action; ` +
    `capping ${merged.length} candidates to the first ${max}.`,
  );
  return merged.slice(0, max);
}

/** De-duplicates a string array while preserving order. */
function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
