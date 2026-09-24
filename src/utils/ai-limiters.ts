import { getErrorMessage } from './error.js';
import { and, eq, sql } from 'drizzle-orm';
import { usage } from '../db/schema.js';
import { getCurrentMonthBounds, getTodayDate } from './time.js';
import { dbRead, dbWrite } from '../db/client.js';
import { AI_RATE_LIMITS, AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT } from "../config/ai-clients.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { delay } from "./time.js";
import { getRedisClient } from './redis.js';

/**
 * Calculate rate limit configuration with safety buffer
 */
const getRateLimitConfig = (provider: AIChatProvider) => {
  const actualRpm = AI_RATE_LIMITS[provider].rpm;
  const safetyBuffer = AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT / 100;
  const bufferedRpm = Math.floor(actualRpm * (1 - safetyBuffer));
  const delayMs = Math.floor(60000 / bufferedRpm); // Convert RPM to milliseconds between calls
  
  return { rpm: bufferedRpm, delayMs };
};

/**
 * Rate limit configuration for each AI provider with safety buffer applied
 */
const AI_RATE_LIMITS_WITH_BUFFER: Record<AIChatProvider, { rpm: number; delayMs: number }> = {
  gemini: getRateLimitConfig('gemini'),
  cohere: getRateLimitConfig('cohere'),
  groq: getRateLimitConfig('groq'),
  cerebras: getRateLimitConfig('cerebras'),
  mistral: getRateLimitConfig('mistral'),
  nvidia: getRateLimitConfig('nvidia'),
  openrouter: getRateLimitConfig('openrouter'),
  cloudflare: getRateLimitConfig('cloudflare'),
  jina: getRateLimitConfig('jina'),
  ovhcloud: getRateLimitConfig('ovhcloud'),
  sambanova: getRateLimitConfig('sambanova'),
  ollama: getRateLimitConfig('ollama'),
  modelscope: getRateLimitConfig('modelscope'),
  zai: getRateLimitConfig('zai'),
  siliconflow: getRateLimitConfig('siliconflow'),
  aionlabs: getRateLimitConfig('aionlabs'),
  chutes: getRateLimitConfig('chutes'),
  llm7: getRateLimitConfig('llm7'),
  inception: getRateLimitConfig('inception'),
};

/**
 * Rate limiter for AI API calls to prevent hitting rate limits
 * 
 * @example
 * ```typescript
 * const groqLimiter = new RateLimiter('groq');
 * const jinaLimiter = new RateLimiter('jina');
 * 
 * async function summarize(text: string) {
 *   await groqLimiter.throttle();
 *   return await groqSummarize({ text });
 * }
 * ```
 */
export class RateLimiter {
  private lastCall: number = 0;
  private readonly delay: number;

  /**
   * Serializes concurrent throttle() calls. Each call chains onto this promise,
   * so overlapping callers wait their turn instead of all reading the same
   * `lastCall` and passing the gate simultaneously.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly provider: AIChatProvider) {
    const config = AI_RATE_LIMITS_WITH_BUFFER[provider];
    if (!config) {
      throw new Error(`No rate limit configuration found for provider: ${provider}`);
    }
    this.delay = config.delayMs;
  }

  /**
   * Throttle the next API call to respect rate limits
   * Automatically delays if called too frequently
   * 
   * @returns Promise that resolves when it's safe to make the next API call
   */
  async throttle(): Promise<void> {
    // Grab a slot in the queue, chained after whoever is currently waiting
    const previous = this.queue;
    let release: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });

    await previous;

    try {
      const now = Date.now();
      const timeSinceLastCall = now - this.lastCall;

      if (timeSinceLastCall < this.delay) {
        const waitTime = this.delay - timeSinceLastCall;
        console.log(`[RateLimiter] ⏰ Throttling ${this.provider} - waiting ${waitTime}ms`);
        await delay(waitTime);
      }

      this.lastCall = Date.now();
    } finally {
      release!();
    }
  }

  /**
   * Get the configured delay for this provider
   * @returns Delay in milliseconds between calls
   */
  getDelay(): number {
    return this.delay;
  }

  /**
   * Get the provider this limiter is configured for
   * @returns The AI provider name
   */
  getProvider(): AIChatProvider {
    return this.provider;
  }

  /**
   * Get the maximum requests per minute for this provider
   * @returns Maximum requests per minute
   */
  getRPM(): number {
    return AI_RATE_LIMITS_WITH_BUFFER[this.provider].rpm;
  }
}

// Singleton rate limiter instances - created only when first accessed
let geminiLimiter: RateLimiter | null = null;
let groqLimiter: RateLimiter | null = null;
let cohereLimiter: RateLimiter | null = null;
let cerebrasLimiter: RateLimiter | null = null;
let mistralLimiter: RateLimiter | null = null;
let nvidiaLimiter: RateLimiter | null = null;
let openrouterLimiter: RateLimiter | null = null;
let cloudflareLimiter: RateLimiter | null = null;
let jinaLimiter: RateLimiter | null = null;
let inceptionLimiter: RateLimiter | null = null;
let ovhcloudLimiter: RateLimiter | null = null;
let sambanovaLimiter: RateLimiter | null = null;
let ollamaLimiter: RateLimiter | null = null;
let modelscopeLimiter: RateLimiter | null = null;
let zaiLimiter: RateLimiter | null = null;
let siliconflowLimiter: RateLimiter | null = null;
let aionlabsLimiter: RateLimiter | null = null;
let chutesLimiter: RateLimiter | null = null;
let llm7Limiter: RateLimiter | null = null;

/**
 * Get Gemini rate limiter (singleton)
 * @returns Rate limiter instance for Gemini
 */
export function getGeminiLimiter(): RateLimiter {
  return geminiLimiter || (geminiLimiter = new RateLimiter('gemini'));
}

/**
 * Get Groq rate limiter (singleton)
 * @returns Rate limiter instance for Groq
 */
export function getGroqLimiter(): RateLimiter {
  return groqLimiter || (groqLimiter = new RateLimiter('groq'));
}

/**
 * Get Cohere rate limiter (singleton)
 * @returns Rate limiter instance for Cohere
 */
export function getCohereLimiter(): RateLimiter {
  return cohereLimiter || (cohereLimiter = new RateLimiter('cohere'));
}

/**
 * Get Cerebras rate limiter (singleton)
 * @returns Rate limiter instance for Cerebras
 */
export function getCerebrasLimiter(): RateLimiter {
  return cerebrasLimiter || (cerebrasLimiter = new RateLimiter('cerebras'));
}

/**
 * Get Mistral rate limiter (singleton)
 * @returns Rate limiter instance for Mistral
 */
export function getMistralLimiter(): RateLimiter {
  return mistralLimiter || (mistralLimiter = new RateLimiter('mistral'));
}

/**
 * Get NVIDIA rate limiter (singleton)
 * @returns Rate limiter instance for NVIDIA
 */
export function getNvidiaLimiter(): RateLimiter {
  return nvidiaLimiter || (nvidiaLimiter = new RateLimiter('nvidia'));
}

/**
 * Get OpenRouter rate limiter (singleton)
 * @returns Rate limiter instance for OpenRouter
 */
export function getOpenRouterLimiter(): RateLimiter {
  return openrouterLimiter || (openrouterLimiter = new RateLimiter('openrouter'));
}

/**
 * Get Cloudflare Workers AI rate limiter (singleton)
 * @returns Rate limiter instance for Cloudflare Workers AI
 */
export function getCloudflareLimiter(): RateLimiter {
  return cloudflareLimiter || (cloudflareLimiter = new RateLimiter('cloudflare'));
}

/**
 * Get Jina AI rate limiter (singleton)
 *
 * Embeddings only (jina-embeddings-v5-text-small), not a chat provider.
 * Shared by every caller — fire-and-forget page/character/place/future-note
 * embeds AND the backfill cron all funnel through this one instance, so the
 * serialized throttle() queue naturally caps concurrency too (see roadmap
 * §2 for the math: ~652ms spacing at 100 RPM with an 8% buffer, comfortably
 * above Jina's ~100-500ms typical latency — no separate concurrency
 * semaphore needed).
 *
 * @returns Rate limiter instance for Jina AI
 */
export function getJinaLimiter(): RateLimiter {
  return jinaLimiter || (jinaLimiter = new RateLimiter('jina'));
}

/**
 * Get Inception rate limiter (singleton)
 * @returns Rate limiter instance for Inception (diffusion LLM provider)
 */
export function getInceptionLimiter(): RateLimiter {
  return inceptionLimiter || (inceptionLimiter = new RateLimiter('inception'));
}

/**
 * Get OVHcloud rate limiter (singleton)
 */
export function getOvhcloudLimiter(): RateLimiter {
  return ovhcloudLimiter || (ovhcloudLimiter = new RateLimiter('ovhcloud'));
}

/**
 * Get SambaNova rate limiter (singleton)
 */
export function getSambanovaLimiter(): RateLimiter {
  return sambanovaLimiter || (sambanovaLimiter = new RateLimiter('sambanova'));
}

/**
 * Get Ollama rate limiter (singleton)
 */
export function getOllamaLimiter(): RateLimiter {
  return ollamaLimiter || (ollamaLimiter = new RateLimiter('ollama'));
}

/**
 * Get ModelScope rate limiter (singleton)
 */
export function getModelscopeLimiter(): RateLimiter {
  return modelscopeLimiter || (modelscopeLimiter = new RateLimiter('modelscope'));
}

/**
 * Get Z.ai rate limiter (singleton)
 */
export function getZaiLimiter(): RateLimiter {
  return zaiLimiter || (zaiLimiter = new RateLimiter('zai'));
}

/**
 * Get SiliconFlow rate limiter (singleton)
 */
export function getSiliconflowLimiter(): RateLimiter {
  return siliconflowLimiter || (siliconflowLimiter = new RateLimiter('siliconflow'));
}

/**
 * Get Aion Labs rate limiter (singleton)
 */
export function getAionlabsLimiter(): RateLimiter {
  return aionlabsLimiter || (aionlabsLimiter = new RateLimiter('aionlabs'));
}

/**
 * Get Chutes rate limiter (singleton)
 */
export function getChutesLimiter(): RateLimiter {
  return chutesLimiter || (chutesLimiter = new RateLimiter('chutes'));
}

/**
 * Get LLM7 rate limiter (singleton)
 */
export function getLlm7Limiter(): RateLimiter {
  return llm7Limiter || (llm7Limiter = new RateLimiter('llm7'));
}

/**
 * Get rate limiter by provider name with lazy initialization
 * @param provider - AI provider name
 * @returns Rate limiter instance for the provider
 * @throws Error if no rate limiter found for provider
 */
export function getRateLimiter(provider: AIChatProvider): RateLimiter {
  switch (provider) {
    case 'gemini': return getGeminiLimiter();
    case 'groq': return getGroqLimiter();
    case 'cohere': return getCohereLimiter();
    case 'cerebras': return getCerebrasLimiter();
    case 'mistral': return getMistralLimiter();
    case 'nvidia': return getNvidiaLimiter();
    case 'openrouter': return getOpenRouterLimiter();
    case 'cloudflare': return getCloudflareLimiter();
    case 'jina': return getJinaLimiter();
    case 'inception': return getInceptionLimiter();
    case 'ovhcloud': return getOvhcloudLimiter();
    case 'sambanova': return getSambanovaLimiter();
    case 'ollama': return getOllamaLimiter();
    case 'modelscope': return getModelscopeLimiter();
    case 'zai': return getZaiLimiter();
    case 'siliconflow': return getSiliconflowLimiter();
    case 'aionlabs': return getAionlabsLimiter();
    case 'chutes': return getChutesLimiter();
    case 'llm7': return getLlm7Limiter();
    // default: throw new Error(`No rate limiter found for provider: ${provider}`);
  }
}

/**
 * Structured result of a read-only quota check.
 */
export type QuotaCheckResult =
  | { allowed: true; reason: 'ok' }
  | { allowed: false; reason: 'daily' | 'monthly' | 'token-budget' | 'cooldown' | 'error'; resetAt?: Date; used?: number; limit?: number };

/**
 * Result of an atomic admission attempt.
 */
export type QuotaAdmitResult =
  | { admitted: true }
  | { admitted: false; reason: 'daily' | 'monthly' | 'token-budget' | 'cooldown' | 'error' };

/** Seconds until the next UTC midnight — used for QUOTA_EXCEEDED cooldown TTLs. */
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}

/** Seconds until the first day of the next UTC month — for monthly cooldown TTLs. */
function secondsUntilUtcMonthStart(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}

/**
 * Cooldown Redis key for a provider/model pair. Model is omitted for
 * aggregate-grain cooldowns (provider-level hold).
 */
function cooldownKey(provider: AIChatProvider, model?: string): string {
  return model
    ? `ai:cooldown:${provider}:${model}`
    : `ai:cooldown:${provider}`;
}

/**
 * Quota admit Redis key for a provider/model pair over a UTC-day window.
 * Model segment is omitted for aggregate grain.
 */
function quotaDayKey(provider: AIChatProvider, model?: string): string {
  const day = getTodayDate();
  return model
    ? `ai:quota:${provider}:${model}:${day}`
    : `ai:quota:${provider}:${day}`;
}

/**
 * Quota admit Redis key for a provider over the current UTC-month window.
 */
function quotaMonthKey(provider: AIChatProvider): string {
  const { start } = getCurrentMonthBounds();
  return `ai:quota:${provider}:m:${start.slice(0, 7)}`;
}

/**
 * Reads an active cooldown for a provider/model, if any.
 * Returns the remaining TTL in seconds when a cooldown is live, 0 otherwise.
 */
export async function getCooldownRemainingSeconds(
  provider: AIChatProvider,
  model?: string,
): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;
  try {
    const key = cooldownKey(provider, model);
    // Upstash: ttl returns -2 if key missing, -1 if no expire, >0 if remaining.
    const ttl = await redis.ttl(key);
    return typeof ttl === 'number' && ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}

/**
 * Sets a cooldown hold on a provider/model.
 *
 * - `RATE_LIMITED` → short TTL (Retry-After or exponential backoff seconds).
 * - `QUOTA_EXCEEDED` → TTL to UTC midnight (daily) or month start (monthly),
 *   so the waterfall skips a known-dead quota for the rest of the window.
 *
 * @param provider - Provider to hold
 * @param model - Specific model, or undefined for a provider-level hold
 * @param ttlSeconds - Cooldown duration in seconds
 */
export async function setQuotaCooldown(
  provider: AIChatProvider,
  model: string | undefined,
  ttlSeconds: number,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || ttlSeconds <= 0) return;
  try {
    await redis.set(cooldownKey(provider, model), '1', { ex: ttlSeconds });
  } catch (err) {
    console.warn(`[${provider}] Failed to set cooldown:`, getErrorMessage(err));
  }
}

/**
 * Clears a cooldown (e.g. after a successful call proves the hold was stale).
 */
export async function clearQuotaCooldown(
  provider: AIChatProvider,
  model?: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(cooldownKey(provider, model));
  } catch {
    // best-effort
  }
}

/**
 * Computes the effective daily ceiling for a provider+model combination,
 * honoring per-model overrides when `grain: 'per-model'`.
 */
function effectiveDailyCeiling(
  provider: AIChatProvider,
  model?: string,
): number | undefined {
  const limits = AI_RATE_LIMITS[provider];
  if (model && limits.grain === 'per-model' && limits.models?.[model]?.rpd !== undefined) {
    return limits.models[model].rpd;
  }
  return limits.rpd;
}

/**
 * Computes the effective monthly ceiling for a provider+model combination.
 */
function effectiveMonthlyCeiling(
  provider: AIChatProvider,
  model?: string,
): number | undefined {
  const limits = AI_RATE_LIMITS[provider];
  if (model && limits.grain === 'per-model' && limits.models?.[model]?.rpmo !== undefined) {
    return limits.models[model].rpmo;
  }
  return limits.rpmo;
}

/**
 * Reads the Postgres `usage` sum for the given grain (analytics SSOT fallback
 * and the read-only check path). Performs NO writes and NO Redis INCR.
 */
async function readUsageSum(
  provider: AIChatProvider,
  opts: { model?: string; grain?: 'aggregate' | 'per-model'; window: 'day' | 'month' },
): Promise<number> {
  const limits = AI_RATE_LIMITS[provider];
  const useModel = opts.grain === 'per-model' && opts.model;

  if (opts.window === 'day') {
    const today = getTodayDate();
    const rows = useModel
      ? await dbRead
          .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
          .from(usage)
          .where(and(eq(usage.date, today), eq(usage.provider, provider), eq(usage.model, opts.model!)))
          .limit(1)
      : await dbRead
          .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
          .from(usage)
          .where(and(eq(usage.date, today), eq(usage.provider, provider)))
          .limit(1);
    return rows?.[0]?.requests ?? 0;
  }

  // Monthly
  const { start, end } = getCurrentMonthBounds();
  const rows = useModel
    ? await dbRead
        .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
        .from(usage)
        .where(and(
          sql`${usage.date} >= ${start}`,
          sql`${usage.date} < ${end}`,
          eq(usage.provider, provider),
          eq(usage.model, opts.model!),
        ))
        .limit(1)
    : await dbRead
        .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
        .from(usage)
        .where(and(
          sql`${usage.date} >= ${start}`,
          sql`${usage.date} < ${end}`,
          eq(usage.provider, provider),
        ))
        .limit(1);
  void limits;
  return rows?.[0]?.requests ?? 0;
}

/**
 * Reads the Postgres `usage` total_tokens sum for the given window.
 * Only consulted when `tpd` is configured and stream usage capture is complete.
 */
async function readTokenSum(
  provider: AIChatProvider,
  window: 'day' | 'month',
): Promise<number> {
  if (window === 'day') {
    const today = getTodayDate();
    const rows = await dbRead
      .select({ tokens: sql`SUM(${usage.totalTokens})`.mapWith(Number) })
      .from(usage)
      .where(and(eq(usage.date, today), eq(usage.provider, provider)))
      .limit(1);
    return rows?.[0]?.tokens ?? 0;
  }
  const { start, end } = getCurrentMonthBounds();
  const rows = await dbRead
    .select({ tokens: sql`SUM(${usage.totalTokens})`.mapWith(Number) })
    .from(usage)
    .where(and(
      sql`${usage.date} >= ${start}`,
      sql`${usage.date} < ${end}`,
      eq(usage.provider, provider),
    ))
    .limit(1);
  return rows?.[0]?.tokens ?? 0;
}

/**
 * Observability: structured deny log + near-limit warn at ≥80%.
 */
function logQuotaDecision(
  provider: AIChatProvider,
  model: string | undefined,
  grain: 'aggregate' | 'per-model',
  outcome: 'allow' | 'deny',
  reason: string,
  used?: number,
  limit?: number,
  source: 'check' | 'admit' | 'cooldown' = 'check',
): void {
  const payload = { provider, model, grain, reason, used, limit, source };
  if (outcome === 'deny') {
    console.warn(`[Quota] DENY ${JSON.stringify(payload)}`);
    return;
  }
  if (limit !== undefined && used !== undefined && limit > 0) {
    const ratio = used / limit;
    if (ratio >= 0.8) {
      console.warn(`[Quota] NEAR-LIMIT ${JSON.stringify({ ...payload, pct: Math.round(ratio * 100) })}`);
    }
  }
}

/**
 * CQS **check** path — read-only quota evaluation.
 *
 * Performs NO Redis INCR and NO DB writes. Safe to call from pre-gates,
 * boolean wrappers, and any path that may invoke check multiple times
 * before a single `admitAIQuota`.
 *
 * Grain dispatch:
 * - `aggregate` — SUM(requests) WHERE date, provider (all models share one bucket)
 * - `per-model` + model — SUM WHERE date, provider, model
 * - `per-model` without model — allow if any `candidateModels` entry is under ceiling
 *   (coarse pre-gate; authoritative check is per attempt)
 * - `tpd` — additionally SUM(total_tokens) >= tpd (effective after Step 10 usage capture)
 * - `window: 'provider-cycle'` — not evaluated (always pass; RPM throttle still applies)
 *
 * Fail policy (Q2 tiered): DB error → fail-closed for strictly capped providers
 * (`rpd ≤ 50` or `tpd` present), fail-open with structured warn otherwise.
 *
 * @param provider - Provider to check
 * @param opts.model - Specific model for per-model grain
 * @param opts.candidateModels - Models this request may actually try (for coarse pre-gate)
 */
export async function checkAIQuota(
  provider: AIChatProvider,
  opts?: { model?: string; candidateModels?: readonly string[] },
): Promise<QuotaCheckResult> {
  const limits = AI_RATE_LIMITS[provider];
  const grain = limits.grain ?? 'aggregate';
  const model = opts?.model;

  // provider-cycle windows are not evaluated by the day/month gate.
  if (limits.window === 'provider-cycle') {
    return { allowed: true, reason: 'ok' };
  }

  try {
    // --- Cooldown check (set by step 6 dual-tier cooldown) ---
    const cooldownTtl = await getCooldownRemainingSeconds(provider, model);
    if (cooldownTtl > 0) {
      logQuotaDecision(provider, model, grain, 'deny', 'cooldown', undefined, undefined, 'cooldown');
      return { allowed: false, reason: 'cooldown', resetAt: new Date(Date.now() + cooldownTtl * 1000) };
    }

    // --- Daily cap ---
    const dailyCeiling = effectiveDailyCeiling(provider, model);
    if (dailyCeiling !== undefined) {
      if (grain === 'per-model' && !model) {
        // Coarse pre-gate: allow if ANY candidate model remains under ceiling.
        const candidates = opts?.candidateModels ?? [];
        if (candidates.length > 0) {
          let anyOpen = false;
          for (const m of candidates) {
            const used = await readUsageSum(provider, { model: m, grain: 'per-model', window: 'day' });
            const ceil = effectiveDailyCeiling(provider, m) ?? dailyCeiling;
            if (used < ceil) { anyOpen = true; break; }
          }
          if (!anyOpen) {
            logQuotaDecision(provider, undefined, grain, 'deny', 'daily');
            return { allowed: false, reason: 'daily', used: dailyCeiling, limit: dailyCeiling };
          }
        }
        // No candidates provided → fall through to aggregate-style check below.
      }
      if (model || grain === 'aggregate') {
        const used = await readUsageSum(provider, { model, grain, window: 'day' });
        if (used >= dailyCeiling) {
          logQuotaDecision(provider, model, grain, 'deny', 'daily', used, dailyCeiling);
          return { allowed: false, reason: 'daily', used, limit: dailyCeiling };
        }
        logQuotaDecision(provider, model, grain, 'allow', 'ok', used, dailyCeiling);
      }
    }

    // --- Monthly cap ---
    const monthlyCeiling = effectiveMonthlyCeiling(provider, model);
    if (monthlyCeiling !== undefined) {
      const used = await readUsageSum(provider, { model, grain, window: 'month' });
      if (used >= monthlyCeiling) {
        logQuotaDecision(provider, model, grain, 'deny', 'monthly', used, monthlyCeiling);
        return { allowed: false, reason: 'monthly', used, limit: monthlyCeiling };
      }
      logQuotaDecision(provider, model, grain, 'allow', 'ok', used, monthlyCeiling);
    }

    // --- Token budget (tpd) — only when configured; requires complete usage capture (Step 10) ---
    if (limits.tpd !== undefined) {
      const usedTokens = await readTokenSum(provider, 'day');
      if (usedTokens >= limits.tpd) {
        logQuotaDecision(provider, model, grain, 'deny', 'token-budget', usedTokens, limits.tpd);
        return { allowed: false, reason: 'token-budget', used: usedTokens, limit: limits.tpd };
      }
      logQuotaDecision(provider, model, grain, 'allow', 'ok', usedTokens, limits.tpd);
    }

    return { allowed: true, reason: 'ok' };
  } catch (err) {
    console.error(`[${provider}] ❌ Quota check error:`, getErrorMessage(err));
    // Q2 tiered fail policy:
    // - Strictly capped (rpd ≤ 50 or tpd set): fail-closed to protect free-tier caps.
    // - High/uncapped: fail-open with structured warn so a DB blip doesn't 100% outage the waterfall.
    const strictCap = (limits.rpd !== undefined && limits.rpd <= 50) || limits.tpd !== undefined;
    if (strictCap) {
      return { allowed: false, reason: 'error' };
    }
    console.warn(`[Quota] FAIL-OPEN ${JSON.stringify({ provider, reason: 'db-error' })}`);
    return { allowed: true, reason: 'ok' };
  }
}

/**
 * Thin boolean wrapper — preserves existing boolean call sites
 * (`backfill-embeddings.ts:53`, roadmap references). Read-only: no side effects.
 */
export async function canUseAIToday(provider: AIChatProvider): Promise<boolean> {
  return (await checkAIQuota(provider)).allowed;
}

/**
 * CQS **admit** path — atomic Redis Lua `INCR` + `EXPIRE` + ceiling check.
 *
 * One round-trip; fixes the INCR/EXPIRE TTL-leak window and the DECR race of
 * the naive INCR→check→DECR pattern. Redis is the real-time **attempt**
 * authority: every admitted HTTP attempt (including 429/quota failures)
 * increments this counter, matching what the provider counts.
 *
 * On Redis error: falls back to a DB `SUM` conditional admit (today's query).
 *
 * @param provider - Provider to admit against
 * @param opts.model - Specific model for per-model grain
 * @returns `{ admitted: true }` when the caller may proceed; otherwise a deny reason.
 */
export async function admitAIQuota(
  provider: AIChatProvider,
  opts?: { model?: string },
): Promise<QuotaAdmitResult> {
  const limits = AI_RATE_LIMITS[provider];
  const grain = limits.grain ?? 'aggregate';
  const model = opts?.model;

  if (limits.window === 'provider-cycle') {
    return { admitted: true };
  }

  // Cooldown still gates admission (belt-and-suspenders after check).
  const cooldownTtl = await getCooldownRemainingSeconds(provider, model);
  if (cooldownTtl > 0) {
    return { admitted: false, reason: 'cooldown' };
  }

  const dailyCeiling = effectiveDailyCeiling(provider, model);
  const monthlyCeiling = effectiveMonthlyCeiling(provider, model);
  const useModelKey = grain === 'per-model' && model;

  const redis = getRedisClient();
  if (redis) {
    try {
      // Lua: INCR, EXPIRE if new, ceiling test, DECR on over-limit — atomic.
      const ADMIT_LUA = `
        local v = redis.call('INCR', KEYS[1])
        if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
        if tonumber(v) > tonumber(ARGV[1]) then
          redis.call('DECR', KEYS[1])
          return 0
        end
        return 1
      `;

      if (dailyCeiling !== undefined) {
        const key = quotaDayKey(provider, useModelKey ? model : undefined);
        const ttl = secondsUntilUtcMidnight();
        const ok = await (redis as unknown as { eval(script: string, keys: string[], args: string[]): Promise<unknown> }).eval(ADMIT_LUA, [key], [String(dailyCeiling), String(ttl)]);
        if (ok === 0 || ok === '0') {
          logQuotaDecision(provider, model, grain, 'deny', 'daily', dailyCeiling, dailyCeiling, 'admit');
          return { admitted: false, reason: 'daily' };
        }
      }

      if (monthlyCeiling !== undefined) {
        const key = quotaMonthKey(provider);
        const ttl = secondsUntilUtcMonthStart();
        const ok = await (redis as unknown as { eval(script: string, keys: string[], args: string[]): Promise<unknown> }).eval(ADMIT_LUA, [key], [String(monthlyCeiling), String(ttl)]);
        if (ok === 0 || ok === '0') {
          logQuotaDecision(provider, model, grain, 'deny', 'monthly', monthlyCeiling, monthlyCeiling, 'admit');
          return { admitted: false, reason: 'monthly' };
        }
      }

      // Token-budget admit: Redis token counter (best-effort; falls back to DB check).
      if (limits.tpd !== undefined) {
        const tkey = `ai:quota-tokens:${provider}:${getTodayDate()}`;
        const ok = await (redis as unknown as { eval(script: string, keys: string[], args: string[]): Promise<unknown> }).eval(ADMIT_LUA, [tkey], [String(limits.tpd), String(secondsUntilUtcMidnight())]);
        if (ok === 0 || ok === '0') {
          logQuotaDecision(provider, model, grain, 'deny', 'token-budget', limits.tpd, limits.tpd, 'admit');
          return { admitted: false, reason: 'token-budget' };
        }
      }

      return { admitted: true };
    } catch (err) {
      console.warn(`[${provider}] Redis admit failed, falling back to DB:`, getErrorMessage(err));
      // fall through to DB fallback
    }
  }

  // DB fallback — conditional admit using today's SUM (byte-for-byte legacy query shape).
  try {
    if (dailyCeiling !== undefined) {
      const used = await readUsageSum(provider, { model, grain, window: 'day' });
      if (used >= dailyCeiling) {
        logQuotaDecision(provider, model, grain, 'deny', 'daily', used, dailyCeiling, 'admit');
        return { admitted: false, reason: 'daily' };
      }
    }
    if (monthlyCeiling !== undefined) {
      const used = await readUsageSum(provider, { model, grain, window: 'month' });
      if (used >= monthlyCeiling) {
        logQuotaDecision(provider, model, grain, 'deny', 'monthly', used, monthlyCeiling, 'admit');
        return { admitted: false, reason: 'monthly' };
      }
    }
    return { admitted: true };
  } catch (err) {
    console.error(`[${provider}] ❌ Admit DB fallback error:`, getErrorMessage(err));
    const strictCap = (limits.rpd !== undefined && limits.rpd <= 50) || limits.tpd !== undefined;
    return strictCap
      ? { admitted: false, reason: 'error' }
      : { admitted: true };
  }
}

/**
 * CQS **settle** path — records a successful request's tokens/duration into
 * `usage` (analytics SSOT). Does NOT re-increment attempt counts (those live
 * in Redis via `admitAIQuota`). Success-only: called only after a good output.
 *
 * Thin alias over `incrementDailyUsageCount` for CQS call-site clarity.
 */
export async function settleAIQuota(
  provider: AIChatProvider,
  context: string,
  options?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    durationMs?: number;
  },
): Promise<void> {
  return incrementDailyUsageCount(provider, context, options);
}

/**
 * Increments daily usage count for a specific AI provider, model, and context
 *
 * Records a **successful** request and optionally token/duration metrics for
 * cost analysis and performance monitoring. Attempt counts (including failures)
 * are tracked separately in Redis via `admitAIQuota` — this function is the
 * success-only analytics write (see roadmap Q4 decision).
 *
 * @param provider - The AI provider to increment usage for
 * @param context - The usage context (e.g., 'story-page', 'ai-stream-sse', etc.)
 * @param options - Optional metrics: model, inputTokens, outputTokens, totalTokens, cachedTokens, durationMs
 *
 * @example
 * ```typescript
 * // Minimal increment (count only)
 * await incrementDailyUsageCount('gemini', 'summary', { model: 'gemini-2.5-flash' });
 *
 * // With full metrics
 * await incrementDailyUsageCount('groq', 'story-page', {
 *   model: 'openai/gpt-oss-120b',
 *   inputTokens: 450,
 *   outputTokens: 120,
 *   totalTokens: 570,
 *   durationMs: 1234,
 * });
 * ```
 */
export async function incrementDailyUsageCount(
  provider: AIChatProvider,
  context: string,
  options?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    durationMs?: number;
  }
): Promise<void> {
  try {
    const today = getTodayDate();
    const {
      // PK columns are NOT NULL — sanitize missing model to 'default'
      // so inserts without an explicit model never violate the composite PK.
      model = 'default',
      inputTokens = null,
      outputTokens = null,
      totalTokens = null,
      cachedTokens = null,
      durationMs = null
    } = options ?? {};

    await dbWrite.execute(sql`
      INSERT INTO "usage" (date, provider, model, requests, input_tokens, output_tokens, total_tokens, cached_tokens, duration_ms, context)
      VALUES (${today}, ${provider}, ${model}, 1, ${inputTokens}, ${outputTokens}, ${totalTokens}, ${cachedTokens}, ${durationMs}, ${context})
      ON CONFLICT (date, provider, context, model) DO UPDATE SET
        requests = "usage".requests + 1,
        input_tokens = COALESCE("usage".input_tokens, 0) + COALESCE(${inputTokens}, 0),
        output_tokens = COALESCE("usage".output_tokens, 0) + COALESCE(${outputTokens}, 0),
        total_tokens = COALESCE("usage".total_tokens, 0) + COALESCE(${totalTokens}, 0),
        cached_tokens = COALESCE("usage".cached_tokens, 0) + COALESCE(${cachedTokens}, 0),
        duration_ms = COALESCE("usage".duration_ms, 0) + COALESCE(${durationMs}, 0)
    `);
  } catch (err) {
    console.error(`[${provider}] ❌ Failed to increment usage for context '${context}':`, err);
  }
}