/**
 * Book Creation Service
 * 
 * Core book creation logic shared between POST and SSE endpoints.
 * Provides a unified interface for book creation with optional progress callbacks.
 */

import type { StoryMCCandidate } from '../types/character.js';
import type { CreateBookResponse } from '../types/book.js';
import type { ProgressCallback } from '../types/sse.js';
import type { ThemeValidationResult } from '../types/theme-validation.js';
import { validateTheme } from '../utils/theme-validation.js';
import { initializeBook } from '../utils/prompt.js';
import { handleThemeValidationError } from './book-controller.js';
import type { Response } from 'express';
import { invalidateUserBooksCache, invalidateUserProfileCache, invalidateExploreCache } from './cache.js';
import { getErrorMessage, handleApiError } from '../utils/error.js';

/**
 * Book creation parameters
 */
export interface BookCreationParams {
  userId: string;
  theme: string;
  mcCandidate?: StoryMCCandidate;
  generateCoverImage?: boolean;
  isOriginal?: boolean;
}

/**
 * Custom error for book creation failures
 */
class BookCreationError extends Error {
  constructor(
    message: string,
    public validationResult?: ThemeValidationResult
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
): Promise<CreateBookResponse> {
  const { userId, theme, mcCandidate, generateCoverImage, isOriginal } = params;

  try {
    // STEP 1: VALIDATING THEME
    const validationResult = await validateTheme(theme, onProgress);

    if (!validationResult.isValid) {
      throw new BookCreationError('Theme validation failed', validationResult);
    }

    // Validate mcCandidate if provided
    if (mcCandidate) {
      if (typeof mcCandidate !== 'object' || mcCandidate === null) {
        throw new Error('Invalid mcCandidate: must be an object');
      }

      if (mcCandidate.name !== undefined) {
        if (typeof mcCandidate.name !== 'string' || mcCandidate.name.trim().length === 0) {
          throw new Error('Invalid mcCandidate.name: must be a non-empty string');
        }
      }

      if (mcCandidate.age !== undefined) {
        if (typeof mcCandidate.age !== 'number' || mcCandidate.age < 0 || mcCandidate.age > 150) {
          throw new Error('Invalid mcCandidate.age: must be a number between 0 and 150');
        }
      }

      if (mcCandidate.gender !== undefined) {
        if (typeof mcCandidate.gender !== 'string' || !['male', 'female', 'other'].includes(mcCandidate.gender)) {
          throw new Error("Invalid mcCandidate.gender: must be 'male', 'female', or 'other'");
        }
      }

      if (mcCandidate.bio !== undefined) {
        if (typeof mcCandidate.bio !== 'string' || mcCandidate.bio.trim().length === 0) {
          throw new Error('Invalid mcCandidate.bio: must be a non-empty string');
        }
      }
    }

    // Validate generateCoverImage if provided
    if (generateCoverImage !== undefined) {
      if (typeof generateCoverImage !== 'boolean') {
        throw new Error('Invalid generateCoverImage: must be a boolean');
      }
    }

    // STEP 2: INITIALIZING BOOK
    const result = await initializeBook({ userId, theme, mcCandidate, generateCoverImage, isOriginal }, onProgress);

    // Invalidate caches
    await invalidateUserBooksCache(userId);
    await invalidateUserProfileCache(userId);
    
    if (result.book.status === 'active') {
      await invalidateExploreCache();
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
export function handleBookCreationError(res: Response, error: unknown): void {
  if (error instanceof BookCreationError && error.validationResult) {
    handleThemeValidationError(res, error.validationResult);
  } else {
    handleApiError(res, 'Failed to create book', error);
  }
}
