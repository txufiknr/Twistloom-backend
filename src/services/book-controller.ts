/**
 * @overview Book Controller Service
 * 
 * Provides reusable query builders for book endpoints with enriched data.
 * Handles joins for author information, engagement metrics, and user-specific states.
 * 
 * Features:
 * - Author penName from users table
 * - Aggregate counts (likes, reads) from related tables
 * - User-specific flags (isLiked, isRead) based on authenticated user
 * - DRY query builders for consistent book data across endpoints
 * - Shared search, filter, and pagination logic
 * 
 * Performance:
 * - Uses SQL subqueries within SELECT for single-query execution
 * - Optimal for paginated results (O(n) where n = page size, not total books)
 * - Leverages existing database indexes on targetId, bookId, and userId
 * - PostgreSQL query planner optimizes correlated subqueries with indexes
 * - Avoids N+1 query problem
 */

import { sql, and, or, eq, desc } from "drizzle-orm";
import { books, users } from '../db/schema.js';
import type { Response } from "express";
import type { BookPageVisit, BookSortOption, EnrichedBookData } from "../types/book.js";
import { applySorting } from '../utils/pagination.js';
import { dbRead } from "../db/client.js";
import { createRelevanceExpression } from "../utils/search.js";
import type { DBBookTranslations, DBPage } from "../types/schema.js";
import { getEnrichedBook, getPageActionsFromDB, getPageFromDB } from "./book.js";
import type { Action } from "../types/story.js";
import { handleForbiddenError, handleNotFoundError } from "../utils/error.js";
import { markPageVisited } from "./story.js";
import { FREE_ACTION_SELECTION_UNTIL_PAGE } from "../config/story.js";

/**
 * Builds an enriched book select object with all required fields
 * 
 * Uses denormalized columns (likes_count, read_count) for O(1) performance on aggregate metrics.
 * User-specific flags (isLiked, isRead) still use EXISTS subqueries which are fast with indexes.
 * 
 * Performance Characteristics:
 * - likesCount and readCount: O(1) - direct column access (updated via triggers)
 * - isLiked and isRead: O(log n) - EXISTS subquery with proper indexes
 * - Overall: ~10-50ms for 100 books (vs 50-200ms with COUNT subqueries)
 * 
 * Denormalization Benefits:
 * - Eliminates COUNT(*) subqueries for likes/reads
 * - Triggers keep counts synchronized automatically
 * - No cache invalidation needed
 * - Always consistent with source data
 * 
 * User-specific Flags:
 * - Still use EXISTS subqueries (fast with indexes on user_id, target_id/book_id)
 * - Cannot be denormalized without per-user tables
 * - Performance acceptable since only 2 subqueries per book
 * 
 * @param currentUserId - Optional current user ID for user-specific flags (isLiked, isRead)
 * @param language - Optional language code to include translation data (e.g., "es", "fr")
 * @returns Select object with enriched book fields
 */
export function getEnrichedBookSelect(currentUserId: string | null = null, language: string | null = null) {
  return {
    // Basic book fields
    id: books.id,
    userId: books.userId,
    slug: books.slug,
    title: books.title,
    hook: books.hook,
    summary: books.summary,
    image: books.image,
    keywords: books.keywords,
    status: books.status,
    trendingScore: books.trendingScore,
    totalPages: books.totalPages,
    language: books.language,
    topPick: books.topPick,
    isOriginal: books.isOriginal,
    createdAt: books.createdAt,
    updatedAt: books.updatedAt,
    mc: books.mc,
    // Author info
    author: {
      id: users.userId,
      email: users.email,
      username: users.username,
      name: users.penName || users.name,
      image: users.image,
    },
    // Denormalized engagement metrics (O(1) performance, maintained by trigger)
    stats: {
      likesCount: books.likesCount,
      readCount: books.readCount,
      commentsCount: books.commentsCount,
      branchesCount: books.branchesCount,
      completeCount: books.completeCount,
    },
    // User-specific flags (indexed by userId and targetId/bookId)
    isLiked: currentUserId 
      ? sql<boolean>`EXISTS (
          SELECT 1 
          FROM user_likes 
          WHERE user_id = ${currentUserId} AND target_type = 'book' AND target_id = books.id
        )`
      : sql<boolean>`false`,
    isRead: currentUserId
      ? sql<boolean>`EXISTS (
          SELECT 1 
          FROM user_sessions 
          WHERE user_id = ${currentUserId} AND book_id = books.id
        )`
      : sql<boolean>`false`,
    isCompleted: currentUserId
      ? sql<boolean>`EXISTS (
          SELECT 1 
          FROM user_completed_books 
          WHERE user_id = ${currentUserId} AND book_id = books.id
        )`
      : sql<boolean>`false`,
    // Last read tracking (optional fields for user session data) - combined lateral join for better performance
    lastReadAt: currentUserId
      ? sql<Date | null>`(
          SELECT ls.updated_at 
          FROM LATERAL (
            SELECT updated_at, page_id 
            FROM user_sessions 
            WHERE user_id = ${currentUserId} AND book_id = books.id
            ORDER BY updated_at DESC
            LIMIT 1
          ) ls
        )`
      : sql<Date | null>`null`,
    lastPage: currentUserId
      ? sql<string | null>`(
          SELECT ls.page_id::text 
          FROM LATERAL (
            SELECT updated_at, page_id 
            FROM user_sessions 
            WHERE user_id = ${currentUserId} AND book_id = books.id
            ORDER BY updated_at DESC
            LIMIT 1
          ) ls
        )`
      : sql<string | null>`null`,
    // First page data (page 1 of the book) - combined lateral join for better performance
    firstPageId: sql<string>`(
      SELECT fp.id 
      FROM LATERAL (
        SELECT id, text 
        FROM pages 
        WHERE book_id = books.id AND page = 1 
        LIMIT 1
      ) fp
    )`,
    // First page text content (page 1 of the book)
    firstPageText: sql<string>`(
      SELECT fp.text 
      FROM LATERAL (
        SELECT id, text 
        FROM pages 
        WHERE book_id = books.id AND page = 1 
        LIMIT 1
      ) fp
    )`,
    // Translation data from bookTranslations table when language is provided and differs from book's original language
    translation: language
      ? sql<DBBookTranslations | null>`(
          SELECT jsonb_build_object(
            'id', bt.id,
            'bookId', bt.book_id,
            'language', bt.language,
            'title', bt.title,
            'hook', bt.hook,
            'summary', bt.summary,
            'keywords', bt.keywords,
            'providerType', bt.provider_type,
            'providerName', bt.provider_name,
            'createdAt', bt.created_at,
            'updatedAt', bt.updated_at
          )
          FROM book_translations bt
          WHERE bt.book_id = books.id AND bt.language = ${language} AND ${language} <> ${books.language}
          LIMIT 1
        )`
      : sql<DBBookTranslations | null>`null`,
  } satisfies Record<keyof EnrichedBookData, unknown>;
}

/**
 * Builds an enriched similar books select object with similarity score
 * 
 * Extends getEnrichedBookSelect to include Jaccard similarity score for ranking.
 * 
 * @param targetKeywords - Keywords array from the target book for similarity calculation
 * @param currentUserId - Optional current user ID for user-specific flags (isLiked, isRead)
 * @param language - Optional language code to include translation data (e.g., "es", "fr")
 * @returns Select object with enriched book fields and similarity score
 */
export function getSimilarBookSelect(targetKeywords: string[], currentUserId: string | null = null, language: string | null = null) {
  const baseSelect = getEnrichedBookSelect(currentUserId, language);
  
  // Construct the similarity calculation SQL fragment for reuse in SELECT and ORDER BY
  // TODO: add `books.keywordsText` column (updated via trigger) to eliminate heavy CTE calculations
  const targetKeywordsJson = sql.raw(`'${JSON.stringify(targetKeywords).replace(/'/g, "''")}'::jsonb`);
  const similarityCalculation = sql<number>`
    (
      WITH book_elems AS (
        SELECT DISTINCT jsonb_array_elements_text(${books.keywords}) AS elem
      ),
      target_elems AS (
        SELECT DISTINCT elem
        FROM jsonb_array_elements_text(${targetKeywordsJson}) AS elem
      ),
      intersection_count AS (
        SELECT COUNT(*)::float AS count
        FROM book_elems b
        INNER JOIN target_elems t ON b.elem = t.elem
      ),
      union_count AS (
        SELECT COUNT(*)::float AS count
        FROM (
          SELECT elem FROM book_elems
          UNION
          SELECT elem FROM target_elems
        ) u
      )
      SELECT i.count / NULLIF(u.count, 0)
      FROM intersection_count i, union_count u
    )
  `;
  
  return {
    ...baseSelect,

    // Calculate Jaccard similarity using jsonb array operations
    // J(A, B) = |A ∩ B| / |A ∪ B|
    // Work entirely with jsonb and text values, never cast to text[]
    similarityScore: similarityCalculation,
    // Also include the calculation for ORDER BY reference
    similarityScoreExpr: similarityCalculation,
  };
}

/**
 * Builds time-based filter condition for lastUpdated parameter
 * 
 * @param lastUpdated - Time filter value: anytime|today|this-week|this-month|this-year
 * @returns SQL condition or null if anytime/invalid
 */
export function buildTimeFilterCondition(lastUpdated?: string) {
  if (!lastUpdated || lastUpdated === 'anytime') {
    return null;
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (lastUpdated) {
    case 'today': {
      return sql`${books.updatedAt} >= ${startOfDay}`;
    }
    case 'this-week': {
      const startOfWeek = new Date(startOfDay);
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      return sql`${books.updatedAt} >= ${startOfWeek}`;
    }
    case 'this-month': {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return sql`${books.updatedAt} >= ${startOfMonth}`;
    }
    case 'this-year': {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      return sql`${books.updatedAt} >= ${startOfYear}`;
    }
    default:
      return null;
  }
}

/**
 * Builds tags filter condition with OR logic (books matching ANY tag)
 * 
 * @param tags - Array of tag strings to filter by
 * @returns SQL condition or null if no tags
 */
export function buildTagsFilterCondition(tags: string[]) {
  if (!tags || tags.length === 0) {
    return null;
  }

  const tagConditions = tags.map(tag => 
    sql`${books.keywords} @> ${JSON.stringify([tag])}::jsonb`
  );

  return or(...tagConditions);
}

/**
 * Builds language filter condition
 * 
 * @param language - ISO 639-1 language code (e.g., "en", "es")
 * @returns SQL condition or null if no language
 */
export function buildLanguageFilterCondition(language?: string) {
  if (!language) {
    return null;
  }

  return eq(books.language, language);
}

/**
 * Builds age range filter condition for main character age
 * 
 * @param minAge - Minimum age (inclusive)
 * @param maxAge - Maximum age (inclusive)
 * @returns SQL condition or null if no age range
 */
export function buildAgeRangeFilterCondition(minAge?: number, maxAge?: number) {
  if (minAge === undefined || maxAge === undefined) {
    return null;
  }

  // Filter by books.mc->age field (JSONB)
  // Parentheses required to cast the extracted value, not the key string
  return sql`(${books.mc}->>'age')::int BETWEEN ${minAge} AND ${maxAge}`;
}

/**
 * Builds gender filter condition for main character gender
 * 
 * @param gender - Gender value (male/female)
 * @returns SQL condition or null if no gender
 */
export function buildGenderFilterCondition(gender?: string) {
  if (!gender) {
    return null;
  }

  // Filter by books.mc->gender field (JSONB)
  return sql`${books.mc}->>'gender' = ${gender}`;
}

/**
 * Builds search condition with ILIKE patterns for multiple fields
 * 
 * @param search - Search query string
 * @returns SQL condition or null if no search
 */
export function buildSearchCondition(search?: string) {
  if (!search) {
    return null;
  }

  const searchPattern = `%${search}%`;
  const searchConditions = [
    sql`${books.title} ILIKE ${searchPattern}`,
    sql`${books.hook} ILIKE ${searchPattern}`,
    sql`${books.summary} ILIKE ${searchPattern}`,
    sql`${books.keywords} ILIKE ${searchPattern}`
  ];

  return or(...searchConditions);
}

/**
 * Builds comprehensive book query with filtering, sorting, and search
 * 
 * Provides a unified interface for building book queries across endpoints.
 * Handles all filtering options, search relevance scoring, and specialized book sorting.
 * 
 * Sorting Hierarchy:
 * 1. Primary: Book-specific sorting (applyBookSorting) - handles popular, trending, top-picks, originals, newest
 * 2. Secondary: Contextual sorting - relevance for search, generic column sorting otherwise
 * 
 * @param params - Query parameters object
 * @param booksTable - Drizzle books table reference
 * @param currentUserId - Optional current user ID for user-specific fields
 * @returns Object with query, countQuery, and finalCondition
 * 
 * @example
 * ```typescript
 * const { query, countQuery, finalCondition } = buildBookQuery({
 *   baseQuery: dbRead.select(getEnrichedBookSelect(userId)).from(books),
 *   baseCondition: eq(books.userId, userId),
 *   search: sanitizedSearch,
 *   bookSortBy: 'trending',
 *   genericSortBy: 'updatedAt',
 *   sortOrder: 'desc',
 *   tags: ['thriller', 'mystery'],
 *   language: 'en',
 *   lastUpdated: 'this-week'
 * }, books, userId);
 * ```
 */
export function buildBookQuery<T>(
  params: {
    /** Base query builder with selects and joins already applied */
    baseQuery: T;
    /** Base condition for the query (e.g., user filter, status filter) */
    baseCondition: ReturnType<typeof sql>;
    /** Search query string (sanitized) */
    search?: string;
    /** Book-specific sort option (primary sort) */
    bookSortBy?: BookSortOption;
    /** Generic field to sort by (secondary sort, used when no search) */
    genericSortBy?: string;
    /** Sort direction for secondary sort */
    sortOrder?: 'asc' | 'desc';
    /** Tags array for filtering */
    tags?: string[];
    /** Language filter */
    language?: string;
    /** Time filter */
    lastUpdated?: string;
    /** Age range filter (minAge, maxAge) */
    minAge?: number;
    maxAge?: number;
    /** Gender filter */
    gender?: string;
    /** Current user ID for user-specific sorting (reads, recommendations) */
    currentUserId?: string | null;
  }
) {
  const { baseQuery, baseCondition, search, bookSortBy, genericSortBy, sortOrder, tags, language, lastUpdated, minAge, maxAge, gender, currentUserId } = params;
  
  // Build filter conditions using shared helpers
  const timeCondition = buildTimeFilterCondition(lastUpdated);
  const languageCondition = buildLanguageFilterCondition(language);
  const searchCondition = buildSearchCondition(search);
  const tagsCondition = buildTagsFilterCondition(tags || []);
  const ageRangeCondition = buildAgeRangeFilterCondition(minAge, maxAge);
  const genderCondition = buildGenderFilterCondition(gender);
  
  // Combine all conditions with base condition
  const finalCondition = combineFilterConditions(
    baseCondition,
    timeCondition,
    languageCondition,
    searchCondition,
    tagsCondition,
    ageRangeCondition,
    genderCondition
  );
  
  // Apply secondary sorting: contextual sorting (before where to allow addSelect)
  let query = baseQuery;
  if (search) {
    // Search relevance scoring takes precedence over generic sorting
    const relevanceExpression = createRelevanceExpression(search, books);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any).addSelect({
      relevanceScore: relevanceExpression
    });
  }

  // Apply where condition to main query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = (query as any).where(finalCondition);
  
  // Apply primary sorting: book-specific sorting (acts as category filter)
  if (bookSortBy) {
    query = applyBookSorting(query, bookSortBy, currentUserId);
  }
  
  // Apply orderBy for search relevance
  if (search) {
    const relevanceExpression = createRelevanceExpression(search, books);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any).orderBy(desc(relevanceExpression));
  } else if (genericSortBy) {
    // Apply generic column sorting only when no search
    query = applySorting(query, genericSortBy, sortOrder);
  }
  
  // Build count query for pagination
  const countQuery = dbRead
    .select({ count: sql`COUNT(*)::int` })
    .from(books)
    .where(finalCondition);
  
  return {
    query,
    countQuery,
    finalCondition
  };
}

/**
 * Combines multiple filter conditions into a single AND condition
 * 
 * @param conditions - Array of SQL conditions (can include nulls/undefined)
 * @returns Combined AND condition, single condition, or always-true condition
 */
export function combineFilterConditions(...conditions: (ReturnType<typeof sql> | null | undefined)[]) {
  const validConditions = conditions.filter((c): c is ReturnType<typeof sql> => c !== null && c !== undefined);
  
  if (validConditions.length === 0) return sql`1=1`; // Always true condition when no filters
  if (validConditions.length === 1) return validConditions[0];
  
  return and(...validConditions);
}

/**
 * Applies book-specific sorting to a query based on sort option
 * 
 * @param query - Drizzle query builder
 * @param sortBy - Sort option (popular, newest, trending, top-picks, originals, reads, recommendations)
 * @param currentUserId - Optional current user ID for user-specific sorting (reads, recommendations)
 * @returns Modified query builder with sorting applied
 * 
 * Behavior:
 * - popular: Sorts by branchesCount/totalPages ratio (highest first)
 * - newest: Sorts by createdAt (latest first)
 * - trending: Sorts by weighted formula: readCount(0.5) + likesCount(0.3) + favoritedCount(0.2)
 * - top-picks: Sorts by latest topPick timestamp (only books marked as editor's picks)
 * - originals: Filters by isOriginal: true (auto-generated books via cron job), sorts by createdAt (newest first)
 * - reads: Filters to books user has read (from userSessions), sorts by lastReadAt (most recent first)
 * - recommendations: Recommends books based on user likes (similar books to what user liked)
 * 
 * @remarks
 * Uses `any` type for query parameter because Drizzle ORM query builder types
 * are extremely complex generic types that don't fit well into simple type constraints.
 * Type safety is maintained through the actual database operations and SQL generation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBookSorting(query: any, sortBy: BookSortOption = 'newest', currentUserId?: string | null): any {
  switch (sortBy) {
    case 'popular': {
      // Sort by branchesCount/totalPages ratio (pre-calculated branchesCount maintained by trigger)
      return query.orderBy(
        sql`(COALESCE(${books.branchesCount}, 0)::float / NULLIF(${books.totalPages}, 0)) DESC`
      );
    }

    case 'trending': {
      // Sort by pre-calculated trendingScore (updated daily via cron job with time decay)
      return query.orderBy(desc(books.trendingScore));
    }

    case 'top-picks': {
      // Sort by latest topPick timestamp (only books marked as top picks)
      return query
        .where(sql`${books.topPick} IS NOT NULL`)
        .orderBy(desc(books.topPick));
    }

    case 'originals': {
      // Filter by isOriginal: true (auto-generated books via cron job) and has cover image
      // Sort by creation date (newest first)
      // Note: Intentionally filtering to only show originals with covers for quality control
      // Auto-generated books without covers are excluded from the originals list
      return query
        .where(eq(books.isOriginal, true))
        .where(sql`${books.image} IS NOT NULL`)
        .orderBy(desc(books.createdAt));
    }

    case 'reads': {
      // Filter to books the user has read (from userSessions)
      // Sort by lastReadAt (most recent first)
      // Requires authentication
      if (!currentUserId) {
        // If no user provided, return empty result (should be handled by requireAuth middleware)
        return query.where(sql`1=0`);
      }
      return query
        .where(sql`EXISTS (
          SELECT 1 FROM user_sessions 
          WHERE user_id = ${currentUserId} AND book_id = books.id
        )`)
        .orderBy(sql`COALESCE(last_read_at, ${books.updatedAt}) DESC`);
    }

    case 'recommendations': {
      // Recommend books based on user likes
      // Get books similar to what the user has liked using keyword similarity
      // Requires authentication
      if (!currentUserId) {
        // If no user provided, return empty result (should be handled by requireAuth middleware)
        return query.where(sql`1=0`);
      }
      
      // Get user's liked books' keywords for similarity calculation
      // Recommend books that have keyword overlap with user's liked books
      return query
        .where(sql`EXISTS (
          SELECT 1 
          FROM user_likes ul
          INNER JOIN books liked_books ON ul.target_id = liked_books.id
          WHERE ul.user_id = ${currentUserId} 
            AND ul.target_type = 'book' 
            AND liked_books.id != books.id
            AND books.keywords && liked_books.keywords
        )`)
        .orderBy(desc(books.trendingScore)); // Sort by trending as fallback for recommendations
    }

    case 'newest':
    default: {
      return query.orderBy(desc(books.createdAt));
    }
  }
}

/**
 * Visits a book page by validating navigation, recording progress, and calculating visit statistics
 * 
 * This function handles the complete flow of a user visiting a page:
 * 1. Validates the page exists and belongs to the specified book
 * 2. For non-root pages (page > 1), validates the navigation action from parent page
 * 3. Checks if user has already made a different choice on the parent page
 * 4. Records the visit and calculates visit statistics (nth visitor, visitor percentage)
 * 
 * @param res - Express response object for error handling
 * @param params - Parameters for the page visit
 * @param params.userId - The user's unique identifier
 * @param params.pageId - The page identifier to visit
 * @param params.bookIdentifier - Optional book identifier (slug or UUID) for validation
 * @returns Promise resolving to visit details, book data, and page data
 * 
 * Behavior:
 * - For page 1: No action validation required, marks as visited without action
 * - For page > 1: Validates action exists on parent page and user hasn't changed choice
 * - Returns early with error response if validation fails
 * - Calculates visit statistics using denormalized visitCount and readCount
 * 
 * Visit Statistics:
 * - nthVisit: The visit number for this page (e.g., "you're the 100th visitor")
 * - visitorPercentage: Percentage of book readers who have visited this page
 * 
 * Example:
 * ```typescript
 * const { visitDetails, book, dbPage } = await visitBookPage(res, { userId, pageId, bookIdentifier });
 * if (visitDetails) {
 *   console.log(`You're visitor #${visitDetails.nthVisit}`);
 * }
 * ```
 */
export async function visitBookPage(
  res: Response,
  params: { userId?: string, pageId: string, bookIdentifier?: string, skipVisit?: boolean, consumeCredits?: boolean, language?: string | null }
): Promise<{ visitDetails?: BookPageVisit, book?: EnrichedBookData, dbPage?: DBPage, sourceAction?: Action }> {
  const { userId, pageId, bookIdentifier, skipVisit = false, consumeCredits = false, language } = params;
  console.log(`[visit] 👓 Visited pageId:`, pageId, `(skipVisit = ${skipVisit})`);

  // Get page
  const dbPage = await getPageFromDB(pageId, { bookIdentifier });
  if (!dbPage) {
    console.error(`[visit] ❌ Visited page not found:`, pageId);
    handleNotFoundError(res, `Page not found`);
    return {};
  }

  const { page: pageNumber, bookId, parentId: parentPageId } = dbPage;
  console.log(`[visit] 👓 Visited pageNumber:`, pageNumber);

  // Get book
  const book = await getEnrichedBook(bookId, userId, language);
  if (!book) {
    console.error(`[visit] ❌ Book not found:`, bookId);
    handleNotFoundError(res, `Book not found`);
    return {};
  }

  // No user visit track for prefetch (not actual navigation)
  if (skipVisit || !userId) return { dbPage, book };

  // Get parent page and selected action (if it's not page 1)
  let action: Action | undefined;
  let shouldConsumeCredits = false;

  if (pageNumber > 1) {
    const parentDbPage = parentPageId ? await getPageFromDB(parentPageId) : null;
    if (!parentDbPage) {
      console.error(`[visit] ❌ Previous page not found:`, parentPageId);
      handleNotFoundError(res, `Previous page not found for pageNumber ${pageNumber}`);
      return {};
    }
  
    action = parentDbPage.actions.filter(a => a.destination.pageId === pageId)[0];
    if (!action) {
      console.error(`[visit] ❌ Action for this page not found in the parent page:`, parentPageId);
      handleNotFoundError(res, `Action for this page not found in the parent page`);
      return {};
    }

    const isActionMatch = !action || action.destination.pageId === pageId;
    if (!isActionMatch) {
      console.error(`[visitBookPage] ❌ action.destination.pageId and pageId mismatch`);
      return { dbPage, book };
    }

    // Users can go back and select any action they like in page 1
    if (pageNumber > FREE_ACTION_SELECTION_UNTIL_PAGE + 1) {
      // Validate user's action choice: check if user already chose a different action on previous page
      const selectedActions = await getPageActionsFromDB(userId, book.id, parentPageId!);
      if (selectedActions.length > 0) {
        if (!selectedActions.some((a) => a.text === action!.text)) {
          if (!consumeCredits) {
            // User already chose a different action on this page; can't continue except they pay credits
            console.error(`[visit] 💥 Choice made, can't make another choice`);
            handleForbiddenError(res, "Choice made, can't make another choice");
            return {};
          } else {
            shouldConsumeCredits = true;
          }
        }
      }
    }
  }

  // Mark page as visited and persists chosen action
  const visitDetails = await markPageVisited({
    userId,
    book,
    visitedPage: dbPage,
    actionedPageId: parentPageId ?? undefined,
    action,
    shouldConsumeCredits
  });
  return { dbPage, book, visitDetails, sourceAction: action };
}