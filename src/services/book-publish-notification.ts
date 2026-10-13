/** Durable publication fan-out; enumeration and in-app inserts share the campaign cursor transaction. */
import { dbWrite, type DBTransaction } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { queueEmailCampaign } from './email-campaigns.js';
import { emailDeliveryEnabled } from '../config/email-delivery.js';
export interface NotifyFollowersOfPublishedBookParams { authorId: string; bookId: string; bookSlug: string; bookTitle: string }
export async function notifyFollowersOfPublishedBook(params: NotifyFollowersOfPublishedBookParams, tx?: DBTransaction): Promise<void> {
  if (!emailDeliveryEnabled()) return;
  const connection = tx ?? dbWrite;
  const [author] = await connection.select({ name: users.name }).from(users).where(eq(users.userId, params.authorId)).limit(1);
  await queueEmailCampaign({ requestKey: `story_published/${params.bookId}`, title: params.bookTitle,
    audience: { kind: 'story_published', ...params, authorName: author?.name ?? 'Someone' } }, tx);
}
