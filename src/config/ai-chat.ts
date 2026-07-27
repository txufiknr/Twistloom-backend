import type { AIChatConfig } from "../types/ai-chat.js";

export const DEFAULT_MAX_OUTPUT_TOKEN: number = 4000;
export const EVALUATION_SCORING_OUTPUT_TOKEN: number = 2000;
export const EVALUATION_FALLBACK_LIMIT: number = 3;
export const MAX_SCHEMA_LENGTH: number = 30_000;

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