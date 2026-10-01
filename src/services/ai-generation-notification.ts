/**
 * AI Generation Outcome Notification Service (F-8)
 *
 * Persists a `user_notifications` row when an AI story generation reaches a
 * terminal state (`completed` / `failed`), so the in-app notification center
 * (`GET /api/notifications` — web bell feed and Flutter inbox) keeps a durable
 * record even when the reader closes the tab mid-generation. Before this module
 * the only write paths were `bookGenerations` + the failure refund, which made
 * generation outcomes completely ephemeral and tab-bound.
 *
 * Design mirrors `book-publish-notification.ts`:
 *   - Channel: in-app only for now (a `user_notifications` row). WebPush/FCM is
 *     the future channel (OPEN_FINDINGS_REGISTER F-9) and will hang off this
 *     same module.
 *   - Preference-gated per recipient: `users.inAppPreferences.aiCompleted`
 *     (opt-out, default enabled) normalised via `normalizeInAppPreferences`.
 *   - Best-effort: {@link notifyBookGenerationOutcome} NEVER throws — a
 *     notification failure must never break generation status persistence or
 *     the auto-refund that precedes it.
 *
 * Exactly-once: the caller resolves the outcome through
 * {@link resolveGenerationOutcome}, which combines the pre-update status read,
 * the guarded UPDATE's `RETURNING` result, and the terminal-status filter so a
 * duplicate webhook callback (or a `cancelled`/`completed` row the WHERE guard
 * refuses to touch) can never double-insert.
 */

import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { books, users, userNotifications } from '../db/schema.js';
import { normalizeInAppPreferences } from './in-app-preferences.js';
import { getErrorMessage } from '../utils/error.js';
import type { BookGenerationStatus } from '../types/book.js';

/** Terminal generation outcomes that produce an inbox row. */
export type GenerationOutcome = 'completed' | 'failed';

/**
 * Pure decision function — resolves whether a status write should persist an
 * outcome notification, and which one.
 *
 * A notification is emitted only when **all** of the following hold:
 * 1. `finalStatus` is terminal (`completed` or `failed`);
 * 2. the guarded UPDATE actually wrote a row (`updateApplied` — `RETURNING`
 *    was non-empty), i.e. the WHERE clause did not refuse the write because
 *    the row was already `completed`/`cancelled`;
 * 3. a pre-update row existed and its status differs from `finalStatus`
 *    (a repeated `failed` callback while already `failed` must not double-notify).
 *
 * @param args.finalStatus - Derived terminal status of this write, if any
 * @param args.priorStatus - Row status read immediately before the UPDATE
 *                           (`undefined` when no row exists); only read by the
 *                           caller when `finalStatus` is terminal
 * @param args.updateApplied - Whether the UPDATE returned a row
 * @returns `'completed' | 'failed'` when a notification should be inserted, otherwise `null`
 */
export function resolveGenerationOutcome(args: {
  finalStatus: BookGenerationStatus | undefined;
  priorStatus: BookGenerationStatus | undefined;
  updateApplied: boolean;
}): GenerationOutcome | null {
  const { finalStatus, priorStatus, updateApplied } = args;
  if (finalStatus !== 'completed' && finalStatus !== 'failed') return null;
  if (!updateApplied) return null;
  if (priorStatus === undefined || priorStatus === finalStatus) return null;
  return finalStatus;
}

/** Row written to `user_notifications` by {@link notifyBookGenerationOutcome}. */
export interface GenerationOutcomeNotificationRow {
  userId: string;
  type: 'ai_completed' | 'ai_failed';
  title: string;
  message: string;
  data: { bookId: string; bookSlug: string | null; bookTitle: string; status: GenerationOutcome };
  read: false;
}

/**
 * Pure row builder for the inbox insert — kept free of I/O so the copy,
 * type strings and deep-link payload are unit-testable (web deep-links off
 * `data.bookSlug`, see `UtilityFab.tsx handleOpenNotification`).
 *
 * @param ctx - Book identity plus the resolved terminal outcome
 * @returns The `user_notifications` values (timestamps come from column defaults)
 */
export function buildGenerationOutcomeRow(ctx: {
  userId: string;
  bookId: string;
  bookSlug: string | null;
  bookTitle: string;
  outcome: GenerationOutcome;
}): GenerationOutcomeNotificationRow {
  const { userId, bookId, bookSlug, bookTitle, outcome } = ctx;
  const data = { bookId, bookSlug, bookTitle, status: outcome };

  if (outcome === 'completed') {
    return {
      userId,
      type: 'ai_completed',
      title: `Story ready: ${bookTitle}`,
      message: 'Your story finished generating — open it to start reading.',
      data,
      read: false,
    };
  }

  return {
    userId,
    type: 'ai_failed',
    title: `Story generation failed: ${bookTitle}`,
    message: 'We could not finish generating this story.',
    data,
    read: false,
  };
}

/**
 * Inserts the in-app inbox row for a terminal generation outcome.
 *
 * Loads the book owner together with their `inAppPreferences` in one indexed
 * read, skips the insert when `aiCompleted` is opted out, and swallows every
 * error (logged) so this can be awaited from the generation pipeline without
 * ever affecting the status write or the auto-refund.
 *
 * @param bookId - Book whose generation just reached `outcome`
 * @param outcome - Terminal state that triggered the notification
 */
export async function notifyBookGenerationOutcome(
  bookId: string,
  outcome: GenerationOutcome,
): Promise<void> {
  try {
    const [row] = await dbRead
      .select({
        userId: books.userId,
        title: books.title,
        slug: books.slug,
        inAppPreferences: users.inAppPreferences,
      })
      .from(books)
      .leftJoin(users, eq(users.userId, books.userId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!row?.userId) return;
    if (!normalizeInAppPreferences(row.inAppPreferences).aiCompleted) return;

    await dbWrite.insert(userNotifications).values(
      buildGenerationOutcomeRow({
        userId: row.userId,
        bookId,
        bookSlug: row.slug,
        bookTitle: row.title,
        outcome,
      }),
    );
  } catch (err) {
    // Best-effort channel: never break generation persistence (F-8 contract).
    console.error(
      `[ai-generation-notification] ❌ Failed to persist ${outcome} notification for book ${bookId}:`,
      getErrorMessage(err),
    );
  }
}
