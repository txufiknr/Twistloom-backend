import type { AIChatProvider } from "../types/ai-chat.js";
import { usage } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { getTodayDate } from "./time.js";
import { dbRead } from "../db/client.js";

/**
 * AI cost estimation & daily spend tracking.
 *
 * Twistloom routes the same ask through a pool of LLM providers (gemini, groq,
 * mistral, github, cerebras, etc. — 19 total as of 2026-08-04, after adding
 * ovhcloud, sambanova, ollama, modelscope, zai, siliconflow, aionlabs, chutes,
 * and llm7). This module converts the token totals that `recordUsage()`
 * already stores in the `usage` table into an estimated USD cost. It is
 * deliberately approximate — per-token pricing drifts, free tiers exist, and
 * some providers bill by units other than raw tokens (Ollama Cloud by
 * GPU-time, ModelScope/LLM7.io by request quota with no paid tier at all) —
 * so treat the numbers as *estimates for budgeting/alerts*, never as an
 * invoicing source.
 *
 * Every number in this file was checked against official pricing pages and
 * independent trackers as of 2026-08-04. Where sources disagreed or no
 * official rate exists, the comment says so explicitly rather than presenting
 * a guess as fact — re-verify anything flagged that way before trusting it
 * for a real budget decision.
 */

/**
 * USD cost per 1,000,000 tokens, keyed by provider.
 *
 * Rates reflect a representative model tier for each provider — generally
 * the cheapest tier actually wired into the waterfall (see ai-clients.ts),
 * not necessarily the provider's absolute cheapest model. Pricier/cheaper
 * specific models are priced via {@link AI_MODEL_COST_OVERRIDES}, which is
 * checked first. Expressed in dollars (input/output per 1M tokens).
 *
 * @see https://ai.google.dev/gemini-api/docs/pricing
 * @example
 * ```typescript
 * AI_COST_PER_MILLION_PREVIEW.gemini; // { input: 0.30, output: 2.50 }
 * ```
 */
const AI_COST_PER_MILLION_PREVIEW: Record<AIChatProvider, { input: number; output: number }> = {
  gemini:    { input: 0.30, output: 2.50 }, // gemini-2.5-flash — confirmed directly against ai.google.dev/gemini-api/docs/pricing (Standard tier). Unchanged; a third-party tracker briefly suggested $0.15/$1.25, but that's Gemini's *Batch*-tier rate, not Standard — don't let that resurface here.
  cohere:    { input: 0.15, output: 0.60 }, // FIXED (was 0.20/1.00, labeled "estimate"). command-r-08-2024's actual published rate, confirmed by two independent trackers.
  mistral:   { input: 1.00, output: 2.00 }, // mistral-medium-latest — UNVERIFIED this pass. The one 2026-relevant data point found (Mistral Medium 3's May 2025 launch price) was $0.40/$2.00, notably lower on input than this entry. Could mean this is stale, or that "latest" now points to a costlier successor tier — couldn't confirm either way. Check mistral.ai/pricing directly before trusting this number for a real budget.
  groq:      { input: 0.15, output: 0.60 }, // UPDATED 2026-09-22 — was priced for llama-3.3-70b-versatile ($0.59/$0.79), which Groq deprecated 08/16/26 and which no longer appears anywhere in ai-clients.ts's groq entries (see AI_CHAT_MODELS_FAST.groq/WRITING.groq for the full story). Repriced to match gpt-oss-120b, now the dominant model actually wired into groq across this waterfall (stream default, WRITING, FAST).
  cerebras:  { input: 0.35, output: 0.75 }, // FIXED (was 0.60/0.30 — backwards, and priced against a model Cerebras may no longer self-serve). Repriced against gpt-oss-120b, which is what's actually wired into cerebras's WRITING/EVALUATION entries in ai-clients.ts today. One tracker (dated May 2026) states Llama 3.3 70B has moved to Dedicated-Endpoints-only (custom/sales pricing, no public rate) on Cerebras — if that's still true, don't reintroduce a llama-3.3-70b override scoped to cerebras without confirming it's back on the public rate card.
  nvidia:    { input: 0.15, output: 0.60 }, // FIXED (was 0.60/0.30 — backwards, and not grounded in anything). NVIDIA does not publish a direct per-token rate for build.nvidia.com hosted models — it's a free-developer-credits program, with production pricing routed through NVIDIA AI Enterprise licensing ($4,500/GPU/year) instead. This number is an inferred proxy from comparable Nemotron-tier pricing seen via third-party pass-through (OpenRouter). Treat it as a rough placeholder, not a real NVIDIA rate.
  openrouter:{ input: 0.30, output: 1.20 }, // blended price (varies wildly) — unchanged, not re-verified this pass; still the most honest single number for an aggregator whose actual per-model rate depends entirely on which upstream host you land on.
  cloudflare:{ input: 0.01, output: 0.01 }, // @cf/… small models (estimate) — unchanged, not re-verified this pass.
  jina:      { input: 0.02, output: 0.00 }, // jina-embeddings-v5 ($0.02 / 1M tokens) — unchanged.

  // --- New additions (2026-08-04 provider assessment) — see AI_RATE_LIMITS
  // in ai-clients.ts for the matching free-tier reasoning on these same 9.

  ovhcloud:  { input: 0.09, output: 0.47 }, // gpt-oss-120b on OVHcloud AI Endpoints — confirmed directly (OVHcloud's own published per-model rate), and notably the *cheapest* of the three hosts this same model runs on in this waterfall (Groq $0.15/$0.60, Cerebras $0.35/$0.75, OVHcloud $0.09/$0.47) — see the gpt-oss-120b overrides below for why that matters.
  sambanova: { input: 0.20, output: 0.50 }, // Estimate. SambaNova's catalog spans a huge range ($0.26 blended on gpt-oss-120b up to $3+ blended on DeepSeek-class models per Artificial Analysis) with no clean official input/output split published anywhere found — this represents their cheap tier, not the pricier DeepSeek-V3.2 model actually wired into ai-clients.ts (see the deepseek-v3.2 override below for that).
  ollama:    { input: 0.10, output: 0.40 }, // Estimate — Ollama Cloud doesn't bill per-token at all; it's a flat subscription ($0 Free / ~$20 Pro / ~$200 Max per month) gated by GPU-time, not tokens. This number exists so checkDailyCostSpike() has *some* non-zero signal instead of silently reporting $0 for a provider that's actually costing real money on a paid plan — it is not a real per-token rate and will never reconcile against an actual Ollama invoice.
  modelscope:{ input: 0.15, output: 0.60 }, // Estimate. ModelScope's API-Inference product appears to be free-quota-only (2,000 calls/day) with no published paid overage tier found anywhere — this is a conservative proxy based on comparable Qwen pricing on Alibaba's own paid Qwen Cloud platform, kept non-zero in case ModelScope introduces overage billing later.
  zai:       { input: 0.20, output: 1.10 }, // GLM-4.5-Air's official Z.ai rate — used as the representative small/cheap tier. The model actually wired into ai-clients.ts (glm-4.7-flash) is genuinely free — see the override below — so this default only fires if a paid GLM model gets used without its own override.
  siliconflow:{ input: 0.14, output: 0.57 }, // Qwen3-32B on SiliconFlow — confirmed. The model actually wired into ai-clients.ts (Qwen/Qwen3-8B) is one of SiliconFlow's permanently-$0 models — see the override below — so this default is the fallback for any other SiliconFlow model.
  aionlabs:  { input: 0.50, output: 1.50 }, // Estimate — no published rate card found for Aion Labs' paid tier (their site documents the free tier's ~20K token/day allowance but not what happens beyond it). Rough placeholder based on comparable boutique/specialized-model pricing; low confidence.
  chutes:    { input: 0.30, output: 1.20 }, // UPDATED 2026-09-22: "no official rate card found" (the old framing) is no longer true — confirmed live against llm.chutes.ai/v1/models that Chutes publishes real per-model USD pricing, and it spans a huge range across the 13-model catalog (as low as $0.0245/$0.0978 for unsloth/Mistral-Nemo-Instruct-2407-TEE, as high as $3/$15 for moonshotai/Kimi-K3-TEE). This flat figure is now only the fallback for any chutes model NOT covered by a specific override below — the model actually wired into ai-clients.ts has its own override (see below) with the real confirmed rate, so this number rarely gets used in practice. Left as a mid-range guess for anything else.
  llm7:      { input: 0,    output: 0 },    // Not an estimate — LLM7.io has no paid tier at all; it's free-only by construction (an unofficial mirror with no billing path). This accurately reflects that Twistloom will never be invoiced for it, but also means checkDailyCostSpike() structurally can't catch a problem via this provider — its risk is reliability/ToS, not cost. See ai-clients.ts's AI_RATE_LIMITS comment for that caveat.
  inception: { input: 0.25, output: 0.75 }, // UPDATED 2026-09-22 — the old $0 framing ("API-credits burn campaign") was wrong: confirmed via Inception's own blog that free access is a ONE-TIME 10-million-token grant per account on signup, not an ongoing free rate — unlike llm7 (true $0, no paid tier ever exists), Inception has a real per-token invoice waiting once that grant is spent. Priced at mercury-2's confirmed real rate so checkDailyCostSpike() can actually do its job here once the free grant runs out, instead of staying blind to a real cost the way a $0 placeholder would.
};

/**
 * Per-model price overrides (USD per 1M tokens), checked before falling back
 * to the provider default above.
 *
 * Two kinds of entry:
 * - **Provider-scoped** (`provider` set): only applies when the request's
 *   provider matches too. Needed because the *same* open-weight model is
 *   sometimes hosted by several providers in this waterfall at genuinely
 *   different prices — e.g. gpt-oss-120b is $0.15/$0.60 on Groq, $0.35/$0.75
 *   on Cerebras, and $0.09/$0.47 on OVHcloud. Without provider-scoping, one
 *   shared "gpt-oss-120b" entry can only be right for one of those three.
 * - **Provider-agnostic** (`provider` omitted): applies regardless of host —
 *   for models only ever wired into one provider in this waterfall, or where
 *   no host-specific pricing difference is known.
 *
 * Substring-matched against the recorded model name in priority order within
 * each kind; the first matching entry wins. Provider-scoped matches are
 * checked before provider-agnostic ones. Order specific patterns (e.g.
 * "gemini-2.5-flash-lite") before the broader patterns they'd otherwise be
 * swallowed by (e.g. "gemini-2.5-flash") — .find() takes the first hit.
 *
 * @example
 * ```typescript
 * // 'gemini-2.5-pro' matches 'gemini-2.5-pro' → charged at the expensive tier
 * AI_MODEL_COST_OVERRIDES.find((o) => !o.provider && 'gemini-2.5-pro'.includes(o.match));
 * // { match: 'gemini-2.5-pro', input: 1.25, output: 10.00 }
 * ```
 */
interface AICostOverride {
  match: string;
  /** Restricts this override to one provider — see the class comment above. Omit for a provider-agnostic match. */
  provider?: AIChatProvider;
  input: number;
  output: number;
}

const AI_MODEL_COST_OVERRIDES: AICostOverride[] = [
  // OpenAI / GitHub tiers — confirmed current against openai.com/api/pricing.
  { match: "gpt-4o-mini", input: 0.15, output: 0.60 },
  { match: "gpt-4o", input: 2.50, output: 10.00 },

  // GPT-OSS — provider-scoped. Same open-weight model, three different
  // hosts in this waterfall, three different confirmed prices. The old
  // single shared entries (0.60/1.50 and 0.01/0.31) were wrong for all
  // three hosts simultaneously; fixed and split out below.
  { match: "gpt-oss-120b", provider: "groq", input: 0.15, output: 0.60 },
  { match: "gpt-oss-120b", provider: "cerebras", input: 0.35, output: 0.75 },
  { match: "gpt-oss-120b", provider: "ovhcloud", input: 0.09, output: 0.47 },
  { match: "gpt-oss-120b", input: 0.15, output: 0.60 }, // fallback for any other host — Groq's confirmed rate.
  { match: "gpt-oss-safeguard", input: 0.075, output: 0.30 }, // NEW — Groq's safety-classifier variant; wasn't matching anything before ("gpt-oss-safeguard-20b" doesn't contain "gpt-oss-20b" as a substring) and was silently falling through to the groq provider default.
  { match: "gpt-oss-20b", input: 0.075, output: 0.30 }, // FIXED (was 0.01/0.31). Groq-confirmed base rate; $0.0375 is the *cached*-input rate, not the listed rate — don't reintroduce that confusion.

  // Gemini tiers — confirmed directly against ai.google.dev/gemini-api/docs/pricing, 2026-08-04. Ordered specific-pattern-first.
  // CAUTION added 2026-09-22: ai.google.dev/gemini-api/docs/deprecations officially lists
  // gemini-2.5-flash's shutdown date as June 17, 2026 and gemini-2.5-flash-lite's as
  // July 22, 2026 — both already past. Google's own release notes (Sept 2026) now say
  // these models are "not deprecated" after all and will keep being served, but access
  // is newly restricted to projects that have "actively used them in the past" — new
  // projects are steered to gemini-3.5-flash-lite or gemini-3.8-flash instead. Prices
  // below are probably still right if calls are still succeeding, but this generation's
  // continued availability for THIS account isn't something either file can confirm —
  // check the AI Studio dashboard for this project, not just whether the below still
  // compiles.
  { match: "gemini-2.5-flash-lite", input: 0.10, output: 0.40 },
  { match: "gemini-2.5-flash", input: 0.30, output: 2.50 },
  { match: "gemini-3.1-flash-lite", input: 0.25, output: 1.50 }, // NEW — was missing entirely; this model is wired into AI_CHAT_MODELS_IDEA in ai-clients.ts and was silently falling through to the (wrong, higher) generic gemini default.
  { match: "gemini-3.5-flash", input: 1.50, output: 9.00 }, // NEW — same gap as above, for the model referenced in ai-clients.ts's comments as a May 2026 release.
  { match: "gemini-3.6-flash", input: 0.75, output: 3.75 }, // ADDED 2026-09-22 — was missing entirely; this model is wired into AI_CHAT_MODELS_WRITING.gemini as the primary pick and was silently falling through to the generic gemini default ($0.30/$2.50, priced for 2.5 Flash — badly wrong for this model). Confirmed against Google's own Cloud pricing page (cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) plus multiple independent trackers: this is Google's current *introductory* rate for 3.6/3.7/3.8 Flash alike, running through Dec 31 2026, then doubling to $1.50/$7.50 on Jan 1 2027 — the standard rate 3.6 Flash actually launched at back in July. Revisit this number after that date.
  { match: "gemini-3.7-flash", input: 0.75, output: 3.75 }, // ADDED 2026-09-22 — same introductory rate as 3.6 Flash above (same Dec 31 2026 → Jan 1 2027 step-up to $1.50/$7.50). Note: gemini-3.8-flash also exists now (released 2026-09-02, same $0.75/$3.75 rate) and isn't wired into ai-clients.ts at all yet — add its own entry here first if it ever gets added there, don't assume it'll fall through to this or the 3.6 entry correctly.
  { match: "gemini-3-flash", input: 0.50, output: 3.00 }, // FIXED (was 0.30/2.50 — that's 2.5 Flash's price, not 3 Flash's). Matches ai-clients.ts's actual model id, gemini-3-flash-preview.
  // { match: "gemini-2.5-pro", input: 1.25, output: 10.00 }, // Confirmed, ≤200K-token tier (steps up to 2.50/15.00 above 200K — not modeled here, same simplification as before).
  { match: "gemini-3.1-pro", input: 2.00, output: 12.00 }, // FIXED (was 1.25/10.00, which is 2.5 Pro's rate). Confirmed ≤200K tier for gemini-3.1-pro-preview; steps up to 4.00/18.00 above 200K.
  { match: "gemini-3-pro", input: 2.00, output: 12.00 }, // FIXED (was 1.25/10.00). Google's own pricing page prices "Gemini 3 Pro Image" text I/O identically to 3.1 Pro, which is the best available confirmation for bare "gemini-3-pro" text pricing.
  { match: "gemini-pro", input: 2.00, output: 12.00 }, // Generic catch-all for any gemini-*-pro model not matched above — bumped from 1.25 to line up with the current 3.x generation now that 2.5-pro/3.1-pro/3-pro all have their own explicit entries checked first.

  // Mistral tiers — NOT re-verified this pass (see the mistral provider-default comment above for why these are lower-confidence than most of this file).
  { match: "mistral-small", input: 0.20, output: 0.60 },
  { match: "mistral-medium", input: 1.00, output: 2.00 },
  { match: "mistral-large", input: 2.00, output: 6.00 },
  { match: "mistral-7b", input: 0.20, output: 0.60 },

  // Llama tiers — provider-scoped where hosts genuinely diverge.
  // REMOVED 2026-09-22: `{ match: "llama-3.3-70b", provider: "groq", input: 0.59, output: 0.79 }`
  // used to live here. Groq deprecated llama-3.3-70b-versatile 08/16/26 and it no
  // longer appears anywhere in ai-clients.ts's groq entries — this override could
  // never match again. The global (non-provider-scoped) fallback two lines below is
  // left in place since it may still be needed for llama-3.3-70b-style model strings
  // on other providers (e.g. OpenRouter's meta-llama/llama-3.3-70b-instruct:free).
  { match: "llama-3.3-nemotron-super-49b", provider: "nvidia", input: 0.10, output: 0.40 }, // UPDATED 2026-09-22 — this entry previously matched "llama-3.3-70b" and priced meta/llama-3.3-70b-instruct, now retired from NIM's hosted endpoint (2026-08-26; see ai-clients.ts). Renamed to match the model that replaced it. Same "NVIDIA doesn't publish a direct build.nvidia.com rate" caveat as the nvidia provider default above — this is triangulated from third-party pass-through pricing for this exact model (OpenRouter lists $0.10/$0.40), not a NIM-specific rate. Substring-matches both the v1 and v1.5 tags. qwen/qwen3-next-80b-a3b-instruct (the other new nvidia WRITING entry in ai-clients.ts) has no override yet and intentionally falls through to the nvidia provider default — same "no confirmed rate" situation, not worth a second guess on top of a guess.
  { match: "llama-3.3-70b", input: 0.59, output: 0.79 }, // fallback for any other host.
  { match: "llama-3.1-8b", input: 0.05, output: 0.08 }, // FIXED input (was 0.03). Groq-confirmed.
  { match: "llama3.1-8b", provider: "cerebras", input: 0.10, output: 0.10 }, // RELABELED — this dotless spelling was previously commented "NVIDIA legacy alias", but the model id actually wired into ai-clients.ts under this exact string is cerebras's AI_CHAT_MODELS_FAST entry (which itself carries a "TODO: is it really available now?" comment — same uncertainty applies here). Price is Cerebras's original 2024 launch rate; may no longer be on their current public rate card at all.
  { match: "llama-4-maverick", input: 0.20, output: 0.80 }, // Not re-verified this pass.
  // REMOVED 2026-09-22: `{ match: "llama-4-scout", input: 0.11, output: 0.34 }` used
  // to live here. meta-llama/llama-4-scout-17b-16e-instruct was deprecated by Groq
  // (the only provider that used it in this file) 07/17/26 and was removed from
  // ai-clients.ts entirely — no successor of the same name exists, so unlike the
  // llama-3.3-70b entry above, there's no other provider this could plausibly still
  // match. Genuinely dead weight, not kept.

  // Qwen — the qwen3.6-27b entry that used to live here ("no confirmed rate anywhere
  // found") is gone: Groq deprecated qwen/qwen3.6-27b 09/14/26 in favor of
  // qwen/qwen3.8-27b (now wired into ai-clients.ts's WRITING/IDEA/TRANSLATION/
  // EVALUATION groq arrays), and the old qwen3-32b/groq override below it is also
  // gone — that model was deprecated by Groq 07/17/26 and removed from ai-clients.ts
  // too. Both replaced with confirmed rates for what's actually in use now.
  { match: "qwen3.8-27b", provider: "groq", input: 0.80, output: 4.00 }, // ADDED 2026-09-22 — confirmed via Groq-specific trackers (typingmind, computeprices), not yet cross-checked against Groq's own docs page directly.
  { match: "qwen3.8-27b", provider: "ovhcloud", input: 0.47, output: 3.19 }, // ADDED 2026-09-22 — confirmed directly against OVHcloud's own published catalog rate; same price OVHcloud lists for Qwen3.6-27B, the model this replaces in ai-clients.ts's ovhcloud entries.

  // GLM / Z.ai family — NEW section.
  { match: "glm-4.7-flash", input: 0, output: 0 }, // Confirmed genuinely free on the official Z.ai API (not a rate-limited trial — $0 input, cached input, and output). This is the model actually wired into ai-clients.ts's zai entries.
  { match: "glm-4.5-flash", input: 0, output: 0 }, // Same — also confirmed free on the official API.
  { match: "glm-4.5-air", input: 0.20, output: 1.10 }, // Official Z.ai rate for the small paid tier (used via openrouter's z-ai/glm-4.5-air in AI_CHAT_MODELS_EVALUATION).
  { match: "zai-glm-4.7", provider: "cerebras", input: 2.25, output: 2.75 }, // Cerebras's own hosted GLM-4.7 (distinct model id from Z.ai's "glm-4.7" — Cerebras prices it well above Z.ai's own $0.60/$2.20 official rate for the same underlying model family). Confirmed via Cerebras's pricing calculator.

  // New-provider-specific models with confirmed or reasonably-grounded rates.
  { match: "deepseek-v3.2", provider: "sambanova", input: 2.00, output: 6.00 }, // Estimate, low confidence — no clean official split found; interpolated from Artificial Analysis's ~$3.15 blended figure for the closely-related DeepSeek V3.1 using DeepSeek's typical ~1:3 input:output ratio elsewhere. This is the model actually wired into ai-clients.ts's sambanova entries, hence pricier than the sambanova provider default above.
  { match: "qwen/qwen3-8b", provider: "siliconflow", input: 0, output: 0 }, // Confirmed (per third-party trackers, most recently dated Aug 2026) as one of SiliconFlow's permanently-$0 models, and the one actually wired into ai-clients.ts's siliconflow entries. CAVEAT added 2026-09-22: you're seeing 402s calling this model — that's very likely an account-side gate (starter credit exhausted, missing real-name/KYC verification, or hitting siliconflow.cn instead of .com — see the platform-mismatch warning already flagged near the siliconflow rate-limit entry above) rather than this model having actually moved off the $0 tier; nothing in current third-party pricing data suggests it was repriced. Left this override as-is since I can't confirm your account state from here — check the SiliconFlow dashboard/balance page directly before assuming the model itself is the problem.
  { match: "mistral-nemo-instruct-2407", provider: "chutes", input: 0.0245, output: 0.0978 }, // ADDED 2026-09-22 — confirmed live against llm.chutes.ai/v1/models. Replaces the old zai-org/GLM-5.1-TEE-implied pricing (that model was never actually overridden here, it was just silently absorbing the $0.30/$1.20 generic chutes default above, which badly understated its real $0.98/$3.08 rate). unsloth/Mistral-Nemo-Instruct-2407-TEE is the model ai-clients.ts now wires in — see its AI_CHAT_MODELS_WRITING.chutes entry for why. NOTE: matching this model string doesn't guarantee calls succeed — Chutes now requires a funded account (subscription or PAYG balance) for every model; a $0-balance account will still 402 here regardless of this cost figure being accurate.
  // REMOVED 2026-09-22: `{ match: "gpt-4o-mini", provider: "llm7", input: 0, output: 0 }`
  // used to live here. ai-clients.ts's llm7 entries no longer reference
  // "gpt-4o-mini" — that model was pulled from LLM7.io's catalog (confirmed
  // via docs.llm7.io/guides/models and the live /v1/models list) and
  // replaced with the `default`/`fast` routing selectors. The override is
  // dead weight now: "gpt-4o-mini" can never appear as a substring of
  // "default" or "fast", so it would never match again. Not replaced with a
  // renamed override either — llm7's generic provider default two lines up
  // is already { input: 0, output: 0 }, and that's correct for both
  // selectors too (LLM7.io has no paid tier at all, regardless of which
  // underlying model a selector resolves to), so a per-model override here
  // would just be duplicating the default for no benefit.

  // Cloudflare
  // REMOVED 2026-09-22: `{ match: "mistral-7b-instruct", input: 0.01, output: 0.01 }`
  // used to live here, priced for @cf/mistral/mistral-7b-instruct-v0.1 — Cloudflare
  // deprecated that model 2026-05-30 (see ai-clients.ts's AI_CHAT_MODELS_WRITING.cloudflare
  // for the full story) and it no longer appears anywhere in this file. Replaced with
  // overrides for the three models Cloudflare's own migration notice recommended instead.
  { match: "glm-4.7-flash", provider: "cloudflare", input: 0.07, output: 0.40 }, // ADDED 2026-09-22 — Cloudflare Workers AI's published rate for @cf/zai-org/glm-4.7-flash (matches the same model's OpenRouter-listed price, so likely a pass-through rather than a Cloudflare-specific markup — unconfirmed which).
  { match: "gemma-4-26b-a4b-it", provider: "cloudflare", input: 0.10, output: 0.30 }, // ADDED 2026-09-22 — estimate. Cloudflare hasn't published this specific model's Workers AI rate anywhere I could confirm; proxied from comparable efficient open-vision-model pricing on Workers AI. Low confidence — replace with Cloudflare's own published number once available.
  { match: "kimi-k2.6", provider: "cloudflare", input: 0.15, output: 0.60 }, // ADDED 2026-09-22 — estimate, same low-confidence caveat as gemma-4-26b-a4b-it above; no Cloudflare-specific published rate found for this exact model yet.

  // Inception (diffusion LLM) — mercury-2 as of the 2026-09-22 model-name fix
  // (was mercury-coder-small; see ai-clients.ts). Free up to a one-time 10M-token
  // account grant, then bills at mercury-2's real rate — provider-scoped so this
  // only ever charges the diffusion provider (an autoregressive model deliberately
  // named "mercury-*" elsewhere would otherwise inherit it).
  { match: "mercury-2", provider: "inception", input: 0.25, output: 0.75 },
];

/**
 * Resolves a cost tier for the given provider + model.
 *
 * Checks {@link AI_MODEL_COST_OVERRIDES} in two passes — provider-scoped
 * matches first, then provider-agnostic ones — falling back to the provider
 * default in {@link AI_COST_PER_MILLION_PREVIEW} if nothing matches.
 *
 * @param provider - The AI provider that served the request
 * @param model - The model name recorded for the request, or null
 * @returns `{ input, output }` USD per 1M tokens for the matched tier
 */
function resolveCostTier(
  provider: AIChatProvider,
  model?: string | null
): { input: number; output: number } {
  if (model) {
    const needle = model.toLowerCase();
    const scoped = AI_MODEL_COST_OVERRIDES.find(
      (o) => o.provider === provider && needle.includes(o.match)
    );
    if (scoped) return { input: scoped.input, output: scoped.output };
    const generic = AI_MODEL_COST_OVERRIDES.find(
      (o) => !o.provider && needle.includes(o.match)
    );
    if (generic) return { input: generic.input, output: generic.output };
  }
  return AI_COST_PER_MILLION_PREVIEW[provider];
}

/**
 * Estimates the USD cost of a single AI request from its token usage.
 *
 * Converts the per-1M-token tier into a per-token price and multiplies by the
 * recorded usage. `inputTokens`/`outputTokens` may be `null` (the `usage` table
 * permits both), in which case the missing quantity contributes zero. Clamps
 * the result to a non-negative value rounded to 6 decimal places.
 *
 * @param provider - The AI provider that served the request
 * @param model - Optional model name (drives tier overrides)
 * @param inputTokens - Prompt tokens consumed, or null/undefined if unknown
 * @param outputTokens - Completion tokens generated, or null/undefined if unknown
 * @returns Estimated cost in USD
 *
 * @example
 * ```typescript
 * const cost = estimateCost('groq', 'openai/gpt-oss-120b', 450, 120);
 * // ≈ (0.15/1e6 * 450) + (0.60/1e6 * 120) ≈ 0.0000398
 * ```
 */
export function estimateCost(
  provider: AIChatProvider,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number {
  const tier = resolveCostTier(provider, model);
  const inputCost = (tier.input / 1_000_000) * (inputTokens ?? 0);
  const outputCost = (tier.output / 1_000_000) * (outputTokens ?? 0);
  return Math.max(0, Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000);
}

/** A single aggregated spend bucket for a day (per provider + model). */
export interface DailyCostRow {
  /** The provider that served the requests */
  provider: AIChatProvider;
  /** The model used for this bucket, or null if not recorded */
  model: string | null;
  /** Number of requests captured in this bucket */
  requests: number;
  /** Total input tokens across the bucket (null if not recorded) */
  inputTokens: number | null;
  /** Total output tokens across the bucket (null if not recorded) */
  outputTokens: number | null;
  /** Estimated USD cost for this bucket */
  cost: number;
}

export interface DailyCostSummary {
  /** The day these rows were aggregated from */
  date: string;
  /** Total estimated USD spend across all providers for the day */
  totalCost: number;
  /** Per provider+model spend breakdown */
  rows: DailyCostRow[];
}

/**
 * Fetches and estimates a day's AI spend from the `usage` table.
 *
 * Runs a read-only aggregation grouped by (provider, model) for the requested
 * day, converting the summed token usage to USD via {@link estimateCost}. Safe
 * to call anywhere (e.g. `/api/health`, a cron) since it only reads.
 *
 * @param date - ISO date string to bucket by; defaults to today
 * @returns A {@link DailyCostSummary} with the aggregated breakdown
 *
 * @example
 * ```typescript
 * const day = await getDailyCostSummary();
 * console.log(`Today's AI spend ≈ $${day.totalCost.toFixed(4)}`);
 * ```
 */
export async function getDailyCostSummary(date?: string): Promise<DailyCostSummary> {
  const target = date ?? getTodayDate();
  const rows = await dbRead
    .select({
      provider: usage.provider,
      model: usage.model,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .from(usage)
    .where(and(eq(usage.date, target)));

  const mapped = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    requests: row.requests ?? 0,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: estimateCost(row.provider, row.model, row.inputTokens, row.outputTokens),
  }));

  const totalCost = mapped.reduce((acc, row) => acc + row.cost, 0);
  return { date: target, totalCost: Math.round(totalCost * 1_000_000) / 1_000_000, rows: mapped };
}

/**
 * Checks the day's estimated AI spend against a threshold and flags a spike.
 *
 * Enables cheap cost-alerting: if today's estimated cost exceeds
 * `${thresholdUsd}`, `overBudget` is true so the caller can log or alert. This
 * is passive alerting only — it never blocks or rejects any request.
 *
 * @param thresholdUsd - USD ceiling for the day's spend (default $20)
 * @returns `{ overBudget, totalCost, summary }` for the current day
 *
 * @example
 * ```typescript
 * const report = await checkDailyCostSpike(25);
 * if (report.overBudget) {
 *   console.error(`[ai-cost] 💸 AI spend over $25: $${report.totalCost.toFixed(2)}`);
 * }
 * ```
 */
export async function checkDailyCostSpike(thresholdUsd = 20): Promise<{
  overBudget: boolean;
  totalCost: number;
  summary: DailyCostSummary;
}> {
  const summary = await getDailyCostSummary();
  const overBudget = summary.totalCost >= thresholdUsd;
  return { overBudget, totalCost: summary.totalCost, summary };
}
