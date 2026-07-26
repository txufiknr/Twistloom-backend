/**
 * @overview Publish product domain events to the Twistloom Portal forum via Upstash QStash.
 *
 * Portal consumes `POST {PORTAL_URL}/forum/api/queue/consume` (signature + Zod + idempotency).
 * Failures are logged only — book/user mutations must not fail because the queue is down.
 *
 * Env:
 * - `QSTASH_TOKEN` — required to publish (no-op when missing)
 * - `PORTAL_URL` — origin only, e.g. `https://portal.twistloom.com` (default)
 * - Optional topic: `QSTASH_FORUM_TOPIC` (default `twistloom.forum`)
 */

import type { BookMode, BookStatus, BookVisibility } from '../types/book.js';

export const ForumQueueEvent = {
  STORY_PUBLISHED: 'story.published',
  STORY_UPDATED: 'story.updated',
  STORY_ARCHIVED: 'story.archived',
  STORY_TRENDING: 'story.trending',
  USER_BANNED: 'user.banned',
  USER_UNBANNED: 'user.unbanned',
} as const;

export type ForumQueueEventName = (typeof ForumQueueEvent)[keyof typeof ForumQueueEvent];

export type StoryForumPayload = {
  storyId: string;
  slug: string;
  title: string;
  summary?: string | null;
  coverUrl?: string | null;
  authorId?: string | null;
  authorUsername?: string | null;
  status?: BookStatus | string | null;
  visibility?: BookVisibility | string | null;
  mode?: BookMode | string | null;
  language?: string | null;
};

export type StoryArchivedPayload = {
  storyId: string;
  slug?: string | null;
};

export type StoryTrendingPayload = {
  storyId: string;
  isTrending: boolean;
};

export type UserBanPayload = {
  userId: string;
  reason?: string;
};

type QueueEnvelope<T> = {
  event: ForumQueueEventName | string;
  payload: T;
  idempotencyKey?: string;
  occurredAt: string;
};

type PublishResult = { success: true } | { success: false; error: string; skipped?: boolean };

function portalOrigin(): string {
  const raw = process.env.PORTAL_URL?.trim() || 'https://portal.twistloom.com';
  return raw.replace(/\/$/, '');
}

function consumeUrl(): string {
  return `${portalOrigin()}/forum/api/queue/consume`;
}

function forumTopic(): string {
  return process.env.QSTASH_FORUM_TOPIC?.trim() || 'twistloom.forum';
}

/**
 * Publish a forum queue envelope. Soft-fails when QStash is unconfigured or HTTP errors.
 */
export async function publishForumEvent<T>(
  event: ForumQueueEventName | string,
  payload: T,
  idempotencyKey?: string,
): Promise<PublishResult> {
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) {
    return { success: false, error: 'QSTASH_TOKEN not configured', skipped: true };
  }

  const envelope: QueueEnvelope<T> = {
    event,
    payload,
    idempotencyKey,
    occurredAt: new Date().toISOString(),
  };

  try {
    const res = await fetch('https://qstash.upstash.io/v1/publish', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Upstash-Topic': forumTopic(),
        'Upstash-Callback': consumeUrl(),
        ...(idempotencyKey ? { 'Upstash-Deduplication-Id': idempotencyKey.slice(0, 128) } : {}),
      },
      body: JSON.stringify(envelope),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[forum-queue] QStash ${res.status} for ${event}:`, text.slice(0, 500));
      return { success: false, error: `QStash ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown queue error';
    console.error(`[forum-queue] publish failed for ${event}:`, message);
    return { success: false, error: message };
  }
}

/** Fire-and-forget helper for route handlers. */
export function publishForumEventSafe(
  event: ForumQueueEventName | string,
  payload: unknown,
  idempotencyKey?: string,
): void {
  void publishForumEvent(event, payload, idempotencyKey).then((result) => {
    if (!result.success && !result.skipped) {
      console.warn(`[forum-queue] soft-fail ${event}:`, result.error);
    }
  });
}

export function isPublicActiveBook(book: {
  status?: string | null;
  visibility?: string | null;
}): boolean {
  return book.status === 'active' && book.visibility === 'public';
}

export function storyPayloadFromBook(book: {
  id: string;
  slug?: string | null;
  title: string;
  summary?: string | null;
  hook?: string | null;
  imageUrl?: string | null;
  coverUrl?: string | null;
  userId?: string | null;
  authorUsername?: string | null;
  status?: string | null;
  visibility?: string | null;
  mode?: string | null;
  language?: string | null;
}): StoryForumPayload | null {
  const slug = book.slug?.trim();
  if (!slug) return null;

  return {
    storyId: book.id,
    slug,
    title: book.title,
    summary: book.summary ?? book.hook ?? null,
    coverUrl: book.coverUrl ?? book.imageUrl ?? null,
    authorId: book.userId ?? null,
    authorUsername: book.authorUsername ?? null,
    status: book.status ?? null,
    visibility: book.visibility ?? null,
    mode: book.mode ?? null,
    language: book.language ?? null,
  };
}

/**
 * After a book row changes, notify the portal when visibility/status affect public discovery.
 * - Becomes public+active → `story.published` (upsert + auto-thread)
 * - Leaves public+active → `story.archived`
 * - Stays public+active with metadata edits → `story.updated`
 */
export function notifyForumOfBookChange(args: {
  before: { status?: string | null; visibility?: string | null };
  after: {
    id: string;
    slug?: string | null;
    title: string;
    summary?: string | null;
    hook?: string | null;
    imageUrl?: string | null;
    userId?: string | null;
    authorUsername?: string | null;
    status?: string | null;
    visibility?: string | null;
    mode?: string | null;
    language?: string | null;
  };
}): void {
  const was = isPublicActiveBook(args.before);
  const now = isPublicActiveBook(args.after);
  const payload = storyPayloadFromBook(args.after);

  if (now && payload) {
    if (!was) {
      publishForumEventSafe(
        ForumQueueEvent.STORY_PUBLISHED,
        payload,
        `story.published:${payload.storyId}`,
      );
    } else {
      publishForumEventSafe(
        ForumQueueEvent.STORY_UPDATED,
        payload,
        `story.updated:${payload.storyId}:${Date.now()}`,
      );
    }
    return;
  }

  if (was && !now) {
    publishForumEventSafe(
      ForumQueueEvent.STORY_ARCHIVED,
      { storyId: args.after.id, slug: args.after.slug ?? undefined } satisfies StoryArchivedPayload,
      `story.archived:${args.after.id}`,
    );
  }
}

export function notifyForumStoryArchived(storyId: string, slug?: string | null): void {
  publishForumEventSafe(
    ForumQueueEvent.STORY_ARCHIVED,
    { storyId, slug: slug ?? undefined } satisfies StoryArchivedPayload,
    `story.archived:${storyId}`,
  );
}

/**
 * After platform ban (users.banned_at set). Portal sets forum_users.is_banned.
 * No-op on portal if the user never visited the forum (no forum_users row yet).
 */
export function notifyForumUserBanned(userId: string, reason?: string): void {
  publishForumEventSafe(
    ForumQueueEvent.USER_BANNED,
    { userId, reason } satisfies UserBanPayload,
    `user.banned:${userId}`,
  );
}

/** After platform unban (users.banned_at cleared). */
export function notifyForumUserUnbanned(userId: string): void {
  publishForumEventSafe(
    ForumQueueEvent.USER_UNBANNED,
    { userId } satisfies UserBanPayload,
    `user.unbanned:${userId}`,
  );
}
