import type { AIChatProvider, AIModelSelection } from "../types/ai-chat.js";

/**
 * Rate limit configuration for each AI provider based on typical free tier limits (as of mid-2026).
 * 
 * | Provider      | RPM  | RPD         | Notes                                      |
 * |---------------|------|-------------|--------------------------------------------|
 * | GitHub Models | 15   | 150         | Best quality backup, strict daily limit.   |
 * | Gemini        | 15   | 1,500       | Flash: 15 RPM. Pro: 2 RPM.                 |
 * | Cohere        | 100  | 10,000      | Extremely generous RPM, RAG optimized.     |
 * | Mistral       | 60   | ~86,400     | 1 req/sec enforced on free tier.           |
 * | Groq          | 30   | 14,400      | Fast inference, but strict 6K TPM limit.   |
 * | Cerebras      | 30   | 14,400      | Blistering speed, 1M daily tokens limit.   |
 * | NVIDIA NIM    | 40   | ~57,600     | Excellent fallback for open-source heavy.  |
 * 
 * RPM = Requests Per Minute
 * RPD = Requests Per Day
 * 
 * Note: Actual limits may vary by account status, region, and current API load.
 * Always implement exponential backoff and retry logic for rate limit errors.
 * 
 * @see https://ai.google.dev/gemini-api/docs/models/gemini#gemini-2.5-flash
 * @see https://docs.cohere.com/docs/rate-limits
 * @see https://console.groq.com/docs/rate-limits
 * @see https://inference-docs.cerebras.ai/support/rate-limits
 * @see https://docs.api.nvidia.com/nim/reference/rate-limits
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 */
export const AI_RATE_LIMITS: Record<AIChatProvider, { rpm: number; rpd: number }> = {
  github:     { rpm: 15,  rpd: 150 },
  gemini:     { rpm: 15,  rpd: 1_500 },
  cohere:     { rpm: 100, rpd: 10_000 },
  mistral:    { rpm: 60,  rpd: 86_400 },
  groq:       { rpm: 30,  rpd: 14_400 },
  cerebras:   { rpm: 30,  rpd: 14_400 },
  nvidia:     { rpm: 40,  rpd: 57_600 },

  // NOTE: 1,000 RPD requires a one-time $10 credit top-up on OpenRouter (never expires).
  // If you haven't done that yet, use 50 RPD instead.
  openrouter: { rpm: 20,  rpd: 50 },

  // Cloudflare bills in "neurons" (compute units), not requests, so this is
  // a conservative request-based proxy for the 10,000 neurons/day budget on
  // small (8B-class) models. Monitor actual neuron usage in the Cloudflare
  // dashboard and adjust `rpd` down if you pick a larger model.
  cloudflare: { rpm: 10,  rpd: 150 },
};

/**
 * Safety buffer percentage for rate limiting.
 * Applied to actual RPM to prevent hitting HTTP 429 Rate Limit errors.
 */
export const AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT = 8;

/**
 * Maximum total prompt length (system + documents + user context) in characters.
 * 
 * Token-to-character conversion: ~4 characters per token (English text average).
 * 
 * Note for free tiers:
 * While models like Llama 3.3 technically support 128K context, free tier API limits 
 * (like Groq's 6,000 TPM limit or Cerebras's 8K hard-cap) dictate your payload size.
 * Exceeding these artificial character limits will instantly crash the background generator.
 * 
 * | Provider      | Model                      | Context    | Max Input    | Max Input Chars |
 * |---------------|----------------------------|------------|--------------|-----------------|
 * | Gemini        | gemini-2.5-flash-lite      | 1M tokens  | ~900K tokens | ~3,600,000      |
 * | Mistral       | mistral-large-latest       | 256K       | ~250K tokens | ~1,000,000      |
 * | Cohere        | command-r-08-2024          | 128K       | ~125K tokens | ~500,000        |
 * | NVIDIA NIM    | meta/llama-3.3-70b         | 128K       | ~120K tokens | ~480,000        |
 * | Cerebras      | llama-3.3-70b              | 128K       | 8K tokens    | ~32,000         |
 * | GitHub        | gpt-4o                     | 128K       | 8K tokens    | ~30,000         |
 * | Groq          | llama-3.3-70b-versatile    | 128K       | 6K tokens    | ~24,000         |
 * 
 * @see https://ai.google.dev/gemini-api/docs/models
 * @see https://docs.cohere.com/docs/models
 * @see https://console.groq.com/docs/models
 * @see https://inference-docs.cerebras.ai/models/overview
 * @see https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 * @see https://developers.openai.com/api/docs/models
 * @see https://openrouter.ai/models
 * @see https://developers.cloudflare.com/workers-ai/models
 */
export const AI_MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini:     3_600_000, // 1M tokens   - The Deep Memory Vault. Safe to load full story.
  mistral:    1_000_000, // 256K tokens - Handles massive context perfectly.
  cohere:     500_000,   // 128K tokens - Good for external lore fetching.
  nvidia:     480_000,   // 128K tokens - Native context.
  cerebras:   32_000,    // 8K tokens   - FREE TIER CAP. Do not exceed ~32,000 chars.
  github:     30_000,    // 8K tokens   - Standard GPT-4o free tier context limit.
  groq:       24_000,    // 6K tokens   - FREE TIER TPM CAP. Exceeding this triggers a 429.

  // If you pin a large-context free model (e.g. meta-llama/llama-4-maverick:free
  // with a 1M context), raise this — but remember the 20 RPM cap makes huge
  // prompts a poor fit regardless.
  openrouter: 60_000,    // ~15K tokens - Conservative default for most :free model variants.

  // Workers AI 8B-class models commonly cap around 4-8K token context.
  // Keep this small both to fit the context window and to preserve neuron
  // budget for the output.
  cloudflare: 12_000,
};

/**
 * GitHub Models inference (OpenAI-compatible). 
 * Primary model first; mini as fallback. Ideal for absolute JSON structure rescue.
 */
export const AI_CHAT_MODELS_OPENAI: AIModelSelection = {
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini']
};

/**
 * Creative story writing (large and creative models) - in fallback order.
 * Sorted strictly from highest emotional/artistic prose quality down to functional/rigid prose.
 * 
 * Mistral stands at the top because of its lighter RLHF (Reinforcement Learning from Human Feedback). 
 * Unlike corporate-tuned models, it natively understands gritty tension, subtext, and ambiguous 
 * thriller scenes without forcing moralizing, wrapped-up conclusions.
 */
export const AI_CHAT_MODELS_WRITING: AIModelSelection = {
  mistral: [
    'mistral-medium-latest', // The Prose Champion. Unmatched human-like fluidity and distinct character voices.
    'mistral-large-latest' // Highly precise, vocabulary-dense. Ideal for complex environmental descriptions.
  ],
  gemini: [
    'gemini-3-flash-preview', // Vivid and highly descriptive. Phenomenal at sensory world-building.
    'gemini-2.5-flash' // Excellent workhorse.
  ],
  groq: [
    'llama-3.3-70b-versatile', // Cinematic, fast-paced action, snappy dialogue.
    'deepseek-r1-distill-llama-70b', // Deeply analytical pacing, vivid logic mapping.
    'mixtral-8x7b-32768', // Atmospheric, moody, and highly descriptive.
    'gemma2-9b-it', // Unique vocabulary, great for erratic/poetic internal monologues.
  ],
  cerebras: [
    'llama-3.3-70b', // Instantaneous generation. Action-oriented, direct, punchy pulp fiction.
  ],
  nvidia: [
    'mistralai/mixtral-8x22b-instruct-v0.1', // Deeply artistic, excellent at environmental tension.
    'meta/llama-3.3-70b-instruct', // Tightly paced, structurally robust.
    'qwen/qwen2.5-72b-instruct', // Intricate, heavily detailed. Ideal for massive lore.
  ],

  // Last-resort fallback when every dedicated free tier above is exhausted.
  cohere: [
    'command-r-08-2024' // Reads like an academic summary. Use only as a last resort for prose.
  ],
  // Verify these IDs are still :free at openrouter.ai/models before relying on them.
  openrouter: [
    'deepseek/deepseek-r1:free', // Strong analytical/reasoning prose
    'meta-llama/llama-4-maverick:free', // Large context, broad fallback
  ],
  // Verify current model IDs/availability at developers.cloudflare.com/workers-ai/models
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/google/gemma-3-12b-it',
  ],
};

/**
 * Generating story theme ideas and meta-directives.
 * Prefers fast, highly structured, smaller models that excel at brainstorming.
 */
export const AI_CHAT_MODELS_THEME: AIModelSelection = {
  ...AI_CHAT_MODELS_OPENAI,
  gemini: [
    'gemini-3-flash-preview', 
    'gemini-2.5-flash', 
    'gemini-2.5-flash-lite', 
    'gemini-1.5-flash-8b'
  ],
  mistral: [
    'mistral-small-latest', 
    'mistral-medium-latest'
  ],
  cohere: ['command-r-08-2024'],
  groq: ['llama-3.3-70b-versatile'],
  cerebras: ['llama-3.3-70b'],
  nvidia: [
    'meta/llama-3.3-70b-instruct', 
    'mistralai/mistral-7b-instruct'
  ],
  openrouter: [
    'deepseek/deepseek-r1:free',
    'meta-llama/llama-4-maverick:free',
  ],
};

/**
 * Story book and page translation (Multilingual capabilities).
 * Mistral excels at European languages (subtext/culture), while Gemini handles Asian/Middle Eastern languages.
 */
export const AI_CHAT_MODELS_TRANSLATION: AIModelSelection = {
  // Mistral’s architecture handles European languages (especially French, Spanish, German, and Italian) with a deeply innate grasp of cultural subtext and literary grammar.
  // If you are translating into or out of European languages (French, Spanish, German, Italian), Mistral is historically superior due to its training bias.
  mistral: [
    'mistral-medium-latest',
    'mistral-large-latest',
  ],
  // If you are dealing with Asian or Middle Eastern languages, Gemini 3 Flash offers vastly more balanced and robust global multilingual capability.
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  // Possesses enough language complexity to grasp context, maintain story continuity, and accurately translate dialogue.
  // Optimized for 10 core languages: English, French, Spanish, Italian, German, Portuguese, Japanese, Korean, Chinese, Arabic.
  cohere: [
    'command-r-08-2024'
  ],
};

/**
 * Scoring, evaluating, and error-correcting previously generated JSON state/pages.
 * Requires large context windows and strict schema adherence.
 */
export const AI_CHAT_MODELS_EVALUATION: AIModelSelection = {
  mistral: [
    'mistral-large-latest',
  ],
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  cohere: [
    'command-r-08-2024'
  ],
};