/**
 * API Response Types
 * 
 * Type definitions for API response patterns and resource naming conventions.
 */

/**
 * Valid resource names for paginated responses
 * 
 * These correspond to the resource-specific keys used in API responses
 * following industry-standard public API patterns.
 */
export type ResourceName = 
  | 'books'          // Collection of books
  | 'likes'          // Collection of likes
  | 'favorites'      // Collection of favorites
  | 'comments'       // Collection of comments
  | 'items'          // Generic collection (fallback)
  | 'users'          // Collection of users
  | 'transactions'   // Collection of transactions
  | 'testimonials';  // Collection of testimonials

export type ResourceTranslatorType = 'ai' | 'translator';
export type ResourceTranslatorProvider = 'providerType' | 'providerName' | 'aiModel';
export type ResourceTimestamp = 'createdAt' | 'updatedAt';
export type ResourceAIProvider =
  | 'aiProvider'
  | 'aiModel'
  | 'aiEvalProvider'
  | 'aiEvalModel';

/**
 * AI evaluation quality scores persisted alongside a generated page.
 *
 * `scoreBefore` is the evaluator's quality score of the raw model output
 * (before any corrections); `scoreAfter` is the score after corrections.
 * Both are nullable — they are only present when an evaluation pass ran.
 */
export type ResourceAIScore = 'scoreBefore' | 'scoreAfter';

/**
 * Pagination metadata interface
 */
export interface PaginationMeta {
  /** Current page number */
  page: number;
  /** Items per page */
  limit: number;
  /** Total number of items */
  totalCount: number;
  /** Total number of pages */
  totalPages: number;
  /** Whether next page exists */
  hasNext: boolean;
  /** Whether previous page exists */
  hasPrevious: boolean;
  /**
   * Total number of items ignoring the active search/filter (the unfiltered
   * denominator). Optional — only present when the caller needs a "found M from
   * N total" style label. Computed over the same base condition as the result
   * set but without tag/search/age/gender/mode/rating/lastUpdated filters.
   */
  grandTotal?: number;
}