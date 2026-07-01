/**
 * On-Demand Book Creation Cron Job
 * 
 * Triggered by GitHub Actions workflow to create a book asynchronously.
 * This script runs in GitHub Actions environment with all necessary credentials.
 * 
 * Environment Variables:
 * - BOOK_ID: UUID v7 of the book to create (optional for hourly routine)
 * 
 * Core Functions:
 * - `processBookGeneration()`: Processing on-demand book generation by given BOOK_ID
 * - `processHourlyRoutine()`: Batch processing of pending book generations with oldest-first priority
 * - `generateMissingOriginalBookCovers()`: Generates AI cover images for books without covers
 * 
 * Two Modes of Operation:
 * 
 * 1. On-Demand Mode (BOOK_ID provided):
 *    - Processes a specific book by ID
 *    - Used when user triggers generation or retries a specific book
 * 
 * 2. Hourly Routine Mode (BOOK_ID not provided):
 *    - Finds and processes pending/failed books
 *    - Uses locking mechanism to prevent duplicate processing per-book
 *    - Processes oldest books first, limited to HOURLY_RETRY_BATCH_SIZE per run
 *    - Lock timeout: 30 minutes (stale generations are retried)
 * 
 * Locking Mechanism:
 * - Uses `isGeneratingStartedAt` timestamp to track active processing
 * - Sets timestamp when starting generation
 * - Checks for stale locks (>30 minutes) before processing
 * - Prevents multiple cron jobs from processing the same book simultaneously
 * 
 * Lock Clearing Patterns:
 * - `processBookGeneration()`: Clears lock on success/error (direct processing)
 * - `processHourlyRoutine()`: Clears lock on workflow trigger failure (workflow dispatch only)
 * - The cron job that runs the actual generation clears the lock when complete
 * - Stale locks (>30 minutes) are automatically retried by subsequent runs
 */

import { initializeBook } from '../utils/prompt.js';
import { getErrorMessage } from '../utils/error.js';
import { bookGenerations } from '../db/schema.js';
import { dbRead, dbWrite } from '../db/client.js';
import { eq, and, or, lt, isNull } from 'drizzle-orm';
import { updateBookGenerationStatus, triggerBookGenerationWorkflow } from '../services/book-creation.js';
import { MAX_GENERATION_DURATION_MS, HOURLY_RETRY_BATCH_SIZE, MAX_PENDING_BOOK_COVER_PER_RUN } from '../config/book-creation.js';
import { mapBookFromDb } from '../services/book.js';
import type { InitializeBookParams } from '../types/book.js';

/**
 * Processes a single book generation
 * 
 * @param bookId - Book ID to process
 * @returns Promise resolving when generation completes
 */
async function processBookGeneration(bookId: string): Promise<void> {
  console.log('[book-creation] 💭 Prepare to write the book:', bookId);

  const setLockTimestamp = async (isGeneratingStartedAt: Date | null) => {
    await dbWrite
      .update(bookGenerations)
      .set({ isGeneratingStartedAt })
      .where(eq(bookGenerations.bookId, bookId));
  };

  try {
    // Check existing lock state BEFORE setting to prevent race condition
    const [existingLock] = await dbRead
      .select({ isGeneratingStartedAt: bookGenerations.isGeneratingStartedAt })
      .from(bookGenerations)
      .where(eq(bookGenerations.bookId, bookId))
      .limit(1);

    if (!existingLock) {
      throw new Error(`Book generation record not found for bookId: ${bookId}`);
    }

    // Check if lock was already set by another process (race condition)
    if (existingLock.isGeneratingStartedAt) {
      const existingLockTime = new Date(existingLock.isGeneratingStartedAt).getTime();
      const now = Date.now();
      const lockAge = now - existingLockTime;
      
      // If lock is recent (< 1 minute), another process is handling it
      if (lockAge < 60000) {
        console.log(`[book-creation] ⏸️ Book ${bookId} is already being processed (lock age: ${lockAge}ms), skipping`);
        return;
      }
      
      // Lock is stale, proceed with processing
      console.log(`[book-creation] 🔄 Book ${bookId} has stale lock (age: ${lockAge}ms), proceeding with processing`);
    }

    // Set lock timestamp to prevent duplicate processing
    await setLockTimestamp(new Date());

    // Fetch book generation data from database
    const [generationData] = await dbRead
      .select({
        userId: bookGenerations.userId,
        theme: bookGenerations.theme,
        mcCandidate: bookGenerations.mcCandidate,
        generateCoverImage: bookGenerations.generateCoverImage,
        language: bookGenerations.language,
        titleIdea: bookGenerations.titleIdea,
        aiComment: bookGenerations.aiComment,
      })
      .from(bookGenerations)
      .where(eq(bookGenerations.bookId, bookId))
      .limit(1);

    if (!generationData) {
      throw new Error(`Book generation record not found for bookId: ${bookId}`);
    }

    const { userId, theme } = generationData;
    if (!userId || !theme) {
      throw new Error(`Missing required fields in bookGenerations: userId=${userId}, theme=${theme}`);
    }

    const params: InitializeBookParams = {
      ...generationData,
      language: generationData.language || 'en',
      titleIdea: generationData.titleIdea || undefined,
      mcCandidate: generationData.mcCandidate || undefined,
      bookId, // IMPORTANT: Pass bookId to update existing draft
      theme
    };

    console.log('[book-creation] ✒️ Writing the book...', params);

    // Update book generation step to 'initializing'
    void updateBookGenerationStatus({ bookId, step: 'book_initialization' });

    // Initialize book (this is the long-running AI generation)
    // Pass bookId to update existing draft instead of creating duplicate
    const result = await initializeBook(params);

    console.log('[book-creation] 📔 Book initialized successfully:', result);

    // Update book generation status (content already updated by initializeBook)
    void updateBookGenerationStatus({ bookId, step: 'complete', aiFinalComment: result.aiFinalComment });

    // Clear lock timestamp
    await setLockTimestamp(null);

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error('[book-creation] ❌ Book generation error:', errorMessage);
    
    // Clear lock timestamp on error
    await setLockTimestamp(null);
    
    void updateBookGenerationStatus({ bookId, status: 'failed', error: errorMessage });
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
  
  if (MAX_PENDING_BOOK_COVER_PER_RUN > 0) {
    console.log("[generateMissingOriginalBookCovers] 🎨 Starting missing cover image generation...");
  } else {
    console.log("[generateMissingOriginalBookCovers] ⏩ Cover image generation is disabled");
    return;
  }

  try {
    // Lazy imports for better memory usage and startup time
    const { dbRead } = await import("../db/client.js");
    const { books } = await import("../db/schema.js");
    const { eq, and, isNull, desc, asc } = await import("drizzle-orm");
    const { generateAndUpdateBookCoverImage } = await import("../services/book.js");
    
    // Query original books without cover images (limit to prevent overwhelming the system)
    // Prioritize books with lowest branchesCount, then by highest trendingScore
    const originalBooksWithoutCovers = await dbRead
      .select()
      .from(books)
      .where(and(eq(books.isOriginal, true), isNull(books.imageId)))
      .orderBy(asc(books.branchesCount), desc(books.trendingScore))
      .limit(MAX_PENDING_BOOK_COVER_PER_RUN); // Process up to N books per run
    
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
        const bookForGeneration = mapBookFromDb(book);
        
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
 * Finds and triggers GitHub workflows for pending/failed books in hourly routine mode
 * 
 * Implements locking mechanism to prevent duplicate processing:
 * 1. Finds books with status 'pending' or 'failed'
 * 2. Excludes books that are currently locked (isGeneratingStartedAt within timeout)
 * 3. Excludes refunded books
 * 4. Processes oldest books first (up to HOURLY_RETRY_BATCH_SIZE)
 * 5. Triggers separate GitHub workflow runs for each book (not processed directly)
 */
async function processHourlyRoutine(): Promise<void> {
  console.log('[book-creation] 🔄 Running hourly routine to retry pending/failed generations');

  const lockTimeout = new Date(Date.now() - MAX_GENERATION_DURATION_MS);

  // Find oldest pending or failed books that are not locked and not refunded
  const pendingBooks = await dbRead
    .select({ bookId: bookGenerations.bookId })
    .from(bookGenerations)
    .where(
      and(
        or(
          eq(bookGenerations.generationStatus, 'pending'),
          eq(bookGenerations.generationStatus, 'failed')
        ),
        isNull(bookGenerations.isRefunded),
        or(
          isNull(bookGenerations.isGeneratingStartedAt),
          lt(bookGenerations.isGeneratingStartedAt, lockTimeout)
        )
      )
    )
    .orderBy(bookGenerations.createdAt)
    .limit(HOURLY_RETRY_BATCH_SIZE);

  if (!pendingBooks.length) {
    console.log('[book-creation] ℹ️ No pending or failed books to process');
    return;
  }

  console.log(`[book-creation] 📚 Found ${pendingBooks.length} pending books to trigger workflows for`);

  // Trigger separate GitHub workflow runs for each book
  for (const { bookId } of pendingBooks) {
    console.log(`[book-creation] 👨‍💻 Triggering workflow for book: ${bookId}`);
    
    try {
      // Set lock before triggering workflow to prevent race conditions
      await dbWrite
        .update(bookGenerations)
        .set({ isGeneratingStartedAt: new Date() })
        .where(eq(bookGenerations.bookId, bookId));
      
      triggerBookGenerationWorkflow(bookId, 'Hourly routine');
    } catch (error) {
      console.error(`[book-creation] ❌ Failed to set lock or trigger workflow for book ${bookId}:`, getErrorMessage(error));
      // Clear lock if set, to allow retry on next run
      await dbWrite
        .update(bookGenerations)
        .set({ isGeneratingStartedAt: null })
        .where(eq(bookGenerations.bookId, bookId));
    }
  }
}

/**
 * Main execution function for on-demand book creation cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const bookId = process.env.BOOK_ID;

  try {
    if (bookId) {
      // On-demand mode: process specific book
      console.log('[book-creation] 🎯 On-demand mode for book:', bookId);
      await processBookGeneration(bookId);
    } else {
      // Hourly routine mode: find and process pending books
      console.log('[book-creation] ⏰ Hourly routine mode');
      await processHourlyRoutine();
      // Note: Automatic cover image AI generation is disabled to reduce cost and load, manual handcraft is encouraged
      // await generateMissingOriginalBookCovers();
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[book-creation] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error('[book-creation] ❌ Fatal error:', error);
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[book-creation] 💥 Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[book-creation] 💥 Uncaught exception:', error);
  process.exit(1);
});

void main();
