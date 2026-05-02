/**
 * SSE (Server-Sent Events) types for real-time progress tracking
 *
 * This module defines types for SSE events used in streaming operations
 * like book creation, providing step-by-step progress feedback to clients.
 */

import type { ThemeValidationResult } from './theme-validation.js';
import type { CreateBookResponse } from './book.js';

/**
 * Progress event types for book creation
 *
 * Each event represents a step in the book creation process:
 * - theme_validation_start: Theme validation is beginning
 * - theme_validation_complete: Theme validation finished with result
 * - book_initialization_start: Book initialization is beginning
 * - ai_generation_start: AI content generation is beginning
 * - ai_generation_complete: AI content generation finished
 * - ai_evaluation_start: AI evaluation phase is beginning (if evaluatorPrompt provided)
 * - ai_evaluation_complete: AI evaluation phase finished
 * - finalizing_start: Database operations and finalization are beginning
 * - complete: Entire process finished with final book data
 * - error: An error occurred during the process
 *
 * @example
 * ```typescript
 * // Emit validation start
 * callback({ type: 'theme_validation_start' });
 *
 * // Emit validation complete with result
 * callback({
 *   type: 'theme_validation_complete',
 *   data: { isValid: true, heuristicResult: {...}, aiResult: {...} }
 * });
 *
 * // Emit completion with final book data
 * callback({
 *   type: 'complete',
 *   data: { book: {...}, firstPage: {...}, initialState: {...} }
 * });
 * ```
 */
export type BookCreationProgressEvent =
  | { type: 'theme_validation_start' }
  | { type: 'theme_validation_complete'; data: ThemeValidationResult }
  | { type: 'book_initialization_start' }
  | { type: 'ai_generation_start' }
  | { type: 'ai_generation_complete' }
  | { type: 'ai_evaluation_start' }
  | { type: 'ai_evaluation_complete' }
  | { type: 'finalizing_start' }
  | { type: 'complete'; data: CreateBookResponse }
  | { type: 'error'; error: string };

/**
 * Progress callback for emitting events
 *
 * Callback function that receives progress events during long-running operations.
 * Can be used for SSE event emission or other progress tracking mechanisms.
 *
 * @param event - Progress event to emit
 * @returns Promise that resolves when event is processed (optional)
 *
 * @example
 * ```typescript
 * // SSE event emission
 * const callback: ProgressCallback = (event) => {
 *   res.write(`data: ${JSON.stringify(event)}\n\n`);
 * };
 *
 * // Console logging (for testing)
 * const logCallback: ProgressCallback = (event) => {
 *   console.log('Progress:', event);
 * };
 *
 * // No-op (for non-SSE endpoints)
 * const noOpCallback: ProgressCallback = () => {};
 * ```
 */
export type ProgressCallback = (event: BookCreationProgressEvent) => void | Promise<void>;
