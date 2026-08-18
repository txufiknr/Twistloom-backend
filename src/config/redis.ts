/**
 * @overview Redis Configuration
 * 
 * Provides Redis client configuration for caching.
 * Uses Upstash Redis for serverless-compatible HTTP-based Redis.
 * 
 * Features:
 * - Singleton Redis client instance
 * - Automatic connection management
 * - Error handling and graceful degradation
 * - Environment-based configuration
 */

/**
 * Cache TTL configuration (in seconds)
 */
export const REDIS_CACHE_TTL = {
  /** Per-user book list: 5 minutes */
  PER_USER_BOOKS: 5 * 60,
  /** Explore page 1: 30 minutes (for default/newest sort which changes slowly)
   * Note: Trending sort uses separate EXPLORE_PAGE_1_TRENDING cache with 5 min TTL */
  EXPLORE_PAGE_1: 30 * 60,
  /** Explore page 1 trending: 5 minutes (incremental updates) */
  EXPLORE_PAGE_1_TRENDING: 5 * 60,
  /** User profile: 2 minutes */
  USER_PROFILE: 2 * 60,
  /** Page 1 of an active book: 30 days. Page 1 content is immutable per book
   * (only created at book initialization), so a long TTL acts as "always
   * cached". Cleared on book deletion via invalidatePageOneCache. */
  PAGE_ONE: 30 * 24 * 60 * 60,
  /** Default: 1 minute */
  DEFAULT: 60,
  /** Five minutes: 5 * 60 */
  FIVE_MINUTES: 5 * 60,
  /** Thirty minutes: 30 * 60 */
  THIRTY_MINUTES: 30 * 60,
} as const;

/**
 * Cache key patterns
 */
export const REDIS_CACHE_KEYS = {
  /** Per-user book list: books:user:{userId}:page:{page} */
  USER_BOOKS: (userId: string, page: number) => `books:user:${userId}:page:${page}`,
  /** Invalidate all user books: books:user:{userId}:* */
  USER_BOOKS_PATTERN: (userId: string) => `books:user:${userId}:*`,
  /**
   * Legacy combined explore page-1 key (superseded by EXPLORE_PAGE_1_BY_SORT).
   * Kept only to explicitly purge the old shared slot on invalidation; nothing
   * new is ever written under it.
   *
   * WHY IT WAS BROKEN: `newest`, `popular`, `top-picks` and `originals` all
   * wrote their page-1 results into this ONE key. Whichever sort ran first
   * (always the default `newest` browse request, TTL 30 min) won, and every
   * later `sortBy=top-picks` / `sortBy=originals` request was served that same
   * cached "all public books" list — so those filters appeared to do nothing.
   */
  EXPLORE_PAGE_1: 'books:explore:page:1',
  /**
   * Per-sort explore page-1 key: `books:explore:page:1:{sortBy}`.
   *
   * Each public sort option (newest, popular, trending, top-picks, originals)
   * gets its OWN cache slot, so a `top-picks` request can never be answered
   * with data cached for `newest`. Trending falls out naturally as
   * `...:trending`, which matches the old EXPLORE_PAGE_1_TRENDING value.
   *
   * @param sortBy - BookSortOption value (e.g. 'top-picks', 'originals').
   */
  EXPLORE_PAGE_1_BY_SORT: (sortBy: string) => `books:explore:page:1:${sortBy}`,
  /**
   * Pattern matching every per-sort explore page-1 key. Used by
   * `invalidateExploreCache` so a public/visibility change clears all sort
   * slots in one scan. Note this does NOT match the legacy key
   * `books:explore:page:1` (no trailing segment) — that one is purged
   * explicitly alongside this pattern.
   */
  EXPLORE_PAGE_1_PATTERN: 'books:explore:page:1:*',
  /** Explore page 1 trending TTL (5 min) — superseded key constant kept for clarity in cache.ts */
  EXPLORE_PAGE_1_TRENDING: 'books:explore:page:1:trending',
  /** User profile: user:profile:{userId} */
  USER_PROFILE: (userId: string) => `user:profile:${userId}`,
  /** Top creators this week (homepage): users:top-creators:{limit} */
  TOP_CREATORS: (limit: number) => `users:top-creators:${limit}`,
  /** Static page 1 payload for a book: book:page1:{bookId}:{contentLanguage}
   * (contentLanguage is the effective page language, i.e. book language or the
   * translation target — page 1 content differs per language). */
  PAGE_ONE: (bookId: string, contentLanguage: string) => `book:page1:${bookId}:${contentLanguage}`,
} as const;
