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

import type { Context } from "hono";
import type { AIChatProvider } from "../types/ai-chat.js";
import { IS_DEVELOPMENT } from "../config/env.js";
import { edgeGroup } from './edge-group.js';

/**
 * Standardized error response interface
 */
export interface ErrorResponse {
  success: false;
  error: string;
  details?: string | object;
}


export type GenAIErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INVALID_API_KEY'
  | 'SAFETY_BLOCKED'
  | 'NETWORK_ERROR'
  | 'INVALID_SCHEMA'
  | 'SCHEMA_TOO_COMPLEX'
  | 'MAX_TOKENS_EXCEEDED'
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'SERVICE_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'UNKNOWN';

/**
 * Error codes that are safe to retry (transient failures that may succeed on retry)
 */
export const RETRYABLE_GENAI_ERROR_CODES: ReadonlySet<GenAIErrorCode> = new Set([
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'NETWORK_ERROR',
]);

/**
 * Error codes that should NOT be retried (will likely fail again on retry)
 */
export const NON_RETRYABLE_GENAI_ERROR_CODES: ReadonlySet<GenAIErrorCode> = new Set([
  'QUOTA_EXCEEDED',
  'INVALID_API_KEY',
  'SAFETY_BLOCKED',
  'INVALID_SCHEMA',
  'SCHEMA_TOO_COMPLEX',
  'MAX_TOKENS_EXCEEDED',
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNKNOWN',
]);

/**
 * Returns true if the given error code represents a transient failure that
 * may succeed if retried (e.g. rate limits, service unavailability, timeouts).
 */
export function isGenAIErrorRetryable(code: GenAIErrorCode): boolean {
  return RETRYABLE_GENAI_ERROR_CODES.has(code);
}

/**
 * Returns true if the given error code represents a permanent failure that
 * will likely recur on retry (e.g. invalid API key, bad request, quota exceeded).
 */
export function isGenAIErrorNonRetryable(code: GenAIErrorCode): boolean {
  return NON_RETRYABLE_GENAI_ERROR_CODES.has(code);
}

/**
 * Internal utility to extract a deep string representation of an error specifically 
 * for the classifier. Safely traverses common provider error structures (like 
 * OpenAI metadata and Cohere bodies) without altering the user-facing `getErrorMessage`.
 */
function getDeepErrorStringForClassification(err: unknown): string {
  let combinedStr = getErrorMessage(err);
  
  if (err instanceof Error) {
    combinedStr += ` ${err.name} ${err.message} ${err.stack || ''}`;
  }
  
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, any>;
    
    // Catch OpenAI deep raw metadata
    if (obj.error?.metadata?.raw) {
      combinedStr += ` ${obj.error.metadata.raw}`;
    }
    
    // Catch Cohere body messages
    if (obj.body?.message) {
      combinedStr += ` ${obj.body.message}`;
    }

    // Catch generic axios/fetch data bodies
    if (obj.response?.data) {
      try {
        combinedStr += ` ${JSON.stringify(obj.response.data)}`;
      } catch {
        // Ignore JSON stringify errors on circular dependencies
      }
    }
  }
  
  return combinedStr.toLowerCase();
}

/**
 * Classify a GenAI-related error into a small set of canonical error codes.
 *
 * The classifier uses conservative substring matching of known provider and
 * transport error phrases (HTTP status codes, short phrases like "rate limit",
 * undici abort errors, etc.). This maps diverse error shapes into a handful
 * of actionable categories consumers can use for retry/backoff decisions,
 * user-facing messages, or metrics.
 *
 * Example mappings:
 * - "413 Request body too large" / "request body too large for model" -> `BAD_REQUEST`
 * - "429" or "rate limit" -> `RATE_LIMITED`
 * - "quota" or "resource_exhausted" -> `QUOTA_EXCEEDED`
 * - "too many tokens" -> `MAX_TOKENS_EXCEEDED`
 *
 * Note: This is a best-effort classifier based on message text and object layout.
 *
 * Two call signatures:
 *   classifyGenAIError(err)                             — provider defaults to 'openrouter'
 *   classifyGenAIError(provider, model, err)            — full context for richer logging
 *
 * @returns One of the `GenAIErrorCode` discriminants describing the category
 * @todo handle "no longer available", "high demand", "usually temporary", "try again later"
 */
export function classifyGenAIError(err: unknown): GenAIErrorCode;
export function classifyGenAIError(provider: AIChatProvider, model: string, err: unknown): GenAIErrorCode;
export function classifyGenAIError(providerOrErr: AIChatProvider | unknown, modelOrErr?: string | unknown, err?: unknown): GenAIErrorCode {
  // Support both call signatures: classifyGenAIError(err) and classifyGenAIError(provider, model, err)
  let provider: AIChatProvider;
  let model: string;
  let error: unknown;
  if (typeof providerOrErr === 'string') {
    provider = providerOrErr as AIChatProvider;
    model = modelOrErr as string;
    error = err as unknown;
  } else {
    provider = 'openrouter';
    model = 'unknown';
    error = providerOrErr;
  }

  // Use deep string extraction to ensure we catch deeply nested raw JSON payloads
  const msg = getDeepErrorStringForClassification(error);
  const logPrefix = `${provider}/${model}`;

  // Check for timeout/transport aborts — treat as request timeout for retry/backoff
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('request timeout') ||
    getErrorName(error).toLowerCase().includes('timeout') ||
    isUndiciAbortError(error)
  ) {
    edgeGroup.wrap(`[${logPrefix}] ⌚ Request timeout:`, async () => {
      console.log(error);
    });
    return 'REQUEST_TIMEOUT';
  }

  // Check for complex schema error BEFORE generic validation/schema
  if (msg.includes('too many states for serving')) {
    edgeGroup.wrap(`[${logPrefix}] 💢 Schema too complex:`, async () => {
      console.log(error);
    });
    return 'SCHEMA_TOO_COMPLEX';
  }

  // Check for max token exhaustion
  if (
    msg.includes('too many tokens') || 
    msg.includes('max tokens must be less than') || 
    msg.includes('max_tokens') || 
    msg.includes('context length exceeded')
  ) {
    edgeGroup.wrap(`[${logPrefix}] 💥 Max tokens exceeded:`, async () => {
      console.log(error);
    });
    return 'MAX_TOKENS_EXCEEDED';
  }

  // Check for schema validation errors
  if (
    msg.includes('invalid schema') ||
    msg.includes('schema missing') ||
    msg.includes('response_format') ||
    msg.includes('json schema') ||
    msg.includes('array schema')
  ) {
    edgeGroup.wrap(`[${logPrefix}] ❗ Schema invalid:`, async () => {
      console.log(error);
    });
    return 'INVALID_SCHEMA';
  }

  // Check for general validation errors
  if (
    msg.includes('validation') ||
    msg.includes('invalid request') ||
    msg.includes('invalid_parameter')
  ) {
    edgeGroup.wrap(`[${logPrefix}] ❗ Validation error:`, async () => {
      console.log(error);
    });
    return 'VALIDATION_ERROR';
  }

  // Check for quota/billing errors
  if (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('exceeded') ||
    msg.includes('billing')
  ) {
    edgeGroup.wrap(`[${logPrefix}] 💥 Quota exceeded:`, async () => {
      console.log(error);
    });
    return 'QUOTA_EXCEEDED';
  }

  // Check for rate limiting
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    edgeGroup.wrap(`[${logPrefix}] 💥 Rate limited:`, async () => {
      console.log(error);
    });
    return 'RATE_LIMITED';
  }

  // Check for payload-too-large / request body too large (HTTP 413)
  // Example: "APIError: 413 Request body too large for gpt-4o model."
  if (
    msg.includes('413') ||
    msg.includes('payload too large') ||
    msg.includes('request body too large') ||
    msg.includes('too large for')
  ) {
    edgeGroup.wrap(`[${logPrefix}] ❗ Bad request (too large):`, async () => {
      console.log(error);
    });
    return 'BAD_REQUEST';
  }

  // Check for API key issues
  if (msg.includes('403') || msg.includes('401') || msg.includes('api key') || msg.includes('unauthorized')) {
    edgeGroup.wrap(`[${logPrefix}] ⚠️ API key invalid:`, async () => {
      console.log(error);
    });
    return 'INVALID_API_KEY';
  }

  // Check for safety/content policy blocks
  if (msg.includes('safety') || msg.includes('content policy') || msg.includes('blocked')) {
    edgeGroup.wrap(`[${logPrefix}] ⚠️ Safety blocked:`, async () => {
      console.log(error);
    });
    return 'SAFETY_BLOCKED';
  }

  // Check for network/fetch errors
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('enetunreach') || msg.includes('econnrefused')) {
    edgeGroup.wrap(`[${logPrefix}] 🛜 Network error:`, async () => {
      console.log(error);
    });
    return 'NETWORK_ERROR';
  }

  // Check for bad request errors (400)
  if (msg.includes('400') || msg.includes('bad request')) {
    edgeGroup.wrap(`[${logPrefix}] ❗ Bad request (other):`, async () => {
      console.log(error);
    });
    return 'BAD_REQUEST';
  }

  // Check for service unavailable errors (503)
  if (
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('try again later')
  ) {
    edgeGroup.wrap(`[${logPrefix}] 🛜 Service unavailable:`, async () => {
      console.log(error);
    });
    return 'SERVICE_UNAVAILABLE';
  }

  edgeGroup.wrap(`[${logPrefix}] ❓ Unknown error:`, async () => {
    console.log(error);
  });
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
  // Handle nested error shape where error.message contains a JSON string with another error object
  // Example: { error: { message: '{"error": {"code": 503, "message": "..."}}', code: 503, status: "..." } }
  if (typeof error === 'object' && error !== null) {
    const errObj = error as any;
    if (errObj.error && typeof errObj.error === 'object' && errObj.error.message) {
      const outerMessage = errObj.error.message;
      if (typeof outerMessage === 'string') {
        try {
          const parsed = JSON.parse(outerMessage);
          if (parsed.error && parsed.error.message) {
            return parsed.error.message;
          }
        } catch {
          // If parsing fails, continue to normal handling
        }
      }
    }
  }

  return error instanceof Error ? error.message : error ? String(error) : fallback;
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
 * Type guard for Node.js error objects with code property
 */
export function hasErrorCode(err: unknown): err is { code: string } {
  return err !== null && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string";
}

/**
 * Export the undici abort error detection function for use in other modules
 */
export { isUndiciAbortError };

// ---------------------------------------------------------------------------
// Hono-native error helpers
//
// Operate on a Hono `Context` and return the `c.json(...)` response so callers
// can `return cApiError(...)`. Used by all route handlers and service functions
// (fully migrated away from Express).
// ---------------------------------------------------------------------------

/**
 * Handles API errors with consistent logging and JSON response on a Hono context.
 */
export function cApiError(
  c: Context,
  message: string,
  error?: unknown,
  statusCode?: number,
) {
  if (error) console.error(`[cApiError] ❌ ${message}:`, error);

  const errorResponse: ErrorResponse = {
    success: false,
    error: getErrorMessage(error, message),
  };

  if (error && IS_DEVELOPMENT) {
    if (typeof error === "object" && error !== null) {
      errorResponse.details = JSON.stringify(error, null, 2);
    } else {
      errorResponse.details = String(error);
    }
  }

  return c.json(errorResponse, (statusCode ?? 500) as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500);
}

/** Validation error (400) on a Hono context. */
export function cValidationError(c: Context, message: string, error?: unknown, statusCode?: number) {
  return cApiError(c, message, error, statusCode ?? 400);
}

/** Not found error (404) on a Hono context. */
export function cNotFoundError(c: Context, message: string, error?: unknown) {
  return cApiError(c, message, error, 404);
}

/** Unauthorized error (401) on a Hono context. */
export function cUnauthorizedError(c: Context, message: string, error?: unknown) {
  return cApiError(c, message, error, 401);
}

/** Forbidden error (403) on a Hono context. */
export function cForbiddenError(c: Context, message: string, error?: unknown) {
  return cApiError(c, message, error, 403);
}

/** Rate limit error (429) on a Hono context. */
export function cRateLimitError(c: Context, message?: string, error?: unknown) {
  return cApiError(c, message ?? "Too many attempts. Please try again later.", error, 429);
}

/** Conflict error (409) on a Hono context. */
export function cConflictError(c: Context, message: string, error?: unknown) {
  return cApiError(c, message, error, 409);
}
