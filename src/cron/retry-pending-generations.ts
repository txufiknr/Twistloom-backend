/**
 * @summary Comprehensive story page generation and retry job
 * @description Multi-purpose cron job supporting both scheduled batch processing and manual trigger execution
 * 
 * Dual Execution Modes:
 * - Scheduled: Processes pages with pendingGenerationCount > 0 to regenerate failed candidate pages
 * - Manual: Processes specific book/page triggered via GitHub workflow with user attribution
 * 
 * Core Functions:
 * - `retryPendingGenerations()`: Batch processing of pending generations with priority ordering
 * - `processSpecificPage()`: Targeted processing for manual workflow triggers
 * - `processPageGeneration()`: Shared logic for both scheduled and manual processing
 * 
 * Idempotency:
 * - Safe to run multiple times: only processes pages with pending generations or specific manual targets
 * - Atomic operations: updates pendingGenerationCount after successful generation
 * - No side effects: only regenerates missing candidates, doesn't modify existing data
 * - User attribution: Manual triggers include user tracking for audit purposes
 * 
 * Execution Context:
 * - Should be run periodically via cron job (e.g., every hour) for scheduled processing
 * - Manual triggers via GitHub workflow API with environment variables:
 *   - `TRIGGERED_BOOK_ID`: Target book identifier
 *   - `TRIGGERED_PAGE_ID`: Target page identifier  
 *   - `TRIGGERED_BY_USER`: User who initiated the trigger
 * 
 * Performance Features:
 * - Lazy imports for optimal memory usage and startup time
 * - Priority ordering: trending score + pending count optimization
 * - Rate limiting: delays between AI API calls to prevent overwhelming
 * - Distributed locking: prevents concurrent processing of same page
 */
import type { DBPage } from "../types/schema.js";
import type { UserStoryPage } from "../types/story.js";
import { MAX_BRANCHING_PREGENERATION_LIMIT } from "../config/story.js";
import { MAX_GENERATION_DURATION_MS } from "../config/candidate-generation.js";
import { requireEnv } from "../utils/env.js";
import { getErrorMessage } from "../utils/error.js";
import { delay } from "../utils/time.js";

export async function retryPendingGenerations(): Promise<string[]> {
  const startedAt = Date.now();
  const processedPageIds: string[] = [];

  if (MAX_BRANCHING_PREGENERATION_LIMIT > 0) {
    console.log("[retryPendingGenerations] 🔄 Starting retry of pending generations...");
  } else {
    console.log("[retryPendingGenerations] ⏩ Pending generation retry is disabled");
    return [];
  }
  
  try {
    
    // Lazy imports for better memory usage and startup time
    const { dbRead, dbWrite } = await import("../db/client.js");
    const { pages, books, userSessions } = await import("../db/schema.js");
    const { eq, gt, lt, desc, asc, and, sql } = await import("drizzle-orm");
    const { getPageFromDB } = await import("../services/book.js");
    const { mapToUserStoryPage } = await import("../services/book.js");
    
    // Subquery to get the most recent active session for each book
    const mostRecentSession = dbRead
      .select({
        bookId: userSessions.bookId,
        lastActiveAt: sql`MAX(${userSessions.updatedAt})`.as('lastActiveAt')
      })
      .from(userSessions)
      .where(eq(userSessions.status, 'active'))
      .groupBy(userSessions.bookId)
      .as('mostRecentSession');
    
    // Query pages with pending generations (limit to prevent overwhelming system, minimal fields needed)
    const pagesWithPending = await dbRead
      .select({
        id: pages.id,
        pendingGenerationCount: pages.pendingGenerationCount,
        trendingScore: books.trendingScore,
        page: pages.page,
        totalPages: books.totalPages,
        lastActiveAt: mostRecentSession.lastActiveAt,
      })
      .from(pages)
      .innerJoin(books, eq(pages.bookId, books.id))
      .leftJoin(mostRecentSession, eq(books.id, mostRecentSession.bookId))
      .where(and(
        gt(pages.pendingGenerationCount, 0),
        lt(pages.page, books.totalPages) // Exclude last page since it doesn't need candidates
      ))
      .orderBy(
        desc(mostRecentSession.lastActiveAt), // Prioritize books with most recent active session
        desc(books.trendingScore), // Then prioritize books with highest trending scores
        desc(books.readCount), // Then prioritize books with highest read count
        desc(pages.visitCount), // Then prioritize pages with most visits
        asc(pages.page), // Then prioritize pages with smaller page numbers
        asc(pages.pendingGenerationCount), // Then prioritize pages with fewer remaining pending candidate generation
      )
      .limit(MAX_BRANCHING_PREGENERATION_LIMIT); // Process up to N pages per run
    
    if (pagesWithPending.length === 0) {
      console.log("[retryPendingGenerations] ✨ No pending generations to process");
      return [];
    }
    
    console.log(`[retryPendingGenerations] 📋 Found ${pagesWithPending.length} pages with pending generations`);
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    // TODO: is it feasible to make it parallel?
    for (const pageData of pagesWithPending) {
      try {
        console.log(`[retryPendingGenerations] 🔄 Processing page ${pageData.id} (pending: ${pageData.pendingGenerationCount})`);
        
        // Fetch fresh page data using `dbWrite` client
        const dbPage = await getPageFromDB(pageData.id, { client: dbWrite });
        if (!dbPage) {
          console.warn(`[retryPendingGenerations] ⚠️ Page ${pageData.id} not found, skipping`);
          continue;
        }
        
        // Convert null fields to undefined for type compatibility
        const systemUserId = requireEnv('SYSTEM_USER_ID');
        const pageForGeneration = await mapToUserStoryPage(dbPage, systemUserId, []);
        const pendingBefore = pageData.pendingGenerationCount || 0;
        const hasNoPendingActions = pendingBefore === 0;

        // Use shared page generation logic
        const generationResult = await processPageGeneration(
          dbPage,
          pageForGeneration,
          hasNoPendingActions,
          'retryPendingGenerations'
        );

        if (generationResult.successCount > 0) {
          totalSuccess += generationResult.successCount;
          console.log(`[retryPendingGenerations] ✅ Page ${pageData.id}: ${generationResult.successCount} actions regenerated`);
        } else {
          totalFailed += pendingBefore;
          console.log(`[retryPendingGenerations] ⚠️ Page ${pageData.id}: No actions regenerated`);
        }
        
        totalProcessed++;
        processedPageIds.push(pageData.id);
        
        // Small delay between pages to prevent overwhelming AI API
        await delay(500);
        
      } catch (error) {
        console.error(`[retryPendingGenerations] ❌ Failed to process page ${pageData.id}:`, getErrorMessage(error));
        totalFailed++;
        // Continue with next page - don't fail entire batch
      }
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[retryPendingGenerations] ✅ Retry completed in ${durationMs}ms:`, {
      pagesProcessed: totalProcessed,
      actionsRegenerated: totalSuccess,
      actionsStillPending: totalFailed
    });
    return processedPageIds;
  } catch (error) {
    console.error("[retryPendingGenerations] ❌ Retry job failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Processes a specific page for manual trigger
 */
async function processSpecificPage(bookId: string, pageId: string, triggeredBy?: string, maxDepth?: number): Promise<string | null> {
  const startedAt = Date.now();

  try {
    console.log(`[processSpecificPage] 🎯 Processing manual trigger: book=${bookId}, page=${pageId}, user=${triggeredBy}`);

    // Lazy imports for better memory usage and startup time
    const { getPageFromDB } = await import("../services/book.js");
    const { mapToUserStoryPage } = await import("../services/book.js");

    // Fetch full page data
    const dbPage = await getPageFromDB(pageId, { bookIdentifier: bookId });
    if (!dbPage) {
      console.warn(`[processSpecificPage] ⚠️ Page ${pageId} not found, skipping`);
      return null;
    }

    // Convert null fields to undefined for type compatibility
    const systemUserId = requireEnv('SYSTEM_USER_ID');
    const pageForGeneration = await mapToUserStoryPage(dbPage, systemUserId, []);
    const pendingBefore = dbPage.pendingGenerationCount || 0;

    // Force candidate generation for manual trigger (always generate, even if no pending actions)
    const generationResult = await processPageGeneration(
      dbPage,
      pageForGeneration,
      false, // Always generate for manual trigger
      'processSpecificPage',
      maxDepth
    );

    const durationMs = Date.now() - startedAt;

    console.log(`[processSpecificPage] ✅ Manual trigger completed in ${durationMs}ms:`, {
      bookId,
      pageId,
      triggeredBy,
      actionsRegenerated: generationResult.successCount,
      actionsStillPending: generationResult.pendingAfter,
      beforeAfter: `${pendingBefore} → ${generationResult.pendingAfter}`
    });
    return pageId;
  } catch (error) {
    console.error(`[processSpecificPage] ❌ Manual trigger failed for book ${bookId}, page ${pageId}:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Common page generation logic for both scheduled and manual processing
 */
async function processPageGeneration(
  dbPage: DBPage,
  pageForGeneration: UserStoryPage,
  hasNoPendingActions: boolean,
  context: string,
  maxDepth?: number
): Promise<{ updatedPage: UserStoryPage; successCount: number; pendingAfter: number }> {
  const startedAt = Date.now();
  const pageId = pageForGeneration.id;

  try {
    // Dynamic imports for this function scope
    const { ensureCandidatesForPageWithStrategy } = await import("../utils/candidate-generation.js");

    // Count actions without complete destination before regeneration
    const systemUserId = requireEnv('SYSTEM_USER_ID');
    const actionsBefore = dbPage.actions || [];
    const pendingBefore = actionsBefore.filter(action => !action.destination?.pageId).length;

    hasNoPendingActions = hasNoPendingActions || pendingBefore === 0;

    // Early exit: No pending actions, nothing to do
    if (hasNoPendingActions) {
      console.log(`[${context}] ✨ Page ${pageId} has no pending actions, skipping generation`);
      return { updatedPage: pageForGeneration, successCount: 0, pendingAfter: 0 };
    }

    console.log(`[${context}] 🔄 Processing page ${pageId} (pending: ${pendingBefore})`);

    // Force candidate generation for manual trigger or normal processing
    const updatedPage = await ensureCandidatesForPageWithStrategy({
      strategy: 'cron',
      userId: systemUserId,
      page: pageForGeneration,
      options: maxDepth !== undefined ? { maxDepth } : undefined
    });

    // Count actions without complete destination after regeneration
    const actionsAfter = updatedPage.actions || [];
    const pendingAfter = actionsAfter.filter(action => !action.destination?.pageId).length;

    const successCount = pendingBefore - pendingAfter;
    const durationMs = Date.now() - startedAt;

    console.log(`[${context}] ✅ Page ${pageId} processed in ${durationMs}ms:`, {
      actionsRegenerated: successCount,
      actionsStillPending: pendingAfter,
      beforeAfter: `${pendingBefore} → ${pendingAfter}`
    });

    return { updatedPage, successCount, pendingAfter };
  } catch (error) {
    console.error(`[${context}] ❌ Failed to process page ${pageId}:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Cleanup function to reset isGeneratingStartedAt for processed pages
 * 
 * This function resets the isGeneratingStartedAt field to null for specific pages
 * that have been processed, ensuring they are not stuck in a generating state.
 * 
 * @param pageIds - Array of page IDs to reset isGeneratingStartedAt for
 * 
 * Idempotency:
 * - Safe to run multiple times: only updates specified pages
 * - Uses consistent query: WHERE id IN (pageIds)
 * - Atomic operations: single UPDATE statement
 * - No side effects: only resets timestamp, doesn't modify other data
 */
async function cleanupGeneratingStartedAt(pageIds: string[]): Promise<void> {
  const startedAt = Date.now();
  
  try {
    if (pageIds.length === 0) {
      console.log("[cleanupGeneratingStartedAt] ✨ No pages to cleanup");
      return;
    }
    
    console.log(`[cleanupGeneratingStartedAt] 🧹 Starting cleanup of isGeneratingStartedAt for ${pageIds.length} pages...`);
    
    // Lazy imports for better memory usage and startup time
    const { dbWrite } = await import("../db/client.js");
    const { pages } = await import("../db/schema.js");
    const { inArray } = await import("drizzle-orm");
    
    // Reset isGeneratingStartedAt to null for specified pages
    const result = await dbWrite
      .update(pages)
      .set({ isGeneratingStartedAt: null })
      .where(inArray(pages.id, pageIds));
    
    const durationMs = Date.now() - startedAt;
    console.log(`[cleanupGeneratingStartedAt] ✅ Cleanup completed in ${durationMs}ms:`, {
      pagesUpdated: result.rowCount || 0
    });
  } catch (error) {
    console.error("[cleanupGeneratingStartedAt] ❌ Cleanup failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Global cleanup function to reset isGeneratingStartedAt for stuck generations
 * 
 * This function resets the isGeneratingStartedAt field to null for pages
 * that have been stuck in generating state for longer than MAX_GENERATION_DURATION_MS.
 * 
 * Idempotency:
 * - Safe to run multiple times: only updates pages with stuck generations
 * - Uses consistent query: WHERE is_generating_started_at < NOW() - MAX_GENERATION_DURATION_MS
 * - Atomic operations: single UPDATE statement
 * - No side effects: only resets timestamp, doesn't modify other data
 */
async function cleanupStuckGenerations(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[cleanupStuckGenerations] 🧹 Starting global cleanup of stuck generations...");
    
    // Lazy imports for better memory usage and startup time
    const { dbWrite } = await import("../db/client.js");
    const { pages } = await import("../db/schema.js");
    const { and, isNotNull, lt } = await import("drizzle-orm");
    
    // Calculate the cutoff timestamp
    const cutoffTimestamp = new Date(Date.now() - MAX_GENERATION_DURATION_MS);
    
    // Reset isGeneratingStartedAt to null for pages stuck in generating state
    const result = await dbWrite
      .update(pages)
      .set({ isGeneratingStartedAt: null })
      .where(and(
        isNotNull(pages.isGeneratingStartedAt),
        lt(pages.isGeneratingStartedAt, cutoffTimestamp)
      ));
    
    const durationMs = Date.now() - startedAt;
    console.log(`[cleanupStuckGenerations] ✅ Global cleanup completed in ${durationMs}ms:`, {
      pagesUpdated: result.rowCount || 0,
      cutoffTimestamp: cutoffTimestamp.toISOString()
    });
  } catch (error) {
    console.error("[cleanupStuckGenerations] ❌ Global cleanup failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for retry pending generations cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    // Check if this is an on-demand trigger with specific inputs
    const triggeredBookId = process.env.TRIGGERED_BOOK_ID?.trim();
    const triggeredPageId = process.env.TRIGGERED_PAGE_ID?.trim();
    const triggeredByUser = process.env.TRIGGERED_BY_USER?.trim();
    const triggeredMaxDepthStr = process.env.TRIGGERED_MAX_DEPTH?.trim();
    const triggeredMaxDepth = triggeredMaxDepthStr ? parseInt(triggeredMaxDepthStr, 10) : undefined;
    
    let processedPageIds: string[] = [];
    
    if (triggeredBookId && triggeredPageId) {
      console.log(`[retry-pending-generations] 🎯 On-demand trigger detected`);
      const processedPageId = await processSpecificPage(triggeredBookId, triggeredPageId, triggeredByUser, triggeredMaxDepth);
      if (processedPageId) processedPageIds.push(processedPageId);
    } else {
      console.log(`[retry-pending-generations] 🔄 Scheduled batch processing`);
      processedPageIds = await retryPendingGenerations();
    }
    
    // Cleanup: Reset isGeneratingStartedAt to null for processed pages only
    await cleanupGeneratingStartedAt(processedPageIds);
    
    // Global cleanup: Reset isGeneratingStartedAt for stuck generations
    await cleanupStuckGenerations();
    
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
  console.error("[retry-pending-generations] 💥 Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[retry-pending-generations] 💥 Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
