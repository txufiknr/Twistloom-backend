/**
 * Shared validation and utility functions for candidate generation
 * 
 * This module extracts common validation logic used by both synchronous
 * and asynchronous candidate generation functions to eliminate code duplication.
 */

import { getBook, getPageFromDB, getStoryPageById, mapToUserStoryPage } from '../services/book.js';
import { MAX_BRANCHING_PREGENERATION_DEPTH, MAX_BRANCHING_RETRIES } from '../config/story.js';
import { GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_DEFAULT_BRANCH } from '../config/env.js';
import type { UserStoryPage, Action, ActionedStoryPage, PersistedStoryPage } from '../types/story.js';
import type { Book } from '../types/book.js';
import type { ActionProgressCallback, ActionProgressStatus, CandidateGenerationResult, CandidateGenerationStrategy, GenerateCandidatePageParams, GenerateCandidatesInParallelParams, GenerateCandidatesOptions, GenerateCandidatesWithStrategyParams, GenerationStrategy } from '../types/candidates.js';
import { getErrorMessage } from './error.js';
import { dbWrite } from '../db/client.js';
import { pages } from '../db/schema.js';
import { storeActionProgressEvent } from './progress-tracking.js';
import { eq } from 'drizzle-orm';
import { LOCK_KEYS, withLock } from './distributed-lock.js';
import { createNonRetryableError, type ErrorWithCustomProperties, retryWithBackoffOrNull } from './retry.js';
import { generateNextPage } from './prompt.js';

/**
 * Performance metrics for candidate generation
 */
interface GenerationMetrics {
  actionCount: number;
  lookupTime: number;
  generationTime: number;
  successCount: number;
  failureCount: number;
  timeoutOccurrences: number;
  lockContentions: number;
}

/**
 * Global metrics collector for candidate generation performance
 */
const globalMetrics = {
  totalGenerations: 0,
  totalLookups: 0,
  totalTimeouts: 0,
  totalLockContentions: 0
};

/**
 * Log performance metrics for candidate generation
 */
function logMetrics(metrics: Partial<GenerationMetrics>): void {
  globalMetrics.totalGenerations++;
  globalMetrics.totalLookups += metrics.lookupTime || 0;
  globalMetrics.totalTimeouts += metrics.timeoutOccurrences ? 1 : 0;
  globalMetrics.totalLockContentions += metrics.lockContentions ? 1 : 0;
  
  console.log(`[candidate-generation-metrics] 📊 Performance metrics:`, {
    actionCount: metrics.actionCount,
    lookupTime: metrics.lookupTime,
    generationTime: metrics.generationTime,
    successCount: metrics.successCount,
    failureCount: metrics.failureCount,
    timeoutOccurrences: metrics.timeoutOccurrences,
    lockContentions: metrics.lockContentions,
    totals: { ...globalMetrics }
  });
}

/**
 * Result of candidate generation validation
 */
export interface CandidateGenerationValidation {
  /** Whether generation should proceed */
  canGenerate: boolean;
  /** Reason why generation cannot proceed (if applicable) */
  reason?: string;
  /** Book context (resolved if available) */
  book: Book | null;
  /** Actions that need generation */
  pendingActions: Action[];
  /** Current depth for generation */
  currentDepth: number;
  /** Maximum depth for generation */
  maxDepth: number;
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
  const pendingActions = getPendingActionsCount(page);
  return pendingActions > 0;
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
    !action.destination?.pageId && 
    !action._isFallback // Skip fallback actions that already failed
  ).length;
}

/**
 * Validates whether a page needs candidate generation
 * 
 * This function consolidates all the early exit checks used across
 * different candidate generation implementations.
 * 
 * @param userId - The user's unique identifier
 * @param page - The story page to validate
 * @param currentBook - Optional book context (avoids DB lookup if provided)
 * @param currentState - Optional story state (not used in validation but kept for consistency)
 * @param options - Additional options for validation
 * 
 * @returns Validation result with all necessary context
 * 
 * @example
 * ```typescript
 * const validation = await validateCandidateGeneration(page, book);
 * if (!validation.canGenerate) {
 *   console.log(validation.reason);
 *   return;
 * }
 * // Proceed with generation using validation.pendingActions
 * ```
 */
export async function validateCandidateGeneration(
  page: UserStoryPage,
  currentBook: Book | null = null,
  options: Pick<GenerateCandidatesOptions, 'currentDepth' | 'maxDepth'>
): Promise<CandidateGenerationValidation> {
  const { currentDepth = 1, maxDepth: providedMaxDepth = MAX_BRANCHING_PREGENERATION_DEPTH } = options;
  const maxDepth = Math.min(providedMaxDepth, MAX_BRANCHING_PREGENERATION_DEPTH);
  
  // Early exit: skip if book not found
  currentBook ??= await getBook(page.bookId);
  if (!currentBook) {
    return {
      canGenerate: false,
      reason: `Book not found for page ${page.id}`,
      book: null,
      pendingActions: [],
      currentDepth,
      maxDepth
    };
  }

  // Early exit: skip if this is the last page (no candidates needed)
  if (page.page >= currentBook.totalPages) {
    return {
      canGenerate: false,
      reason: `Skipping last page ${page.page} (no candidates needed)`,
      book: currentBook,
      pendingActions: [],
      currentDepth,
      maxDepth
    };
  }

  // Early exit: skip if no actions need generation (exclude fallback actions to prevent retry loops)
  const pendingActions = page.actions.filter(action => 
    !action.destination?.pageId && 
    !action._isFallback // Skip fallback actions that already failed
  );
  
  if (pendingActions.length === 0) {
    return {
      canGenerate: false,
      reason: 'All actions are complete',
      book: currentBook,
      pendingActions: [],
      currentDepth,
      maxDepth
    };
  }

  // Early exit: skip if depth limit reached
  if (currentDepth > maxDepth) {
    return {
      canGenerate: false,
      reason: `Depth limit reached (${currentDepth}/${maxDepth})`,
      book: currentBook,
      pendingActions,
      currentDepth,
      maxDepth
    };
  }

  return {
    canGenerate: true,
    book: currentBook,
    pendingActions,
    currentDepth,
    maxDepth
  };
}

/**
 * Validates page for job enqueue (simplified version)
 * 
 * This is a lightweight validation specifically for job enqueue operations
 * that doesn't need the full context of the main validation.
 * 
 * @param page - The story page to validate
 * @param currentBook - Book context
 * 
 * @returns Validation result
 */
export function validatePageForJobEnqueue(page: UserStoryPage, currentBook: Book | null): {
  canEnqueue: boolean;
  reason?: string;
  pendingActions: Action[];
} {
  // Early exit: skip if book not found
  // currentBook ??= await getBook(page.bookId);
  if (!currentBook) {
    return {
      canEnqueue: false,
      reason: `Book not found for page ${page.id}`,
      pendingActions: []
    };
  }
  
  // Early exit: skip if this is the last page (no candidates needed)
  if (page.page >= currentBook.totalPages) {
    return {
      canEnqueue: false,
      reason: `Skipping last page ${page.page} (no candidates needed)`,
      pendingActions: []
    };
  }
  
  // Early exit: skip if no actions need generation (exclude fallback actions to prevent retry loops)
  const pendingActions = page.actions.filter(action => 
    !action.destination?.pageId && 
    !action._isFallback // Skip fallback actions that already failed
  );
  
  if (pendingActions.length === 0) {
    return {
      canEnqueue: false,
      reason: `No actions need generation for page ${page.id}`,
      pendingActions: []
    };
  }

  return {
    canEnqueue: true,
    pendingActions
  };
}

/**
 * Determines the appropriate generation strategy based on context
 * 
 * @param context - Generation context
 * @returns Generation strategy configuration which is optimized for specific
 * use cases and environments:
 * 
 * 'vercel': User-facing API requests with immediate response requirements (Express API Route)
 * - Timeout: 4.5 minutes (Vercel limits enforced)
 * - Parallel: ✅ Yes (for performance)
 * - Use Case: Real-time user interactions via SSE
 * - Benefits: Fast response, real-time progress tracking
 * - Limitations: Vercel timeout restrictions
 * 
 * 'cron': Background processing and extended timeout operations (Vercel Cron)
 * - Timeout: 13 minutes (no Vercel limits, align with API route maxDuration)
 * - Parallel: ✅ Yes (for efficiency)
 * - Use Case: Background functions, retry processing
 * - Benefits: Extended timeout, bulk operations
 * - Limitations: Delayed execution (scheduled)
 * 
 * 'github-action': Automated workflows and manual CI/CD operations (GitHub Workflow)
 * - Timeout: 30 minutes (custom extended)
 * - Parallel: ❌ No (sequential for reliability and logging)
 * - Use Case: Originals generation, bulk processing
 * - Benefits: Detailed logging, error recovery
 * - Limitations: Slower sequential processing
 */
export function getGenerationStrategy(context: CandidateGenerationStrategy = 'vercel'): GenerationStrategy {
  switch (context) {
    case 'vercel': return {
      useParallel: true,
      enforceVercelLimits: true,
      customTimeoutMs: undefined // Use calculated timeout
    };
    
    case 'cron': return {
      useParallel: true, // Parallel for efficiency
      enforceVercelLimits: false, // No Vercel limits in cron
      customTimeoutMs: 780_000 // 13 minutes for cron jobs (20s buffer)
    };
    
    case 'github-action': return {
      useParallel: false, // Sequential for reliability
      enforceVercelLimits: false, // No Vercel limits in GitHub Actions
      customTimeoutMs: 1_800_000 // 30 minutes for GitHub Actions
    };
  }
}

/**
 * Calculates appropriate timeout based on generation context (in milliseconds)
 * 
 * @param strategy - Generation strategy
 * @param requestStartTime - When the request started (for Vercel timeout calculation)
 * @returns Timeout in milliseconds
 */
export function calculateGenerationTimeout(
  strategy: GenerationStrategy,
  requestStartTime?: number
): number {
  const { customTimeoutMs, enforceVercelLimits } = strategy;
  if (customTimeoutMs) return customTimeoutMs;

  if (enforceVercelLimits && requestStartTime) {
    const VERCEL_TIMEOUT_MS = 300000; // 300 seconds Vercel limit
    const RESPONSE_BUFFER_MS = 5000; // 5s buffer for response processing
    const MIN_AI_TIMEOUT_MS = 10000; // 10 seconds minimum for AI generation
    const timeElapsed = Date.now() - requestStartTime;
    
    // Calculate remaining time and cap at 4 minutes, floor at 0
    const remaining = VERCEL_TIMEOUT_MS - timeElapsed - RESPONSE_BUFFER_MS;
    const timeoutMs = Math.min(Math.max(remaining, 0), 240000);
    
    // Bail early if insufficient time for meaningful AI generation
    if (timeoutMs < MIN_AI_TIMEOUT_MS) {
      console.warn(`[calculateGenerationTimeout] ⚠️ Only ${timeoutMs}ms remaining, skipping generation (minimum ${MIN_AI_TIMEOUT_MS}ms required)`);
      return 0; // Signal to skip generation entirely
    }
    
    return timeoutMs;
  }

  // Default timeout for non-Vercel environments
  return 600000; // 10 minutes
}

/**
 * Generates a candidate page for an action (pre-generation for branching narratives)
 * 
 * This function handles the candidate pre-generation pipeline:
 * 1. Retrieves current story progress (session, page, state, character) in parallel
 * 2. Matches actionText against current page actions to get full Action object
 * 3. Checks if next page is pre-generated (candidate) and reuses if available
 * 4. Updates story state based on chosen action (increments page, generates context summary)
 * 5. Generates next page using AI with dynamic configuration
 * 6. Persists page and state to database with proper parent-child relationships
 * 
 * This function is always used for pre-generation, not for user navigation.
 * User session and page progress tracking are handled separately when users actually visit pages.
 * 
 * @param params.userId - The user's unique identifier
 * @param params.actionText - The action text for which to generate a candidate
 * @param params.currentPage - Optional current page context (if already fetched)
 * @param params.currentState - Optional current story state (avoids database lookup when provided)
 * @returns Promise resolving to the generated candidate page with database ID and metadata
 * 
 * @example
 * ```typescript
 * // Generate candidate page for an action
 * const candidatePage = await generateCandidatePage({ 
 *   userId: "user123", 
 *   actionText: "Investigate the noise",
 *   currentPage,
 *   currentState 
 * });
 * console.log(`Candidate page: ${candidatePage.text}`);
 * ```
 */
export async function generateCandidatePage(params: GenerateCandidatePageParams): Promise<PersistedStoryPage | null> {
  const { userId, action: actionCandidate, currentPage, currentState, generateNewBranchId } = params;
  let { currentBook } = params;
  
  if (!currentPage) {
    throw createNonRetryableError('currentPage is required');
  }
  
  // 1. Check for invalid actions (will be removed)
  if (!actionCandidate.text) {
    throw createNonRetryableError(`Invalid action: no text`, 'INVALID_ACTION');
  }

  // 2. Get book for current page if not provided
  currentBook ??= await getBook(currentPage.bookId);
  if (!currentBook) {
    throw createNonRetryableError(`Book not found for page ${currentPage.id}`, 'BOOK_NOT_FOUND');
  }

  // 3. Match actionText against current page actions to get full Action object
  const action = currentPage.actions.find(a => a.text === actionCandidate.text);
  if (!action) {
    throw createNonRetryableError(`Action "${actionCandidate.text}" not found in current page actions`, 'ACTION_NOT_FOUND');
  }

  const nextPageNumber = currentPage.page + 1;
  console.log(`[generateCandidatePage] ℹ️ Should generate candidates for page ${nextPageNumber}`);

  if (currentState?.plotFlags.some(p => p.page === nextPageNumber)) {
    console.warn(`[generateCandidatePage] ⚠️ Unexpected page ${nextPageNumber} is already in plot flags`);
  }

  // 4. Check if next page is pre-generated (candidate) and reuse if available
  const nextPageId = action.destination?.pageId;
  const bookId = currentBook.id;
  let newPage: PersistedStoryPage | null = null;
  if (nextPageId) {
    newPage = await getStoryPageById(userId, bookId, nextPageId);
  }

  // 5. If no pre-generated page exists, generate new page with state progression
  if (newPage) {
    // Candidate: wait until user visit the page and ensure next candidates
    console.log(`[generateCandidatePage] ✅ Using pre-generated page ${newPage.id}, delta already exists from pre-generation`);
  } else {
    // 6a. Create actioned page with selected action for state processing
    const actionedPage: ActionedStoryPage = {
      ...currentPage,
      selectedAction: action
    };
    
    // 6b. Generate next page using AI with dynamic configuration
    try {
      newPage = await generateNextPage({
        userId,
        book: currentBook,
        currentState,
        actionedPage,
        generateNewBranchId
      });

      console.log(`[generateCandidatePage] 🌌 Generated new story page ${newPage.id} for ${action.text} (type: ${action.type})`);
    } catch (error) {
      // Check if this is a duplicate destination error (action already has pageId)
      if ((error as ErrorWithCustomProperties).code === 'ACTION_ALREADY_HAS_DESTINATION') {
        console.log(`[generateCandidatePage] ⏭️ Action "${action.text}" already has destination, retrieving existing page`);
        // The action already has a destination, so get the existing page
        const existingPageId = action.destination?.pageId;
        if (existingPageId) {
          newPage = await getStoryPageById(userId, bookId, existingPageId);
          if (newPage) {
            console.log(`[generateCandidatePage] ✅ Retrieved existing page ${newPage.id} for action "${action.text}"`);
          }
        }
      } else {
        // Re-throw other errors
        // throw createNonRetryableError(getErrorMessage(error), 'GENERATION_FAILED');
        throw error;
      }
    }
  }

  // 7. Return the generated page with all database metadata
  return newPage;
}

/**
 * Generates candidate pages in parallel for multiple actions
 * 
 * This function processes multiple actions simultaneously using Promise.allSettled,
 * providing better performance and timeout resilience compared to sequential processing.
 * Each action generation is isolated, so failures don't affect other actions.
 * 
 * @param params - Parameters for parallel generation
 * @returns Array of generation results in the same order as input actions
 */
async function generateCandidatesInParallel(params: GenerateCandidatesInParallelParams): Promise<CandidateGenerationResult[]> {
  const { userId, actions, currentPage, currentState, currentBook, initialGenerateNewBranchId, timeoutMs, currentDepth, maxDepth, onProgress } = params;
  const startTime = Date.now();
  const lookupStartTime = Date.now();
  
  console.log(`[generateCandidatesInParallel] 🚀 Starting parallel generation for ${actions.length} actions at depth ${currentDepth}/${maxDepth}`);
  
  // Create generation promises for each action
  const generationPromises = actions.map(async (action, index) => {
    const letter = String.fromCharCode(65 + index);
    
    // Notify action start
    onProgress?.(action, 'started');
    console.log(`[generateCandidatesInParallel] ⏳ Starting generation for: ${letter}. ${action.text}`);
    
    // Track the last error to determine if action should be removed
    let lastError: unknown = null;
    
    // Use new branch ID for all but the first action (if initial flag is false)
    // This matches sequential strategy logic: isPartial || generateNewBranchId || index > 0
    const generateNewBranchId = initialGenerateNewBranchId || index > 0;
    
    const candidatePage = await Promise.race([
      retryWithBackoffOrNull(
        () => generateCandidatePage({
          userId,
          action,
          currentPage,
          currentState,
          currentBook,
          generateNewBranchId
        }),
        {
          maxRetries: MAX_BRANCHING_RETRIES,
          baseDelayMs: 1000,
          maxDelayMs: 4000,
          onRetry: (attempt, error) => {
            lastError = error; // Capture the error for later analysis
            console.error(`[generateCandidatesInParallel] ⚠️ Retry ${attempt}/${MAX_BRANCHING_RETRIES} for action "${action.text}":`, error);
          },
          // Stop retrying if error is non-retryable (e.g. validation errors)
          shouldRetry: (error) => {
            try {
              lastError = error; // Capture the error
              // Check if error is marked as non-retryable
              const err = error as ErrorWithCustomProperties;
              if (err.shouldRetry === false || err.code === 'INVALID_ACTION') {
                console.warn(`[generateCandidatesInParallel] ⛔ Non-retryable error detected:`, getErrorMessage(error));
                return false;
              }
              console.warn(`[generateCandidatesInParallel] ❓ Should retry for this error?`, getErrorMessage(error));
              return true;
            } catch {
              return true;
            }
          }
        }
      ),
      new Promise<null>((_, reject) => 
        setTimeout(() => {
          console.warn(`[generateCandidatesInParallel] ⏰ AI generation timeout for action ${letter}. ${action.text} after ${timeoutMs}ms`);
          reject(new Error(`AI generation timeout (${timeoutMs}ms)`));
        }, timeoutMs)
      )
    ]).catch(error => {
      // Handle timeout and other errors gracefully
      console.error(`[generateCandidatesInParallel] ❌ Generation failed for action ${letter}. ${action.text}:`, getErrorMessage(error));
      lastError = error;
      
      // Notify failure
      onProgress?.(action, 'failed', undefined, error);
      return null;
    });

    // Notify success if generation completed
    if (candidatePage) {
      onProgress?.(action, 'completed', candidatePage);
      console.log(`[generateCandidatesInParallel] ✅ Completed generation for: ${letter}. ${action.text}`);
    }

    return {
      action,
      success: !!candidatePage,
      candidatePage,
      error: lastError
    } satisfies CandidateGenerationResult;
  });

  // Execute all generations in parallel and wait for completion
  const results = await Promise.allSettled(generationPromises);
  
  // Convert settled results to array and log summary
  const generationResults: CandidateGenerationResult[] = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`[generateCandidatesInParallel] ❌ Promise rejected for action ${index}:`, result.reason);
      return {
        action: actions[index],
        success: false,
        candidatePage: null,
        error: result.reason
      };
    }
  });

  // Log parallel generation summary with performance metrics
  const successCount = generationResults.filter(r => r.success).length;
  const failureCount = generationResults.length - successCount;
  const endTime = Date.now();
  const totalGenerationTime = endTime - startTime;
  const lookupTime = lookupStartTime ? startTime - lookupStartTime : 0;
  
  console.log(`[generateCandidatesInParallel] ✅ Parallel generation complete: ${successCount} succeeded, ${failureCount} failed`);
  
  // Log performance metrics
  logMetrics({
    actionCount: actions.length,
    lookupTime,
    generationTime: totalGenerationTime,
    successCount,
    failureCount,
    timeoutOccurrences: 0, // Would be tracked in timeout handling
    lockContentions: 0 // Would be tracked in lock acquisition
  });

  // Fire-and-forget deeper level generation for successfully generated candidates
  if (currentDepth < maxDepth) {
    const successfulResults = generationResults.filter(r => r.success && r.candidatePage);
    
    if (successfulResults.length > 0) {
      console.log(`[generateCandidatesInParallel] 🚀 Starting fire-and-forget generation for depth ${currentDepth + 1}/${maxDepth} with ${successfulResults.length} candidates`);
      
      // Process deeper levels in background without waiting
      void Promise.allSettled(
        successfulResults.map(async (result) => {
          try {
            const candidatePage = result.candidatePage!;
            
            // Validate required fields
            if (!candidatePage.id || !candidatePage.bookId || !candidatePage.branchId) {
              console.error(`[generateCandidatesInParallel] ❌ Invalid candidate page missing required fields:`, {
                id: candidatePage.id,
                bookId: candidatePage.bookId,
                branchId: candidatePage.branchId
              });
              return;
            }
            
            const nextDepth = currentDepth + 1;
            if (nextDepth <= MAX_BRANCHING_PREGENERATION_DEPTH) {
              // Immediate fire-and-forget for better UX
              void triggerGitHubWorkflow({
                userId,
                pageId: candidatePage.id,
                bookId: candidatePage.bookId,
                context: `generateCandidatesInParallel-depth${nextDepth}`
              });
              console.log(`[generateCandidatesInParallel] 🚀 Triggered immediate background generation for level ${nextDepth}`);
            } else {
              console.log(`[generateCandidatesInParallel] ⏳ No need to do anything for level ${nextDepth}, let GitHub Workflow done the hourly job`);
              // No need to do anything, let GitHub Workflow done the hourly job
            }
          } catch (error) {
            console.error(`[generateCandidatesInParallel] ❌ Background generation failed for depth ${currentDepth + 1}:`, getErrorMessage(error));
          }
        })
      ).then(results => {
        // Log any rejected promises for monitoring
        const rejectedCount = results.filter(r => r.status === 'rejected').length;
        if (rejectedCount > 0) {
          console.warn(`[generateCandidatesInParallel] ⚠️ ${rejectedCount} background generation operations failed at depth ${currentDepth + 1}`);
        }
      });
    }
  }

  return generationResults;
}

/**
 * Core candidate generation implementation with configurable strategy
 * 
 * This function consolidates the logic for both parallel and non-parallel generation
 * by using a strategy pattern to determine the generation approach.
 * 
 * @param userId - The user's unique identifier
 * @param page - The story page to process
 * @param currentState - Story state for the current page for prompt (highly recommended)
 * @param currentBook - Optional book context
 * @param context - Generation context
 * 
 * @returns Promise<UserStoryPage> - The updated page with generated candidates
 */
export async function ensureCandidatesForPageWithStrategy(
  params: GenerateCandidatesWithStrategyParams
): Promise<UserStoryPage> {
  const { strategy: context, userId, page, currentState, currentBook: providedBook, options = {} } = params;
  const { timeoutMs: customTimeoutMs, onProgress } = options;

  // Wrap onProgress callback to store progress in database
  const onActionProgress: ActionProgressCallback = async (
    action: Action,
    status: ActionProgressStatus,
    result?: PersistedStoryPage,
    error?: unknown
  ) => {
    // Store progress event in database
    await storeActionProgressEvent(page.id, {
      action: action.text,
      status,
      error: error ? getErrorMessage(error) : undefined,
      timestamp: new Date().toISOString(),
    });

    // Call original callback if provided
    onProgress?.(action, status, result, error);
  };

  // Use shared validation to eliminate redundant checks
  const validation = await validateCandidateGeneration(page, providedBook, options);
  if (!validation.canGenerate) {
    console.log(`[ensureCandidatesForPageWithStrategy] ⏩ ${validation.reason}`);
    return page;
  }

  // It's highly recommended to provide the currentState explicitly
  if (currentState === undefined) {
    console.warn(`[ensureCandidatesForPageWithStrategy] ⚠️ Base state not provided, will be reconstructed from current page`);
  }

  // Extract validated context
  const currentBook = validation.book!;
  const pendingActions = validation.pendingActions;
  const { currentDepth, maxDepth } = validation;
  
  console.log(`[ensureCandidatesForPageWithStrategy] ⏳ ${pendingActions.length} actions need candidate page generation (${context})`);

  // Get generation strategy based on context
  const strategy = getGenerationStrategy(context);
  const timeoutMs = customTimeoutMs ?? calculateGenerationTimeout(strategy);
  
  console.log(`[ensureCandidatesForPageWithStrategy] ⏱️ Using timeout: ${timeoutMs}ms (parallel: ${strategy.useParallel})`);

  // Use distributed lock to prevent concurrent processing of the same page
  const lockKey = LOCK_KEYS.CANDIDATE_GENERATION(page.id);
  const lockResult = await withLock<UserStoryPage | null>(lockKey, async () => {
    // Read current page state (no transaction - avoids idle timeout during AI generation)
    const currentDBPage = await getPageFromDB(page.id, { client: dbWrite });
    if (!currentDBPage) throw new Error('Page not found');

    // Map DB row to the user-facing page shape used by generation code.
    const currentPage = await mapToUserStoryPage(currentDBPage, userId);
    const initialDBActions = currentDBPage.actions;

    // Re-check pending actions after acquiring lock (another instance might have processed them)
    const recheckedPendingDBActions = initialDBActions.filter(action => 
      !action.destination?.pageId && 
      !action._isFallback // Skip fallback actions that already failed
    );
    if (recheckedPendingDBActions.length === 0) {
      console.log(`[ensureCandidatesForPage] ⏩ Actions already processed by another instance`);
      return currentPage;
    }

    // Mark page as generating under lock to make the state visible to other readers
    // Note: perform update inside the lock so only the lock owner sets the flag
    // Use a timestamp so we can detect stale generators later (`null` when not generating)
    await dbWrite
      .update(pages)
      .set({ isGeneratingStartedAt: new Date() })
      .where(eq(pages.id, page.id));
    console.log(`[ensureCandidatesForPage] 🔒 Set isGeneratingStartedAt for page ${page.id} (lock owner)`);

    // Track if any actions were actually updated
    const generateNewBranchId = recheckedPendingDBActions.length < initialDBActions.length;
    let updatedDBActions = [...initialDBActions];
    let hasRealChanges = false;

    // Track removed actions using Set for O(1) lookup (clean, type-safe approach)
    const removedActionTexts = new Set<string>();

    // Build action index map for O(1) lookups using text as key
    const actionIndexMap = new Map(
      initialDBActions.map((action, index) => [action.text, index])
    );

    // Helper functions for DRY code
    /**
     * Generate letter mapping for action (A, B, C, etc.)
     */
    function generateActionLetter(action: Action): string {
      const actionIndex = actionIndexMap.get(action.text) ?? 0;
      return String.fromCharCode(65 + actionIndex);
    }

    /**
     * Check if error indicates invalid action
     */
    function isInvalidActionError(error: unknown): boolean {
      if (!error) return false;
      return (
        (error as ErrorWithCustomProperties).code === 'INVALID_ACTION' ||
        (error as ErrorWithCustomProperties).shouldRetry === false
      );
    }

    /**
     * Update action with destination page using Map-based O(1) updates
     * This provides optimal performance and maintains consistency
     */
    function updateActionWithDestination(
      action: Action, 
      candidatePage: PersistedStoryPage, 
    ): void {
      // Use action index map for O(1) lookup and update
      const existingIndex = actionIndexMap.get(action.text);
      
      if (existingIndex !== undefined) {
        // Direct update at existing position - O(1) operation
        updatedDBActions[existingIndex] = { 
          ...action, 
          destination: { 
            branchId: candidatePage.branchId, 
            pageId: candidatePage.id 
          } 
        };
      } else {
        // Append new action - O(1) operation
        updatedDBActions.push({ 
          ...action, 
          destination: { 
            branchId: candidatePage.branchId, 
            pageId: candidatePage.id 
          } 
        });
        // Update map with new index
        actionIndexMap.set(action.text, updatedDBActions.length - 1);
      }
      
      hasRealChanges = true;
    }

    /**
     * Process action generation result (success or failure)
     */
    function processActionResult(
      result: CandidateGenerationResult,
      letter: string
    ): void {
      const action = result.action;

      if (result.success && result.candidatePage) {
        // Success: update action with destination
        console.log(`[ensureCandidatesForPageWithStrategy] ✅ Pre-generated destination page for: ${letter}.`, action.text);
        updateActionWithDestination(action, result.candidatePage);

        // Notify progress callback
        onActionProgress(action, 'completed', result.candidatePage);
      } else {
        // Handle failed generation
        const isInvalidAction = isInvalidActionError(result.error);

        if (isInvalidAction) {
          console.error(`[ensureCandidatesForPageWithStrategy] ❌ Invalid action "${action.text}" detected, removing from actions`);
          // Track removed action using clean Set-based approach
          const existingIndex = actionIndexMap.get(action.text);
          if (existingIndex !== undefined) {
            removedActionTexts.add(action.text);
            hasRealChanges = true;
            // Remove from map immediately
            actionIndexMap.delete(action.text);
          }
        } else {
          console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to generate candidate for valid action ${letter}. ${action.text}:`, getErrorMessage(result.error));
        }

        // Notify progress callback of failure
        onActionProgress(action, 'failed', undefined, result.error);
      }
    }
    
    /**
     * Filter out removed actions and rebuild action index map
     * Clean, type-safe approach using text as key
     */
    function filterRemovedActionsAndRebuildMap(): void {
      // Filter out removed actions using Set-based O(1) lookup
      updatedDBActions = updatedDBActions.filter(action => !removedActionTexts.has(action.text));
      
      // Rebuild action index map for consistency
      actionIndexMap.clear();
      updatedDBActions.forEach((action, index) => {
        actionIndexMap.set(action.text, index);
      });
    }
    
    // Choose generation strategy based on context
    if (strategy.useParallel) {
      // Parallel generation (for Vercel and cron)
      const generationResults = await generateCandidatesInParallel({
        userId,
        actions: recheckedPendingDBActions,
        currentPage,
        currentState,
        currentBook,
        initialGenerateNewBranchId: generateNewBranchId,
        timeoutMs,
        currentDepth,
        maxDepth,
        onProgress: onActionProgress
      });
      
      // Process parallel results using helper functions
      for (let i = 0; i < generationResults.length; i++) {
        const result = generationResults[i];
        const letter = generateActionLetter(result.action);
        processActionResult(result, letter);
      }
    } else {
      // If there were any existing actions, should generate new branchId for each pending action
      const isPartial = initialDBActions.length > recheckedPendingDBActions.length;

      // Sequential generation (for GitHub Actions) using helper functions
      for (const [index, action] of recheckedPendingDBActions.entries()) {
        const letter = generateActionLetter(action);
        console.log(`[ensureCandidatesForPageWithStrategy] ⏳ Pre-generating destination page for: ${letter}.`, action.text);

        // Notify progress callback of action start
        onActionProgress(action, 'started');
        
        // Calculate generateNewBranchId per action: first action uses parent branchId, subsequent actions get new branchId
        const actionGenerateNewBranchId = isPartial || generateNewBranchId || index > 0;
        
        // Generate candidate page with retry logic (3 retries with exponential backoff: 1s, 2s, 4s)
        // Track the last error to determine if action should be removed
        let lastError: unknown = null;
        const candidatePage = await retryWithBackoffOrNull(
          () => generateCandidatePage({
            userId,
            action,
            currentPage,
            currentState,
            currentBook,
            generateNewBranchId: actionGenerateNewBranchId
          }),
          {
            maxRetries: MAX_BRANCHING_RETRIES,
            baseDelayMs: 1000,
            maxDelayMs: 4000,
            onRetry: (attempt, error) => {
              lastError = error; // Capture the error for later analysis
              console.error(`[ensureCandidatesForPageWithStrategy] ⚠️ Retry ${attempt}/${MAX_BRANCHING_RETRIES} for action "${action.text}":`, error);
            },
            // Stop retrying if error is non-retryable (e.g. validation errors)
            shouldRetry: (error) => {
              try {
                const err = error as ErrorWithCustomProperties;
                if (err.shouldRetry === false || err.code === 'INVALID_ACTION') {
                  console.warn(`[ensureCandidatesForPageWithStrategy] ⛔ Non-retryable error detected:`, getErrorMessage(error));
                  return false;
                }
                console.warn(`[ensureCandidatesForPageWithStrategy] ❓ Should retry for this error?`, getErrorMessage(error));
                return true;
              } catch {
                return true;
              }
            }
          }
        ).catch(error => {
          lastError = error;
        });

        // Process the result (success or failure)
        if (candidatePage) {
          // Success: update the action with the destination
          console.log(`[ensureCandidatesForPageWithStrategy] ✅ Pre-generated destination page for: ${letter}.`, action.text);
          updateActionWithDestination(action, candidatePage);

          // Notify progress callback of success
          onActionProgress(action, 'completed', candidatePage);
        } else {
          // Handle failed generation
          const isInvalidAction = isInvalidActionError(lastError);

          if (isInvalidAction) {
            console.error(`[ensureCandidatesForPageWithStrategy] ❌ Invalid action "${action.text}" detected, removing from actions`);
            // Track removed action using clean Set-based approach
            const existingIndex = actionIndexMap.get(action.text);
            if (existingIndex !== undefined) {
              removedActionTexts.add(action.text);
              hasRealChanges = true;
              // Remove from map immediately
              actionIndexMap.delete(action.text);
            }
          } else {
            console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to generate candidate for valid action ${letter}. ${action.text}:`, getErrorMessage(lastError));
          }

          // Notify progress callback of failure
          onActionProgress(action, 'failed', undefined, lastError);
        }
      }
    }

    // Filter out removed actions and rebuild action index map before DB operations
    filterRemovedActionsAndRebuildMap();

    // Summarize results and decide whether we need to persist changes back to DB
    const pendingAfter = updatedDBActions.filter(action => !action.destination?.pageId).length;
    const succeededCount = updatedDBActions.length - pendingAfter;
    console.log(`[ensureCandidatesForPageWithStrategy] ✅ Pre-generated pages: ${succeededCount}/${updatedDBActions.length} actions${pendingAfter > 0 ? '' : ' (COMPLETED)'}`);
    if (pendingAfter > 0) console.warn(`[ensureCandidatesForPageWithStrategy] ⚠️ ${pendingAfter} still pending for candidate page generation`);

    // Ensure there's at least one navigable action on the page.
    // If all were removed as invalid, insert a 'Continue' action for navigating to the next page.
    if (updatedDBActions.length === 0) {
      console.warn(`[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.`);
      updatedDBActions.push({
        text: "Continue.",
        type: "other",
        hint: {
          text: "See what happens next.",
          type: "none"
        },
        destination: {}, // Will be pre-generated on next run
        _isFallback: true // Sentinel flag to prevent retry loops
      });
      hasRealChanges = true;
    }
    
    // If nothing changed compared to rechecked state, return the current mapped page to avoid a DB update.
    const shouldUpdate = hasRealChanges || pendingAfter !== recheckedPendingDBActions.length;
    if (!shouldUpdate) return currentPage;

    // Persist the updated actions, clear the generating timestamp and update pending count atomically.
    const updatedPage = await dbWrite
      .update(pages)
      .set({
        actions: updatedDBActions,
        pendingGenerationCount: pendingAfter,
        isGeneratingStartedAt: null,
        updatedAt: new Date()
      })
      .where(eq(pages.id, page.id))
      .returning();

    console.log(`[ensureCandidatesForPageWithStrategy] 🔓 Cleared isGeneratingStartedAt for page ${page.id}`);
    const dbPage = updatedPage[0] || null;
    return dbPage ? await mapToUserStoryPage(dbPage, userId) : null;
  }, 270); // 270-second (4.5-minute) lock TTL to align with Vercel timeout

  // If lock succeeded, return its result
  if (lockResult) return lockResult || page;
  
  // Otherwise, fetch and return the freshest page state
  console.log(`[ensureCandidatesForPageWithStrategy] ⚠️ Lock not acquired - another worker is processing page ${page.id}. Returning fresh page state.`);
  try {
    const fresh = await getPageFromDB(page.id, { client: dbWrite });
    return fresh ? await mapToUserStoryPage(fresh, userId) : page;
  } catch (err) {
    console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to read fresh page after lock failure:`, getErrorMessage(err));
    return page;
  }
}

/**
 * Triggers GitHub workflow for on-demand candidate generation
 * 
 * This function dispatches the retry-pending-generations workflow via GitHub REST API,
 * which runs in GitHub Actions with extended timeout (30 minutes) and full environment access.
 * 
 * This is the recommended approach for Express.js deployments where Vercel's waitUntil is unavailable.
 * 
 * **Idempotency**: This function is idempotent per pageId - it checks if generation is already
 * in progress (isGeneratingStartedAt not null) and returns early if so. It sets isGeneratingStartedAt
 * to now() before triggering the workflow to prevent duplicate triggers.
 * 
 * **Cleanup**: The cron job (retry-pending-generations.ts) is responsible for resetting
 * isGeneratingStartedAt to null when generation completes or fails.
 * 
 * @param params - Workflow trigger parameters
 * @param params.bookId - Book ID to trigger generation for
 * @param params.pageId - Page ID to trigger generation for
 * @param params.userId - User ID who triggered the generation
 * @param params.context - Context for logging (defaults to 'github-workflow-trigger')
 * 
 * @returns Promise<{ success: boolean; error?: string; alreadyInProgress?: boolean }> - Workflow dispatch result
 * 
 * @example
 * ```typescript
 * const result = await triggerGitHubWorkflow({
 *   bookId: 'book123',
 *   pageId: 'page456',
 *   userId: 'user789',
 *   context: 'GET /candidates'
 * });
 * 
 * if (result.success) {
 *   console.log('Workflow triggered successfully');
 * } else if (result.alreadyInProgress) {
 *   console.log('Generation already in progress');
 * } else {
 *   console.error('Failed to trigger workflow:', result.error);
 * }
 * ```
 */
export async function triggerGitHubWorkflow(params: {
  bookId: string;
  pageId: string;
  userId: string;
  context?: string;
}): Promise<{ success: boolean; error?: string; alreadyInProgress?: boolean }> {
  const { bookId, pageId, userId, context = 'github-workflow-trigger' } = params;
  console.log(`[${context}] 🚀 Triggering GitHub workflow for page ${pageId}`);

  try {
    // Check if generation is already in progress (idempotency check)
    const dbPage = await getPageFromDB(pageId, { client: dbWrite });
    if (!dbPage) {
      console.error(`[${context}] ❌ Page ${pageId} not found`);
      return { success: false, error: 'Page not found' };
    }

    if (dbPage.isGeneratingStartedAt) {
      console.log(`[${context}] ⏳ Generation already in progress for page ${pageId} (started at ${dbPage.isGeneratingStartedAt})`);
      return { success: true, alreadyInProgress: true };
    }

    // Set isGeneratingStartedAt to now() to mark generation as in progress
    await dbWrite.update(pages)
      .set({ isGeneratingStartedAt: new Date() })
      .where(eq(pages.id, pageId));
    console.log(`[${context}] ⏰ Set isGeneratingStartedAt for page ${pageId}`);

    // Get GitHub token from environment
    const githubToken = process.env.GITHUB_WORKFLOW_TOKEN;
    if (!githubToken) {
      console.error(`[${context}] 💀 GITHUB_WORKFLOW_TOKEN not configured`);
      // Reset isGeneratingStartedAt since we can't trigger the workflow
      await dbWrite.update(pages)
        .set({ isGeneratingStartedAt: null })
        .where(eq(pages.id, pageId));
      return { success: false, error: 'GitHub workflow token not configured' };
    }

    // Trigger workflow via GitHub REST API
    const workflowResponse = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/retry-pending-generations.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Twistloom-Backend'
        },
        body: JSON.stringify({
          ref: GITHUB_DEFAULT_BRANCH,
          inputs: {
            book_id: bookId,
            page_id: pageId,
            triggered_by: userId
          }
        })
      }
    );

    if (!workflowResponse.ok) {
      const errorText = await workflowResponse.text();
      console.error(`[${context}] ❌ GitHub API error:`, {
        status: workflowResponse.status,
        statusText: workflowResponse.statusText,
        body: errorText
      });
      // Reset isGeneratingStartedAt since workflow trigger failed
      await dbWrite.update(pages)
        .set({ isGeneratingStartedAt: null })
        .where(eq(pages.id, pageId));
      return {
        success: false,
        error: `GitHub API error: ${workflowResponse.status} ${workflowResponse.statusText}`
      };
    }

    console.log(`[${context}] 🚀 GitHub workflow triggered successfully for page ${pageId} (book: ${bookId}, user: ${userId})`);
    return { success: true };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[${context}] ❌ Failed to trigger GitHub workflow:`, errorMessage);
    // Reset isGeneratingStartedAt on error to allow retry
    try {
      await dbWrite.update(pages)
        .set({ isGeneratingStartedAt: null })
        .where(eq(pages.id, pageId));
    } catch (resetError) {
      console.error(`[${context}] ⚠️ Failed to reset isGeneratingStartedAt:`, getErrorMessage(resetError));
    }
    return { success: false, error: errorMessage };
  }
}