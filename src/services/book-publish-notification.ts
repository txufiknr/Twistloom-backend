/** Durable publication fan-out; enumeration and in-app inserts share the campaign cursor transaction. */
import { dbRead, dbWrite, type DBTransaction } from '../db/client.js';
import { userFollows, users } from '../db/schema.js';
import { NOTIFICATION_I18N_KEYS } from '../config/notifications.js';
import { createNotificationsBatch } from './notifications.js';
import { and, asc, eq, gt } from 'drizzle-orm';
import { queueEmailCampaign } from './email-campaigns.js';
import { emailDeliveryEnabled } from '../config/email-delivery.js';
import { normalizeInAppPreferences } from './in-app-preferences.js';
export interface NotifyFollowersOfPublishedBookParams { authorId: string; bookId: string; bookSlug: string; bookTitle: string }
/**
 * Notifies followers of a newly published book.
 *
 * In-app delivery never depends on the email transport flag: when the shared
 * email/campaign infrastructure is disabled (pre-provision rollout window) this
 * falls back to a direct `user_notifications` insert using only long-lived
 * tables, restoring the pre-outbox behavior. When enabled, both in-app and
 * email fan out through the resumable campaign cursor.
 */
export async function notifyFollowersOfPublishedBook(params: NotifyFollowersOfPublishedBookParams, tx?: DBTransaction): Promise<void> {
  if (!emailDeliveryEnabled()) {
    await insertPublicationInAppDirect(params, tx);
    return;
  }
  const connection = tx ?? dbWrite;
  const [author] = await connection.select({ name: users.name }).from(users).where(eq(users.userId, params.authorId)).limit(1);
  await queueEmailCampaign({ requestKey: `story_published/${params.bookId}`, title: params.bookTitle,
    audience: { kind: 'story_published', ...params, authorName: author?.name ?? 'Someone' } }, tx);
}

/**
 * Flag-off fallback: synchronous in-app fan-out with no dependency on the new
 * `email_campaigns`/`email_messages` tables, Resend, Redis, or QStash.
 * Runs in the caller's transaction when one is supplied so publish + notify
 * commit together. Only used while the shared delivery gate is disabled.
 */
async function insertPublicationInAppDirect(params: NotifyFollowersOfPublishedBookParams, tx?: DBTransaction): Promise<void> {
  // Reads see the publish transaction when one is supplied; otherwise use replica.
  const reader = tx ?? dbRead;
  const [author] = await reader.select({ name: users.name }).from(users).where(eq(users.userId, params.authorId)).limit(1);
  const authorName = author?.name ?? '';

  /**
   * Bounded chunk size for fan-out batch processing.
   *
   * Why CHUNK_SIZE = 500 is canonical and an industry standard:
   * 1. PostgreSQL Wire Protocol Parameter Limit: PostgreSQL enforces a maximum of 65,535
   *    parameters ($1, $2, ...) per prepared statement. Each notification row binds ~11 values
   *    (userId, type, title, message, i18nKey, i18nParams, data, groupKey, read, createdAt, updatedAt).
   *    Inserting 500 items binds ~5,500 parameters (~8.4% of the protocol ceiling), leaving a massive
   *    safety margin and preventing fatal "bind message has X parameter formats" driver errors.
   * 2. Bounded Serverless Memory Overhead: In serverless runtimes (Netlify/Vercel/Lambda with 512-1024MB RAM),
   *    loading tens of thousands of joined follower rows into V8 heap at once causes GC thrashing or OOM
   *    crashes. Chunking guarantees O(CHUNK_SIZE) constant working memory instead of O(N) unbounded heap growth.
   * 3. Keyset (Cursor) Pagination over OFFSET: We paginate via `gt(userFollows.followerId, lastFollowerId)`
   *    ordered by `userFollows.followerId ASC`. Unlike `OFFSET` which scans and discards N prior rows on
   *    every step (yielding O(N^2) total work and data drift under concurrent writes), keyset pagination
   *    performs an O(1) B-tree index seek per batch.
   * 4. Transaction & Lock Health: Slicing multi-row inserts prevents long-lived exclusive table/index locks
   *    and WAL buffer saturation, allowing concurrent database operations to proceed smoothly.
   */
  const CHUNK_SIZE = 500;
  let lastFollowerId: string | null = null;
  while (true) {
    const conditions = [eq(userFollows.followingId, params.authorId)];
    if (lastFollowerId) {
      conditions.push(gt(userFollows.followerId, lastFollowerId));
    }

    const rows = await reader
      .select({ followerId: userFollows.followerId, inAppPreferences: users.inAppPreferences })
      .from(userFollows)
      .innerJoin(users, eq(users.userId, userFollows.followerId))
      .where(and(...conditions))
      .orderBy(asc(userFollows.followerId))
      .limit(CHUNK_SIZE);

    if (rows.length === 0) break;

    const notifications = rows
      .filter((f) => normalizeInAppPreferences(f.inAppPreferences).storyPublished)
      .map((f) => ({
        userId: f.followerId,
        type: 'story_published' as const,
        fallbackTitle: 'New story from someone you follow',
        fallbackMessage: params.bookTitle,
        i18nKey: NOTIFICATION_I18N_KEYS.STORY_PUBLISHED,
        i18nParams: { bookTitle: params.bookTitle, authorId: params.authorId, bookSlug: params.bookSlug, authorName },
        data: { authorId: params.authorId, bookId: params.bookId, bookSlug: params.bookSlug, bookTitle: params.bookTitle, authorName },
      }));

    if (notifications.length > 0) {
      await createNotificationsBatch(notifications, tx);
    }

    if (rows.length < CHUNK_SIZE) break;
    lastFollowerId = rows[rows.length - 1].followerId;
  }
}
