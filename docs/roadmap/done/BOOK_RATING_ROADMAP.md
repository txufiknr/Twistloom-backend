# Book Rating (`rating` + `ratingCount`) — Implementation Roadmap

**Status:** ✅ Implemented (2026-08-02)
**Depends on:** `book_testimonials` table + testimonial CRUD already shipped (create/update/delete + admin curation)
**Scope:** Backend only — schema, trigger, types, select builder, cache invalidation. Frontend rendering of the rating is out of scope here.

---

## 0. Completion status

| # | Item | File | Status |
|---|---|---|---|
| 7.1 | Schema: `books.rating` (real) + `books.ratingCount` (integer) | `src/db/schema.ts:443-444` | ✅ |
| 7.2 | Types: `BookStats.rating` + `BookStats.ratingCount` | `src/types/book.ts` | ✅ |
| 7.3 | Select builder: `stats` gains `rating` + `ratingCount` | `src/services/book-controller.ts:122-123` | ✅ |
| 7.4 | Trigger: folded into `ensureBookTestimonialsCountTrigger`, renamed `update_book_testimonials_stats`, `AFTER INSERT OR UPDATE OR DELETE` | `src/db/triggers.ts` | ✅ |
| 7.5 | Migration `0045_friendly_violations.sql` + backfill, applied via `bun db:migrate` | `drizzle/0045_friendly_violations.sql` | ✅ |
| 7.6 | Cache invalidation on testimonial mutations (books.ts + admin.ts) | `src/routes/books.ts`, `src/routes/admin.ts` | ✅ |
| 7.7 | Explore rating filter: `validateRatingFilter`/`validateRatingCountFilter`, `buildRatingFilterCondition`, `?rating=` + `?minRatingCount=` wiring + `shouldCache` exclusion | `src/utils/search.ts`, `src/services/book-controller.ts`, `src/routes/books.ts` | ✅ |
| 7.8 | `books_rating_idx` partial index, migration `0046_thankful_night_thrasher.sql`, applied via `bun db:migrate` | `src/db/schema.ts`, `drizzle/0046_thankful_night_thrasher.sql` | ✅ |
| — | E2E trigger verification (INSERT / UPDATE flip / DELETE, pending-exclusion, NULLIF empty-state) | `test-rating-*.ts` (run + cleaned up) | ✅ |
| — | Rating-filter verification (parsers + threshold/count SQL behavior against real rows) | `test-rating-filter.ts` (run + cleaned up) | ✅ |
| — | Typecheck + lint | `bun run typecheck`, `bun run lint:fast` | ✅ |
| — | Google `AggregateRating` JSON-LD on the book detail page | (Frontend/SEO, out of scope) | ✅ |
| — | Bayesian "top-rated" ranking (§9) | (Future work) | ◻️ |

**Deviations from the plan (all deliberate, see Open Questions):**

- `rating_count` uses `NULLIF(COUNT(*), 0)` — it goes `NULL` (not `0`) when there are no approved rated testimonials, so `rating` and `ratingCount` are always **both null or both non-null**. The backfill leaves untouched books at `NULL/NULL`; without `NULLIF` the first delete-cycle would have drifted them to `NULL/0`.
- The legacy trigger function `update_book_testimonials_count` is explicitly dropped (`DROP FUNCTION IF EXISTS`) because `CREATE OR REPLACE` on a new name leaves the old function orphaned.

---

## 1. Problem statement

`book_testimonials` (schema.ts:2134) stores an optional integer `rating` (1–5, nullable) per testimonial, but no book-level aggregate rating exists anywhere. We want a public-facing **book rating** (0–5 display scale) computed from those testimonials, served alongside the other `stats` fields in `EnrichedBookData`, and eventually exposed as Google `AggregateRating` structured data.

This roadmap resolves two design questions:

1. **Where is the aggregate computed?** A denormalized, trigger-maintained column on `books` (chosen) vs. a correlated subquery in the read path (rejected).
2. **What does the aggregate represent?** The average of `approved` testimonials that carry a rating — deliberately narrower than the existing `testimonials_count` semantics.

---

## 2. Decision summary

| Decision | Recommendation | Why |
|---|---|---|
| Storage | **Denormalized `books.rating` (real) + `books.ratingCount` (integer)**, maintained by a trigger on `book_testimonials` | Consistent with every other aggregate in `BookStats` (`likesCount`, `testimonialsCount`, `completeCount`, …); O(1) reads; enables indexed `ORDER BY rating`; matches how Goodreads/Amazon/IMDb store aggregates |
| Trigger ownership | **Fold into the existing `ensureBookTestimonialsCountTrigger` function** so it maintains both `testimonials_count` and `rating`/`rating_count` | One table, one source scan, one trigger event — no second trigger, no double bookkeeping |
| Trigger event list | **`AFTER INSERT OR UPDATE OR DELETE`** (today it is `INSERT OR DELETE`) | `rating` and `status` both change on `UPDATE` (user rating edits + admin curation flips); a count-only trigger never needed UPDATE, the rating does |
| Rating filter | `AVG(rating)` over **`status = 'approved' AND rating IS NOT NULL`** only | Pending/rejected testimonials are not public (social-mentions.ts:120); a public rating must not be polluted by uncurated stars |
| Count semantics | `ratingCount` = COUNT of **approved testimonials with a non-null rating** — *not* `testimonialsCount` | `testimonialsCount` counts all testimonials of any status with or without a rating (schema.ts:442 comment); Google `AggregateRating.ratingCount` and any Bayesian ranking need the rated-subset count |
| Empty state | `rating = NULL` when there are no approved rated testimonials ("no ratings yet"), not `0` | `0/5` is misleading; `NULL` lets the frontend render "no ratings yet" |
| Precision | `ROUND(AVG(rating)::numeric, 1)` → one decimal, stored as `real` | Matches the decimal-dot requirement of Google's `ratingValue` (`4.4`, not `4,4`); matches `completionRate`/`trendingScore` column style |
| Per-user uniqueness | Keep `book_testimonials` **without** a `(userId, bookId)` unique constraint for now, but document the `ratingCount` semantics explicitly | Adding a constraint is a product decision (one rating per reader vs. multiple testimonials); see §6.4 |
| Cache | **Add `invalidateEnrichedBookCache(bookId)` to testimonial mutation routes** | Without it, rating changes lag the 5-minute enriched-book LRU TTL (pre-existing behavior for all counters, now user-visible for rating) |

---

## 3. Denormalized column vs. correlated subquery — full rationale

Two candidate implementations were evaluated.

### 3.1 The subquery approach (rejected)

```sql
-- in getEnrichedBookSelect stats object
rating: sql<number | null>`(
  SELECT ROUND(AVG(rating)::numeric, 1)
  FROM book_testimonials bt
  WHERE bt.book_id = books.id
    AND bt.status = 'approved'
    AND bt.rating IS NOT NULL
)`
```

**Pros:**
- No migration, no trigger, no backfill.
- Always fresh — no trigger/cache staleness.
- Follows the existing correlated-subquery precedent already used for `session`, `firstPage`, and `translation` (book-controller.ts:142–196).

**Cons (decisive):**
- **Per-row cost on list queries.** A correlated subquery executes once per returned `books` row. It is *not* O(total rows) — the `(book_id, status)` index (schema.ts:2150) bounds each execution to O(k), where k = approved rated testimonials **for that book**. A page of n books costs O(n·k). Cost grows with **popular books accumulating ratings** (k → thousands), not with raw table size. On hot endpoints (explore, feed) this recompute happens on every request.
- **No indexed sorting/filtering.** A correlated subquery is a computed expression. A future `ORDER BY rating DESC` ("top-rated" feed) or `rating >= 4.0` filter forces a sort of the entire result set per query — Postgres cannot use an index on a computed expression. This is the same reason `trendingScore`, `likesCount`, etc. are stored, not computed.
- **Cascade invalidation burden.** Would be re-derived per request; if we ever memoized it we'd re-invent the denormalized column.

### 3.2 The denormalized approach (chosen)

A nullable `books.rating` + `books.ratingCount` kept in sync by the same trigger that already maintains `testimonials_count`.

**Pros:**
- **O(1) read** — direct column access, exactly like `likesCount`, `readCount`, `commentsCount`, `branchesCount`, `completeCount`, `completionRate` in the `stats` select (book-controller.ts:116–124).
- **Indexable** — a future `books_rating_idx` turns `ORDER BY rating DESC` into an indexed scan instead of a full sort (§9).
- **Single source of truth** — one trigger keeps `testimonials_count`, `rating`, and `rating_count` consistent; no drift between them.
- **Pattern consistency** — the codebase already accepts the trigger-maintained-denormalized tradeoff everywhere else; rating is the same shape of problem.
- **AggregateRating-ready** — Google needs exactly `ratingValue` + `ratingCount`; both are stored and served O(1).

**Cons (accepted):**
- Requires a migration + one-time backfill for existing books.
- Write-side recompute on every testimonial mutation (full AVG/COUNT over that book's subset). This is the same cost the existing count trigger already pays, and testimonials are a low-frequency write path (curated submissions), so the full recompute is acceptable — unlike the O(1) delta triggers used on high-frequency tables.
- Cache staleness for `getEnrichedBook` (5-min LRU) unless invalidation is added (§6.5).

### 3.3 Verdict

The denormalized approach is chosen. It is not merely "consistent with the existing pattern" — it is *strictly better* than the subquery for the two workloads that matter here: hot list reads (explore/feed) and future rating-based sorting. The subquery's one advantage (no migration) is a one-time cost, while the subquery's per-row recompute is a recurring cost on the hottest endpoints.

---

## 4. Google's `AggregateRating` — what it is & how to comply

### 4.1 What it is

`AggregateRating` is a schema.org type embedded in page structured data (JSON-LD recommended) that tells Google the **collective** rating of an item — the average value plus how many people rated it. When eligible, Google renders **star review rich snippets** in search results. It is relevant here because **`Book` is on Google's valid `itemReviewed` type list**, so book detail pages qualify directly.

### 4.2 Required / recommended properties (Google-supported)

| Property | Required | Notes |
|---|---|---|
| `itemReviewed` (or parent `Book.name` when nested) | ✅ | The item being rated; `Book` is a valid type |
| `ratingValue` | ✅ | Average. Default scale **1–5**; decimals must use a **dot** (`4.4`, not `4,4`). `4` is treated as 4/5 |
| `ratingCount` | ✅ one of | Number of ratings |
| `reviewCount` | ✅ one of | Number of reviews (use `ratingCount` here — ratings, not reviews) |
| `bestRating` / `worstRating` | ⭐ recommended | Only needed if the scale differs from 1–5; harmless to include (`5` / `1`) |
| `author` | For individual reviews | Not needed for a pure `AggregateRating` block |

**Important:** Google explicitly states that a rich snippet for an aggregate *requires* the `ratingValue` (the average) — a bare count is not enough.

### 4.3 Content & quality guidelines (what actually gets you the rich result, and avoids manual action)

These come from Google Search Central (Review Snippet / General Structured Data Guidelines). Violations can make you *ineligible* or trigger a spam manual action — this is why compliance matters, not just syntax.

1. **Markup must reflect visible content.** The rating and its testimonials must be actually rendered on the book page. Do not emit `AggregateRating` for data users can't see on the page.
2. **An aggregate "by many people".** A 1-rating average is not eligible in spirit; `ratingCount` should be a real number of distinct user ratings.
3. **First-party only.** Don't aggregate ratings/reviews scraped from other websites. `book_testimonials` are first-party user submissions → compliant by construction.
4. **No fake or undisclosed incentivized reviews.** Content must be based on a genuine experience. This is a strong argument for rating from **`approved`** testimonials only — pending/rejected rows were rejected *by the curation process* precisely because they don't meet this bar.
5. **No self-serving ratings.** A site rating its own product (no genuine user source) is disqualified. Ours are user-submitted → compliant.
6. **`ratingValue` format.** Decimal dot, values on the 1–5 scale (or explicit `bestRating`/`worstRating`).

### 4.4 Example JSON-LD (nested into the Book detail page)

```json
{
  "@context": "https://schema.org",
  "@type": "Book",
  "name": "The Whispering Halls",
  "url": "https://twistloom.app/books/the-whispering-halls",
  "image": "https://ik.imagekit.io/.../cover.jpg",
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": 4.4,
    "ratingCount": 127,
    "bestRating": 5,
    "worstRating": 1
  }
}
```

### 4.5 The `ratingCount` consequence

`AggregateRating.ratingCount` must equal the number of **ratings** on the site. That is *not* `testimonialsCount` (schema.ts:442), which counts **all** testimonials — any status, with or without a rating. It is the count of **approved testimonials that carry a non-null rating**. Hence the new `books.ratingCount` column, maintained in the same trigger subquery that computes the AVG. It is also exactly the input a future Bayesian ranking needs (§9).

---

## 5. Industry standard — how big platforms rate entities

### 5.1 Arithmetic-mean platforms

The **displayed** rating on Goodreads, Amazon, and Letterboxd is essentially the mean of user star ratings, stored/cached as a denormalized aggregate. Our chosen approach (trigger-maintained `AVG`, O(1) read) is precisely this pattern. The architectural shape — write-time aggregate kept in sync, cheap reads — is what all of them use.

### 5.2 IMDb — the deliberate exception (weighted average)

IMDb explicitly does **not** use the arithmetic mean for its headline rating:

> "We don't use the arithmetic mean... instead the rating displayed on a title's page is a weighted average."

For the Top 250, IMDb publishes a **Bayesian credibility formula**:

```
WR = (v / (v + m)) × R + (m / (v + m)) × C
```

| Symbol | Meaning |
|---|---|
| `R` | the title's raw mean rating |
| `v` | number of ratings for the title |
| `m` | minimum votes required to be listed (25,000 for Top 250) |
| `C` | the mean rating across all titles |

Intuition: with few votes, don't trust `R` much — pull it toward the global prior `C`; as votes accumulate, trust `R` more. IMDb also filters to "regular voters" and applies secret anti-abuse weighting. This exists to make **rankings** resistant to vote-stuffing (a single 10-star vote must not rocket an unknown title to #1).

### 5.3 What this means for us

- **For displaying a rating** (and for Google `AggregateRating`), the plain `AVG` via trigger is correct and standard.
- **For future ranking** ("top-rated" sort), a raw `AVG` over small samples orders badly (a 3-vote book at 5.0 beating a 500-vote book at 4.8). That is when to apply the Bayesian formula. The two denormalized columns we add — `rating` = `R`, `ratingCount` = `v` — are exactly the formula's inputs; `C` (global mean) and `m` (threshold) are config constants. We already run a `trendingScore` cron (schema.ts:431), so a cron-computed Bayesian rating would fit the existing pattern.

---

## 6. What to correct from the current implementation

None of these are bugs in shipped behavior — they are gaps/decisions exposed by introducing a public rating.

### 6.1 Status filtering divergence (rating vs. count)

`update_book_testimonials_count()` (triggers.ts:541-555) counts **all** testimonials regardless of status, and the public testimonial wall only exposes `approved` (+ `featured`) rows (social-mentions.ts:120). The **rating must use `approved AND rating IS NOT NULL`** — otherwise uncurated (`pending`) and rejected stars leak into a public, SEO-exposed rating. This divergence is intentional and must be documented in the trigger function.

### 6.2 Trigger event list must include UPDATE

The current trigger fires `AFTER INSERT OR DELETE` (triggers.ts:564-568). Counts don't change on `UPDATE`, so the count trigger never needed it. Ratings **do** change on `UPDATE` in two flows:

- `PATCH /:identifier/testimonials/:id` — user edits their rating and the row resets to `pending` (books.ts:5529-5579).
- `PATCH /admin/testimonials/:id` and `POST /admin/testimonials/bulk-status` — admin flips `pending → approved` (admin.ts:764-806).

The folded function must therefore register `AFTER INSERT OR UPDATE OR DELETE`. The count recompute is idempotent, so adding `UPDATE` is harmless to it.

### 6.3 `testimonialsCount` ≠ `ratingCount`

`testimonials_count` answers "how many testimonials does this book have (any status, rated or not)". `rating_count` answers "how many approved ratings does this book have". They must not be conflated — Google's `AggregateRating.ratingCount` and any Bayesian formula need the latter. Keep them as two separate columns maintained by one trigger.

### 6.4 No `(userId, bookId)` uniqueness on `book_testimonials`

The table currently has no unique constraint on `(userId, bookId)` (schema.ts:2146-2152 only has indexes). A user can submit multiple testimonials for the same book, which affects `ratingCount` semantics (count of *ratings* vs. count of *people who rated*). Decision: keep as-is for now, but define `ratingCount` as **per-rating** (matches `AVG` numerator/denominator exactly), and note that if "one rating per reader" is desired later it's a product decision requiring a unique constraint + a dedupe backfill. No constraint change in this roadmap.

### 6.5 Cache staleness

`getEnrichedBook` caches `EnrichedBookData` in an LRU with a 5-minute TTL (services/book.ts:62-65). Testimonial mutations never call `invalidateEnrichedBookCache`, so counters can lag up to 5 minutes — accepted today because counters are low-stakes. A **rating is user-visible and SEO-exposed**, so testimonial mutation routes should invalidate the enriched cache for the affected book: the two testimonial routes in books.ts and the admin curation routes in admin.ts. This is additive hardening, not a behavior change.

---

## 7. Implementation plan

### 7.1 Schema — `src/db/schema.ts` (`books` table, ~line 442)

Add two nullable columns after `testimonialsCount`. The existing `satisfies Record<keyof Omit<Book, 'stats' | 'imageUrl'> | keyof BookStats | ResourceTimestamp, unknown>` (schema.ts:453) will then *force* the `BookStats` type update in §7.2 — the compiler enforces the two halves stay in sync.

```ts
rating: real("rating"), // Average rating (1-5 scale, 1 decimal) of approved testimonials (maintained by trigger)
ratingCount: integer("rating_count"), // Count of approved testimonials carrying a rating (maintained by trigger)
```

Optional but recommended once sorting by rating is used (§9): an index.

```ts
// in the table's index callback:
index("books_rating_idx").on(t.rating.desc()).where(sql`${t.rating} IS NOT NULL`),
```

### 7.2 Types — `src/types/book.ts`

Add to `BookStats` (schema.ts counterpart is enforced by §7.1):

```ts
/** Average rating (0-5 display scale) of approved testimonials (maintained by database trigger) */
rating: number | null;
/** Number of approved testimonials carrying a rating (maintained by database trigger) */
ratingCount: number | null;
```

No change needed to `EnrichedBookData` itself — it already carries `stats: BookStats` (types/book.ts:215), so completing `BookStats` completes the enriched shape.

### 7.3 Select builder — `src/services/book-controller.ts`

Add to the `stats` object (book-controller.ts:116-124). The existing `satisfies Record<keyof BookStats, unknown>` enforces this too:

```ts
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
```

### 7.4 Trigger — `src/db/triggers.ts` (`ensureBookTestimonialsCountTrigger`, lines 537-575)

Fold rating + ratingCount into the existing function (rename it to reflect the wider scope) and widen the trigger event list.

```sql
CREATE OR REPLACE FUNCTION update_book_testimonials_stats()
RETURNS TRIGGER AS $$
DECLARE
  v_book_id UUID;
BEGIN
  v_book_id := COALESCE(NEW.book_id, OLD.book_id);

  UPDATE books
  SET testimonials_count = (
        SELECT COUNT(*)
        FROM book_testimonials
        WHERE book_id = v_book_id
      ),
      rating = (
        SELECT ROUND(AVG(rating)::numeric, 1)
        FROM book_testimonials
        WHERE book_id = v_book_id
          AND status = 'approved'
          AND rating IS NOT NULL
      ),
      rating_count = (
        SELECT NULLIF(COUNT(*), 0)
        FROM book_testimonials
        WHERE book_id = v_book_id
          AND status = 'approved'
          AND rating IS NOT NULL
      ),
      updated_at = NOW()
  WHERE id = v_book_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
```

`NULLIF(COUNT(*), 0)` keeps `rating_count` null when no approved rated testimonials exist, so `rating` and `ratingCount` are always both-null or both-non-null (the backfill leaves untouched books at `NULL/NULL`; without `NULLIF` a delete-cycle would drift them to `NULL/0`).

```sql
DROP FUNCTION IF EXISTS update_book_testimonials_count();  -- orphan cleanup
DROP TRIGGER IF EXISTS book_testimonials_count_trigger ON book_testimonials;
CREATE TRIGGER book_testimonials_count_trigger
  AFTER INSERT OR UPDATE OR DELETE ON book_testimonials
  FOR EACH ROW EXECUTE FUNCTION update_book_testimonials_stats();
```

Notes:
- `RETURN COALESCE(NEW, OLD)` already handles all three ops (DELETE exposes only `OLD`).
- The old function name `update_book_testimonials_count` is replaced by `update_book_testimonials_stats`; `CREATE OR REPLACE` on a new name leaves the old-named function orphaned — drop it (`DROP FUNCTION IF EXISTS update_book_testimonials_count();`) or keep the original name to avoid the orphan. Picking the rename is cleaner semantically.
- `dropAllTriggers()` (triggers.ts:44-70) already tears down every trigger before re-creation, so running `bun db:triggers` applies this cleanly and idempotently.

### 7.5 Migration + backfill

1. `bun db:generate` — produces the `rating`/`rating_count` column add.
2. Add a backfill to the generated migration so existing books get correct values:

```sql
UPDATE books b
SET rating = sub.rating,
    rating_count = sub.rating_count
FROM (
  SELECT
    bt.book_id,
    ROUND(AVG(bt.rating)::numeric, 1) AS rating,
    COUNT(*)::int AS rating_count
  FROM book_testimonials bt
  WHERE bt.status = 'approved' AND bt.rating IS NOT NULL
  GROUP BY bt.book_id
) sub
WHERE b.id = sub.book_id;
```

Books with no approved rated testimonials stay `NULL`/`NULL` (correct "no ratings yet" state).
3. `bun db:migrate` (and the prod variant for deployment).

### 7.6 Cache invalidation on testimonial mutations

Call `invalidateEnrichedBookCache(bookId)` in:
- `POST /:identifier/testimonials` (books.ts:5419) — after insert.
- `PATCH /:identifier/testimonials/:id` (books.ts:5529) — after update.
- `DELETE /:identifier/testimonials/:id` — after delete.
- Admin `PATCH /testimonials/:id` and `POST /testimonials/bulk-status` (admin.ts) — after status/feature changes (these are the `pending → approved` flips that actually move the public rating).

This is additive; it fixes the pre-existing 5-minute lag for all `stats` counters as a side effect of touching these routes.

### 7.7 Explore rating filtering — the min-threshold model

**Status:** ✅ Implemented (2026-08-02).

The frontend's book **explore** now supports filtering by rating via two query params on `GET /api/books/explore`:

```
?rating=4          → rating >= 4            ("4★ & up" bucket)
?rating=4-5        → 4 <= rating <= 5       (range)
?minRatingCount=5  → rating_count >= 5      ("by at least 5 people")
```

The API accepts **whole stars only** — a single digit (`"4"`) or an integer range (`"4-5"`). Decimals (`"3.5"`) and max-only forms (`"0-3"`, `"-3"`) are **rejected** by `validateRatingFilter`. Users think in whole stars, so the filter surface is exactly what the UI's star selector offers.

**The chosen model is a minimum-threshold ("X★ & up") ladder with optional ranges, not exact per-star buckets and not a single "4+" binary.** Rationale:

- **Decimals make exact buckets undefined.** `books.rating` is a 1-decimal `real` (4.0, 4.1 … 4.9). An exact "4-star" filter has no meaning — is 4.2 a "4"? Users think in whole stars, so exact-matching a decimal reads as a bug.
- **Thresholds match the industry idiom.** Amazon's canonical star sidebar is all thresholds ("4★ & up" = `rating >= 4`); Letterboxd's rating filter is a minimum ("3.5 and above"); Yelp uses a "at least X" slider. No major platform filters by exact-match star buckets — exact matching is only used for *displaying* a distribution histogram, never for filtering.
- **A single "4+" binary is too narrow.** It removes the "1★ & up" floor, and on a young catalog with sparse ratings "4+ only" often returns an empty page that reads as "broken filter". The whole-star threshold ladder (1★–5★) degrades gracefully.
- **Range mirrors the existing API pattern.** `"4-5"` is the same `min-max` shape as `ageRange=18-30`, and lets users bound a window (e.g. the "4–5 sweet spot") while the single digit covers "X★ & up".

**Semantics:**

- **`NULL` = "not yet rated" is always excluded** from rating filters. The condition builder emits an explicit `rating IS NOT NULL` guard (which also makes the partial-index predicate unambiguous to the planner).
- **`minRatingCount` gates small samples** — e.g. `?rating=4&minRatingCount=5` returns only "4★ & up by ≥ 5 people", so a lone 5-star vote can't dominate a bucket. It reads off the denormalized `rating_count` column (O(1)).
- Both params are validated (`validateRatingFilter`, `validateRatingCountFilter` in `utils/search.ts`) and disable the page-1 response cache (`shouldCache` exclusion), consistent with every other filter.

**Index (Q7 answered early — added with the filter, not deferred to §9):**

```ts
index("books_rating_idx").on(t.rating.desc()).where(sql`${t.rating} IS NOT NULL`),
```

The partial b-tree serves both the `rating >= X` / `rating <= X` range filters (a rating filter always implies `rating IS NOT NULL`, so Postgres can always use the index predicate) **and** the future §9 `ORDER BY rating DESC` "top-rated" sort. It was added now rather than later because it is a one-time migration that also unlocks the filter's query plan — no reason to ship the filter and discover the scan in production.

**Implementation wiring (follows the existing filter pattern exactly):**

| Layer | File | Change |
|---|---|---|
| Validation | `utils/search.ts` | `validateRatingFilter` (single digit or integer range `"n-m"`, whole stars 1–5 only, rejects decimals/max-only/`min > max`) + `validateRatingCountFilter` (positive integer) |
| Condition | `services/book-controller.ts` | `buildRatingFilterCondition(minRating?, maxRating?, minRatingCount?)` → `rating IS NOT NULL` + `>=`/`<=`/`rating_count >=`; wired into `combineFilterConditions` inside `buildBookQuery` |
| Route | `routes/books.ts` | Parse `?rating=` + `?minRatingCount=`, validate, pass into `buildBookQuery`, add `!ratingParam && !ratingCountParam` to `shouldCache` |

**Verified:** a throwaway-data test exercised all parser formats (valid + invalid), threshold behavior (min-only, max-only, range), NULL exclusion, and `minRatingCount` gating against real rows — all passed, test files cleaned up.

---

## 8. Files to change

| File | Change |
|---|---|
| `src/db/schema.ts` | `books.rating` + `books.ratingCount` + `books_rating_idx` (partial, §7.7); `satisfies` clause already enforces §7.2 |
| `src/types/book.ts` | `BookStats.rating` + `BookStats.ratingCount` |
| `src/services/book-controller.ts` | `stats` object gains `rating` + `ratingCount`; `buildRatingFilterCondition` + `buildBookQuery` params (`minRating`, `maxRating`, `minRatingCount`) |
| `src/db/triggers.ts` | Fold rating into `ensureBookTestimonialsCountTrigger`; widen event list to `INSERT OR UPDATE OR DELETE` |
| `src/utils/search.ts` | `validateRatingFilter` + `validateRatingCountFilter` (§7.7) |
| Migration (generated) | `0045_friendly_violations.sql` (column add + backfill UPDATE), `0046_thankful_night_thrasher.sql` (`books_rating_idx`) |
| `src/routes/books.ts` | Testimonial routes call `invalidateEnrichedBookCache`; explore route parses `?rating=` + `?minRatingCount=` |
| `src/routes/admin.ts` | Admin curation routes call `invalidateEnrichedBookCache` |
| (Future) book detail page renderer | Emit `AggregateRating` JSON-LD (§4.4) |

---

## 9. Future work — Bayesian "top-rated" ranking

Once rating data accumulates and a "top-rated" sort is desired, replace the raw `AVG` ordering with IMDb-style credibility scoring. The columns already added make this trivial:

```
score = (ratingCount / (ratingCount + m)) × rating + (m / (ratingCount + m)) × C
```

- `rating` and `ratingCount` come straight off the `books` row (already denormalized).
- `C` = global mean rating across all approved rated testimonials (one aggregate query, cacheable).
- `m` = configurable minimum-ratings threshold.

This can live in the existing `trendingScore` cron (schema.ts:431), writing a cron-computed column, or be computed in SQL at query time using the stored `rating`/`ratingCount`. The `books_rating_idx` (added in §7.7) already serves the `ORDER BY rating DESC` scan, so only the formula itself remains.

---

## 10. Decision log

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Denormalized column vs. subquery | **Denormalized (trigger-maintained)** | O(1) reads, indexed sorting, pattern consistency; subquery's only advantage (no migration) is one-time (§3) |
| D2 | Separate trigger vs. fold into existing | **Fold into `ensureBookTestimonialsCountTrigger`** | Same table/source; single recompute; no double bookkeeping |
| D3 | Which testimonials feed the rating | **`approved` only, with non-null rating** | Public/SEO exposure; curation bar; Google quality guidelines (§4.3, §6.1) |
| D3.1 | AggregateRating gate rating threshold | **`rating >= 3`** | Aligns with Google Rich Results requirement that rating must be at least 3 to be eligible |

| D4 | Empty state | **`NULL`, not `0`** | "No ratings yet" is honest; avoids misleading 0/5 |
| D5 | Precision | **1 decimal** (`ROUND(AVG(...), 1)`) | Google decimal-dot format; matches column style (§4.2) |
| D6 | `ratingCount` semantics | **Count of approved rated testimonials** (per-rating, not per-user) | Matches AVG numerator/denominator; distinct from `testimonialsCount` (§6.3) |
| D7 | Cache staleness | **Invalidate enriched cache on testimonial mutations** | Rating is user-visible/SEO-exposed; pre-existing 5-min lag unacceptable for it (§6.5) |
| D8 | Display algorithm | **Arithmetic mean** for v1 display | Industry standard for displayed ratings (Goodreads/Amazon); Bayesian only when ranking matters (§5.3) |
| D9 | Explore filter model | **Minimum-threshold ladder** (`rating >= X` / `rating <= X` + `minRatingCount`) | Decimals make exact per-star buckets undefined; "X★ & up" is the Amazon/Letterboxd/Yelp idiom; a single "4+" binary is too narrow (§7.7) |
| D10 | `books_rating_idx` timing | **Add now, with the filter** | One-time migration that accelerates both the threshold filter and the future §9 sort; shipping a filter that scans is the worse trade-off (§7.7, Q7) |

---

## 11. Open questions

| # | Question | Recommendation | Notes |
|---|---|---|---|
| Q1 | Should `rating_count` be `NULL` or `0` when a book has no approved rated testimonials? | **`NULL` (implemented)** | Keeps `rating`/`ratingCount` null-invariant (both null or both set). If frontend prefers `0`, render a fallback client-side (`ratingCount ?? 0`) rather than changing the column semantics. |
| Q2 | When should `AggregateRating` JSON-LD be emitted on the book detail page? | **Only when `ratingCount >= 1` (i.e. `rating` is non-null)** | Google requires `ratingValue`; emitting for a NULL rating would be empty markup. Render only approved testimonials on the page so the markup reflects visible content (§4.3.1). |
| Q3 | Should `rating` count per-reader or per-rating? | **Per-rating (implemented, D6)** | Currently a user can submit multiple testimonials for the same book. If "one rating per reader" is wanted, add a `(userId, bookId)` unique constraint + dedupe backfill — a product decision, not a schema bug (§6.4). |
| Q4 | Is the raw `AVG` display acceptable, or should a Bayesian/weighted score be shown once ratings accumulate? | **Keep raw `AVG` for display; add Bayesian only for "top-rated" ranking (§9)** | IMDb uses a weighted formula specifically for rankings. Displaying it would confuse users comparing against Goodreads/Amazon-style means. |
| Q5 | Should a minimum `ratingCount` gate the public rating display (e.g. hide until 3 ratings)? | **Defer; frontend/product decision** | Google's guidance discourages 1-rating aggregates ("by many people"). Backend already exposes the count; a visibility threshold is a UI rule, not a data rule. |
| Q6 | `rating` is stored as `real` (32-bit). Is 1-decimal precision safe? | **Yes** | `ROUND(AVG(rating)::numeric, 1)` produces at most 1 decimal, well within `real`'s ~7 significant digits for values 0–5. `real` matches `trendingScore`/`completionRate` style. |
| Q7 | Should `books_rating_idx` be added now? | **Yes (implemented, §7.7)** | Added with the explore rating filter rather than deferred: the partial index accelerates both the `rating >= X`/`<= X` threshold filter *and* the future §9 sort, and it's a one-time migration — no reason to ship a filter that scans in production. |
