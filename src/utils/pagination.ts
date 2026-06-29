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
import type { PaginationMeta, ResourceName } from "../types/api.js";

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
  /** Collection name to filter favorites */
  collection?: string;
}

/**
 * Paginated response interface with dynamic resource naming
 */
export interface PaginatedResponse<T> {
  [key: string]: T[] | PaginationMeta;
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
  const lastUpdated = req.query.lastUpdated as string | undefined;
  const language = req.query.language as string | undefined;
  const tags = req.query.tags as string | undefined;
  const ageRange = req.query.ageRange as string | undefined;
  const gender = req.query.gender as string | undefined;
  const collection = (req.query.collection as string || '').trim() || undefined;

  return {
    page,
    limit,
    cursor,
    search,
    sortBy,
    sortOrder,
    lastUpdated,
    language,
    tags,
    ageRange,
    gender,
    collection,
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
export function createPaginatedResponse<T>(
  items: T[],
  pagination: PaginationMeta,
  resourceName?: ResourceName
): PaginatedResponse<T> {
  return {
    [resourceName || 'items']: items,
    pagination
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
