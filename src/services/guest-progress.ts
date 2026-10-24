import { and, eq, inArray, sql } from 'drizzle-orm';
import { dbWrite } from '../db/client.js';
import { pages, userPageProgress, userSessions } from '../db/schema.js';
import { type canonicalGuestActions, canonicalGuestProgress, guestImportConflict, guestImportFingerprint, parseGuestProgressImport, resolveGuestImport } from '../utils/guest-progress.js';
import type { GuestProgressAcknowledgement } from '../utils/guest-progress.js';

/** All import/reset invalidations advance even millisecond wire preconditions. */
export const guestImportMutationTime = sql`greatest(clock_timestamp(), ${userSessions.updatedAt} + interval '1 millisecond')`;

type GuestProgressTransaction = Parameters<Parameters<typeof dbWrite.transaction>[0]>[0];
type CanonicalGuestAction = ReturnType<typeof canonicalGuestActions>[number];

/** Shared bounded batch upsert for canonical imported choices. */
async function upsertGuestActions(
  tx: GuestProgressTransaction,
  userId: string,
  bookId: string,
  actions: CanonicalGuestAction[],
): Promise<void> {
  if (actions.length === 0) return;
  await tx.insert(userPageProgress).values(actions.map((edge) => ({
    userId,
    bookId,
    actionedPageId: edge.actionedPageId,
    nextPageId: edge.nextPageId,
    action: edge.action,
  }))).onConflictDoUpdate({
    target: [userPageProgress.userId, userPageProgress.bookId, userPageProgress.actionedPageId],
    set: { nextPageId: sql`excluded.next_page_id`, action: sql`excluded.action`, updatedAt: new Date() },
  });
}

/** One existing session row owns consent, the latest import marker and actions.
 * No receipt table, historical result JSON or advisory lock is needed. */
export async function importGuestProgress(userId: string, bookId: string, body: unknown) {
  let input: ReturnType<typeof parseGuestProgressImport>;
  try {
    input = parseGuestProgressImport(body);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid guest progress' };
  }
  const hash = await guestImportFingerprint(input);
  const owner = and(eq(userSessions.userId, userId), eq(userSessions.bookId, bookId));
  return dbWrite.transaction(async (tx) => {
    const [current] = await tx.select().from(userSessions).where(owner).for('update');
    const resolved = resolveGuestImport(input, hash, current);
    if (resolved) return resolved;

    const ids = [...new Set([
      ...input.pageIds, input.session.pageId, input.session.frontierPageId,
      ...input.actions.flatMap((a) => [a.actionedPageId, a.nextPageId]),
    ])];
    const rows = await tx.select({
      id: pages.id, parentId: pages.parentId, bookId: pages.bookId, page: pages.page, actions: pages.actions,
    }).from(pages).where(and(eq(pages.bookId, bookId), inArray(pages.id, ids)));
    let canonical: ReturnType<typeof canonicalGuestProgress>;
    try {
      canonical = canonicalGuestProgress(input, rows, bookId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Invalid guest path' };
    }
    const next = { ...canonical.session, lastGuestImportId: input.operationId, lastGuestImportHash: hash,
      previousPageId: null, status: 'active' as const };
    if (current) {
      // The row lock keeps the consent snapshot stable until commit. Ensure
      // Ensure the expected-session timestamp always advances after import.
      await tx.update(userSessions).set({ ...next,
        updatedAt: guestImportMutationTime,
      }).where(owner);
    } else {
      // FOR UPDATE cannot lock an absent row. The existing unique key owns the
      // race; a duplicate winner is checked again, never overwritten.
      const inserted = await tx.insert(userSessions).values({ userId, bookId, ...next })
        .onConflictDoNothing().returning({ id: userSessions.id });
      if (inserted.length === 0) {
        const [winner] = await tx.select().from(userSessions).where(owner).for('update');
        return resolveGuestImport(input, hash, winner) ?? guestImportConflict(input);
      }
    }
    await upsertGuestActions(tx, userId, bookId, canonical.actions);
    const acknowledgement: GuestProgressAcknowledgement = {
      importVersion: input.importVersion, operationId: input.operationId,
      sessionApplied: true, alreadyApplied: false, actionsImported: canonical.actions.length, session: canonical.session,
    };
    return acknowledgement;
  });
}
