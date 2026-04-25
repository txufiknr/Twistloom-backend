# Book Search Enhancement Roadmap

## Overview

This document outlines a comprehensive plan to enhance the book search and discovery functionality to align with industry standards from major book platforms (Goodreads, Amazon, Barnes & Noble). The roadmap is organized by priority and includes implementation details, migration steps, and risk assessments.

**Current State (April 2026):**
- Basic search across title, hook, summary
- Keywords search (JSONB array)
- Language filter (ISO 639-1)
- Fuzzy matching toggle
- Relevance scoring
- Pagination with sorting
- Database GIN indexes for search performance

**Target State:**
- Advanced faceted search with multi-dimensional filters
- Search suggestions and autocomplete
- "Did you mean?" typo correction
- Enhanced sorting options
- Recommendation engine
- Performance optimizations
- Security enhancements
- Full-text search capabilities

---

## Priority Matrix

| Priority | Feature | Impact | Effort | Risk |
|----------|---------|--------|--------|------|
| **P0** | Facet counts in search response | High | Medium | Low |
| **P0** | Enhanced sorting options | High | Low | Low |
| **P0** | Search rate limiting | High | Medium | Low |
| **P0** | Search suggestions/autocomplete | Medium | High | Medium |
| **P1** | "Did you mean?" typo suggestions | Medium | Medium | Low |
| **P1** | Similar books recommendation | High | High | Medium |
| **P1** | Search history tracking | Medium | Medium | Low |
| **P1** | Cursor-based pagination | Medium | High | Low |
| **P2** | Highlighted search terms | Low | Medium | Low |
| **P2** | Full-text search with tsvector | High | High | Medium |
| **P2** | Materialized views | Medium | High | Low |
| **P2** | Boolean search operators | Low | High | Medium |

---

## Phase 1: High Priority Enhancements (P0)

### 1.1 Facet Counts in Search Response

**Description:** Add aggregated counts for filter values to enable faceted navigation UI.

**Implementation:**
```typescript
// Add to GET /api/books response
interface FacetCounts {
  language: Record<string, number>;
  status: Record<string, number>;
  keywords: Record<string, number>;
}

interface SearchResponse {
  books: EnrichedBookData[];
  pagination: PaginationMeta;
  facets?: FacetCounts; // Only included when search is active
}
```

**Database Changes:**
```sql
-- Add computed facet counts using subqueries
SELECT 
  language,
  COUNT(*) as count
FROM books
WHERE userId = $1
  AND (search_conditions)
GROUP BY language;
```

**Migration Steps:**
1. Update `EnrichedBookData` interface to include optional facets
2. Add facet aggregation logic to `fetchBooks` function
3. Cache facet results separately (longer TTL than search results)
4. Update API documentation
5. Update frontend to display facet filters

**Dependencies:** None

**Estimated Effort:** 2-3 days

**Risk Assessment:** Low - Read-only aggregation, no schema changes

---

### 1.2 Enhanced Sorting Options

**Description:** Add additional sorting options beyond updatedAt.

**Implementation:**
```typescript
type BookSortOption = 
  | 'updatedAt'    // Current default
  | 'createdAt'    // Creation date
  | 'title'        // Alphabetical
  | 'likesCount'   // Most liked
  | 'readCount'    // Most read
  | 'branchesCount' // Most branches
  | 'completion'   // branchesCount/totalPages ratio
  | 'relevance';   // Search relevance (when searching)
```

**Migration Steps:**
1. Update `BookSortOption` type in `src/types/book.ts`
2. Update `applySorting` function in `src/utils/pagination.ts`
3. Add validation for new sort options
4. Update API documentation
5. Add database indexes if needed (likesCount, readCount already indexed)

**Dependencies:** None

**Estimated Effort:** 1 day

**Risk Assessment:** Low - Backward compatible, adds new options

---

### 1.3 Search Rate Limiting

**Description:** Implement rate limiting for search endpoints to prevent abuse and ensure fair usage.

**Implementation:**
```typescript
// Add to middleware/rate-limiter.ts
import rateLimit from 'express-rate-limit';

const searchRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many search requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/", searchRateLimiter, requireAuth, async (req, res) => {
  // ... existing logic
});
```

**Migration Steps:**
1. Install express-rate-limit: `pnpm add express-rate-limit`
2. Create rate limiter configuration
3. Apply to search endpoints
4. Add rate limit headers to responses
5. Update API documentation
6. Monitor rate limit violations

**Dependencies:** express-rate-limit package

**Estimated Effort:** 1 day

**Risk Assessment:** Low - Standard practice, minimal impact

---

### 1.4 Search Suggestions/Autocomplete

**Description:** Add autocomplete endpoint for search suggestions as user types.

**Implementation:**
```typescript
// New endpoint: GET /api/books/suggestions
router.get("/suggestions", requireAuth, async (req, res) => {
  const { q } = req.query;
  const suggestions = await getSearchSuggestions(q as string, userId);
  res.json({ suggestions });
});

async function getSearchSuggestions(query: string, userId: string) {
  // Return matching titles, keywords, and authors
  const results = await dbRead
    .select({
      title: books.title,
      keywords: books.keywords
    })
    .from(books)
    .where(
      and(
        eq(books.userId, userId),
        or(
          sql`${books.title} ILIKE ${'%' + query + '%'}`,
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${books.keywords}) as kw
            WHERE kw ILIKE ${'%' + query + '%'}
          )`
        )
      )
    )
    .limit(5);
  
  return results;
}
```

**Migration Steps:**
1. Create new `/suggestions` endpoint
2. Implement suggestion logic
3. Add caching for suggestions (short TTL)
4. Update API documentation
5. Frontend integration for debounced autocomplete

**Dependencies:** None

**Estimated Effort:** 2-3 days

**Risk Assessment:** Medium - New endpoint, requires frontend integration

---

## Phase 2: Medium Priority Enhancements (P1)

### 2.1 "Did You Mean?" Typo Suggestions

**Description:** Implement typo correction using Levenshtein distance or Soundex algorithm.

**Implementation:**
```typescript
// Add to src/utils/search.ts
export function getDidYouMeanSuggestions(
  query: string,
  availableTerms: string[]
): string[] {
  const suggestions: string[] = [];
  const threshold = 2; // Max edit distance
  
  for (const term of availableTerms) {
    const distance = levenshteinDistance(query.toLowerCase(), term.toLowerCase());
    if (distance <= threshold && distance > 0) {
      suggestions.push({ term, distance });
    }
  }
  
  return suggestions
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(s => s.term);
}

function levenshteinDistance(a: string, b: string): number {
  // Implement Levenshtein distance algorithm
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}
```

**Migration Steps:**
1. Implement Levenshtein distance algorithm
2. Add suggestion logic to search endpoint
3. Include suggestions in error response for no results
4. Update API documentation
5. Test with common typos

**Dependencies:** None

**Estimated Effort:** 2 days

**Risk Assessment:** Low - Pure algorithm, no database changes

---

### 2.2 Similar Books Recommendation

**Description:** Add endpoint to recommend similar books based on keywords, Jaccard similarity, and reading patterns.

**Implementation:**
```typescript
// New endpoint: GET /api/books/:id/similar
router.get("/:id/similar", optionalAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const similar = await getSimilarBooks(id, userId);
  res.json({ books: similar });
});

async function getSimilarBooks(bookId: string, userId?: string) {
  const book = await getBook(bookId);
  if (!book) return [];
  
  // Find books with keyword overlap
  const similarBooks = await dbRead
    .select()
    .from(books)
    .where(
      and(
        ne(books.id, bookId),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${books.keywords}) as kw
          WHERE kw = ANY(${book.keywords})
        )`
      )
    )
    .limit(10);
  
  // Calculate Jaccard similarity and sort
  const scored = similarBooks.map(b => ({
    ...b,
    similarity: calculateJaccardSimilarity(book.keywords, b.keywords)
  })).sort((a, b) => b.similarity - a.similarity);
  
  return scored.slice(0, 5);
}
```

**Migration Steps:**
1. Create new `/:id/similar` endpoint
2. Implement similarity calculation logic
3. Add caching for recommendations (medium TTL)
4. Update API documentation
5. Frontend integration for "Similar books" section

**Dependencies:** None

**Estimated Effort:** 3-4 days

**Risk Assessment:** Medium - New endpoint, requires algorithm tuning

---

### 2.3 Search History Tracking

**Description:** Track user's recent searches for quick access and analytics.

**Database Schema Addition:**
```sql
CREATE TABLE user_search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(userId) ON DELETE CASCADE,
  search_query TEXT NOT NULL,
  filters JSONB,
  result_count INTEGER,
  searched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, search_query, filters)
);

CREATE INDEX user_search_history_user_idx ON user_search_history(user_id);
CREATE INDEX user_search_history_searched_at_idx ON user_search_history(searched_at DESC);
```

**Implementation:**
```typescript
// Add to search endpoint
router.get("/", requireAuth, async (req, res) => {
  // ... existing search logic
  
  // Track search history (fire-and-forget)
  void trackSearchHistory(userId, search, filters, totalCount);
});

async function trackSearchHistory(
  userId: string,
  search: string,
  filters: Record<string, unknown>,
  resultCount: number
) {
  try {
    await dbWrite.insert(userSearchHistory).values({
      userId,
      searchQuery: search,
      filters: filters as any,
      resultCount
    }).onConflictDoNothing();
  } catch (error) {
    console.error('Failed to track search history:', error);
  }
}

// New endpoint: GET /api/books/search/history
router.get("/search/history", requireAuth, async (req, res) => {
  const history = await dbRead
    .select()
    .from(userSearchHistory)
    .where(eq(userSearchHistory.userId, userId))
    .orderBy(desc(userSearchHistory.searchedAt))
    .limit(10);
  
  res.json({ history });
});
```

**Migration Steps:**
1. Add `user_search_history` table to schema
2. Generate and run migration
3. Implement tracking logic
4. Create history endpoint
5. Update API documentation
6. Add history cleanup job (keep last 30 days)

**Dependencies:** Database migration

**Estimated Effort:** 2-3 days

**Risk Assessment:** Low - New table, isolated functionality

---

### 2.4 Cursor-Based Pagination

**Description:** Implement cursor-based pagination as an alternative to offset-based pagination for better performance with large datasets.

**Implementation:**
```typescript
interface CursorPaginationParams {
  cursor?: string;
  limit?: number;
}

interface CursorPaginationResponse {
  books: EnrichedBookData[];
  nextCursor?: string;
  hasMore: boolean;
}

router.get("/", requireAuth, async (req, res) => {
  const { cursor, limit = 20 } = req.query;
  
  if (cursor) {
    // Cursor-based pagination
    const result = await fetchBooksByCursor(cursor, limit as number);
    return res.json(result);
  }
  
  // Fall back to offset-based pagination
  // ... existing logic
});

async function fetchBooksByCursor(
  cursor: string,
  limit: number
): Promise<CursorPaginationResponse> {
  const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString());
  const { lastId, lastUpdatedAt } = cursorData;
  
  const books = await dbRead
    .select()
    .from(books)
    .where(
      and(
        eq(books.userId, userId),
        or(
          lt(books.updatedAt, lastUpdatedAt),
          and(eq(books.updatedAt, lastUpdatedAt), gt(books.id, lastId))
        )
      )
    )
    .orderBy(books.updatedAt, books.id)
    .limit(limit + 1); // Fetch one extra to check if more exists
  
  const hasMore = books.length > limit;
  const items = books.slice(0, limit);
  
  const nextCursor = hasMore && items.length > 0
    ? Buffer.from(JSON.stringify({
        lastId: items[items.length - 1].id,
        lastUpdatedAt: items[items.length - 1].updatedAt
      })).toString('base64')
    : undefined;
  
  return { books: items, nextCursor, hasMore };
}
```

**Migration Steps:**
1. Implement cursor-based pagination logic
2. Add cursor parameter to existing endpoint
3. Update API documentation
4. Frontend integration for infinite scroll
5. A/B test with offset-based pagination

**Dependencies:** None

**Estimated Effort:** 3-4 days

**Risk Assessment:** Medium - Significant change to pagination logic

---

## Phase 3: Low Priority Enhancements (P2)

### 3.1 Highlighted Search Terms

**Description:** Return search terms highlighted in results with context.

**Implementation:**
```typescript
interface HighlightedResult {
  title: string;
  highlightedTitle: string;
  summary: string;
  highlightedSummary: string;
}

function highlightText(text: string, query: string): string {
  if (!text || !query) return text || '';
  
  const terms = extractSearchTerms(query);
  let highlighted = text;
  
  for (const term of terms) {
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    highlighted = highlighted.replace(regex, '<mark>$1</mark>');
  }
  
  return highlighted;
}
```

**Migration Steps:**
1. Implement highlighting logic
2. Add to search response (optional field)
3. Update API documentation
4. Frontend integration for display

**Dependencies:** None

**Estimated Effort:** 2 days

**Risk Assessment:** Low - Pure string manipulation

---

### 3.2 Full-Text Search with tsvector

**Description:** Implement PostgreSQL full-text search using tsvector for better performance and relevance.

**Database Changes:**
```sql
-- Add tsvector column
ALTER TABLE books ADD COLUMN search_vector tsvector;

-- Create index
CREATE INDEX books_search_vector_idx ON books 
USING GIN (search_vector);

-- Create trigger to update search_vector
CREATE OR REPLACE FUNCTION books_search_vector_update() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', 
    COALESCE(NEW.title, '') || ' ' || 
    COALESCE(NEW.hook, '') || ' ' || 
    COALESCE(NEW.summary, '') || ' ' || 
    array_to_string(NEW.keywords, ' ')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER books_search_vector_trigger 
BEFORE INSERT OR UPDATE ON books
FOR EACH ROW EXECUTE FUNCTION books_search_vector_update();
```

**Implementation:**
```typescript
// Use tsquery for search
const searchQuery = sql`to_tsquery('english', ${parseSearchQuery(search)})`;

const results = await dbRead
  .select()
  .from(books)
  .where(
    and(
      eq(books.userId, userId),
      sql`${books.search_vector} @@ ${searchQuery}`
    )
  )
  .orderBy(sql`ts_rank(${books.search_vector}, ${searchQuery}) DESC`);
```

**Migration Steps:**
1. Add search_vector column to schema
2. Generate and run migration
3. Create update trigger
4. Implement tsquery search logic
5. Backfill existing data
6. Update search endpoint
7. Update API documentation
8. Performance testing

**Dependencies:** Database migration, PostgreSQL extension

**Estimated Effort:** 4-5 days

**Risk Assessment:** Medium - Database schema change, requires testing

---

### 3.3 Materialized Views

**Description:** Create materialized views for expensive aggregations like trending books.

**Database Changes:**
```sql
-- Materialized view for trending books
CREATE MATERIALIZED VIEW trending_books_mv AS
SELECT 
  b.id,
  b.title,
  b.userId,
  b.trendingScore,
  b.readCount,
  b.likesCount,
  b.branchesCount,
  b.updatedAt
FROM books b
WHERE b.status = 'active'
ORDER BY b.trendingScore DESC
LIMIT 100;

CREATE UNIQUE INDEX trending_books_mv_id_idx ON trending_books_mv(id);
CREATE INDEX trending_books_mv_score_idx ON trending_books_mv(trendingScore DESC);

-- Refresh function
CREATE OR REPLACE FUNCTION refresh_trending_books_mv()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY trending_books_mv;
END;
$$ LANGUAGE plpgsql;
```

**Implementation:**
```typescript
// Add to cron job
import { refreshTrendingBooksMV } from '../db/materialized-views.js';

// Run daily
cron.schedule('0 2 * * *', async () => {
  await refreshTrendingBooksMV();
});
```

**Migration Steps:**
1. Create materialized view migration
2. Generate and run migration
3. Implement refresh function
4. Add to cron job
5. Update explore endpoint to use MV
6. Update API documentation
7. Monitor refresh performance

**Dependencies:** Database migration, cron job

**Estimated Effort:** 2-3 days

**Risk Assessment:** Low - Read-only MV, concurrent refresh

---

### 3.4 Boolean Search Operators

**Description:** Support boolean operators (AND, OR, NOT) and phrase search in queries.

**Implementation:**
```typescript
function parseBooleanSearch(query: string): SearchQuery {
  // Parse: "thriller AND mystery"
  // Parse: "thriller -horror" (NOT)
  // Parse: "\"psychological thriller\"" (phrase)
  
  const terms: string[] = [];
  const excluded: string[] = [];
  const phrases: string[] = [];
  
  // Extract phrases in quotes
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(query)) !== null) {
    phrases.push(match[1]);
    query = query.replace(match[0], '');
  }
  
  // Extract excluded terms (prefixed with -)
  const excludedRegex = /-(\w+)/g;
  while ((match = excludedRegex.exec(query)) !== null) {
    excluded.push(match[1]);
    query = query.replace(match[0], '');
  }
  
  // Remaining terms are included
  terms = query.split(/\s+/).filter(t => t.length > 0);
  
  return { terms, excluded, phrases };
}
```

**Migration Steps:**
1. Implement boolean parser
2. Update search condition builder
3. Add operator support to ILIKE queries
4. Update API documentation
5. Test with various query combinations

**Dependencies:** None

**Estimated Effort:** 3-4 days

**Risk Assessment:** Medium - Complex parsing logic

---

## Implementation Timeline

### Week 1-2: Phase 1 (P0)
- Day 1-3: Facet counts implementation
- Day 4: Enhanced sorting options
- Day 5: Search rate limiting
- Day 6-8: Search suggestions/autocomplete
- Day 9-10: Testing and documentation

### Week 3-4: Phase 2 (P1)
- Day 11-12: "Did you mean?" typo suggestions
- Day 13-16: Similar books recommendation
- Day 17-19: Search history tracking
- Day 20-23: Cursor-based pagination
- Day 24: Testing and documentation

### Week 5-6: Phase 3 (P2)
- Day 25-26: Highlighted search terms
- Day 27-31: Full-text search with tsvector
- Day 32-34: Materialized views
- Day 35-38: Boolean search operators
- Day 39-40: Final testing and documentation

---

## Risk Mitigation

### Database Performance
- **Risk:** New indexes and materialized views may impact write performance
- **Mitigation:** Use CONCURRENTLY for index creation, monitor query performance, implement read replicas if needed

### Cache Invalidation
- **Risk:** Complex caching strategy may lead to stale data
- **Mitigation:** Implement cache versioning, use TTL-based expiration, manual invalidation triggers

### Breaking Changes
- **Risk:** API changes may break existing clients
- **Mitigation:** Version API endpoints, maintain backward compatibility, deprecation notices

### Search Relevance
- **Risk:** New algorithms may produce less relevant results
- **Mitigation:** A/B testing with old implementation, user feedback collection, gradual rollout

---

## Success Metrics

### Performance
- Search query latency < 200ms (P95)
- Facet count calculation < 100ms (P95)
- Autocomplete response < 50ms (P95)

### User Engagement
- Search usage increase by 20%
- Search result click-through rate increase by 15%
- User search retention (repeat searches) increase by 10%

### Technical
- Zero critical bugs in production
- 99.9% uptime for search endpoints
- Cache hit rate > 70%

---

## Dependencies

### Required Packages
```json
{
  "express-rate-limit": "^7.0.0",
  "fuse.js": "^7.0.0" (optional, for client-side fuzzy search)
}
```

### Database Requirements
- PostgreSQL 14+ (for advanced full-text search features)
- pg_trgm extension (for trigram similarity)
- Sufficient disk space for materialized views

### Infrastructure
- Redis for distributed caching (if not already using)
- Monitoring for search analytics
- A/B testing framework

---

## Rollback Plan

Each phase includes a rollback strategy:

1. **Feature flags:** Enable/disable features via configuration
2. **Database migrations:** Revertible migration scripts
3. **API versioning:** Maintain old endpoints alongside new ones
4. **Monitoring:** Alert on performance degradation
5. **Gradual rollout:** Canary deployment to subset of users

---

## Next Steps

1. **Immediate:** Run database migration for GIN indexes (already implemented)
2. **Week 1:** Begin Phase 1 implementation starting with facet counts
3. **Week 2:** Complete Phase 1 and begin Phase 2
4. **Ongoing:** Monitor search analytics and user feedback
5. **Review:** Monthly review of roadmap priorities based on usage data

---

## Appendix: Code Examples

### Example: Complete Search Request with All Features

```typescript
// Request
GET /api/books?search=thriller+mystery&language=en&fuzzy=true&sortBy=relevance&limit=20&page=1

// Response
{
  "books": [...],
  "pagination": {...},
  "facets": {
    "language": { "en": 42, "es": 15 },
    "status": { "active": 50, "draft": 7 },
    "keywords": { "thriller": 30, "mystery": 25, "horror": 12 }
  },
  "didYouMean": [],
  "searchId": "abc123"
}
```

### Example: Autocomplete Request

```typescript
// Request
GET /api/books/suggestions?q=thr

// Response
{
  "suggestions": [
    { type: "title", text: "The Thriller House", score: 0.95 },
    { type: "keyword", text: "thriller", score: 0.90 },
    { type: "title", text: "Midnight Thriller", score: 0.85 }
  ]
}
```

### Example: Similar Books Request

```typescript
// Request
GET /api/books/book123/similar

// Response
{
  "books": [
    { ...book, similarity: 0.85 },
    { ...book, similarity: 0.72 },
    { ...book, similarity: 0.65 }
  ]
}
```

---

**Document Version:** 1.0  
**Last Updated:** April 25, 2026  
**Maintained By:** Backend Team  
**Review Cycle:** Monthly
