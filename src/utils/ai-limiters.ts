import { getErrorMessage } from './error.js';
import { and, eq, sql } from 'drizzle-orm';
import { usage } from '../db/schema.js';
import { getTodayDate } from './time.js';
import { dbRead, dbWrite } from '../db/client.js';
import { AI_RATE_LIMITS, RATE_LIMIT_SAFETY_BUFFER_PERCENT } from "../config/ai-clients.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { delay } from "./time.js";

/**
 * Calculate rate limit configuration with safety buffer
 */
const getRateLimitConfig = (provider: AIChatProvider) => {
  const actualRpm = AI_RATE_LIMITS[provider].rpm;
  const safetyBuffer = RATE_LIMIT_SAFETY_BUFFER_PERCENT / 100;
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
   * Create a new rate limiter for the specified AI provider
   * @param provider - The AI provider to rate limit calls for
   */
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
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;
    
    if (timeSinceLastCall < this.delay) {
      const waitTime = this.delay - timeSinceLastCall;
      console.log(`[RateLimiter] Throttling ${this.provider} - waiting ${waitTime}ms`);
      await delay(waitTime);
    }
    
    this.lastCall = Date.now();
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
    default: throw new Error(`No rate limiter found for provider: ${provider}`);
  }
}

/**
 * Checks if AI provider can be used today based on daily request limits
 * 
 * @param provider - The AI provider to check
 * @returns Promise resolving to true if provider can be used today, false otherwise
 * 
 * @example
 * ```typescript
 * const canUse = await canUseAIToday('gemini');
 * if (canUse) {
 *   // Make AI request
 * } else {
 *   // Use fallback method
 * }
 * ```
 */
export async function canUseAIToday(provider: AIChatProvider): Promise<boolean> {
  const maxAllowed = AI_RATE_LIMITS[provider].rpd || 0;
  if (maxAllowed === 0) return true;
  try {
    const today = getTodayDate(); // YYYY-MM-DD
    const rows = await dbRead
      .select({ requests: sql`SUM(${usage.requests})`.mapWith(Number) })
      .from(usage)
      .where(and(eq(usage.date, today), eq(usage.provider, provider)))
      .limit(1);

    const used = rows?.[0]?.requests ?? 0;
    const canUse = used < maxAllowed;
    if (!canUse) {
      console.warn(`[${provider}] ⚠️ Daily limit has been reached (${used}/${maxAllowed})`);
    }
    return canUse;
  } catch (err) {
    console.error(`[${provider}] ❌ Daily usage check error:`, getErrorMessage(err));
    // Fail-safe: disallow AI prompt if DB check fails
    return false;
  }
}

/**
 * Increments daily usage count for a specific AI provider and context
 * 
 * @param provider - The AI provider to increment usage for
 * @param context - The usage context (e.g., 'summary', 'context', 'title', etc.)
 * @returns Promise that resolves when increment is complete
 * 
 * @example
 * ```typescript
 * // Increment usage for summary generation
 * await incrementDailyUsageCount('gemini', 'summary');
 * 
 * // Increment usage for context generation
 * await incrementDailyUsageCount('github', 'context');
 * ```
 */
export async function incrementDailyUsageCount(provider: AIChatProvider, context: string): Promise<void> {
  // Increment daily usage counter (upsert)
  try {
    const today = getTodayDate();
    await dbWrite.execute(sql`
      INSERT INTO "usage" (date, provider, requests, context)
      VALUES (${today}, ${provider}, 1, ${context})
      ON CONFLICT (date, provider, context) DO UPDATE SET requests = "usage".requests + 1
    `);
  } catch (err) {
    console.error(`[${provider}] ❌ Failed to increment usage for context '${context}':`, err);
  }
}