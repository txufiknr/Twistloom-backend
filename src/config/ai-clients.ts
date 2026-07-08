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

  /**
   * Updated Google AI Studio Text Chat Model (Post-December 2025 Cuts)
   * Ranked from Best Story Writing Capabilities to Lowest
   * 
   * | Model ID | Release Date | Context Window Size | Requests Per Minute (RPM) | Requests Per Day (RPD) | Story Writing Benchmark Profile |
   * |---|---|---|---|---|---|
   * | gemini-3.1-pro | Feb 19, 2026 | 2,097,152 tokens | 5 RPM | 100 RPD | Master Novelist: Unparalleled structural memory; catches deep emotional subtext, handles nonlinear plotting, and mimics specific author voices beautifully. |
   * | gemini-2.5-pro | Late 2025 | 2,097,152 tokens | 5 RPM | 100 RPD (Down to 25 RPD on some accounts) | Excellent Wordsmith: Exceptionally deep context tracking; highly descriptive prose but marginally less experimental with its metaphors than 3.1. |
   * | gemma-3-27b-it | Mar 12, 2025 | 131,072 tokens | ~30 RPM | ~1,500 RPD | Unfiltered Creative: Because open-weights lack commercial pipeline restrictions, it writes gritty, incredibly stylistic, and raw short-form narratives. |
   * | gemini-3.5-flash | May 19, 2026 | 1,048,576 tokens | 10 RPM | 250 RPD | Fast-Paced Action: Strong vocabulary upgrades over 2.5. Best Flash variant for punchy, rapid dialogue generation and high-stakes thriller drafting. |
   * | gemini-3-flash-preview | Dec 17, 2025 | 1,048,576 tokens | 10 RPM | 250 RPD (some sources say 1,500 RPD) | Brainstorming Partner: Highly adaptive for rapid outline prototyping or multi-branch plot development, though raw prose can lean generic. |
   * | gemma-3-4b-it | Mar 12, 2025 | 131,072 tokens | ~30 RPM | ~1,500 RPD | Indie Micro-Fiction: Compact, expressive, and snappy. Highly effective for short fairy tales or quick scene adjustments, though limited by lower absolute logic. |
   * | gemini-2.5-flash | Mid 2025 | 1,048,576 tokens | 10 RPM | 250 RPD | Basic Co-Writer: Best used as an editor to check grammar or rewrite your blocks of text; struggles to generate thousands of original narrative words without looping. |
   * | gemini-3.1-flash-lite | May 7, 2026 | 1,048,576 tokens | 15 RPM | 1,000 RPD | World-Building Index: Great for processing high-volume text fast, but write profile is heavily clinical. Best for generation of NPC barks or item lore descriptions. |
   * | gemini-2.5-flash-lite | Mid 2025 | 1,000,000 tokens | 15 RPM | 1,000 RPD | The Glossary: Lowest creative voice depth; prose is predictable and basic. Perfect strictly for quick character names or background detail tables. |
   * 
   * Verify in AI Studio:
   * @see https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas
   * @see https://aistudio.google.com/rate-limit
   */
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
 * However, Qwen3-30B-A3B outperforms or heavily rivals Mistral-Medium-latest across creative writing and handling complex schemas.
 * It provides much deeper narrative pacing and far superior schema adherence at a fraction of the inference cost.
 * 
 * Legacy (don't use):
 * - mistralai/mistral-7b-instruct // Classic Mistral raw tone, completely free.
 * - google/gemma-2-9b-it // Poetic, surprising, with highly unique vocabulary.
 * - mistralai/mixtral-8x22b-instruct-v0.1 // Deeply artistic, excellent at environmental tension.
 * 
 * @see https://openrouter.ai/models to see whether these IDs are still :free before relying on them.
 * @see https://console.groq.com/docs/models
 * @see https://console.groq.com/docs/structured-outputs#supported-models and https://console.groq.com/docs/tool-use/overview to see json schema supportability.
 * @see https://console.groq.com/docs/deprecations to see deprecated Groq models and recommended replacements.
 * @see https://developers.cloudflare.com/workers-ai/models for current model IDs/availability.
 */
export const AI_CHAT_MODELS_WRITING: AIModelSelection = {
  openrouter: [
    'qwen/qwen3-30b-a3b', // 256K+ tokens. Excellent JSON. Toggleable Reasoning. Creative and imaginative with good character voice variety.
    'google/gemini-2.5-flash', // 1,048,576 (1M) Tokens. Excellent JSON. Hybrid reasoning. Extremely strong prose quality, pacing, emotion, and instruction-following.
    'z-ai/glm-4.5-air', // 128K tokens. Excellent JSON. Toggleable Reasoning. Clean, coherent, reliable storyteller with natural dialogue.
    'meta-llama/llama-4-maverick:free', // 1,048,576 (1M) Tokens. Excellent JSON. Toggleable reasoning. Strong narrative fluidity and voice, benefiting from a massive, rich dataset of human social interactions.
    'nvidia/nemotron-3-super:free', // 1,000,000 (1M) tokens. Excellent JSON. Toggleable Reasoning. Replaces Mixtral. Massive MoE model, exceptional atmospheric tension.
    'deepseek/deepseek-r1:free', // 128K+ tokens. Superior JSON. Native Reasoning. Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text.
    'meta-llama/llama-3.3-70b-instruct:free', // 128K tokens. Very good JSON. Standard Model. Very fluid, natural vocabulary. Excellent at keeping character dialogue sounding organic and culturally nuanced.
  ],
  mistral: [
    'mistral-medium-latest', // 128K tokens. Good JSON. Standard Model. The Prose Champion. Unmatched human-like fluidity and distinct character voices.
    'mistral-large-latest' // Highly precise, vocabulary-dense. Ideal for complex environmental descriptions.
  ],
  gemini: [
    // 'gemini-3.1-pro', // Entirely blocked on the free tier. Unrivaled world-building and character memory. It naturally avoids cliché prose, catches subtle subtext, and introduces complex narrative framing.
    // 'gemini-3.1-pro-preview', // Entirely blocked on the free tier.
    'gemini-2.5-pro', // Strong emotional nuance, handles complex subplots well, and avoids clichés much better than the Flash models. It is highly reactive to complex prompt instructions regarding prose style and meter.
    'gemini-3.5-flash', // Prose is clean, coherent, and highly adaptable to action, sci-fi, and fast-paced adventure writing.
    'gemini-3-flash-preview', // Vivid and highly descriptive. Phenomenal at sensory world-building.
    'gemini-2.5-flash' // A reliable, highly accessible baseline model. It handles plot progression and narrative outlines beautifully.
  ],
  groq: [
    'openai/gpt-oss-120b', // deepest psychological complexity, best for sustained horror dread
    'openai/gpt-oss-20b', // structurally reliable fallback, same OpenAI lineage as 120B
    'qwen/qwen3.6-27b',

    // TODO: deprecated Jul 17, 2026
    'qwen/qwen3-32b', // intricate atmospheric layering; 60 RPM (2x other models)
    'meta-llama/llama-4-scout-17b-16e-instruct', // MoE: excellent for continuity-heavy branching scenes

    // TODO: deprecated on Aug 16, 2026
    'llama-3.1-8b-instant', // fast/punchy action beats, distinct voice for erratic/poetic internal monologue; 14.4K RPD makes it a high-volume last resort

    // All models
    // openai/gpt-oss-20b ✅ // Strict Mode (strict: true)
    // openai/gpt-oss-120b ✅ // Strict Mode (strict: true)
    // openai/gpt-oss-safeguard-20b ✅ // Best-effort Mode (strict: false)
    // qwen/qwen3-32b ✅
    // qwen/qwen3.6-27b ✅
    // meta-llama/llama-4-scout-17b-16e-instruct ✅ // Best-effort Mode (strict: false)
    // llama-3.3-70b-versatile ✅
    // llama-3.1-8b-instant ✅
  ],
  cerebras: [
    'gpt-oss-120b', // Production model; strong general quality
    'zai-glm-4.7',
    // TODO: is it really available now?
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
    // TODO: deprecated on Aug 16, 2026
    'llama-3.3-70b-versatile', // cinematic, fast-paced action, sharp dialogue, proven thriller prose
    'llama-3.1-8b-instant', // fast/punchy action beats, distinct voice for erratic/poetic internal monologue; 14.4K RPD makes it a high-volume last resort
  ],
  cerebras: [
    // TODO: is it really available now?
    'llama3.1-8b', // Fast, punchy — closest in spirit to the old llama-3.3-70b pick
  ],
};

/**
 * Small but creative model for idea brainstorming
 */
export const AI_CHAT_MODELS_IDEA: AIModelSelection = {
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite', // Generic, "safe" creative prose. It shines brightest at micro-creative tasks: crafting quick character descriptions, naming fictional places, generating short status messages, or writing brief background dialogue snippets for NPCs.
    'gemini-2.5-flash-lite',
    'gemma-3-27b-it', // Outstanding for raw, highly stylistic, and gritty short-form stories.
    'gemma-3-4b-it' // Can be highly expressive for creative writing. Excel at writing quirky, stylistic, and highly unfiltered prose.
  ],
  mistral: [
    'mistral-small-latest',
    'mistral-medium-latest'
  ],
  openrouter: [
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'mistralai/mistral-small-3.2', // Surprisingly expressive and emotionally rich prose
    'meta-llama/llama-3.1-8b-instruct:free', // Reliable but uninspiring; good at following story-state rules, weak at producing memorable prose.
    'nvidia/nemotron-nano-9b-v2:free' // Replaces Gemma. Punchy, unique vocabulary, great for erratic character thoughts.
  ],
  groq: [
    'openai/gpt-oss-20b', // structurally reliable fallback, same OpenAI lineage as 120B
    'qwen/qwen3.6-27b',
  ],
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/qwen/qwen1.5-7b-chat-awq'
  ],
  nvidia: ['meta/llama-3.3-70b-instruct'],
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
 * Prefers fast, highly structured, smaller models that excel at policy enforcement, content moderation, and compliance checking.
 */
export const AI_CHAT_MODELS_VALIDATION: AIModelSelection = {
  ...{...AI_CHAT_MODELS_IDEA, groq: [
    'openai/gpt-oss-safeguard-20b', // fine-tuned from GPT-OSS, this model helps classify text content based on customizable policies
    ...(AI_CHAT_MODELS_IDEA.groq ?? []),
  ]},
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
  groq: [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b', // structurally reliable fallback, same OpenAI lineage as 120B
    'qwen/qwen3.6-27b',
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
  openrouter: [
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'meta-llama/llama-4-maverick:free', // Large context, broad fallback
    'nvidia/nemotron-3-super:free', // 1M context easily handles parsing massive full-story payloads.
    'deepseek/deepseek-r1:free', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text. Incredible at analyzing strict JSON constraints and finding errors.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  mistral: [
    'mistral-large-latest',
  ],
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  groq: [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-safeguard-20b', // fine-tuned from GPT-OSS, this model helps classify text content based on customizable policies
    'openai/gpt-oss-20b', // structurally reliable fallback, same OpenAI lineage as 120B
  ],
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct'
  ],
  cohere: [
    'command-r-08-2024'
  ],
};