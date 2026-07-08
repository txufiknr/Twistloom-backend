# Backend changes for the Ending Share feature

Precise, targeted specs — not full-file rewrites, since I don't have your actual route/controller files loaded for this specific feature (writing against the conventions confirmed in the reading-mode/ending-page work: Express routers, Drizzle `dbRead`/`dbWrite`, `requireAuth` middleware, `getErrorMessage`). Verify table/column names against your real schema before applying — a couple are inferred from context (e.g. `users.name`/`users.imageUrl`, `books.slug`) rather than freshly re-confirmed in this pass.

---

## 1. New `activityType` value

Wherever `userActivityLogs.activityType`'s allowed values are enumerated (a Postgres enum or a TS union type, matching the `bookVisibilities`/`bookStatuses`-style `as const` pattern used elsewhere in this schema), add:

```ts
'shared_ending'
```

No migration needed if it's a plain text column validated at the TS layer; a real `pgEnum` would need `ALTER TYPE ... ADD VALUE`.

---

## 2. Share-logging endpoint

Fire-and-forget from the frontend (`ShareOutcomeCard`'s click handler) — logs that a share happened, and doubles as the consent record the public page's gate checks (§3).

```ts
// books_routes.ts
router.post('/:identifier/:pageId/share', requireAuth, async (req, res) => {
  const { identifier: bookIdentifier, pageId } = req.params;
  const userId = req.user!.id;

  const book = await resolveBookByIdentifier(bookIdentifier); // however slug-or-uuid resolution already works elsewhere in this file
  if (!book) return res.status(404).json({ error: 'Book not found' });

  // Can't log a share for an ending this user never actually reached —
  // same completion record the ending debrief page already relies on.
  const [completion] = await dbRead
    .select({ id: userCompletedBooks.id })
    .from(userCompletedBooks)
    .where(and(
      eq(userCompletedBooks.userId, userId),
      eq(userCompletedBooks.bookId, book.id),
      eq(userCompletedBooks.pageId, pageId),
    ));

  if (!completion) return res.status(403).json({ error: 'No completion record for this ending' });

  await dbWrite.insert(userActivityLogs).values({
    userId,
    activityType: 'shared_ending',
    targetType: 'user_completed_book',
    targetId: completion.id,
    metadata: { bookId: book.id, pageId },
  });

  res.json({ success: true });
});
```

Deliberately **not** deduped — every click is a real event worth counting (`COUNT(*)` grouped by `targetId` gives "how many times has this specific ending been shared"; existence alone is the consent gate in §3).

---

## 3. Public read endpoint — the three-check gate

```ts
// books_routes.ts — public, unauthenticated
router.get('/share/:username/:bookSlug/:pageId', async (req, res) => {
  const { username, bookSlug, pageId } = req.params;

  const [sharer] = await dbRead
    .select({ id: users.id, name: users.name, imageUrl: users.imageUrl })
    .from(users)
    .where(eq(users.username, username));
  if (!sharer) return res.status(404).json({ error: 'Not found' });

  const [book] = await dbRead
    .select({ id: books.id, title: books.title, hook: books.hook, imageUrl: books.imageUrl, slug: books.slug, visibility: books.visibility, readCount: books.readCount })
    .from(books)
    .where(eq(books.slug, bookSlug));
  // Check 1 (§1.3 of the roadmap doc): private books never resolve here,
  // regardless of whether a completion/share exists — full stop, not a
  // conditional field hide.
  if (!book || book.visibility === 'private') return res.status(404).json({ error: 'Not found' });

  // Check 2: did this user actually reach this ending?
  const [completion] = await dbRead
    .select({ id: userCompletedBooks.id })
    .from(userCompletedBooks)
    .where(and(
      eq(userCompletedBooks.userId, sharer.id),
      eq(userCompletedBooks.bookId, book.id),
      eq(userCompletedBooks.pageId, pageId),
    ));
  if (!completion) return res.status(404).json({ error: 'Not found' });

  // Check 3 — THE consent gate: completing an ending is automatic;
  // this page existing publicly is not. No 'shared_ending' log row for
  // this specific completion means the reader never opted in, and this
  // must 404 exactly the same as a malformed URL would — not a
  // different error that would confirm the completion exists but is
  // merely "not shared yet" (that distinction itself would leak
  // information the reader didn't consent to leak).
  const [sharedLog] = await dbRead
    .select({ id: userActivityLogs.id })
    .from(userActivityLogs)
    .where(and(
      eq(userActivityLogs.activityType, 'shared_ending'),
      eq(userActivityLogs.targetId, completion.id),
    ))
    .limit(1);
  if (!sharedLog) return res.status(404).json({ error: 'Not found' });

  const [page] = await dbRead
    .select({ context: pages.context })
    .from(pages)
    .where(eq(pages.id, pageId));

  const endingStats = await computeEndingStats(book.id, pageId, sharer.id);

  // Deliberately thin — no contextHistory, no outline, no personal
  // reader stats. Nothing here that isn't already on the public share
  // page's content plan (roadmap doc §3).
  res.json({
    sharer: { name: sharer.name, imageUrl: sharer.imageUrl },
    book: { title: book.title, hook: book.hook, imageUrl: book.imageUrl, slug: book.slug, readCount: book.readCount },
    ending: { text: page?.context?.ending?.text ?? null, percentage: endingStats.endingPercentage },
  });
});
```

Note the 404-not-403 choice on check 3 deliberately: if an unshared completion returned a *different* error than a nonexistent one, that difference itself would tell a probing visitor "this completion exists, it just isn't shared" — which is exactly the information the consent gate exists to withhold. Same response either way.

`computeEndingStats(bookId, pageId, sharer.id)` reuses the function built for the reading-mode/ending-page work as-is — the `userId` param only affects the (here-unused) reading-time calculation, so passing the sharer's id is harmless; `endingPercentage` is global to the ending, not per-viewer.

---

## 4. Frontend `BooksApi` addition

Same shape as `confirmVisit` (reading-mode work) — fire-and-forget, `this.client.post()`. Named `logEndingShare` (not `logShare`) to match what `ShareOutcomeCard.tsx` actually calls:

```ts
async logEndingShare(identifier: string, pageId: string): Promise<{ success: boolean }> {
  return this.client.post<{ success: boolean }>(`/books/${identifier}/${pageId}/share`, {});
}
```

Public read is a plain unauthenticated `GET`, no `BooksApi` method needed on the reader-facing client necessarily — the public share page can call it directly or through a small dedicated fetch, since it's a different, unauthenticated surface (see frontend `useSharedEndingPage` hook).
