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

import { sql, and, or, eq, desc, inArray, arrayOverlaps, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { books, users, userLikes, userFavorites, userSessions, userCompletedBooks, userPurchasedBooks, pages, storyStates, bookTranslations, userFollows, customActions } from '../db/schema.js';

import { dbRead } from "../db/client.js";
import { createRelevanceExpression } from "../utils/search.js";
import { getEnrichedBook, getPageActionsFromDB, getPageFromDB } from "./book.js";
import { cNotFoundError, cForbiddenError } from "../utils/error.js";
import { getBookAccessSnapshot, getBookPageAccessError } from "./book-page-access.js";
import { getClientIp } from "../hono/express-shim.js";
import { computeVisitStats, mapActionToSelectedAction, markPageVisited } from "./story.js";
import { sendSystemBroadcast, type SystemBroadcastI18nPayload } from "./broadcast.js";
import { FREE_ACTION_SELECTION_UNTIL_PAGE, PHASE_EARLY_CEILING, PHASE_LATE_FLOOR, PHASE_FINALE_FLOOR } from "../config/story.js";
import { getCreditCostForUser } from "../config/credits.js";
import { buildCustomActionAction } from "../utils/custom-action.js";
import type { BookAuthor, BookMode, BookPageVisit, BookSortOption, BookSource, BookStats, BookTranslation, EnrichedBookData, EnrichedBookFirstPage, EnrichedBookGeneration, EnrichedBookSession, VisitBookPageParams, VisitBookPageResult } from "../types/book.js";
import type { Action, ActionHintType, ActionType, Ending, SelectedAction, StoryPhase } from "../types/story.js";

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
    aiContributionPercent: books.aiContributionPercent,
    authoringStatus: books.authoringStatus,
    mode:        books.mode,
    creditsPrice: books.creditsPrice,
    originalThemeInput: books.originalThemeInput,
    frontMatter:   books.frontMatter,
    createdAt:   books.createdAt,
    updatedAt:   books.updatedAt,
    mc:          books.mc,
    guestProgressImportVersion: sql<number>`1`,
    
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
      avatarFrame: users.avatarFrame,
      bio: users.bio,
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
      endingsFound: books.endingsFound,
    } satisfies Record<keyof BookStats, unknown>,

    // User-specific flags (Index-only scans via PK/Unique EXISTS constraints)
    isMine: currentUserId ? sql<boolean>`books.user_id = ${currentUserId}` : sql<boolean>`false`,
    isLiked: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_likes WHERE user_id = ${currentUserId} AND target_type = 'book' AND target_id = books.id)` : sql<boolean>`false`,
    isSaved: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_favorites WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isRead: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_sessions WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isCompleted: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_completed_books WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    isPurchased: currentUserId ? sql<boolean>`EXISTS (SELECT 1 FROM user_purchased_books WHERE user_id = ${currentUserId} AND book_id = books.id)` : sql<boolean>`false`,
    ending: currentUserId
      ? sql<Ending | null>`CASE WHEN books.user_id = ${currentUserId} THEN books.ending ELSE NULL END`
      : sql<Ending | null>`null`,

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
            'lastGuestImportId', us.last_guest_import_id,
            'lastPageId', us.page_id,
            'lastPageNumber', p.page,
            'frontierPageId', us.frontier_page_id,
            'frontierPageNumber', us.frontier_page_number,
            'frontierAncestorIds', us.frontier_ancestor_ids,
            'contextHistory', COALESCE(ss.context_history, ''),
            'phase', CASE
              WHEN ss.page::float / NULLIF(ss.max_page, 0) >= ${PHASE_FINALE_FLOOR} THEN 'FINALE'
              WHEN ss.page::float / NULLIF(ss.max_page, 0) >= ${PHASE_LATE_FLOOR} THEN 'LATE'
              WHEN ss.page::float / NULLIF(ss.max_page, 0) > ${PHASE_EARLY_CEILING} THEN 'MID'
              ELSE 'EARLY'
            END,
            'maxPage', ss.max_page
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
 * Uses SQL rolling intervals for timezone-neutral time filtering
 *
 * @param lastUpdated - Time filter value: anytime|today|this-week|this-month|this-year
 * @returns SQL condition or null if anytime/invalid
 */
export function buildTimeFilterCondition(lastUpdated?: string) {
  if (!lastUpdated || lastUpdated === 'anytime') {
    return null;
  }

  switch (lastUpdated) {
    case 'today': {
      return sql`${books.updatedAt} >= NOW() - INTERVAL '24 hours'`;
    }
    case 'this-week': {
      return sql`${books.updatedAt} >= NOW() - INTERVAL '7 days'`;
    }
    case 'this-month': {
      return sql`${books.updatedAt} >= NOW() - INTERVAL '30 days'`;
    }
    case 'this-year': {
      return sql`${books.updatedAt} >= NOW() - INTERVAL '365 days'`;
    }
    default:
      return null;
  }
}

/**
 * Builds tags filter condition with OR logic (books matching ANY tag)
 * Normalizes tags to lowercase to prevent case-sensitivity mismatches
 *
 * Uses PostgreSQL array overlap operator (&&) which is
 * optimised by the GIN index on books.keywords.
 *
 * @param tags - Array of tag strings to filter by
 * @returns SQL condition or null if no tags
 */
export function buildTagsFilterCondition(tags: string[]) {
  if (!tags || tags.length === 0) return null;

  const normalized = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return null;

  return arrayOverlaps(books.keywords, normalized);
}

/**
 * Builds the viewer's interest-keyword profile as a single SQL subquery.
 *
 * Aggregates the DISTINCT keywords of every book the user has engaged with
 * across three implicit signals (matching the `getRecommendedTags` signal set):
 * 1. Reads   — `user_sessions` (weight 1.0 in tag ranking)
 * 2. Likes   — `user_likes` where `targetType = 'book'` (weight 0.7)
 * 3. Favs    — `user_favorites` (weight 0.5)
 *
 * Weights only matter for tag *ranking* (`getRecommendedTags`); here the
 * result is a flat keyword set consumed by overlap predicates, so no weighting
 * is applied. The read-books join intentionally does NOT filter on
 * `visibility = 'public'`: a user reading their own private/draft book still
 * has a real `user_sessions` row, and its keywords are legitimate
 * personalization signal.
 *
 * Returns `'{}'` (empty array) when the user has no signals — callers must
 * handle the cold-start case (see `buildPersonalizedFilterCondition`).
 *
 * @param userId - The user whose interest profile is built
 * @returns SQL subquery evaluating to `text[]`
 *
 * @example
 * ```typescript
 * const interestKeywords = buildInterestKeywordsSql(userId);
 * // cards where the book overlaps the profile: books.keywords && interestKeywords
 * ```
 */
export function buildInterestKeywordsSql(userId: string) {
  return sql`(
    SELECT COALESCE(array_agg(DISTINCT kw), '{}')
    FROM (
      SELECT unnest(rb.keywords) AS kw
      FROM ${userSessions}
      INNER JOIN ${books} rb ON rb.id = ${userSessions.bookId}
      WHERE ${userSessions.userId} = ${userId}
      UNION ALL
      SELECT unnest(lb.keywords) AS kw
      FROM ${userLikes}
      INNER JOIN ${books} lb ON lb.id = ${userLikes.targetId}
      WHERE ${userLikes.userId} = ${userId} AND ${userLikes.targetType} = 'book'
      UNION ALL
      SELECT unnest(fb.keywords) AS kw
      FROM ${userFavorites}
      INNER JOIN ${books} fb ON fb.id = ${userFavorites.bookId}
      WHERE ${userFavorites.userId} = ${userId}
    ) signals
  )`;
}

/**
 * Builds the "For You" personalization FILTER predicate.
 *
 * Unlike `sortBy = 'for-you'` (which *replaces* the section's ordering with a
 * keyword-overlap score), this predicate is designed to be ANDed onto any
 * sort — it narrows the popular/trending/newest shelves to the user's
 * interest profile while PRESERVING the section's own ranking
 * (branching ratio / trendingScore / createdAt).
 *
 * Semantics:
 * 1. Cold start (`cardinality(...) = 0`): the user has no read/like/favorite
 *    signals, so the interest branch is a no-op and the unfiltered shelf is
 *    returned — sections on the home screen never render empty for new users.
 * 2. Ongoing reads stay eligible through a positive `user_sessions` probe,
 *    even when the book has no keywords. Other candidates match the interest
 *    profile via `books.keywords && profile` (GIN-optimised `&&`).
 * 3. Only completed reads are excluded, using `user_completed_books`, the
 *    same authoritative source as the returned `isCompleted` flag. Completion
 *    wins even when a session still exists (for example after a replay).
 *
 * A single SQL predicate with indexed per-user session/completion probes;
 * applies equally to results and pagination COUNT via `finalCondition`.
 *
 * @param userId - The viewer whose interests are matched against book keywords
 * @returns SQL condition ready for `combineFilterConditions`
 *
 * @example
 * ```typescript
 * // Popular books matching the user's taste, still ranked by popularity:
 * GET /api/books/explore?sortBy=popular&personalized=true
 * ```
 */
export function buildPersonalizedFilterCondition(userId: string) {
  const interestKeywords = buildInterestKeywordsSql(userId);

  return sql`(
    EXISTS (
      SELECT 1 FROM ${userSessions}
      WHERE ${userSessions.userId} = ${userId} AND ${userSessions.bookId} = ${books.id}
    ) OR cardinality(${interestKeywords}) = 0 OR ${books.keywords} && ${interestKeywords}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${userCompletedBooks}
    WHERE ${userCompletedBooks.userId} = ${userId} AND ${userCompletedBooks.bookId} = ${books.id}
  )`;
}

/**
 * Builds language filter condition
 * Matches either the book's primary authoring language OR any verified translation
 * in the book_translations table.
 *
 * @param language - ISO 639-1 language code (e.g. "en", "es", "id")
 * @returns SQL condition or null if no language
 */
export function buildLanguageFilterCondition(language?: string) {
  if (!language) {
    return null;
  }

  const normalized = language.trim().toLowerCase();
  return or(
    eq(books.language, normalized),
    sql`EXISTS (
      SELECT 1 FROM ${bookTranslations}
      WHERE ${bookTranslations.bookId} = ${books.id} AND ${bookTranslations.language} = ${normalized}
    )`
  );
}

/**
 * Builds age range filter condition for main character age
 * Uses regex safe-check to guard against runtime integer cast exceptions on dirty records.
 *
 * @param minAge - Minimum age (inclusive)
 * @param maxAge - Maximum age (inclusive)
 * @returns SQL condition or null if no age range
 */
export function buildAgeRangeFilterCondition(minAge?: number, maxAge?: number) {
  if (minAge === undefined || maxAge === undefined) {
    return null;
  }

  return sql`CASE WHEN (${books.mc}->>'age') ~ '^[0-9]+$' THEN (${books.mc}->>'age')::int ELSE NULL END BETWEEN ${minAge} AND ${maxAge}`;
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
 * Builds authoring-origin filter condition (`source` query param).
 *
 * Distinct from the `pen` *sort option* (a public showcase category requiring
 * visibility=public + authoringStatus=complete): this is an owner-scoped
 * filter that composes with any sort — e.g. `sortBy=creations&source=pen`.
 *
 * @param source - Authoring origin (spark|pen)
 * @returns SQL condition or null if no source filter
 */
export function buildSourceFilterCondition(source?: BookSource) {
  if (!source) {
    return null;
  }
  return source === 'pen' ? eq(books.isPenBook, true) : eq(books.isPenBook, false);
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
 * Uses array unnest for keyword matching so PostgreSQL can utilize index acceleration.
 *
 * @param search - Search query string
 * @returns SQL condition or null if no search
 */
export function buildSearchCondition(search?: string) {
  if (!search) return null;

  const tokens = search.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const tokenConditions = tokens.map(token => {
    const pattern = `%${token}%`;
    return or(
      sql`${books.title} ILIKE ${pattern}`,
      sql`${books.hook} ILIKE ${pattern}`,
      sql`${books.summary} ILIKE ${pattern}`,
      sql`EXISTS (SELECT 1 FROM unnest(${books.keywords}) AS kw WHERE kw ILIKE ${pattern})`
    );
  });

  return and(...tokenConditions) ?? null;
}

/**
 * Fast indexed batch query to enrich cached public book objects with authenticated
 * user interactions (isLiked, isSaved, isRead, isCompleted, isPurchased, collection, session).
 *
 * Executes a single parallel lookup on indexed (userId, bookId) constraints, keeping
 * the shared Redis explore cache 100% public while delivering personalized user badges
 * in ~1-2ms without cache data leakage.
 *
 * @param booksList - Array of public enriched books (from cache or DB)
 * @param currentUserId - The authenticated user's ID
 * @returns Enriched books with user-specific flags overlaid
 */
export async function enrichBooksWithUserData(
  booksList: EnrichedBookData[],
  currentUserId: string | null
): Promise<EnrichedBookData[]> {
  if (!currentUserId || !booksList || booksList.length === 0) {
    return booksList;
  }

  const bookIds = booksList.map((b) => b.id).filter(Boolean);
  if (bookIds.length === 0) return booksList;

  // Run indexed batch queries in parallel
  const [likes, favorites, sessions, completed, purchased] = await Promise.all([
    dbRead
      .select({ targetId: userLikes.targetId })
      .from(userLikes)
      .where(
        and(
          eq(userLikes.userId, currentUserId),
          eq(userLikes.targetType, "book"),
          inArray(userLikes.targetId, bookIds)
        )
      ),
    dbRead
      .select({ bookId: userFavorites.bookId, collection: userFavorites.collection })
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, currentUserId),
          inArray(userFavorites.bookId, bookIds)
        )
      ),
    dbRead
      .select({
        bookId: userSessions.bookId,
        lastReadAt: userSessions.updatedAt,
        lastGuestImportId: userSessions.lastGuestImportId,
        lastPageId: userSessions.pageId,
        lastPageNumber: pages.page,
        frontierPageId: userSessions.frontierPageId,
        frontierPageNumber: userSessions.frontierPageNumber,
        frontierAncestorIds: userSessions.frontierAncestorIds,
        contextHistory: sql<string>`COALESCE(${storyStates.contextHistory}, '')`,
        ssPage: storyStates.page,
        ssMaxPage: storyStates.maxPage,
      })
      .from(userSessions)
      .leftJoin(pages, eq(pages.id, userSessions.pageId))
      .leftJoin(storyStates, eq(storyStates.pageId, userSessions.pageId))
      .where(
        and(
          eq(userSessions.userId, currentUserId),
          inArray(userSessions.bookId, bookIds)
        )
      ),
    dbRead
      .select({ bookId: userCompletedBooks.bookId })
      .from(userCompletedBooks)
      .where(
        and(
          eq(userCompletedBooks.userId, currentUserId),
          inArray(userCompletedBooks.bookId, bookIds)
        )
      ),
    dbRead
      .select({ bookId: userPurchasedBooks.bookId })
      .from(userPurchasedBooks)
      .where(
        and(
          eq(userPurchasedBooks.userId, currentUserId),
          inArray(userPurchasedBooks.bookId, bookIds)
        )
      ),
  ]);

  const likedSet = new Set(likes.map((l) => l.targetId));
  const favoriteMap = new Map(favorites.map((f) => [f.bookId, f.collection]));
  const sessionMap = new Map(
    sessions.map((s) => {
      const maxPage = s.ssMaxPage ?? 0;
      const progress = maxPage > 0 ? (s.ssPage ?? 0) / maxPage : 0;
      const phase: StoryPhase = progress >= PHASE_FINALE_FLOOR ? 'FINALE' : progress >= PHASE_LATE_FLOOR ? 'LATE' : progress > PHASE_EARLY_CEILING ? 'MID' : 'EARLY';
      return [
        s.bookId,
      {
        lastReadAt: s.lastReadAt,
        lastGuestImportId: s.lastGuestImportId,
        lastPageId: s.lastPageId,
        lastPageNumber: s.lastPageNumber ?? null,
        frontierPageId: s.frontierPageId ?? null,
        frontierPageNumber: s.frontierPageNumber ?? 1,
        frontierAncestorIds: s.frontierAncestorIds ?? [],
        contextHistory: s.contextHistory || "",
        phase,
        maxPage: s.ssMaxPage,
      } as EnrichedBookSession,
      ];
    })
  );
  const completedSet = new Set(completed.map((c) => c.bookId));
  const purchasedSet = new Set(purchased.map((p) => p.bookId));

  return booksList.map((book) => ({
    ...book,
    isMine: book.userId === currentUserId,
    isLiked: likedSet.has(book.id),
    isSaved: favoriteMap.has(book.id),
    collection: favoriteMap.get(book.id) ?? null,
    isRead: sessionMap.has(book.id),
    session: sessionMap.get(book.id) ?? null,
    isCompleted: completedSet.has(book.id),
    isPurchased: purchasedSet.has(book.id),
  }));
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
    /** Authoring-origin filter (spark = AI-generated, pen = human-authored); absent = no filter */
    source?: BookSource;
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
    /** When true + authenticated + default `newest` sort: bubble books from followed authors to the top. */
    followingFirst?: boolean;
    /**
     * When true + `currentUserId` present: ANDs the viewer's interest profile
     * onto whatever sort is active — popular/trending/newest shelves are
     * narrowed to books matching the user's read/like/favorite keywords while
     * the section's own ranking is preserved. Cold start (no signals) returns
     * the unfiltered shelf. Applied to both result and COUNT queries.
     */
    personalized?: boolean;
  }
) {
  const { baseQuery, baseCondition, search, bookSortBy, tags, language, lastUpdated, minAge, maxAge, gender, mode, source, minRating, maxRating, minRatingCount, currentUserId, collection, followingFirst, personalized } = params;

  // Build filter conditions using shared helpers
  const timeCondition      = buildTimeFilterCondition(lastUpdated);
  const languageCondition  = buildLanguageFilterCondition(language);
  const searchCondition    = buildSearchCondition(search);
  const tagsCondition      = buildTagsFilterCondition(tags || []);
  const ageRangeCondition  = buildAgeRangeFilterCondition(minAge, maxAge);
  const genderCondition    = buildGenderFilterCondition(gender);
  const modeCondition      = buildModeFilterCondition(mode);
  const sourceCondition    = buildSourceFilterCondition(source);
  const ratingCondition    = buildRatingFilterCondition(minRating, maxRating, minRatingCount);
  // Personalization is a FILTER, not a sort: it must never apply without an
  // authenticated user (the route also guards this, but the builder is
  // exported and reused, so the invariant is enforced here too).
  //
  // `sortBy=for-you` already applies the same predicate via
  // `buildBookSortCondition`, so folding `personalizedCondition` in as well
  // would be a redundant (and confusing) duplicate.
  const personalizedCondition = personalized && currentUserId && bookSortBy !== 'for-you'
    ? buildPersonalizedFilterCondition(currentUserId)
    : null;

  // Sort-specific membership predicates (top-picks, originals, reads,
  // favorites, ...) are FILTERS, not merely ordering. They are folded into
  // `finalCondition` here — never applied via a second `.where()` call,
  // because drizzle's `.where()` ASSIGNS `config.where` (last call wins) and
  // would silently discard every earlier predicate, including the
  // status='active' + visibility='public' base scope.
  const sortCondition = buildBookSortCondition(bookSortBy, currentUserId, collection);

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
    sourceCondition,
    ratingCondition,
    personalizedCondition,
    sortCondition
  );

  // Apply secondary sorting: contextual sorting
  let query = baseQuery;

  // Apply where condition to main query
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = (query as any).where(finalCondition);

  // Build count query for pagination — shares the exact same combined
  // predicate as the result query so totalCount always matches.
  const countQuery = dbRead
    .select({ count: sql`COUNT(*)::int` })
    .from(books)
    .where(finalCondition);

  // Apply primary sorting: book-specific ORDER BY (the membership half of each
  // sort already lives in `sortCondition` above).
  if (bookSortBy) {
    query = applyBookSortOrder(query, bookSortBy, currentUserId, followingFirst);
  }

  // Apply orderBy for search relevance
  if (search) {
    const relevanceExpression = createRelevanceExpression(search, books);
    // `books.id` is appended as a stable, unique tie-breaker so that rows with
    // equal relevance score keep a deterministic order across pages (offset
    // pagination correctness — avoids duplicates/skips when ties exist).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query = (query as any).orderBy(desc(relevanceExpression), desc(books.id));
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
 * Builds the sort-specific membership predicate for a book sort option.
 *
 * Several sorts are not pure ORDER BY clauses — they also restrict WHICH rows
 * appear (top-picks → `top_pick IS NOT NULL`, reads → the viewer's sessions,
 * originals → `is_original` with a cover, ...). Those predicates are returned
 * here so {@link buildBookQuery} can AND them into the single combined
 * `finalCondition`.
 *
 * ⚠️ These predicates must NEVER be applied by chaining a second `.where()`
 * onto a query that already has one: drizzle's `.where()` assigns
 * `config.where` (last call wins), which silently discards the base
 * status='active' + visibility='public' scope and every other active filter.
 *
 * @param sortBy - Sort option
 * @param currentUserId - Viewer ID for user-scoped sorts (reads, favorites, ...)
 * @param collection - Optional favorites collection name to scope `favorites`
 * @returns Sort-specific predicate, or `null` when the sort is ordering-only
 *   (newest, popular, trending, creations)
 */
function buildBookSortCondition(
  sortBy: BookSortOption | undefined,
  currentUserId?: string | null,
  collection?: string
): ReturnType<typeof sql> | null {
  switch (sortBy) {
    case 'for-you': {
      // Recommend books based on the user's engagement history — reads
      // (userSessions), likes (userLikes), and favorites (userFavorites).
      // Keeps ongoing reads and finds other books with overlapping keywords;
      // only completed reads are excluded.
      // Requires authentication; anonymous viewers get an empty page instead of
      // falling through to the `popular` ordering: the fall-through used to
      // silently present the entire public catalogue under a "You Might Like"
      // label, and combined with the old single-slot explore cache this could
      // even surface a stale cached list.
      //
      // NOTE: unlike `personalized=true` (which FILTERS a section while keeping
      // its own popular/trending/newest ranking), this sort REPLACES the
      // ordering with the keyword-overlap score. Both share the same signal
      // profile and cold-start/completed-read-exclusion semantics via
      // `buildPersonalizedFilterCondition`.
      if (!currentUserId) return sql`1=0`;
      return buildPersonalizedFilterCondition(currentUserId);
    }

    case 'top-picks':
      // Only books marked as editor's top picks
      return sql`${books.topPick} IS NOT NULL`;

    case 'originals':
      // Auto-generated books (cron job) that also have a cover image.
      // Note: Intentionally filtering to only show originals with covers for
      // quality control — auto-generated books without covers are excluded.
      return sql`${books.isOriginal} AND ${books.imageId} IS NOT NULL`;

    case 'pen':
      // Public Pen-written books (is_pen_book) that the author has marked
      // complete (authoring_status='complete'). In-progress Pen drafts are
      // intentionally excluded from this showcase — they are surfaced in the
      // owner-scoped 'pen-drafts' sort instead.
      return sql`${books.isPenBook} AND ${books.authoringStatus} = 'complete'`;

    case 'reads':
      // Books the user has read (from userSessions)
      if (!currentUserId) return sql`1=0`;
      return sql`EXISTS (
        SELECT 1 FROM user_sessions
        WHERE user_id = ${currentUserId} AND book_id = books.id
      )`;

    case 'favorites':
      // Books the user has favorited (from userFavorites), optionally scoped
      // to a named collection.
      if (!currentUserId) return sql`1=0`;
      return sql`EXISTS (
        SELECT 1 FROM user_favorites uf
        WHERE uf.user_id = ${currentUserId}
          AND uf.book_id = books.id
          ${collection ? sql`AND uf.collection = ${collection}` : sql``}
      )`;

    case 'likes':
      // Books the user has liked (from user_likes where target_type = 'book')
      if (!currentUserId) return sql`1=0`;
      return sql`EXISTS (
        SELECT 1 FROM user_likes ul
        WHERE ul.user_id = ${currentUserId}
          AND ul.target_type = 'book'
          AND ul.target_id = books.id
      )`;

    case 'recommendations':
      // Books similar to what the user has liked (keyword overlap with liked books)
      if (!currentUserId) return sql`1=0`;
      return sql`EXISTS (
        SELECT 1
        FROM user_likes ul
        INNER JOIN books liked_books ON ul.target_id = liked_books.id
        WHERE ul.user_id = ${currentUserId}
          AND ul.target_type = 'book'
          AND liked_books.id != books.id
          AND books.keywords && liked_books.keywords
      )`;

    case 'pen-drafts':
      // User's own in-progress Pen books (is_pen_book + authoring_status='draft').
      // baseCondition already scopes to the owner via requireAuth, but we
      // re-assert the pen-draft predicate so a completed pen book drops off the
      // list as soon as it's marked complete.
      if (!currentUserId) return sql`1=0`;
      return sql`${books.isPenBook} AND ${books.authoringStatus} = 'draft'`;

    case 'following':
      // Books authored by people the current user follows (requires auth).
      // Anonymous viewers get an empty result.
      if (!currentUserId) return sql`1=0`;
      return sql`EXISTS (
        SELECT 1 FROM ${userFollows}
        WHERE ${userFollows.followerId} = ${currentUserId}
          AND ${userFollows.followingId} = ${books.userId}
      )`;

    case 'popular':
    case 'trending':
    case 'creations':
    case 'newest':
    default:
      // Ordering-only sorts — no membership restriction.
      return null;
  }
}

/**
 * Applies the book-specific ORDER BY clause for a sort option.
 *
 * Ordering ONLY — membership filtering lives in
 * {@link buildBookSortCondition} and is folded into `finalCondition` by
 * {@link buildBookQuery}. Keeping the two halves separate is what makes
 * drizzle's single-`.where()`-per-query contract safe.
 *
 * @param query - Drizzle query builder (WHERE already applied)
 * @param sortBy - Sort option (popular, newest, trending, top-picks, originals, reads, favorites, recommendations, for-you)
 * @param currentUserId - Optional current user ID for user-specific ordering (reads, favorites, likes, followingFirst)
 * @param followingFirst - When true + authenticated + default `newest` sort: bubble books from followed authors to the top
 * @returns Modified query builder with ORDER BY applied
 *
 * Behaviour:
 * - popular: Sorts by branchesCount/totalPages ratio (highest first)
 * - newest: Sorts by createdAt (latest first); optionally followed-authors-first
 * - trending: Sorts by pre-calculated trendingScore (time decay, cron-updated)
 * - top-picks: Sorts by latest topPick timestamp
 * - originals / pen / following: Sorts by createdAt (newest first)
 * - reads: Sorts by last-read timestamp (most recent first)
 * - favorites: Sorts by favorite creation date (most recent first)
 * - likes: Sorts by like creation date (most recent first)
 * - for-you: Scores by keyword overlap with the user's engagement profile,
 *   then trendingScore. Cold start (no profile) ranks by trendingScore so new
 *   users see content instead of an empty shelf.
 * - recommendations: Sorts by trendingScore
 * - creations / pen-drafts: Sorts by updatedAt (most recently edited first)
 *
 * @remarks
 * Uses `any` type for query parameter because Drizzle ORM query builder types
 * are extremely complex generic types that don't fit well into simple type constraints.
 * Type safety is maintained through the actual database operations and SQL generation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyBookSortOrder(query: any, sortBy: BookSortOption = 'newest', currentUserId?: string | null, followingFirst?: boolean): any {
  switch (sortBy) {
    case 'for-you': {
      // Rank by keyword overlap count between the candidate book and the
      // user's engagement profile, then trendingScore, then id as a stable
      // tie-breaker. (Anonymous viewers get `1=0` from
      // `buildBookSortCondition`, so the ordering never surfaces rows.)
      const interestKeywords = buildInterestKeywordsSql(currentUserId!);

      const overlapScore = sql`(
        SELECT COUNT(*)::int
        FROM unnest(${books.keywords}) AS kw
        WHERE kw = ANY(${interestKeywords})
      )`;

      return query.orderBy(desc(overlapScore), desc(books.trendingScore), desc(books.id));
    }

    case 'popular': {
      // Sort by branchesCount/totalPages ratio (pre-calculated branchesCount maintained by trigger)
      return query.orderBy(
        sql`(COALESCE(${books.branchesCount}, 0)::float / NULLIF(${books.totalPages}, 0)) DESC`,
        desc(books.id)
      );
    }

    case 'trending': {
      // Sort by pre-calculated trendingScore (updated daily via cron job with time decay)
      return query.orderBy(desc(books.trendingScore), desc(books.id));
    }

    case 'top-picks': {
      // Sort by latest topPick timestamp
      return query.orderBy(desc(books.topPick), desc(books.id));
    }

    case 'originals':
    case 'pen':
    case 'following': {
      // Sort by creation date (newest first)
      return query.orderBy(desc(books.createdAt), desc(books.id));
    }

    case 'reads': {
      // Sort by the most recent read timestamp. A user has at most one
      // user_sessions row per book (unique (user_id, book_id)), upserted on
      // every visit, so its updated_at is the last-read time. Falls back to
      // the book's updatedAt when no session exists (shouldn't happen here
      // due to the membership predicate).
      if (!currentUserId) return query.orderBy(desc(books.id));
      return query.orderBy(sql`COALESCE((
        SELECT us.updated_at FROM user_sessions us
        WHERE us.user_id = ${currentUserId} AND us.book_id = books.id
      ), ${books.updatedAt}) DESC`, desc(books.id));
    }

    case 'favorites': {
      // Sort by favorite creation date (most recent first)
      if (!currentUserId) return query.orderBy(desc(books.id));
      return query.orderBy(sql`(
        SELECT uf.created_at FROM user_favorites uf
        WHERE uf.user_id = ${currentUserId} AND uf.book_id = books.id
      ) DESC`, desc(books.id));
    }

    case 'likes': {
      // Sort by like creation date (most recent first)
      if (!currentUserId) return query.orderBy(desc(books.id));
      return query.orderBy(sql`(
        SELECT ul.created_at FROM user_likes ul
        WHERE ul.user_id = ${currentUserId} AND ul.target_type = 'book' AND ul.target_id = books.id
      ) DESC`, desc(books.id));
    }

    case 'recommendations': {
      return query.orderBy(desc(books.trendingScore), desc(books.id));
    }

    case 'creations': {
      // User's own created books (any status) — baseCondition already scopes
      // to the owner; here we only apply a deterministic sort (no filtering).
      // Sort by most-recently-edited so the dashboard "Recent Creations"
      // carousel (and Library) surface the books the user last touched first.
      return query.orderBy(desc(books.updatedAt), desc(books.id));
    }

    case 'pen-drafts': {
      // Most recently edited in-progress draft first.
      return query.orderBy(desc(books.updatedAt), desc(books.id));
    }

    case 'newest':
    default: {
      // When an authenticated user is on the default "All Stories" feed and
      // `followingFirst` is requested, bubble books from followed authors to
      // the top while still showing everything else below (newest-first within
      // each group). Degrades to plain `createdAt DESC` when not signed in or
      // when the user follows nobody.
      if (followingFirst && currentUserId) {
        const followedFirst = sql`(CASE WHEN EXISTS (
          SELECT 1 FROM ${userFollows}
          WHERE ${userFollows.followerId} = ${currentUserId}
            AND ${userFollows.followingId} = ${books.userId}
        ) THEN 0 ELSE 1 END)`;
        return query.orderBy(followedFirst, desc(books.createdAt), desc(books.id));
      }
      return query.orderBy(desc(books.createdAt), desc(books.id));
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
 * built here. It is served by {@link mapToEnrichedPage} directly from the
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
 * - Rejects anonymous/non-owner access to private or archived books before
 *   either prefetch returns or visit/progress/credit mutations can run.
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
 * const result = await visitBookPage(
 *   { userId, pageId, bookIdentifier, skipVisit, takeAction, consumeCredits, language },
 *   { c }
 * );
 * if (result.errorResponse) return result.errorResponse;
 * if (!result.dbPage || !result.book) return cNotFoundError(c, "Book or page not found");
 * const { visitDetails, book, dbPage, sourceAction, isUserTakeAction } = result;
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
    return { errorResponse: cNotFoundError(res, `Page not found`) };
  }

  // Get book (fat projection — cached, may be process-local stale)
  const { page: pageNumber, bookId, parentId: parentPageId, branchId } = dbPage;
  const book = await getEnrichedBook(bookId, userId, language);
  if (!book) {
    console.error(`[visit] ❌ Book not found:`, bookId);
    return { errorResponse: cNotFoundError(res, `Book not found`) };
  }

  // Authorization runs on the AUTHORITATIVE primary read, never on the
  // 5-minute process-local enriched projection: a book moderated to
  // private/archived on another serverless instance must be denied now, not
  // when that instance's LRU expires. See getBookAccessSnapshot.
  const accessFields = await getBookAccessSnapshot(bookId);
  if (!accessFields) {
    console.error(`[visit] ❌ Book row vanished during access check:`, bookId);
    return { errorResponse: cNotFoundError(res, `Book not found`) };
  }
  const accessError = getBookPageAccessError(res, accessFields, userId);
  if (accessError) return { errorResponse: accessError };

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
  let creditContext: "choose_other_action" | "choose_custom_action" = "choose_other_action";
  let creditAmount: number | undefined;

  if (pageNumber > 1) {
    const parentDbPage = parentPageId ? await getPageFromDB(parentPageId) : null;
    if (!parentDbPage) {
      console.error(`[visit] ❌ Previous page not found:`, parentPageId);
      return { errorResponse: cNotFoundError(res, `Previous page not found for pageNumber ${pageNumber}`) };
    }

    action = parentDbPage.actions.filter(a => a.destinationPageIds?.some(p => p === pageId))[0];

    let customActionAuthorId: string | undefined;

    // Custom action pages live in the custom_actions table, not in the
    // parent page's canonical actions[]. When the canonical lookup fails,
    // fall back to querying the custom_actions row that generated this page.
    if (!action) {
      const [customRow] = await dbRead
        .select()
        .from(customActions)
        .where(
          and(
            eq(customActions.pageId, parentPageId!),
            eq(customActions.nextPageId, pageId)
          )
        )
        .limit(1);

      if (customRow) {
        customActionAuthorId = customRow.userId ?? undefined;
        action = buildCustomActionAction({
          originalText: customRow.originalText,
          interpretedIntent: customRow.canonicalIntent ?? '',
          hintText: customRow.hintText ?? '',
          hintType: (customRow.hintType || 'custom') as ActionHintType,
          actionType: (customRow.actionType || 'custom') as ActionType,
          nextPageId: customRow.nextPageId,
          customActionId: customRow.id,
        });
      }
    }

    if (!action) {
      console.error(`[visit] ❌ Action for this page not found in the parent page:`, parentPageId);
      return { errorResponse: cNotFoundError(res, `Action for this page not found in the parent page`) };
    }

    selectedAction = mapActionToSelectedAction(action, parentPageId!, parentDbPage.page, pageId);

    const isCustomAction = action.source === 'custom' || Boolean(action.customActionId);
    const isOwnCustomAction = customActionAuthorId
      ? customActionAuthorId === userId
      : isCustomAction;
    const isCommunityAction = isCustomAction && !isOwnCustomAction;

    const selectedActions = await getPageActionsFromDB(userId, book.id, parentPageId!);
    const hasAlreadyChosenThisAction = selectedActions.some((a) => a.text === action!.text);

    if (isCommunityAction) {
      // Community action created by another user:
      // Costs CHOOSE_CUSTOM_ACTION (2 credits) to explore on first selection.
      // Free for the original creator or if the user has already chosen/unlocked this branch.
      if (!hasAlreadyChosenThisAction) {
        if (!consumeCredits) {
          console.error(`[visit] 💥 Community action requires credit confirmation`);
          return { errorResponse: cForbiddenError(res, "Credits required to choose community action") };
        }
        shouldConsumeCredits = true;
        creditContext = "choose_custom_action";
        creditAmount = getCreditCostForUser(userId, 'CHOOSE_CUSTOM_ACTION');
      }
    } else if (pageNumber > FREE_ACTION_SELECTION_UNTIL_PAGE + 1) {
      // Canonical actions (or own custom actions):
      // Validate user's action choice: check if user already chose a different action on previous page
      if (selectedActions.length && !hasAlreadyChosenThisAction) {
        if (isOwnCustomAction) {
          shouldConsumeCredits = false;
        } else if (!consumeCredits) {
          console.error(`[visit] 💥 Choice made, can't make another choice`);
          return { errorResponse: cForbiddenError(res, "Choice made, can't make another choice") };
        } else {
          shouldConsumeCredits = true;
          creditContext = "choose_other_action";
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
    shouldConsumeCredits,
    creditContext,
    creditAmount,
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

  // Fire system broadcast when this is the first user to complete this book.
  // Fire-and-forget; non-critical path so errors are silently swallowed.
  if (visitDetails.isNewCompletion && book.visibility === "public" && userId) {
    void fireFirstEndingBroadcast(userId, book, pageId);
  }

  return { dbPage, book, visitDetails, sourceAction: selectedAction, isUserTakeAction };
}

/**
 * Fires a locale-aware system broadcast when the first reader completes a book.
 * Uses the book's ending text (author-edited) for the broadcast.
 *
 * **Design decisions (by-design, not bugs):**
 * - **No `username` in `messageParams`:** The `BroadcastBanner` always renders
 *   `@{broadcast.username}` as a separate span. Translation strings don't include
 *   `@{username}` to avoid duplication (e.g., `@john 👁️ @john just discovered...`).
 * - **Race condition:** Two users finishing simultaneously can both see
 *   `isNewCompletion: true` (narrow window between stats query and completion
 *   insert). At most one duplicate system message — acceptable for rare events.
 *   `insertUserCompletedBook` uses `onConflictDoNothing` for idempotency.
 * - **`_endingPageId` unused:** Retained for potential future use (e.g., looking
 *   up story state for ending name if `book.ending?.text` is unavailable).
 */
async function fireFirstEndingBroadcast(
  userId: string,
  book: Pick<EnrichedBookData, "id" | "title" | "ending">,
  _endingPageId: string,
): Promise<void> {
  try {
    const endingText = book.ending?.text;

    const payload: SystemBroadcastI18nPayload = endingText
      ? {
          key: "broadcast.system.firstEnding",
          params: {
            endingName: endingText,
            bookTitle: book.title,
          },
          fallback: `📖 ${book.title} just had its first ending reached: "${endingText}". The story thickens!`,
        }
      : {
          key: "broadcast.system.firstEndingNoName",
          params: {
            bookTitle: book.title,
          },
          fallback: `📖 ${book.title} just had its first ending reached. The story thickens!`,
        };

    await sendSystemBroadcast(userId, payload);
  } catch (error) {
    console.error("[fireFirstEndingBroadcast] ❌ Failed:", error);
  }
}
