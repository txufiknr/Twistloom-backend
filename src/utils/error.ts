/**
 * @overview Error Handling Utilities Module
 * 
 * Provides standardized error handling for API routes with consistent response format.
 * Implements development vs production error detail management for security.
 * 
 * Features:
 * - Consistent error response format across all routes
 * - Development vs production error detail handling
 * - Centralized error logging and response formatting
 * - Type-safe error handling with proper status codes
 * - Gemini API error handling with structured detail processing
 */

import type { Response } from "express";
import { IS_DEVELOPMENT } from "../config/constants.js";
// import type { GeminiResponse, ErrorInfo, QuotaFailure, RetryInfo, Help } from "../types/gemini.js";

/**
 * Standardized error response interface
 */
export interface ErrorResponse {
  success: false;
  error: string;
  details?: string;
}

/**
 * Handles API errors with consistent logging and response format.
 * Provides detailed error information in development mode only.
 * 
 * @param res - Express response object
 * @param message - User-friendly error message
 * @param error - Error object or unknown error
 * @param statusCode - HTTP status code (default: 500)
 * 
 * @example
 * ```typescript
 * try {
 *   const result = await someOperation();
 *   res.json(result);
 * } catch (error) {
 *   handleApiError(res, "Operation failed", error, 500);
 * }
 * ```
 * 
 * Behavior:
 * - Logs full error to console for debugging
 * - Returns standardized error response format
 * - Includes error details only in development mode
 * - Handles both Error objects and unknown types safely
 * 
 * Security:
 * - Production responses exclude sensitive error details
 * - Development responses include full error stack traces
 * - Sanitizes error messages for user consumption
 */
export function handleApiError(
  res: Response,
  message: string,
  error?: unknown,
  statusCode?: number
): Response {
  // Log the full error for debugging
  if (error) console.error(error);

  // Build error response
  const errorResponse: ErrorResponse = {
    success: false,
    error: message,
  };

  // Include error details only in development mode
  if (error && IS_DEVELOPMENT) {
    if (typeof error === 'object' && error !== null) {
      errorResponse.details = JSON.stringify(error, null, 2);
    } else {
      errorResponse.details = String(error);
    }
  }

  // Send error response
  return res.status(statusCode ?? 500).json(errorResponse);
}

/**
 * Handles validation errors with 400 status code.
 * Use for client-side input validation failures.
 * 
 * @param res - Express response object
 * @param message - Validation error message
 * @param error - Optional validation error details
 * 
 * @example
 * ```typescript
 * if (!req.body.clusterId) {
 *   handleValidationError(res, "clusterId is required");
 *   return;
 * }
 * ```
 */
export function handleValidationError(
  res: Response,
  message: string,
  error?: unknown
): void {
  handleApiError(res, message, error, 400);
}

/**
 * Handles not found errors with 404 status code.
 * Use for resources that don't exist.
 * 
 * @param res - Express response object
 * @param message - Not found error message
 * @param error - Optional error details
 * 
 * @example
 * ```typescript
 * const resource = await findResource(id);
 * if (!resource) {
 *   handleNotFoundError(res, "Resource not found");
 *   return;
 * }
 * ```
 */
export function handleNotFoundError(
  res: Response,
  message: string,
  error?: unknown
): void {
  handleApiError(res, message, error, 404);
}

/**
 * Handles unauthorized errors with 401 status code.
 * Use for authentication failures.
 * 
 * @param res - Express response object
 * @param message - Unauthorized error message
 * @param error - Optional error details
 * 
 * @example
 * ```typescript
 * if (!req.userId) {
 *   handleUnauthorizedError(res, "Authentication required");
 *   return;
 * }
 * ```
 */
export function handleUnauthorizedError(
  res: Response,
  message: string,
  error?: unknown
): void {
  handleApiError(res, message, error, 401);
}

/**
 * Handles forbidden errors with 403 status code.
 * Use for authorization failures.
 * 
 * @param res - Express response object
 * @param message - Forbidden error message
 * @param error - Optional error details
 * 
 * @example
 * ```typescript
 * if (!hasPermission(req.userId, resource)) {
 *   handleForbiddenError(res, "Access denied");
 *   return;
 * }
 * ```
 */
export function handleForbiddenError(
  res: Response,
  message: string,
  error?: unknown
): void {
  handleApiError(res, message, error, 403);
}

/**
 * Handles rate limit errors with 429 status code.
 * Use for rate limiting violations.
 * 
 * @param res - Express response object
 * @param message - Rate limit error message
 * @param error - Optional error details
 * 
 * @example
 * ```typescript
 * if (requestCount > maxRequests) {
 *   handleTooManyRequestsError(res, "Rate limit exceeded");
 *   return;
 * }
 * ```
 */
export function handleTooManyRequestsError(
  res: Response,
  message: string,
  error?: unknown
): void {
  handleApiError(res, message, error, 429);
}

type GenAIErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INVALID_API_KEY'
  | 'SAFETY_BLOCKED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export function classifyGenAIError(err: unknown): GenAIErrorCode {
  const msg = getErrorMessage(err).toLowerCase();

  if (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('exceeded')
  ) {
    return 'QUOTA_EXCEEDED';
  }

  if (msg.includes('429') || msg.includes('rate limit')) {
    return 'RATE_LIMITED';
  }

  if (msg.includes('403') || msg.includes('api key')) {
    return 'INVALID_API_KEY';
  }

  if (msg.includes('safety')) {
    return 'SAFETY_BLOCKED';
  }

  if (msg.includes('fetch') || msg.includes('network')) {
    return 'NETWORK_ERROR';
  }

  return 'UNKNOWN';
}

/**
 * Checks if an error is an undici abort error (UND_ERR_ABORTED)
 * @param error - Error object or unknown error type
 * @returns True if the error is an undici abort error
 */
function isUndiciAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return (error as any).code === 'UND_ERR_ABORTED' || 
           error.name === 'AbortError' || 
           error.message.includes('AbortError') ||
           getErrorName(error).includes('AbortError');
  }
  return false;
}

/**
 * Safely extracts error message string from any error type.
 * Handles Error objects, strings, and unknown error types.
 * 
 * @param error - Error object, string, or unknown error type
 * @returns Error message as string
 * 
 * @example
 * ```typescript
 * try {
 *   await someOperation();
 * } catch (error) {
 *   const message = getErrorMessage(error);
 *   console.error(message);
 * }
 * ```
 */
export function getErrorMessage(error: unknown, fallback: string = 'Unknown error'): string {
  return error instanceof Error ? error.message : error ? String(error) : fallback;
  // return String((error as any)?.message ?? error);
}

/**
 * Safely extracts error name/constructor name from any error type.
 * Handles Error objects and unknown error types.
 * 
 * @param error - Error object or unknown error type
 * @returns Error name as string
 * 
 * @example
 * ```typescript
 * try {
 *   await someOperation();
 * } catch (error) {
 *   const name = getErrorName(error);
 *   console.error(`${name}: ${getErrorMessage(error)}`);
 * }
 * ```
 */
export function getErrorName(error: unknown, fallback: string = 'UnknownError'): string {
  if (error instanceof Error) {
    // For undici errors, prioritize the code over constructor name
    if ((error as any).code === 'UND_ERR_ABORTED') return 'AbortError';
    return error.name || error.constructor.name;
  }
  return fallback;
}

/**
 * Export the undici abort error detection function for use in other modules
 */
export { isUndiciAbortError };
