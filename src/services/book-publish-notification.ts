/** Durable publication fan-out; enumeration and in-app inserts share the campaign cursor transaction. */
import { dbRead, dbWrite, type DBTransaction } from '../db/client.js';
import { userFollows, userNotifications, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
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
  const writer = tx ?? dbWrite;
  const rows = await reader.select({ followerId: userFollows.followerId, inAppPreferences: users.inAppPreferences })
    .from(userFollows).innerJoin(users, eq(users.userId, userFollows.followerId))
    .where(eq(userFollows.followingId, params.authorId));
  const now = new Date();
  const notifications = rows
    .filter((f) => normalizeInAppPreferences(f.inAppPreferences).storyPublished)
    .map((f) => ({
      userId: f.followerId,
      type: 'story_published' as const,
      title: 'New story from someone you follow',
      message: params.bookTitle,
      data: { authorId: params.authorId, bookId: params.bookId, bookSlug: params.bookSlug, bookTitle: params.bookTitle },
      read: false,
      createdAt: now,
      updatedAt: now,
    }));
  if (!notifications.length) return;
  await writer.insert(userNotifications).values(notifications);
}
