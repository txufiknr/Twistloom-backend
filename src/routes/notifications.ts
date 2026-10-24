/**
 * Notifications Routes
 *
 * Client-facing read/management API for the `user_notifications` table.
 * This is the read side of the notification system; the *write* side lives in
 * `services/book-publish-notification.ts` (and any future channel services)
 * and is deliberately decoupled from these routes.
 *
 * All endpoints require authentication and are strictly scoped to the caller's
 * own notifications.
 */

import { and, count, desc, eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { userNotifications } from '../db/schema.js';
import { requireAuth } from '../middleware/nextauth.js';
import {
  getAnnouncementUnseenCount,
  markActiveAnnouncementSeen,
} from '../services/announcements.js';
import {
  cApiError,
  cNotFoundError,
  cUnauthorizedError,
  cForbiddenError,
  cValidationError,
} from '../utils/error.js';
import type { AppEnv } from '../hono/env.js';
import { Hono } from 'hono';

const router = new Hono<AppEnv>();

/**
 * GET /api/notifications
 * Paginated list of the current user's notifications (newest first), plus the
 * total count and the current unread count.
 *
 * `unreadCount` is server-composed: personal unread + the 0/1 announcement
 * unseen flag (`announcementUnread`, additive) so the badge and the list stay
 * perfectly in sync (ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP Q1).
 */
router.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return cUnauthorizedError(c, 'Authentication required');

    const limit = Math.min(
      Math.max(parseInt((c.req.query('limit') as string) ?? '20', 10) || 20, 1),
      50,
    );
    const offset = Math.max(parseInt((c.req.query('offset') as string) ?? '0', 10) || 0, 0);

    const [items, totalRow, unreadRow, announcementUnread] = await Promise.all([
      dbRead
        .select({
          id: userNotifications.id,
          userId: userNotifications.userId,
          type: userNotifications.type,
          title: userNotifications.title,
          message: userNotifications.message,
          i18nKey: userNotifications.i18nKey,
          i18nParams: userNotifications.i18nParams,
          data: userNotifications.data,
          read: userNotifications.read,
          createdAt: userNotifications.createdAt,
          updatedAt: userNotifications.updatedAt,
        })
        .from(userNotifications)
        .where(eq(userNotifications.userId, userId))
        .orderBy(desc(userNotifications.createdAt))
        .limit(limit)
        .offset(offset),
      dbRead
        .select({ value: count() })
        .from(userNotifications)
        .where(eq(userNotifications.userId, userId)),
      dbRead
        .select({ value: count() })
        .from(userNotifications)
        .where(and(eq(userNotifications.userId, userId), eq(userNotifications.read, false))),
      getAnnouncementUnseenCount(userId),
    ]);

    const personalUnread = unreadRow[0]?.value ?? 0;
    return c.json({
      items,
      total: totalRow[0]?.value ?? 0,
      unreadCount: personalUnread + announcementUnread,
      announcementUnread,
    });
  } catch (error) {
    return cApiError(c, 'Failed to load notifications', error);
  }
});

/**
 * GET /api/notifications/unread-count
 * Lightweight badge counter for the notification bell.
 *
 * `count` = personal unread + `announcementUnread` (0 or 1) — an additive,
 * server-composed fold so every existing badge call-site keeps working
 * against a single number.
 */
router.get('/unread-count', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return cUnauthorizedError(c, 'Authentication required');

    const [unreadRows, announcementUnread] = await Promise.all([
      dbRead
        .select({ value: count() })
        .from(userNotifications)
        .where(and(eq(userNotifications.userId, userId), eq(userNotifications.read, false))),
      getAnnouncementUnseenCount(userId),
    ]);

    const personalUnread = unreadRows[0]?.value ?? 0;
    return c.json({ count: personalUnread + announcementUnread, announcementUnread });
  } catch (error) {
    return cApiError(c, 'Failed to load unread count', error);
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Marks a single notification as read. Ownership-checked so a user can never
 * mutate another user's notifications.
 */
router.patch('/:id/read', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return cUnauthorizedError(c, 'Authentication required');

    const { id } = c.req.param();
    if (!id) return cValidationError(c, 'Notification id is required');

    const [existing] = await dbRead
      .select({ userId: userNotifications.userId })
      .from(userNotifications)
      .where(eq(userNotifications.id, id))
      .limit(1);

    if (!existing) return cNotFoundError(c, 'Notification not found');
    if (existing.userId !== userId) {
      return cForbiddenError(c, 'Cannot modify another user’s notification');
    }

    const [updated] = await dbWrite
      .update(userNotifications)
      .set({ read: true, updatedAt: new Date() })
      .where(eq(userNotifications.id, id))
      .returning();

    return c.json({ notification: updated });
  } catch (error) {
    return cApiError(c, 'Failed to mark notification read', error);
  }
});

/**
 * POST /api/notifications/read-all
 * Marks every notification for the current user as read.
 *
 * Also points `users.last_seen_announcement_id` at the active announcement —
 * otherwise "Mark all as read" would clear the personal list but leave the
 * announcement badge stuck at +1, which reads as a bug.
 */
router.post('/read-all', requireAuth, async (c) => {
  try {
    const userId = c.get('userId');
    if (!userId) return cUnauthorizedError(c, 'Authentication required');

    await dbWrite
      .update(userNotifications)
      .set({ read: true, updatedAt: new Date() })
      .where(eq(userNotifications.userId, userId));

    await markActiveAnnouncementSeen(userId);

    return c.json({ success: true });
  } catch (error) {
    return cApiError(c, 'Failed to mark all notifications read', error);
  }
});

export default router;
