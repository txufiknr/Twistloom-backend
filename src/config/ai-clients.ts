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
 * | Chutes      | 10   | 200    | UPDATED 2026-09-22: confirmed live (llm.chutes.ai/v1/models as of Sept 2026) that Chutes now requires an active subscription or funded PAYG balance for every model — no genuinely free tier remains, and all 13 catalog models report confidential_compute=true (so "prefer TEE-flagged" no longer means anything — every current option qualifies). RPM/RPD below are pre-paywall estimates and may not reflect subscription-tier limits; unverified. |
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
 * @see https://llm.chutes.ai/v1/models — live catalog; confirms pricing and confidential_compute flag per model
 * @see https://docs.llm7.io/limits
 */
export const AI_RATE_LIMITS: Record<AIChatProvider, AIProviderRateLimit> = {
  /**
   * Updated Google AI Studio Text Chat Model (Post-December 2025 Cuts)
   * Ranked from Best Story Writing Capabilities to Lowest
   * 
   * | Model ID | Release Date | Context Window Size | Requests Per Minute (RPM) | Requests Per Day (RPD) | Story Writing Benchmark Profile |
   * |---|---|---|---|---|---|
   * | gemini-3.1-pro | Feb 19, 2026 | 2,097,152 tokens | 5 RPM | 100 RPD | Master Novelist: Unparalleled structural memory; catches deep emotional subtext, handles nonlinear plotting, and mimics specific author voices beautifully. |
   * | gemini-2.5-pro | Late 2025 | 2,097,152 tokens | 5 RPM | 100 RPD (Down to 25 RPD on some accounts) | Excellent Wordsmith: Exceptionally deep context tracking; highly descriptive prose but marginally less experimental with its metaphors than 3.1. |
   * | gemma-3-27b-it | Mar 12, 2025 | 131,072 tokens | ~30 RPM | ~1,500 RPD | Unfiltered Creative: Because open-weights lack commercial pipeline restrictions, it writes gritty, incredibly stylistic, and raw short-form narratives. |
   * | gemini-3.7-flash | Aug 13, 2026 | 1,048,576 tokens | UNDOCUMENTED — see caution below | Google's newest-but-one Flash pick as of this table; benchmarked as a large step up over 3.6 on agentic/long-horizon tasks. gemini-3.8-flash (Sept 2, 2026) is newer still and NOT wired in anywhere in this file. |
   * | gemini-3.6-flash | Jul 21, 2026 | 1,048,576 tokens | UNDOCUMENTED — see caution below | Currently the primary AI_CHAT_MODELS_WRITING.gemini pick. Google's iteration cadence on this line is now roughly monthly — expect this table to be stale again soon. |
   * | gemini-3.5-flash | May 19, 2026 | 1,048,576 tokens | 10 RPM | 250 RPD | Fast-Paced Action: Strong vocabulary upgrades over 2.5. Best Flash variant for punchy, rapid dialogue generation and high-stakes thriller drafting. |
   * | gemini-3-flash-preview | Dec 17, 2025 | 1,048,576 tokens | 10 RPM | 250 RPD (some sources say 1,500 RPD) | Brainstorming Partner: Highly adaptive for rapid outline prototyping or multi-branch plot development, though raw prose can lean generic. |
   * | gemma-3-4b-it | Mar 12, 2025 | 131,072 tokens | ~30 RPM | ~1,500 RPD | Indie Micro-Fiction: Compact, expressive, and snappy. Highly effective for short fairy tales or quick scene adjustments, though limited by lower absolute logic. |
   * | gemini-2.5-flash | Mid 2025 | 1,048,576 tokens | 10 RPM | 250 RPD | Basic Co-Writer: Best used as an editor to check grammar or rewrite your blocks of text; struggles to generate thousands of original narrative words without looping. CAUTION: officially past its published June 17, 2026 shutdown date — see the rate-limit comment below. |
   * | gemini-3.1-flash-lite | May 7, 2026 | 1,048,576 tokens | 15 RPM | 1,000 RPD | World-Building Index: Great for processing high-volume text fast, but write profile is heavily clinical. Best for generation of NPC barks or item lore descriptions. |
   * | gemini-2.5-flash-lite | Mid 2025 | 1,000,000 tokens | 15 RPM | 1,000 RPD | The Glossary: Lowest creative voice depth; prose is predictable and basic. Perfect strictly for quick character names or background detail tables. CAUTION: officially past its published July 22, 2026 shutdown date — see the rate-limit comment below. |
   * 
   * Verify in AI Studio:
   * @see https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas
   * @see https://aistudio.google.com/rate-limit
   */
  // MAJOR CAUTION added 2026-09-22: every RPM/RPD figure in the table above for the
  // 3.6/3.7 Flash rows (and arguably the older rows too) should be treated as
  // unverifiable, not just possibly-stale. As of this table's last confirmed accuracy
  // (2026-08-04), Google published free-tier RPM/RPD numbers on a docs page; sometime
  // since, that page (ai.google.dev/gemini-api/docs/rate-limits) was rewritten to cover
  // only spend-based paid-tier limits — it no longer contains the phrase "free tier" at
  // all. Free-tier quotas are now undocumented and reportedly vary by project/account
  // history, discoverable only by deliberately triggering a 429 and reading the quota
  // value back. Multiple independent sources this month converge on a MUCH lower number
  // than the 250 RPD below — around 20 RPD for current Flash-generation models (3.6/3.7/
  // 3.8/3.5), with Flash-Lite models faring better (~500 RPD). That's roughly a 12x cut
  // from what this config assumes. I can't confirm the exact number for THIS account —
  // it may genuinely differ — but shipping on the old 250 assumption risks a wall of
  // unexpected 429s the moment real traffic exceeds ~20/day on the primary Flash model.
  // Tightened the rpd below to the more conservative, if still unverified, figure; if
  // real usage shows a different actual ceiling, adjust from measurement, not guesswork,
  // and treat the whole table above the same way going forward. Also worth doing: query
  // https://aistudio.google.com/rate-limit directly for this project rather than trusting
  // any hardcoded number here, including this one.
  gemini:     { rpm: 10,  rpd: 20, grain: 'per-model', scope: 'project' }, // before: { rpm: 10, rpd: 250 }; before that: { rpm: 15, rpd: 1_500 }.

  // Trial key: 1,000 calls/month hard cap. No per-day sublimit documented.
  // rpmo (not rpd) gates this correctly — canUseAI() sums across the calendar month.
  cohere:     { rpm: 100, rpmo: 1_000, scope: 'api-key', window: 'utc-month' }, // before: { rpm: 100, rpd: 10_000 },

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
  // CONFIRMED 2026-09-22 via console.groq.com/docs/rate-limits (official): Groq's
  // limits are genuinely per-model (each model has its own RPM/TPM/RPD bucket, and
  // they vary a lot — e.g. qwen/qwen3.8-27b is capped around 1K RPM while other
  // models differ) AND scoped at the organization level, not per API key ("Rate
  // limits apply at the organization level, not individual users" — verbatim from
  // Groq's docs). So the single flat number below is, structurally, averaging over
  // several genuinely different per-model ceilings — it's a deliberate
  // simplification, not a fact about how Groq actually enforces this. (The old
  // qwen3-32b/60-RPM example this comment used to cite is gone — that model was
  // deprecated 07/17/26, see AI_CHAT_MODELS_WRITING.groq.)
  // See: https://console.groq.com/settings/limits
  groq:       { rpm: 60,  rpd: 1_000, grain: 'per-model', scope: 'organization', tpm: 6_000 }, // before: { rpm: 30, rpd: 14_400 },

  // 1M tokens/day free; 8,192-token context cap on free tier.
  // At max prompt length (~8K tokens), token budget allows ~125 requests/day —
  // request-count rpd not meaningful here.
  // See: https://cloud.cerebras.ai/platform/org_2ypxv2rc6j554f4f22pntket/models
  // CAUTION added 2026-09-22: Cerebras's own model-catalog page currently carries a
  // live notice that free-tier rate limits on zai-glm-4.7 and gpt-oss-120b — both
  // wired into this waterfall (WRITING/TRANSLATION/EVALUATION) — have been
  // "temporarily reduced" due to high demand, with no restoration date given.
  //
  // INTERIM FIX (roadmap Step 1): rpd 2_400 was a ~16x over-open gate vs the
  // comment's own "~125–150 requests/day at 1M tokens/day" math. Tightened to a
  // proxy rpd: 150 so the daily gate actually binds while tpd is not yet active.
  // tpd: 1_000_000 seeds the real token budget; it only takes effect once
  // StreamUsage carries completionTokens (Step 10), at which point rpd: 150
  // should be retired in the same change set to avoid an ungated gap.
  cerebras:   { rpm: 5, rpd: 150, tpd: 1_000_000 },

  // 40 RPM confirmed. RPD unclear: either renewable-rate or finite credit pool
  // depending on account type (see build.nvidia.com usage panel).
  // Omitting rpd until credit model is confirmed for your account.
  //
  // CONFIRMED 2026-09-22: unlike Gemini and Groq (both genuinely per-model — see
  // their comments above), NVIDIA NIM's free tier reads as ONE aggregate 40 RPM
  // bucket shared across every model called with that key — multiple independent
  // developer reports cite the identical "40 RPM" ceiling regardless of which
  // specific model (DeepSeek V4, Nemotron Ultra 550B, Nemotron Super 120B, etc.)
  // they were calling. That means having two models in AI_CHAT_MODELS_WRITING.nvidia
  // doesn't add throughput the way it might on a per-model provider — it adds a
  // fallback for quality/availability, but both draw from the same 40-per-minute
  // pool. The flat per-provider shape below happens to model NVIDIA correctly for
  // this reason — it would be wrong for Gemini or Groq.
  nvidia:     { rpm: 40, grain: 'aggregate' }, // before: { rpm: 40, rpd: 57_600 },

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
  // grain: 'per-model' — OVHcloud's own docs state limits are per-project per-model.
  ovhcloud:   { rpm: 400, grain: 'per-model', scope: 'project' },

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
  ollama:     { rpm: 10,  rpd: 50, window: 'provider-cycle' },

  // 2,000 RPD total across all models, capped at 500 RPD per individual
  // model — using the safer per-model number as the ceiling here, same
  // reasoning as the Groq entry above (a provider-wide daily gate set to
  // the aggregate figure would stay open long after any single model's
  // real quota is exhausted). RPM isn't published; 30 is an estimate.
  // Registration may require an Alibaba Cloud account and possibly a
  // Chinese phone number — confirm before depending on this in prod.
  modelscope: { rpm: 30,  rpd: 500, grain: 'per-model' },

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
  aionlabs:   { rpm: 15, tpd: 20_000 },

  // No official ceiling published anywhere found ("no hard cap" per one
  // tracker, which isn't the same as an SLA) — 10 RPM / 200 RPD is an
  // invented, cautious placeholder pending real traffic data. Chutes runs
  // on a decentralized Bittensor compute market: your actual request is
  // served by whichever anonymous third-party "miner" node wins that
  // request's auction. Prefer models flagged `confidential_compute: true`
  // (TEE-protected) if you route real story content through this provider —
  // non-TEE requests aren't logged by Chutes itself, but do transit an
  // unvetted operator.
  //
  // UPDATED 2026-09-22: "free/cheap availability is subsidized by Bittensor
  // token economics" (the previous framing here) no longer holds — confirmed
  // live against llm.chutes.ai/v1/models that every one of Chutes' 13
  // current catalog models carries real, non-zero USD pricing, and Chutes'
  // own docs now state an active subscription or funded PAYG balance is
  // required to call ANY model. There is no genuinely free path on this
  // provider anymore. Also: all 13 current models report
  // confidential_compute=true, so the TEE-preference note above is now
  // automatically satisfied by anything in the catalog, not a reason to
  // reach for the most expensive flagship (see AI_CHAT_MODELS_WRITING.chutes
  // for what that mistake actually cost). The 10/200 ceiling below is
  // unverified against subscription-tier limits — re-check once an account
  // tier is chosen.
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
  llm7:       { rpm: 60, tpd: 1_000_000 },

  // Inception Labs Mercury (diffusion LLM). No hard published ceiling found
  // for the platform API — 60 RPM is a conservative placeholder pending the
  // Step-6 trial, same stance as the other "estimate" entries in this file.
  // Pricing is also unconfirmed while Inception runs its API-credits burn
  // campaign — see AI_MODEL_COST_OVERRIDES for the $0 placeholder.
  inception:  { rpm: 60 },
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
 * | NVIDIA NIM    | llama-3.3-nemotron-super-49b-v1.5 | 128K | ~120K tokens | ~480,000        |
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
 * | Chutes      | unsloth/Mistral-Nemo-Instruct-2407-TEE | 131K tokens | ~300,000 |
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
 * @see https://docs.api.nvidia.com/nim/reference/nvidia-llama-3_3-nemotron-super-49b-v1_5 — current NVIDIA NIM model (meta/llama-3.3-70b-instruct, the old link target, was retired from the hosted endpoint 2026-08-26; its docs page is stale but still online)
 * @see https://github.com/marketplace/models
 * @see https://docs.mistral.ai/getting-started/models/
 * @see https://developers.openai.com/api/docs/models
 * @see https://openrouter.ai/models
 * @see https://developers.cloudflare.com/workers-ai/models
 * @see https://docs.llm7.io/guides/models
 * @see https://api.llm7.io/v1/models
 */
export const AI_MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini:     3_600_000, // 1M tokens   - The Deep Memory Vault. Safe to load full story.
  mistral:    1_000_000, // 256K tokens - Handles massive context perfectly.
  cohere:     500_000,   // 128K tokens - Good for external lore fetching.
  nvidia:     480_000,   // 128K tokens - Native context (nvidia/llama-3.3-nemotron-super-49b-v1.5 and qwen/qwen3-next-80b-a3b-instruct both meet or exceed this; unchanged from the retired meta/llama-3.3-70b-instruct figure).
  cerebras:   32_000,    // 8K tokens   - FREE TIER CAP. Do not exceed ~32,000 chars.
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

  // Inception Labs Mercury (diffusion LLM) — placeholder pending the Step-6
  // trial; matches the conservative 120K figure used for the restricted
  // free-tier models above. Revision tracked in the diffusion roadmap.
  inception:  120_000,
};

/**
 * Provider-specific maximum allowed output tokens.
 *
 * This map constrains the generated completion length for models whose
 * practical or documented output token limit is smaller than the global
 * AI chat config default. The value is intended for the request payload's
 * `max_tokens` / `maxTokens` field only, and does not affect prompt size.
 *
 * Keys are normalized by provider and exact model ID string. If a model is
 * not present, the global `config.maxOutputToken` value is used unchanged.
 *
 * Deliberately NOT exhaustive — see the accompanying review notes for what
 * was checked and omitted, and why. Every value below is a *ceiling the API
 * enforces* (exceeding it errors or truncates), not a quality/style choice.
 *
 * Example:
 * ```ts
 * AI_MAX_OUTPUT_TOKEN.cohere['command-r-08-2024'] === 4000;
 * ```
 *
 * Use `getMaxOutputToken(provider, model, config.maxOutputToken)` before
 * assigning the output token limit in provider requests.
 */
export const AI_MAX_OUTPUT_TOKEN: Partial<Record<AIChatProvider, Record<string, number>>> = {
  cohere: {
    // 4,000 is Cohere's own documented figure (confirmed via Cohere/
    // Oracle's model docs and independently by OpenRouter) — 4096 was a
    // plausible-looking guess, not the real number. Applies identically to
    // both the R and R+ 08-2024 tiers.
    'command-r-08-2024': 4000,
    'command-r-plus-08-2024': 4000,
  },
  groq: {
    // Confirmed via Groq's own model listing and independent trackers. This
    // is a hard per-request ceiling distinct from — and unrelated to — the
    // RPM/TPM/TPD rate limits tracked elsewhere; exceeding it errors the
    // request outright rather than truncating.
    // FIXED 2026-09-22: llama-3.3-70b-versatile deprecated on Groq 08/16/26 (see
    // AI_CHAT_MODELS_FAST.groq) — replaced this entry with the models actually wired
    // in now. gpt-oss-120b/20b figures confirmed via Groq's own model listing;
    // qwen3.8-27b's 16,384 max-output figure confirmed via Groq-specific trackers
    // (not yet cross-checked against Groq's own docs page directly).
    'openai/gpt-oss-120b': 65536,
    'openai/gpt-oss-20b': 65536,
    'qwen/qwen3.8-27b': 16384,
  },
};

/**
 * Default stream models for AI providers.
 *
 * These model IDs are used by streaming generators when no explicit
 * `options.models` array is provided for a provider.
 */
export const AI_STREAM_DEFAULT_MODEL: Record<AIChatProvider, string> = {
  // CONFIRMED 2026-09-22, not changed: per the user's own real-world reliability
  // ranking observed through this waterfall in production — gemini-2.5-flash (#1,
  // still most reliable), gemini-3-flash-preview, gemini-3.5-flash, gemini-3.6-flash
  // (least reliable of that set) — 2.5-flash remains the right stream default despite
  // its shaky documented lifecycle (see the AI_RATE_LIMITS.gemini caution above: it's
  // officially past its published June 17, 2026 shutdown date, though Google says
  // still-served for accounts with prior usage history). Real production behavior
  // outranks a deprecation-docs concern here. gemini-3.7-flash/3.8-flash aren't
  // factored in — no reliability track record yet, so promoting either over a
  // confirmed #1 performer would be a guess, not a fix. Revisit once they've actually
  // been run through the waterfall for a while.
  gemini: 'gemini-2.5-flash',
  cohere: 'command-r-08-2024',
  mistral: 'mistral-large-latest',
  // FIXED 2026-09-22: llama-3.3-70b-versatile was deprecated on Groq 08/16/26 (see
  // AI_CHAT_MODELS_FAST.groq for the full story — this exact stream default was
  // silently broken for over a month). Replaced with Groq's own official recommended
  // replacement.
  groq: 'openai/gpt-oss-120b',
  cerebras: 'gpt-oss-120b',
  // UPDATED 2026-09-22: meta/llama-3.3-70b-instruct retired from NIM
  // 2026-08-26 (see AI_CHAT_MODELS_WRITING.nvidia below for the full story).
  // CAUTION: this replacement is a reasoning model that emits a visible
  // thinking trace by default. If the nvidia streaming generator doesn't
  // already send `detailed thinking off` in the system prompt, add it before
  // relying on this as a stream default — otherwise chain-of-thought text
  // will stream ahead of the actual answer.
  nvidia: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  openrouter: 'deepseek/deepseek-r1',
  // FIXED 2026-09-22: confirmed against Cloudflare's own official changelog
  // (developers.cloudflare.com/changelog, "Planned model deprecations on
  // Workers AI", posted 2026-05-08) — @cf/meta/llama-3.1-8b-instruct was
  // deprecated 2026-05-30, over three months before this fix. See
  // AI_CHAT_MODELS_WRITING.cloudflare for the full story — this exact model
  // was silently dead in four places across this file at once. Replaced
  // with Cloudflare's own official recommended replacement.
  cloudflare: '@cf/google/gemma-4-26b-a4b-it',
  jina: 'jina-embeddings-v5-text-small',
  ovhcloud: 'gpt-oss-120b',
  sambanova: 'DeepSeek-V3.2',
  ollama: 'gpt-oss:20b',
  modelscope: 'Qwen/Qwen3.5-27B',
  zai: 'glm-4.7-flash',
  siliconflow: 'Qwen/Qwen3-8B',
  aionlabs: 'aion-2.5',
  // UPDATED 2026-09-22: zai-org/GLM-5.1-TEE was Chutes' priciest flagship
  // ($0.98/$3.08 per 1M — confirmed live), not a budget pick — a mismatch
  // with why chutes sits at the bottom of every waterfall here. Swapped to
  // the cheapest model in Chutes' current catalog. See
  // AI_CHAT_MODELS_WRITING.chutes for the full story, including why this
  // alone may not fix a 402.
  chutes: 'unsloth/Mistral-Nemo-Instruct-2407-TEE',
  llm7: 'default',
  // FIXED 2026-09-22: `mercury-coder-small` (without a `-beta` suffix) isn't
  // confirmed as a currently-valid Inception model ID — the working examples
  // found for that exact coder variant all use `mercury-coder-small-beta`,
  // and Inception's own current SDKs/docs (agno, others) default to
  // `mercury-2` as the current model, not the year-and-a-half-old Mercury
  // Coder line. Swapped to `mercury-2`, Inception's own documented default.
  // See AI_CHAT_MODELS_WRITING.inception for the cost-framing correction too.
  inception: 'mercury-2',
}

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
    // ADDED 2026-09-22: gemini-3.7-flash (launched Aug 13, 2026) — confirmed still
    // free-tier eligible via AI Studio/the Gemini API as of this month (multiple
    // independent trackers, one as recent as 4 days old), same as 3.6 below. Placed
    // ahead of 3.6 as the newer model.
    'gemini-3.7-flash', // Substantial jump over 3.6 on agentic/long-horizon benchmarks per Google's own release notes; fiction-prose quality specifically not yet evaluated against 3.6 below.
    // ADDED 2026-09-22: gemini-3.8-flash (launched Sept 2, 2026) — newest in the
    // family as of this pass, also free-tier eligible, same $0.75/$3.75 introductory
    // rate as 3.6/3.7. Reportedly Google's new default model in the consumer Gemini
    // app. Placed first since "newest" has been the ordering principle for this array
    // so far; no fiction-specific quality signal on it yet either.
    'gemini-3.8-flash', // Newest Flash release in this family; agentic/coding gains reported over 3.7, prose quality vs. 3.6/3.7 for this use case not yet evaluated.
    'gemini-3.6-flash', // The latest, highly efficient flagship Flash model.
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
    // FIXED 2026-09-22 — confirmed directly against console.groq.com/docs/deprecations
    // (Groq's own official page): THREE of this array's five entries were already
    // dead. meta-llama/llama-4-scout-17b-16e-instruct and qwen/qwen3-32b were both
    // deprecated 07/17/26 (Groq's recommended replacement for both: openai/gpt-oss-120b,
    // already below). qwen/qwen3.6-27b was deprecated more recently still — 09/14/26,
    // nine days before this fix — in favor of qwen/qwen3.8-27b, its official
    // recommended replacement, added below. That's 3 of 5 WRITING.groq entries
    // silently dead at once; every WRITING call that reached groq first tried three
    // guaranteed failures before reaching a working model. Removed all three; added
    // qwen3.8-27b since it's confirmed live with its own cost override (ai-cost.ts).
    'qwen/qwen3.8-27b', // Confirmed live 2026-09-22, Groq's official successor to qwen3.6-27b: same 131K context, thinking/instruct modes, tool use, JSON mode. No fiction-writing track record yet on Groq specifically.
    'openai/gpt-oss-120b', // 128K tokens. Excellent JSON. Toggleable Reasoning. Sometimes feel "dry," structural, or overly analytical when tasked with creative storytelling. Deepest psychological complexity, best for sustained horror dread.
    'openai/gpt-oss-20b', // Structurally reliable fallback, same OpenAI lineage as 120B.

    // All models
    // openai/gpt-oss-20b ✅ // Strict Mode (strict: true)
    // openai/gpt-oss-120b ✅ // Strict Mode (strict: true)
    // openai/gpt-oss-safeguard-20b ✅ // Best-effort Mode (strict: false)
    // qwen/qwen3.8-27b ✅
    // llama-3.3-70b-versatile ✅
    // llama-3.1-8b-instant ✅
  ],
  nvidia: [
    // UPDATED 2026-09-22: meta/llama-3.3-70b-instruct was retired from NIM's
    // hosted endpoint on 2026-08-26 (HTTP 410 Gone — confirmed against the
    // actual error, not just the docs page, which still lists the model;
    // that page lags real endpoint availability by weeks-to-months). NVIDIA
    // did not publish a designated 1:1 replacement for this specific
    // retirement (unlike some other NIM deprecations that do get an
    // explicit "use X instead" notice).
    //
    // IMPORTANT — this replacement is a reasoning model and emits a visible
    // thinking trace by default. Set `detailed thinking off` (or `/no_think`)
    // in the system prompt for every call here, or the schema-shaped output
    // will arrive wrapped in chain-of-thought text and likely fail
    // parseAISafely.
    'nvidia/llama-3.3-nemotron-super-49b-v1.5', // Closest same-lineage successor — NVIDIA's own NAS-derivative of the exact same base model (Llama-3.3-70B-Instruct), same 128K context, still free/commercial-use on NIM. Tightly paced, structurally robust; dialogue/pacing/character-voice quality should carry over directly from the old pick.
    // qwen/qwen2.5-72b-instruct (the previous 2nd rung, flagged 404 above)
    // isn't in NIM's current catalog at all — confirmed, not just untested.
    // Replaced with the current large-context Qwen3 chat model.
    'qwen/qwen3-next-80b-a3b-instruct', // 262K native context (extensible to ~1M via YaRN rope scaling). Plain instruct variant — no thinking-mode toggle to worry about, unlike the nemotron pick above (the separate qwen3-next-80b-a3b-thinking variant is the one with reasoning traces). MoE (80B total / 3B active params), Apache 2.0. Intricate, heavily detailed — good fit for massive lore.
  ],
  cloudflare: [
    // FIXED 2026-09-22 — confirmed directly against Cloudflare's own official
    // changelog (developers.cloudflare.com/changelog, "Planned model
    // deprecations on Workers AI", 2026-05-08): @cf/mistral/mistral-7b-instruct-v0.1,
    // @cf/meta/llama-3.1-8b-instruct, AND @cf/google/gemma-3-12b-it were ALL
    // deprecated on 2026-05-30 — three of this array's four entries, dead for
    // nearly four months. That's the same failure pattern as the Groq and
    // OVHcloud incidents earlier this session: every WRITING call reaching
    // cloudflare was very likely hitting three guaranteed failures before
    // (maybe) landing on the one surviving entry. Replaced with Cloudflare's
    // own officially-named recommended replacements for this exact
    // deprecation wave, not a guess.
    '@cf/zai-org/glm-4.7-flash', // Cloudflare's official recommended replacement for the retired mistral-7b-instruct-v0.1 slot — fast multilingual model, multi-turn tool calling.
    '@cf/moonshotai/kimi-k2.6', // Cloudflare's official recommended replacement for the retired gemma-3-12b-it slot — capable tool-calling/vision model built for agentic workloads; untested here for fiction-prose quality specifically.
    '@cf/google/gemma-4-26b-a4b-it', // Cloudflare's official recommended replacement for the retired llama-3.1-8b-instruct slot (same slot as the fixed AI_STREAM_DEFAULT_MODEL.cloudflare) — efficient, vision-capable, tool calling.
    // NOT independently confirmed dead or alive this pass — old (Feb 2024
    // vintage) and absent from the specific deprecation notice checked above,
    // but not verified against Cloudflare's live catalog either. Kept, not
    // removed, but flagged as lower-confidence than the three fixes above.
    '@cf/qwen/qwen1.5-14b-chat-awq', // Great for intricate physical environment descriptions.
  ],
  cohere: [
    'command-r-08-2024' // Reads like an academic summary. Use only as a last resort for prose.
  ],

  // --- New additions (2026-08-04) ---
  ovhcloud: [
    'Qwen3.8-27B', // UPDATED 2026-09-22 — OVHcloud confirmed hosting both Qwen3.6-27B and Qwen3.8-27B live at the same $0.47/$3.19 rate (own catalog, checked directly); 3.8 is newer with no cost tradeoff, so no reason to stay on 3.6 here or in any of this file's other ovhcloud entries. 262K+ token context, strong multilingual/structured output.
    'gpt-oss-120b', // Independent rate-limit pool for reliable capacity[cite: 3].
  ],
  sambanova: [
    'DeepSeek-V3.2', // Confirmed available on SambaNova's free tier[cite: 3].
    'MiniMax-M2.7', // Generally strong at long-form narrative pacing[cite: 3].
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // ModelScope's Qwen access tends to get new releases first[cite: 3].
  ],
  zai: [
    'glm-4.7-flash', // First-party path for warm, theatrical prose without relying on OpenRouter[cite: 3].
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // Light-duty fallback capacity; permanently $0[cite: 3].
  ],
  ollama: [
    'gpt-oss:20b', // Kept to level 1-2 models; positioned last due to 5h/7d cycle constraints[cite: 3].
  ],
  chutes: [
    // UPDATED 2026-09-22: the 402 you're seeing isn't (only) about the model
    // string — zai-org/GLM-5.1-TEE is Chutes' priciest flagship model
    // ($0.98 in / $3.08 out per 1M tokens, confirmed live against
    // llm.chutes.ai/v1/models), a 754B-param MoE model. That's a real bug:
    // this waterfall clearly meant chutes as the cheap/last-resort rung
    // (it sits below groq/cerebras/sambanova/ovhcloud/modelscope/zai
    // everywhere it appears), not the tier for reaching for the single most
    // expensive thing in the catalog. The "prefer TEE-flagged models"
    // reasoning in the original comment also no longer picks anything out —
    // confirmed all 13 models in Chutes' current catalog report
    // confidential_compute=true, flagship included, so it never needed to be
    // the expensive one.
    //
    // Swapped to the cheapest model in the live catalog as of today.
    // IMPORTANT — this likely does NOT fully fix the 402 on its own: Chutes'
    // own docs now state a subscription or funded pay-as-you-go balance is
    // required to call ANY model (confirmed — every one of the 13 catalog
    // models carries real, non-zero pricing; there is no free tier left on
    // this platform). If your Chutes account has zero balance and no active
    // subscription, this will 402 regardless of which model string is here.
    // Check chutes.ai/pricing / your account balance directly — that's an
    // account-side fix, not something either of these files can do for you.
    // If you'd rather not fund a Chutes balance right now, the clean
    // architectural move is to drop chutes from the waterfall entirely
    // until you do, rather than carry a rung that will reliably 402.
    'unsloth/Mistral-Nemo-Instruct-2407-TEE', // Cheapest current Chutes model ($0.0245 in / $0.0978 out per 1M) — a much better fit for a bottom-of-waterfall fallback. Trade-off: Mistral Nemo (12B, July 2024) is a noticeably weaker/older model than the GLM-5.1 flagship it replaces — expect plainer prose. If quality matters more than squeezing cost here, `Nemotron-3-Nano-Omni-30B-TEE` is the same price with a newer, larger (30B) reasoning-tuned base — but "reasoning-tuned" may carry the same visible-thinking-trace risk flagged for the NVIDIA NIM pick above; verify before relying on it for schema-shaped output.
  ],
  // PROMOTED 2026-08-15: Inception Labs Mercury (diffusion LLM) moved up from
  // the inert AI_CHAT_MODELS_DIFFUSION experimental rung into the live writing
  // waterfall as a low-cost ($0) bottom rung — roughly an order of magnitude
  // cheaper per token than autoregressive decoders. Positioned just above
  // llm7 (the absolute last resort) so it only ever serves after the
  // higher-quality prose providers have all been exhausted. Continuity risk
  // (diffusion models don't "attend to" prior page text) is mitigated by the
  // 9-stage parse pipeline + evaluator recursion; see
  // docs/roadmap/AI_DIFFUSION_TOKEN_SAVING_EXECUTION_ROADMAP.md Step 6.
  // FIXED 2026-09-22: `mercury-coder-small` swapped to `mercury-2` — see
  // AI_STREAM_DEFAULT_MODEL.inception for why (the coder-small variant's
  // confirmed-working ID has a `-beta` suffix this file never had, and
  // Inception's own current docs default to mercury-2 anyway). Also
  // correcting the framing below: Inception's "free" access isn't an
  // ongoing rate — it's a one-time 10 million token grant per account on
  // signup (confirmed via Inception's own blog), after which mercury-2
  // bills at its real $0.25/$0.75 per-1M-token rate (see ai-cost.ts, no
  // longer a $0 placeholder for the reasons the old comment there gave).
  inception: [
    'mercury-2', // Diffusion decoder; free up to a one-time 10M-token account grant, real per-token pricing after that.
  ],
  llm7: [
    'default', // Unaffiliated mirror with no SLA; absolute last resort[cite: 3].
  ],
};

/**
 * Lightning-fast model (like Llama 3 on Groq) for theme & custom action validation
 * Note: Ollama and Chutes are omitted here. Ollama's GPU timesharing and Chutes' decentralized miners make their latencies too unpredictable for the FAST category[cite: 3]. Aion Labs is omitted because of its strict 20k daily token budget[cite: 3].
 */
export const AI_CHAT_MODELS_FAST: AIModelSelection = {
  groq: [
    // FIXED 2026-09-22 — confirmed against console.groq.com/docs/deprecations: BOTH
    // entries below were dead, not just the first one the old TODO flagged.
    // llama-3.3-70b-versatile and llama-3.1-8b-instant were both deprecated 08/16/26.
    // That means every FAST-tier call that reached groq first was hitting two
    // guaranteed failures before falling through to cerebras — this tier's fastest,
    // lowest-latency provider was 100% non-functional. Replaced with Groq's own
    // official recommended replacements for each.
    'openai/gpt-oss-20b', // Groq's official recommended replacement for llama-3.1-8b-instant. Fast, cheap, structurally reliable; no fiction-speed track record on this specific tier yet.
    'openai/gpt-oss-120b', // Groq's official recommended replacement for llama-3.3-70b-versatile (the other option, qwen/qwen3.8-27b, costs noticeably more per token on Groq — see ai-cost.ts — so kept out of the FAST/cheap tier specifically).
  ],
  cerebras: [
    // RESOLVED 2026-09-22: confirmed still listed on Cerebras's own current Production
    // Models table (inference-docs.cerebras.ai/models/overview). Their docs do also
    // carry a "will be deprecated on May 27, 2026" warning banner for it — that date
    // has already passed with the model still live and still in the production table,
    // so the warning looks like it was never executed on / never cleaned up rather
    // than a sign this is about to disappear. Worth a periodic re-check, not urgent.
    'llama3.1-8b', // Fast, punchy — closest in spirit to the old llama-3.3-70b pick.
  ],
  
  // --- New additions (2026-08-04) ---
  sambanova: [
    'Meta-Llama-3.3-70B-Instruct', // Custom RDU hardware delivers exceptional inference speed[cite: 3].
  ],
  zai: [
    'glm-4.5-air', // The 'air' variant is highly optimized for low-latency calls.
  ],
  ovhcloud: [
    'Qwen3.8-27B', // UPDATED 2026-09-22 — see AI_CHAT_MODELS_IDEA.ovhcloud for why (3.8 replaces 3.6 at the same price). Reliable throughput against the 400 RPM authenticated ceiling.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B',
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // Small $0-tier model[cite: 3], perfect for rapid action checks.
  ],
  llm7: [
    'fast', // Treated as an absolute last-resort proxy fallback[cite: 3].
  ],
};

/**
 * Small but creative model for idea brainstorming
 * High-speed, lightweight models optimized for low-latency tasks.
 */
export const AI_CHAT_MODELS_IDEA: AIModelSelection = {
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite', // Generic, "safe" creative prose. It shines brightest at micro-creative tasks: crafting quick character descriptions, naming fictional places, generating short status messages, or writing brief background dialogue snippets for NPCs.
    'gemini-2.5-flash-lite', // Cost-efficient, fast variant of the 2.5 generation. [2, 3, 4, 5, 6] 
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
    'qwen/qwen3.8-27b', // FIXED 2026-09-22 — qwen/qwen3.6-27b deprecated on Groq 09/14/26; this is Groq's official recommended successor (same context/capabilities).
  ],
  cloudflare: [
    // FIXED 2026-09-22 — see AI_CHAT_MODELS_WRITING.cloudflare for the full
    // story: both entries below were officially deprecated by Cloudflare on
    // 2026-05-30, confirmed against their own changelog.
    '@cf/zai-org/glm-4.7-flash', // Cloudflare's official recommended replacement for mistral-7b-instruct-v0.1.
    '@cf/google/gemma-4-26b-a4b-it', // Cloudflare's official recommended replacement for llama-3.1-8b-instruct.
    '@cf/qwen/qwen1.5-7b-chat-awq', // Not independently confirmed dead or alive this pass — see the same caveat on the Qwen1.5 entry in WRITING.cloudflare.
  ],
  // UPDATED 2026-09-22: meta/llama-3.3-70b-instruct retired from NIM
  // 2026-08-26 — see AI_CHAT_MODELS_WRITING.nvidia above for the full story.
  // Same reasoning-mode caveat applies here: set `detailed thinking off` in
  // the system prompt, or IDEA-tier calls will come back wrapped in a
  // visible thinking trace.
  nvidia: ['nvidia/llama-3.3-nemotron-super-49b-v1.5'], // Creative writing, roleplay, brainstorming, and generating natural-sounding, lengthy prose.
  cohere: ['command-r-08-2024'],

  // --- New additions (2026-08-04) ---
  aionlabs: [
    'aion-2.5', // Fine-tuned for dark themes[cite: 3]. Perfect here to stretch the ~20K token/day budget across small calls[cite: 3].
  ],
  zai: [
    'glm-4.7-flash', // Theatrical and creative, excellent for sparking new concepts.
  ],
  sambanova: [
    'MiniMax-M2.7', // Excellent for rapid brainstorming without burning main provider quotas.
  ],
  ovhcloud: [
    'Qwen3.8-27B', // UPDATED 2026-09-22 — OVHcloud confirmed hosting both 3.6 and 3.8 at the same $0.47/$3.19 rate; 3.8 is newer, no reason to stay on 3.6. 400 RPM authenticated pool provides great capacity for ideas.
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // 500 RPD per-model cap makes this a safe brainstorm fallback[cite: 3].
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // True no-cost default model[cite: 3] for small idea payloads.
  ],
  // UPDATED 2026-09-22: zai-org/GLM-5.1-TEE was Chutes' priciest flagship,
  // not a budget model — see AI_CHAT_MODELS_WRITING.chutes above for the
  // full story, including why fixing the model string may not clear the 402
  // on its own (Chutes now requires a funded account for any model).
  chutes: [
    'unsloth/Mistral-Nemo-Instruct-2407-TEE', // Cheapest current Chutes model; fine for low-stakes idea generation.
  ],
  ollama: [
    'gpt-oss:20b', // Level 1-2 free-tier model[cite: 3], good for offline/timeshared idea generation.
  ],
  llm7: [
    'default', // Unofficial proxy mirror, strictly last-resort[cite: 3].
    'fast'
  ],
};

/**
 * Diffusion LLM story continuation — Inception Labs Mercury (single-shot).
 *
 * This is the v1 target of docs/roadmap/AI_DIFFUSION_TOKEN_SAVING_EXECUTION_ROADMAP:
 * diffusion decoders are roughly an order of magnitude cheaper per token than
 * autoregressive decoders.
 *
 * PROMOTED 2026-08-15: Inception's Mercury model (mercury-2 as of the
 * 2026-09-22 naming fix — see AI_CHAT_MODELS_WRITING.inception) now also
 * lives in AI_CHAT_MODELS_WRITING as the bottom writing rung (see its entry
 * there for current cost framing).
 * This selection is kept as a dedicated pool for two reasons: it is what the
 * Step-6 trial harness (`tests/test-diffusion-adherence.ts`) drives, and it
 * remains the *isolated* way to route single-shot IDEA/THEME-scale diffusion
 * calls without touching the writing waterfall. Continuity caveat still
 * applies — diffusion models have no prior page text to "attend to" the way
 * autoregressive decoders do and are the most likely provider to forget the
 * story state mid-run; the 9-stage parse pipeline + evaluator recursion are
 * the mitigation once live.
 */
export const AI_CHAT_MODELS_DIFFUSION: AIModelSelection = {
  // FIXED 2026-09-22: swapped mercury-coder-small → mercury-2 — see
  // AI_STREAM_DEFAULT_MODEL.inception for the full reasoning. NOTE: if
  // tests/test-diffusion-adherence.ts (the Step-6 trial harness this pool
  // feeds) hardcodes the model string separately rather than importing this
  // constant, that file needs the same edit — not in hand to check here.
  inception: [
    'mercury-2', // Free up to a one-time 10M-token account grant, real per-token pricing after that[cite: 3].
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
    // FIXED 2026-09-22 — qwen/qwen3.6-27b deprecated on Groq 09/14/26; swapped to
    // Groq's official recommended successor, qwen/qwen3.8-27b (same capabilities
    // this comment describes, per Groq's migration notes — not yet independently
    // verified for translation quality specifically).
    'qwen/qwen3.8-27b', // Features an elite multilingual vocabulary tokenizer. It processes complex character-based or non-Latin alphabets natively. It preserves its massive 262K native context window even when dealing entirely with translated lore. Incredible, highly precise translator, though it functions more like a masterful "localization machine" rather than a purely poetic writer.
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
    // NOT independently confirmed dead or alive this pass — see the same
    // caveat on the Qwen1.5 entry in WRITING.cloudflare.
    '@cf/qwen/qwen1.5-14b-chat-awq', // Qwen is notoriously strong at multilingual tasks.
    // FIXED 2026-09-22 — both entries below were officially deprecated by
    // Cloudflare on 2026-05-30; see AI_CHAT_MODELS_WRITING.cloudflare for the
    // full story and source.
    '@cf/zai-org/glm-4.7-flash', // Cloudflare's official recommended replacement for mistral-7b-instruct-v0.1; also strong multilingual per Cloudflare's own model description.
    '@cf/google/gemma-4-26b-a4b-it', // Cloudflare's official recommended replacement for llama-3.1-8b-instruct.
  ],
  // Possesses enough language complexity to grasp context, maintain story continuity, and accurately translate dialogue.
  // Optimized for 10 core languages: English, French, Spanish, Italian, German, Portuguese, Japanese, Korean, Chinese, Arabic.
  cohere: [
    'command-r-08-2024' // Natively optimized for 10 core global languages.
  ],

  // --- New additions (2026-08-04) ---
  zai: [
    'glm-4.7-flash', // Praised for warm, theatrical, naturally human dialogue[cite: 3].
  ],
  sambanova: [
    'DeepSeek-V3.2', // Confirmed free tier[cite: 3]; DeepSeek architecture is remarkably strong at multilingual reasoning.
  ],
  ovhcloud: [
    'Qwen3.8-27B', // UPDATED 2026-09-22 — see AI_CHAT_MODELS_IDEA.ovhcloud for why. Direct path to massive 262K-context Qwen variant.
    'gpt-oss-120b', // Same model family already used via groq for translation[cite: 3].
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // Alibaba's own platform tends to get new Qwen releases first[cite: 3].
  ],
  siliconflow: [
    'Qwen/Qwen3-8B', // Smaller/lighter Qwen variant for fallback capacity[cite: 3].
  ],
  // UPDATED 2026-09-22: see AI_CHAT_MODELS_WRITING.chutes above — was
  // Chutes' priciest flagship, not a budget pick, and Chutes now requires a
  // funded account for any model regardless of which one is named here.
  chutes: [
    'unsloth/Mistral-Nemo-Instruct-2407-TEE', // Cheapest current Chutes model. Weaker than GLM at non-English nuance, but this is a deep fallback rung behind zai/sambanova/ovhcloud above.
  ],
  ollama: [
    'gpt-oss:20b', // Light fallback if GPU-time is available[cite: 3].
  ],
  llm7: [
    'default', // OpenAI's translation alignment is top-tier; use as proxy fallback[cite: 3].
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
    'qwen/qwen3.8-27b', // FIXED 2026-09-22 — qwen/qwen3.6-27b deprecated on Groq 09/14/26; Groq's official recommended successor. Highly reliable bracket matching and field consistency (unverified for 3.8 specifically, carried over from the 3.6 assessment).
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
  ovhcloud: [
    'gpt-oss-120b', // A third independent rate-limit pool for schema adherence[cite: 3].
    'Qwen3.8-27B', // UPDATED 2026-09-22 — see AI_CHAT_MODELS_IDEA.ovhcloud for why. Good throughput and bracket-matching.
  ],
  sambanova: [
    'DeepSeek-V3.2', // DeepSeek's reasoning-heavy training translates well to structured-output scoring[cite: 3].
  ],
  modelscope: [
    'Qwen/Qwen3.5-27B', // Same bracket-matching reliability noted under groq[cite: 3].
  ],
  zai: [
    'glm-4.7-flash', // Powerful reasoning capabilities for finding schema errors.
  ],
  // UPDATED 2026-09-22: see AI_CHAT_MODELS_WRITING.chutes above — was
  // Chutes' priciest flagship, not a budget pick, and Chutes now requires a
  // funded account for any model regardless of which one is named here.
  chutes: [
    'unsloth/Mistral-Nemo-Instruct-2407-TEE', // Cheapest current Chutes model; supports json_mode/tools per the live catalog, but this is a deep fallback rung — reach for it last.
  ],
  llm7: [
    'default', // Very strong at schema parsing, but keep as last resort due to unofficial mirror status[cite: 3].
  ],
};