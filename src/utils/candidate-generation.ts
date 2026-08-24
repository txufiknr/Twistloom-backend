/**
 * Candidate generation: validation, strategy execution, and progress tracking.
 *
 * Responsibilities
 * - Validates whether a page needs generation (last page, depth limit, pending actions)
 * - Chooses a generation strategy (parallel for Vercel/cron, sequential for GitHub Actions)
 * - Runs AI generation with retry logic and distributed locking
 * - Persists `destinationPageIds` per-action as each completes so polling sees progress
 * - Stores per-action progress events for the `/candidates/status` endpoint
 * - Triggers deeper-level pre-generation for successfully generated candidate pages
 * - Handles stuck-generation detection and reset
 *
 * ── Book Mode Branching Contracts ─────────────────────────────────────────
 * The book's `mode` field controls how many actions a page may carry and how
 * many destination pages each action may link to.  Enforcement is layered
 * across prompt instructions, pre-AI candidate-count clamping, and post-AI
 * destination-write capping — all defined in `book-mode.ts`.
 *
 * Novel (linear, single-path)
 *   Action count  : EXACTLY 1 action per page.
 *   Destination   : The one action has exactly 1 `destinationPageId`.
 *   Rationale     : A strictly linear story that reads as one continuous,
 *                   inevitable progression. No branching choices.
 *   Enforcement   : `sanitizeActionsForMode` truncates excess actions at
 *                   page-insert time; novel-mode guard in
 *                   `ensureCandidatesForPageWithStrategy` forces the parent
 *                   page to 1 action before any candidate generation runs.
 *
 * Interactive (reader-choice, single-path per choice)
 *   Action count  : 2–3 branching actions per page (AI decides, capped at
 *                   `MAX_ACTIONS_PER_PAGE`).
 *   Destination   : EVERY action has exactly 1 `destinationPageId` — each
 *                   choice leads to exactly one next page.
 *   Rationale     : The reader shapes ONE path through the book. Choices are
 *                   meaningful but never fork into parallel timelines.
 *   Enforcement   : `clampCandidateCountForMode` requests only 1 candidate
 *                   per action; `enforceModeOnActionDestinations` ensures
 *                   only 1 destination is persisted.
 *
 * Multiverse (parallel timelines, multiple fates)
 *   Action count  : 2–3 branching actions per page (AI decides, capped at
 *                   `MAX_ACTIONS_PER_PAGE`).
 *   Destination   : Unlimited `destinationPageIds` per action (practical cap:
 *                   `MAX_CANDIDATE_PAGE_PER_ACTION = 3`).
 *   Rationale     : Each action unfolds into multiple alternate-fate
 *                   continuations — parallel timelines that diverge into
 *                   distinct, unexpected outcomes.
 *   Enforcement   : `maxDestinationsPerActionForMode` returns `Infinity`;
 *                   only the caller-configured `candidateCount` limits the
 *                   actual number generated.
 *
 * Key design: write-chain serialisation
 * In parallel mode multiple AI calls complete concurrently. `onActionProgress` uses a
 * shared promise chain to serialise DB writes so no completed action is lost to a
 * concurrent overwrite of the `actions` JSONB column.
 */

import { getBook, getBookFromDB, getPageFromDB, getStoryPageById, mapToPersistedStoryPage, mapToUserStoryPage } from '../services/book.js';
import { MAX_BRANCHING_PREGENERATION_DEPTH, MAX_BRANCHING_RETRIES } from '../config/story.js';
import { GITHUB_REPO_CONFIG } from '../config/env.js';
import type { UserStoryPage, Action, PersistedStoryPage } from '../types/story.js';
import type { Book } from '../types/book.js';
import type { ActionProgressCallback, CandidateGenerationPage, CandidateGenerationPageValidation, CandidateGenerationResult, CandidateGenerationStrategy, CandidateGenerationValidation, GenerateCandidatePageParams, GenerateCandidatesInParallelParams, GenerateCandidatesOptions, GenerateCandidatesWithStrategyParams, GenerationStrategy } from '../types/candidate-generation.js';
import { classifyGenAIError, getErrorMessage, isGenAIErrorRetryable } from './error.js';
import { dbWrite } from '../db/client.js';
import { pages } from '../db/schema.js';
import { clearActionProgressEvents, storeActionProgressEvent } from './progress-tracking.js';
import { eq } from 'drizzle-orm';
import { LOCK_KEYS, withLock } from './distributed-lock.js';
import { createNonRetryableError, type ErrorWithCustomProperties, retryWithBackoffOrNull } from './retry.js';
import { generateNextPages } from './prompt.js';
import { dispatchGitHubWorkflow } from './github-workflow.js';
import { ALLOW_DEEPER_LEVEL_UNTIL_PAGE, MAX_CANDIDATE_PAGE_PER_ACTION, MAX_GENERATION_DURATION_MS, MAX_GENERATION_PARALLEL_DURATION_MS } from '../config/candidate-generation.js';
import { formatDuration } from './formatter.js';
import { delay } from './time.js';
import { isValidUuid } from './uuid.js';
import type { DBPage } from '../types/schema.js';
import { clampCandidateCountForMode, enforceModeOnActionDestinations } from './book-mode.js';
import { deriveActionRisk } from './custom-action.js';

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
  
  console.group('[candidate-generation-metrics] 📊 Performance metrics');
  
  console.table({
    'Actions': metrics.actionCount,
    'Lookup Time': formatDuration(metrics.lookupTime || 0),
    'Generation Time': formatDuration(metrics.generationTime || 0),
    'Success': metrics.successCount,
    'Failures': metrics.failureCount,
    'Timeouts': metrics.timeoutOccurrences,
    'Lock Contentions': metrics.lockContentions,
  });
  
  console.table({
    'Total Generations': globalMetrics.totalGenerations,
    'Total Lookup Time': formatDuration(globalMetrics.totalLookups),
    'Total Timeouts': globalMetrics.totalTimeouts,
    'Total Lock Contentions': globalMetrics.totalLockContentions,
  });
  
  console.groupEnd();
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
  return page.actions.filter(action => !action.destinationPageIds?.length).length;
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

  // Early exit: skip if no actions need generation
  console.log(`[validateCandidateGeneration] 👉 Examining ${page.actions.length} actions from page ${page.page}:`, page.actions.map(a => a.text));
  const pendingActions = page.actions.filter(action => !action.destinationPageIds?.length);
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
  
  // Early exit: skip if no actions need generation
  const pendingActions = page.actions.filter(action => !action.destinationPageIds?.length);
  
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
 * 'vercel': User-facing API requests with immediate response requirements (Hono route)
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
      customTimeoutMs: MAX_GENERATION_PARALLEL_DURATION_MS // 13 minutes for cron jobs (20s buffer)
    };
    
    case 'github-action': return {
      useParallel: false, // Sequential for reliability
      enforceVercelLimits: false, // No Vercel limits in GitHub Actions
      customTimeoutMs: MAX_GENERATION_DURATION_MS // 30 minutes for GitHub Actions
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
  return MAX_GENERATION_DURATION_MS; // 30 minutes
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
export async function generateCandidatePages(params: GenerateCandidatePageParams): Promise<PersistedStoryPage[]> {
  const { userId, action: actionCandidate, currentBook, currentPage, currentState, generateNewBranchId, skipIfAlreadyHasDestinations = true } = params;
  let { candidateCount } = params;
  
  // 1. Validate page context for candidates generation
  if (!currentPage || !currentBook) {
    throw createNonRetryableError('Missing: currentPage and currentBook are required');
  }

  // ── MODE BRANCHING CONTRACT (generation-time gate) ──────────────────────
  // novel / interactive allow only ONE destination per action, so generating
  // multiple candidate pages per action would be wasted work (and the extra
  // destinations are dropped later by enforceModeOnActionDestinations anyway).
  // Clamp the requested candidate count to the mode limit before any AI call.
  const modeClampedCandidateCount = clampCandidateCountForMode(currentBook.mode, candidateCount ?? MAX_CANDIDATE_PAGE_PER_ACTION);
  if ((candidateCount ?? MAX_CANDIDATE_PAGE_PER_ACTION) !== modeClampedCandidateCount) {
    console.log(`[generateCandidatePage] 🔧 Mode "${currentBook.mode}" clamps candidateCount ${candidateCount} → ${modeClampedCandidateCount}`);
  }
  candidateCount = modeClampedCandidateCount;

  // 2. Check for invalid actions (will be removed)
  if (!actionCandidate.text) {
    throw createNonRetryableError(`Invalid action: no text`, 'INVALID_ACTION');
  }

  // 3. Match actionText against current page actions to get full Action object
  const action = currentPage.actions.find(a => a.text === actionCandidate.text);
  if (!action) {
    throw createNonRetryableError(`Action "${actionCandidate.text}" not found in current page actions`, 'ACTION_NOT_FOUND');
  }

  const letter = String.fromCharCode(65 + currentPage.actions.findIndex(a => a.text === action.text));
  const nextPageNumber = currentPage.page + 1;

  console.log(`[generateCandidatePage] 📖 Should generate for "${currentBook.title}" page ${nextPageNumber} from action: ${letter}. ${action.text} (type: ${action.type})`);

  if (currentState?.plotFlags.some(p => p.page === nextPageNumber)) {
    console.warn(`[generateCandidatePage] ⚠️ Unexpected page ${nextPageNumber} is already in plot flags`);
  }

  // 4. Check if next page is pre-generated (candidate) and reuse if available
  const existing = action.destinationPageIds;
  const bookId = currentBook.id;
  const newPages: PersistedStoryPage[] = [];
  const limit = MAX_CANDIDATE_PAGE_PER_ACTION;

  // const selectedAction = mapActionToSelectedAction(action, currentPage.id, currentPage.page, );
  const actionedPage: CandidateGenerationPage = { ...currentPage, action };

  if (existing?.length) {
    if (skipIfAlreadyHasDestinations !== false || existing.length >= limit) {
      // Default path: reuse what's there
      console.log(`[generateCandidatePage] ✅ Using ${existing.length} pre-generated pages`);
      for (const id of existing) {
        const page = await getStoryPageById(userId, bookId, id);
        if (page) newPages.push(page);
      }
    } else {
      // Top-up path: generate the missing alternatives
      // Clamp to the mode limit so novel/interactive never top-up beyond 1.
      const modeLimit = clampCandidateCountForMode(currentBook.mode, limit);
      const needed = Math.min(limit - existing.length, modeLimit);
      console.log(`[generateCandidatePage] 🔁 Topping up ${existing.length}→${existing.length + needed} (generating ${needed} more)`);
      const topUpPages = await generateNextPages({
        userId,
        book: currentBook,
        currentState,
        actionedPage,
        generateNewBranchId: true, // always new branch — first slot is taken
        candidateCount: needed,
      });
      newPages.push(...topUpPages);
    }
  }

  // 5. If no pre-generated page exists, generate new page with state progression
  if (newPages.length) {
    // Candidate: wait until user visit the page and ensure next candidates
    console.log(`[generateCandidatePage] ✅ Using ${newPages.length} pre-generated pages, delta already exists from pre-generation`);
  } else {
    // 6. Generate next page using AI with dynamic configuration
    try {
      const newGeneratedPages = await generateNextPages({
        userId,
        book: currentBook,
        currentState,
        actionedPage,
        generateNewBranchId,
        candidateCount,
      });

      // newPages.splice(0, newPages.length, ...newGeneratedPages);
      newPages.push(...newGeneratedPages);
      console.log(`[generateCandidatePage] 🌌 Generated ${newPages.length} new story pages for ${action.text} (type: ${action.type})`);
    } catch (error) {
      // Check if this is a duplicate destination error (action already has pageId)
      if ((error as ErrorWithCustomProperties).code === 'ACTION_ALREADY_HAS_DESTINATION') {
        console.log(`[generateCandidatePage] ⏭️ Action "${action.text}" already has ${action.destinationPageIds?.length} destination pages, retrieving existing pages`);
        // The action already has a destination, so get the existing page
        if (action.destinationPageIds?.length) {
          for (const existingPageId of action.destinationPageIds) {
            const existingPage = await getStoryPageById(userId, bookId, existingPageId);
            if (existingPage) newPages.push(existingPage);
          }
        }
        if (newPages.length) {
          console.log(`[generateCandidatePage] ✅ Retrieved ${newPages.length} existing pages for action "${action.text}"`);
        }
      } else {
        // Re-throw other errors
        // throw createNonRetryableError(getErrorMessage(error), 'GENERATION_FAILED');
        throw error;
      }
    }
  }

  // 7. Return the generated page with all database metadata
  return newPages;
}

/**
 * Generates candidate pages in parallel for multiple actions.
 *
 * Uses `Promise.allSettled` so failures in one action do not cancel others.
 *
 * Progress notification contract
 * - `'started'` — fired fire-and-forget at the top of each promise (non-blocking).
 * - `'failed'`  — fired awaited inside `.catch()` immediately on failure, before returning.
 *   The caller must NOT fire `'failed'` again (no double-fire).
 * - `'completed'` — delegated entirely to the caller via `onActionComplete`. The caller
 *   is responsible for in-memory mutation, DB write, and progress notification.
 *
 * @param params.onActionComplete - Async hook called on each successful generation.
 *   Receives `(action, candidatePage)`. The caller uses this to trigger `onActionProgress`
 *   which is the SSOT for mutation + serialised write + event emission.
 * @returns Array of results in input order; settled promises never throw.
 */
async function generateCandidatesInParallel(params: GenerateCandidatesInParallelParams): Promise<CandidateGenerationResult[]> {
  const { userId, actions, currentPage, currentState, currentBook, initialGenerateNewBranchId, timeoutMs, currentDepth, maxDepth, onProgress, allowDeeperLevel, onActionComplete, candidateCount } = params;
  const startTime = Date.now();
  const lookupStartTime = Date.now();

  console.log(`[generateCandidatesInParallel] 🚀 Starting parallel generation for ${actions.length} actions at depth ${currentDepth}/${maxDepth}`);
  
  // Create generation promises for each action
  const generationPromises = actions.map(async (action, index) => {
    const letter = String.fromCharCode(65 + index);
    const context = `"${currentBook.title}" page ${currentPage.page + 1} from action: ${letter}. ${action.text} (type: ${action.type})`;
    
    // Notify action start — fire-and-forget intentionally: we don't want the tracking
    // write to delay the AI generation call. Failures here are non-fatal.
    void onProgress?.(action, 'started');
    console.log(`[generateCandidatesInParallel] ⏳ Starting generation for ${context}`);
    
    // Track the last error to determine if action should be removed
    const lastErrorRef = { current: null as unknown };
    
    // Use new branch ID for all but the first action (if initial flag is false)
    // This matches sequential strategy logic: isPartial || generateNewBranchId || index > 0
    const generateNewBranchId = initialGenerateNewBranchId || index > 0;
    
    const candidatePages = await Promise.race([
      retryWithBackoffOrNull(
        () => generateCandidatePages({
          userId,
          action,
          currentPage,
          currentState,
          currentBook,
          generateNewBranchId,
          candidateCount
        }),
        createGenerationRetryOptions('generateCandidatesInParallel', context, lastErrorRef)
      ),
      new Promise<null>((_, reject) => 
        setTimeout(() => {
          console.warn(`[generateCandidatesInParallel] ⏰ AI generation timeout for ${context} after ${timeoutMs}ms`);
          reject(new Error(`AI generation timeout (${timeoutMs}ms)`));
        }, timeoutMs)
      )
    ]).catch(async error => {
      console.error(`[generateCandidatesInParallel] ❌ Generation failed for ${context}:`, getErrorMessage(error));
      lastErrorRef.current = error;
      // Notify failure immediately (awaited so the event is stored before we return).
      // The caller's handleInvalidActionRemoval handles removal logic separately — this
      // is the sole notification call so there is no double-fire.
      try {
        await onProgress?.(action, 'failed', undefined, error);
      } catch (notifyError) {
        console.error(`[generateCandidatesInParallel] ⚠️ Failed to notify failure for ${context}:`, getErrorMessage(notifyError));
      }
      return null;
    }) ?? [];

    // On success, delegate to caller via onActionComplete.
    // The caller's onActionProgress handles: in-memory mutation, serialized DB write, and event emission.
    if (candidatePages) {
      console.log(`[generateCandidatesInParallel] ✅ Completed generation for ${context}`);
      await onActionComplete?.(action, candidatePages);
    }

    return {
      action,
      success: !!candidatePages.length,
      candidatePages,
      error: lastErrorRef.current
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
        candidatePages: [],
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
  const successfulResults = generationResults.filter(r => r.success && !!r.candidatePages.length);
  if (successfulResults.length > 0) {
    const successfulCandidatePages = successfulResults.flatMap(r => r.candidatePages);
    triggerDeeperLevelGeneration(
      successfulCandidatePages,
      currentDepth,
      maxDepth,
      userId,
      currentBook,
      'generateCandidatesInParallel',
      allowDeeperLevel
    );
  }

  return generationResults;
}

/**
 * Triggers fire-and-forget background generation for deeper levels
 * 
 * @param candidatePages - Successfully generated candidate pages to trigger next-level generation for
 * @param currentDepth - Current depth level
 * @param maxDepth - Maximum depth to pre-generate
 * @param userId - User ID for workflow triggering
 * @param currentBook - Current book context
 * @param context - Context string for logging
 */
function triggerDeeperLevelGeneration(
  candidatePages: PersistedStoryPage[],
  currentDepth: number,
  maxDepth: number,
  userId: string,
  currentBook: Book,
  context: string,
  allowDeeperLevel: boolean = false
): void {
  if (currentDepth >= maxDepth || candidatePages.length === 0) return;
  const { id: bookId, title: bookTitle, mode } = currentBook;
  const nextDepth = currentDepth + 1;

  console.log(`[${context}] 👩‍🚀 Starting deeper level generation for "${bookTitle}" with ${candidatePages.length} candidate pages`);
  
  // Process deeper levels in background without waiting
  void Promise.allSettled(
    candidatePages.map(async (candidatePage) => {
      try {
        // Validate required fields
        if (!candidatePage.id || !candidatePage.bookId || !candidatePage.branchId) {
          console.error(`[${context}] ❌ Invalid candidate page missing required fields:`, {
            id: candidatePage.id,
            bookId: candidatePage.bookId,
            branchId: candidatePage.branchId
          });
          return;
        }
        
        const { id: pageId, page: pageNumber, branchId } = candidatePage;
        const jobDetails = { bookTitle, depth: `${nextDepth}/${maxDepth}`, pageId, branchId, pageNumber };
        const pageAllowDeeperLevel = mode === 'novel' || pageNumber <= ALLOW_DEEPER_LEVEL_UNTIL_PAGE;

        // Only trigger if page number <= allowed to prevent too many concurrent workflows
        if (nextDepth <= MAX_BRANCHING_PREGENERATION_DEPTH && (allowDeeperLevel || pageAllowDeeperLevel)) {
          // No need for validation as this is a certain candidate generation for a valid new page
          console.log(`[${context}] 📡 Triggering GitHub Workflow for "${bookTitle}" level ${nextDepth} (page ${pageNumber})`);
          triggerCandidateGenerationWorkflow({
            userId,
            pageId,
            bookId,
            bookTitle,
            maxDepth: maxDepth - currentDepth,
            context: `${context}-${nextDepth}`
          }).catch(error => {
            console.error(`[${context}] ❌ Failed to trigger GitHub workflow for:`, { ...jobDetails, error });
          });
        } else {
          console.log(`[${context}] ⏩ Skipped, let GitHub Workflow do it via the hourly job:`, jobDetails);
        }
      } catch (error) {
        console.error(`[${context}] ❌ Background generation failed for depth ${nextDepth}:`, getErrorMessage(error));
      }
    })
  ).then(results => {
    // Log any rejected promises for monitoring
    const rejectedCount = results.filter(r => r.status === 'rejected').length;
    if (rejectedCount > 0) {
      console.warn(`[${context}] ⚠️ ${rejectedCount} background generation operations failed at depth ${currentDepth + 1}`);
    }
  });
}

/**
 * Shared retry configuration for candidate generation.
 *
 * Both the parallel and sequential paths use identical retry logic (3 attempts,
 * exponential backoff, GenAI error classification for delay decisions, and
 * non-retryable error detection). This factory eliminates the duplication.
 */
function createGenerationRetryOptions(
  logPrefix: string,
  actionContext: string,
  lastErrorRef: { current: unknown }
): {
  maxRetries: typeof MAX_BRANCHING_RETRIES;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry: (attempt: number, error: unknown) => Promise<void>;
  shouldRetry: (error: unknown) => boolean;
} {
  return {
    maxRetries: MAX_BRANCHING_RETRIES,
    baseDelayMs: 1000,
    maxDelayMs: 4000,
    onRetry: async (attempt, error) => {
      lastErrorRef.current = error;
      const code = classifyGenAIError(error);

      if (code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED') {
        console.warn(`[${logPrefix}] ⏸️ ${code} detected, adding 5 second delay before retry ${attempt}/${MAX_BRANCHING_RETRIES}:`, getErrorMessage(error));
        await delay(5000);
        console.log(`[${logPrefix}] ▶️ Retrying ${attempt}/${MAX_BRANCHING_RETRIES} after ${code} delay`);
      } else {
        console.warn(`[${logPrefix}] ⚠️ ${code} — Retry ${attempt}/${MAX_BRANCHING_RETRIES} for ${actionContext}:`, getErrorMessage(error));
      }
    },
    shouldRetry: (error) => {
      try {
        lastErrorRef.current = error;
        const errorMessage = getErrorMessage(error);

        // Check for application-level non-retryable errors
        const err = error as ErrorWithCustomProperties;
        if (err.shouldRetry === false || err.code === 'INVALID_ACTION' || errorMessage.includes('Non-retryable error')) {
          console.warn(`[${logPrefix}] 👋 Non-retryable error detected:`, errorMessage);
          return false;
        }

        // Classify GenAI error and check if it's retryable
        const code = classifyGenAIError(error);
        if (!isGenAIErrorRetryable(code)) {
          console.warn(`[${logPrefix}] 👋 GenAI non-retryable error (${code}):`, errorMessage);
          return false;
        }

        console.warn(`[${logPrefix}] 🔄 Retrying (${code}):`, errorMessage);
        return true;
      } catch {
        return true;
      }
    }
  };
}

/**
 * Core candidate generation with configurable strategy (parallel or sequential).
 *
 * Execution Flow:
 * 1. Validates page eligibility (last page, depth limit, pending actions).
 * 2. Acquires a distributed lock to prevent duplicate concurrent runs.
 * 3. Re-reads the page inside the lock (another worker may have already finished).
 * 4. Marks `isGeneratingStartedAt` so polling endpoints see generation in progress.
 * 5. For each pending action, generates a candidate page via AI.
 * 6. After each success, `onActionProgress` atomically: mutates in-memory state,
 *    serialises a DB write (write chain prevents lost-update races in parallel mode),
 *    stores a progress event, and forwards to the external callback.
 * 7. Final write clears `isGeneratingStartedAt` and reconciles any removed actions.
 *
 * Strategy Behaviour:
 * - `vercel` / `cron` → `useParallel: true`  — all actions start concurrently.
 * - `github-action`   → `useParallel: false` — actions run sequentially (reliable logging,
 *   no rate-limit bursts).
 *
 * Write-chain Serialisation (parallel mode):
 * Each `onActionProgress('completed')` call extends a promise chain so writes arrive in
 * order regardless of which parallel AI call resolves first. Because
 * `updateActionWithDestination` is synchronous, each chained write always reflects the
 * most complete in-memory state accumulated so far — a later write automatically heals
 * any earlier write that captured a partial snapshot.
 *
 * @param params.strategy  - Execution context: `'vercel'`, `'cron'`, or `'github-action'`
 * @param params.userId    - User ID used for DB mapping and page generation
 * @param params.page      - The story page whose actions need candidate pages
 * @param params.currentState - Story state snapshot; highly recommended for prompt quality
 * @param params.currentBook  - Optional pre-fetched book (avoids an extra DB round-trip)
 * @param params.options   - Optional overrides: `timeoutMs`, `onProgress`, `allowDeeperLevel`
 *
 * @returns The updated UserStoryPage with completed actions; original page on lock miss
 */
export async function ensureCandidatesForPageWithStrategy(
  params: GenerateCandidatesWithStrategyParams
): Promise<UserStoryPage> {
  const { strategy: context, userId, page, currentState, currentBook: providedBook, candidateCount, options = {} } = params;
  const { timeoutMs: customTimeoutMs, onProgress, allowDeeperLevel = false } = options;

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
    const recheckedPendingDBActions = initialDBActions.filter(action => !action.destinationPageIds?.length);
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
      candidatePages: PersistedStoryPage[], 
    ): void {
      // Use action index map for O(1) lookup and update
      const existingIndex = actionIndexMap.get(action.text);
      // ── MODE BRANCHING CONTRACT (destination-time gate) ───────────────────
      // Cap the destinations written onto this action to the book's mode limit:
      //   novel / interactive → exactly 1 destination per action
      //   multiverse          → multiple (parallel timelines, no cap)
      // Even if the AI produced extra candidate pages, the persisted
      // destinationPageIds can never exceed the mode's branching rule.
      const destinationPageIds = enforceModeOnActionDestinations(
        currentBook.mode,
        action.destinationPageIds,
        candidatePages.map(p => p.id),
      );
      const updatedAction: Action = {
        ...action,
        destinationPageIds,
        // Engine-derived per-action risk (deterministic, no AI authoring).
        risk: deriveActionRisk(action.type),
      };

      if (existingIndex !== undefined) {
        // Direct update at existing position - O(1) operation
        updatedDBActions[existingIndex] = updatedAction;
      } else {
        // Append new action - O(1) operation
        updatedDBActions.push(updatedAction);
        // Update map with new index
        actionIndexMap.set(action.text, updatedDBActions.length - 1);
      }
    }

    /**
     * Handles post-failure cleanup for a failed action result.
     *
     * Responsibility: invalid action removal from updatedDBActions + actionIndexMap only.
     * Progress notification ('failed' event) is NOT fired here — it is the caller's
     * responsibility to avoid double-fire:
     *   - Parallel path: fired immediately inside generateCandidatesInParallel's .catch()
     *   - Sequential path: fired explicitly after this call
     */
    function handleInvalidActionRemoval(result: CandidateGenerationResult): void {
      if (result.success) return;

      const { action } = result;
      const letter = generateActionLetter(action);

      if (isInvalidActionError(result.error)) {
        console.error(`[ensureCandidatesForPageWithStrategy] ❌ Invalid action "${action.text}" detected, removing from actions`);
        const existingIndex = actionIndexMap.get(action.text);
        if (existingIndex !== undefined) {
          removedActionTexts.add(action.text);
          actionIndexMap.delete(action.text);
        }
      } else {
        console.error(`[ensureCandidatesForPageWithStrategy] ❌ Failed to generate candidate for valid action ${letter}. ${action.text}:`, getErrorMessage(result.error));
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

    // Write chain — serialises per-action DB writes in parallel mode.
    // Each completion extends the chain so writes execute in arrival order; a later write
    // always carries the most complete in-memory snapshot, self-healing any earlier partial write.
    let writeChain: Promise<void> = Promise.resolve();

    // ── onActionProgress ────────────────────────────────────────────────────
    // Single source of truth for everything that must happen after an action finishes:
    //   1. Store a progress event (best-effort, never aborts generation if it fails)
    //   2. On 'completed': update in-memory state, enqueue a serialised DB write
    //   3. Forward to the external onProgress callback for UI updates
    //
    // Defined inside withLock so it closes over updatedDBActions, actionIndexMap,
    // writeChain, and the helper functions — all of which live in the lock scope.
    //
    // IMPORTANT: always `await` this callback; it contains `await writeChain` which
    // must complete before the next async step reads `updatedDBActions`.
    const onActionProgress: ActionProgressCallback = async (action, status, candidatePages, error): Promise<void> => {
      // Store progress event — error handled internally so tracking failure never aborts generation.
      // Progress tracking is best-effort — log and continue
      await storeActionProgressEvent(page.id, {
        action: action.text,
        status,
        destinationPageIds: candidatePages?.map(p => p.id), // destination pageId for completed actions
        error: error ? getErrorMessage(error) : undefined,
        timestamp: new Date().toISOString(),
      });

      // This must be the SSOT for: state mutation, DB persistence, event emission, progress updates
      if (status === 'completed' && candidatePages?.length) {
        // Sync: update in-memory state (safe — JS single-threaded, no interleaving)
        updateActionWithDestination(action, candidatePages);

        // Serialize the DB write — chain ensures writes arrive in order regardless
        // of which parallel promise completes first
        writeChain = writeChain.then(async () => {
          // By the time this runs, ALL synchronous mutations so far have happened,
          // so updatedDBActions always reflects the most complete in-memory state.
          const currentPending = updatedDBActions.filter(a => !a.destinationPageIds?.length).length;
          const letter = generateActionLetter(action);
          await dbWrite.update(pages)
            .set({ actions: updatedDBActions })
            .where(eq(pages.id, page.id));
          console.log(`[ensureCandidatesForPageWithStrategy] 💾 Persisted completed action: ${letter}. ${action.text} (${currentPending} still pending)`);
        });

        // Wait for this specific write before proceeding
        await writeChain;
      }

      // Forward to original caller callback if provided
      onProgress?.(action, status, candidatePages, error);
    };
    
    // ── MODE BRANCHING CONTRACT (parent-page enforcement) ─────────────────
    // For novel mode the parent page must have EXACTLY 1 action.  If the DB
    // page already has more (e.g. it was generated before the contract was in
    // place) we truncate here so candidate generation only processes the first
    // action and the excess actions are removed from the persisted array.
    if (currentBook.mode === 'novel' && updatedDBActions.length > 1) {
      const excess = updatedDBActions.slice(1).map(a => a.text);
      const firstAction = updatedDBActions[0];
      console.warn(
        `[ensureCandidatesForPageWithStrategy] ⚠️ Novel mode page ${page.id} has ` +
        `${updatedDBActions.length} actions; truncating to 1. Dropping: "${excess.join('", "')}"`,
      );
      // Mark excess actions for removal
      for (const text of excess) removedActionTexts.add(text);
      // Keep only the first action
      updatedDBActions = [firstAction];
      // Rebuild action index map with single entry
      actionIndexMap.clear();
      actionIndexMap.set(firstAction.text, 0);
      // Re-derive pending list from the trimmed array
      recheckedPendingDBActions.length = 0;
      if (!firstAction.destinationPageIds?.length) {
        recheckedPendingDBActions.push(firstAction);
      }
      console.log(
        `[ensureCandidatesForPageWithStrategy] 📋 After novel truncation: ` +
        `${updatedDBActions.length} action(s), ${recheckedPendingDBActions.length} pending`,
      );
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
        onProgress: onActionProgress,
        allowDeeperLevel,
        candidateCount,
        // onActionComplete bridges generateCandidatesInParallel's success callback into
        // onActionProgress, which is the SSOT for in-memory mutation + serialized DB write + event emission.
        onActionComplete: (action, candidatePage) => onActionProgress(action, 'completed', candidatePage),
      });
      
      // Failure cleanup pass — runs after all parallel AI calls settle.
      // Failure progress events were already fired immediately inside each promise's .catch(),
      // so handleInvalidActionRemoval only needs to handle state mutation (invalid action removal).
      //
      // Why not incorporate this into generateCandidatesInParallel?
      // removedActionTexts, actionIndexMap, and updatedDBActions are closure variables inside
      // withLock. Pushing this logic into generateCandidatesInParallel would require threading
      // mutable state containers as params, coupling a pure generation engine to persistence
      // concerns. Keeping it in the caller is the correct boundary.
      for (const result of generationResults) {
        if (!result.success) {
          handleInvalidActionRemoval(result);
        }
      }
    } else {
      // If there were any existing actions, should generate new branchId for each pending action
      const isPartial = initialDBActions.length > recheckedPendingDBActions.length;

      // Sequential generation (for GitHub Actions) using helper functions
      for (const [index, action] of recheckedPendingDBActions.entries()) {
        const letter = generateActionLetter(action);
        console.log(`[ensureCandidatesForPageWithStrategy] ⏳ Pre-generating destination pages for: ${letter}.`, action.text);

        // Notify progress callback of action start
        await onActionProgress(action, 'started');
        
        // Calculate generateNewBranchId per action: first action uses parent branchId, subsequent actions get new branchId
        const actionGenerateNewBranchId = isPartial || generateNewBranchId || index > 0;
        
        // Generate candidate page with retry logic (3 retries with exponential backoff: 1s, 2s, 4s)
        // Track the last error to determine if action should be removed
        const lastErrorRef = { current: null as unknown };
        const candidatePages = await retryWithBackoffOrNull(
          () => generateCandidatePages({
            userId,
            action,
            currentPage,
            currentState,
            currentBook,
            generateNewBranchId: actionGenerateNewBranchId,
            candidateCount
          }),
          createGenerationRetryOptions('ensureCandidatesForPageWithStrategy', `"${action.text}"`, lastErrorRef)
        ).catch(error => {
          lastErrorRef.current = error;
        });

        // Process the result (success or failure).
        // onActionProgress is the SSOT for completed actions: mutation + DB write + event emission.
        // handleInvalidActionRemoval covers removal of invalid actions from the in-memory state.
        if (candidatePages?.length) {
          // Success: update the action with the destination
          console.log(`[ensureCandidatesForPageWithStrategy] ✅ Pre-generated ${candidatePages.length} destination page for: ${letter}.`, action.text);
          // Notify progress callback of success
          await onActionProgress(action, 'completed', candidatePages);
        } else {
          // Failure notification first (mirrors parallel path where .catch() fires immediately)
          await onActionProgress(action, 'failed', undefined, lastErrorRef.current);
          // Then handle any invalid-action removal (pure state mutation, no re-notification)
          handleInvalidActionRemoval({ action, success: false, candidatePages: [], error: lastErrorRef.current });
        }
      }

      // Fire-and-forget deeper level generation for successfully generated candidates (same as parallel version)
      if (currentDepth < maxDepth) {
        const successfulCandidatePages: PersistedStoryPage[] = [];
        
        // Collect successfully generated candidate pages from updated actions
        for (const action of updatedDBActions) {
          if (!action.destinationPageIds?.length) continue;
          for (const candidatePageId of action.destinationPageIds) {
            // The candidate page is already in the action's destination
            // We need to fetch the full page data or use what we have
            // For simplicity, we'll trigger based on the pageId we have
            const candidatePage = await getPageFromDB(candidatePageId);
            if (candidatePage) {
              // Convert DB page to PersistedStoryPage (handle null -> undefined for mood)
              successfulCandidatePages.push(mapToPersistedStoryPage(candidatePage));
            }
          }
        }
        
        if (successfulCandidatePages.length > 0) {
          triggerDeeperLevelGeneration(
            successfulCandidatePages,
            currentDepth,
            maxDepth,
            userId,
            currentBook,
            'ensureCandidatesForPageWithStrategy',
            allowDeeperLevel
          );
        }
      }
    }

    // Ensure all progressive writes completed
    await writeChain;

    // Filter out removed actions and rebuild action index map before DB operations
    if (removedActionTexts.size > 0) {
      filterRemovedActionsAndRebuildMap();
    }

    // Ensure fallback action exists
    if (updatedDBActions.length === 0) {
      console.warn(`[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.`);
      updatedDBActions.push({
        text: "Continue.",
        type: "other",
        hint: {
          text: "See what happens next.",
          type: "none"
        },
        destinationPageIds: [], // Will be pre-generated on next run
        // _isFallback: true // Sentinel flag to prevent retry loops
      });
    }

    // Recompute final pending state AFTER all mutations
    const pendingAfter = updatedDBActions.filter(a => !a.destinationPageIds?.length).length;
    const succeededCount = updatedDBActions.length - pendingAfter;
    console.log(`[ensureCandidatesForPageWithStrategy] ✅ Pre-generated pages: ${succeededCount}/${updatedDBActions.length} actions${pendingAfter > 0 ? '' : ' (COMPLETED)'}`);
    if (pendingAfter > 0) console.warn(`[ensureCandidatesForPageWithStrategy] ⚠️ ${pendingAfter} still pending for candidate page generation`);

    // Final cleanup write
    const [updatedPage] = await dbWrite.update(pages)
      .set({
        actions: updatedDBActions,
        isGeneratingStartedAt: null,
        updatedAt: new Date()
      })
      .where(eq(pages.id, page.id))
      .returning();

    console.log(`[ensureCandidatesForPageWithStrategy] 🔓 Cleared isGeneratingStartedAt for page ${page.id}`);
    return updatedPage ? await mapToUserStoryPage(updatedPage, userId) : null;
  }, Math.floor(MAX_GENERATION_DURATION_MS / 1000));

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
 * This is the recommended approach for Node server deployments where Vercel's waitUntil is unavailable.
 * 
 * **Idempotency**: This function is idempotent per pageId - it checks if generation is already
 * in progress (isGeneratingStartedAt not null) and returns early if so. It sets isGeneratingStartedAt
 * to now() before triggering the workflow to prevent duplicate triggers.
 * 
 * **Retry Logic**: Uses dispatchGitHubWorkflow utility for transient failures (network errors, rate limits).
 * Retries up to 3 times with exponential backoff (1s, 2s, 4s). Only retries on specific HTTP status codes:
 * - 429 (Rate limit)
 * - 502 (Bad gateway)
 * - 503 (Service unavailable)
 * - 504 (Gateway timeout)
 * 
 * **Disabled Workflow Handling**: Gracefully handles disabled workflows by detecting the specific
 * 422 error and returning early without retries, with clear logging.
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
 * const result = await triggerCandidateGenerationWorkflow({
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
export async function triggerCandidateGenerationWorkflow(params: {
  bookTitle: string;
  bookId: string;
  pageId: string;
  userId: string;
  maxDepth: number;
  context?: string;
}): Promise<{ success: boolean; error?: string; alreadyInProgress?: boolean }> {
  const { bookTitle, bookId, pageId, userId, maxDepth, context = 'triggerCandidateGenerationWorkflow' } = params;
  
  console.log(`[${context}] 🚀 Triggered GitHub workflow for "${bookTitle}" page ${pageId} with maxDepth:`, maxDepth);

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
    const isGeneratingStartedAt = new Date();
    await dbWrite.update(pages)
      .set({ isGeneratingStartedAt })
      .where(eq(pages.id, pageId));
    console.log(`[${context}] ⏰ Set isGeneratingStartedAt for page ${pageId}:`, isGeneratingStartedAt);

    // Trigger workflow via reusable utility
    const dispatchResult = await dispatchGitHubWorkflow(
      GITHUB_REPO_CONFIG,
      {
        workflowFile: 'retry-pending-generations.yml',
        inputs: {
          book_title: bookTitle,
          book_id: bookId,
          page_id: pageId,
          triggered_by: userId,
          ...(maxDepth !== undefined ? { max_depth: String(maxDepth) } : {}),
        }
      },
      {
        context,
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 4000
      }
    );

    if (!dispatchResult.success) {
      // Reset isGeneratingStartedAt on failure to allow retry
      await dbWrite.update(pages)
        .set({ isGeneratingStartedAt: null })
        .where(eq(pages.id, pageId));
      
      if (dispatchResult.disabled) {
        console.error(`[${context}] 🚫 GitHub workflow is disabled - generation cannot proceed`);
      }
      
      return { success: false, error: dispatchResult.error };
    }

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

/**
 * Checks if generation is stuck (exceeded maximum duration) and resets it
 * 
 * This handles edge cases where background generation crashes or server restarts,
 * leaving isGeneratingStartedAt set but no actual generation happening.
 * 
 * @param dbPage - Page from database
 * @param pageId - Page ID for logging
 * @returns Promise resolving to true if it's generating, false otherwise
 */
async function checkAndResetStuckGeneration(dbPage: DBPage): Promise<{ isGenerating: boolean, isDone: boolean, totalPendingActions: number }> {
  const totalPendingActions = dbPage.pendingGenerationCount ?? dbPage.actions.filter(a => !a.destinationPageIds?.length).length;
  const isDone = totalPendingActions === 0;

  console.log(`[checkAndResetStuckGeneration] ${isDone ? '✅' : '👉'} totalPendingActions for page ${dbPage.id}:`, totalPendingActions, { pendingGenerationCount: dbPage.pendingGenerationCount, actions: dbPage.actions });

  const { isGeneratingStartedAt } = dbPage;

  // Early exit: if generation never started
  if (!isGeneratingStartedAt) return { isGenerating: false, isDone, totalPendingActions };

  const elapsedMs = Date.now() - new Date(isGeneratingStartedAt).getTime();
  const isStuck = elapsedMs > MAX_GENERATION_DURATION_MS;
  const isGenerating = !isStuck && !isDone;
  const currentState = { isGenerating, isDone, totalPendingActions };

  // Still actively generating now
  if (isGenerating) return currentState;

  try {
    // Reset stale generation flag and mutate the caller object to reflect the update
    await dbWrite.update(pages).set({ isGeneratingStartedAt: null }).where(eq(pages.id, dbPage.id));
    dbPage.isGeneratingStartedAt = null;

    if (isDone) {
      console.log(`[checkAndResetStuckGeneration] ✅ Generation completed for page ${dbPage.id}`);

      // Cleanup progress events only on successful completion
      void clearActionProgressEvents(dbPage.id);
    } else {
      console.warn(`[checkAndResetStuckGeneration] ⚠️ Reset stuck generation for page ${dbPage.id} after ${Math.round(elapsedMs / 1000)}s`);
    }

  } catch (error) {
    console.error(`[checkAndResetStuckGeneration] ❌ Failed to reset generation state for page ${dbPage.id}:`, error);

    // Conservative fallback: assume generation still active if reset failed
    return { ...currentState, isGenerating: true };
  }

  return currentState;
}

/**
 * Common validation and page retrieval for candidate generation endpoints
 * 
 * Consolidates repeated validation logic across GET /candidates and GET /candidates/status.
 * Handles UUID validation, page lookup, stuck generation reset, and user page mapping.
 * 
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page ID to validate and retrieve
 * @param userId - User ID for mapping page data
 * @returns Promise resolving to validated page data or null if validation fails
 * 
 * @throws ValidationError if pageId is invalid UUID
 * @throws NotFoundError if page not found
 */
export async function validateAndRetrievePageForGeneration(
  identifier: string,
  pageId: string,
  userId?: string
): Promise<CandidateGenerationPageValidation | null> {
  // Early validation
  if (!isValidUuid(pageId)) return null;

  // Get the page by book identifier from database
  const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

  // Use dbWrite client for reliable up-to-date data (avoid read replica stale data)
  const dbPage = await getPageFromDB(pageId, { bookIdentifier, client: dbWrite });
  if (!dbPage) return null;

  const dbBook = await getBookFromDB(dbPage.bookId);
  if (!dbBook) return null;

  // Check if generation is stuck and reset if needed
  const { isGenerating, isDone, totalPendingActions } = await checkAndResetStuckGeneration(dbPage);
  if (!isGenerating && !isDone) {
    dbPage.isGeneratingStartedAt = null; // Reset timestamp for stuck generation
  }

  // Map to user story page
  const userPage = userId ? await mapToUserStoryPage(dbPage, userId) : mapToPersistedStoryPage(dbPage);

  return { dbBook, dbPage, userPage, isGenerating, isDone, totalPendingActions };
}