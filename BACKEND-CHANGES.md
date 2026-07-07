# Backend changes for the Ending page

Precise, targeted edits — not full-file rewrites, since `book.ts`/`book-controller.ts`/`story_service.ts` are large files I only have partial visibility into (and `types/story.ts` wasn't shared at all). Apply these by hand rather than pasting whole files over yours.

---

## 1. Expose `ending` on the page context

### `types/story.ts` (not shared, editing blind — locate `EnrichedStoryPageContext`)

Add one field, mirroring how `plotFlags` is already declared there:

```ts
export type EnrichedStoryPageContext = {
  // ...existing fields (phase, injuries, inventory, contextHistory, actionsHistory, plotFlags, threads, places, characters)
  ending?: Ending; // NEW — singular, mirrors StoryState.viableEnding
};
```

### `book.ts` — `mapToEnrichedPage`, ~line 1351

```ts
// Before:
const { places, characters, injuries, inventory, contextHistory, actionsHistory, plotFlags, threads } = storyState;
// ...
context = {
  phase,
  injuries,
  inventory,
  contextHistory,
  actionsHistory,
  plotFlags,
  threads: activeThreads,
  places: /* ... */,
  characters: /* ... */,
} satisfies Record<keyof EnrichedStoryPageContext, unknown>;

// After — add viableEnding to the destructure and ending to the object:
const { places, characters, injuries, inventory, contextHistory, actionsHistory, plotFlags, threads, viableEnding } = storyState;
// ...
context = {
  phase,
  injuries,
  inventory,
  contextHistory,
  actionsHistory,
  plotFlags,
  threads: activeThreads,
  places: /* ... */,
  characters: /* ... */,
  ending: viableEnding, // NEW
} satisfies Record<keyof EnrichedStoryPageContext, unknown>;
```

Consider gating this to only populate on the actual ending page (`dbPage.page >= book.totalPages`) rather than every page — `viableEnding` is presumably the *currently projected* ending, which could read as a spoiler if shown on earlier pages. Not enforced here since I don't know how `viableEnding` behaves mid-story (whether it's stable/spoiler-free by design) — worth a quick check before shipping this unconditionally.

---

## 2. `insertUserCompletedBook` — RESOLVED, already correct

Superseded — you've already redesigned this correctly (append-only, `unique(userId, bookId, pageId)`, `onConflictDoNothing`), which is a better design than what I'd proposed here (I'd suggested `onConflictDoUpdate` on `(userId, bookId)`, assuming single-latest-ending tracking was intentional — it wasn't, and your append-only redesign is the right call: it's the only shape that supports "you've discovered N endings," which matters given `CHOOSE_OTHER_ACTION` means replay-to-a-different-ending is a real, actively-supported path in this product). Verified against your current `book_service.ts` — target now correctly matches the real 3-column constraint. No further action here.

Also verified `update_book_complete_count()` (`triggers.ts`) is already correct: it recomputes `complete_count = COUNT(DISTINCT user_id) FROM user_completed_books WHERE book_id = NEW.book_id` from scratch on every insert, so a user discovering multiple endings for the same book can't inflate the count — `books.complete_count` is trustworthy as `completedReaders` for the formula below.

---

## 3. Ending stats — RESOLVED, you've implemented it — one real bug found + wiring still needed

`computeEndingStats` now exists in `story_service.ts` and is correctly close to the formula we settled on (`countDistinct`, Option 2). Two things:

### 3a. Bug: reading-time query is missing a `userId` filter

```ts
// Current (story_service.ts, ~line 1021):
const [{ minTs, maxTs }] = await client
  .select({ minTs: sql<Date>`min(${userPageProgress.createdAt})`, maxTs: sql<Date>`max(${userPageProgress.createdAt})` })
  .from(userPageProgress)
  .where(and(eq(userPageProgress.bookId, bookId)));
```

This filters by `bookId` only — it computes the min/max timestamp across **every reader** who's ever made progress on this book, not the specific reader who just finished. For any book that's been live more than a few hours, this returns a nonsense "reading time" (potentially days or weeks). Needs a `userId` parameter added to the function and threaded into the `where`:

```ts
export async function computeEndingStats(
  bookId: string,
  pageId: string,
  userId: string, // NEW
  client: DBClient = dbRead
): Promise<BookEndingStats> {
  // ...completedReaders / endingReaders / endingPercentage unchanged...

  const [{ minTs, maxTs }] = await client
    .select({ minTs: sql<Date>`min(${userPageProgress.createdAt})`, maxTs: sql<Date>`max(${userPageProgress.createdAt})` })
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.bookId, bookId),
      eq(userPageProgress.userId, userId), // NEW
    ));

  // ...unchanged...
}
```

### 3b. Not called anywhere yet — wire into `markPageVisitedWithClient`

Right after the existing completion insert (story_service.ts, ~line 348):

```ts
// Insert completion record if user reached the last page
if (pageNumber === totalPages) {
  const completion = await insertUserCompletedBook(userId, bookId, pageId, branchId, client);
  if (completion) {
    console.log(`[markPageVisited] 🎉 User ${userId} completed book ${bookId} (page ${pageNumber}/${totalPages})`);
  }
}

// NEW — compute ending stats whenever this is the terminal page, whether
// or not `completion` was a fresh insert (onConflictDoNothing means a
// replay of the same ending returns null but the stats query itself is
// idempotent — still worth returning for the Ending Debrief page, which
// re-fetches this on every visit, not just the moment of first completion).
const endingStats = pageNumber === totalPages
  ? await computeEndingStats(bookId, pageId, userId, client)
  : undefined;

return { session, nthVisit, visitorPercentage, readerUserId: userId, endingStats };
```

`BookPageVisit` (book_types.ts) needs the new field:

```ts
export type BookPageVisit = {
  session?: DBUserSession | null;
  nthVisit: number;
  visitorPercentage: number;
  readerUserId?: string;
  endingStats?: BookEndingStats; // NEW
}
```

This is deliberately attached to `visitDetails` (what `markPageVisited`/`visitBookPage` actually return), not `page.context` — I'd originally sketched it as `context.endingStats` before seeing your real implementation, but `endingStats` is a byproduct of the *visit* being recorded, not part of the page's narrative context, so `visitDetails.endingStats` is the more accurate home for it. The frontend type (`GetBookPageResponse['visitDetails']`) needs the same field added — that type lives in `@/lib/types/api/book`, which I don't have; add `endingStats?: EndingStats` there matching `BookEndingStats`'s shape.

### 3c. Ending Debrief page needs `actioning: true` explicitly, always

Unlike the main reader (which only sends `actioning=true` when `selectedActions.length === 0`, since re-visiting a page you've already actioned shouldn't re-trigger `markPageVisited`), the ending page has no actions at all — `selectedActions.length === 0` is permanently true there, so that heuristic doesn't apply. `EndingDebriefClient` should unconditionally request `actioning: true` on its own `usePage` call: visiting that route is inherently a deliberate, real visit, and `insertUserCompletedBook`'s conflict handling makes re-confirming an already-recorded completion harmless (no duplicate rows, `computeEndingStats` just recomputes fresh).

---

## 3a. Completion rate — hidden, owner-only, add to schema + triggers now

Per your direction: not shown to public readers, but worth precomputing since it's cheap to maintain alongside `complete_count`. Schema addition (`schema.ts`, `books` table, alongside `completeCount`):

```ts
completionRate: integer("completion_rate"), // 0-100, NULL until the book has any readers. Owner-facing only — never exposed on the public ending page.
```

Since `completionRate` depends on BOTH `completeCount` (updated by `user_completed_books` inserts) and `readCount` (updated by `user_sessions` inserts), it needs recomputing from whichever trigger fires — each one reads the OTHER counter's current value off the same row it's updating:

```sql
-- In update_book_complete_count() (triggers.ts, ~line 470) — add after the complete_count UPDATE:
CREATE OR REPLACE FUNCTION update_book_complete_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE books
  SET complete_count = (
        SELECT COUNT(DISTINCT user_id) FROM user_completed_books WHERE book_id = NEW.book_id
      ),
      completion_rate = CASE WHEN read_count > 0 THEN
        ROUND((SELECT COUNT(DISTINCT user_id) FROM user_completed_books WHERE book_id = NEW.book_id)::numeric / read_count * 100)
        ELSE NULL END,
      updated_at = NOW()
  WHERE id = NEW.book_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- In update_book_read_count() (triggers.ts, ~line 144) — add after the read_count UPDATE:
CREATE OR REPLACE FUNCTION update_book_read_count()
RETURNS TRIGGER AS $$
DECLARE
  v_page_1_id UUID;
BEGIN
  UPDATE books
  SET read_count = (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id),
      completion_rate = CASE WHEN (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id) > 0 THEN
        ROUND(complete_count::numeric / (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id) * 100)
        ELSE NULL END,
      trending_score = trending_score + 0.5,
      updated_at = NOW()
  WHERE id = NEW.book_id;
  -- ...(page 1 visit_count block unchanged)
END;
$$ LANGUAGE plpgsql;
```

`NULL` (not `0`) when `read_count = 0` — no readers yet means "no rate to show," not "0% completion," which would misleadingly suggest the book has failed everyone who read it.

Not wiring this into any API response — it's explicitly not for the public ending page. Whenever you build an author-facing analytics view, `books.completion_rate` is just sitting there ready to read.


### Addendum: reading time (optional)

Not implemented — `EndingStats.readingTimeMinutes` is optional in the frontend type specifically because this doesn't exist yet. Approximate from `userPageProgress` timestamps if you want it:

```ts
const [{ minTs, maxTs }] = await client
  .select({
    minTs: sql<Date>`min(${userPageProgress.createdAt})`,
    maxTs: sql<Date>`max(${userPageProgress.createdAt})`,
  })
  .from(userPageProgress)
  .where(and(eq(userPageProgress.userId, userId), eq(userPageProgress.bookId, bookId)));

const readingTimeMinutes = minTs && maxTs
  ? Math.max(1, Math.round((maxTs.getTime() - minTs.getTime()) / 60000))
  : undefined;
```

Caveat worth knowing before shipping this: it measures wall-clock time between first and last action, not actual reading attention — a reader who left the tab open overnight between choices would get a wildly inflated number. Reasonable as a rough "time invested" stat, not as anything more precise.

---

## 5. Response shape note

I've assumed `context.endingStats` and `context.ending` both live on the same enriched page response the reader already fetches (`GetBookPageResponse`/`EnrichedStoryPage`), so the Ending page's client component can just call the existing `usePage(pageId, bookId)` hook rather than needing a new endpoint. If you'd rather keep ending-specific data off the hot path (every page fetch) and only compute it for the actual terminal page, a dedicated `GET /api/books/:id/:pageId/ending` endpoint is the alternative — the frontend `EndingDebriefClient` below is written against the `usePage` assumption; swapping to a dedicated endpoint would mean changing its one data-fetching hook, not its structure.


---

## 4. Confirm-visit endpoint (fixes the navigation-persistence Known Issue)

Escalating this from "ship when convenient" to "needed for the ending page to be trustworthy," per the finding above: `visitBookPage` only calls `markPageVisited` (and therefore `insertUserCompletedBook`) when `isUserTakeAction` is true. The frontend's instant-nav path never sends that. A reader finishing the book via a cached/prefetched final page — plausible by page 40+ of a session — would never get counted.

New lightweight route, reusing `visitBookPage`/`markPageVisited` exactly as they exist today — no new business logic, just a thin entry point:

```ts
// books_routes.ts — new route
router.post('/:identifier/:pageId/confirm-visit', requireAuth, async (req, res) => {
  const { identifier: bookIdentifier, pageId } = req.params;
  const { actionedPageId, consumeCredits } = req.body as { actionedPageId?: string; consumeCredits?: boolean };
  const userId = req.user!.id;

  const { visitDetails, dbPage, book } = await visitBookPage(
    { userId, pageId, bookIdentifier, skipVisit: false, takeAction: true, consumeCredits: !!consumeCredits, language: req.headers['accept-language'] },
    { req, res }
  );
  if (!dbPage || !book) return; // visitBookPage already sent the error response

  res.json({ visitDetails });
});
```

**Frontend: now wired, using your actual `BooksApi` conventions** (`this.client.post<T>(url, body)`, matching `purchaseBook`/`revealActionHint`). Add to `books-api.ts`:

```ts
/**
 * Confirms a page visit server-side when the UI already served it from
 * cache (instant navigation) — see StoryActionButton.tsx's confirmVisit
 * call site. Fire-and-forget from the caller's side; this method itself
 * still returns the visit result in case a future caller wants it.
 *
 * @param identifier - Book slug or UUID v7
 * @param pageId - The page actually being visited (the destination, not the page the action was chosen from)
 * @param body.actionedPageId - The page the action was chosen FROM
 * @param body.consumeCredits - Whether this is a paid CHOOSE_OTHER_ACTION reselection
 */
async confirmVisit(identifier: string, pageId: string, body: { actionedPageId?: string; consumeCredits?: boolean }): Promise<{ visitDetails?: GetBookPageResponse['visitDetails'] }> {
  return this.client.post<{ visitDetails?: GetBookPageResponse['visitDetails'] }>(
    `/books/${identifier}/${pageId}/confirm-visit`,
    body
  );
}
```

`StoryActionButton.tsx` already calls `booksApi.confirmVisit(...)` at the cached-navigation branch (fire-and-forget) — see that file's `confirmVisit` helper. Once this method + the route above both exist, that call site works with no further frontend changes.
