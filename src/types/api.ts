/**
 * API Response Types
 * 
 * Type definitions for API response patterns and resource naming conventions.
 */

import type { PgTransaction } from "drizzle-orm/pg-core";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DBTransaction = PgTransaction<any, any, any>;
