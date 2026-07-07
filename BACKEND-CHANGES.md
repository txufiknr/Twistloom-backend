# Backend changes for the Ending Share feature

Precise, targeted additions — no existing files rewritten wholesale, since I don't have full current copies of wherever `userActivityLogs` writes/validation and the public book routes live.

---

## 1. New `activityType`: `'shared_ending'`

Wherever `userActivityLogs.activityType` is validated/typed (likely a string union or enum near the schema, or a constants file) — add `'shared_ending'` alongside whatever values already exist there. No schema migration; `activityType` is presumably already a flexible string column.

```ts
// wherever ActivityType (or similar) is defined
export type ActivityType =
  | /* ...existing values... */
  | 'shared_ending';
```

---

## 2. Share-logging endpoint (authenticated)

Called from the private debrief page when the reader clicks Share — this is what makes the completion publicly reachable at all (see `ending-share-uix-roadmap.md` §1.1 for why this consent step matters, not just analytics).

```ts
// books_routes.ts — new route, requires auth (reader must be logged in to have completed the book anyway)
router.post('/:identifier/:pageId/share', requireAuth, async (req, res) => {
  const { identifier: bookIdentifier, pageId } = req.params;
  const userId = req.user!.id;

  // Resolve the specific completion this share refers to
  const completion = await db.query.userCompletedBooks.findFirst({
    where: (t, { and, eq }) => and(
      eq(t.userId, userId),
      eq(t.pageId, pageId),
      // bookIdentifier may be a slug, not the raw bookId — resolve via
      // whatever helper visitBookPage already uses for identifier lookup
    ),
  });

  if (!completion) {
    return res.status(404).json({ error: 'No completion found for this page — cannot share an ending you have not reached.' });
  }

  await db.insert(userActivityLogs).values({
    userId,
    activityType: 'shared_ending',
    targetType: 'user_completed_book',
    targetId: completion.id,
    metadata: { bookId: completion.bookId, pageId, branchId: completion.branchId },
  });

  res.json({ success: true });
});
```

Every click logs a new row — not deduplicated. Each one is a real share event worth counting (§1.1's analytics point), and the *existence of at least one row* is what the public read endpoint checks for, not a specific count.

**`books-api.ts` addition** (matching your real conventions — `this.client.post()`, same shape as `confirmVisit`/`purchaseBook`):

```ts
/**
 * Logs a share event and (on the FIRST call for a given completion) makes
 * that completion publicly reachable via the ending share page. Every
 * subsequent call for the same completion just logs another share event —
 * this is intentionally not deduped, see BACKEND-CHANGES.md §2.
 */
async logEndingShare(identifier: string, pageId: string): Promise<{ success: boolean }> {
  return this.client.post<{ success: boolean }>(`/books/${identifier}/${pageId}/share`, {});
}
```

---

## 3. Public share-read endpoint (unauthenticated)

Deliberately thin — this must NOT return anything `EndingDebriefClient` fetches (contextHistory, outline, personal stats). Those belong to the reader alone; a stranger visiting a share link gets only what the marketing page actually shows.

```ts
// New route, no requireAuth — this is a public marketing surface
router.get('/share/:username/:bookSlug/:pageId', async (req, res) => {
  const { username, bookSlug, pageId } = req.params;

  const user = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.username, username) });
  if (!user) return res.status(404).json({ error: 'Not found' });

  const book = await db.query.books.findFirst({ where: (t, { eq }) => eq(t.slug, bookSlug) });
  if (!book) return res.status(404).json({ error: 'Not found' });

  // Gate 1: visibility — see ending-share-uix-roadmap.md §1.3
  if (book.visibility === 'private') return res.status(404).json({ error: 'Not found' });

  // Gate 2: did this completion actually happen
  const completion = await db.query.userCompletedBooks.findFirst({
    where: (t, { and, eq }) => and(eq(t.userId, user.id), eq(t.bookId, book.id), eq(t.pageId, pageId)),
  });
  if (!completion) return res.status(404).json({ error: 'Not found' });

  // Gate 3: consent — was this specific completion ever actually shared
  const shareLog = await db.query.userActivityLogs.findFirst({
    where: (t, { and, eq }) => and(eq(t.activityType, 'shared_ending'), eq(t.targetId, completion.id)),
  });
  if (!shareLog) return res.status(404).json({ error: 'Not found' });

  // Ending text/rarity — reuse computeEndingStats (story_service.ts), same
  // formula already built for the private debrief page. Only pulling the
  // two fields the public page actually shows.
  const endingStats = await computeEndingStats(book.id, pageId, user.id);
  const page = await getPageFromDB(pageId);

  res.json({
    sharer: { name: user.name, imageUrl: user.imageUrl },
    book: { title: book.title, hook: book.hook, slug: book.slug, imageUrl: book.imageUrl, readCount: book.stats?.readCount ?? 0 },
    ending: { text: page?.context?.ending?.text, percentage: endingStats.endingPercentage },
  });
});
```

Every field here is deliberately public-safe — nothing that would work as a spoiler, nothing personal to the sharer beyond what they explicitly agreed to expose by clicking Share.

---

## 4. Open Graph image

Handled entirely on the Next.js side (`opengraph-image.tsx` in the route folder) — no separate backend work beyond the read endpoint above, since the image generator calls that same endpoint for its data. See the frontend section for the actual file.
