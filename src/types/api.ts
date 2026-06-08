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
  | 'transactions';  // Collection of transactions

export type ResourceTranslatorType = 'ai' | 'translator';
export type ResourceTranslatorProvider = 'providerType' | 'providerName' | 'aiModel';
export type ResourceTimestamp = 'createdAt' | 'updatedAt';
export type ResourceAIProvider =
  | 'aiProvider'
  | 'aiModel'
  | 'aiEvalProvider'
  | 'aiEvalModel';
