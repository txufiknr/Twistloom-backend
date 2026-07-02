/**
 * Book Creation Service
 *
 * Core book creation logic shared between POST, SSE, and async endpoints.
 * Provides a unified interface for book creation with optional progress callbacks.
 *
 * Architecture:
 * - `createBookValidate`            — input + AI theme validation (shared by all routes)
 * - `createBookCore`                — credit-gated initializeBook wrapper (sync / SSE)
 * - `updateBookGenerationStatus`    — debounced DB progress writes (async / cron flow)
 * - `triggerBookGenerationWorkflow` — GitHub Actions dispatch (async / original flow)
 * - `isGenerationStale`             — staleness detection used by the polling endpoint
 */

import type { StoryMCCandidate } from '../types/character.js';
import {
  type BookGenerationPayload,
  type BookGenerationStatus,
  type StoryGenerationStep,
  type CreateBookResponse,
  type InitializeBookParams,
  type CreateBookParams,
  storyGenerationSteps,
  bookGenerationStatuses,
} from '../types/book.js';
import type { ProgressCallback } from '../types/sse.js';
import type { ThemeValidationResult } from '../types/theme-validation.js';
import { handleThemeValidationError, validateTheme } from '../utils/theme-validation.js';
import { initializeBook } from '../utils/prompt.js';
import type { Response } from 'express';
import { getErrorMessage, handleApiError } from '../utils/error.js';
import { isInsufficientCreditsError } from '../config/errors.js';
import { executeWithCredits, refundCredits } from './credits.js';
import { MAX_CHARACTER_AGE, MIN_CHARACTER_AGE } from '../config/story.js';
import { MAX_THEME_LENGTH, MAX_THEME_LENGTH_BUFFER } from '../config/theme-validation.js';
import type { KnownGender } from '../types/user.js';
import { handleInsufficientCreditsError } from '../routes/payments.js';
import type { DBBookGeneration, DBNewBookGeneration } from '../types/schema.js';
import { bookGenerations } from '../db/schema.js';
import { dbWrite } from '../db/client.js';
import { eq, and, ne } from 'drizzle-orm';
import { cleanupObject } from '../utils/parser.js';
import { formatOneOf, truncateToLastCompleteSentence } from '../utils/text-processing.js';
import { debounceAsync } from '../utils/debounce.js';
import { dispatchGitHubWorkflow } from '../utils/github-workflow.js';
import { GITHUB_REPO_CONFIG } from '../config/env.js';
import { MAX_GENERATION_DURATION_MS, PENDING_TIMEOUT_MS } from '../config/book-creation.js';
import { isValidUuid } from '../utils/uuid.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates all book creation parameters before any credit consumption or DB writes.
 *
 * Performs two distinct validation passes:
 * 1. Synchronous structural validation (theme string, MC fields, flags)
 * 2. Async AI theme validation via `validateTheme`
 *
 * @param theme              - Raw theme string from request body
 * @param mcCandidate        - Optional MC overrides (name, age, gender, bio)
 * @param generateCoverImage - Optional boolean flag
 * @param onProgress         - Optional SSE callback (forwarded to the AI validation step)
 * @returns Validated `ThemeValidationResult` (always `isValid === true` on success)
 * @throws `BookCreationError` on any validation failure
 */
export async function createBookValidate(params: {
  theme: string,
  mcCandidate?: StoryMCCandidate | null,
  generateCoverImage?: boolean,
  isOriginal?: boolean,
  onProgress?: ProgressCallback
}): Promise<ThemeValidationResult> {
  const { mcCandidate, generateCoverImage, isOriginal = false, onProgress } = params;
  let { theme } = params;

  // ── 1. Theme structural validation ───────────────────────────────────────
  if (typeof theme !== 'string' || !theme.trim()) {
    throw new BookCreationError('Theme is required and must be a non-empty string');
  }

  const maxThemeLength = isOriginal ? MAX_THEME_LENGTH + MAX_THEME_LENGTH_BUFFER : MAX_THEME_LENGTH;
  if (theme.trim().length > maxThemeLength) {
    if (isOriginal) {
      // AI-generated theme occasionally exceeds the length limit.
      // Truncating avoids wasting AI credits on theme regeneration.
      theme = truncateToLastCompleteSentence(theme, maxThemeLength);
      console.log(`[createBookValidate] ✂️ Truncated original theme to ${theme.length} characters (limit: ${maxThemeLength})`);
    } else {
      throw new BookCreationError(`Theme exceeds maximum length of ${maxThemeLength} characters`);
    }
  }

  // ── 2. MC candidate structural validation ────────────────────────────────
  if (mcCandidate !== undefined && mcCandidate !== null) {
    if (typeof mcCandidate !== 'object' || Array.isArray(mcCandidate)) {
      throw new BookCreationError('Invalid mcCandidate: must be an object');
    }

    if (mcCandidate.name !== undefined) {
      if (typeof mcCandidate.name !== 'string' || mcCandidate.name.trim().length === 0) {
        throw new BookCreationError('Invalid mcCandidate.name: must be a non-empty string if provided');
      }
    }

    if (mcCandidate.age !== undefined) {
      if (typeof mcCandidate.age !== 'number' || !Number.isInteger(mcCandidate.age)) {
        throw new BookCreationError('Invalid mcCandidate.age: must be an integer');
      }
      if (mcCandidate.age < MIN_CHARACTER_AGE || mcCandidate.age > MAX_CHARACTER_AGE) {
        throw new BookCreationError(
          `Invalid mcCandidate.age: must be between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}`
        );
      }
    }

    if (mcCandidate.gender !== undefined) {
      if (typeof mcCandidate.gender !== 'string') {
        throw new BookCreationError('Invalid mcCandidate.gender: must be a string');
      }
      const genders = ['male', 'female'] satisfies KnownGender[];
      if (!genders.includes(mcCandidate.gender)) {
        throw new BookCreationError(
          `Invalid mcCandidate.gender: must be one of ${formatOneOf(genders)}`
        );
      }
    }

    if (mcCandidate.bio !== undefined) {
      if (typeof mcCandidate.bio !== 'string' || mcCandidate.bio.trim().length === 0) {
        throw new BookCreationError('Invalid mcCandidate.bio: must be a non-empty string if provided');
      }
    }
  }

  // ── 3. generateCoverImage type guard ────────────────────────────────────
  if (generateCoverImage !== undefined && typeof generateCoverImage !== 'boolean') {
    throw new BookCreationError('Invalid generateCoverImage: must be a boolean');
  }

  // ── 4. AI theme validation ───────────────────────────────────────────────
  const validationResult = await validateTheme(theme, onProgress);
  if (!validationResult.isValid) {
    throw new BookCreationError('Theme validation failed', validationResult);
  }

  return { ...validationResult, theme };
}

// ---------------------------------------------------------------------------
// BookCreationError
// ---------------------------------------------------------------------------

/**
 * Typed error for all book creation failures.
 *
 * Carries an optional `validationResult` (theme rejection details) and an
 * optional HTTP `statusCode` override so that `handleBookCreationError` can
 * produce the right response without inspecting the message string.
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

// ---------------------------------------------------------------------------
// createBookCore  (sync / SSE)
// ---------------------------------------------------------------------------

/**
 * Core book creation logic shared by the synchronous POST and SSE endpoints.
 *
 * **Credit handling:**
 * - For regular users: wraps `initializeBook` in `executeWithCredits`, giving
 *   full atomicity — if `initializeBook` throws the transaction rolls back and
 *   the credit deduction is automatically undone (no separate refund needed).
 * - For internal/original flows: calls `initializeBook` directly (no credits).
 *
 * **Outer catch refund guard:**
 * `correlationId` is assigned only after `executeWithCredits` returns. If
 * `executeWithCredits` itself throws (either at credit consumption or during
 * `initializeBook`), `correlationId` remains `undefined` and the outer
 * `refundCredits` is intentionally skipped — the transaction rollback already
 * preserved the user's balance. The outer refund is a defensive safety net for
 * any future code inserted between the `correlationId` assignment and `return`.
 *
 * @param params     - Book creation parameters
 * @param onProgress - Optional SSE progress callback
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
  params: CreateBookParams,
  onProgress?: ProgressCallback
): Promise<CreateBookResponse> {
  const {
    userId,
    theme,
    mcCandidate: initialMCCandidate,
    generateCoverImage,
    isOriginal,
    context = 'book_creation',
  } = params;

  const isInternal = isOriginal || userId === process.env.SYSTEM_USER_ID;
  let correlationId: string | undefined;

  try {
    // ── Step 1: Validate inputs (before any credit consumption) ───────────
    const { aiResult, theme: validatedTheme } = await createBookValidate({
      theme,
      mcCandidate: initialMCCandidate,
      generateCoverImage,
      isOriginal,
      onProgress
    });
    const { comment: aiComment, language = 'en', titleIdea, mcCandidate } = aiResult || {};
    const initializeParams: InitializeBookParams = {
      ...params,
      theme: validatedTheme ?? theme,
      aiComment,
      language,
      titleIdea,
      mcCandidate,
    };

    let result: CreateBookResponse;

    if (isInternal) {
      // ── Step 2a: Internal / cron — no credit gate ──────────────────────
      result = await initializeBook(initializeParams, onProgress);
    } else {
      // ── Step 2b: User request — consume credits atomically ─────────────
      //
      // `executeWithCredits` opens a single DB transaction that:
      //   1. Deducts credits (row-locked SELECT FOR UPDATE + UPDATE)
      //   2. Calls `initializeBook` with the transaction (`tx`)
      //   3a. On success:  commits both credit deduction + book records
      //   3b. On failure:  rolls back everything — no explicit refund needed
      //
      // All DB operations inside `initializeBook` must use the provided `tx`
      // for the atomicity guarantee to hold.
      const executeCreditsResult = await executeWithCredits<CreateBookResponse>(
        userId,
        'STORY_GENERATION',
        async (tx) => initializeBook({ ...initializeParams, tx }, onProgress),
        {
          context,
          metadata: { theme: theme.trim() }
        }
      );

      result = executeCreditsResult.result;
      // Correlation ID is set only after executeWithCredits returns successfully.
      // If it threw, correlationId stays undefined and the outer catch skips the
      // redundant refund (balance already preserved by rollback).
      correlationId = executeCreditsResult.correlationId;
    }

    return result;
  } catch (error) {
    await onProgress?.({ type: 'error', error: getErrorMessage(error) });

    // Safety-net refund: only reachable if future code is inserted between
    // `correlationId = ...` and `return result`.
    // Currently unreachable.
    if (!isInternal && correlationId) {
      try {
        await refundCredits(userId, 'STORY_GENERATION', {
          context: 'book_creation_failed',
          metadata: { theme: theme.trim() },
          correlationId // Use correlation ID from executeWithCredits for idempotency
        });
        console.log('[createBookCore] ✅ Credits refunded due to book creation failure');
      } catch (refundError) {
        // All retry attempts failed, log for manual review
        console.error(
          '[createBookCore] ⚠️ All refund attempts failed, manual review required:',
          {
            userId,
            correlationId,
            theme: theme.trim(),
            error: getErrorMessage(refundError),
          }
        );
      }
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// handleBookCreationError
// ---------------------------------------------------------------------------

/**
 * Unified error handler for all book creation routes.
 *
 * Routes errors into three handlers in priority order:
 * 1. `BookCreationError` with a `validationResult` → theme-specific 4xx
 * 2. `InsufficientCreditsError`                    → credit purchase prompt
 * 3. Everything else                               → generic API error
 *
 * @param res            - Express response object
 * @param error          - Error from book creation
 * @param defaultMessage - Fallback message for generic errors
 */
export function handleBookCreationError(
  res: Response,
  error: unknown,
  defaultMessage?: string
): void {
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

// ---------------------------------------------------------------------------
// updateBookGenerationStatus  (async / cron progress tracking)
// ---------------------------------------------------------------------------

/**
 * Core (un-debounced) DB writer for book generation status.
 *
 * **Status derivation rule — step always takes precedence:**
 * When `step` is provided, the final `generationStatus` is derived from it,
 * overriding any explicitly passed `status`. This removes the need for callers
 * to keep both fields in sync:
 *
 * | step value        | derived generationStatus |
 * |-------------------|--------------------------|
 * | `'complete'`      | `'completed'`            |
 * | `'theme_validation'` | `'pending'`           |
 * | any other step    | `'in_progress'`          |
 * | `undefined`       | uses `status` param as-is |
 *
 * **Completion timestamp:**
 * `generationCompletedAt` is stamped only after the final status is resolved
 * (post-derivation), preventing the inconsistency that would arise if status
 * started as `'failed'` but was later overridden to `'in_progress'` by a step.
 *
 * **Error clearing:**
 * `generationError` is reset to `null` on every call unless `error` is provided.
 * This intentionally clears stale error messages when new progress is reported.
 *
 * @param bookId - Target book ID
 * @param status - Explicit generation status (optional, may be overridden by step)
 * @param step   - Generation step (optional, drives status auto-derivation)
 * @param error  - Error message for failed states (optional, clears previous error if absent)
 * @throws `BookCreationError` on validation failure (400) or DB write failure
 */
async function updateBookGenerationStatusCore(
  bookId: string,
  status?: BookGenerationStatus,
  step?: StoryGenerationStep,
  error?: string,
  aiFinalComment?: string
): Promise<void> {
  // ── 1. Input validation ───────────────────────────────────────────────────
  if (!bookId) {
    throw new BookCreationError('Missing required fields: bookId', undefined, 400);
  }

  if (!status && !step && error === undefined) {
    // A no-op update would only clear generationError with no other effect,
    // which is almost certainly a caller bug.
    throw new BookCreationError('At least one of status, step, or error must be provided', undefined, 400);
  }

  if (step && !Object.keys(storyGenerationSteps).includes(step)) {
    throw new BookCreationError('Invalid step', undefined, 400);
  }

  if (status && !bookGenerationStatuses.includes(status)) {
    throw new BookCreationError('Invalid status', undefined, 400);
  }

  // ── 2. Derive final status (step wins when provided) ─────────────────────
  //
  // IMPORTANT: This derivation MUST happen before the completion-timestamp
  // check below. Previously the check ran on the raw `status` param, which
  // could produce an inconsistent state where `generationCompletedAt` was set
  // while `generationStatus` was simultaneously overridden to `'in_progress'`.
  let finalStatus: BookGenerationStatus | undefined = status;
  if (step === 'complete') {
    finalStatus = 'completed';
  } else if (step === 'theme_validation') {
    finalStatus = 'pending';
  } else if (step) {
    finalStatus = 'in_progress'; // All mid-generation steps indicate active processing
  }

  // ── 3. Build update object ────────────────────────────────────────────────
  //
  // Drizzle ORM omits `undefined` fields from the SET clause, preserving the
  // existing column value. We spread conditionally to avoid accidentally
  // NULLing columns the caller didn't intend to touch.
  const update: Partial<DBNewBookGeneration> = {
    ...(finalStatus !== undefined && { generationStatus: finalStatus }),
    ...(step !== undefined && { generationStep: step }),
    ...(aiFinalComment !== undefined && { aiFinalComment }),
    // Explicitly clear previous errors on progress updates; pass `error` to set one.
    generationError: error ?? null,
  };

  // ── 4. Stamp completion timestamp — only after final status is known ──────
  if (finalStatus === 'completed' || finalStatus === 'failed') {
    update.generationCompletedAt = new Date();
  }

  // ── 5. Terminal-status guard ─────────────────────────────────────────────
  //
  // Never overwrite a row that has already reached a terminal status:
  //   - `'cancelled'` — user cancelled the generation. A delayed webhook from
  //     the dying GitHub runner must not resurrect the status.
  //   - `'completed'` — generation already finished. Prevents races where a
  //     late webhook (already cancelled) could flip it back to 'in_progress'.
  //
  // Non-terminal statuses ('pending', 'in_progress', 'failed') are always
  // overwritable — e.g. retrying a failed generation advances it to in_progress.
  //
  // ── 6. Persist to database ────────────────────────────────────────────────
  await dbWrite
    .update(bookGenerations)
    .set(update)
    .where(
      and(
        eq(bookGenerations.bookId, bookId),
        ne(bookGenerations.generationStatus, 'cancelled'),
        ne(bookGenerations.generationStatus, 'completed'),
      )
    );
}

/**
 * Internal debounced wrapper — one independent timer per `bookId`.
 *
 * Rapid successive calls for the same `bookId` within the 500 ms window are
 * collapsed; only the trailing (latest) call reaches the database.
 * Different `bookId`s are processed independently.
 */
const debouncedUpdateStatus = debounceAsync(
  updateBookGenerationStatusCore,
  { delay: 500, trailing: true, leading: false }
);

/**
 * Updates book generation status with per-bookId debouncing.
 *
 * Suitable for high-frequency progress events from the GitHub Actions runner
 * (e.g., every AI generation step). Rapid calls within 500 ms are batched so
 * only the latest value is written.
 *
 * For one-off writes where immediate persistence matters (e.g., cancellation),
 * write directly to `bookGenerations` via `dbWrite` instead of calling this.
 *
 * Debounce semantics:
 * - Trailing edge only (`leading: false`)
 * - 500 ms delay per `bookId`
 * - Awaiting the returned Promise resolves when the DB write completes
 *
 * @param payload.bookId  - Target book ID (required, used as debounce key)
 * @param payload.status  - Optional explicit generation status
 * @param payload.step    - Optional generation step (auto-derives status)
 * @param payload.error   - Optional error message for failed states
 * @param payload.aiFinalComment - Optional AI final comment to persist on completion
 *
 * @example
 * // Progress update (debounced)
 * await updateBookGenerationStatus({ bookId, step: 'ai_generation' });
 *
 * // Failure update
 * await updateBookGenerationStatus({ bookId, status: 'failed', error: 'AI timeout' });
 */
export async function updateBookGenerationStatus(payload: BookGenerationPayload): Promise<void> {
  const { bookId, status, step, error, aiFinalComment } = payload;
  console.log('[updateBookGenerationStatus] 🧩 Updating generation progress:', cleanupObject(payload));

  try {
    await debouncedUpdateStatus(bookId, status, step, error, aiFinalComment);
  } catch (err) {
    console.error('[updateBookGenerationStatus] ❌ Failed to update generation status:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// triggerBookGenerationWorkflow
// ---------------------------------------------------------------------------

/**
 * Dispatches the GitHub Actions `on-demand-book-creation.yml` workflow for a
 * given `bookId`.
 *
 * The dispatch is **fire-and-forget** — this function returns immediately and
 * the caller does not need to await the GitHub API response. Errors are logged
 * but do not propagate to the caller, because the stale-detection mechanism
 * in `GET /api/books/:bookId/status` will re-trigger the workflow if it never
 * started within `PENDING_TIMEOUT_MS`.
 *
 * Used by:
 * - `POST /api/books/async`         — initial dispatch after credit consumption
 * - `GET /api/books/:bookId/status` — stale-detection re-trigger
 * - Hourly cron job routine         — retry for stuck pending books
 *
 * @param bookId  - Target book ID (UUID v7); validated before dispatch
 * @param context - Caller identifier for structured log entries
 */
export function triggerBookGenerationWorkflow(bookId: string, context: string): void {
  // Validate bookId format before triggering workflow
  if (!isValidUuid(bookId)) {
    console.error(`[${context}] ❌ Invalid bookId format, aborting workflow dispatch: ${bookId}`);
    return;
  }

  dispatchGitHubWorkflow(
    GITHUB_REPO_CONFIG,
    {
      workflowFile: 'on-demand-book-creation.yml',
      inputs: { book_id: bookId }
    },
    {
      context,
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 4000
    }
  ).then((result) => {
    if (!result.success) {
      console.error(`[${context}] ❌ Failed to dispatch workflow for book ${bookId}:`, result.error);
    }
  }).catch((err) => {
    console.error(`[${context}] ⚠️ Unexpected error dispatching workflow for book ${bookId}:`, err);
  });
}

// ---------------------------------------------------------------------------
// isGenerationStale
// ---------------------------------------------------------------------------

/**
 * Determines whether a book generation is stale and should be re-triggered.
 *
 * A generation is considered stale in two distinct scenarios:
 *
 * **Scenario A — stuck in `'pending'`** (workflow never started):
 * - `generationStartedAt` is set and older than `PENDING_TIMEOUT_MS`
 * - OR `generationStartedAt` is null but `createdAt` is older than `PENDING_TIMEOUT_MS`
 *   (edge case where the initial workflow dispatch failed silently)
 *
 * **Scenario B — stuck in `'in_progress'`** (generation crashed mid-run):
 * - `isGeneratingStartedAt` is set and older than `MAX_GENERATION_DURATION_MS`
 *
 * @param params - Snapshot of DB fields needed for staleness evaluation
 * @returns `true` if generation is stale and a re-trigger is warranted
 *
 * @example
 * const stale = isGenerationStale({
 *   generationStatus: 'pending',
 *   generationStartedAt: new Date('2026-05-26T09:00:00Z'),
 *   isGeneratingStartedAt: null,
 *   createdAt: new Date('2026-05-26T08:55:00Z'),
 * });
 */
export function isGenerationStale(
  params: Pick<DBBookGeneration, 'generationStatus' | 'generationStartedAt' | 'isGeneratingStartedAt'> & { createdAt: Date | null }
): boolean {
  const { generationStatus, generationStartedAt, isGeneratingStartedAt, createdAt } = params;
  const now = Date.now();

  if (generationStatus === 'pending') {
    // Workflow was triggered but never picked up the job
    if (generationStartedAt) {
      return now - new Date(generationStartedAt).getTime() > PENDING_TIMEOUT_MS;
    }
    // Workflow dispatch itself may have failed — fall back to book creation time
    if (createdAt) {
      return now - new Date(createdAt).getTime() > PENDING_TIMEOUT_MS;
    }
  }

  // Generation is running but has exceeded the maximum allowed duration
  if (generationStatus === 'in_progress' && isGeneratingStartedAt) {
    return now - new Date(isGeneratingStartedAt).getTime() > MAX_GENERATION_DURATION_MS;
  }

  return false;
}
