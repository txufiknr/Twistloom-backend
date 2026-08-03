import type { AIChatProvider } from "../types/ai-chat.js";
import { usage } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { getTodayDate } from "./time.js";
import { dbRead } from "../db/client.js";

/**
 * AI cost estimation & daily spend tracking.
 *
 * Twistloom routes the same ask through a pool of LLM providers (gemini, groq,
 * mistral, github, cerebras, etc.). This module converts the token totals that
 * `recordUsage()` already stores in the `usage` table into an estimated USD
 * cost. It is deliberately approximate — per-token pricing drifts, free tiers
 * exist, and some providers bill by units other than raw tokens — so treat the
 * numbers as *estimates for budgeting/alerts*, never as an invoicing source.
 */

/**
 * USD cost per 1,000,000 tokens, keyed by provider.
 *
 * Rates reflect a representative model tier for each provider — the flash/mini
 * /small tiers. Pro tiers are priced via {@link AI_MODEL_COST_OVERRIDES}.
 * Expressed in dollars (input/output per 1M tokens).
 *
 * @see https://ai.google.dev/gemini-api/docs/pricing
 * @example
 * ```typescript
 * AI_COST_PER_MILLION_PREVIEW.gemini; // { input: 0.30, output: 2.50 }
 * ```
 */
const AI_COST_PER_MILLION_PREVIEW: Record<AIChatProvider, { input: number; output: number }> = {
  github:    { input: 0.15, output: 0.60 }, // gpt-4o-mini (~gpt-4o priced via override)
  gemini:    { input: 0.30, output: 2.50 }, // gemini-2.5-flash
  cohere:    { input: 0.20, output: 1.00 }, // command-r family (estimate)
  mistral:   { input: 1.00, output: 2.00 }, // mistral-medium-latest
  groq:      { input: 0.59, output: 0.79 }, // llama-3.3-70b-versatile
  cerebras:  { input: 0.60, output: 0.30 }, // llama-3.3-70b
  nvidia:    { input: 0.60, output: 0.30 }, // meta/llama-3.3-70b-instruct
  openrouter:{ input: 0.30, output: 1.20 }, // blended price (varies wildly)
  cloudflare:{ input: 0.01, output: 0.01 }, // @cf/… small models (estimate)
  jina:      { input: 0.02, output: 0.00 }, // jina-embeddings-v5 ($0.02 / 1M tokens)
};

/**
 * Per-model price overrides (USD per 1M tokens).
 *
 * Substring-matched against the recorded model name in priority order; the
 * first matching key wins. Otherwise the provider default from
 * {@link AI_COST_PER_MILLION_PREVIEW} is used.
 *
 * @example
 * ```typescript
 * // 'gemini-2.5-pro' matches 'gemini-2.5-pro' → charged at the expensive tier
 * AI_MODEL_COST_OVERRIDES[
 *   AI_MODEL_COST_OVERRIDES.findIndex((o) => 'gemini-2.5-pro'.includes(o.match))
 * ]; // { match: 'gemini-2.5-pro', input: 1.25, output: 10.00 }
 * ```
 */
const AI_MODEL_COST_OVERRIDES: Array<{ match: string; input: number; output: number }> = [
  // OpenAI / GitHub tiers
  { match: "gpt-4o-mini", input: 0.15, output: 0.60 },
  { match: "gpt-4o", input: 2.50, output: 10.00 },
  { match: "gpt-oss-120b", input: 0.60, output: 1.50 },
  { match: "gpt-oss-20b", input: 0.01, output: 0.31 },
  // Gemini tiers
  { match: "gemini-2.5-flash-lite", input: 0.10, output: 0.40 },
  { match: "gemini-2.5-flash", input: 0.30, output: 2.50 },
  { match: "gemini-3-flash", input: 0.30, output: 2.50 },
  { match: "gemini-2.5-pro", input: 1.25, output: 10.00 },
  { match: "gemini-3.1-pro", input: 1.25, output: 10.00 },
  { match: "gemini-3-pro", input: 1.25, output: 10.00 },
  { match: "gemini-pro", input: 1.25, output: 10.00 },
  // Mistral tiers
  { match: "mistral-small", input: 0.20, output: 0.60 },
  { match: "mistral-medium", input: 1.00, output: 2.00 },
  { match: "mistral-large", input: 2.00, output: 6.00 },
  { match: "mistral-7b", input: 0.20, output: 0.60 },
  // Llama tiers (groq / cerebras / nvidia / openrouter)
  { match: "llama-3.3-70b", input: 0.60, output: 0.80 },
  { match: "llama-3.1-8b", input: 0.03, output: 0.08 },
  { match: "llama-4-maverick", input: 0.20, output: 0.80 },
  { match: "llama-4-scout", input: 0.10, output: 0.40 },
  { match: "llama3.1-8b", input: 0.03, output: 0.08 }, // NVIDIA legacy alias
  // Cloudflare
  { match: "mistral-7b-instruct", input: 0.01, output: 0.01 },
];

/**
 * Resolves a cost tier for the given provider + model.
 *
 * Applies {@link AI_MODEL_COST_OVERRIDES} by substring match (first hit wins),
 * falling back to the provider default in {@link AI_COST_PER_MILLION_PREVIEW}.
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
    const override = AI_MODEL_COST_OVERRIDES.find((o) => needle.includes(o.match));
    if (override) return { input: override.input, output: override.output };
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