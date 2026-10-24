/**
 * Testimonial Like Notification Service
 *
 * Dispatches in-app notification to the testimonial author when a reader
 * likes their testimonial. Follows the notification preference check ('likes')
 * and coalesces unread notifications to avoid spamming the author.
 */

import { and, eq, sql } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { bookTestimonials, userNotifications, users } from '../db/schema.js';
import { NOTIFICATION_I18N_KEYS } from '../config/notifications.js';
import { normalizeInAppPreferences } from './in-app-preferences.js';

export interface NotifyTestimonialLikeParams {
  recipientId: string;
  actorId: string;
  testimonialId: string;
  bookTitle?: string | null;
  bookSlug?: string | null;
}

export async function notifyTestimonialLike(
  params: NotifyTestimonialLikeParams & { ensureMissingOnly?: boolean },
): Promise<void> {
  const { recipientId, actorId, testimonialId, bookTitle, bookSlug, ensureMissingOnly = false } = params;
  const title = bookTitle || 'a story';
  const slug = bookSlug || '';

  // Do not notify self
  if (recipientId === actorId) return;

  // Check if recipient allows 'likes' notifications
  const [recipient] = await dbRead
    .select({ inAppPreferences: users.inAppPreferences })
    .from(users)
    .where(eq(users.userId, recipientId))
    .limit(1);

  if (!recipient) return;
  const prefs = normalizeInAppPreferences(recipient.inAppPreferences);
  if (!prefs.likes) return;

  // Resolve actor name
  const [actor] = await dbRead
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, actorId))
    .limit(1);

  const actorName = actor?.name || 'A reader';

  const now = new Date();
  const groupKey = `testimonial:${testimonialId}`;
  const data = {
    testimonialId,
    bookSlug: slug,
    bookTitle: title,
    actorId,
    actorName,
  };

  await dbWrite.transaction(async (tx) => {
    // Serialize against testimonial deletion and keep stale / hidden reviews
    // from creating notifications after their like transaction has committed.
    const [testimonial] = await tx
      .select({ authorId: bookTestimonials.userId, status: bookTestimonials.status })
      .from(bookTestimonials)
      .where(eq(bookTestimonials.id, testimonialId))
      .limit(1)
      .for('update');
    if (!testimonial || testimonial.authorId !== recipientId || testimonial.status !== 'approved') return;

    // Repair likes created before every endpoint dispatched notifications.
    // A duplicate like request should only backfill a notification when no
    // notification history exists; it must not re-notify a read group.
    if (ensureMissingOnly) {
      const [existing] = await tx
        .select({ id: userNotifications.id })
        .from(userNotifications)
        .where(and(
          eq(userNotifications.userId, recipientId),
          eq(userNotifications.type, 'testimonial_like'),
          sql`(${userNotifications.groupKey} = ${groupKey} OR ${userNotifications.data}->>'testimonialId' = ${testimonialId})`,
        ))
        .limit(1);
      if (existing) return;

      await tx.insert(userNotifications).values({
        userId: recipientId,
        type: 'testimonial_like',
        groupKey,
        title: 'New like on your review',
        message: `${actorName} liked your testimonial for "${title}"`,
        i18nKey: NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_SINGLE,
        i18nParams: { actorName, bookTitle: title },
        data,
        read: false,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      return;
    }

    await tx.insert(userNotifications).values({
      userId: recipientId,
      type: 'testimonial_like',
      groupKey,
      title: 'New like on your review',
      message: `${actorName} liked your testimonial for "${title}"`,
      i18nKey: NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_SINGLE,
      i18nParams: { actorName, bookTitle: title },
      data,
      read: false,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userNotifications.userId, userNotifications.type, userNotifications.groupKey],
      targetWhere: sql`${userNotifications.read} = false AND ${userNotifications.groupKey} IS NOT NULL`,
      set: {
        title: 'New like on your review',
        message: `${actorName} and others liked your testimonial for "${title}"`,
        i18nKey: NOTIFICATION_I18N_KEYS.TESTIMONIAL_LIKE_MULTIPLE,
        i18nParams: { actorName, bookTitle: title },
        data,
        updatedAt: now,
      },
    });
  });
}
