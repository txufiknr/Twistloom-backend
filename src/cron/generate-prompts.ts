/**
 * @overview Weekly Prompt Generation Cron Job
 * 
 * Generates new story prompts weekly to maintain cache freshness.
 * Runs according to PROMPT_GENERATION_CRON schedule (default: Sunday 2:00 AM UTC).
 */

import { generateBookCreationPromptStream } from "../utils/prompt.js";
import { getActivePromptCount, savePromptToCache, validatePromptQuality, deactivateExpiredPrompts, deactivateLowQualityPrompts } from "../services/prompt-cache.js";
import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";

/**
 * Converts a readable stream to a string
 * 
 * @param stream - ReadableStream to convert
 * @returns Promise resolving to the string content
 */
async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  return Buffer.concat(chunks).toString('utf-8');
}

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
      console.log(`[generateWeeklyPrompts] Cache size sufficient (${activeCount}/${targetSize}), skipping generation`);
      return;
    }
    
    // Step 2: Calculate how many to generate
    const toGenerate = Math.min(
      PROMPT_CACHE_CONFIG.batchSize,
      targetSize - activeCount
    );
    
    console.log(`[generateWeeklyPrompts] Generating ${toGenerate} new prompts (current: ${activeCount}, target: ${targetSize})`);
    
    // Step 3: Generate prompts via AI
    const generatedPrompts: string[] = [];
    for (let i = 0; i < toGenerate; i++) {
      try {
        console.log(`[generateWeeklyPrompts] Generating prompt ${i + 1}/${toGenerate}`);
        const stream = await generateBookCreationPromptStream({ logPrompts: true });
        const content = await streamToString(stream);
        generatedPrompts.push(content);
        console.log(`[generateWeeklyPrompts] ✅ Generated prompt ${i + 1}/${toGenerate}`);
      } catch (error) {
        console.error(`[generateWeeklyPrompts] ❌ Failed to generate prompt ${i + 1}/${toGenerate}:`, error);
      }
    }
    
    // Step 4: Validate and save
    let savedCount = 0;
    for (const content of generatedPrompts) {
      const qualityScore = validatePromptQuality(content);
      
      if (qualityScore >= PROMPT_CACHE_CONFIG.minQuality) {
        try {
          await savePromptToCache(content, qualityScore);
          savedCount++;
          console.log(`[generateWeeklyPrompts] ✅ Saved prompt with score ${qualityScore.toFixed(2)}`);
        } catch (error) {
          console.error('[generateWeeklyPrompts] ❌ Failed to save prompt to cache:', error);
        }
      } else {
        console.log(`[generateWeeklyPrompts] ⚠️ Skipped prompt with low score ${qualityScore.toFixed(2)}`);
      }
    }
    
    console.log(`[generateWeeklyPrompts] Saved ${savedCount}/${generatedPrompts.length} prompts`);
    
    // Step 5: Retire old prompts
    const expiredCount = await deactivateExpiredPrompts();
    if (expiredCount > 0) {
      console.log(`[generateWeeklyPrompts] Deactivated ${expiredCount} expired prompts`);
    }
    
    const lowQualityCount = await deactivateLowQualityPrompts();
    if (lowQualityCount > 0) {
      console.log(`[generateWeeklyPrompts] Deactivated ${lowQualityCount} low-quality prompts`);
    }
    
    // Step 6: Update statistics
    const finalCount = await getActivePromptCount();
    console.log(`[generateWeeklyPrompts] ✅ Complete. Active prompts: ${finalCount} (added: ${savedCount})`);
    
  } catch (error) {
    console.error('[generateWeeklyPrompts] ❌ Error:', error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  generateWeeklyPrompts()
    .then(() => {
      console.log('[generateWeeklyPrompts] ✅ Job completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[generateWeeklyPrompts] ❌ Job failed:', error);
      process.exit(1);
    });
}
