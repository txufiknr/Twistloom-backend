/**
 * Asynchronous Candidate Generation System
 * 
 * This module provides the refactored candidate generation system that uses
 * pg-boss job queues instead of synchronous AI generation to avoid Vercel timeouts.
 * 
 * Key improvements over the original system:
 * - Immediate API responses (<10 seconds)
 * - Asynchronous candidate generation via job queue
 * - No Vercel timeout issues
 * - Better error handling and retry logic
 * - Scalable processing via cron jobs
 * 
 * @example
 * ```typescript
 * // Replace synchronous call:
 * // await ensureCandidatesForPage(userId, newPage, newState);
 * 
 * // With async job enqueue:
 * await enqueueCandidateGenerationJob(userId, newPage, currentBook);
 * ```
 */

import { enqueueCandidateGeneration } from '../lib/pgboss.js';
import { MAX_BRANCHING_PREGENERATION_DEPTH } from '../config/story.js';
import type { UserStoryPage, StoryState } from '../types/story.js';
import type { Book } from '../types/book.js';
import { getBook, getPageFromDB } from '../services/book.js';
import { validatePageForJobEnqueue } from './candidate-generation.js';

/**
 * Enqueues candidate generation as a background job
 * 
 * This function replaces the synchronous ensureCandidatesForPage call
 * with an asynchronous job enqueue operation. The actual generation
 * happens in the background via Vercel cron jobs.
 * 
 * @param userId - The user's unique identifier
 * @param page - The story page that needs candidate generation
 * @param currentBook - The book containing the page (for validation)
 * @param currentState - Optional story state (for context)
 * @param options - Additional options for job processing
 * 
 * @returns Promise<string> - The job ID for tracking
 * 
 * @example
 * ```typescript
 * // In your page creation flow:
 * const newPage = await generateNextPage(userId, character, state, previousPage, true);
 * const jobId = await enqueueCandidateGenerationJob(userId, newPage, currentBook);
 * console.log(`Candidate generation job enqueued: ${jobId}`);
 * 
 * // The page is returned to user immediately, candidates generated in background
 * return newPage;
 * ```
 */
export async function enqueueCandidateGenerationJob(
  userId: string,
  page: UserStoryPage,
  currentBook: Book | null,
  currentState?: StoryState | null,
  options: {
    priority?: number;
    currentDepth?: number;
    maxDepth?: number;
  } = {}
): Promise<string | null> {
  // Use shared validation for job enqueue
  const { canEnqueue, reason, pendingActions } = validatePageForJobEnqueue(page, currentBook);
  
  if (!canEnqueue) {
    console.log(`[enqueueCandidateGenerationJob] ⏩ ${reason}`);
    return null;
  }
  
  console.log(`[enqueueCandidateGenerationJob] 📋 Enqueuing job for ${pendingActions.length} actions on page ${page.id}`);
  
  // Serialize state if provided for context preservation
  const serializedState = currentState ? JSON.stringify(currentState) : null;
  
  // Enqueue the job with pg-boss
  const jobId = await enqueueCandidateGeneration({
    userId,
    pageId: page.id,
    bookId: currentBook!.id,
    currentDepth: options.currentDepth || 1,
    maxDepth: options.maxDepth || MAX_BRANCHING_PREGENERATION_DEPTH,
    priority: options.priority || 0,
    currentState: serializedState
  }, {
    priority: options.priority || 0,
    retryLimit: 3,
    retryDelay: 30,
    expireInSeconds: 600 // 10 minutes max lifetime
  });
  
  console.log(`[enqueueCandidateGenerationJob] ✅ Job ${jobId} enqueued for page ${page.id} with state: ${serializedState ? 'included' : 'not provided'}`);
  return jobId;
}

/**
 * Batch enqueue candidate generation for multiple pages
 * 
 * Useful for bulk operations like retrying failed generations
 * or processing multiple pages from a book.
 * 
 * @param userId - The user's unique identifier
 * @param pageIds - Array of page IDs to process
 * @param bookId - The book ID containing these pages
 * @param options - Additional options for batch processing
 * 
 * @returns Promise<string> - The batch job ID
 * 
 * @example
 * ```typescript
 * // Retry failed pages:
 * const failedPages = await getFailedGenerationPages(userId, bookId);
 * const batchJobId = await enqueueBatchCandidateGenerationJob(
 *   userId,
 *   failedPages.map(p => p.id),
 *   bookId,
 *   { priority: 10 } // High priority for retries
 * );
 * ```
 */
export async function enqueueBatchCandidateGenerationJob(
  userId: string,
  pageIds: string[],
  bookId: string,
  options: {
    priority?: number;
  } = {}
): Promise<string> {
  if (pageIds.length === 0) {
    console.log(`[enqueueBatchCandidateGenerationJob] No pages to process`);
    return '';
  }
  
  console.log(`[enqueueBatchCandidateGenerationJob] 📦 Enqueuing batch job for ${pageIds.length} pages`);
  
  // This would require implementing the batch job handler in pgboss.ts
  // For now, we'll enqueue individual jobs in parallel
  const jobPromises = pageIds.map(async (pageId) => {
    try {
      return await enqueueCandidateGeneration({
        userId,
        pageId,
        bookId,
        priority: options.priority || 0
      }, {
        priority: options.priority || 0,
        retryLimit: 3,
        retryDelay: 30
      });
    } catch (error) {
      console.error(`[enqueueBatchCandidateGenerationJob] Failed to enqueue job for page ${pageId}:`, error);
      return null;
    }
  });
  
  const jobIds = await Promise.all(jobPromises);
  const successfulJobs = jobIds.filter(id => id !== null);
  
  console.log(`[enqueueBatchCandidateGenerationJob] ✅ Enqueued ${successfulJobs.length}/${pageIds.length} jobs`);
  return `batch-${successfulJobs.length}-jobs`;
}

/**
 * Check if a page has pending candidate generation
 * 
 * This function can be used to determine if a page needs candidate
 * generation without actually triggering it.
 * 
 * @param page - The story page to check
 * @returns boolean - True if the page has pending actions
 * 
 * @example
 * ```typescript
 * const needsGeneration = hasPendingCandidates(page);
 * if (needsGeneration) {
 *   await enqueueCandidateGenerationJob(userId, page, book);
 * }
 * ```
 */
export function hasPendingCandidates(page: UserStoryPage): boolean {
  const pendingActions = page.actions.filter(action => 
    !action.destination?.pageId || !action.destination?.branchId
  );
  
  return pendingActions.length > 0;
}

/**
 * Get pending actions count for a page
 * 
 * @param page - The story page to check
 * @returns number - Number of actions needing generation
 * 
 * @example
 * ```typescript
 * const pendingCount = getPendingActionsCount(page);
 * console.log(`Page has ${pendingCount} pending actions`);
 * ```
 */
export function getPendingActionsCount(page: UserStoryPage): number {
  return page.actions.filter(action => 
    !action.destination?.pageId || !action.destination?.branchId
  ).length;
}

/**
 * Validate page for candidate generation
 * 
 * This function performs the same validation checks as the original
 * ensureCandidatesForPage function but returns validation results
 * instead of performing generation.
 * 
 * @param page - The story page to validate
 * @param currentBook - The book containing the page
 * @returns Object with validation results
 * 
 * @example
 * ```typescript
 * const validation = validatePageForGeneration(page, book);
 * if (!validation.canGenerate) {
 *   console.log('Cannot generate candidates:', validation.reason);
 *   return;
 * }
 * ```
 */
export function validatePageForGeneration(
  page: UserStoryPage,
  currentBook: Book | null
): {
  canGenerate: boolean;
  reason?: string;
  pendingActionsCount: number;
} {
  // Check if book exists
  if (!currentBook) {
    return {
      canGenerate: false,
      reason: 'Book not found',
      pendingActionsCount: 0
    };
  }
  
  // Check if this is the last page
  if (page.page >= currentBook.totalPages) {
    return {
      canGenerate: false,
      reason: 'Last page - no candidates needed',
      pendingActionsCount: 0
    };
  }
  
  // Check pending actions
  const pendingActionsCount = getPendingActionsCount(page);
  
  if (pendingActionsCount === 0) {
    return {
      canGenerate: false,
      reason: 'No actions need generation',
      pendingActionsCount: 0
    };
  }
  
  return {
    canGenerate: true,
    pendingActionsCount
  };
}

/**
 * Migrate from synchronous to asynchronous generation
 * 
 * This function helps migrate existing code by providing a drop-in
 * replacement for ensureCandidatesForPage that uses the job queue.
 * 
 * @param userId - The user's unique identifier
 * @param page - The story page
 * @param currentState - Optional story state
 * @param currentBook - Optional book (will be fetched if not provided)
 * 
 * @returns Promise<string> - Job ID or empty string if no job needed
 * 
 * @example
 * ```typescript
 * // Replace this:
 * // await ensureCandidatesForPage(userId, page, currentState);
 * 
 * // With this:
 * await ensureCandidatesForPageAsync(userId, page, currentState);
 * ```
 */
export async function ensureCandidatesForPageAsync(
  userId: string,
  page: UserStoryPage,
  currentState?: StoryState | null,
  currentBook?: Book | null
): Promise<string | null> {
  // Get book if not provided
  currentBook ??= await getBook(page.bookId);
  if (!currentBook) {
    console.log(`[ensureCandidatesForPageAsync] ❓ Book not found, skipping generation`);
    return null;
  }

  try {
    const dbPage = await getPageFromDB(page.id, { bookIdentifier: currentBook.id });
    if (!dbPage) {
      console.error(`[ensureCandidatesForPageAsync] ❓ Page ${page.id} not found, skipping generation`);
      return null;
    }
  } catch (error) {
    console.error(`[ensureCandidatesForPageAsync] ❌ Error fetching page ${page.id}:`, error);
    return null;
  }
  
  // Validate and enqueue
  const validation = validatePageForGeneration(page, currentBook);
  if (!validation.canGenerate) {
    console.log(`[ensureCandidatesForPageAsync] ⏩ ${validation.reason}`);
    return null;
  }
  
  return await enqueueCandidateGenerationJob(
    userId,
    page,
    currentBook,
    currentState
  );
}
