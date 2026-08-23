/**
 * Book Publish Notification Service (follower fan-out)
 *
 * When a book becomes publicly visible (`visibility` → 'public', handled in
 * `book.ts#updateBook`), every follower of the author is notified through one
 * or more **channels**. This module is the SSOT for that fan-out and is
 * intentionally decoupled from the book code so future channels (e.g. a push
 * gateway) can be added without touching `updateBook` or the book domain.
 *
 * Channels (each opt-out, gated by the recipient's own preferences):
 *   - in-app  → `user_notifications` row (read later by the notification center)
 *   - email   → transactional email (gated by `emailPreferences.storyPublished`
 *               + a verified email address)
 *   - push    → reserved extension point (see `dispatchPush`, not yet wired)
 *
 * Fire-and-forget safe: callers should swallow errors (`.catch()`) so a
 * notification failure can never break the publish transaction.
 */

import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { userFollows, userAuth, users, userNotifications } from '../db/schema.js';
import { normalizeInAppPreferences } from './in-app-preferences.js';
import { normalizeEmailPreferences } from './email-preferences.js';
import type { InAppPreferences } from '../types/in-app-preferences.js';
import type { EmailPreferences } from '../types/email-preferences.js';
import { sendEmailSafe, sendStoryPublishedEmail } from '../utils/email.js';

export interface NotifyFollowersOfPublishedBookParams {
  /** User who published the book (the followed author). */
  authorId: string;
  /** Published book id. */
  bookId: string;
  /** Published book slug (for building deep links). */
  bookSlug: string;
  /** Published book title (shown in the notification). */
  bookTitle: string;
}

interface FollowerRow {
  followerId: string;
  inAppPreferences: unknown;
  emailPreferences: unknown;
  name: string | null;
  email: string | null;
  emailVerified: Date | null;
}

/**
 * Notifies all eligible followers that `authorId` just published `bookId`.
 *
 * Eligibility is per-channel and per-recipient:
 *   - in-app  → recipient's `inAppPreferences.storyPublished`
 *   - email   → recipient's `emailPreferences.storyPublished` AND a verified email
 */
export async function notifyFollowersOfPublishedBook(
  params: NotifyFollowersOfPublishedBookParams,
): Promise<void> {
  const { authorId, bookId, bookSlug, bookTitle } = params;

  // Author display name (for email personalisation).
  const [author] = await dbRead
    .select({ name: users.name })
    .from(users)
    .where(eq(users.userId, authorId))
    .limit(1);
  const authorName = author?.name ?? 'Someone';

  // Followers, joined to their preference blobs + email contact info.
  const followers: FollowerRow[] = await dbRead
    .select({
      followerId: userFollows.followerId,
      inAppPreferences: users.inAppPreferences,
      emailPreferences: users.emailPreferences,
      name: users.name,
      email: users.email,
      emailVerified: userAuth.emailVerified,
    })
    .from(userFollows)
    .innerJoin(users, eq(users.userId, userFollows.followerId))
    .innerJoin(userAuth, eq(userAuth.userId, userFollows.followerId))
    .where(eq(userFollows.followingId, authorId));

  if (followers.length === 0) return;

  const now = new Date();

  // ── Channel: in-app ───────────────────────────────────────────────────────
  const inAppRows = followers
    .filter((f) => normalizeInAppPreferences(f.inAppPreferences as Partial<InAppPreferences> | null).storyPublished)
    .map((f) => ({
      userId: f.followerId,
      type: 'story_published' as const,
      title: 'New story from someone you follow',
      message: bookTitle,
      data: { authorId, bookId, bookSlug, bookTitle },
      read: false,
      createdAt: now,
      updatedAt: now,
    }));

  if (inAppRows.length > 0) {
    await dbWrite.insert(userNotifications).values(inAppRows);
  }

  // ── Channel: email ────────────────────────────────────────────────────────
  for (const f of followers) {
    const emailPrefs = normalizeEmailPreferences(f.emailPreferences as Partial<EmailPreferences> | null);
    if (!emailPrefs.storyPublished) continue;
    if (!f.email || !f.emailVerified) continue; // require a verified address

    void sendEmailSafe(`story_published→${f.followerId}`, () =>
      sendStoryPublishedEmail({
        to: f.email!,
        name: f.name ?? 'there',
        authorName,
        bookTitle,
        bookSlug,
        userId: f.followerId,
      }),
    );
  }

  // ── Channel: push (future) ────────────────────────────────────────────────
  // When a push gateway is integrated, fan out here, gated by a
  // `pushPreferences`/device-token lookup. No book-domain code needs to change.
  // dispatchPush(followers ...);
}
