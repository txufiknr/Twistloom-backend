/**
 * @overview Weekly Prompt Generation Cron Job
 * 
 * Generates new story prompts weekly to maintain cache freshness.
 * Runs according to PROMPT_GENERATION_CRON schedule (default: Sunday 2:00 AM UTC).
 */

import { generateBookCreationPrompt } from "../utils/prompt.js";
import { requireEnv } from "../utils/env.js";
import { getActivePromptCount, savePromptToCache, deactivateExpiredPrompts, deactivateLowQualityPrompts } from "../services/prompt-cache.js";
import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";
import { getErrorMessage } from "../utils/error.js";
import type { AIResponse } from "../types/ai-chat.js";

// /**
//  * Converts a readable stream to a string
//  * 
//  * @param stream - ReadableStream to convert
//  * @returns Promise resolving to the string content
//  */
// async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
//   const chunks: Uint8Array[] = [];
//   const reader = stream.getReader();
  
//   while (true) {
//     const { done, value } = await reader.read();
//     if (done) break;
//     chunks.push(value);
//   }
  
//   return Buffer.concat(chunks).toString('utf-8');
// }

/**
 * Cron job: Generate new story prompts weekly
 * 
 * Process:
 * 1. Check current cache size
 * 2. If below target, generate new prompts via AI
 * 3. Validate and save high-quality prompts
 * 4. Retire expired or low-quality prompts
 * 5. Update cache statistics
 */
export async function generateWeeklyPrompts() {
  console.log('[generateWeeklyPrompts] Starting weekly prompt generation');
  
  try {
    // Step 1: Check cache size
    const activeCount = await getActivePromptCount();
    const targetSize = PROMPT_CACHE_CONFIG.targetSize;
    
    if (activeCount >= targetSize) {
      console.log(`[generateWeeklyPrompts] 🍪 Cache size sufficient (${activeCount}/${targetSize}), skipping generation`);
      return;
    }
    
    // Step 2: Calculate how many to generate
    const toGenerate = Math.min(PROMPT_CACHE_CONFIG.batchSize, targetSize - activeCount);
    
    // Step 3: Generate prompts via AI
    console.log(`[generateWeeklyPrompts] 💭 Generating ${toGenerate} new story theme prompts (current: ${activeCount}, target: ${targetSize})`);
    const generatedPrompts: AIResponse<string>[] = [];
    const userId = requireEnv('SYSTEM_USER_ID');

    for (let i = 0; i < toGenerate; i++) {
      try {
        console.log(`[generateWeeklyPrompts] ✒️ Generating prompt ${i + 1}/${toGenerate}`);
        const response = await generateBookCreationPrompt({ logPrompts: true, language: 'en', userId });
        if (response.output) {
          generatedPrompts.push(response);
          console.log(`[generateWeeklyPrompts] ✅ Generated prompt ${i + 1}/${toGenerate}`);
        } else {
          console.log(`[generateWeeklyPrompts] ⚠️ Generated prompt ${i + 1}/${toGenerate} has no content`);
        }
      } catch (error) {
        console.error(`[generateWeeklyPrompts] ❌ Failed to generate prompt ${i + 1}/${toGenerate}:`, error);
      }
    }
    
    // Step 4: Validate and save
    let savedCount = 0;
    for (const response of generatedPrompts) {
      const { output: content, provider: aiProvider, model: aiModel } = response;
      const promptId = await savePromptToCache({
        content,
        userId,
        aiProvider,
        aiModel,
        language: 'en'
      });
      if (promptId) savedCount++;
    }
    
    console.log(`[generateWeeklyPrompts] ✅ Saved ${savedCount}/${generatedPrompts.length} prompts`);
    
    // Step 5: Retire old prompts
    const expiredCount = await deactivateExpiredPrompts();
    if (expiredCount > 0) {
      console.log(`[generateWeeklyPrompts] 🗑️ Deactivated ${expiredCount} expired prompts`);
    }
    
    const lowQualityCount = await deactivateLowQualityPrompts();
    if (lowQualityCount > 0) {
      console.log(`[generateWeeklyPrompts] 🗑️ Deactivated ${lowQualityCount} low-quality prompts`);
    }
    
    // Step 6: Update statistics
    const finalCount = await getActivePromptCount();
    console.log(`[generateWeeklyPrompts] ✅ Generation complete! Active prompts: ${finalCount} (added: ${savedCount})`);
    
  } catch (error) {
    console.error('[generateWeeklyPrompts] ❌ Failed to generate prompts:', error);
    throw error;
  }
}

/**
 * Main execution function for on-demand book creation cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await generateWeeklyPrompts();
    const durationMs = Date.now() - startedAt;
    console.log(`[weekly-prompt] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error('[weekly-prompt] ❌ Fatal error:', error);
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[weekly-prompt] 💥 Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[weekly-prompt] 💥 Uncaught exception:', error);
  process.exit(1);
});

void main();
