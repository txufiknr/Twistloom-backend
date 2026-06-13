import type { AIChatProvider, AIModelSelection } from "../types/ai-chat.js";

/**
 * Rate limit configuration for each AI provider based on typical free tier limits
 * Free tier rate limits (as of March 2026):
 * 
 * | Provider      | Model                      | RPM  | RPD         | Context    | Notes                       |
 * |---------------|----------------------------|------|-------------|------------|-----------------------------|
 * | GitHub Models | gpt-4o                     | 10-15| 50-150      | 128K       | Best quality, varies by model|
 * | Gemini        | gemini-2.5-flash-lite      | 15   | ~1,500      | 1M tokens  | Flash: 15 RPM, Pro: 2 RPM   |
 * | Cohere        | command-r-08-2024          | 100  | 10,000      | 128K       | V2 API with RAG             |
 * | Mistral       | mistral-large-latest       | 60   | ~86,400     | 256K       | 1 req/sec, 1B tokens/mo     |
 * | Groq          | llama-3.3-70b-versatile    | 30   | 14,400      | 128K       | Fast inference              |
 * | Cerebras      | llama-3.3-70b              | 30   | 14,400      | 128K       | Fastest inference           |
 * | NVIDIA NIM    | meta/llama-3.3-70b         | 40   | ~57,600     | 128K       | Higher RPM than Groq        |
 * | HuggingFace   | facebook/bart-large-cnn    | ~60* | ~1,000*     | 1K         | *Undocumented, estimated    |
 * 
 * RPM = Requests Per Minute
 * RPD = Requests Per Day (conservative estimates based on RPM × 1440 min/day or documented daily limits)
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
  github: { rpm: 15, rpd: 150 },      // 10-15 RPM varies by model, ~150 RPD safe estimate (10-15 RPM × 10-15 requests avg per day)
  gemini: { rpm: 15, rpd: 1_500 },    // 15 RPM for Flash, 2 RPM for Pro (15 RPM × 100 safe utilization)
  cohere: { rpm: 100, rpd: 10_000 },  // 100 RPM, 10K RPD documented
  mistral: { rpm: 60, rpd: 86_400 },  // 1 req/sec enforced = 60 RPM, ~86.4K RPD max (60 RPM × 60 min × 24 hours (1B tokens/month is huge))
  groq: { rpm: 30, rpd: 14_400 },     // 30 RPM, 14.4K RPD documented (30 RPM × 60 min × 8 hours safe window)
  cerebras: { rpm: 30, rpd: 14_400 }, // Same as Groq (same RPM/RPD limits)
  nvidia: { rpm: 40, rpd: 57_600 },   // 40 RPM documented, ~57.6K RPD max (40 RPM × 60 min × 24 hours (conservative))
};

/**
 * Safety buffer percentage for rate limiting
 * Applied to actual RPM to prevent hitting limits
 */
export const AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT = 8;

/**
 * Maximum total prompt length including system prompt + user prompt (in characters)
 * 
 * This is the hard limit for the entire request payload to the API.
 * Exceeding this will result in:
 * - Gemini/Groq/GitHub/Mistral: Hard error (400 Bad Request)
 * - Cohere: Silent truncation from the end (DANGEROUS - instructions may be lost)
 * 
 * Note:
 * - Token-to-character conversion: ~4 characters per token (English text average)
 * - This is rough estimation rather than exact token calculation which requires separate tokenizer library
 * - Always validate prompt length before sending
 * 
 * If you need exact count before sending your prompt, you can use Vercel AI SDK Core
 * using `experimental_countTokens` for provider-agnostc way:
 * 
 * `pnpm add ai @ai-sdk/openai @ai-sdk/google @ai-sdk/anthropic`
 * 
 * Or use separate tokenizer library for each provider:
 * - OpenAI: tiktoken
 * - Gemini: Uses a native remote model.count_tokens(text) API call.
 * - Cohere: Provides a local tokenizer or an API endpoint via coheretokenizer.
 * - Mistral: mistral-common
 * - Groq (Meta Llama 3): transformers
 * 
 * @example
 * ```typescript
 * const totalLength = systemPrompt.length + userPrompt.length;
 * if (totalLength > AI_MAX_PROMPT_LENGTH[provider]) {
 *   // Switch to provider with larger context OR truncate article
 * }
 * ```
 * 
 * Model context window and token limits for each AI chat provider
 * 
 * | Provider      | Model                      | Context    | Max Input    | Max Input Chars |
 * |---------------|----------------------------|------------|--------------|-----------------|
 * | Gemini        | gemini-2.5-flash-lite      | 1M tokens  | ~900K tokens | ~3,600,000      |
 * | Cohere        | command-r-08-2024          | 128K       | ~125K tokens | ~500,000        |
 * | Groq          | llama-3.3-70b-versatile    | 128K       | ~120K tokens | ~480,000        |
 * | Cerebras      | llama-3.3-70b              | 128K       | ~120K tokens | ~480,000        |
 * | NVIDIA NIM    | meta/llama-3.3-70b         | 128K       | ~120K tokens | ~480,000        |
 * | OpenAI        | gpt-4o                     | 128K       | ~120K tokens | ~480,000        |
 * | Mistral       | mistral-large-latest       | 256K       | ~250K tokens | ~1,000,000      |
 * 
 * @see https://ai.google.dev/gemini-api/docs/models
 * @see https://docs.cohere.com/docs/models
 * @see https://console.groq.com/docs/models
 * @see https://inference-docs.cerebras.ai/models/overview
 * @see https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 * @see https://developers.openai.com/api/docs/models
 */
export const AI_MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini: 3_600_000,     // Full 1M token context (~4M chars, use 3.6M safe)
  cohere: 500_000,       // Full 128K token context (~512K chars, use 500K safe)
  groq: 480_000,         // Full 128K token context (~512K chars, use 480K safe)
  cerebras: 480_000,     // Same as Groq
  nvidia: 480_000,       // Same as Groq/Cerebras
  github: 30_000,        // GPT-4o 8K context on GitHub Models (official OpenAI = 128K context)
  mistral: 1_000_000,    // 256K token context (~1,024K chars, use 1M safe)
};

/**
 * GitHub Models inference (OpenAI-compatible). Primary model first; mini as fallback.
 * @see https://github.com/marketplace/models
 */
export const AI_CHAT_MODELS_OPENAI: AIModelSelection = {
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini']
};

/**
 * Creative story writing (largest and creative models) - in fallback order
 * 
 * The Truth About Mistral Medium
 * Mistral Medium (and its 2026 evolution, Mistral Medium 3.5, alongside their experimental Mistral Small Creative branch) is the darling of the creative writing community for a very specific architectural reason: lighter RLHF (Reinforcement Learning from Human Feedback).
 * Models like GPT-4o are heavily fine-tuned with RLHF to be "helpful, harmless, and polite corporate assistants." This fine-tuning lobotomizes their creative edge, resulting in the classic "AI shimmer"—purple prose, repetitive sentence structures, and a desperate need to wrap every dark scene up with a moralizing, hopeful conclusion.
 * Mistral was trained differently. With a strong European literary influence and a much lighter RLHF touch, it understands subtext, character flaws, and gritty tension natively. It won't flinch when writing a terrifying, ambiguous thriller scene. If your priority is breathtaking, emotionally resonant prose, Mistral should sit at the absolute top of your fallback array.
 * 
 * Why Claude and Mistral Rule the Creative Space
 * If your absolute priority is making a human reader feel an emotional ache, Claude 3.7 Sonnet and Mistral Medium are in a league of their own.
 * Standard AI models (like base GPT-4o or Cohere) are trained heavily on corporate data, instruction manuals, and coding. They approach writing linearly—they solve the "problem" of the prompt. Claude and Mistral handle language elastically. They understand how to build tension using short, fragmented sentences, when to deploy an unusual metaphor, and how to make dialogue sound natural by leaving things unsaid.
 */
export const AI_CHAT_MODELS_WRITING: AIModelSelection = {
  // Soulful, literary, atmospheric. Excellent for moody or classic prose styles.
  mistral: [
    // Why it excels for fiction:
    // Mistral Medium consistently outperforms larger models when it comes to capturing distinct character voices, handling subtext, and mimicking subtle prose styles.
    // It avoids the rigid, formulaic sentence structures common in other AI models, rendering a translation that reads less like a machine and more like a human author.
    // For short chapters where you want the most breathtaking, artistic, and emotionally resonant prose.
    'mistral-medium-latest',
    // Highly precise, vocabulary-dense. Flawless with complex world-building. Can sometimes feel cold or clinical.
    'mistral-large-latest'
  ],

  gemini: [
    'gemini-3-flash-preview', // Vivid, highly descriptive, imaginative. Phenomenal at sensory world-building.
    'gemini-2.5-flash' // Older workhorse model.
  ],

  // Polished, cinematic, highly structured. Great for fast-paced, plot-driven stories.
  // TODO: activate when using official OpenAI: 8K context -> 128K context
  // ...AI_CHAT_MODELS_OPENAI,

  groq: [
    'llama-3.3-70b-versatile', // Incredible at maintaining cohesive plot structures, realistic action sequences, and snappy dialogue.
    // TODO: are these real valid models in "groq-sdk" (free tier)?
    // 'meta/llama-3.3-70b-specdec', // Absolute workhorse for narrative pacing. Handles snappy, realistic character conversations and high-intensity action sequences flawlessly. Cinematic, action-forward, and crisp.
    // 'deepseek-r1', // Deeply analytical, highly structured, yet remarkably vivid. Maps out the underlying logic of a scene before outputting the final text.
    // 'mistralai/mixtral-8x7b-instruct', // Atmospheric, moody, and highly descriptive. Detailed physical settings with highly unique imagery.
    // 'google/gemma-2-9b-it', // Poetic, surprising, but short-winded. Unique vocabulary and emotional descriptors.
  ],

  cerebras: [
    'llama-3.3-70b', // Llama 70B is highly creative for thriller and fast-paced sci-fi. Direct, punchy, action-oriented. Good for raw drafting, pulp fiction, or urban fantasy.
    // TODO: are these real valid models in "@cerebras/cerebras_cloud_sdk" (free tier)?
    // 'kimi-k2.6', // Deeply atmospheric, evocative, and narrative-focused. Writes beautifully paced storytelling. Extensive high-quality prose corpora. Mimics a human author's rhythmic style.
    // 'qwen3-235b-instruct', // Epic in scale, heavily detailed, and visually immersive. Writes beautifully detailed physical descriptions. Handles specialized vocabulary and complex timelines flawlessly.
    // 'zai-glm-4.7', // Philosophical, emotionally resonant, and elegant. Highly capable of subtle text variations, allowing dialogue to feel sharp and subtext-heavy. Naturally captures the unspoken tension between characters.
    // 'llama-3.3-70b-instruct', // Fast-moving plot architecture. Cinematic. Great action pacing; needs anti-trope prompt.
    // 'gpt-oss-120b' // Direct, classic, and fast-paced. Highly reliable for keeping a narrative moving forward sequentially.
  ],
  nvidia: [
    'meta/llama-3.3-70b',
    'mistralai/mistral-large',
    'mistralai/mistral-7b-instruct',
    // TODO: are these real valid models in NVIDIA NIM REST API (free tier)?
    // 'meta/llama-3.3-70b-instruct', // Action-packed, visually descriptive, and highly consistent. Cinematic, tightly paced, and structurally robust.
    // 'mistralai/mistral-large-3-675b-instruct-2512', // Atmospheric, deeply vocabulary-dense, and highly literary.
    // 'mistralai/mixtral-8x22b-instruct', // Moody, atmospheric, and highly artistic. Captures emotional longing and environmental tension more naturally than Llama.
    // 'yi-large', '01-ai/yi-1.5-34b-chat', // Flowing, highly expressive, and poetic. A famously a "hidden gem" for creative writing.
    // 'qwen/qwen2.5-72b-instruct', // Intricate, heavily detailed, epic in scale. Unmatched if you are building massive, high-fantasy worlds, magic systems, or complex political sci-fi lore.
  ],

  // Dry, functional, narrative-focused. Reads like an academic summary or historical chronicle.
  cohere: ['command-r-08-2024'],
};

// Summarizing story context (small but creative)
export const AI_CHAT_MODELS_SUMMARIZING: AIModelSelection = {
  /**
   * Gemini Generative AI models (2026)
   * @see https://aistudio.google.com/models/gemini-3
   * 
   * Model Name              Rate Limit           Best Use Case
   * gemini-3-flash-preview  15 RPM / 20 RPD      High-speed frontier intelligence
   * gemini-2.5-flash        15 RPM / 20-50 RPD   Best price-performance, large scale processing
   * gemini-2.5-flash-lite   15 RPM / 50+ RPD     Lightweight tasks, high volume
   * gemini-1.5-flash        15 RPM               Fast, high-volume tasks (legacy)
   * gemini-1.5-flash-8b     High                 Ultra-lightweight tasks (legacy)
   */
  gemini: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash-8b', 'gemini-1.5-flash'],
  mistral: ['mistral-medium-latest', 'mistral-small-latest'],
  cohere: ['command-r-08-2024'],
  groq: ['llama-3.3-70b-versatile'],
  cerebras: ['llama-3.3-70b', 'llama-3.1-70b', 'llama3.1-8b'],
  nvidia: ['meta/llama-3.3-70b', 'mistralai/mistral-large', 'mistralai/mistral-7b-instruct'],
};

// Story book and page translation (largest high-quality models)
export const AI_CHAT_MODELS_TRANSLATION: AIModelSelection = {
  // Mistral’s architecture handles European languages (especially French, Spanish, German, and Italian) with a deeply innate grasp of cultural subtext and literary grammar.
  // If you are translating into or out of European languages (French, Spanish, German, Italian), Mistral is historically superior due to its training bias.
  mistral: [
    'mistral-medium-latest', // Favored by authors for its superior creative fluidity.
    'mistral-large-latest', // Unparalleled multilingual vocabulary accuracy.
  ],
  // If you are dealing with Asian or Middle Eastern languages, Gemini 3 Flash offers vastly more balanced and robust global multilingual capability.
  gemini: [
    'gemini-3-flash-preview', // Decode abstract metaphors and poetic dialogue instead of reverting to rigid, literal phrasing.
    'gemini-2.5-flash' // Prose tends to be formulaic and "AI-like." It often flattens unique author quirks and translates idioms directly rather than finding cultural equivalents.
  ],
  // ...AI_CHAT_MODELS_OPENAI, // TODO: activate when using official OpenAI: 8K context -> 128K context
  cohere: [
    // Possesses enough language complexity to grasp context, maintain story continuity, and accurately translate dialogue.
    // Optimized for 10 core languages: English, French, Spanish, Italian, German, Portuguese, Japanese, Korean, Chinese, Arabic.
    'command-r-08-2024'
  ],
};

// Story book and page generation result scoring and evaluation (largest high-quality models)
export const AI_CHAT_MODELS_EVALUATION: AIModelSelection = {
  ...AI_CHAT_MODELS_WRITING,
};

// Generating story theme idea (small but creative)
export const AI_CHAT_MODELS_THEME: AIModelSelection = {
  ...AI_CHAT_MODELS_OPENAI,
  ...AI_CHAT_MODELS_SUMMARIZING
};