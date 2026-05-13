/**
 * Book Creation Service
 * 
 * Core book creation logic shared between POST and SSE endpoints.
 * Provides a unified interface for book creation with optional progress callbacks.
 */

import type { StoryMCCandidate } from '../types/character.js';
import type { InitializeBookResult } from '../types/book.js';
import type { ProgressCallback } from '../types/sse.js';
import type { ThemeValidationResult } from '../types/theme-validation.js';
import { validateTheme } from '../utils/theme-validation.js';
import { formatOneOf, initializeBook } from '../utils/prompt.js';
import { handleThemeValidationError } from './book-controller.js';
import type { Request, Response } from "express";
import { getErrorMessage, handleApiError } from '../utils/error.js';
import { isInsufficientCreditsError } from '../config/errors.js';
import { executeWithCredits } from './credits.js';
import { MAX_CHARACTER_AGE, MIN_CHARACTER_AGE } from '../config/story.js';
import { MAX_THEME_LENGTH } from '../config/theme-validation.js';
import type { KnownGender } from '../types/user.js';
import { handleInsufficientCreditsError } from '../routes/payments.js';

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

  try {
    // STEP 1: Validate book creation parameters (before credit consumption)
    await createBookValidate(theme, mcCandidate, generateCoverImage, onProgress);

    // STEP 2: Skip credit consumption for internal cron jobs
    const isInternal = isOriginal || userId === process.env.SYSTEM_USER_ID;

    let result: InitializeBookResult;

    if (isInternal) {
      // Cron job or original story: initialize without credit consumption
      result = await initializeBook({ userId, theme, mcCandidate, generateCoverImage, isOriginal }, onProgress);
    } else {
      // User request: consume credits and initialize atomically
      // This ensures credits are refunded if initialization fails
      // 
      // LIMITATION: initializeBook does not currently support transaction parameter
      // This means if book creation partially succeeds (book created but page/state fails),
      // credits will still be consumed. Full atomicity requires passing tx through
      // to initializeBook and all its DB operations (insertBook, insertStoryPage, insertStoryState).
      // 
      // Current behavior: Credits refunded if initializeBook fails entirely
      // Future improvement: Pass tx to initializeBook for full atomicity
      const { result: initResult } = await executeWithCredits<InitializeBookResult>(
        userId,
        "STORY_GENERATION",
        async (_tx) => {
          // Initialize book within the transaction
          // Note: initializeBook must support transaction parameter for full atomicity
          // For now, we call it outside and rely on executeWithCredits's automatic refund
          return await initializeBook({ userId, theme, mcCandidate, generateCoverImage, isOriginal, req }, onProgress);
        },
        {
          context,
          metadata: { theme: theme.trim() }
        }
      );
      result = initResult;
    }

    return result;
  } catch (error) {
    await onProgress?.({ type: 'error', error: getErrorMessage(error) });
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
