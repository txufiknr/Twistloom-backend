import type { AIChatConfig } from "../types/ai-chat.js";

export const DEFAULT_MAX_OUTPUT_TOKEN: number = 4000;
export const EVALUATION_SCORING_OUTPUT_TOKEN: number = 2000;
export const EVALUATION_FALLBACK_LIMIT: number | undefined = undefined;
export const MAX_SCHEMA_LENGTH: number = 30_000;

/**
 * Feature flag gating the multi-turn (stage-split) page generation pipeline.
 * 
 * `false` (default): `generateNextPage`/`generateNextPages` use the
 * original single combined "page + state delta" request, byte-identical to
 * pre-refactor behavior — this is the safe rollback state.
 * `true`: routes through the 2-turn (single page) / parallel-multi-turn
 * (multiverse) pipeline in prompt.ts.
 */
export const USE_MULTI_TURN_GENERATION = false;

/**
 * Per-turn output-token budgets for multi-turn (stage-split) page generation
 * — see MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 2 & Part 3 Phase 2.
 *
 * `DEFAULT_MAX_OUTPUT_TOKEN` (4000) sizes the OLD single combined
 * "page + state delta" request and stays unchanged for every non-split
 * caller (pen.ts, canon-validation.ts, book-creation, and the legacy
 * `generateNextPage(s)` path when `USE_MULTI_TURN_GENERATION` is off).
 *
 * The two turn budgets below intentionally do NOT sum to 4000. A StoryPage
 * turn only authors `text` (max MAX_WORDS_PER_PAGE words) plus a handful of
 * scalar/array scene fields — empirically it almost never approaches even
 * half of 4000 today. A StateDelta turn's largest single field
 * (`contextHistory`, capped at MAX_WORDS_SUMMARIZED_CONTEXT words) plus every
 * other delta array (newCharacters/newPlaces/newThreads/etc.) is the field
 * set that actually risks truncation (`finishReason === 'length'`) under the
 * OLD shared 4000 budget, since it competes with the page text for the same
 * pool. Splitting the budget unevenly — page gets headroom it rarely uses,
 * delta gets a larger dedicated share than it effectively had before (it
 * used to share ~4000 with the page text; alone it gets 1800, which is more
 * than its typical share of the old combined budget) — is a deliberate
 * asymmetric split, not a straight halving. Revisit against observed
 * `finishReason === 'length'` telemetry per Part 5 decision #3 before
 * tightening further.
 */
export const STORY_PAGE_MAX_OUTPUT_TOKEN: number = 2200;
export const STATE_DELTA_MAX_OUTPUT_TOKEN: number = 1800;

/**
 * NVIDIA API request timeout in milliseconds
 * 
 * This timeout prevents hanging requests to NVIDIA's inference API.
 * If a request takes longer than this duration, it will be automatically aborted.
 */
export const NVIDIA_REQUEST_TIMEOUT_MS: number = 60000;

/** Temperature controls randomness and elevates the creative vocabulary (0.6 - 0.85): > 0.85 → messy / incoherent, < 0.6 → robotic */
export const DEFAULT_TEMPERATURE: number = 0.7;
/** Top-p (nucleus) sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
export const DEFAULT_TOP_P: number = 0.9;
/** Top-k sampling: considers top K most likely tokens */
export const DEFAULT_TOP_K: number = 40;
/** Stop sequences to control output generation */
// export const DEFAULT_STOP_SEQUENCES: string[] = ['\n\n\n'];
export const DEFAULT_STOP_SEQUENCES: string[] | undefined = undefined;

/**
 * Number of times to retry the same model on retryable errors before falling
 * back to the next model in the provider's model list.
 * Applied per model — each model gets up to this many retry attempts.
 */
export const AI_CHAT_MODEL_RETRY_COUNT = 3;

/**
 * Default AI chat parameters for consistent behavior across providers
 * 
 * These values provide balanced settings for generating coherent, creative responses
 * while maintaining factual accuracy and preventing excessive randomness.
 */
export const AI_CHAT_CONFIG_DEFAULT: Readonly<AIChatConfig> = {
  /** Controls randomness: 0.0 = deterministic, 1.0 = maximum randomness */
  temperature: DEFAULT_TEMPERATURE,
  /** Nucleus sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
  topP: DEFAULT_TOP_P,
  /** Top-k sampling: considers top K most likely tokens */
  topK: DEFAULT_TOP_K,
  /** Maximum number of tokens to generate in the response */
  maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN,
  /** Stop sequences to control output generation */
  stopSequences: DEFAULT_STOP_SEQUENCES,
};

/**
 * AI chat parameters optimized for human-like engaging story writing
 * 
 * These settings provide a natural, engaging narrative experience
 * with appropriate creativity and personality for compelling storytelling.
 */
export const AI_CHAT_CONFIG_CREATIVE: Readonly<AIChatConfig> = {
  /** Controls randomness: 0.0 = deterministic, 1.0 = maximum randomness */
  temperature: 0.78,
  /** Nucleus sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
  topP: 0.92,
  /** Top-k sampling: considers top K most likely tokens */
  topK: 50,
  /** Maximum number of tokens to generate in the response */
  maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN,
  /** Stop sequences to control output generation */
  stopSequences: DEFAULT_STOP_SEQUENCES,
};