/**
 * @overview Pagination Utility Module
 * 
 * Provides consistent pagination utilities across the application.
 * Implements cursor-based pagination for optimal performance.
 * Supports search and filtering capabilities.
 * 
 * Features:
 * - Cursor-based pagination for large datasets
 * - Search integration with configurable fields
 * - Type-safe pagination parameters
 * - DRY pagination logic across routes
 */

import type { Request } from "express";
import { DEFAULT_ITEMS_PER_PAGE, MAX_ITEMS_PER_PAGE } from "../config/pagination.js";

/**
 * Pagination parameters interface for type safety
 */
export interface PaginationParams {
  /** Current page number (1-based) */
  page?: number;
  /** Number of items per page */
  limit?: number;
  /** Cursor for cursor-based pagination */
  cursor?: string;
  /** Search query string */
  search?: string;
  /** Field to sort by */
  sortBy?: string;
  /** Sort direction (asc|desc) */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Pagination metadata interface
 */
export interface PaginationMeta {
  /** Current page number */
  page: number;
  /** Items per page */
  limit: number;
  /** Total number of items */
  total: number;
  /** Total number of pages */
  totalPages: number;
  /** Next page cursor (if applicable) */
  nextCursor?: string;
  /** Previous page cursor (if applicable) */
  prevCursor?: string;
}

/**
 * Paginated response interface
 */
export interface PaginatedResponse<T> {
  /** Array of items */
  items: T[];
  /** Pagination metadata */
  pagination: PaginationMeta;
}

/**
 * Extracts pagination parameters from Express request
 * 
 * @param req - Express request object
 * @param defaultLimit - Default items per page (uses config default if not provided)
 * @returns Normalized pagination parameters
 * 
 * @example
 * ```typescript
 * const params = extractPaginationParams(req, 20);
 * // Returns: { page: 1, limit: 20, search: "thriller" }
 * ```
 */
export function extractPaginationParams(req: Request, defaultLimit: number = DEFAULT_ITEMS_PER_PAGE): PaginationParams {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(
    MAX_ITEMS_PER_PAGE, 
    Math.max(1, parseInt(req.query.limit as string) || defaultLimit)
  );
  const cursor = req.query.cursor as string;
  const search = (req.query.search as string || '').trim();
  const sortBy = req.query.sortBy as string;
  const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

  return {
    page,
    limit,
    cursor,
    search,
    sortBy,
    sortOrder
  };
}

/**
 * Calculates pagination metadata
 * 
 * @param page - Current page number
 * @param limit - Items per page
 * @param total - Total number of items
 * @returns Pagination metadata object
 * 
 * @example
 * ```typescript
 * const meta = calculatePaginationMeta(1, 20, 150);
 * // Returns: { page: 1, limit: 20, total: 150, totalPages: 8 }
 * ```
 */
export function calculatePaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Creates a paginated response object
 * 
 * @param items - Array of items to paginate
 * @param pagination - Pagination metadata
 * @returns Paginated response object
 * 
 * @example
 * ```typescript
 * const response = createPaginatedResponse(books, paginationMeta);
 * // Returns: { items: [...], pagination: { page: 1, limit: 20, ... } }
 * ```
 */
export function createPaginatedResponse<T>(
  items: T[],
  pagination: PaginationMeta
): PaginatedResponse<T> {
  return {
    items,
    pagination
  };
}

/**
 * Applies search filter to a query builder
 * 
 * @param search - Search string
 * @param searchFields - Fields to search in
 * @returns Search filter function
 * 
 * @example
 * ```typescript
 * const searchFilter = createSearchFilter("mystery", ["title", "summary"]);
 * // Returns filter function for query builder
 * ```
 */
export function createSearchFilter(
  search: string,
  searchFields: string[]
): (query: any) => any {
  return (query: any) => {
    if (!search) return query;

    // Create OR conditions for search fields
    const searchConditions = searchFields.map(field => `${field} ILIKE '%${search}%'`);

    return query.where(`(${searchConditions.join(' OR ')})`);
  };
}

/**
 * Applies sorting to a query builder
 * 
 * @param query - Query builder
 * @param sortBy - Field to sort by
 * @param sortOrder - Sort direction
 * @returns Modified query builder
 * 
 * @example
 * ```typescript
 * const sortedQuery = applySorting(query, "createdAt", "desc");
 * // Returns query with ORDER BY createdAt DESC
 * ```
 */
export function applySorting(
  query: any,
  sortBy: string = 'updatedAt',
  sortOrder: 'asc' | 'desc' = 'desc'
): any {
  return query.orderBy(`${sortBy} ${sortOrder.toUpperCase()}`);
}
