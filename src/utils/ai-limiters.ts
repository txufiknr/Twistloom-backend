import { getErrorMessage } from './error.js';
import { and, eq, sql } from 'drizzle-orm';
import { usage } from '../db/schema.js';
import { getCurrentMonthBounds, getTodayDate } from './time.js';
import { dbRead, dbWrite } from '../db/client.js';
import { AI_RATE_LIMITS, AI_RATE_LIMIT_SAFETY_BUFFER_PERCENT } from "../config/ai-clients.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { delay } from "./time.js";

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
  github: getRateLimitConfig('github'),
  gemini: getRateLimitConfig('gemini'),
  cohere: getRateLimitConfig('cohere'),
  groq: getRateLimitConfig('groq'),
  cerebras: getRateLimitConfig('cerebras'),
  mistral: getRateLimitConfig('mistral'),
  nvidia: getRateLimitConfig('nvidia'),
  openrouter: getRateLimitConfig('openrouter'),
  cloudflare: getRateLimitConfig('cloudflare'),
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
let githubLimiter: RateLimiter | null = null;
let geminiLimiter: RateLimiter | null = null;
let groqLimiter: RateLimiter | null = null;
let cohereLimiter: RateLimiter | null = null;
let cerebrasLimiter: RateLimiter | null = null;
let mistralLimiter: RateLimiter | null = null;
let nvidiaLimiter: RateLimiter | null = null;
let openrouterLimiter: RateLimiter | null = null;
let cloudflareLimiter: RateLimiter | null = null;

/**
 * Get GitHub Models rate limiter (singleton)
 * @returns Rate limiter instance for GitHub Models
 */
export function getGitHubLimiter(): RateLimiter {
  return githubLimiter || (githubLimiter = new RateLimiter('github'));
}

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
 * Get rate limiter by provider name with lazy initialization
 * @param provider - AI provider name
 * @returns Rate limiter instance for the provider
 * @throws Error if no rate limiter found for provider
 */
export function getRateLimiter(provider: AIChatProvider): RateLimiter {
  switch (provider) {
    case 'github': return getGitHubLimiter();
    case 'gemini': return getGeminiLimiter();
    case 'groq': return getGroqLimiter();
    case 'cohere': return getCohereLimiter();
    case 'cerebras': return getCerebrasLimiter();
    case 'mistral': return getMistralLimiter();
    case 'nvidia': return getNvidiaLimiter();
    case 'openrouter': return getOpenRouterLimiter();
    case 'cloudflare': return getCloudflareLimiter();
    default: throw new Error(`No rate limiter found for provider: ${provider}`);
  }
}

/**
 * Checks whether an AI provider can still be used based on its configured
 * rate limits. Supports daily (`rpd`) and monthly (`rpmo`) caps independently.
 * Providers with neither configured (mistral, cerebras, nvidia) always pass —
 * their real ceilings are token-budget-based and not tracked here.
 *
 * Both checks query the existing `usage` table with no schema changes:
 * - Daily: SUM(requests) WHERE date = today AND provider = X
 * - Monthly: SUM(requests) WHERE date >= month_start AND date < month_end AND provider = X
 *
 * Why monthly for Cohere: Cohere trial keys cap at 1,000 calls/month with no
 * per-day sublimit. A daily average (1000/30 ≈ 33) would be wrong in both
 * directions — blocking on a day where quota remains, allowing through on a day
 * where monthly quota is already exhausted. Summing the current month is exact.
 *
 * Note on ceiling values: rpd/rpmo in AI_RATE_LIMITS use the ceiling across all
 * models for that provider. Individual models may have lower limits — the
 * waterfall's 429 handling covers the per-model gap gracefully.
 */
export async function canUseAIToday(provider: AIChatProvider): Promise<boolean> {
  const limits = AI_RATE_LIMITS[provider];

  try {
    // --- Daily cap check ---
    if (limits.rpd) {
      const today = getTodayDate(); // 'YYYY-MM-DD'
      const rows = await dbRead
        .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
        .from(usage)
        .where(and(eq(usage.date, today), eq(usage.provider, provider)))
        .limit(1);

      const usedToday = rows?.[0]?.requests ?? 0;
      if (usedToday >= limits.rpd) {
        console.warn(`[${provider}] ⚠️ Daily limit reached (${usedToday}/${limits.rpd})`);
        return false;
      }
    }

    // --- Monthly cap check ---
    if (limits.rpmo) {
      const { start, end } = getCurrentMonthBounds();
      const rows = await dbRead
        .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
        .from(usage)
        .where(and(
          sql`${usage.date} >= ${start}`,
          sql`${usage.date} < ${end}`,
          eq(usage.provider, provider)
        ))
        .limit(1);

      const usedThisMonth = rows?.[0]?.requests ?? 0;
      if (usedThisMonth >= limits.rpmo) {
        console.warn(`[${provider}] ⚠️ Monthly limit reached (${usedThisMonth}/${limits.rpmo})`);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error(`[${provider}] ❌ Usage check error:`, getErrorMessage(err));
    return false; // fail-safe: block rather than overshoot
  }
}

/**
 * Increments daily usage count for a specific AI provider, model, and context
 * 
 * Records request count and optionally token/duration metrics for cost analysis
 * and performance monitoring.
 * 
 * @param provider - The AI provider to increment usage for
 * @param context - The usage context (e.g., 'story-page', 'ai-stream-sse', etc.)
 * @param options - Optional metrics: model, inputTokens, outputTokens, totalTokens, cachedTokens, durationMs
 * 
 * @example
 * ```typescript
 * // Minimal increment (count only)
 * await incrementDailyUsageCount('gemini', 'summary');
 * 
 * // With full metrics
 * await incrementDailyUsageCount('groq', 'story-page', {
 *   model: 'llama-3.3-70b-versatile',
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
    const opts = options ?? {};
    const model = opts.model ?? null;
    const inputTokens = opts.inputTokens ?? null;
    const outputTokens = opts.outputTokens ?? null;
    const totalTokens = opts.totalTokens ?? null;
    const cachedTokens = opts.cachedTokens ?? null;
    const durationMs = opts.durationMs ?? null;

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