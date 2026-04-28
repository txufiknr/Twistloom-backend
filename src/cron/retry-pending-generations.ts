/**
 * @summary Runs retry job for failed page pre-generations
 * @description Processes pages with pendingGenerationCount > 0 to regenerate failed candidate pages
 * 
 * Idempotency:
 * - Safe to run multiple times: only processes pages with pending generations
 * - Uses consistent query: WHERE pending_generation_count > 0
 * - Atomic operations: updates pendingGenerationCount after successful generation
 * - No side effects: only regenerates missing candidates, doesn't modify existing data
 * 
 * Should be run periodically via cron job (e.g., every 15 minutes), but safe to run repeatedly
 */
import { mapToUserStoryPage } from "../services/book.js";
import { getErrorMessage } from "../utils/error.js";

export async function retryPendingGenerations(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[retry-pending-generations] 🔄 Starting retry of pending generations...");
    
    // Lazy imports for better memory usage and startup time
    const { dbRead, dbWrite } = await import("../db/client.js");
    const { pages } = await import("../db/schema.js");
    const { eq, gt, desc } = await import("drizzle-orm");
    const { ensureCandidatesForPage } = await import("../utils/prompt.js");
    const { getPageFromDB } = await import("../services/book.js");
    
    // Query pages with pending generations (limit to prevent overwhelming the system)
    // Note: Fetch userId and pendingGenerationCount (minimal fields needed)
    // TODO: prioritize most trending books
    const pagesWithPending = await dbRead
      .select({
        id: pages.id,
        userId: pages.userId,
        pendingGenerationCount: pages.pendingGenerationCount,
      })
      .from(pages)
      .where(gt(pages.pendingGenerationCount, 0))
      .orderBy(desc(pages.pendingGenerationCount))
      .limit(50); // Process up to 50 pages per run
    
    if (pagesWithPending.length === 0) {
      console.log("[retry-pending-generations] ✨ No pending generations to process");
      return;
    }
    
    console.log(`[retry-pending-generations] 📋 Found ${pagesWithPending.length} pages with pending generations`);
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    for (const pageData of pagesWithPending) {
      try {
        console.log(`[retry-pending-generations] 🔄 Processing page ${pageData.id} (pending: ${pageData.pendingGenerationCount})`);
        
        // Fetch full page data
        const fullPage = await getPageFromDB(pageData.id);
        if (!fullPage) {
          console.warn(`[retry-pending-generations] ⚠️ Page ${pageData.id} not found, skipping`);
          continue;
        }
        
        // Convert null fields to undefined for type compatibility
        const pageForGeneration = mapToUserStoryPage(fullPage);
        
        // Count actions without complete destination before regeneration
        const actionsBefore = fullPage.actions || [];
        const pendingBefore = actionsBefore.filter((action: any) => 
          !action.destination?.branchId || !action.destination?.pageId
        ).length;
        
        if (pendingBefore === 0) {
          console.log(`[retry-pending-generations] ✅ Page ${pageData.id} has no pending actions, resetting counter`);
          await dbWrite
            .update(pages)
            .set({ pendingGenerationCount: 0 })
            .where(eq(pages.id, pageData.id));
          continue;
        }
        
        // Retry candidate generation (fire-and-forget pattern)
        await ensureCandidatesForPage(pageData.userId, pageForGeneration);
        
        // Fetch updated page to check if generation succeeded
        const updatedPage = await getPageFromDB(pageData.id);
        if (!updatedPage) {
          console.warn(`[retry-pending-generations] ⚠️ Page ${pageData.id} not found after regeneration, skipping`);
          continue;
        }
        
        // Count actions without complete destination after regeneration
        const actionsAfter = updatedPage.actions || [];
        const pendingAfter = actionsAfter.filter((action: any) => 
          !action.destination?.branchId || !action.destination?.pageId
        ).length;
        
        // Update pendingGenerationCount
        await dbWrite
          .update(pages)
          .set({ pendingGenerationCount: pendingAfter })
          .where(eq(pages.id, pageData.id));
        
        const successCount = pendingBefore - pendingAfter;
        if (successCount > 0) {
          totalSuccess += successCount;
          console.log(`[retry-pending-generations] ✅ Page ${pageData.id}: ${successCount} actions regenerated (${pendingBefore} → ${pendingAfter} pending)`);
        } else {
          totalFailed += pendingAfter;
          console.log(`[retry-pending-generations] ⚠️ Page ${pageData.id}: No actions regenerated (${pendingAfter} still pending)`);
        }
        
        totalProcessed++;
        
        // Small delay between pages to prevent overwhelming AI API
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`[retry-pending-generations] ❌ Failed to process page ${pageData.id}:`, getErrorMessage(error));
        totalFailed++;
        // Continue with next page - don't fail entire batch
      }
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[retry-pending-generations] ✅ Retry completed in ${durationMs}ms:`, {
      pagesProcessed: totalProcessed,
      actionsRegenerated: totalSuccess,
      actionsStillPending: totalFailed
    });
  } catch (error) {
    console.error("[retry-pending-generations] ❌ Retry job failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for retry pending generations cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    await retryPendingGenerations();
    const durationMs = Date.now() - startedAt;
    console.log(`[retry-pending-generations] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[retry-pending-generations] ❌ Retry job failed:", getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[retry-pending-generations] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[retry-pending-generations] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
