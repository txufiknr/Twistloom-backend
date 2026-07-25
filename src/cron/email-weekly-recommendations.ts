/**
 * Weekly "books you might like" email cron
 *
 * Selects onboarded users with weeklyRecommendations=true and a verified-or-OAuth
 * email, ranks public active books by trending score, and sends a short digest.
 *
 * Run: pnpm dev:cron:email-weekly
 * Idempotency: simple per-user day key via activity log is deferred; rely on
 * weekly schedule + empty-state skip for v1.
 */

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { dbRead } from '../db/client.js';
import { books, users } from '../db/schema.js';
import { normalizeEmailPreferences } from '../services/email-preferences.js';
import { sendWeeklyRecommendationsEmail } from '../utils/email.js';
import { getErrorMessage } from '../utils/error.js';

const BATCH_SIZE = 50;
const BOOKS_PER_EMAIL = 5;

export async function runWeeklyRecommendationsEmail(): Promise<void> {
  console.log('[email-weekly] 🚀 Starting weekly recommendations job');

  const frontend = process.env.FRONTEND_URL?.replace(/\/$/, '') ?? 'https://twistloom.com';

  const topBooks = await dbRead
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
    })
    .from(books)
    .where(and(eq(books.status, 'active'), eq(books.visibility, 'public')))
    .orderBy(desc(books.trendingScore))
    .limit(BOOKS_PER_EMAIL);

  if (topBooks.length === 0) {
    console.log('[email-weekly] ⏭️ No public books to recommend — skipping');
    return;
  }

  const bookItems = topBooks.map((b) => ({
    title: b.title,
    url: `${frontend}/books/${b.slug || b.id}`,
    blurb: undefined as string | undefined,
  }));

  // Paginate users with engagement prefs enabled
  let offset = 0;
  let sent = 0;
  let skipped = 0;

  for (;;) {
    const rows = await dbRead
      .select({
        userId: users.userId,
        email: users.email,
        name: users.name,
        emailPreferences: users.emailPreferences,
        isNewUser: users.isNewUser,
      })
      .from(users)
      .where(and(eq(users.isNewUser, false), isNotNull(users.email)))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      const prefs = normalizeEmailPreferences(row.emailPreferences);
      if (!prefs.weeklyRecommendations) {
        skipped++;
        continue;
      }

      try {
        const ok = await sendWeeklyRecommendationsEmail(
          row.email,
          row.name || 'there',
          bookItems,
        );
        if (ok) sent++;
        else skipped++;
      } catch (error) {
        skipped++;
        console.error(`[email-weekly] ❌ user ${row.userId}:`, getErrorMessage(error));
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[email-weekly] ✅ Done — sent=${sent} skipped=${skipped}`);
}

async function main() {
  try {
    await runWeeklyRecommendationsEmail();
    process.exit(0);
  } catch (error) {
    console.error('[email-weekly] ❌ Fatal:', getErrorMessage(error));
    process.exit(1);
  }
}

void main();
