/**
 * Book Creation Service
 * 
 * Core book creation logic shared between POST and SSE endpoints.
 * Provides a unified interface for book creation with optional progress callbacks.
 */

import type { StoryMCCandidate } from '../types/character.js';
import type { BookGenerationPayload, BookGenerationStatus, BookGenerationStep, InitializeBookResult } from '../types/book.js';
import type { ProgressCallback } from '../types/sse.js';
import type { ThemeValidationResult } from '../types/theme-validation.js';
import { validateTheme } from '../utils/theme-validation.js';
import { formatOneOf, initializeBook } from '../utils/prompt.js';
import { handleThemeValidationError } from './book-controller.js';
import type { Request, Response } from "express";
import { getErrorMessage, handleApiError } from '../utils/error.js';
import { isInsufficientCreditsError } from '../config/errors.js';
import { executeWithCredits, refundCredits } from './credits.js';
import { MAX_CHARACTER_AGE, MIN_CHARACTER_AGE } from '../config/story.js';
import { MAX_THEME_LENGTH } from '../config/theme-validation.js';
import type { KnownGender } from '../types/user.js';
import { handleInsufficientCreditsError } from '../routes/payments.js';
import type { DBNewBookGeneration } from '../types/schema.js';
import { bookGenerations } from '../db/schema.js';
import { dbWrite } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { cleanupObject } from '../utils/parser.js';
import { debounceAsync } from '../utils/debounce.js';

/**
 * Book creation parameters
 */
export interface BookCreationParams {
  userId: string;
  theme: string;
  mcCandidate?: StoryMCCandidate;
  generateCoverImage?: boolean;
  isOriginal?: boolean;
  context?: string;
  req?: Request;
}

/**
 * Validates book creation parameters
 * 
 * @param theme - The story theme to validate
 * @param mcCandidate - Optional main character candidate
 * @param generateCoverImage - Optional flag to generate cover image
 * @param onProgress - Optional progress callback for AI validation
 * @returns null if validation fails, void if validation passes
 * @throws BookCreationError if AI theme validation fails
 */
export async function createBookValidate(
  theme: string,
  mcCandidate: StoryMCCandidate | undefined,
  generateCoverImage: boolean | undefined,
  onProgress?: ProgressCallback
): Promise<void> {
  // STEP 1: VALIDATING THEME
  // Validate theme (required)
  if (typeof theme !== 'string' || !theme.trim()) {
    throw new BookCreationError('Theme is required and must be a non-empty string');
  }

  // Validate theme length
  if (theme.trim().length > MAX_THEME_LENGTH) {
    throw new BookCreationError(`Theme exceeds maximum length of ${MAX_THEME_LENGTH} characters`);
  }

  // STEP 2: VALIDATING MC CANDIDATE
  // Validate mcCandidate if provided
  if (mcCandidate !== undefined && mcCandidate !== null) {
    // Ensure mcCandidate is an object
    if (typeof mcCandidate !== 'object' || Array.isArray(mcCandidate)) {
      throw new BookCreationError('Invalid mcCandidate: must be an object');
    }

    // Validate name (optional)
    if (mcCandidate.name !== undefined) {
      if (typeof mcCandidate.name !== 'string' || mcCandidate.name.trim().length === 0) {
        throw new BookCreationError('Invalid mcCandidate.name: must be a non-empty string if provided');
      }
    }

    // Validate age (optional)
    if (mcCandidate.age !== undefined) {
      if (typeof mcCandidate.age !== 'number' || !Number.isInteger(mcCandidate.age)) {
        throw new BookCreationError('Invalid mcCandidate.age: must be an integer');
      }
      if (mcCandidate.age < MIN_CHARACTER_AGE || mcCandidate.age > MAX_CHARACTER_AGE) {
        throw new BookCreationError(`Invalid mcCandidate.age: must be between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}`);
      }
    }

    // Validate gender (optional)
    if (mcCandidate.gender !== undefined) {
      if (typeof mcCandidate.gender !== 'string') {
        throw new BookCreationError('Invalid mcCandidate.gender: must be a string');
      }
      const genders = ['male', 'female'] satisfies KnownGender[];
      if (!genders.includes(mcCandidate.gender)) {
        throw new BookCreationError(`Invalid mcCandidate.gender: must be one of ${formatOneOf(genders)}`);
      }
    }

    // Validate bio (optional)
    if (mcCandidate.bio !== undefined) {
      if (typeof mcCandidate.bio !== 'string' || mcCandidate.bio.trim().length === 0) {
        throw new BookCreationError('Invalid mcCandidate.bio: must be a non-empty string if provided');
      }
    }
  }

  // STEP 3: VALIDATING GENERATE COVER IMAGE
  // Validate generateCoverImage if provided
  if (generateCoverImage !== undefined) {
    if (typeof generateCoverImage !== 'boolean') {
      throw new BookCreationError('Invalid generateCoverImage: must be a boolean');
    }
  }
  
  // STEP 4: VALIDATING THEME (AI)
  const validationResult = await validateTheme(theme, onProgress);
  if (!validationResult.isValid) {
    throw new BookCreationError('Theme validation failed', validationResult);
  }
}

// /**
//  * Consumes credits for book creation
//  * 
//  * @param userId - User ID to consume credits from
//  * @param isOriginal - Whether this is an original story (free)
//  * @param context - Context for credit consumption
//  * @param theme - Theme for credit metadata
//  * @returns null if credit error occurs, void if successful
//  * @throws Error if non-credit error occurs
//  */
// export async function consumeBookCredits(
//   userId: string,
//   isOriginal: boolean | undefined,
//   context: string,
//   theme: string
// ): Promise<void> {
//   // Skip credits consume for internal cron jobs (only for actual consumers)
//   if (isOriginal || userId === process.env.SYSTEM_USER_ID) return;

//   await consumeCredits(userId, "STORY_GENERATION", {
//     context,
//     metadata: { theme: theme.trim() }
//   });
// }

/**
 * Custom error for book creation failures
 */
class BookCreationError extends Error {
  constructor(
    message: string,
    public validationResult?: ThemeValidationResult,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'BookCreationError';
  }
}

/**
 * Core book creation logic (shared between POST and SSE)
 * 
 * This function extracts the core business logic from the POST /api/books route
 * to make it reusable for both synchronous and SSE endpoints.
 * 
 * Uses executeWithCredits for atomic credit consumption and book creation,
 * ensuring credits are refunded if initialization fails.
 * 
 * Note: Cache invalidation and activity logging are now handled in initializeBook
 * for consistency across all book creation approaches (sync, SSE, async, cron).
 * 
 * @param params - Book creation parameters
 * @param onProgress - Optional progress callback for SSE events
 * @returns Complete book creation result
 * 
 * @example
 * ```typescript
 * // POST endpoint (no progress)
 * const result = await createBookCore({ userId, theme, mcCandidate });
 * 
 * // SSE endpoint (with progress)
 * const result = await createBookCore(
 *   { userId, theme, mcCandidate },
 *   (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
 * );
 * ```
 */
export async function createBookCore(
  params: BookCreationParams,
  onProgress?: ProgressCallback
): Promise<InitializeBookResult> {
  const { userId, theme, mcCandidate, generateCoverImage, isOriginal, context = "book_creation", req } = params;

  // STEP 1: Skip credit consumption for internal cron jobs
  const isInternal = isOriginal || userId === process.env.SYSTEM_USER_ID;
  let correlationId: string | undefined;

  try {
    // STEP 2: Validate book creation parameters (before credit consumption)
    await createBookValidate(theme, mcCandidate, generateCoverImage, onProgress);

    let result: InitializeBookResult;

    if (isInternal) {
      // Cron job or original story: initialize without credit consumption
      result = await initializeBook({ userId, theme, mcCandidate, generateCoverImage, isOriginal }, onProgress);
    } else {
      // User request: consume credits and initialize atomically
      // This ensures credits are refunded if initialization fails
      // 
      // initializeBook now supports transaction parameter for full atomicity
      // All DB operations (insertBook, insertStoryPage, insertStoryState) are executed
      // within the same transaction, ensuring credits are refunded if any operation fails.
      const executeCreditsResult = await executeWithCredits<InitializeBookResult>(
        userId,
        "STORY_GENERATION",
        async (tx) => {
          // Initialize book within the transaction
          // All DB operations use tx for full atomicity
          return await initializeBook({ userId, theme, mcCandidate, generateCoverImage, isOriginal, req, tx }, onProgress);
        },
        {
          context,
          metadata: { theme: theme.trim() }
        }
      );
      result = executeCreditsResult.result;
      correlationId = executeCreditsResult.correlationId;
    }

    return result;
  } catch (error) {
    await onProgress?.({ type: 'error', error: getErrorMessage(error) });
    
    // Refund credits idempotently using correlation ID for non-internal users
    // This prevents duplicate refunds if the error handler runs multiple times
    if (!isInternal && correlationId) {
      try {
        await refundCredits(userId, "STORY_GENERATION", {
          context: "book_creation_failed",
          metadata: { theme: theme.trim() },
          correlationId // Use correlation ID from executeWithCredits for idempotency
        });
        console.log('[createBookCore] ✅ Credits refunded due to book creation failure');
      } catch (refundError) {
        // All retry attempts failed, log for manual review
        console.error('[createBookCore] ⚠️ All refund attempts failed, manual review required:', {
          userId,
          correlationId,
          theme: theme.trim(),
          error: getErrorMessage(refundError)
        });
      }
    }
    
    throw error;
  }
}

/**
 * Handles book creation error for Express responses
 * 
 * @param res - Express response object
 * @param error - Error from book creation
 */
export function handleBookCreationError(res: Response, error: unknown, defaultMessage?: string): void {
  const isBookCreationError = error instanceof BookCreationError;
  const statusCode = isBookCreationError ? error.statusCode : undefined;
  if (isBookCreationError && error.validationResult) {
    handleThemeValidationError(res, error.validationResult, statusCode);
  } else if (isInsufficientCreditsError(error)) {
    handleInsufficientCreditsError(res, 'STORY_GENERATION', error);
  } else {
    handleApiError(res, defaultMessage ?? 'Failed to create book', error, statusCode);
  }
}

/**
 * Updates book generation status in the database (internal core logic)
 * 
 * This function performs the actual database update for book generation status.
 * It is separated from the public API to enable debouncing.
 * 
 * @param bookId - The book ID to update
 * @param status - Optional generation status
 * @param step - Optional generation step
 * @param error - Optional error message
 * @throws BookCreationError if validation fails or database update fails
 */
async function updateBookGenerationStatusCore(
  bookId: string,
  status?: BookGenerationStatus,
  step?: BookGenerationStep,
  error?: string
): Promise<void> {
  // 1. Validations
  if (!bookId) {
    throw new BookCreationError('Missing required fields: bookId', undefined, 400);
  }

  const validSteps = new Set<BookGenerationStep>(['initializing', 'generating', 'evaluating', 'reviewing', 'finalizing', 'completed']);
  if (step && !validSteps.has(step)) {
    throw new BookCreationError('Invalid step', undefined, 400);
  }
  
  const validStatuses = new Set<BookGenerationStatus>(['pending', 'in_progress', 'completed', 'failed']);
  if (status && !validStatuses.has(status)) {
    throw new BookCreationError('Invalid status', undefined, 400);
  }

  // 2. Compose generation status update values
  const update: Partial<DBNewBookGeneration> = { 
    generationStatus: status, 
    generationStep: step,
    generationError: error ?? null,
  };

  // Set completion timestamp for terminal states
  if (status === 'completed' || status === 'failed') {
    update.generationCompletedAt = new Date();
  }

  // Auto-derive status from step for consistency
  if (step === 'completed') {
    update.generationStatus = 'completed';
  } else if (step === 'initializing') {
    update.generationStatus = 'in_progress';
  }

  // 3. Persist generation status in DB
  await dbWrite.update(bookGenerations).set(update).where(eq(bookGenerations.bookId, bookId));
}

/**
 * Debounced version of updateBookGenerationStatusCore with per-bookId debouncing
 * 
 * Uses a 500ms delay to batch rapid successive updates for the same book.
 * Only the latest update for each bookId is executed (trailing edge).
 * 
 * @param bookId - The book ID to update (used as debounce key)
 * @param status - Optional generation status
 * @param step - Optional generation step
 * @param error - Optional error message
 * @returns Promise resolving when update is executed or debounced
 */
const debouncedUpdateStatus = debounceAsync(
  updateBookGenerationStatusCore,
  { delay: 500, trailing: true, leading: false }
);

/**
 * Updates book generation status with debouncing per bookId
 * 
 * This function provides a debounced interface for updating book generation status.
 * Multiple rapid calls for the same bookId will be debounced, with only the latest
 * update being executed after a 500ms delay. This prevents excessive database writes
 * during rapid status changes (e.g., during AI generation progress updates).
 * 
 * The function validates the input parameters and ensures only valid status/step
 * values are accepted. It automatically derives status from step when appropriate
 * and sets completion timestamps for terminal states.
 * 
 * Debouncing behavior:
 * - Each bookId has its own independent debounce timer
 * - Only the trailing (latest) call is executed after the delay
 * - Intermediate calls are debounced and not executed
 * - Different bookIds are processed independently
 * 
 * @param payload - Book generation update payload
 * @param payload.bookId - The book ID to update (required)
 * @param payload.status - Optional generation status ('pending' | 'in_progress' | 'completed' | 'failed')
 * @param payload.step - Optional generation step ('initializing' | 'generating' | 'evaluating' | 'reviewing' | 'finalizing' | 'completed')
 * @param payload.error - Optional error message for failed generations
 * @returns Promise that resolves when the update is processed (executed or debounced)
 * @throws BookCreationError if validation fails (400) or database update fails (500)
 * 
 * @example
 * ```typescript
 * // Basic status update
 * await updateBookGenerationStatus({ 
 *   bookId: 'book123', 
 *   status: 'in_progress', 
 *   step: 'generating' 
 * });
 * 
 * // Update with error
 * await updateBookGenerationStatus({ 
 *   bookId: 'book123', 
 *   status: 'failed', 
 *   error: 'AI generation timeout' 
 * });
 * 
 * // Rapid successive calls - only the last one executes
 * await updateBookGenerationStatus({ bookId: 'book123', step: 'generating' });
 * await updateBookGenerationStatus({ bookId: 'book123', step: 'evaluating' }); // Debounced
 * await updateBookGenerationStatus({ bookId: 'book123', step: 'reviewing' }); // Debounced
 * // After 500ms, only 'reviewing' is executed
 * ```
 */
export async function updateBookGenerationStatus(payload: BookGenerationPayload): Promise<void> {
  const { bookId, status, step, error } = payload;
  console.log(`[updateBookGenerationStatus] 🧩 Book generation progress updated to:`, cleanupObject(payload));
  
  try {
    await debouncedUpdateStatus(bookId, status, step, error);
  } catch (error) {
    console.log(`[updateBookGenerationStatus] ❌ Failed to update generation status:`, error);
    throw error;
  }
}
