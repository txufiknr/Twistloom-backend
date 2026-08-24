/**
 * @overview Pagination Utility Module
 * 
 * Provides consistent pagination utilities across the application.
 * Implements offset-based pagination for optimal performance.
 * Supports search and filtering capabilities.
 * 
 * Features:
 * - Offset-based pagination (page + limit)
 * - Search integration with configurable fields
 * - Type-safe pagination parameters
 * - DRY pagination logic across routes
 */

import { DEFAULT_ITEMS_PER_PAGE, MAX_ITEMS_PER_PAGE } from "../config/pagination.js";
import type { PaginationMeta, ResourceName } from "../types/api.js";

/**
 * Pagination parameters interface for type safety
 */
export interface PaginationParams {
  /** Current page number (1-based) */
  page?: number;
  /** Number of items per page */
  limit?: number;
  /** Search query string */
  search?: string;
  /** Field to sort by */
  sortBy?: string;
  /** Sort direction (asc|desc) */
  sortOrder?: 'asc' | 'desc';
  /** Last updated filter */
  lastUpdated?: string;
  /** Language filter */
  language?: string;
  /** Tags filter (comma-separated) */
  tags?: string;
  /** Age range filter (format: n-m, e.g., 18-30) */
  ageRange?: string;
  /** Gender filter (male/female) */
  gender?: string;
  /** Mode filter (novel|interactive|multiverse) */
  mode?: string;
  /** Collection name to filter favorites */
  collection?: string;
  /** Target user ID for viewing another user's favorites/reads */
  profileUserId?: string;
}

/**
 * Paginated response interface with dynamic resource naming
 */
export type PaginatedResponse<T, K extends ResourceName = 'items'> = {
  [P in K]: T[];
} & {
  pagination: PaginationMeta;
};

/**
 * Extracts pagination parameters from a Hono request query record.
 *
 * Accepts the plain query object returned by `c.req.query()` — a record keyed
 * by query-parameter name whose values are strings (or arrays, for repeated
 * keys). This keeps the helper framework-agnostic and removes the need for the
 * Express `Request` shape or `as any` casts.
 *
 * @param query - Query parameters from `c.req.query()`
 * @param defaultLimit - Default items per page (uses config default if not provided)
 * @returns Normalized pagination parameters
 *
 * @example
 * ```typescript
 * const params = extractPaginationParams(c.req.query(), 20);
 * // Returns: { page: 1, limit: 20, search: "thriller" }
 * ```
 */
export function extractPaginationParams(
  query: Record<string, string | string[] | undefined>,
  defaultLimit: number = DEFAULT_ITEMS_PER_PAGE
): PaginationParams {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const page = Math.max(1, parseInt(first(query.page) ?? "") || 1);
  const limit = Math.min(
    MAX_ITEMS_PER_PAGE,
    Math.max(1, parseInt(first(query.limit) ?? "") || defaultLimit)
  );
  const search = (first(query.search) || '').trim();
  const sortBy = first(query.sortBy);
  const sortOrder = (first(query.sortOrder) as 'asc' | 'desc') || 'desc';
  const lastUpdated = first(query.lastUpdated);
  const language = first(query.language);
  const tags = first(query.tags);
  const ageRange = first(query.ageRange);
  const gender = first(query.gender);
  const mode = first(query.mode);
  const collection = (first(query.collection) || '').trim() || undefined;
  const queryUserId = first(query.userId) || undefined;
  const profileUserId = first(query.profileUserId) || undefined;

  return {
    page,
    limit,
    search,
    sortBy,
    sortOrder,
    lastUpdated,
    language,
    tags,
    ageRange,
    gender,
    mode,
    collection,
    /** Target user ID for viewing another user's books. Read from `userId` or `profileUserId` query param. */
    profileUserId: queryUserId || profileUserId,
  };
}

/**
 * Calculates pagination metadata
 * 
 * @param page - Current page number
 * @param limit - Items per page
 * @param totalCount - Total number of items
 * @returns Pagination metadata object
 * 
 * @example
 * ```typescript
 * const meta = calculatePaginationMeta(1, 20, 150);
 * // Returns: { page: 1, limit: 20, totalCount: 150, totalPages: 8, hasNext: true, hasPrevious: false }
 * ```
 */
export function calculatePaginationMeta(
  page: number,
  limit: number,
  totalCount: number
): PaginationMeta {
  const totalPages = Math.ceil(totalCount / limit);
  return {
    page,
    limit,
    totalCount,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1
  };
}

/**
 * Creates a paginated response object
 * 
 * @param items - Array of items to paginate
 * @param pagination - Pagination metadata
 * @param resourceName - Name for the items array (default: "items")
 * @returns Paginated response object
 * 
 * @example
 * ```typescript
 * const response = createPaginatedResponse(books, paginationMeta, 'books');
 * // Returns: { books: [...], pagination: { page: 1, limit: 20, ... } }
 * 
 * const response = createPaginatedResponse(likes, paginationMeta);
 * // Returns: { items: [...], pagination: { page: 1, limit: 20, ... } }
 * ```
 */
export function createPaginatedResponse<T, K extends ResourceName = 'items'>(
  items: T[],
  pagination: PaginationMeta,
  resourceName?: K
): PaginatedResponse<T, K> {
  const key = (resourceName || 'items') as K;
  return {
    [key]: items,
    pagination,
  } as PaginatedResponse<T, K>;
}
