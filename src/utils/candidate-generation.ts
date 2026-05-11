/**
 * Shared validation and utility functions for candidate generation
 * 
 * This module extracts common validation logic used by both synchronous
 * and asynchronous candidate generation functions to eliminate code duplication.
 */

import { getBook, getPageFromDB, getStoryPageById, mapToUserStoryPage } from '../services/book.js';
import { MAX_BRANCHING_PREGENERATION_DEPTH, MAX_BRANCHING_RETRIES } from '../config/story.js';
import type { UserStoryPage, StoryState, Action, ActionedStoryPage, PersistedStoryPage } from '../types/story.js';
import type { Book } from '../types/book.js';
import type { ActionProgressCallback, CandidateGenerationResult, CandidateGenerationStrategy, GenerateCandidatePageParams, GenerateCandidatesInParallelParams, GenerationStrategy } from '../types/candidates.js';
import { getErrorMessage } from './error.js';
import { dbWrite } from '../db/client.js';
import { pages } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { LOCK_KEYS, withLock } from './distributed-lock.js';
import { enqueueCandidateGenerationJob } from './candidate-generation-async.js';
import { createNonRetryableError, type ErrorWithCustomProperties, retryWithBackoffOrNull } from './retry.js';
import { generateNextPage } from './prompt.js';
import { getStoryStateWithBranch } from '../services/story-branch.js';
import { getStoryProgress, getUserSession } from '../services/story.js';
import { isValidUuid } from './uuid.js';
import { generateId } from './uuid.js';

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
  book?: Book | null;
  /** Actions that need generation */
  pendingActions: Action[];
  /** Current depth for generation */
  currentDepth: number;
  /** Maximum depth for generation */
  maxDepth: number;
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
 * const validation = await validateCandidateGeneration(userId, page, book);
 * if (!validation.canGenerate) {
 *   console.log(validation.reason);
 *   return;
 * }
 * // Proceed with generation using validation.pendingActions
 * ```
 */
export async function validateCandidateGeneration(
  userId: string,
  page: UserStoryPage,
  currentBook: Book | null = null,
  currentState?: StoryState | null,
  options: {
    currentDepth?: number;
    maxDepth?: number;
  } = {}
): Promise<CandidateGenerationValidation> {
  const { currentDepth = 1, maxDepth = MAX_BRANCHING_PREGENERATION_DEPTH } = options;
  
  // Resolve book context if not provided
  if (!currentBook) {
    try {
      currentBook = await getBook(page.bookId);
    } catch (error) {
      console.error(`[validateCandidateGeneration] ❌ Failed to fetch book ${page.bookId}:`, error);
    }
  }

  // Early exit: skip if book not found
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
    (!action.destination?.pageId || !action.destination?.branchId) && 
    !action._isFallback // Skip fallback actions that already failed
  );
  
  if (pendingActions.length === 0) {
    return {
      canGenerate: false,
      reason: 'No actions need candidate generation',
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
    (!action.destination?.pageId || !action.destination?.branchId) && 
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
 * @returns Generation strategy configuration
 */
export function getGenerationStrategy(context: CandidateGenerationStrategy = 'vercel'): GenerationStrategy {
  switch (context) {
    case 'vercel':
      return {
        useParallel: true,
        enforceVercelLimits: true,
        customTimeoutMs: undefined // Use calculated timeout
      };
    
    case 'github-action':
      return {
        useParallel: false, // Sequential for reliability
        enforceVercelLimits: false, // No Vercel limits in GitHub Actions
        customTimeoutMs: 600000 // 10 minutes for GitHub Actions
      };
    
    case 'cron':
      return {
        useParallel: true, // Parallel for efficiency
        enforceVercelLimits: false, // No Vercel limits in cron
        customTimeoutMs: 900000 // 15 minutes for cron jobs
      };
    
    default:
      return {
        useParallel: true,
        enforceVercelLimits: true
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
  const { userId, action: actionCandidate, currentState: providedState, currentBook: providedBook, generateNewBranchId } = params;
  let { currentPage } = params;

  // Check for invalid actions (will be removed)
  if (!actionCandidate.text) {
    throw createNonRetryableError(
      `Invalid action: no text`,
      'INVALID_ACTION'
    );
  }

  // 1. Get current story progress (book, page, state, session) in parallel
  // Use provided state if available, otherwise fetch from database
  let currentState = providedState;
  let currentBook: Book | null = providedBook ?? null;
  // let currentSession: UserSession | null = null;

  if (!currentState) {
    console.log(`[generateCandidatePage] 👀 No state provided, reconstructing from parent page...`);
    // For candidate generation, always reconstruct state from parent page to avoid
    // cross-branch contamination. Don't use getStoryProgress which relies on session
    // that may point to a different branch's page.
    const { parentId: parentPageId, bookId } = currentPage || {};
    if (parentPageId && bookId) {
      currentState = await getStoryStateWithBranch(userId, bookId, parentPageId);
      
      // Add error handling for getBook call
      try {
        currentBook ??= await getBook(bookId);
      } catch (err) {
        console.error(`[generateCandidatePage] ❌ Failed to fetch book ${bookId}:`, getErrorMessage(err));
        throw new Error(`Failed to fetch book ${bookId} for candidate generation`, { cause: err });
      }
      
      console.log(`[generateCandidatePage] 🧩 Reconstructed state from parent page ${parentPageId}`);
    } else {
      // No parent (root page), use getStoryProgress as fallback
      console.log(`[generateCandidatePage] ⚠️ No parent page, using getStoryProgress fallback...`);
      const progress = await getStoryProgress(userId, currentBook?.id, currentPage?.id);
      currentBook ??= progress.book ?? null;
      currentPage ??= progress.page;
      console.log(`[generateCandidatePage] 🧩 getStoryProgress session:`, progress.session);
      console.log(`[generateCandidatePage] 🧩 getStoryProgress state:`, progress.state);
      console.log(`[generateCandidatePage] 🧩 getStoryProgress currentPage?.page:`, currentPage?.page);
      currentState = progress.state;
      // currentSession = progress.session ?? null;
    }
  } else if (!currentBook) {
    // If state is provided but book is not, try to get it from session
    const session = await getUserSession(userId);
    // currentSession = session ?? null;
    if (session) {
      // Add error handling for getBook call
      try {
        currentBook = await getBook(session.bookId) ?? null;
      } catch (err) {
        console.error(`[generateCandidatePage] ❌ Failed to fetch book ${session.bookId} from session:`, getErrorMessage(err));
        // Continue with null book rather than throwing to allow graceful degradation
        currentBook = null;
      }
    }
  }

  // 2. Validate all required components exist for story progression
  // Book is required (provided directly for system-generated originals, or fetched from session for user navigation)
  // Session is optional, not available during background process using system user ID (generate originals, retry pending generations)
  // Except it's manually triggered via user navigation (GET /api/books/:identifier/:pageId/candidates)
  if (!currentBook) throw new Error(`No active book found for user ${userId}`);
  if (!currentPage) throw new Error(`No page found for user ${userId} (bookId: ${currentBook.id})`);
  if (!currentState) throw new Error(`No state found for user ${userId} (pageId: ${currentPage.id})`);

  // Use session bookId if available, otherwise use provided book
  // const { bookId } = currentSession ?? { bookId: currentBook.id };

  // 3. Match actionText against current page actions to get full Action object
  const action = currentPage.actions.find(a => a.text === actionCandidate.text && a.type === actionCandidate.type);
  if (!action) {
    throw new Error(`Action "${actionCandidate.text}" not found in current page actions`);
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
            
            // Convert PersistedStoryPage to UserStoryPage for background generation
            // Validate required fields before casting
            if (!candidatePage.id || !candidatePage.bookId || !candidatePage.branchId) {
              console.error(`[generateCandidatesInParallel] ❌ Invalid candidate page missing required fields:`, {
                id: candidatePage.id,
                bookId: candidatePage.bookId,
                branchId: candidatePage.branchId
              });
              return;
            }
            
            const candidateUserPage: UserStoryPage = {
              ...candidatePage,
              selectedActions: []
            };
            
            // Trigger next level generation without blocking current response (fire-and-forget)
            // void ensureCandidatesForPageWithDepth(userId, candidateUserPage, null, currentBook, currentDepth + 1, maxDepth, options).catch(error => {
            //   console.error(`[generateCandidatesInParallel] ❌ Background generation failed for depth ${currentDepth + 1}:`, getErrorMessage(error));
            // });

            // Calculate proper state for deeper level generation
            // This ensures advanceStoryState increments to correct page number and uses updated context
            const candidateState = await getStoryStateWithBranch(userId, candidatePage.bookId, candidatePage.id);
            
            // Trigger next level generation via job queue (async, no timeouts)
            void enqueueCandidateGenerationJob(userId, candidateUserPage, currentBook, candidateState, {
              currentDepth: currentDepth + 1,
              maxDepth,
              priority: 5 // Lower priority for deeper levels
            }).catch(error => {
              console.error(`[generateCandidatesInParallel] ❌ Failed to enqueue generation job for depth ${currentDepth + 1}:`, getErrorMessage(error));
            });
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
 * Pre-generates candidate pages for all actions on a story page with depth control
 * 
 * This is the internal function that handles multi-level pre-generation with depth control.
 * It's used by the fire-and-forget background processing for deeper levels.
 * 
 * @deprecated Now uses `enqueueCandidateGenerationJob` pg-boss job queue system.
 * @see {@link ../../docs/ASYNC_CANDIDATE_GENERATION_ARCHITECTURE.md}
 * 
 * The replacement is superior because:
 * - No timeout issues: Jobs run in background via cron
 * - Better reliability: pg-boss handles retries and failures
 * - Scalability: Can process multiple jobs concurrently
 * - Monitoring: Job queue provides better observability
 * 
 * @param userId - The user's unique identifier for database operations
 * @param page - The story page whose actions need candidate generation
 * @param currentState - Optional story state for the page
 * @param currentBook - Optional book context
 * @param currentDepth - Current depth level (1-based)
 * @param maxDepth - Maximum depth to generate
 */
export async function ensureCandidatesForPageWithDepth(
  userId: string, 
  page: UserStoryPage, 
  currentState: StoryState | null | undefined, 
  currentBook: Book | null,
  currentDepth: number,
  maxDepth: number,
  options?: {
    onProgress?: ActionProgressCallback;
  }
): Promise<void> {
  const { onProgress } = options || {};

  // Track request start time for timeout calculation
  const requestStartTime = Date.now();

  // Validate page ID before proceeding
  if (!isValidUuid(page.id)) {
    console.error(`[ensureCandidatesForPageWithDepth] ❌ Invalid page ID (must be uuid v7)`);
    return;
  }

  // Skip if depth limit reached
  if (currentDepth > maxDepth) {
    console.log(`[ensureCandidatesForPageWithDepth] ⏩ Depth limit reached (${currentDepth}/${maxDepth}), skipping generation`);
    return;
  }

  // Skip if no actions need generation (exclude fallback actions to prevent retry loops)
  const pendingActions = page.actions.filter(action => 
    (!action.destination?.pageId || !action.destination?.branchId) && 
    !action._isFallback // Skip fallback actions that already failed
  );
  if (pendingActions.length === 0) {
    console.log(`[ensureCandidatesForPageWithDepth] ✨ No actions need generation at depth ${currentDepth}`);
    return;
  }
  
  console.log(`[ensureCandidatesForPageWithDepth] ⏳ Depth ${currentDepth}/${maxDepth}: ${pendingActions.length} actions need candidate generation`);

  // Use distributed lock to prevent concurrent processing of the same page
  const lockKey = LOCK_KEYS.CANDIDATE_GENERATION(page.id);
  await withLock(lockKey, async () => {
    // Read current page state
    const currentDBPage = await getPageFromDB(page.id, { client: dbWrite });
    if (!currentDBPage) throw new Error('Page not found');

    // Map DB row to the user-facing page shape
    const currentPage = await mapToUserStoryPage(currentDBPage, userId);
    const initialDBActions = currentDBPage.actions;

    // Re-check pending actions after acquiring lock
    const recheckedPendingDBActions = initialDBActions.filter(action => !action.destination?.pageId || !action.destination?.branchId);
    if (recheckedPendingDBActions.length === 0) {
      console.log(`[ensureCandidatesForPageWithDepth] ⏩ Actions already processed by another instance at depth ${currentDepth}`);
      return;
    }

    // Mark page as generating
    await dbWrite
      .update(pages)
      .set({ isGeneratingStartedAt: new Date() })
      .where(eq(pages.id, page.id));

    // Track if any actions were actually updated
    const updatedDBActions = [...initialDBActions];
    const generateNewBranchId = recheckedPendingDBActions.length < initialDBActions.length;
    let hasRealChanges = false;
    
    // Calculate dynamic timeout for background processing (more generous for background)
    const BACKGROUND_TIMEOUT_MS = 180000; // 3 minutes for background
    const timeElapsed = Date.now() - requestStartTime;
    const AI_GENERATION_TIMEOUT_MS = Math.max(BACKGROUND_TIMEOUT_MS - timeElapsed - 5000, 30000); // Min 30s
    
    // Generate candidates in parallel
    const generationResults = await generateCandidatesInParallel({
      userId,
      actions: recheckedPendingDBActions,
      currentPage,
      currentState,
      currentBook,
      initialGenerateNewBranchId: generateNewBranchId,
      timeoutMs: AI_GENERATION_TIMEOUT_MS,
      currentDepth,
      maxDepth,
      onProgress
    });
    
    // Process results and update actions
    for (let i = 0; i < generationResults.length; i++) {
      const result = generationResults[i];
      const action = result.action;
      
      if (result.success && result.candidatePage) {
        // Success: update action with destination
        const actionIndex = updatedDBActions.findIndex(a => a.text === action.text && a.type === action.type);
        if (actionIndex !== -1) {
          updatedDBActions[actionIndex] = { 
            ...action, 
            destination: { 
              branchId: result.candidatePage.branchId, 
              pageId: result.candidatePage.id 
            } 
          };
          hasRealChanges = true;
        }
        // Note: generateNewBranchId logic not used in background processing
        // as each action generates independently without affecting others
      } else {
        // Failed: check if it was a validation error before removing
        const isInvalidAction = result.error && (
          (result.error as ErrorWithCustomProperties).code === 'INVALID_ACTION' ||
          (result.error as ErrorWithCustomProperties).shouldRetry === false
        );
        
        if (isInvalidAction) {
          console.error(`[ensureCandidatesForPageWithDepth] ❌ Invalid action "${action.text}" detected, removing from actions`);
          const actionIndex = updatedDBActions.findIndex(a => a.text === action.text && a.type === action.type);
          if (actionIndex !== -1) {
            updatedDBActions.splice(actionIndex, 1);
            hasRealChanges = true;
          }
        }
      }
    }

    // Summarize results
    const pendingAfter = updatedDBActions.filter(action => !action.destination?.pageId).length;
    const succeededCount = updatedDBActions.length - pendingAfter;
    console.log(`[ensureCandidatesForPageWithDepth] ✅ Depth ${currentDepth}: ${succeededCount}/${updatedDBActions.length} actions generated`);

    // Ensure there's at least one navigable action
    if (updatedDBActions.length === 0) {
      console.warn(`[ensureCandidatesForPageWithDepth] ⚠️ All actions are invalid, replaced with 1 continue action.`);
      updatedDBActions.push({
        id: generateId(), // Add stable ID
        text: "Continue.",
        type: "other",
        hint: {
          text: "See what happens next.",
          type: "none"
        },
        destination: {},
        _isFallback: true // Sentinel flag to prevent retry loops
      });
      hasRealChanges = true;
    }
    
    // Update database if changes were made
    if (hasRealChanges) {
      await dbWrite
        .update(pages)
        .set({
          actions: updatedDBActions,
          pendingGenerationCount: pendingAfter,
          isGeneratingStartedAt: null,
          updatedAt: new Date()
        })
        .where(eq(pages.id, page.id));
    } else {
      // Clear generation flag even if no changes
      await dbWrite
        .update(pages)
        .set({ isGeneratingStartedAt: null })
        .where(eq(pages.id, page.id));
    }
  }, 600); // 10-minute lock for background processing
}

/**
 * Core candidate generation implementation with configurable strategy
 * 
 * This function consolidates the logic for both parallel and non-parallel generation
 * by using a strategy pattern to determine the generation approach.
 * 
 * @param userId - The user's unique identifier
 * @param page - The story page to process
 * @param currentState - Optional story state
 * @param currentBook - Optional book context
 * @param context - Generation context
 * 
 * @returns Promise<UserStoryPage> - The updated page with generated candidates
 */
export async function ensureCandidatesForPageWithStrategy(
  userId: string, 
  page: UserStoryPage, 
  currentState?: StoryState | null, 
  currentBook?: Book | null,
  context: CandidateGenerationStrategy = 'vercel',
  options?: {
    onProgress?: ActionProgressCallback;
  }
): Promise<UserStoryPage> {
  const { onProgress } = options || {};

  // Use shared validation to eliminate redundant checks
  const validation = await validateCandidateGeneration(userId, page, currentBook, currentState);
  
  if (!validation.canGenerate) {
    console.log(`[ensureCandidatesForPageWithStrategy] ⏩ ${validation.reason}`);
    return page;
  }

  // Extract validated context
  currentBook = validation.book!;
  const pendingActions = validation.pendingActions;
  const { currentDepth, maxDepth } = validation;
  
  console.log(`[ensureCandidatesForPageWithStrategy] ⏳ ${pendingActions.length} actions need candidate page generation (${context})`);

  // Get generation strategy based on context
  const strategy = getGenerationStrategy(context);
  const timeoutMs = calculateGenerationTimeout(strategy);
  
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
      (!action.destination?.pageId || !action.destination?.branchId) && 
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
    const updatedDBActions = [...initialDBActions];
    const generateNewBranchId = recheckedPendingDBActions.length < initialDBActions.length;
    let hasRealChanges = false;

    // Build action index map for O(1) lookups (prevents O(n²) performance)
    const actionIndexMap = new Map(
      initialDBActions.map((action, index) => [action.id, index])
    );

    // Helper functions for DRY code
    /**
     * Generate letter mapping for action (A, B, C, etc.)
     */
    function generateActionLetter(action: Action): string {
      const actionIndex = actionIndexMap.get(action.id) ?? 0;
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
     * Update action with destination page using O(1) Map lookup
     */
    function updateActionWithDestination(
      action: Action, 
      candidatePage: PersistedStoryPage, 
    ): void {
      const actionIndex = actionIndexMap.get(action.id) ?? -1;
      if (actionIndex !== -1) {
        updatedDBActions[actionIndex] = { 
          ...action, 
          destination: { 
            branchId: candidatePage.branchId, 
            pageId: candidatePage.id 
          } 
        };
        hasRealChanges = true;
      }
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
        onProgress?.(action, 'completed', result.candidatePage);
      } else {
        // Handle failed generation
        const isInvalidAction = isInvalidActionError(result.error);
        
        if (isInvalidAction) {
          console.error(`[ensureCandidatesForPageWithStrategy] ❌ Invalid action "${action.text}" detected, removing from actions`);
          const actionIndex = actionIndexMap.get(action.id) ?? -1;
          if (actionIndex !== -1) {
            updatedDBActions.splice(actionIndex, 1);
            hasRealChanges = true;
          }
        } else {
          console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to generate candidate for valid action ${letter}. ${action.text}:`, getErrorMessage(result.error));
        }
        
        // Notify progress callback of failure
        onProgress?.(action, 'failed', undefined, result.error);
      }
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
        onProgress
      });
      
      // Process parallel results using helper functions
      for (let i = 0; i < generationResults.length; i++) {
        const result = generationResults[i];
        const letter = generateActionLetter(result.action);
        processActionResult(result, letter);
      }
    } else {
      // Sequential generation (for GitHub Actions) using helper functions
      for (const action of recheckedPendingDBActions) {
        const letter = generateActionLetter(action);
        console.log(`[ensureCandidatesForPageWithStrategy] ⏳ Pre-generating destination page for: ${letter}.`, action.text);
        
        // Notify progress callback of action start
        onProgress?.(action, 'started');
        
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
            generateNewBranchId
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
          onProgress?.(action, 'completed', candidatePage);
        } else {
          // Handle failed generation
          const isInvalidAction = isInvalidActionError(lastError);
          
          if (isInvalidAction) {
            console.error(`[ensureCandidatesForPageWithStrategy] ❌ Invalid action "${action.text}" detected, removing from actions`);
            const actionIndex = actionIndexMap.get(action.id) ?? -1;
            if (actionIndex !== -1) {
              updatedDBActions.splice(actionIndex, 1);
              hasRealChanges = true;
            }
          } else {
            console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to generate candidate for valid action ${letter}. ${action.text}:`, getErrorMessage(lastError));
          }
          
          // Notify progress callback of failure
          onProgress?.(action, 'failed', undefined, lastError);
        }
      }
    }

    // Summarize results and decide whether we need to persist changes back to DB
    const pendingAfter = updatedDBActions.filter(action => !action.destination?.pageId).length;
    const succeededCount = updatedDBActions.length - pendingAfter;
    console.log(`[ensureCandidatesForPage] ✅ Pre-generated pages: ${succeededCount}/${updatedDBActions.length} actions${pendingAfter > 0 ? '' : ' (COMPLETED)'}`);
    if (pendingAfter > 0) console.warn(`[ensureCandidatesForPage] ⚠️ ${pendingAfter} still pending for candidate page generation`);

    // Ensure there's at least one navigable action on the page.
    // If all were removed as invalid, insert a 'Continue' action for navigating to the next page.
    if (updatedDBActions.length === 0) {
      console.warn(`[ensureCandidatesForPageWithDepth] ⚠️ All actions are invalid, replaced with 1 continue action.`);
      updatedDBActions.push({
        id: generateId(), // Add stable ID
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

    console.log(`[ensureCandidatesForPage] 🔓 Cleared isGeneratingStartedAt for page ${page.id}`);
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
 * Wrapper function for Vercel environment (parallel generation with timeout limits)
 * 
 * This is the main function used in Vercel serverless functions.
 * It uses parallel generation and respects Vercel's 5-minute timeout limit.
 */
export async function ensureCandidatesForPage(userId: string, page: UserStoryPage, currentState?: StoryState | null, currentBook?: Book | null): Promise<UserStoryPage> {
  return ensureCandidatesForPageWithStrategy(userId, page, currentState, currentBook, 'vercel');
}

/**
 * Wrapper function for GitHub Actions environment (sequential generation, no timeout limits)
 * 
 * This function is designed for GitHub Actions workflows where we have:
 * - No Vercel timeout constraints
 * - Sequential generation for better reliability
 * - Longer timeout tolerance (10+ minutes)
 */
export async function ensureCandidatesForPageGitHubAction(userId: string, page: UserStoryPage, currentState?: StoryState | null, currentBook?: Book | null): Promise<UserStoryPage> {
  return ensureCandidatesForPageWithStrategy(userId, page, currentState, currentBook, 'github-action');
}

/**
 * Wrapper function for cron job environment (parallel generation, no timeout limits)
 * 
 * This function is used by Vercel cron jobs for background processing.
 * It uses parallel generation for efficiency and has relaxed timeout constraints.
 */
export async function ensureCandidatesForPageCron(userId: string, page: UserStoryPage, currentState?: StoryState | null, currentBook?: Book | null): Promise<UserStoryPage> {
  return ensureCandidatesForPageWithStrategy(userId, page, currentState, currentBook, 'cron');
}
