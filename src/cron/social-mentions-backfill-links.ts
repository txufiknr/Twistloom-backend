/**
 * @summary One-shot backfill: extract Twistloom book links for existing social mentions (D9).
 * @description Safe to re-run. Only updates rows where related_book_id is null and
 * related_book_source is not 'admin'. Never auto-features. Never overwrites admin links.
 *
 * Usage:
 *   pnpm tsx src/cron/social-mentions-backfill-links.ts
 */
import { and, eq, isNull, or, ne } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";

export async function runSocialMentionLinkBackfill(): Promise<void> {
  const startedAt = Date.now();
  console.log("[social-backfill] 🚀 Starting related-book link backfill...");

  const { dbRead, dbWrite } = await import("../db/client.js");
  const { socialMentions } = await import("../db/schema.js");
  const { extractAndResolveTwistloomLink } = await import("../services/social/extract-twistloom-link.js");

  // Rows without a book link, excluding sticky admin overrides
  const candidates = await dbRead
    .select({
      id: socialMentions.id,
      title: socialMentions.title,
      content: socialMentions.content,
      relatedBookSource: socialMentions.relatedBookSource,
    })
    .from(socialMentions)
    .where(
      and(
        isNull(socialMentions.relatedBookId),
        or(
          isNull(socialMentions.relatedBookSource),
          ne(socialMentions.relatedBookSource, "admin"),
        ),
      ),
    )
    .limit(2000);

  console.log(`[social-backfill] 📋 Candidates: ${candidates.length}`);

  let updated = 0;
  let skipped = 0;

  for (const row of candidates) {
    try {
      const resolved = await extractAndResolveTwistloomLink(row.title, row.content, "auto");
      if (!resolved) {
        skipped++;
        continue;
      }

      await dbWrite
        .update(socialMentions)
        .set({
          relatedBookId: resolved.bookId,
          relatedPageId: resolved.pageId,
          relatedBookSource: "auto",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(socialMentions.id, row.id),
            isNull(socialMentions.relatedBookId),
            or(
              isNull(socialMentions.relatedBookSource),
              ne(socialMentions.relatedBookSource, "admin"),
            ),
          ),
        );

      updated++;
    } catch (error) {
      console.error(`[social-backfill] ⚠️ Failed for ${row.id}:`, getErrorMessage(error));
    }
  }

  console.log(`[social-backfill] ✅ Done in ${Date.now() - startedAt}ms`, {
    candidates: candidates.length,
    updated,
    skippedNoLink: skipped,
  });
}

async function main(): Promise<void> {
  try {
    await runSocialMentionLinkBackfill();
    process.exit(0);
  } catch (error) {
    console.error("[social-backfill] ❌ Fatal:", error);
    process.exit(1);
  }
}

void main();
