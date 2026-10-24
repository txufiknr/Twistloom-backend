/**
 * Unified Notification Service
 * @overview Centralized helper for inserting user notifications with i18n metadata
 */

import { dbWrite, type DBTransaction, type DBClient } from '../db/client.js';
import { userNotifications } from '../db/schema.js';
import type { NotificationI18nKey, NotificationType } from '../config/notifications.js';

export interface InsertNotificationParams {
  userId: string;
  type: NotificationType | string;
  i18nKey?: NotificationI18nKey;
  i18nParams?: Record<string, string | number>;
  fallbackTitle: string;
  fallbackMessage: string;
  data?: Record<string, unknown> | null;
  groupKey?: string | null;
  tx?: DBTransaction | DBClient;
}

export async function createNotification(params: InsertNotificationParams): Promise<void> {
  const conn = params.tx ?? dbWrite;
  const now = new Date();

  await conn.insert(userNotifications).values({
    userId: params.userId,
    type: params.type,
    i18nKey: params.i18nKey ?? null,
    i18nParams: params.i18nParams ?? null,
    title: params.fallbackTitle,
    message: params.fallbackMessage,
    data: params.data ?? null,
    groupKey: params.groupKey ?? null,
    read: false,
    createdAt: now,
    updatedAt: now,
  });
}
