/**
 * Monthly activity summary email cron
 *
 * Aggregates prior-calendar-month stats per user and sends a recap when the
 * monthlyActivitySummary preference is on and at least one metric is non-zero.
 *
 * Run: pnpm dev:cron:email-monthly
 */

import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { dbRead } from '../db/client.js';
import { books, userCompletedBooks, userLikes, users } from '../db/schema.js';
import { normalizeEmailPreferences } from '../services/email-preferences.js';
import { sendMonthlyActivityEmail } from '../utils/email.js';
import { getErrorMessage } from '../utils/error.js';

const BATCH_SIZE = 50;

function previousMonthRange(now = new Date()): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const label = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, end, label };
}

export async function runMonthlyActivitySummaryEmail(): Promise<void> {
  console.log('[email-monthly] 🚀 Starting monthly activity summary job');
  const { start, end, label } = previousMonthRange();

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
      })
      .from(users)
      .where(and(eq(users.isNewUser, false), isNotNull(users.email)))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      const prefs = normalizeEmailPreferences(row.emailPreferences);
      if (!prefs.monthlyActivitySummary) {
        skipped++;
        continue;
      }

      try {
        const [[created], [completed], [likes]] = await Promise.all([
          dbRead
            .select({ count: sql<number>`count(*)::int` })
            .from(books)
            .where(
              and(
                eq(books.userId, row.userId),
                gte(books.createdAt, start),
                lt(books.createdAt, end),
              ),
            ),
          dbRead
            .select({ count: sql<number>`count(*)::int` })
            .from(userCompletedBooks)
            .where(
              and(
                eq(userCompletedBooks.userId, row.userId),
                gte(userCompletedBooks.completedAt, start),
                lt(userCompletedBooks.completedAt, end),
              ),
            ),
          dbRead
            .select({ count: sql<number>`count(*)::int` })
            .from(userLikes)
            .where(
              and(
                eq(userLikes.userId, row.userId),
                gte(userLikes.createdAt, start),
                lt(userLikes.createdAt, end),
              ),
            ),
        ]);

        const stats = {
          booksCreated: created?.count ?? 0,
          booksCompleted: completed?.count ?? 0,
          pagesRead: 0,
          likesGiven: likes?.count ?? 0,
        };

        if (
          stats.booksCreated === 0 &&
          stats.booksCompleted === 0 &&
          stats.likesGiven === 0
        ) {
          skipped++;
          continue;
        }

        const ok = await sendMonthlyActivityEmail(
          row.email,
          row.name || 'there',
          label,
          stats,
        );
        if (ok) sent++;
        else skipped++;
      } catch (error) {
        skipped++;
        console.error(`[email-monthly] ❌ user ${row.userId}:`, getErrorMessage(error));
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[email-monthly] ✅ Done — sent=${sent} skipped=${skipped} period=${label}`);
}

async function main() {
  try {
    await runMonthlyActivitySummaryEmail();
    process.exit(0);
  } catch (error) {
    console.error('[email-monthly] ❌ Fatal:', getErrorMessage(error));
    process.exit(1);
  }
}

void main();
