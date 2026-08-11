import type { ActionHintType, ActionType } from "./story.js";

/**
 * Outcome of a custom action validation
 *
 * - `reject`: Hard block — no generation, no charge, free retry
 * - `allow_as_attempt`: Proceeds to generation, but hint forces a failed/punished consequence
 * - `allow`: Proceeds normally, plausible as attempted
 */
export type CustomActionOutcome = 'reject' | 'allow_as_attempt' | 'allow';

/**
 * Categories for why a custom action was rejected or flagged
 *
 * - `content_policy`: Policy violation — always maps to 'reject'
 * - `implausible`: Missing item/ability — usually maps to 'allow_as_attempt'
 * - `world_inconsistent`: Contradicts established facts — usually maps to 'reject'
 * - `tonally_wrong`: Passive/comedic/nonsensical mid-tension — maps to 'allow_as_attempt'
 * - `bypasses_thread`: Skips a mystery/conflict instead of engaging it — always maps to 'reject'
 * - `bypasses_ending`: Jumps straight to/around the planned ending — always maps to 'reject'
 */
export type CustomActionRejectionCategory =
  | 'content_policy'
  | 'implausible'
  | 'world_inconsistent'
  | 'tonally_wrong'
  | 'bypasses_thread'
  | 'bypasses_ending';

/**
 * Result of the deterministic security filter (Gate 1)
 */
export interface CustomActionSecurityResult {
  passed: boolean;
  category?: 'injection_attempt' | 'denylist' | 'length' | 'invalid_characters' | 'empty';
}

/**
 * Result of the consolidated AI interpreter call (Gate 2)
 */
export type CustomActionValidationResult = {
  outcome: CustomActionOutcome;
  rejectionCategory?: CustomActionRejectionCategory;

  /** Internal-only reasoning, never shown verbatim to the reader */
  reasons: string[];

  /** 0–1, how plausible attempting this is given current state */
  plausibilityScore: number;

  /**
   * 0–1, how much this preserves story progression.
   * Also penalizes gradual drift from active threads, not just outright bypass.
   */
  progressionScore: number;

  /** 3–8 word canonical intent, replaces the draft's separate "canonicalization" prompt */
  interpretedIntent: string;

  /**
   * Short consequence hint written by the AI alongside `interpretedIntent`
   * (the action label). Text = intent; hint = what this choice leads to,
   * phrased evocatively rather than bluntly, grounded in the current scene.
   * Always in the story language (book.language), never the reader's raw
   * input language.
   */
  hintText: string;

  /** Best-fit classification into existing ActionType union */
  actionType: ActionType;

  /** Best-fit classification into existing ActionHintType union */
  hintType: ActionHintType;

  /**
   * ISO 639-1 language code of the action text (e.g. "en", "ar", "fr", "tr").
   * Used for analytics, per-language threshold tuning, and future multilingual support.
   */
  language: string;
}

/**
 * Preview response returned to the client before submission
 */
export interface CustomActionPreviewResponse {
  outcome: CustomActionOutcome;
  rejectionCategory?: CustomActionRejectionCategory;
  preview?: {
    canonicalIntent: string;
    cost: number;
  };
  message?: string;
}

/**
 * Submit response returned to the client after successful submission
 */
export interface CustomActionSubmitResponse {
  nextPageId?: string;
  pollingInfo?: {
    pollingUrl: string;
    pollingIntervalMs: number;
    maxPollingTimeMs: number;
  };
  message?: string;
}

/**
 * Per-book stored template for community action reuse (Tier 1)
 */
export interface CustomActionTemplate {
  id: string;
  canonicalIntent: string;
  sceneType?: string;
  momentum?: string;
  actionType: ActionType;
  usageCount: number;
  approvalScore: number;
}
