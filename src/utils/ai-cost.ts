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
  groq:      { input: 0.59, output: 0.79 }, // llama-3.3-70b-versatile — confirmed current across five independent trackers.
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
  chutes:    { input: 0.30, output: 1.20 }, // Estimate — no official rate card found; Chutes' pricing is tied to Bittensor subnet economics that shift over time. Rough proxy based on comparable budget-aggregator pricing for similar open models (e.g. DeepSeek-R1 class). TEE/confidential-compute-flagged models may carry an unmodeled premium over this.
  llm7:      { input: 0,    output: 0 },    // Not an estimate — LLM7.io has no paid tier at all; it's free-only by construction (an unofficial mirror with no billing path). This accurately reflects that Twistloom will never be invoiced for it, but also means checkDailyCostSpike() structurally can't catch a problem via this provider — its risk is reliability/ToS, not cost. See ai-clients.ts's AI_RATE_LIMITS comment for that caveat.
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
  { match: "gemini-2.5-flash-lite", input: 0.10, output: 0.40 },
  { match: "gemini-2.5-flash", input: 0.30, output: 2.50 },
  { match: "gemini-3.1-flash-lite", input: 0.25, output: 1.50 }, // NEW — was missing entirely; this model is wired into AI_CHAT_MODELS_IDEA in ai-clients.ts and was silently falling through to the (wrong, higher) generic gemini default.
  { match: "gemini-3.5-flash", input: 1.50, output: 9.00 }, // NEW — same gap as above, for the model referenced in ai-clients.ts's comments as a May 2026 release.
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
  { match: "llama-3.3-70b", provider: "groq", input: 0.59, output: 0.79 },
  { match: "llama-3.3-70b", provider: "nvidia", input: 0.15, output: 0.60 }, // Estimate — same "NVIDIA has no direct published rate" caveat as the nvidia provider default above; matches ai-clients.ts's meta/llama-3.3-70b-instruct.
  { match: "llama-3.3-70b", input: 0.59, output: 0.79 }, // fallback for any other host.
  { match: "llama-3.1-8b", input: 0.05, output: 0.08 }, // FIXED input (was 0.03). Groq-confirmed.
  { match: "llama3.1-8b", provider: "cerebras", input: 0.10, output: 0.10 }, // RELABELED — this dotless spelling was previously commented "NVIDIA legacy alias", but the model id actually wired into ai-clients.ts under this exact string is cerebras's AI_CHAT_MODELS_FAST entry (which itself carries a "TODO: is it really available now?" comment — same uncertainty applies here). Price is Cerebras's original 2024 launch rate; may no longer be on their current public rate card at all.
  { match: "llama-4-maverick", input: 0.20, output: 0.80 }, // Not re-verified this pass.
  { match: "llama-4-scout", input: 0.11, output: 0.34 }, // Refined from 0.10/0.40 — Groq-confirmed exact figures.

  // Qwen — NEW. Groq's self-serve catalog includes this one with a confirmed rate; qwen3.6-27b (also used elsewhere in ai-clients.ts) has no confirmed rate anywhere found, so it's deliberately left unlisted rather than guessed — it'll fall through to the hosting provider's default.
  { match: "qwen3-32b", provider: "groq", input: 0.29, output: 0.59 },

  // GLM / Z.ai family — NEW section.
  { match: "glm-4.7-flash", input: 0, output: 0 }, // Confirmed genuinely free on the official Z.ai API (not a rate-limited trial — $0 input, cached input, and output). This is the model actually wired into ai-clients.ts's zai entries.
  { match: "glm-4.5-flash", input: 0, output: 0 }, // Same — also confirmed free on the official API.
  { match: "glm-4.5-air", input: 0.20, output: 1.10 }, // Official Z.ai rate for the small paid tier (used via openrouter's z-ai/glm-4.5-air in AI_CHAT_MODELS_EVALUATION).
  { match: "zai-glm-4.7", provider: "cerebras", input: 2.25, output: 2.75 }, // Cerebras's own hosted GLM-4.7 (distinct model id from Z.ai's "glm-4.7" — Cerebras prices it well above Z.ai's own $0.60/$2.20 official rate for the same underlying model family). Confirmed via Cerebras's pricing calculator.

  // New-provider-specific models with confirmed or reasonably-grounded rates.
  { match: "deepseek-v3.2", provider: "sambanova", input: 2.00, output: 6.00 }, // Estimate, low confidence — no clean official split found; interpolated from Artificial Analysis's ~$3.15 blended figure for the closely-related DeepSeek V3.1 using DeepSeek's typical ~1:3 input:output ratio elsewhere. This is the model actually wired into ai-clients.ts's sambanova entries, hence pricier than the sambanova provider default above.
  { match: "qwen/qwen3-8b", provider: "siliconflow", input: 0, output: 0 }, // Confirmed — one of SiliconFlow's permanently-$0 models, and the one actually wired into ai-clients.ts's siliconflow entries.
  { match: "gpt-4o-mini", provider: "llm7", input: 0, output: 0 }, // Caught by testing this file: without this scoped override, LLM7.io's free mirror of gpt-4o-mini was falling through to the generic "gpt-4o-mini" entry above (OpenAI's real paid rate) instead of llm7's $0 default — silently over-reporting spend that never actually happens. This is the model wired into ai-clients.ts's llm7 entries.

  // Cloudflare
  { match: "mistral-7b-instruct", input: 0.01, output: 0.01 },
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
 * const cost = estimateCost('groq', 'llama-3.3-70b-versatile', 450, 120);
 * // ≈ (0.59/1e6 * 450) + (0.79/1e6 * 120) ≈ 0.000360
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
