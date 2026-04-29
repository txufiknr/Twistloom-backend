# Trending Scores - Hybrid Approach

## Overview

This document describes the hybrid approach for calculating and maintaining trending scores for books. The system combines incremental updates on engagement events with daily batch normalization to provide near real-time trending while maintaining accuracy.

## Architecture

### Hybrid Approach

The trending score system uses a two-tier approach:

1. **Incremental Updates (Real-time)**
   - Engagement events immediately update `trendingScore`
   - Lightweight, fast operations
   - Provides near real-time feedback

2. **Daily Batch Recalculation (Normalization)**
   - Recalculates scores based on current engagement metrics
   - Applies time decay to older content
   - Prevents score drift from incremental updates

## Incremental Updates

### Engagement Weights

| Event | Weight | Implementation |
|-------|--------|----------------|
| User reads book | +0.5 | Database trigger on `user_sessions` insert |
| User likes book | +0.3 | API endpoint (POST /api/books/:id/like) |
| User unlikes book | -0.3 | API endpoint (DELETE /api/books/:id/like) |
| User favorites book | +0.2 | API endpoint (POST /api/books/:id/favorite) |
| User unfavorites book | -0.2 | API endpoint (DELETE /api/books/:id/favorite) |

### Implementation Details

**Read Count (Trigger):**
```sql
CREATE OR REPLACE FUNCTION increment_book_read_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE books
  SET read_count = read_count + 1,
      trending_score = trending_score + 0.5,
      updated_at = NOW()
  WHERE id = NEW.book_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Like/Unlike (API):**
```typescript
// Like
await dbWrite
  .update(books)
  .set({
    likesCount: sql`${books.likesCount} + 1`,
    trendingScore: sql`${books.trendingScore} + 0.3`,
    updatedAt: new Date()
  })
  .where(eq(books.id, id));

// Unlike
await dbWrite
  .update(books)
  .set({
    likesCount: sql`GREATEST(${books.likesCount} - 1, 0)`,
    trendingScore: sql`GREATEST(${books.trendingScore} - 0.3, 0)`,
    updatedAt: new Date()
  })
  .where(eq(books.id, id));
```

**Favorite/Unfavorite (API):**
```typescript
// Favorite
await dbWrite
  .update(books)
  .set({
    trendingScore: sql`${books.trendingScore} + 0.2`,
    updatedAt: new Date()
  })
  .where(eq(books.id, id));

// Unfavorite
await dbWrite
  .update(books)
  .set({
    trendingScore: sql`GREATEST(${books.trendingScore} - 0.2, 0)`,
    updatedAt: new Date()
  })
  .where(eq(books.id, id));
```

## Daily Batch Recalculation

### Purpose

- Normalize scores to prevent drift from incremental updates
- Apply time decay to older books
- Handle edge cases (negative scores, etc.)
- Ensure consistency with engagement metrics

### Formula

```
trendingScore = (readCount * 0.5 + likesCount * 0.3 + favoritedCount * 0.2) * timeDecayFactor
```

### Time Decay

| Age | Factor | Description |
|-----|--------|-------------|
| 0-7 days | 1.0 | Full score (100%) |
| 7-30 days | 0.8 | 80% score |
| 30-90 days | 0.5 | 50% score |
| 90+ days | 0.2 | 20% score |

### Implementation

**Location:** `src/cron/update-trending-scores.ts`
**Schedule:** Daily at 2 AM UTC via GitHub Actions
**Process:**
1. Query all active books with engagement metrics
2. Calculate scores using formula with time decay
3. Batch update in chunks of 100
4. Log success/failure statistics

## Caching Strategy

### Cache Keys

| Cache Key | TTL | Purpose |
|-----------|-----|---------|
| `books:explore:page:1` | 30 min | Default explore page (newest sort) |
| `books:explore:page:1:trending` | 5 min | Trending explore page (incremental updates) |

### Cache Invalidation

The explore cache is invalidated on any engagement event that affects trending scores:
- User likes/unlikes a book
- User favorites/unfavorites a book
- User reads a book (via trigger)

**Implementation:**
```typescript
export async function invalidateExploreCache(): Promise<boolean> {
  await deleteCache(CACHE_KEYS.EXPLORE_PAGE_1);
  await deleteCache(CACHE_KEYS.EXPLORE_PAGE_1_TRENDING);
  return true;
}
```

### HTTP Cache Headers

- **Trending:** `Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=150`
- **Newest:** `Cache-Control: public, max-age=1800, s-maxage=1800, stale-while-revalidate=900`

## Benefits

### Performance
- Incremental updates are O(1) operations
- No expensive COUNT queries on engagement events
- Daily batch processes all books efficiently
- Caching reduces database load

### Freshness
- Near real-time trending (immediate incremental updates)
- Users see impact of their engagement immediately
- Daily normalization ensures accuracy

### Cost Efficiency
- Reduced database queries (no COUNT on every engagement)
- Efficient batch processing
- Lower API costs with caching
- Reduced GitHub Actions runs (daily vs hourly)

### Industry Alignment
- Follows industry standards (YouTube, Reddit, Twitter)
- Balances freshness and cost
- Scalable architecture

## Migration Notes

### Database Changes
No schema changes required - `trendingScore` column already exists.

### Trigger Update
The `increment_book_read_count` trigger needs to be recreated to include `trendingScore` update:
```bash
pnpm db:generate  # Generate migration for trigger update
pnpm db:migrate   # Apply migration
```

### Deployment
1. Deploy code changes
2. Run database migration
3. GitHub Actions workflow will automatically switch to daily schedule (2 AM UTC)

## Monitoring

### Metrics to Track
- Trending score distribution
- Cache hit/miss ratios
- Cron job execution time
- Engagement event frequency

### Alerts
- Cron job failures
- Cache invalidation spikes
- Negative trending scores (shouldn't happen with GREATEST)

## Frontend Implementation (Next.js)

### ISR Configuration

For Next.js applications using Incremental Static Regeneration (ISR), match revalidation times with backend cache TTLs:

**Page: `/books/explore`**

```typescript
// app/books/explore/page.tsx
export const revalidate = 300; // 5 minutes (matches trending cache TTL)

// OR dynamic revalidation based on sort option
export async function generateStaticParams() {
  return [{ sort: 'trending' }, { sort: 'newest' }];
}

// For different sort options, use different revalidation times
export const dynamic = 'force-static';
```

### Recommended Revalidation Times

| Sort Option | Backend TTL | ISR Revalidate | Reason |
|-------------|-------------|----------------|--------|
| `trending` | 5 min (300s) | 300s | Matches backend cache for consistency |
| `newest` | 30 min (1800s) | 1800s | Matches backend cache, changes slowly |
| `popular` | 30 min (1800s) | 1800s | Calculated from branchesCount, changes slowly |
| `top-picks` | 1 hour (3600s) | 3600s | Editor's picks change infrequently |
| `originals` | 1 hour (3600s) | 3600s | Auto-generated books change infrequently |

### Implementation Pattern

**Option 1: Single Page with Dynamic Revalidation**

```typescript
// app/books/explore/page.tsx
export const revalidate = 300; // Use shortest TTL (trending)

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: { sort?: string };
}) {
  const sortBy = searchParams.sort || 'newest';

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/books/explore?sortBy=${sortBy}`,
    {
      next: {
        revalidate: sortBy === 'trending' ? 300 : 1800, // Dynamic based on sort
        tags: ['books-explore'], // Cache tag for on-demand revalidation
      },
    }
  );

  const data = await response.json();
  // Render component...
}
```

**Option 2: Separate Pages per Sort Option**

```typescript
// app/books/explore/trending/page.tsx
export const revalidate = 300; // 5 minutes

export default async function TrendingPage() {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/books/explore?sortBy=trending`,
    {
      next: {
        revalidate: 300,
        tags: ['books-explore-trending'],
      },
    }
  );
  // ...
}

// app/books/explore/newest/page.tsx
export const revalidate = 1800; // 30 minutes

export default async function NewestPage() {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/books/explore?sortBy=newest`,
    {
      next: {
        revalidate: 1800,
        tags: ['books-explore-newest'],
      },
    }
  );
  // ...
}
```

### On-Demand Revalidation

Use Next.js revalidation API to invalidate cache when engagement events occur:

**API Route for Cache Invalidation:**

```typescript
// app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { tag } = body;

  if (tag === 'books-explore' || tag === 'books-explore-trending') {
    revalidateTag('books-explore');
    revalidateTag('books-explore-trending');
    return NextResponse.json({ revalidated: true });
  }

  return NextResponse.json({ revalidated: false }, { status: 400 });
}
```

**Call from Backend on Engagement Events:**

```typescript
// In your backend routes after engagement events
await fetch(`${process.env.NEXT_PUBLIC_FRONTEND_URL}/api/revalidate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag: 'books-explore-trending' }),
});
```

### Client-Side Caching

For optimal UX, implement client-side caching with SWR or React Query:

```typescript
// SWR example
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function useExploreBooks(sortBy: string = 'newest') {
  const { data, error, isLoading } = useSWR(
    `/api/books/explore?sortBy=${sortBy}`,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: sortBy === 'trending', // Only revalidate trending on reconnect
      dedupingInterval: sortBy === 'trending' ? 300000 : 1800000, // 5 min vs 30 min
    }
  );

  return { data, error, isLoading };
}
```

### HTTP Cache Headers

The backend already sets appropriate HTTP cache headers:
- **Trending**: `Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=150`
- **Newest**: `Cache-Control: public, max-age=1800, s-maxage=1800, stale-while-revalidate=900`

These headers work with CDN/edge caching (Vercel Edge Network, Cloudflare, etc.) to reduce backend load.

### Best Practices

1. **Match TTLs**: Ensure ISR revalidation matches backend cache TTL to avoid stale data
2. **Use Cache Tags**: Implement cache tags for on-demand revalidation on engagement events
3. **Stale-While-Revalidate**: Leverage stale-while-revalidate for better UX
4. **Client-Side Caching**: Use SWR/React Query with appropriate deduping intervals
5. **Separate Pages**: Consider separate pages for high-traffic vs low-traffic sort options
6. **Monitor Cache Hit Rates**: Track cache performance to optimize TTLs

### Example: Full Implementation

```typescript
// app/books/explore/page.tsx
import { revalidateTag } from 'next/cache';

export const revalidate = 300; // Default to shortest TTL

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: { sort?: string; page?: string };
}) {
  const sortBy = searchParams.sort || 'newest';
  const page = parseInt(searchParams.page || '1');

  // Only cache page 1
  const shouldCache = page === 1;

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/api/books/explore?sortBy=${sortBy}&page=${page}`,
    {
      next: {
        revalidate: shouldCache ? (sortBy === 'trending' ? 300 : 1800) : 0,
        tags: shouldCache ? ['books-explore'] : [],
      },
    }
  );

  const data = await response.json();

  return <ExploreBooksView data={data} sortBy={sortBy} />;
}

// API route for manual revalidation
// app/api/revalidate/explore/route.ts
import { revalidateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    revalidateTag('books-explore');
    return NextResponse.json({ success: true, revalidated: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Revalidation failed' }, { status: 500 });
  }
}
```

## Future Enhancements

Potential improvements:
1. **Real-time normalization**: Event-driven normalization instead of daily
2. **Personalized trending**: User-specific trending based on preferences
3. **Category-specific trending**: Trending within tags/genres
4. **Velocity-based scoring**: Rate of change in engagement
5. **Machine learning**: Predict trending based on patterns
6. **WebSocket updates**: Real-time trending updates for active users
