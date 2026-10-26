/**
 * Unified Notification Service
 * @overview Centralized helpers for inserting and upserting user notifications with i18n metadata.
 * Enforces the code-driven localization architecture across all backend event writers.
 */

import { sql } from 'drizzle-orm';
import { dbWrite, type DBTransaction, type DBClient } from '../db/client.js';
import { userNotifications } from '../db/schema.js';
import type { NotificationI18nKey, NotificationType } from '../config/notifications.js';
import { batchInsert } from '../utils/batch.js';

export interface InsertNotificationParams {
  userId: string;
  type: NotificationType;
  i18nKey: NotificationI18nKey;
  i18nParams?: Record<string, string | number> | null;
  fallbackTitle: string;
  fallbackMessage: string;
  data?: Record<string, unknown> | null;
  groupKey?: string | null;
  onConflictDoNothing?: boolean;
  tx?: DBTransaction | DBClient;
}

export interface UpsertNotificationParams extends InsertNotificationParams {
  groupKey: string;
  updateTitle?: string;
  updateMessage?: string;
  updateI18nKey?: NotificationI18nKey;
  updateI18nParams?: Record<string, string | number> | null;
  updateData?: Record<string, unknown> | null;
}

/**
 * Inserts a single localized user notification.
 * Automatically enforces `read: false`, `createdAt: now`, and `updatedAt: now`.
 */
export async function createNotification(params: InsertNotificationParams): Promise<void> {
  const conn = params.tx ?? dbWrite;
  const now = new Date();

  const values = {
    userId: params.userId,
    type: params.type,
    i18nKey: params.i18nKey,
    i18nParams: params.i18nParams ?? null,
    title: params.fallbackTitle,
    message: params.fallbackMessage,
    data: params.data ?? null,
    groupKey: params.groupKey ?? null,
    read: false,
    createdAt: now,
    updatedAt: now,
  };

  if (params.onConflictDoNothing) {
    await conn.insert(userNotifications).values(values).onConflictDoNothing();
    return;
  }

  await conn.insert(userNotifications).values(values);
}

/**
 * Inserts multiple localized user notifications in bounded, parameter-safe batch chunks.
 * Automatically guards against PostgreSQL 65,535 wire-protocol parameter overflows.
 */
export async function createNotificationsBatch(
  items: InsertNotificationParams[],
  tx?: DBTransaction | DBClient,
): Promise<void> {
  if (!items.length) return;
  const conn = tx ?? dbWrite;
  const now = new Date();

  const rows = items.map((item) => ({
    userId: item.userId,
    type: item.type,
    i18nKey: item.i18nKey,
    i18nParams: item.i18nParams ?? null,
    title: item.fallbackTitle,
    message: item.fallbackMessage,
    data: item.data ?? null,
    groupKey: item.groupKey ?? null,
    read: false,
    createdAt: now,
    updatedAt: now,
  }));

  await batchInsert(conn, userNotifications, rows);
}

/**
 * Upserts a localized user notification targeting the partial unique index:
 * `user_notifications_unread_group_unique` ON (userId, type, groupKey) WHERE read = false AND groupKey IS NOT NULL.
 * Coalesces concurrent or subsequent events (e.g. review likes, wall reactions) into an existing unread row.
 */
export async function upsertNotification(params: UpsertNotificationParams): Promise<void> {
  const conn = params.tx ?? dbWrite;
  const now = new Date();

  await conn
    .insert(userNotifications)
    .values({
      userId: params.userId,
      type: params.type,
      i18nKey: params.i18nKey,
      i18nParams: params.i18nParams ?? null,
      title: params.fallbackTitle,
      message: params.fallbackMessage,
      data: params.data ?? null,
      groupKey: params.groupKey,
      read: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userNotifications.userId, userNotifications.type, userNotifications.groupKey],
      targetWhere: sql`${userNotifications.read} = false AND ${userNotifications.groupKey} IS NOT NULL`,
      set: {
        title: params.updateTitle ?? params.fallbackTitle,
        message: params.updateMessage ?? params.fallbackMessage,
        i18nKey: params.updateI18nKey ?? params.i18nKey,
        i18nParams: params.updateI18nParams ?? params.i18nParams ?? null,
        data: params.updateData ?? params.data ?? null,
        updatedAt: now,
      },
    });
}
