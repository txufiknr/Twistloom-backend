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
 * - `generateMissingOriginalBookCovers()`: Generates AI cover images for books without covers
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
import type { Action, UserStoryPage } from "../types/story.js";
import { MAX_BRANCHING_PREGENERATION_LIMIT } from "../config/story.js";
import { requireEnv } from "../utils/env.js";
import { getErrorMessage } from "../utils/error.js";
import { delay } from "../utils/time.js";

export async function retryPendingGenerations(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[retryPendingGenerations] 🔄 Starting retry of pending generations...");
    
    // Lazy imports for better memory usage and startup time
    const { dbRead, dbWrite } = await import("../db/client.js");
    const { pages, books } = await import("../db/schema.js");
    const { eq, gt, lt, desc, asc, and } = await import("drizzle-orm");
    const { getPageFromDB } = await import("../services/book.js");
    const { mapToUserStoryPage } = await import("../services/book.js");
    
    // Query pages with pending generations (limit to prevent overwhelming system, minimal fields needed)
    const pagesWithPending = await dbRead
      .select({
        id: pages.id,
        pendingGenerationCount: pages.pendingGenerationCount,
        trendingScore: books.trendingScore,
        page: pages.page,
        totalPages: books.totalPages,
      })
      .from(pages)
      .innerJoin(books, eq(pages.bookId, books.id))
      .where(and(
        gt(pages.pendingGenerationCount, 0),
        lt(pages.page, books.totalPages) // Exclude last page since it doesn't need candidates
      ))
      .orderBy(
        desc(books.trendingScore), // Prioritize books with highest trending scores
        asc(pages.pendingGenerationCount) // Prioritize pages with fewer remaining pending candidate generation
        // TODO:
        // - prioritize branch with smallest furthest generated pages against books.totalPages
        // - prioritize book with most recent active session
      )
      .limit(MAX_BRANCHING_PREGENERATION_LIMIT); // Process up to N pages per run
    
    if (pagesWithPending.length === 0) {
      console.log("[retryPendingGenerations] ✨ No pending generations to process");
      return;
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
        const pendingGenerationCount = pageData.pendingGenerationCount || 0;
        const hasNoPendingActions = pendingGenerationCount === 0;
        
        // Use shared page generation logic
        const generationResult = await processPageGeneration(
          dbPage,
          pageForGeneration,
          hasNoPendingActions,
          '[retryPendingGenerations]'
        );
        
        const successCount = pendingGenerationCount - (generationResult.updatedPage.actions?.filter((action: Action) => 
          !action.destination?.pageId
        ).length || 0);
        
        if (successCount > 0) {
          totalSuccess += successCount;
          console.log(`[retryPendingGenerations] ✅ Page ${pageData.id}: ${successCount} actions regenerated`);
        } else {
          totalFailed += pendingGenerationCount;
          console.log(`[retryPendingGenerations] ⚠️ Page ${pageData.id}: No actions regenerated`);
        }
        
        totalProcessed++;
        
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
  } catch (error) {
    console.error("[retryPendingGenerations] ❌ Retry job failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Detects and generates missing cover images for original books
 * 
 * This function:
 * - Finds books where isOriginal: true and image: null
 * - Generates AI cover images for these books
 * - Updates books with new image URLs and IDs
 * 
 * Idempotency:
 * - Safe to run multiple times: only processes books without images
 * - Uses consistent query: WHERE is_original = true AND image IS NULL
 * - Atomic operations: updates book record after successful image generation
 * - No side effects: only adds missing images, doesn't modify existing data
 * 
 * Should be run periodically via cron job, but safe to run repeatedly
 */
export async function generateMissingOriginalBookCovers(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[generateMissingOriginalBookCovers] Starting missing cover image generation...");
    
    // Lazy imports for better memory usage and startup time
    const { dbRead } = await import("../db/client.js");
    const { books } = await import("../db/schema.js");
    const { eq, and, isNull, desc, asc } = await import("drizzle-orm");
    const { generateAndUpdateBookCoverImage } = await import("../services/book.js");
    
    // Query original books without cover images (limit to prevent overwhelming the system)
    // Prioritize books with lowest branchesCount, then by highest trendingScore
    const originalBooksWithoutCovers = await dbRead
      .select({
        id: books.id,
        title: books.title,
        hook: books.hook,
        summary: books.summary,
        trendingScore: books.trendingScore,
        userId: books.userId,
        image: books.image,
        imageId: books.imageId,
        isOriginal: books.isOriginal,
        keywords: books.keywords,
        totalPages: books.totalPages,
        language: books.language,
        slug: books.slug,
        status: books.status,
        mc: books.mc,
        likesCount: books.likesCount,
        readCount: books.readCount,
        branchesCount: books.branchesCount,
        topPick: books.topPick,
        createdAt: books.createdAt,
        updatedAt: books.updatedAt,
      })
      .from(books)
      .where(and(eq(books.isOriginal, true), isNull(books.image)))
      .orderBy(asc(books.branchesCount), desc(books.trendingScore))
      .limit(25); // Process up to 25 books per run
    
    if (originalBooksWithoutCovers.length === 0) {
      console.log("[generateMissingOriginalBookCovers] ⏩ No original books missing cover images");
      return;
    }
    
    console.log(`[generateMissingOriginalBookCovers] 👀 Found ${originalBooksWithoutCovers.length} original books missing cover images`);
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    for (const book of originalBooksWithoutCovers) {
      try {
        console.log(`[generateMissingOriginalBookCovers] 🧠 Generating cover for book "${book.title}" (ID: ${book.id})`);
        
        // Convert database result to Book type (convert null to undefined where needed)
        const bookForGeneration = {
          ...book,
          slug: book.slug || undefined,
          hook: book.hook || '',
          summary: book.summary || '',
          language: book.language || 'en',
          trendingScore: book.trendingScore || 0,
          image: book.image || undefined,
          imageId: book.imageId || undefined,
          status: book.status || 'active',
          topPick: book.topPick || undefined,
        };
        
        // Generate and update cover image
        await generateAndUpdateBookCoverImage(bookForGeneration);
        console.log(`[generateMissingOriginalBookCovers] ✅ Successfully generated cover for book "${book.title}"`);
        totalSuccess++;
        totalProcessed++;
        
        // Small delay between books to prevent overwhelming AI API
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`[generateMissingOriginalBookCovers] ❌ Failed to generate cover for book ${book.id}:`, getErrorMessage(error));
        totalFailed++;
        // Continue with next book - don't fail entire batch
      }
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[generateMissingOriginalBookCovers] ✅ Missing cover generation completed in ${durationMs}ms:`, {
      booksProcessed: totalProcessed,
      coversGenerated: totalSuccess,
      coversFailed: totalFailed
    });
  } catch (error) {
    console.error("[generateMissingOriginalBookCovers] ❌ Missing cover generation job failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Processes a specific page for manual trigger
 */
async function processSpecificPage(bookId: string, pageId: string, triggeredBy: string): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log(`[processSpecificPage] 🎯 Processing manual trigger: book=${bookId}, page=${pageId}, user=${triggeredBy}`);
    
    // Lazy imports for better memory usage and startup time
    const { dbWrite } = await import("../db/client.js");
    const { pages } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { getPageFromDB } = await import("../services/book.js");
    const { mapToUserStoryPage } = await import("../services/book.js");

    // Fetch full page data
    const dbPage = await getPageFromDB(pageId, { bookIdentifier: bookId });
    if (!dbPage) {
      console.warn(`[processSpecificPage] ⚠️ Page ${pageId} not found, skipping`);
      return;
    }
    
    console.log(`[processSpecificPage] 📋 Found page ${pageId} (pending: ${dbPage.pendingGenerationCount})`);
    
    // Convert null fields to undefined for type compatibility
    const systemUserId = requireEnv('SYSTEM_USER_ID');
    const pageForGeneration = await mapToUserStoryPage(dbPage, systemUserId, []);
    
    // Force candidate generation for manual trigger (always generate, even if no pending actions)
    const generationResult = await processPageGeneration(
      dbPage, 
      pageForGeneration, 
      false, // Always generate for manual trigger
      '[processSpecificPage]'
    );
    
    const actionsAfter = generationResult.updatedPage.actions || [];
    const pendingAfter = actionsAfter.filter((action: Action) => 
      !action.destination?.pageId
    ).length;
    
    // Update pendingGenerationCount
    await dbWrite
      .update(pages)
        .set({ pendingGenerationCount: pendingAfter })
        .where(eq(pages.id, pageId));
    
    const successCount = (dbPage.pendingGenerationCount || 0) - pendingAfter;
    const durationMs = Date.now() - startedAt;
    
    console.log(`[processSpecificPage] ✅ Manual trigger completed in ${durationMs}ms:`, {
      bookId,
      pageId,
      triggeredBy,
      actionsRegenerated: successCount,
      actionsStillPending: pendingAfter,
      beforeAfter: `${(dbPage.pendingGenerationCount || 0)} → ${pendingAfter}`
    });
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
  logPrefix: string
): Promise<{ updatedPage: UserStoryPage }> {
  const startedAt = Date.now();
  const pageId = pageForGeneration.id;
  
  try {
    // Dynamic imports for this function scope
    const { dbWrite } = await import("../db/client.js");
    const { pages } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { ensureCandidatesForPageWithStrategy } = await import("../utils/candidate-generation.js");
    const { mapToUserStoryPage } = await import("../services/book.js");

    const systemUserId = requireEnv('SYSTEM_USER_ID');
    
    // Early exit: No pending actions, nothing to do
    if (hasNoPendingActions) {
      console.log(`[${logPrefix}] ✨ Page ${pageId} has no pending actions, skipping generation`);
      await dbWrite
        .update(pages)
          .set({ pendingGenerationCount: 0 })
          .where(eq(pages.id, pageId));
      return { updatedPage: await mapToUserStoryPage(dbPage, systemUserId, []) };
    }
    
    // Count actions without complete destination before regeneration
    const actionsBefore = dbPage.actions || [];
    const pendingBefore = actionsBefore.filter(action => !action.destination?.pageId).length;
    
    console.log(`[${logPrefix}] 🔄 Processing page ${pageId} (pending: ${pendingBefore})`);
    
    // Force candidate generation for manual trigger or normal processing
    const updatedPage = await ensureCandidatesForPageWithStrategy({
      strategy: 'cron',
      userId: systemUserId,
      page: pageForGeneration,
    });
    
    // Count actions without complete destination after regeneration
    const actionsAfter = updatedPage.actions || [];
    const pendingAfter = actionsAfter.filter((action: Action) => 
      !action.destination?.pageId
    ).length;
    
    // Update pendingGenerationCount
    await dbWrite
      .update(pages)
        .set({ pendingGenerationCount: pendingAfter })
        .where(eq(pages.id, pageId));
    
    const successCount = pendingBefore - pendingAfter;
    const durationMs = Date.now() - startedAt;
    
    console.log(`[${logPrefix}] ✅ Page ${pageId} processed in ${durationMs}ms:`, {
      actionsRegenerated: successCount,
      actionsStillPending: pendingAfter,
      beforeAfter: `${pendingBefore} → ${pendingAfter}`
    });
    
    return { updatedPage };
  } catch (error) {
    console.error(`[${logPrefix}] ❌ Failed to process page ${pageId}:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for retry pending generations cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    // Check if this is a manual trigger with specific inputs
    const triggeredBookId = process.env.TRIGGERED_BOOK_ID?.trim();
    const triggeredPageId = process.env.TRIGGERED_PAGE_ID?.trim();
    const triggeredByUser = process.env.TRIGGERED_BY_USER?.trim();
    
    if (triggeredBookId && triggeredPageId) {
      console.log(`[retry-pending-generations] 🎯 Manual trigger detected`);
      await processSpecificPage(triggeredBookId, triggeredPageId, triggeredByUser || 'unknown');
    } else {
      console.log(`[retry-pending-generations] 🔄 Scheduled batch processing`);
      await retryPendingGenerations();
      await generateMissingOriginalBookCovers();
    }
    
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
