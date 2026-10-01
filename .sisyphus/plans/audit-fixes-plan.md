# Code-Review Audit Fixes — Assessment & Execution Plan

Source: 25-file uncommitted-change audit. Store-domain findings (§1.1 App Store bundle ID, §5.1 `verifyConsumable` JWS DRY) **excluded by user instruction**. Store test files (`store-verification.test.ts`, `test-cron-sweep-custom-actions.test.ts`) are **not touched** (store workstream; their mock leak is benign — no later test consumes `db/client`).

## Verdicts

| # | Claim | Verdict | Resolution |
|---|---|---|---|
| 1.2 | Stale `Cache-Control`/payload on detail gate | **REAL** (impact overstated: gate denies non-owners already; `private` keeps it out of shared caches — but violates invariant 3 + stale `status`/`visibility` for authorized clients ≤5min) | Fix A |
| 2.1 | Missing migration for partial unique index | **REAL** (`schema.ts:1609` in this diff; `drizzle/` ends at 0104, no match; row lock serializes but `ON CONFLICT` never fires without the index → double-grant window) | Human-gated (user runs `db:generate`) |
| 3.1 | Admin mutations read from `dbRead` | **REAL** (`admin.ts:376,412,508,778,938,1049,1065,1114,1964,1980,2255,2611,2700,2794,3032,3845,3855,3875` + `trust-safety.ts:334`) | Fix B (+C for 2700) |
| 3.2 | Non-atomic SELECT→UPDATE takedown | **REAL, low** — collapses into Fix C | Fix C |
| 4.1 | N+1 explore SCAN in ban loop | **REAL** (per public+active book = full `deleteCachePattern` SCAN; `cache.ts:199-223`) | Fix C |
| 4.2 | Double SELECT in `updateBook` | **REAL but negligible** — user decision: document + plan future `options.current`, survey callers now | Fix G (docs only) |
| 5.2 | No forum sync on `hide_books` | **REAL** (portal `handleUserBanned` only sets `is_banned`; feeds never filter banned authors — `threads.ts:92,238` — so banned books' threads stay listed) | Fix C |
| 5.3 | Asymmetric gates, snapshot discarded | **REAL — root cause of 1.2** | Fix A |
| 5.4 | `awardFirstPurchaseBonusOnce` inconsistency | **REAL in principle, dead code today** (`FIRST_PURCHASE_BONUS = 50` constant → `<= 0` unreachable; `?? 0` only fires if user row missing mid-purchase) | Fix F (1-liner hygiene) |
| 6.1 | `mock.module` leaks across tests | **REAL (latent; suite green by luck)** — only `test-cron-sweep` restores `db/client`; `auth-signup-pair`/`auth-username-available` install complete factories with no `actual` capture | Fix D |
| 6.2 | `not in` inverted in fake `evalSql` | **REAL but fully latent** (`notInArray` used only in `src/scripts/realign-achievements.ts`, zero tests) — shared helper, not store logic | Fix E |
| 4.2 aside | Keep `admin.ts:1789` (announcement fan-out) on `dbRead` | Deliberate: bulk read of all users must not hit primary; second-stale opt-out prefs acceptable | Comment only (Fix B) |

User decisions: **full admin.ts read-then-write sweep** · **4.2 = document & future-work, caller survey now** · **user runs `db:generate`**.

---

## Fix A — Detail gate: snapshot-driven header + payload (1.2 + 5.3)

**`src/services/book-page-access.ts`**
1. Change `getBookDetailAccessError(c, bookId, userId): Promise<Response | null>` → **sync** `getBookDetailAccessError(c, book: BookAccessFields, userId): Response | null` — mirrors `getBookPageAccessError`, removes the buried `getBookAccessSnapshot` call (the `!snapshot → 404` moves to the route).
2. Add exported SSOT helper:
   ```ts
   export function bookDetailCacheControl(book: BookAccessFields): string {
     if (isRestrictedToOwner(book)) return "private, no-store";
     if (book.status === "active") return "private, max-age=300, stale-while-revalidate=150";
     return "private, no-cache";
   }
   ```
3. Update file header + function JSDoc (`@see` doc §4.1-§4.3 anchors unchanged).

**`src/routes/books.ts` `GET /:identifier` (:9327-9376)**
```ts
const enrichedBook = await getEnrichedBook(bookIdentifier, userId, headerLanguage);
if (!enrichedBook) return cNotFoundError(c, "Book not found");
const snapshot = await getBookAccessSnapshot(enrichedBook.id);
if (!snapshot) return cNotFoundError(c, "Book not found");
const accessError = getBookDetailAccessError(c, snapshot, c.get("userId"));
if (accessError) { accessError.headers.set("Cache-Control", "no-store"); return accessError; }
// ETag/304 + Last-Modified unchanged (updatedAt staleness = accepted residual, doc §10)
c.header("Cache-Control", bookDetailCacheControl(snapshot));
return c.json({ book: { ...enrichedBook, status: snapshot.status, visibility: snapshot.visibility } });
```
- Import `getBookAccessSnapshot` + `bookDetailCacheControl` (line :142).
- Spread-copy the response (never mutate the shared LRU entry). No `as` casts — `BookAccessFields = Pick<EnrichedBookData, ...>` makes the override type-safe.
- Update the :9335-9340 comment: header + policy fields now snapshot-keyed.
- Query count unchanged (gate already fetched the snapshot internally).

## Fix B — Full admin.ts `dbRead` → `dbWrite` sweep (3.1)

Switch to `dbWrite` (all single-row guard/read-before-write reads, cheap on primary):
`admin.ts` lines **376, 412, 508, 778, 938, 1049, 1065, 1114, 1964, 1980 (read-back-after-write), 2255, 2611, 2794, 3032, 3845, 3855, 3875**; plus **`trust-safety.ts:334`** `getActiveEnforcementsForUser` (feeds unban revocation — stale replica read can skip revoking the ledger row → SSOT drift).
- Line **2700** is *replaced* by Fix C (not a swap).
- **Keep `dbRead`**: all pure GET/listing reads, and **line 1789** (`POST /email/announcements` bulk recipient fan-out) — add a short comment there: bulk read deliberately on replica.
- Verify imports: `trust-safety.ts` already imports both clients (`import { dbRead, dbWrite }`).

## Fix C — Ban takedown: atomic + N+1 + forum sync (3.2 + 4.1 + 5.2)

Replace `admin.ts:2697-2732` hide-books block:
```ts
if (settings["ban.hide_books"] === true) {
  // Single atomic UPDATE ... RETURNING (AGENTS.md §3.9): one primary statement
  // replaces the replica-lag SELECT + read→update gap.
  const affected = await dbWrite
    .update(books)
    .set({ visibility: "private", updatedAt: new Date() })
    .where(and(eq(books.userId, userId), ne(books.visibility, "private")))
    .returning({ id: books.id, slug: books.slug, status: books.status, visibility: books.visibility });

  for (const book of affected) {
    invalidateBookCache(book.id);
    invalidateEnrichedBookCache(book.id);
    if (book.slug) invalidateEnrichedBookCache(book.slug);
    // Portal thread (if any) must leave the feed with the hidden book; the
    // consumer is idempotent (queue key `story.archived:<id>`) and no-ops
    // when no thread exists.
    notifyForumStoryArchived(book.id, book.slug);
  }
  if (affected.some((book) => book.status === "active")) {
    // ONE pattern wipe for all Explore page-1 sort slots (not k scans).
    // Conservative: counts active+unlisted too — an unnecessary wipe costs
    // only a cache miss.
    await invalidateExploreCache();
  }
  if (affected.length > 0) await invalidateUserBooksCache(userId);
  appliedTakedowns.push("hide_books");
  console.log(/* unchanged */);
}
```
- Add `notifyForumStoryArchived` to the `forum-queue` import in `admin.ts`.
- Behavior deltas (intentional): explore wipe hoisted to ≤1 call; forum archive events fire for every affected book (unpublished/no-thread → portal no-op).

## Fix D — Test mock hygiene (6.1)

Pattern per file (Bun: `mock.module` is process-global; `mock.restore()` does NOT revert modules):
```ts
const actualDbClient = await import("../src/db/client.js"); // BEFORE mock.module
mock.module("../src/db/client.js", () => ({ ...actualDbClient, /* fakes */ }));
afterAll(() => { mock.module("../src/db/client.js", () => actualDbClient); });
```
- **Capture-actual + afterAll-restore** in: `admin-moderation.test.ts` (restore *all* 5-6 mocked modules: db/client, book, cache, forum-queue, trust-safety), `book-access-gate.test.ts` (db/client, book, story), `book-page-access.test.ts` (db/client + others), `auth-username-available.test.ts` (currently complete factory — capture first; keep existing `mock.restore()`), `auth-signup-pair.test.ts` (capture db/client before L70; extend existing afterAll at :187), `mobile-oauth-issuance.test.ts` (capture + restore).
- Chain soundness: alphabetical order `admin-moderation → auth-signup-pair → auth-username-available → … → book-* → … → mobile-oauth` each restoring real, so every capture sees the true module.
- Add a one-paragraph rule to the `tests/helpers/store-verification-db.ts` file header documenting the pattern.

## Fix E — Fake DB: `not in` + `update().returning()` (6.2 + required by Fix C)

`tests/helpers/store-verification-db.ts`:
1. `evalSql` (~L123): test `/\bnot\s+in\b/` **before** `/\bin\b/`, returning the negation (extract the shared `list` computation first).
2. `updateChain` (~L316): add `returning: () => chain`; in `then`, for each matched row apply the patch then push a post-update copy into a result array and `resolve(result)` (drizzle projection arg ignored — full row is a superset; current `resolve([])` breaks Fix C's `.returning()`).
   - In-place mutation is fine here (ban flow captures no before-snapshot; the PATCH-books before-snapshot flows through the *mocked* `updateBook`, not this chain).

## Fix F — `awardFirstPurchaseBonusOnce` consistency (5.4)

`src/services/credits.ts:1041-1048`:
```ts
if (creditsAmount <= 0) {
  const [current] = await tx.select({ credits: users.credits }).from(users)
    .where(eq(users.userId, userId)).limit(1);
  if (!current) throw new Error('User not found'); // never fabricate balance 0 (AGENTS.md §3.11)
  return { inserted: false, balance: current.credits };
}
```

## Fix G — Documentation (2.1 hand-off + 4.2 future work + doc sync)

1. **`docs/architecture/BOOK_ACCESS_AND_MODERATION_ARCHITECTURE.md`**
   - §4.1: gate now takes `BookAccessFields` (symmetry with page gate), route fetches snapshot.
   - §4.3: cache-header row → `bookDetailCacheControl(snapshot)` SSOT; mechanism + line refs (`books.ts` lines shift after edit).
   - Invariant 3 (L98): "computed from the authoritative snapshot" + refreshed citations.
   - §4.4: note `existing` read moved to `dbWrite`.
   - §4.5: rewrite mechanism — single `UPDATE ... RETURNING`, ≤1 explore wipe, `notifyForumStoryArchived` per affected book, primary reads.
   - Failure matrix: add "stale cache header on moderated detail" (now impossible) + "ban misses books via replica lag" (closed).
   - §10 gap inventory: **(a)** admin `PATCH /books/:id` double-SELECT → future `options.current`; **(b)** announcement fan-out deliberately `dbRead`.
   - Evidence section: refresh line refs.
2. **`TODO.md`**: entry — *"Implement `options.current` in `updateBook` (audit §4.2)"* with the caller survey below + regression checklist:
   - Callers (14): `admin.ts:2277` (route already selects — primary candidate), `books.ts:1885,1989,2001,2200(tx),2336(tx),2509,2573,2629`, `book.ts:1333`, `pen.ts:548,2926`, `utils/prompt.ts:4841`.
   - When implemented: optional param honored only when caller fetched `{visibility,status,isOriginal,userId,slug,title}` by PK on the same client; all other callers keep the internal fetch — zero behavior change. Regression focus: `needsCurrent` gate, slug auto-assign on first publish, custom-slug validation, publish notification, `isOriginal` consumers; run full suite.
3. **Migration hand-off (2.1) — user executes:**
   1. Dedup check: `SELECT user_id, count(*) FROM transactions WHERE type = 'first_purchase_bonus' GROUP BY 1 HAVING count(*) > 1;`
   2. If rows → dedup `DELETE ... ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at)` keeping the oldest.
   3. `bun db:generate` (review `drizzle/0105_*.sql` — `CREATE UNIQUE INDEX ... WHERE type = 'first_purchase_bonus'`).
   4. `bun db:migrate` in staging → prod.

## Fix H — Tests

1. `tests/book-access-gate.test.ts`
   - Update `detailAccess` helper to snapshot-then-gate (new signature).
   - Unit tests for `bookDetailCacheControl` (restricted → `private, no-store`; active → max-age 300; other → `private, no-cache`).
   - **Regression for 1.2**: mount the real `GET /:identifier` from `routes/books.js` (mock `optionalAuth` from `middleware/nextauth.js` to pass-through; `getEnrichedBook` already mocked to the stale public projection; primary seeded private) asserting: owner → 200 + `Cache-Control: private, no-store` + body `book.visibility === "private"`; anonymous → 404 + `no-store`. If the books router import proves side-effect-heavy, fall back to gate+helper unit assertions and note it in the doc evidence table.
2. `tests/admin-moderation.test.ts`
   - `invalidateExploreCacheMock` expected calls: **2 → 1** (no-arg wipe; seeds contain an active book).
   - Add `notifyForumStoryArchived` to the forum mock module; assert called for `b-public` + `b-unlisted` with slugs, **not** for `b-private`; add `.not.toHaveBeenCalled()` to the "hide_books not configured" test.
   - Sweep swaps (dbRead→dbWrite) are transparent: both map to the same fake store.
3. Full suite must stay green; watch for any store test asserting `update().returning()` → `[]` (none known).

## Verification (after all edits)

1. `bun run check` (eslint + import-extensions + `tsc --noEmit`) — 0 problems.
2. `bun test` — all pass (baseline 295 + new).
3. Grep doc citations: `BOOK_ACCESS_AND_MODERATION_ARCHITECTURE.md §` in `src/` still resolves (3 `@see` sites); refresh any `books.ts` line numbers cited inside the doc.
4. No `Twistloom-web` changes → no web typecheck needed.

## Out of scope / deferred

- Store findings §1.1, §5.1 (+ store test files).
- §4.2 `options.current` implementation (documented, caller surveyed — Fix G).
- `admin.ts:1789` announcement fan-out stays `dbRead` (documented).
- Residual accepted: detail ETag/`Last-Modified` from stale-LRU `updatedAt`, stale non-policy display fields ≤5min (doc §10).
