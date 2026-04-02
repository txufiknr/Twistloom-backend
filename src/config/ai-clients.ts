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
 * | Jina AI       | jina-embeddings-v3         | 500  | 1,000,000   | 8K         | Embeddings only, 1M tok/day |
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
 * @see https://docs.cerebras.ai/inference/rate-limits
 * @see https://docs.api.nvidia.com/nim/reference/rate-limits
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 * @see https://api.jina.ai/redoc#tag/embeddings
 */
export const AI_RATE_LIMITS: Record<AIChatProvider, { rpm: number; rpd: number }> = {
  github: { rpm: 15, rpd: 150 },           // 10-15 RPM varies by model, ~150 RPD safe estimate (10-15 RPM × 10-15 requests avg per day)
  gemini: { rpm: 15, rpd: 1_500 },         // 15 RPM for Flash, 2 RPM for Pro (15 RPM × 100 safe utilization)
  cohere: { rpm: 100, rpd: 10_000 },       // 100 RPM, 10K RPD documented
  mistral: { rpm: 60, rpd: 86_400 },       // 1 req/sec enforced = 60 RPM, ~86.4K RPD max (60 RPM × 60 min × 24 hours (1B tokens/month is huge))
  groq: { rpm: 30, rpd: 14_400 },          // 30 RPM, 14.4K RPD documented (30 RPM × 60 min × 8 hours safe window)
  cerebras: { rpm: 30, rpd: 14_400 },      // Same as Groq (same RPM/RPD limits)
  nvidia: { rpm: 40, rpd: 57_600 },        // 40 RPM documented, ~57.6K RPD max (40 RPM × 60 min × 24 hours (conservative))
};

/**
 * Safety buffer percentage for rate limiting
 * Applied to actual RPM to prevent hitting limits
 */
export const RATE_LIMIT_SAFETY_BUFFER_PERCENT = 8;

/**
 * Maximum total prompt length including system prompt + user prompt (in characters)
 * 
 * This is the hard limit for the entire request payload to the API.
 * Exceeding this will result in:
 * - Gemini/Groq/GitHub/Mistral: Hard error (400 Bad Request)
 * - Cohere: Silent truncation from the end (DANGEROUS - instructions may be lost)
 * 
 * Always validate prompt length before sending:
 * ```typescript
 * const totalLength = systemPrompt.length + articleText.length + instructions.length;
 * if (totalLength > MAX_PROMPT_LENGTH[provider]) {
 *   // Switch to provider with larger context OR truncate article
 * }
 * ```
 * 
 * Model context window and token limits for each AI chat provider
 * 
 * | Provider      | Model                      | Context    | Max Input    | Max Input Chars | Max Article  |
 * |---------------|----------------------------|------------|--------------|-----------------|--------------|
 * | Gemini        | gemini-2.5-flash-lite      | 1M tokens  | ~900K tokens | ~3,600,000      | ~3,500,000   |
 * | Cohere        | command-r-08-2024          | 128K       | ~125K tokens | ~500,000        | ~480,000     |
 * | Groq          | llama-3.3-70b-versatile    | 128K       | ~120K tokens | ~480,000        | ~460,000     |
 * | Cerebras      | llama-3.3-70b              | 128K       | ~120K tokens | ~480,000        | ~460,000     |
 * | NVIDIA NIM    | meta/llama-3.3-70b         | 128K       | ~120K tokens | ~480,000        | ~460,000     |
 * | GitHub Models | gpt-4o                     | 128K       | ~120K tokens | ~480,000        | ~460,000     |
 * | Mistral       | mistral-large-latest       | 256K       | ~250K tokens | ~1,000,000      | ~980,000     |
 * 
 * Token-to-character conversion: ~4 characters per token (English text average)
 * Max Article Chars = Max Input Chars - System Prompt Buffer (~20,000 chars)
 * 
 * @see https://ai.google.dev/gemini-api/docs/models/gemini#gemini-2.5-flash
 * @see https://ai.google.dev/gemini-api/docs/models/gemini#model-variations
 * @see https://docs.cohere.com/docs/models#command-r-08-2024
 * @see https://docs.cohere.com/docs/models#context-length
 * @see https://console.groq.com/docs/models
 * @see https://docs.cerebras.ai/inference/models
 * @see https://docs.api.nvidia.com/nim/reference/meta-llama3-3-70b-instruct
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 */
export const MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini: 3_600_000,     // Full 1M token context (~4M chars, use 3.6M safe)
  cohere: 500_000,       // Full 128K token context (~512K chars, use 500K safe)
  groq: 480_000,         // Full 128K token context (~512K chars, use 480K safe)
  cerebras: 480_000,     // Same as Groq
  nvidia: 480_000,       // Same as Groq/Cerebras
  github: 480_000,       // GPT-4o 128K context
  mistral: 1_000_000,    // 256K token context (~1,024K chars, use 1M safe)
};

export const AI_CHAT_MODELS_WRITING: AIModelSelection = {
  /**
   * GitHub Models inference (OpenAI-compatible). Primary model first; mini as fallback.
   * @see https://github.com/marketplace/models
   */
  gemini: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
  mistral: ['mistral-large-latest'],
  cohere: [
    /** 35B parameter model for complex text with nuanced understanding and better quality */
    'command-r-08-2024',
    /** 7B parameter model for fast, cost-effective processing of straightforward tasks */
    'command-r7b-12-2024'
  ]
}

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
  cohere: [
    /** 35B parameter model for complex text with nuanced understanding and better quality */
    'command-r-08-2024',
    /** 7B parameter model for fast, cost-effective processing of straightforward tasks */
    'command-r7b-12-2024'
  ],
  groq: ['llama-3.3-70b-versatile'],
  cerebras: ['llama-3.3-70b', 'llama-3.1-70b', 'llama3.1-8b'],
  nvidia: ['meta/llama-3.3-70b', 'mistralai/mistral-large', 'mistralai/mistral-7b-instruct'],
}

export const TIER_S_PROVIDERS: AIChatProvider[] = ['github', 'gemini'];