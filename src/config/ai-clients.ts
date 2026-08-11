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
 * | Jina (embed)  | 100  | n/a (TPM)   | 100K TPM, 2 concurrent — not a chat provider.  |
 * 
 * New additions (added 2026-08-04, from the new free-tier provider batch assessment.
 * Every figure below is a conservative estimate reconciled from third-party trackers
 * that visibly disagree with each other, NOT a number pulled from a stable, versioned
 * API contract the way the original 9 mostly are. Re-verify each one in the provider's
 * own console before trusting it as a hard ceiling — see the per-provider comments
 * below for exactly what's uncertain about each figure.
 * 
 * | Provider    | RPM  | RPD    | Notes                                             |
 * |-------------|------|--------|----------------------------------------------------|
 * | OVHcloud    | 400  | n/a    | 400 RPM authenticated (per project per model); no published daily cap yet. 2 RPM anonymous/no-signup tier also exists. |
 * | SambaNova   | 15   | n/a    | Published figures conflict wildly (20 vs 600 RPM across sources) — using a conservative floor. Free tier = no payment method on file. |
 * | Ollama      | 10   | 50     | Not actually RPM/RPD — real quota is GPU-time on a 5h session / 7d weekly cycle. Both numbers here are an ESTIMATED safety proxy, not an official figure. |
 * | ModelScope  | 30   | 500    | 500 RPD is the *per-model* cap (2,000 RPD total across all models) — using the safer per-model number as the ceiling, same reasoning as the Groq entry below. |
 * | Z.ai        | 5    | 100    | Third-party figures range from "1 concurrent request" to "~1,000/day" — deliberately conservative until confirmed. Use the z.ai (international) endpoint, not bigmodel.cn. |
 * | SiliconFlow | 10   | 50     | 50 RPD is the true no-cost default; rises to 1,000 RPD only after a ~$10 credit top-up (spent or not). Assumes the siliconflow.com platform, not .cn. |
 * | Aion Labs   | 15   | n/a    | Real constraint is ~20K tokens/day, not a request count — same "token budget, not RPD" pattern as Mistral/NVIDIA below. Deliberately tiny; reserved for IDEA/THEME-scale calls only. |
 * | Chutes      | 10   | 200    | No official ceiling published ("no hard cap" per one tracker) — this is a cautious made-up number pending real traffic data. Decentralized/miner-served; prefer TEE-flagged models. |
 * | LLM7.io     | 60   | n/a    | 60 RPM / 2 req/sec matches the registered-token tier; real daily gate is a 1M-token/day budget, not a request count. Treat as last-resort — unofficial mirror, no SLA. |
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
 * @see https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities
 * @see https://docs.sambanova.ai/docs/en/models/rate-limits
 * @see https://ollama.com/pricing
 * @see https://modelscope.ai/docs/model-service/API-Inference/limits
 * @see https://docs.z.ai (international) — do not use open.bigmodel.cn, it requires China phone verification
 * @see https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation
 * @see https://www.aionlabs.ai/docs/pricing/
 * @see https://chutes.ai/terms
 * @see https://docs.llm7.io/limits
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

  // Embeddings only (jina-embeddings-v5-text-small), not a chat provider.
  // Free tier: 100 RPM, 100K TPM, 2 concurrent requests — no fixed daily/
  // monthly cap, so rpd/rpmo are intentionally omitted (same pattern as
  // mistral/nvidia). canUseAIToday('jina') will always pass; RateLimiter's
  // RPM throttling is what actually protects this provider.
  // @see https://jina.ai/embeddings/
  jina:       { rpm: 100 },

  // --- New additions (2026-08-04 provider assessment) ---
  // Every entry below is a *conservative estimate*, not a figure pulled from
  // a stable versioned contract. Re-verify in each provider's own console
  // before raising any of these — see /areas/twistloom.md for the full
  // provider-by-provider writeup these numbers come from.

  // 400 RPM authenticated, per Public Cloud project per model — a real,
  // published ceiling (not an estimate, unlike most of the entries below).
  // No daily request cap currently published; OVHcloud's docs explicitly
  // state AI Endpoints imposes no usage limit beyond rate/payload size as
  // of today, but note they reserve the right to add one later — omitting
  // rpd rather than inventing a number, same reasoning as mistral/nvidia.
  // A 2 RPM/IP anonymous tier also exists (no signup) if you ever need a
  // zero-setup emergency fallback, but 400 RPM authenticated is what you'd
  // actually build the waterfall against.
  ovhcloud:   { rpm: 400 },

  // Free tier = automatic whenever no payment method is linked to the
  // account (no opt-in needed, but also easy to accidentally lose by
  // adding a card later for something else). Published RPM figures
  // conflict hard across sources — SambaNova's own launch blog cited
  // ~600 RPM, but recent per-model trackers show 20 RPM/20 RPD/200K TPD,
  // and that lower figure may specifically be for "Preview" models
  // (SambaNova explicitly says Preview ≠ Production tier limits). Using
  // 15 RPM as a deliberately conservative floor and omitting rpd until
  // you've confirmed which figure applies to the Production models you
  // actually intend to call.
  sambanova:  { rpm: 15 },

  // Not really RPM/RPD-shaped at all: Ollama Cloud bills free-tier usage
  // against GPU-time on a 5-hour session cycle *and* a 7-day weekly cycle,
  // not a calendar day — so canUseAIToday()'s daily-reset assumption is a
  // mismatch for this provider specifically. Both numbers below are an
  // invented safety proxy (mirroring how `cerebras` below turns a token
  // budget into an rpd estimate), deliberately conservative given there's
  // no published SLA and one independent tracker reported a ~95%
  // failure-rate window on Ollama Cloud in April 2026. Free tier is also
  // restricted to lighter "level 1-2" models — don't route heavy models
  // like the 480B-class coder variants through this entry.
  ollama:     { rpm: 10,  rpd: 50 },

  // 2,000 RPD total across all models, capped at 500 RPD per individual
  // model — using the safer per-model number as the ceiling here, same
  // reasoning as the Groq entry above (a provider-wide daily gate set to
  // the aggregate figure would stay open long after any single model's
  // real quota is exhausted). RPM isn't published; 30 is an estimate.
  // Registration may require an Alibaba Cloud account and possibly a
  // Chinese phone number — confirm before depending on this in prod.
  modelscope: { rpm: 30,  rpd: 500 },

  // GLM-4.7-Flash / GLM-4.5-Flash free tier. Third-party figures disagree
  // sharply — anywhere from "1 concurrent request" to "~1,000 req/day" —
  // so 5 RPM / 100 RPD here is a deliberately conservative floor, not a
  // confirmed number. IMPORTANT: register through the international
  // z.ai/model-api platform, not open.bigmodel.cn (the China-domestic
  // platform, which reportedly requires a Chinese phone number to sign
  // up) — same underlying GLM models either way.
  zai:        { rpm: 5,   rpd: 100 },

  // True no-cost default is ~50 RPD on the $0 models. SiliconFlow also
  // offers a credit-gated upgrade to ~1,000 RPD once you've added roughly
  // $10 of credit to the account — even unspent, having it on file raises
  // the ceiling. Left at the true-free 50 RPD here; bump this if you
  // decide the $10 top-up is worth it. Assumes the international
  // siliconflow.com platform — the .cn domain is the China-domestic
  // platform and reportedly needs a Chinese phone number to register.
  siliconflow:{ rpm: 10,  rpd: 50 },

  // The real constraint here is a token budget (~20,000 tokens/day), not
  // a request count — omitting rpd for the same reason mistral/nvidia
  // omit it above. 15 RPM is the published per-minute figure. This is
  // Aion Labs' whole free tier, and it's intentionally tiny — it's wired
  // into AI_CHAT_MODELS_IDEA below (theme/brainstorm-scale calls only),
  // not AI_CHAT_MODELS_WRITING, because a 20K token/day budget would be
  // exhausted by a single full-page generation. Aion Labs' actual
  // differentiator is that its models are fine-tuned specifically for
  // dark/mature narrative fiction — closest thematic fit to Twistloom of
  // any provider on this list — but commercial-use terms aren't clearly
  // published anywhere, so confirm that directly before leaning on it.
  aionlabs:   { rpm: 15 },

  // No official ceiling published anywhere found ("no hard cap" per one
  // tracker, which isn't the same as an SLA) — 10 RPM / 200 RPD is an
  // invented, cautious placeholder pending real traffic data. Chutes runs
  // on a decentralized Bittensor compute market: your actual request is
  // served by whichever anonymous third-party "miner" node wins that
  // request's auction, and free/cheap availability is subsidized by
  // Bittensor token economics that can shift without notice. Prefer
  // models flagged `confidential_compute: true` (TEE-protected) if you
  // route real story content through this provider — non-TEE requests
  // aren't logged by Chutes itself, but do transit an unvetted operator.
  chutes:     { rpm: 10,  rpd: 200 },

  // Registered-token tier (free, no card): 250 req/hr, 60 req/min,
  // 2 req/sec, 1,000,000 tokens/day. Using the 60 RPM figure directly;
  // omitting rpd since the real daily gate is the token budget, not a
  // request count (same reasoning as mistral/nvidia/aionlabs above).
  // IMPORTANT caveat: LLM7.io is an independent mirror/proxy that states
  // plainly it has no affiliation with the model owners it proxies —
  // including branded ones (its catalog lists gpt-4o-mini and
  // gemini-2.5-flash-lite alongside open models). That's a business model
  // that can be cut off without notice, and independent reviewers
  // describe it as "not recommended for production." Positioned as an
  // absolute last resort in the waterfall below, not a rung you'd expect
  // to hit often.
  llm7:       { rpm: 60 },
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
 * New additions — figures are conservative, model-dependent estimates (see
 * per-entry comments below), not confirmed hard ceilings the way most of
 * the table above is:
 * 
 * | Provider    | Model                    | Context (typ.) | Max Input Chars |
 * |-------------|--------------------------|-----------------|------------------|
 * | Z.ai        | glm-4.7-flash            | 200K tokens     | ~600,000         |
 * | SambaNova   | DeepSeek-V3.2 / Llama    | 128K tokens     | ~450,000         |
 * | ModelScope  | Qwen3.5-family           | ~128K tokens    | ~400,000         |
 * | Chutes      | DeepSeek-R1 / GLM-5.1    | ~128K tokens    | ~300,000         |
 * | OVHcloud    | Qwen3.6-27B / gpt-oss    | ~128K tokens    | ~120,000 (conservative — payload-size, not context, is the documented constraint) |
 * | SiliconFlow | Qwen3-8B ($0 tier)       | ~32-128K tokens | ~120,000         |
 * | LLM7.io     | gpt-4o-mini / deepseek   | 128K tokens     | ~100,000 (kept small — this is a last-resort provider, not a primary one) |
 * | Ollama      | gpt-oss:20b (free tier)  | model-dependent | ~32,000 (free tier is level 1-2 models only — stay light) |
 * | Aion Labs   | aion-2.5                 | 128K tokens     | ~40,000 (capped hard by the ~20K token/DAY budget, not the model's context window) |
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

  // If you pin a large-context free model (e.g. meta-llama/llama-4-maverick
  // with a 1M context), raise this — but remember the 20 RPM cap makes huge
  // prompts a poor fit regardless.
  openrouter: 60_000,    // ~15K tokens - Conservative default for most :free model variants.

  // Workers AI 8B-class models commonly cap around 4-8K token context.
  // Keep this small both to fit the context window and to preserve neuron
  // budget for the output.
  cloudflare: 12_000,    // ~3,000 tokens

  // Embeddings only, not a chat provider — nothing currently reads this
  // entry for jina (embedding.ts does its own input handling). Present
  // purely because AIChatProvider now includes 'jina', so this Record
  // requires every key. Value documents jina-embeddings-v5-text-small's
  // real 32,768-token input cap in characters (~4 chars/token).
  jina:       131_000,

  // --- New additions (2026-08-04 provider assessment) — see AI_RATE_LIMITS
  // above for the matching per-provider reasoning on why each of these is
  // conservative rather than confirmed.

  zai:        600_000,   // 200K tokens - GLM-4.7-Flash's published context; left headroom below the true ceiling.
  sambanova:  450_000,   // 128K tokens - Conservative for the Llama/DeepSeek-class models on the free tier.
  modelscope: 400_000,   // ~128K tokens - Qwen3.5-family typical context; verify per specific model.
  chutes:     300_000,   // ~128K tokens - Model-dependent (decentralized); kept conservative given variable serving.
  ovhcloud:   120_000,   // Conservative — OVHcloud's documented constraint is a 2MB request-body size, not a token count; this is deliberately well under that so you're bound by the model's real context, not guessing at the body-size math.
  siliconflow:120_000,   // ~32K tokens - The $0-tier models (Qwen3-8B class) skew smaller-context than the paid catalog.

  // Kept deliberately small — LLM7.io is positioned as a last-resort
  // fallback, not a provider you'd want handling your largest prompts.
  llm7:       100_000,

  // Free tier is restricted to lighter "level 1-2" models — treat like
  // the cerebras/groq free-tier caps above rather than the model's
  // theoretical max context.
  ollama:     32_000,

  // Hard-capped well below aion-2.5's real 128K context window, because
  // the actual binding constraint is the ~20,000 token/DAY budget, not
  // the model's context size — a single request anywhere near the
  // model's real max would blow the entire day's quota in one call. This
  // value assumes small IDEA/THEME-scale prompts, matching where
  // AI_CHAT_MODELS_IDEA below actually uses this provider.
  aionlabs:   40_000,
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
  mistral: [
    'mistral-medium-latest', // 128K tokens. Good JSON. Standard Model. The Prose Champion. Unmatched human-like fluidity and distinct character voices.
    'mistral-large-latest' // Highly precise, vocabulary-dense. Ideal for complex environmental descriptions.
  ],
  gemini: [
    // 'gemini-3.1-pro', // Entirely blocked on the free tier. Unrivaled world-building and character memory. It naturally avoids cliché prose, catches subtle subtext, and introduces complex narrative framing.
    // 'gemini-3.1-pro-preview', // Entirely blocked on the free tier.
    // 'gemini-2.5-pro', // No longer available to new users. Strong emotional nuance, handles complex subplots well, and avoids clichés much better than the Flash models. It is highly reactive to complex prompt instructions regarding prose style and meter.
    'gemini-3.5-flash', // Prose is clean, coherent, and highly adaptable to action, sci-fi, and fast-paced adventure writing.
    'gemini-3-flash-preview', // Vivid and highly descriptive. Phenomenal at sensory world-building.
    'gemini-2.5-flash' // A reliable, highly accessible baseline model. It handles plot progression and narrative outlines beautifully.
  ],
  openrouter: [
    'qwen/qwen3-30b-a3b', // 256K+ tokens. Excellent JSON. Toggleable Reasoning. Creative and imaginative with good character voice variety.
    'google/gemini-2.5-flash', // 1,048,576 (1M) Tokens. Excellent JSON. Hybrid reasoning. Extremely strong prose quality, pacing, emotion, and instruction-following.
    'z-ai/glm-4.5-air', // 128K tokens. Excellent JSON. Toggleable Reasoning. Clean, coherent, reliable storyteller with natural dialogue.
    'meta-llama/llama-4-maverick', // 1,048,576 (1M) Tokens. Excellent JSON. Toggleable reasoning. Strong narrative fluidity and voice, benefiting from a massive, rich dataset of human social interactions.
    'nvidia/nemotron-3-super-120b-a12b:free', // 1,000,000 (1M) tokens. Excellent JSON. Toggleable Reasoning. Replaces Mixtral. Massive MoE model, exceptional atmospheric tension.
    'deepseek/deepseek-r1', // 128K+ tokens. Superior JSON. Native Reasoning. Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text.
    'meta-llama/llama-3.3-70b-instruct:free', // 128K tokens (~131K tokens). Fair JSON. Standard Model. Very fluid, natural vocabulary. Excellent at keeping character dialogue sounding organic and culturally nuanced.
  ],
  cerebras: [
    'zai-glm-4.7', // 200K tokens. Excellent JSON. Toggleable Reasoning. Fluid dialogue and strong plot pacing. Avoids the rigid, formulaic block-text styling that plagues GPT-OSS-120B. Acts as a powerful middle ground, effectively bridging the gap between the strict structural engineering of GPT-OSS-120B and the creative versatility of Llama-3.3-70B.
  ],
  groq: [
    // TODO: deprecated Jul 17, 2026
    'meta-llama/llama-4-scout-17b-16e-instruct', // 10M tokens. Very Good JSON. Retains the signature warmth, emotional nuance, and highly organic dialogue flow that made the Llama-3 series popular, but pairs it with unparalleled long-horizon memory tracking. MoE: excellent for continuity-heavy branching scenes.
    'qwen/qwen3-32b', // Intricate atmospheric layering; 60 RPM (2x other models).

    'qwen/qwen3.6-27b', // 262K+ tokens (Extendable up to 1M). Excellent JSON. Toggleable Reasoning. Prose leans closer to the structured nature of GPT-OSS-120B. It can write a highly logical mystery plot or complex political intrigue, but its natural dialogue and emotional nuance still won't feel quite as organic or warm as Meta's Llama-3.3.
    'openai/gpt-oss-120b', // 128K tokens. Excellent JSON. Toggleable Reasoning. Sometimes feel "dry," structural, or overly analytical when tasked with creative storytelling. Deepest psychological complexity, best for sustained horror dread.
    'openai/gpt-oss-20b', // Structurally reliable fallback, same OpenAI lineage as 120B.

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
  nvidia: [
    // Verify still in NIM catalog — Mixtral variants deprecated elsewhere
    'meta/llama-3.3-70b-instruct', // Tightly paced, structurally robust. Llama-3.3 has a large context window and excels naturally at dialogue, character development, and narrative pacing. It generates much more "human-like" text that flows organically without feeling forced.
    // TODO: Error: HTTP 404: 404 page not found
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

  // --- New additions (2026-08-04) ---
  // Deliberately appended below the hierarchy above rather than sorted
  // into it. The ordering above (mistral > gemini > openrouter > cerebras
  // > groq > nvidia > cloudflare > cohere) reflects actual observed prose
  // quality on your story content — these providers don't have that track
  // record yet, so they start at the bottom of the waterfall on capacity/
  // reliability grounds instead. Once you've seen real output quality from
  // each, move the good ones up.
  ovhcloud: [
    'Qwen3.6-27B', // 262K+ token context, strong multilingual/structured output. Verify exact catalog slug — OVHcloud's naming can differ slightly from the upstream Hugging Face ID.
    'gpt-oss-120b', // Same model family already used via cerebras/groq above; a third, independent rate-limit pool for it is genuinely useful capacity, not just redundant coverage.
  ],
  sambanova: [
    'DeepSeek-V3.2', // Confirmed available on SambaNova's free tier per their own docs; verify current model-list slug before wiring in.
    'MiniMax-M2.7', // Also confirmed free-tier available; MiniMax models are generally strong at long-form narrative pacing.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // ModelScope's Qwen access tends to get new releases first — worth checking their catalog periodically for newer variants than what's listed here.
  ],
  zai: [
    'glm-4.7-flash', // Same GLM family already praised in AI_CHAT_MODELS_TRANSLATION below (via cerebras/openrouter) for warm, theatrical prose — this gives you a first-party, independently-rate-limited path to it instead of relying on those routes.
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // One of the permanently-$0 models on SiliconFlow; smaller model, treat as light-duty fallback capacity, not a primary rung.
  ],

  // The two entries below are intentionally last. Ollama's free tier has
  // no SLA and a documented reliability incident; Chutes' free capacity
  // is served by anonymous decentralized operators. Both are "better than
  // nothing when everything else is exhausted," not providers to route
  // real volume through by default.
  ollama: [
    'gpt-oss:20b', // Stay on "level 1-2" free-tier-safe models — do not pin the larger cloud-only variants (e.g. 480B-class coder models) here, they're outside the free tier.
  ],
  chutes: [
    'zai-org/GLM-5.1-TEE', // Prefer TEE (confidential-compute)-flagged models specifically for real story content — this one keeps your prompts out of the non-TEE decentralized logging path described in the AI_RATE_LIMITS comment above.
  ],

  // Absolute last resort. LLM7.io is an unaffiliated mirror with no SLA —
  // this entry exists so the waterfall has one more rung before failing
  // outright, not because it's a provider you'd want serving real volume.
  llm7: [
    'gpt-4o-mini', // The one genuinely notable thing LLM7.io offers: a named closed model, free. Treat its availability as fragile — it can disappear without notice since LLM7.io isn't OpenAI's partner.
  ],
};

/**
 * Lightning-fast model (like Llama 3 on Groq) for theme & custom action validation
 */
export const AI_CHAT_MODELS_FAST: AIModelSelection = {
  groq: [
    // TODO: deprecated on Aug 16, 2026
    'llama-3.3-70b-versatile', // Cinematic, fast-paced action, sharp dialogue, proven thriller prose.
    'llama-3.1-8b-instant', // Fast/punchy action beats, distinct voice for erratic/poetic internal monologue; 14.4K RPD makes it a high-volume last resort.
  ],
  cerebras: [
    // TODO: is it really available now?
    'llama3.1-8b', // Fast, punchy — closest in spirit to the old llama-3.3-70b pick.
  ],

  // SambaNova's whole differentiator is inference speed (custom RDU
  // hardware, not GPUs) — a direct fit for this category. Free-tier RPM
  // is conservative (see AI_RATE_LIMITS above) so this won't carry heavy
  // volume, but for latency-sensitive validation calls it's worth having.
  sambanova: [
    'Meta-Llama-3.3-70B-Instruct', // Verify exact slug casing in SambaNova's model list — their naming convention differs from most other providers here.
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
    'openai/gpt-oss-20b', // Structurally reliable fallback, same OpenAI lineage as 120B
    'qwen/qwen3.6-27b',
  ],
  cloudflare: [
    '@cf/mistral/mistral-7b-instruct-v0.1',
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/qwen/qwen1.5-7b-chat-awq',
  ],
  nvidia: ['meta/llama-3.3-70b-instruct'], // Creative writing, roleplay, brainstorming, and generating natural-sounding, lengthy prose.
  cohere: ['command-r-08-2024'],

  // --- New additions (2026-08-04) ---
  // This category is exactly where the smallest-quota new providers
  // belong: short, structured, low-token brainstorm calls, not full page
  // generation.
  aionlabs: [
    'aion-2.5', // Fine-tuned for narrative tension/dark themes specifically — the whole point of pulling it in here despite the tiny ~20K token/day budget. Capped hard by AI_MAX_PROMPT_LENGTH.aionlabs above; keep calls short so this quota stretches across a full day of theme generation rather than one request.
  ],
  llm7: [
    'gpt-4o-mini', // Low-stakes brainstorm text is a reasonable place to spend an unaffiliated-mirror provider's capacity — worth less if it disappears than it would be as a primary writing rung.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B',
  ],
  siliconflow: [
    'Qwen/Qwen3-8B',
  ],
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
  // If you are translating highly complex fiction (like Sci-Fi or High Fantasy) with specific custom world languages, Qwen3.6-27B is your best bet because its massive memory ensures no lore rules are broken. If you are translating an emotional, character-driven drama, GLM-4.7 will give you slightly more moving, poetic prose out of the box.
  cerebras: [
    // Best for Prose Aesthetic. GLM-4.7's post-training leans heavily into creative fluid styles. It writes translated dialogue that feels warm, theatrical, and naturally human.
    'zai-glm-4.7', // GLM series is trained from the ground up on vast, highly diverse multilingual datasets (especially English, Chinese, and other major Asian and European languages). It understands the subtle cultural idioms, emotional tones, and structural nuances of non-English languages.
  ],
  groq: [
    // Best for Continuity and Accuracy. Qwen3.6 is highly literal and accurate. It perfectly captures intricate plot instructions, tracks world-building glossaries, and manages a massive 262K book context effortlessly. Its prose is incredibly polished and clean, though slightly more clinical than GLM-4.7.
    'qwen/qwen3.6-27b', // Features an elite multilingual vocabulary tokenizer. It processes complex character-based or non-Latin alphabets natively. It preserves its massive 262K native context window even when dealing entirely with translated lore. Incredible, highly precise translator, though it functions more like a masterful "localization machine" rather than a purely poetic writer.
  ],
  openrouter: [
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following
    'qwen/qwen3-30b-a3b', // Creative and imaginative with good character voice variety
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue
    'meta-llama/llama-4-maverick', // Large context, broad fallback
    'nvidia/nemotron-3-super-120b-a12b:free', // MoE architecture handles multilingual subtext very well.
    'deepseek/deepseek-r1', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  cloudflare: [
    '@cf/qwen/qwen1.5-14b-chat-awq', // Qwen is notoriously strong at multilingual tasks.
    '@cf/mistral/mistral-7b-instruct-v0.1',
    '@cf/meta/llama-3.1-8b-instruct'
  ],
  // Possesses enough language complexity to grasp context, maintain story continuity, and accurately translate dialogue.
  // Optimized for 10 core languages: English, French, Spanish, Italian, German, Portuguese, Japanese, Korean, Chinese, Arabic.
  cohere: [
    'command-r-08-2024' // Natively optimized for 10 core global languages.
  ],

  // --- New additions (2026-08-04) ---
  // The GLM and Qwen praise already written above (via cerebras/groq/
  // openrouter routes) now has a first-party path too — same model
  // families, but on an independent rate-limit pool instead of riding on
  // cerebras/groq/openrouter's shared capacity.
  zai: [
    'glm-4.7-flash', // Same GLM family praised above under cerebras for "warm, theatrical, naturally human" translated dialogue.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // Same reasoning as the qwen3.6-27b praise above under groq — Alibaba's own platform tends to get new Qwen releases first.
  ],
  ovhcloud: [
    'Qwen3.6-27B', // Direct path to the same 262K-context Qwen variant already used via groq above.
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // Smaller/lighter than the other Qwen entries here — treat as fallback capacity, not primary.
  ],
};

/**
 * Scoring, evaluating, and error-correcting previously generated JSON state/pages.
 * Requires large context windows, strict schema adherence, and analytical logic mapping.
 */
export const AI_CHAT_MODELS_EVALUATION: AIModelSelection = {
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  mistral: [
    'mistral-large-latest',
  ],
  cerebras: [
    'zai-glm-4.7', // Occasionally beats GPT-OSS-120B on deeply nested structures due to its raw reasoning capabilities.
    'gpt-oss-120b', // Production model; strong general quality. It is great at plotting, but dialogue and prose can feel slightly robotic.
  ],
  groq: [
    'openai/gpt-oss-120b', // Superior choice for complex JSON schema adherence and step-by-step reasoning.
    'openai/gpt-oss-safeguard-20b', // Fine-tuned from GPT-OSS, this model helps classify text content based on customizable policies
    'openai/gpt-oss-20b', // Structurally reliable fallback, same OpenAI lineage as 120B
    'qwen/qwen3.6-27b', // Highly reliable bracket matching and field consistency.
  ],
  openrouter: [
    'qwen/qwen3-30b-a3b', // Has known tokenization bias during constrained JSON decoding. Creative and imaginative with good character voice variety.
    'google/gemini-2.5-flash', // Extremely strong prose quality, pacing, emotion, and instruction-following.
    'z-ai/glm-4.5-air', // Clean, coherent, reliable storyteller with natural dialogue.
    'meta-llama/llama-4-maverick', // Large context, broad fallback.
    'nvidia/nemotron-3-super-120b-a12b:free', // 1M context easily handles parsing massive full-story payloads.
    'deepseek/deepseek-r1', // Strong analytical/reasoning prose. Phenomenal at mapping out the underlying logic of a scene before outputting final text. Incredible at analyzing strict JSON constraints and finding errors.
    'meta-llama/llama-3.3-70b-instruct:free', // High-octane cinematic action and dialogue.
  ],
  cohere: [
    'command-r-08-2024'
  ],

  // --- New additions (2026-08-04) ---
  // High-RPM-ceiling, well-documented providers are the better fit here —
  // evaluation runs against every generated page, so this rung needs
  // throughput more than it needs the tiny-quota providers (aionlabs,
  // llm7) added to AI_CHAT_MODELS_IDEA above.
  ovhcloud: [
    'gpt-oss-120b', // Same reasoning as the groq/cerebras gpt-oss-120b picks above — a third independent rate-limit pool for a model already proven here for schema adherence.
  ],
  sambanova: [
    'DeepSeek-V3.2', // DeepSeek's reasoning-heavy training tends to translate well to structured-output scoring, consistent with the deepseek-r1 pick under openrouter above.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // Same qwen3.6-27b bracket-matching reliability noted under groq above.
  ],
};