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
 * - PostgreSQL query planner optimises correlated subqueries with indexes
 * - Avoids N+1 query problem
 */

import { sql, and, eq, desc, arrayOverlaps, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { books, users } from '../db/schema.js';
import { applySorting } from '../utils/pagination.js';
import { dbRead } from "../db/client.js";
import { createRelevanceExpression, buildTokenizedSearchCondition } from "../utils/search.js";
import { getEnrichedBook, getPageActionsFromDB, getPageFromDB } from "./book.js";
import { cNotFoundError, cForbiddenError } from "../utils/error.js";
import { getClientIp } from "../hono/express-shim.js";
import { computeVisitStats, mapActionToSelectedAction, markPageVisited } from "./story.js";
import { FREE_ACTION_SELECTION_UNTIL_PAGE } from "../config/story.js";
import type { BookAuthor, BookMode, BookPageVisit, BookSortOption, BookStats, BookTranslation, EnrichedBookData, EnrichedBookFirstPage, EnrichedBookGeneration, EnrichedBookSession, VisitBookPageParams, VisitBookPageResult } from "../types/book.js";
import type { Action, SelectedAction } from "../types/story.js";

/**
 * Builds an enriched book select object with all required fields
 *
 * Uses denormalized columns (likes_count, read_count) for O(1) performance on aggregate metrics.
 * User-specific flags (isLiked, isRead) still use EXISTS subqueries which are fast with indexes.
 *
 * Performance Characteristics:
 * - likesCount and readCount: O(1) — direct column access (updated via triggers)
 * - isLiked and isRead: O(log n) — EXISTS subquery with proper indexes
 * - Overall: ~10-50 ms for 100 books (vs 50-200 ms with COUNT subqueries)
 *
 * Denormalization Benefits:
 * - Eliminates COUNT(*) subqueries for likes/reads
 * - Triggers keep counts synchronised automatically
 * - No cache invalidation needed
 * - Always consistent with source data
 *
 * Translation Strategy:
 * The `translation` field uses a correlated subquery directly in the SELECT.
 * This is intentional for list queries: each book row fetches its own translation
 * in O(log n) via the (book_id, language) unique index, and the entire list lands
 * in a single round-trip — far better than N separate `getBookTranslation()` calls
 * with LRU-cache misses on cold paths.
 *
 * LRU-cache at the service layer (`getEnrichedBook`) is the right place for
 * single-book fetches (e.g. book detail page), where the same book is repeatedly
 * hit and the cache hit rate is high. For list queries the per-book cache benefit
 * is negligible compared to the subquery cost saved by the single round-trip.
 *
 * The subquery returns NULL when the requested language matches the book's own
 * language (`${language} <> ${books.language}`), so no translation object is
 * returned for same-language requests — callers do not need to check this.
 *
 * @param currentUserId - Optional current user ID for user-specific flags
 * @param language      - Optional language code to include translation data (e.g. "es", "fr")
 * @returns Select object with enriched book fields
 */
export function getEnrichedBookSelect(currentUserId: string | null = null, language: string | null = null) {
  return {
    // Basic book fields
    id:          books.id,
    userId:      books.userId,
    slug:        books.slug,
    title:       books.title,
    hook:        books.hook,
    summary:     books.summary,
    keywords:    books.keywords,
    status:      books.status,
    visibility:  books.visibility,
    trendingScore: books.trendingScore,
    totalPages:  books.totalPages,
    language:    books.language,
    topPick:     books.topPick,
    isOriginal:  books.isOriginal,
    isPenBook:   books.isPenBook,
    authoringStatus: books.authoringStatus,
    mode:        books.mode,
    creditsPrice: books.creditsPrice,
    originalThemeInput: books.originalThemeInput,
    createdAt:   books.createdAt,
    updatedAt:   books.updatedAt,
    mc:          books.mc,
    
    // Cover image URL subquery (Consider moving to a standard LEFT JOIN in the parent query)
    imageUrl: sql<string | null>`(
      SELECT ui.image_url
      FROM uploaded_images ui
      WHERE ui.image_id = books.image_id
      LIMIT 1
    )`,
    
    // Author info (Assumes `users` table is joined in the parent query)
    author: {
      id: users.userId,
      email: users.email,
      username: users.username,
      name: sql<string>`COALESCE(users.pen_name, users.name)`,
      // name: users.penName || users.name || "Anonymous",
      imageUrl: users.imageUrl,
    } satisfies Record<keyof BookAuthor, unknown>,

    // Denormalized engagement metrics (O(1))
    stats: {
      likesCount: books.likesCount,
      readCount: books.readCount,
      commentsCount: books.commentsCount,
      testimonialsCount: books.testimonialsCount,
      rating: books.rating,
      ratingCount: books.ratingCount,
      branchesCount: books.branchesCount,
      completeCount: books.completeCount,
      completionRate: books.completionRate,
    } satisfies Record<keyof BookStats, unknown>,

    // User-specific flags (Index-only scans via PK/Unique EXISTS constraints)
    isMine: currentUserId ? sql<boolean>`books.user_id = ${currentUserId}` : sql<boolean>`false`,
    isLiked: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_likes WHERE user_id = ${currentUserId} AND target_type = 'book' AND target_id = books.id)` : sql<boolean>`false`,
    isSaved: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_favorites WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isRead: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_sessions WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isCompleted: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_completed_books WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isPurchased: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_purchased_books WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,

    collection: currentUserId ? sql<string | null>`(
      SELECT uf.collection FROM user_favorites uf
      WHERE uf.user_id = ${currentUserId} AND uf.book_id = books.id
      LIMIT 1
    )` : sql<string | null>`null`,

    // Consolidated 4 session/context subqueries into ONE single lookup
    // ORDER BY and LIMIT 1 removed due to the unique (user_id, book_id) constraint
    session: currentUserId
      ? sql<EnrichedBookSession | null>`(
          SELECT jsonb_build_object(
            'lastReadAt', us.updated_at,
            'lastPageId', us.page_id,
            'lastPageNumber', p.page,
            'frontierPageId', us.frontier_page_id,
            'frontierPageNumber', us.frontier_page_number,
            'frontierAncestorIds', us.frontier_ancestor_ids,
            'contextHistory', COALESCE(ss.context_history, '')
          )
          FROM user_sessions us
          LEFT JOIN pages p ON p.id = us.page_id
          LEFT JOIN story_states ss ON ss.page_id = us.page_id
          WHERE us.user_id = ${currentUserId} AND us.book_id = books.id
        )`
      : sql<EnrichedBookSession | null>`null`,

    // Consolidated 2 independent scans into ONE single page lookup
    firstPage: sql<EnrichedBookFirstPage | null>`(
      SELECT jsonb_build_object('id', id, 'text', text)
      FROM pages
      WHERE book_id = books.id AND page = 1
      LIMIT 1
    )`,

    // Book translation subquery
    translation: language
      ? sql<BookTranslation | null>`(
          SELECT jsonb_build_object(
            'title',    bt.title,
            'hook',     bt.hook,
            'summary',  bt.summary,
            'keywords', bt.keywords,
            'mc',       bt.mc
          )
          FROM book_translations bt
          WHERE bt.book_id = books.id
            AND bt.language = ${language}
            AND ${language} <> ${books.language}
          LIMIT 1
        )`
      : sql<BookTranslation | null>`null`,

    // Book generation tracking subquery
    generation: sql<EnrichedBookGeneration | null>`(
      SELECT jsonb_build_object(
        'generationStatus', bg.generation_status,
        'generationStep', bg.generation_step,
        'generationDurationMs', bg.generation_duration_ms
      )
      FROM book_generations bg
      WHERE bg.book_id = books.id
      LIMIT 1
    )`

  } satisfies Record<keyof EnrichedBookData, unknown>;
}

/**
 * Calculation Modes:
 * 1. Keyword overlap score using unnest + ANY — optimal for tiny arrays (≤10 tags).
 * 2. Jaccard Similarity Formula: J(A, B) = |A ∩ B| / |A ∪ B|
 *    Range:
 *    0.0 → no shared keywords
 *    1.0 → identical keyword sets
 *
 * Jaccard vs Overlap:
 * Jaccard penalises books with more tags
 * (e.g. a 9-keyword book sharing 5 keywords scores lower than a 5-keyword book sharing 5).
 * Raw overlap count tends to produce better "more like this" results
 * for browsable content like Twistloom.
 *
 * Jaccard similarity measures the ratio of shared keywords to total
 * unique keywords: J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Requires:
 * - books.keywords: text[]
 * - GIN index on books.keywords (for the && pre-filter in .where())
 *
 * @param targetKeywords Keywords from the target book
 * @param mode Prefer 'overlap' for production unless testing shows meaningful ranking improvements
 */
export function buildKeywordsSimilarityScore(
  targetKeywords: string[],
  mode: 'overlap' | 'jaccard' = 'overlap'
) {
  // Parameterized: produces ARRAY[$1, $2, ...]::text[] — no sql.raw, no manual escaping
  const targetArray = sql`ARRAY[${sql.join(targetKeywords.map((k) => sql`${k}`), sql`, `)}]::text[]`;

  // Single-pass Jaccard: one UNION ALL + one GROUP BY derives both counts.
  // COALESCE to 0 guards against empty arrays (shouldn't occur after the && pre-filter,
  // but prevents NULL bleed into ORDER BY if dirty data ever bypasses the filter).
  if (mode === 'jaccard') {
    /**
     * Jaccard similarity score.
     *
     * Example:
     *   Target:    ['thriller', 'crime', 'mystery']
     *   Candidate: ['thriller', 'crime', 'horror']
     *   ∩ = ['thriller', 'crime'] → 2
     *   ∪ = ['thriller', 'crime', 'mystery', 'horror'] → 4
     *   Score = 2 / 4 = 0.5
     */
    return sql<number>`(
      SELECT COALESCE(
        COUNT(*) FILTER (WHERE in_candidate AND in_target_set)::float /
        NULLIF(COUNT(*), 0),
        0
      )
      FROM (
        SELECT
          kw,
          bool_or(NOT from_target) AS in_candidate,
          bool_or(from_target)     AS in_target_set
        FROM (
          SELECT unnest(${books.keywords}) AS kw, false AS from_target
          UNION ALL
          SELECT unnest(${targetArray})    AS kw, true  AS from_target
        ) combined
        GROUP BY kw
      ) deduped
    )`;
  }

  /**
   * Number of shared keywords.
   *
   * Example:
   * Target:    ["thriller", "crime", "mystery"]
   * Candidate: ["thriller", "crime", "horror"]
   *
   * Score = 2
   */
  return sql<number>`(
    SELECT COUNT(*)::int
    FROM unnest(${books.keywords}) AS kw
    WHERE kw = ANY(${targetArray})
  )`;
}

/**
 * Builds an enriched similar books select object with similarity score.
 *
 * Similarity is calculated as the number of shared keywords
 * between the target book and candidate book.
 *
 * This approach is significantly faster than per-row Jaccard
 * calculations while producing nearly identical recommendation
 * quality for genre/theme tags.
 *
 * IMPORTANT:
 * - Requires books.keywords to be text[]
 * - Requires GIN index on books.keywords
 * - Candidate filtering should use: sql`${books.keywords} && ${targetKeywords}`
 *
 * @param targetKeywords Keywords from the target book
 * @param currentUserId Optional current user ID
 * @param language Optional translation language
 */
export function getSimilarBookSelect(
  targetKeywords: string[],
  currentUserId: string | null = null,
  language: string | null = null,
  mode: 'overlap' | 'jaccard' = 'overlap'
) {
  const baseSelect = getEnrichedBookSelect(currentUserId, language);
  const similarityScore = buildKeywordsSimilarityScore(targetKeywords, mode);

  return {
    ...baseSelect,
    similarityScore,
    // Reuse the same expression reference for ORDER BY
    similarityScoreExpr: similarityScore,
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
 * Uses PostgreSQL array overlap operator (&&) which is
 * optimised by the GIN index on books.keywords.
 *
 * Example:
 * tags = ["thriller", "crime"]
 * matches books containing either tag.
 *
 * @param tags - Array of tag strings to filter by
 * @returns SQL condition or null if no tags
 */
export function buildTagsFilterCondition(tags: string[]) {
  if (!tags || tags.length === 0) return null;

  return arrayOverlaps(books.keywords, tags);
}

/**
 * Builds language filter condition
 *
 * @param language - ISO 639-1 language code (e.g. "en", "es")
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

  return sql`${books.mc}->>'gender' = ${gender}`;
}

/**
 * Builds mode filter condition for book creation mode (story format).
 *
 * @param mode - Book mode value (novel|interactive|multiverse)
 * @returns SQL condition or null if no mode
 */
export function buildModeFilterCondition(mode?: BookMode) {
  if (!mode) {
    return null;
  }

  // books.mode is a string-literal union column; cast the column to a plain
  // string column so eq() accepts the string-valued filter param.
  return eq(books.mode, mode);
}

/**
 * Builds rating filter condition (minimum/maximum threshold + optional rating count gate).
 *
 * Uses the denormalized `books.rating` / `books.ratingCount` columns (O(1) reads),
 * accelerated by the partial `books_rating_idx` index when rating is non-null.
 *
 * Semantics:
 * - `rating = NULL` means "not yet rated" → **always excluded** from rating
 *   filters. The explicit `isNotNull` guard also makes the partial-index
 *   predicate unambiguous to the query planner.
 * - `minRating` "4" means `rating >= 4` (the "4★ & up" bucket).
 * - `maxRating` is only ever set together with `minRating` as a range from the
 *   route (e.g. "4-5"); the route no longer supports max-only "below X" forms.
 * - `minRatingCount` gates on the number of approved ratings (e.g. "4★ & up by
 *   at least 5 people") so a lone 5-star vote can't dominate a bucket.
 *
 * @param minRating - Minimum rating (inclusive), 1-5
 * @param maxRating - Maximum rating (inclusive), 1-5
 * @param minRatingCount - Minimum number of approved ratings (inclusive)
 * @returns SQL condition or null if no rating filter
 */
export function buildRatingFilterCondition(minRating?: number, maxRating?: number, minRatingCount?: number) {
  if (minRating === undefined && maxRating === undefined && minRatingCount === undefined) {
    return null;
  }

  const conditions: ReturnType<typeof sql>[] = [];

  // A rating filter implies "has a rating" — NULL (not-yet-rated) books must
  // never match, and this makes the partial books_rating_idx predicate explicit.
  conditions.push(isNotNull(books.rating));

  if (minRating !== undefined) {
    conditions.push(sql`${books.rating} >= ${minRating}`);
  }
  if (maxRating !== undefined) {
    conditions.push(sql`${books.rating} <= ${maxRating}`);
  }
  if (minRatingCount !== undefined) {
    conditions.push(sql`${books.ratingCount} >= ${minRatingCount}`);
  }

  return and(...conditions);
}

/**
 * Builds search condition with ILIKE patterns for title, hook, summary, and keywords.
 *
 * Note: `books.keywords` is `text[]` — ILIKE cannot be applied directly to an array.
 * We use `array_to_string` to flatten the array for a substring match. This does NOT
 * use the GIN index (ILIKE is never index-accelerated), but it is consistent with
 * how title/hook/summary are searched and avoids a false-negative on keyword matches.
 *
 * @param search - Search query string
 * @returns SQL condition or null if no search
 */
export function buildSearchCondition(search?: string) {
  if (!search) return null;

  return buildTokenizedSearchCondition(search, [
    books.title,
    books.hook,
    books.summary,
    sql`array_to_string(${books.keywords}, ' ')`,
  ]);
}

/**
 * Builds comprehensive book query with filtering, sorting, and search
 *
 * Provides a unified interface for building book queries across endpoints.
 * Handles all filtering options, search relevance scoring, and specialised book sorting.
 *
 * Sorting Hierarchy:
 * 1. Primary: Book-specific sorting ({@link applyBookSorting}) — handles popular, trending, top-picks, originals, newest
 * 2. Secondary: Contextual sorting — relevance for search, generic column sorting otherwise
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
    /** Search query string (sanitised) */
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
    /** Mode filter (novel|interactive|multiverse) */
    mode?: BookMode;
    /** Minimum rating threshold (inclusive), 1-5 — "X★ & up" */
    minRating?: number;
    /** Maximum rating threshold (inclusive), 1-5 — "below X" */
    maxRating?: number;
    /** Minimum number of approved ratings (inclusive) — gates small samples */
    minRatingCount?: number;
    /** Current user ID for user-specific sorting (reads, recommendations) */
    currentUserId?: string | null;
    /** Collection name to filter favorites (only applies when sortBy=favorites) */
    collection?: string;
  }
) {
  const { baseQuery, baseCondition, search, bookSortBy, genericSortBy, sortOrder, tags, language, lastUpdated, minAge, maxAge, gender, mode, minRating, maxRating, minRatingCount, currentUserId, collection } = params;

  // Build filter conditions using shared helpers
  const timeCondition      = buildTimeFilterCondition(lastUpdated);
  const languageCondition  = buildLanguageFilterCondition(language);
  const searchCondition    = buildSearchCondition(search);
  const tagsCondition      = buildTagsFilterCondition(tags || []);
  const ageRangeCondition  = buildAgeRangeFilterCondition(minAge, maxAge);
  const genderCondition    = buildGenderFilterCondition(gender);
  const modeCondition      = buildModeFilterCondition(mode);
  const ratingCondition    = buildRatingFilterCondition(minRating, maxRating, minRatingCount);

  // Combine all conditions with base condition
  const finalCondition = combineFilterConditions(
    baseCondition,
    timeCondition,
    languageCondition,
    searchCondition,
    tagsCondition,
    ageRangeCondition,
    genderCondition,
    modeCondition,
    ratingCondition
  );

  // Apply secondary sorting: contextual sorting
  let query = baseQuery;

  // Apply where condition to main query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = (query as any).where(finalCondition);

  // Build count query for pagination (must be created before applying sort conditions
  // so that sort-specific WHERE filters can be applied to both queries)
  const countQuery = dbRead
    .select({ count: sql`COUNT(*)::int` })
    .from(books)
    .where(finalCondition);

  // Apply primary sorting: book-specific sorting (acts as category filter).
  // Pass countQuery so sort-specific WHERE conditions are applied to both queries.
  if (bookSortBy) {
    query = applyBookSorting(query, bookSortBy, currentUserId, collection, countQuery);
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

  if (validConditions.length === 0) return sql`1=1`;
  if (validConditions.length === 1) return validConditions[0];

  return and(...validConditions);
}

/**
 * Applies book-specific sorting to a query based on sort option
 *
 * @param query - Drizzle query builder
 * @param sortBy - Sort option (popular, newest, trending, top-picks, originals, reads, favorites, recommendations)
 * @param currentUserId - Optional current user ID for user-specific sorting (reads, recommendations)
 * @returns Modified query builder with sorting applied
 *
 * Behaviour:
 * - popular: Sorts by branchesCount/totalPages ratio (highest first)
 * - newest: Sorts by createdAt (latest first)
 * - trending: Sorts by weighted formula: readCount(0.5) + likesCount(0.3) + favoritedCount(0.2)
 * - top-picks: Sorts by latest topPick timestamp (only books marked as editor's picks)
 * - originals: Filters by isOriginal: true (auto-generated books via cron job), sorts by createdAt (newest first)
 * - reads: Filters to books the user has read (from userSessions), sorts by lastReadAt (most recent first)
 * - favorites: Filters to books the user has favorited (from userFavorites), sorts by favoritedAt (most recent first)
 * - recommendations: Recommends books based on user likes (similar books to what user liked)
 *
 * @remarks
 * Uses `any` type for query parameter because Drizzle ORM query builder types
 * are extremely complex generic types that don't fit well into simple type constraints.
 * Type safety is maintained through the actual database operations and SQL generation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBookSorting(query: any, sortBy: BookSortOption = 'newest', currentUserId?: string | null, collection?: string, countQuery?: any): any {
  switch (sortBy) {
    case 'for-you': {
      // Recommend books based on user's reading history (from userSessions)
      // Finds unread books with overlapping keywords, sorted by similarity count
      // Requires authentication, fall through to 'popular' books
      if (currentUserId) {
        // Aggregate all distinct keywords from books the user has read
        const userReadKeywords = sql`(
          SELECT COALESCE(array_agg(DISTINCT kw), '{}')
          FROM user_sessions us_src
          INNER JOIN books rb ON us_src.book_id = rb.id
          CROSS JOIN LATERAL unnest(rb.keywords) AS kw
          WHERE us_src.user_id = ${currentUserId}
        )`;

        // Keyword overlap count between the candidate book and user's read books
        const overlapScore = sql`(
          SELECT COUNT(*)::int
          FROM unnest(${books.keywords}) AS kw
          WHERE kw = ANY(${userReadKeywords})
        )`;

        query = query
          .where(sql`${books.keywords} && ${userReadKeywords}`)
          .where(sql`NOT EXISTS (
            SELECT 1 FROM user_sessions us_exclude
            WHERE us_exclude.user_id = ${currentUserId} AND us_exclude.book_id = books.id
          )`);
        if (countQuery) {
          countQuery.where(sql`${books.keywords} && ${userReadKeywords}`)
            .where(sql`NOT EXISTS (
              SELECT 1 FROM user_sessions us_exclude
              WHERE us_exclude.user_id = ${currentUserId} AND us_exclude.book_id = books.id
            )`);
        }
        return query.orderBy(desc(overlapScore)).orderBy(desc(books.trendingScore));
      }
    }

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
      query = query
        .where(sql`${books.topPick} IS NOT NULL`)
        .orderBy(desc(books.topPick));
      if (countQuery) countQuery.where(sql`${books.topPick} IS NOT NULL`);
      return query;
    }

    case 'originals': {
      // Filter by isOriginal: true (auto-generated books via cron job) and has cover image
      // Sort by creation date (newest first)
      // Note: Intentionally filtering to only show originals with covers for quality control
      // Auto-generated books without covers are excluded from the originals list
      query = query
        .where(eq(books.isOriginal, true))
        .where(sql`${books.imageId} IS NOT NULL`)
        .orderBy(desc(books.createdAt));
      if (countQuery) {
        countQuery.where(eq(books.isOriginal, true))
          .where(sql`${books.imageId} IS NOT NULL`);
      }
      return query;
    }

    case 'reads': {
      // Filter to books the user has read (from userSessions)
      // Sort by lastReadAt (most recent first)
      // Requires authentication
      if (!currentUserId) {
        const noop = query.where(sql`1=0`);
        if (countQuery) countQuery.where(sql`1=0`);
        return noop;
      }
      const readCondition = sql`EXISTS (
        SELECT 1 FROM user_sessions
        WHERE user_id = ${currentUserId} AND book_id = books.id
      )`;
      query = query.where(readCondition);
      if (countQuery) countQuery.where(readCondition);
      // Sort by the most recent read timestamp. A user has at most one
      // user_sessions row per book (unique (user_id, book_id)), upserted on
      // every visit, so its updated_at is the last-read time. Falls back to
      // the book's updatedAt when no session exists (shouldn't happen here
      // due to the readCondition filter above).
      return query.orderBy(sql`COALESCE((
        SELECT us.updated_at FROM user_sessions us
        WHERE us.user_id = ${currentUserId} AND us.book_id = books.id
      ), ${books.updatedAt}) DESC`);
    }

    case 'favorites': {
      // Filter to books the user has favorited (from userFavorites table)
      // Sort by favorite creation date (most recent first)
      // Requires authentication
      if (!currentUserId) {
        const noop = query.where(sql`1=0`);
        if (countQuery) countQuery.where(sql`1=0`);
        return noop;
      }
      const favCondition = sql`EXISTS (
        SELECT 1 FROM user_favorites uf
        WHERE uf.user_id = ${currentUserId}
          AND uf.book_id = books.id
          ${collection ? sql`AND uf.collection = ${collection}` : sql``}
      )`;
      query = query.where(favCondition);
      if (countQuery) countQuery.where(favCondition);
      return query.orderBy(sql`(
        SELECT uf.created_at FROM user_favorites uf
        WHERE uf.user_id = ${currentUserId} AND uf.book_id = books.id
      ) DESC`);
    }

    case 'likes': {
      // Filter to books the user has liked (from user_likes where target_type = 'book')
      // Sort by like creation date (most recent first)
      if (!currentUserId) {
        const noop = query.where(sql`1=0`);
        if (countQuery) countQuery.where(sql`1=0`);
        return noop;
      }
      const likeCondition = sql`EXISTS (
        SELECT 1 FROM user_likes ul
        WHERE ul.user_id = ${currentUserId}
          AND ul.target_type = 'book'
          AND ul.target_id = books.id
      )`;
      query = query.where(likeCondition);
      if (countQuery) countQuery.where(likeCondition);
      return query.orderBy(sql`(
        SELECT ul.created_at FROM user_likes ul
        WHERE ul.user_id = ${currentUserId} AND ul.target_type = 'book' AND ul.target_id = books.id
      ) DESC`);
    }

    case 'recommendations': {
      // Recommend books based on user likes
      // Get books similar to what the user has liked using keyword similarity
      // Requires authentication
      if (!currentUserId) {
        const noop = query.where(sql`1=0`);
        if (countQuery) countQuery.where(sql`1=0`);
        return noop;
      }

      const recCondition = sql`EXISTS (
        SELECT 1
        FROM user_likes ul
        INNER JOIN books liked_books ON ul.target_id = liked_books.id
        WHERE ul.user_id = ${currentUserId}
          AND ul.target_type = 'book'
          AND liked_books.id != books.id
          AND books.keywords && liked_books.keywords
      )`;
      query = query.where(recCondition);
      if (countQuery) countQuery.where(recCondition);
      return query.orderBy(desc(books.trendingScore));
    }

    case 'creations': {
      // User's own created books (any status) — baseCondition already scopes
      // to the owner; here we only apply a deterministic sort (no filtering).
      return query.orderBy(desc(books.createdAt));
    }

    case 'pen-drafts': {
      // User's own in-progress Pen books (is_pen_book + authoring_status='draft').
      // baseCondition already scopes to the owner via requireAuth, but we
      // re-assert the pen-draft predicate on both query + countQuery so a
      // completed pen book drops off the list as soon as it's marked complete.
      if (!currentUserId) {
        const noop = query.where(sql`1=0`);
        if (countQuery) countQuery.where(sql`1=0`);
        return noop;
      }
      const penDraftCondition = sql`${books.isPenBook} AND ${books.authoringStatus} = 'draft'`;
      query = query.where(penDraftCondition);
      if (countQuery) countQuery.where(penDraftCondition);
      // Most recently edited in-progress draft first.
      return query.orderBy(desc(books.updatedAt));
    }

    case 'newest':
    default: {
      return query.orderBy(desc(books.createdAt));
    }
  }
}

/**
 * Visits a book page by validating navigation, recording progress, and
 * calculating visit statistics.
 *
 * This function handles the complete flow of a user visiting a page:
 * 1. Validates the page exists and belongs to the specified book
 * 2. For non-root pages (page > 1), validates the navigation action from
 *    the parent page
 * 3. Checks if the user has already made a different choice on the parent page
 * 4. Records the visit and calculates visit statistics (nth visitor,
 *    visitor percentage)
 *
 * Story context (actionsHistory, plotFlags, places, characters…) is NOT
 * built here. It is served by `mapToEnrichedPage` directly from the
 * persisted StoryState, which is the single source of truth.
 *
 * @param params - Parameters for the page visit
 * @param params.userId           - The user's unique identifier
 * @param params.pageId           - The page identifier to visit
 * @param params.bookIdentifier   - Book slug or UUID for validation
 * @param params.skipVisit        - Skip DB write (prefetch / HEAD requests)
 * @param params.takeAction       - Whether this is a deliberate user action
 * @param params.consumeCredits   - Allow spending credits to override a
 *                                  prior choice
 * @param params.language         - Accept-Language header value
 * @param options.c               - Hono context
 * @returns Promise resolving to visit details, book, page, sourceAction,
 *          and isUserTakeAction flag. Returns `{}` when the response has
 *          already been sent (error / not-found paths).
 *
 * Behaviour:
 * - Page 1: No action validation required, marks as visited without action.
 * - Page > 1: Validates action exists on parent page and that the user
 *   hasn't previously chosen a different action (unless consumeCredits).
 *
 * Visit Statistics:
 * - nthVisit:           The ordinal visit count for this page.
 * - visitorPercentage:  Percentage of total book readers who reached here.
 *
 * @example
 * ```typescript
 * const { visitDetails, book, dbPage, sourceAction, isUserTakeAction } =
 *   await visitBookPage(
 *     { userId, pageId, bookIdentifier, skipVisit, takeAction, consumeCredits, language },
 *     { c }
 *   );
 *
 * // Response already sent by visitBookPage on error paths
 * if (!dbPage || !book) return;
 *
 * const page = await mapToEnrichedPage(dbPage, {
 *   userId,
 *   bookLanguage: book.language,
 *   headerLanguage,
 *   translate,
 *   sourceAction,
 *   isUserTakeAction,
 * });
 * ```
 */
export async function visitBookPage(
  params: VisitBookPageParams,
  options: { c: Context }
): Promise<VisitBookPageResult> {
  const { userId, pageId, bookIdentifier, skipVisit = false, takeAction = false, consumeCredits = false, language } = params;
  const isUserTakeAction = !!userId && !skipVisit && takeAction;
  const { c } = options;
  const res = c;

  // Get page
  const dbPage = await getPageFromDB(pageId, { bookIdentifier });
  if (!dbPage) {
    console.error(`[visit] ❌ Visited page not found:`, pageId);
    cNotFoundError(res, `Page not found`);
    return {};
  }

  // Get book
  const { page: pageNumber, bookId, parentId: parentPageId, branchId } = dbPage;
  const book = await getEnrichedBook(bookId, userId, language);
  if (!book) {
    console.error(`[visit] ❌ Book not found:`, bookId);
    cNotFoundError(res, `Book not found`);
    return {};
  }

  if (isUserTakeAction) {
    console.log(`[visit] 🐑 User actually visited "${book.title}" page ${pageNumber}:`, { pageId, branchId });
  } else {
    console.log(`[visit] 👓 Prefetching "${book.title}" page ${pageNumber}:`, { pageId, branchId });

    // No user visit tracking for prefetch (not actual navigation)
    const { nthVisit, visitorPercentage } = computeVisitStats({ rawVisitCount: dbPage.visitCount, readerCount: book.stats.readCount, addOne: false });
    const visitDetails: BookPageVisit = { nthVisit, visitorPercentage, readerUserId: userId };
    return { dbPage, book, visitDetails, isUserTakeAction };
  }

  // Get parent page and resolve the selected action (if it's not page 1)
  let action: Action | undefined;
  let shouldConsumeCredits = false;
  let selectedAction: SelectedAction | undefined;

  if (pageNumber > 1) {
    const parentDbPage = parentPageId ? await getPageFromDB(parentPageId) : null;
    if (!parentDbPage) {
      console.error(`[visit] ❌ Previous page not found:`, parentPageId);
      cNotFoundError(res, `Previous page not found for pageNumber ${pageNumber}`);
      return {};
    }

    action = parentDbPage.actions.filter(a => a.destinationPageIds?.some(p => p === pageId))[0];
    if (!action) {
      console.error(`[visit] ❌ Action for this page not found in the parent page:`, parentPageId);
      cNotFoundError(res, `Action for this page not found in the parent page`);
      return {};
    }

    selectedAction = mapActionToSelectedAction(action, parentPageId!, parentDbPage.page, pageId);

    // Users can go back and select any action they like until FREE_ACTION_SELECTION_UNTIL_PAGE
    if (pageNumber > FREE_ACTION_SELECTION_UNTIL_PAGE + 1) {
      // Validate user's action choice: check if user already chose a different action on previous page
      const selectedActions = await getPageActionsFromDB(userId, book.id, parentPageId!);
      if (selectedActions.length) {
        if (!selectedActions.some((a) => a.text === action!.text)) {
          if (!consumeCredits) {
            // User already chose a different action on this page; can't continue except they pay credits
            console.error(`[visit] 💥 Choice made, can't make another choice`);
            cForbiddenError(res, "Choice made, can't make another choice");
            return {};
          } else {
            shouldConsumeCredits = true;
          }
        }
      }
    }
  }

  // Mark page as visited and persist chosen action
  const visitDetails = await markPageVisited({
    userId,
    book,
    visitedPage: dbPage,
    actionedPageId: parentPageId ?? undefined,
    action,
    shouldConsumeCredits
  }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

  // The `book` object was freshly fetched (enriched book cache was
  // invalidated by the previous session upsert) so mutating it is safe.
  // Patch the session in-place with the updated DB values rather than
  // re-fetching the entire enriched book.
  if (book.session && visitDetails.session) {
    book.session = {
      ...book.session,
      lastPageId: pageId,
      lastPageNumber: pageNumber,
      lastReadAt: new Date(),
      frontierPageId: visitDetails.session.frontierPageId ?? pageId,
      frontierPageNumber: visitDetails.session.frontierPageNumber ?? pageNumber,
      frontierAncestorIds: visitDetails.session.frontierAncestorIds ?? [],
    };
  }

  return { dbPage, book, visitDetails, sourceAction: selectedAction, isUserTakeAction };
}