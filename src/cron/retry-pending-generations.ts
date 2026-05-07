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
import { requireEnv } from "../utils/env.js";
import { getErrorMessage } from "../utils/error.js";
import { delay } from "../utils/time.js";

export async function retryPendingGenerations(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[retry-pending-generations] 🔄 Starting retry of pending generations...");
    
    // Lazy imports for better memory usage and startup time
    const { dbRead, dbWrite } = await import("../db/client.js");
    const { pages, books } = await import("../db/schema.js");
    const { eq, gt, lt, desc, and } = await import("drizzle-orm");
    const { ensureCandidatesForPage } = await import("../utils/prompt.js");
    const { getPageFromDB } = await import("../services/book.js");
    
    // Query pages with pending generations (limit to prevent overwhelming system)
    // Note: Fetch userId and pendingGenerationCount (minimal fields needed)
    // Prioritize books with highest trending scores
    // Exclude last page (page.number < totalPages) since it doesn't need candidates
    const pagesWithPending = await dbRead
      .select({
        id: pages.id,
        userId: pages.userId,
        pendingGenerationCount: pages.pendingGenerationCount,
        trendingScore: books.trendingScore,
        page: pages.page,
        totalPages: books.totalPages,
      })
      .from(pages)
      .innerJoin(books, eq(pages.bookId, books.id))
      .where(and(
        gt(pages.pendingGenerationCount, 0),
        lt(pages.page, books.totalPages) // Exclude last page
      ))
      .orderBy(desc(books.trendingScore), desc(pages.pendingGenerationCount))
      .limit(50); // Process up to 50 pages per run
    
    if (pagesWithPending.length === 0) {
      console.log("[retry-pending-generations] ✨ No pending generations to process");
      return;
    }
    
    console.log(`[retry-pending-generations] 📋 Found ${pagesWithPending.length} pages with pending generations`);
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    // TODO: make it parallel
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
        const systemUserId = requireEnv('SYSTEM_USER_ID');
        const pageForGeneration = await mapToUserStoryPage(fullPage, systemUserId, []);
        
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
        
        // Retry candidate generation
        await ensureCandidatesForPage(systemUserId, pageForGeneration);
        
        // Fetch updated page to check if generation succeeded
        const updatedPage = await getPageFromDB(pageData.id, { client: dbWrite });
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
        await delay(500);
        
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
    console.log("[retry-pending-generations] Starting missing cover image generation...");
    
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
      console.log("[retry-pending-generations] ⏩ No original books missing cover images");
      return;
    }
    
    console.log(`[retry-pending-generations] 👀 Found ${originalBooksWithoutCovers.length} original books missing cover images`);
    
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    for (const book of originalBooksWithoutCovers) {
      try {
        console.log(`[retry-pending-generations] 🧠 Generating cover for book "${book.title}" (ID: ${book.id})`);
        
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
        
        totalSuccess++;
        console.log(`[retry-pending-generations] ✅ Successfully generated cover for book "${book.title}"`);
        
        totalProcessed++;
        
        // Small delay between books to prevent overwhelming AI API
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`[retry-pending-generations] ❌ Failed to generate cover for book ${book.id}:`, getErrorMessage(error));
        totalFailed++;
        // Continue with next book - don't fail entire batch
      }
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[retry-pending-generations] ✅ Missing cover generation completed in ${durationMs}ms:`, {
      booksProcessed: totalProcessed,
      coversGenerated: totalSuccess,
      coversFailed: totalFailed
    });
  } catch (error) {
    console.error("[retry-pending-generations] ❌ Missing cover generation job failed:", getErrorMessage(error));
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
    await generateMissingOriginalBookCovers();
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
