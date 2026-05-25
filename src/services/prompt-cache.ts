/**
 * @overview Prompt Cache Service
 * 
 * Core caching logic for AI-generated story themes.
 * Handles prompt selection, validation, storage, and user-specific freshness tracking.
 */

import { dbRead, dbWrite } from "../db/client.js";
import { storyPrompts, userPromptHistory } from "../db/schema.js";
import { eq, and, sql, count } from "drizzle-orm";
import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";
import type { AIChatProvider } from "../types/ai-chat.js";

// Simple in-memory cache hit rate tracking (for monitoring)
let cacheHits = 0;
let cacheMisses = 0;
let trackingStartTime = new Date();

/**
 * Gets the count of active prompts in the cache
 * 
 * @returns Promise resolving to the number of active prompts
 * 
 * @example
 * ```typescript
 * const count = await getActivePromptCount();
 * console.log(`Active prompts: ${count}`);
 * ```
 */
export async function getActivePromptCount(): Promise<number> {
  const result = await dbRead
    .select({ count: count() })
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  return result[0]?.count || 0;
}

/**
 * Gets the IDs of prompts a user has already viewed
 * 
 * @param userId - User ID to check history for
 * @returns Promise resolving to array of viewed prompt IDs
 * 
 * @example
 * ```typescript
 * const viewedIds = await getUserViewedPromptIds('user123');
 * console.log(`User has viewed ${viewedIds.length} prompts`);
 * ```
 */
export async function getUserViewedPromptIds(userId: string): Promise<string[]> {
  const history = await dbRead
    .select({ promptId: userPromptHistory.promptId })
    .from(userPromptHistory)
    .where(eq(userPromptHistory.userId, userId));
  
  return history.map(h => h.promptId);
}

/**
 * Gets the least recently viewed prompt for a user
 * 
 * Fallback when no fresh prompts are available.
 * 
 * @param userId - User ID to find LRV prompt for
 * @returns Promise resolving to the prompt or null
 * 
 * @example
 * ```typescript
 * const prompt = await getLeastRecentlyViewedPrompt('user123');
 * if (prompt) {
 *   console.log('Serving least recently viewed prompt');
 * }
 * ```
 */
export async function getLeastRecentlyViewedPrompt(userId: string): Promise<typeof storyPrompts.$inferSelect | null> {
  const result = await dbRead
    .select()
    .from(storyPrompts)
    .innerJoin(
      userPromptHistory,
      eq(storyPrompts.id, userPromptHistory.promptId)
    )
    .where(
      and(
        eq(storyPrompts.isActive, true),
        eq(userPromptHistory.userId, userId)
      )
    )
    .orderBy(userPromptHistory.viewedAt)
    .limit(1);
  
  return result[0]?.story_prompts || null;
}

/**
 * Gets a fresh prompt for a specific user
 * 
 * Selects a random prompt that the user hasn't viewed yet.
 * Falls back to least recently viewed if no fresh prompts available.
 * 
 * @param userId - User ID to get fresh prompt for
 * @returns Promise resolving to the prompt or null
 * 
 * @example
 * ```typescript
 * const prompt = await getFreshPromptForUser('user123');
 * if (prompt) {
 *   console.log('Fresh prompt:', prompt.theme);
 * }
 * ```
 */
export async function getFreshPromptForUser(userId: string): Promise<typeof storyPrompts.$inferSelect | null> {
  const viewedPromptIds = await getUserViewedPromptIds(userId);
  
  // Select from active prompts excluding viewed ones
  const freshPrompt = await dbRead
    .select()
    .from(storyPrompts)
    .where(
      and(
        eq(storyPrompts.isActive, true),
        viewedPromptIds.length > 0 
          ? sql`${storyPrompts.id} NOT IN ${viewedPromptIds}`
          : undefined
      )
    )
    .orderBy(sql`RANDOM()`)
    .limit(1);
  
  if (freshPrompt.length) {
    return freshPrompt[0];
  }
  
  // Fallback to least recently viewed
  return getLeastRecentlyViewedPrompt(userId);
}

/**
 * Determines whether to use cache based on cache size and hit rate
 * 
 * @returns Promise resolving to true if cache should be used
 * 
 * @example
 * ```typescript
 * const shouldCache = await shouldUseCache();
 * if (shouldCache) {
 *   const prompt = await getFreshPromptForUser(userId);
 * }
 * ```
 */
export async function shouldUseCache(): Promise<boolean> {
  const cacheCount = await getActivePromptCount();
  if (cacheCount < PROMPT_CACHE_CONFIG.threshold) {
    cacheMisses++;
    return false;
  }
  
  const random = Math.random();
  const shouldUse = random < PROMPT_CACHE_CONFIG.hitRate;
  
  if (shouldUse) {
    cacheHits++;
  } else {
    cacheMisses++;
  }
  
  return shouldUse;
}

/**
 * Validates the quality of a generated prompt
 * 
 * Checks length, structure, and other quality metrics.
 * Returns a score from 0.0 to 1.0.
 * 
 * @param content - Full prompt content to validate
 * @returns Quality score (0.0 - 1.0)
 * 
 * @example
 * ```typescript
 * const score = validatePromptQuality(promptContent);
 * if (score >= 0.7) {
 *   await savePromptToCache(promptContent, score);
 * }
 * ```
 */
export function validatePromptQuality(content: string): number {
  let score = 1.0;
  
  // Length check (100-500 characters)
  if (content.length < 100 || content.length > 500) {
    score -= 0.2;
  }
  
  // Structure check (must contain MC: and Tone:)
  if (!content.includes('MC:') || !content.includes('Tone:')) {
    score -= 0.3;
  }
  
  // Elements check (must contain Elements:)
  if (!content.includes('Elements:')) {
    score -= 0.1;
  }
  
  return Math.max(0, score);
}

/**
 * Calculates expiration date based on quality score
 * 
 * @param qualityScore - Quality score of the prompt (0-1)
 * @returns Expiration date
 * 
 * @example
 * ```typescript
 * const expiresAt = calculateExpiration(0.95);
 * console.log('Expires:', expiresAt);
 * ```
 */
export function calculateExpiration(qualityScore: number): Date {
  const now = new Date();
  let days = PROMPT_CACHE_CONFIG.expiration.default;
  
  if (qualityScore >= 0.9) {
    days = PROMPT_CACHE_CONFIG.expiration.highQuality;
  } else if (qualityScore < 0.7) {
    days = PROMPT_CACHE_CONFIG.expiration.lowQuality;
  }
  
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Saves a prompt to the cache
 * 
 * Stores the full content atomically without parsing, since AI-generated
 * story themes are creative free-form text without definitive structure.
 * 
 * @param content - Full prompt content
 * @param qualityScore - Quality score (optional, will calculate if not provided)
 * @param aiProvider - AI provider used for generation
 * @param aiModel - AI model used for generation
 * @returns Promise resolving to the saved prompt ID
 * 
 * @example
 * ```typescript
 * const promptId = await savePromptToCache(content, 0.95, 'gemini', 'gemini-2.5-flash');
 * console.log('Saved prompt:', promptId);
 * ```
 */
export async function savePromptToCache(
  content: string,
  qualityScore?: number,
  aiProvider?: AIChatProvider,
  aiModel?: string
): Promise<string> {
  const score = qualityScore ?? validatePromptQuality(content);
  
  const result = await dbWrite
    .insert(storyPrompts)
    .values({
      content,
      aiProvider,
      aiModel,
      qualityScore: score,
      expiresAt: calculateExpiration(score),
      isActive: true,
    })
    .returning({ id: storyPrompts.id });
  
  return result[0].id;
}

/**
 * Tracks that a user viewed a prompt
 * 
 * @param userId - User ID
 * @param promptId - Prompt ID
 * @returns Promise resolving when tracking is complete
 * 
 * @example
 * ```typescript
 * await trackPromptView('user123', 'prompt456');
 * ```
 */
export async function trackPromptView(userId: string, promptId: string): Promise<void> {
  try {
    // Run operations in parallel for performance
    await Promise.all([
      // Insert into user prompt history (idempotent via onConflictDoNothing)
      dbWrite
        .insert(userPromptHistory)
        .values({
          userId,
          promptId,
          viewedAt: new Date(),
        })
        .onConflictDoNothing(),
      
      // Increment usage count and unique user count
      dbWrite
        .update(storyPrompts)
        .set({
          usageCount: sql`${storyPrompts.usageCount} + 1`,
          uniqueUserCount: sql`${storyPrompts.uniqueUserCount} + 1`,
          lastServedAt: new Date(),
        })
        .where(eq(storyPrompts.id, promptId)),
    ]);
  } catch (error) {
    console.error('[trackPromptView] ❌ Failed to track prompt view:', error);
  }
}

/**
 * Marks a prompt as used for book creation
 * 
 * @param userId - User ID
 * @param promptId - Prompt ID
 * @param bookId - Book ID that was created
 * @returns Promise resolving when update is complete
 * 
 * @example
 * ```typescript
 * await markPromptUsedForBook('user123', 'prompt456', 'book789');
 * ```
 */
export async function markPromptUsedForBook(
  userId: string,
  promptId: string,
  bookId: string
): Promise<void> {
  try {
    await dbWrite
      .update(userPromptHistory)
      .set({
        usedForBook: true,
        bookId,
      })
      .where(
        and(
          eq(userPromptHistory.userId, userId),
          eq(userPromptHistory.promptId, promptId)
        )
      );
  } catch (error) {
    console.error('[markPromptUsedForBook] ❌ Failed to mark prompt as used:', error);
  }
}

/**
 * Deactivates expired prompts
 * 
 * @returns Promise resolving to the number of deactivated prompts
 * 
 * @example
 * ```typescript
 * const deactivated = await deactivateExpiredPrompts();
 * console.log(`Deactivated ${deactivated} expired prompts`);
 * ```
 */
export async function deactivateExpiredPrompts(): Promise<number> {
  const result = await dbWrite
    .update(storyPrompts)
    .set({ isActive: false })
    .where(
      and(
        eq(storyPrompts.isActive, true),
        sql`${storyPrompts.expiresAt} < NOW()`
      )
    )
    .returning({ id: storyPrompts.id });
  
  return result.length;
}

/**
 * Deactivates low-quality prompts
 * 
 * @returns Promise resolving to the number of deactivated prompts
 * 
 * @example
 * ```typescript
 * const deactivated = await deactivateLowQualityPrompts();
 * console.log(`Deactivated ${deactivated} low-quality prompts`);
 * ```
 */
export async function deactivateLowQualityPrompts(): Promise<number> {
  const result = await dbWrite
    .update(storyPrompts)
    .set({ isActive: false })
    .where(
      and(
        eq(storyPrompts.isActive, true),
        sql`${storyPrompts.qualityScore} < ${PROMPT_CACHE_CONFIG.minQuality}`
      )
    )
    .returning({ id: storyPrompts.id });
  
  return result.length;
}

/**
 * Deactivates over-used prompts
 * 
 * @returns Promise resolving to the number of deactivated prompts
 * 
 * @example
 * ```typescript
 * const deactivated = await deactivateOverusedPrompts();
 * console.log(`Deactivated ${deactivated} overused prompts`);
 * ```
 */
export async function deactivateOverusedPrompts(): Promise<number> {
  const result = await dbWrite
    .update(storyPrompts)
    .set({ isActive: false })
    .where(
      and(
        eq(storyPrompts.isActive, true),
        sql`${storyPrompts.usageCount} >= ${PROMPT_CACHE_CONFIG.maxUsageCount}`
      )
    )
    .returning({ id: storyPrompts.id });
  
  return result.length;
}

/**
 * Selects a prompt by usage-weighted random selection
 * 
 * Prompts with lower usage have higher probability of being selected.
 * 
 * @returns Promise resolving to the selected prompt or null
 * 
 * @example
 * ```typescript
 * const prompt = await selectPromptByUsageWeight();
 * if (prompt) {
 *   console.log('Selected prompt:', prompt.theme);
 * }
 * ```
 */
export async function selectPromptByUsageWeight(): Promise<typeof storyPrompts.$inferSelect | null> {
  const prompts = await dbRead
    .select()
    .from(storyPrompts)
    .where(eq(storyPrompts.isActive, true));
  
  if (!prompts.length) return null;
  
  // Calculate weights (inverse of usage)
  const weights = prompts.map(p => 1 / (p.usageCount + 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  
  // Weighted random selection
  let random = Math.random() * totalWeight;
  for (let i = 0; i < prompts.length; i++) {
    random -= weights[i];
    if (random <= 0) return prompts[i];
  }
  
  return prompts[prompts.length - 1];
}

/**
 * Gets cache hit rate statistics
 * 
 * @returns Cache hit rate statistics
 * 
 * @example
 * ```typescript
 * const stats = getCacheHitRateStats();
 * console.log('Hit rate:', stats.hitRate);
 * ```
 */
export function getCacheHitRateStats() {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? (cacheHits / total) * 100 : 0;
  const elapsedMs = Date.now() - trackingStartTime.getTime();
  const elapsedMinutes = elapsedMs / (1000 * 60);
  
  return {
    cacheHits,
    cacheMisses,
    totalRequests: total,
    hitRate: hitRate.toFixed(2),
    elapsedMinutes: elapsedMinutes.toFixed(2),
    requestsPerMinute: elapsedMinutes > 0 ? (total / elapsedMinutes).toFixed(2) : '0',
  };
}

/**
 * Resets cache hit rate tracking
 * 
 * Useful for testing or periodic reset.
 * 
 * @example
 * ```typescript
 * resetCacheHitRateTracking();
 * ```
 */
export function resetCacheHitRateTracking(): void {
  cacheHits = 0;
  cacheMisses = 0;
  trackingStartTime = new Date();
}
