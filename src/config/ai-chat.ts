import { AIChatConfig } from "../types/ai-chat";

export const DEFAULT_MAX_OUTPUT_TOKEN: number = 1500;

/** Temperature controls randomness (0.6 - 0.85): > 0.85 → messy / incoherent, < 0.6 → robotic */
export const DEFAULT_TEMPERATURE: number = 0.7;
/** Top-p (nucleus) sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
export const DEFAULT_TOP_P: number = 0.9;
/** Top-k sampling: considers top K most likely tokens */
export const DEFAULT_TOP_K: number = 40;
/** Stop sequences to control output generation */
export const DEFAULT_STOP_SEQUENCES: string[] = ['\n\n\n'];

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
 * AI chat parameters optimized for story context summarization
 * 
 * These settings prioritize consistency, accuracy, and conciseness for
 * maintaining narrative coherence across story progression.
 */
export const AI_CHAT_CONFIG_SUMMARIZE: Readonly<AIChatConfig> = {
  /** Lower temperature for more consistent and predictable summaries */
  temperature: 0.3,
  /** Higher topP for more diverse but still focused output */
  topP: 0.85,
  /** Top-k sampling for balanced token selection */
  topK: 30,
  /** Large token limit for more accurate context */
  maxOutputToken: 2500,
  /** Standard stop sequences for clean output termination */
  stopSequences: DEFAULT_STOP_SEQUENCES,
};

/**
 * AI chat parameters optimized for human-like engaging story writing
 * 
 * These settings provide a natural, engaging narrative experience
 * with appropriate creativity and personality for compelling storytelling.
 */
export const AI_CHAT_CONFIG_HUMAN_STYLE: Readonly<AIChatConfig> = {
  /** Controls randomness: 0.0 = deterministic, 1.0 = maximum randomness */
  temperature: 0.75,
  /** Nucleus sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
  topP: 0.92,
  /** Top-k sampling: considers top K most likely tokens */
  topK: 50,
  /** Maximum number of tokens to generate in the response */
  maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN,
  /** Stop sequences to control output generation */
  stopSequences: DEFAULT_STOP_SEQUENCES,
};