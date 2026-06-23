import type { AIChatProvider, AIModelSelection, AIProviderRateLimit } from "../types/ai-chat.js";

/**
 * Rate limit configuration for each AI provider based on typical free tier limits (as of mid-2026).
 * 
 * | Provider      | RPM  | RPD         | Notes                                      |
 * |---------------|------|-------------|--------------------------------------------|
 * | GitHub Models | 15   | 150         | Best quality backup, strict daily limit.   |
 * | Gemini        | 15   | 1,500       | Flash: 15 RPM. Pro: 2 RPM.                 |
 * | Cohere        | 100  | 10,000      | Extremely generous RPM, RAG optimized.     |
 * | Mistral       | 60   | ~86,400     | 1 req/sec enforced on free tier.           |
 * | Groq          | 30   | 14,400      | Fast inference, strict 6K TPM limit.       |
 * | Cerebras      | 30   | 14,400      | Blistering speed, 1M daily tokens limit.   |
 * | NVIDIA NIM    | 40   | ~57,600     | Excellent fallback for open-source heavy.  |
 * | OpenRouter    | 20   | ~500        | 20 RPM, 50-1000 RPD depending on model route. |
 * | Cloudflare    | 30   | 10,000      | Rate limited by 10,000 free "Neurons" per day. |
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
 * @see https://console.groq.com/settings/limits
 * @see https://inference-docs.cerebras.ai/support/rate-limits
 * @see https://docs.api.nvidia.com/nim/reference/rate-limits
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 */
export const AI_RATE_LIMITS: Record<AIChatProvider, AIProviderRateLimit> = {
  // High tier (gpt-4o): 10 RPM / 50 RPD. Low tier (gpt-4o-mini): 10 RPM / 150 RPD.
  // Using gpt-4o (high tier) ceiling since it's tried first; mini's higher RPD
  // doesn't matter because the daily gate fires per-provider, not per-model.
  github:     { rpm: 10,  rpd: 50 }, // before: { rpm: 15, rpd: 150 },

  // Post Dec-2025 quota cut: gemini-2.5-flash at 10 RPM / 250 RPD.
  // gemini-3-flash-preview may be higher (some sources say 1,500 RPD) but it's
  // a preview — using the GA model ceiling to avoid over-spending preview quota.
  // Verify in AI Studio: https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas
  gemini:     { rpm: 10,  rpd: 250 }, // before: { rpm: 15, rpd: 1_500 },

  // Trial key: 1,000 calls/month hard cap. No per-day sublimit documented.
  // rpmo (not rpd) gates this correctly — canUseAI() sums across the calendar month.
  cohere:     { rpm: 100, rpmo: 1_000 }, // before: { rpm: 100, rpd: 10_000 },

  // Free "Experiment" tier: ~1 req/sec, ~1B tokens/month.
  // No published request-count daily cap — token budget is the real ceiling,
  // which this config doesn't track. Omitting rpd; RateLimiter throttle() handles rpm.
  // Need to confirm: some sources say it's actually just 2 RPM?
  mistral:    { rpm: 60 }, // before: { rpm: 60, rpd: 86_400 },

  // RPM ceiling: qwen/qwen3-32b at 60 RPM (all other models are 30 RPM).
  // RPD ceiling: 1,000 for the primary 70B+ creative models (llama-3.3-70b-versatile,
  // openai/gpt-oss-120b, etc.). llama-3.1-8b-instant has 14.4K RPD but is only
  // used as a last-resort volume fallback — setting 14.4K here would let the
  // daily gate stay open long after the primary models are actually exhausted.
  // Waterfall's 429 handling covers the per-model gap when qwen3-32b (60 RPM)
  // triggers a 429 on a model that's only rated at 30 RPM.
  // See: https://console.groq.com/settings/limits
  groq:       { rpm: 60,  rpd: 1_000 }, // before: { rpm: 30, rpd: 14_400 },

  // 1M tokens/day free; 8,192-token context cap on free tier.
  // At max prompt length (~8K tokens), token budget allows ~125 requests/day —
  // request-count rpd not meaningful here.
  // See: https://cloud.cerebras.ai/platform/org_2ypxv2rc6j554f4f22pntket/models
  cerebras:   { rpm: 5, rpd: 2_400 },

  // 40 RPM confirmed. RPD unclear: either renewable-rate or finite credit pool
  // depending on account type (see build.nvidia.com usage panel).
  // Omitting rpd until credit model is confirmed for your account.
  nvidia:     { rpm: 40 }, // before: { rpm: 40, rpd: 57_600 },

  // 20 RPM / 1,000 RPD (requires one-time $10 credit top-up; 50 RPD without it).
  openrouter: { rpm: 20,  rpd: 1_000 },

  // ~10 RPM / ~150 RPD proxy for the 10,000 neurons/day free budget on 8B models.
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
  cloudflare: 12_000,    // ~3,000 tokens
};

/**
 * Creative story writing (large and creative models) - in fallback order.
 * Sorted strictly from highest emotional/artistic prose quality down to functional/rigid prose.
 * 
 * Mistral stands at the top because of its lighter RLHF (Reinforcement Learning from Human Feedback). 
 * Unlike corporate-tuned models, it natively understands gritty tension, subtext, and ambiguous 
 * thriller scenes without forcing moralizing, wrapped-up conclusions.
 * 
 * Legacy (don't use):
 * - mistralai/mistral-7b-instruct // Classic Mistral raw tone, completely free.
 * - google/gemma-2-9b-it // Poetic, surprising, with highly unique vocabulary.
 * - mistralai/mixtral-8x22b-instruct-v0.1 // Deeply artistic, excellent at environmental tension.
 * 
 * @see https://openrouter.ai/models to see whether these IDs are still :free before relying on them.
 * @see https://console.groq.com/docs/models
 * @see https://developers.cloudflare.com/workers-ai/models for current model IDs/availability.
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
  openrouter: [
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'meta-llama/llama-4-maverick:free', // Large context, broad fallback
    'nvidia/nemotron-3-super:free', // Replaces Mixtral. Massive MoE model, 1M context, exceptional atmospheric tension.
    'deepseek/deepseek-r1:free', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  groq: [
    'openai/gpt-oss-120b',                        // 120B: deepest psychological complexity, best for sustained horror dread
    'llama-3.3-70b-versatile',                    // 70B: cinematic, fast-paced action, sharp dialogue, proven thriller prose
    'qwen/qwen3-32b',                             // 32B: intricate atmospheric layering; 60 RPM (2x other models)
    'meta-llama/llama-4-scout-17b-16e-instruct',  // 10M (MoE): excellent for continuity-heavy branching scenes
    'openai/gpt-oss-20b',                         // 20B: structurally reliable fallback, same OpenAI lineage as 120B
    'llama-3.1-8b-instant',                       // 8B: fast/punchy action beats, distinct voice for erratic/poetic internal monologue; 14.4K RPD makes it a high-volume last resort
    // These 3 models deprecated between March–Sept 2025 — see: https://console.groq.com/docs/deprecations
    // 'deepseek-r1-distill-llama-70b', // Deeply analytical pacing, vivid logic mapping. (deprecated Sept 2, 2025)
    // 'mixtral-8x7b-32768', // Atmospheric, moody, and highly descriptive. (deprecated March 5, 2025)
    // 'gemma2-9b-it', // Unique vocabulary, great for erratic/poetic internal monologues. (deprecated Aug 8, 2025)
  ],
  cerebras: [
    'gpt-oss-120b', // Production model; strong general quality
    'zai-glm-4.7',
    // TODO: is it really available now?
    // llama-3.3-70b scheduled for deprecation Feb 16 2026 — verify at https://cloud.cerebras.ai
    'llama-3.3-70b', // Instantaneous generation. Action-oriented, direct, punchy pulp fiction. (along with qwen-3-32b - scheduled for deprecation on February 16, 2026)
    'llama3.1-8b', // Fast, punchy — closest in spirit to the old llama-3.3-70b pick
  ],
  nvidia: [
    // Verify still in NIM catalog — Mixtral variants deprecated elsewhere
    'meta/llama-3.3-70b-instruct', // Tightly paced, structurally robust.
    'qwen/qwen2.5-72b-instruct', // Intricate, heavily detailed. Ideal for massive lore.
  ],
  cloudflare: [
    '@cf/mistral/mistral-7b-instruct-v0.1', // Raw European tone hosted directly on the edge.
    '@cf/meta/llama-3.1-8b-instruct', // Punchy, fast, and excellent for sudden jump-scare pacing.
    '@cf/qwen/qwen1.5-14b-chat-awq', // Great for intricate physical environment descriptions.
    '@cf/google/gemma-3-12b-it',
  ],
  cohere: [
    'command-r-08-2024' // Reads like an academic summary. Use only as a last resort for prose.
  ],
};

/**
 * Lightning-fast model (like Llama 3 on Groq) for theme & custom action validation
 */
export const AI_CHAT_MODELS_FAST: AIModelSelection = {
  groq: [
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
  ],
  // TODO: is it really available now?
  cerebras: ['llama-3.3-70b'],
  nvidia: ['meta/llama-3.3-70b-instruct'],
};

/**
 * Small but creative model for idea brainstorming
 */
export const AI_CHAT_MODELS_IDEA: AIModelSelection = {
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
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
  openrouter: [
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'mistralai/mistral-small-3.2', // Surprisingly expressive and emotionally rich prose
    'meta-llama/llama-3.1-8b-instruct:free', // Reliable but uninspiring; good at following story-state rules, weak at producing memorable prose.
    'nvidia/nemotron-nano-9b-v2:free' // Replaces Gemma. Punchy, unique vocabulary, great for erratic character thoughts.
  ],
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/qwen/qwen1.5-7b-chat-awq'
  ],
  cohere: ['command-r-08-2024'],
};

/**
 * Generating story theme ideas and meta-directives.
 * Prefers fast, highly structured, smaller models that excel at brainstorming.
 */
export const AI_CHAT_MODELS_THEME: AIModelSelection = {
  ...AI_CHAT_MODELS_IDEA,
  ...AI_CHAT_MODELS_FAST,
};

/**
 * Validating story theme ideas and meta-directives.
 * Prefers fast, highly structured, smaller models that excel at analyzing.
 */
export const AI_CHAT_MODELS_VALIDATOR: AIModelSelection = {
  ...AI_CHAT_MODELS_FAST,
  ...AI_CHAT_MODELS_IDEA,
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
  openrouter: [
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'meta-llama/llama-4-maverick:free', // Large context, broad fallback
    'nvidia/nemotron-3-super:free', // MoE architecture handles multilingual subtext very well.
    'deepseek/deepseek-r1:free', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  cloudflare: [
    '@cf/qwen/qwen1.5-14b-chat-awq', // Qwen is notoriously strong at multilingual tasks.
    '@cf/mistral/mistral-7b-instruct-v0.1'
  ],
  // Possesses enough language complexity to grasp context, maintain story continuity, and accurately translate dialogue.
  // Optimized for 10 core languages: English, French, Spanish, Italian, German, Portuguese, Japanese, Korean, Chinese, Arabic.
  cohere: [
    'command-r-08-2024' // Natively optimized for 10 core global languages.
  ],
};

/**
 * Scoring, evaluating, and error-correcting previously generated JSON state/pages.
 * Requires large context windows, strict schema adherence, and analytical logic mapping.
 */
export const AI_CHAT_MODELS_EVALUATION: AIModelSelection = {
  mistral: [
    'mistral-large-latest',
  ],
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  openrouter: [
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'meta-llama/llama-4-maverick:free', // Large context, broad fallback
    'nvidia/nemotron-3-super:free', // 1M context easily handles parsing massive full-story payloads.
    'deepseek/deepseek-r1:free', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text. Incredible at analyzing strict JSON constraints and finding errors.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct'
  ],
  cohere: [
    'command-r-08-2024'
  ],
};