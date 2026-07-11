/**
 * @summary Runs daily embedding backfill for pages missing pgvector embeddings
 * @description Finds pages whose page_embeddings row is missing (never embedded,
 * or reconstructed-and-later-pruned — pages themselves are never deleted by
 * story_states cleanup, only their state snapshots are, so this can only
 * happen from a genuinely missed live embed) and embeds them, along with any
 * character interactions / place events / future notes recorded in that
 * page's own stored StateDelta.
 *
 * Idempotency:
 * - Safe to run multiple times: only processes pages with no page_embeddings row
 * - All embedding writes use onConflictDoUpdate, so a page that gets embedded
 *   both live and by a backfill race just overwrites with the same content
 * - No side effects on story content — this only ever writes to the four
 *   embedding tables, never touches pages/story_states
 *
 * Should be run periodically via cron (daily is plenty — this is a safety
 * net, not the primary embedding path; embedPersistedPage/embedStateDeltaEntities
 * firing fire-and-forget from generateNextPage/generateNextPages after every
 * page is what covers the vast majority of pages the moment they're created).
 *
 * Rate limits: Jina free tier is 100 RPM / 100,000 TPM / 2 concurrent
 * requests, enforced per-minute, not a fixed daily budget. At
 * EMBEDDING_GENERATION_DELAY (1000ms) between pages, on top of
 * getJinaLimiter().throttle()'s own ~652ms spacing (100 RPM, 8% safety
 * buffer), a full EMBEDDING_GENERATION_LIMIT (100) run takes roughly
 * 100-150 seconds and stays comfortably under both ceilings even when a
 * page also triggers character/place/future-note embeds alongside its page
 * embed.
 */
import { getErrorMessage } from "../utils/error.js";
import { EMBEDDING_GENERATION_LIMIT, EMBEDDING_GENERATION_DELAY } from "../config/embedding.js";

export async function runEmbeddingBackfill(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log("[backfill-embeddings] 🔍 Starting embedding backfill...");

    // Lazy import to avoid circular dependencies (same pattern as vip-expiration.ts)
    const { dbRead } = await import("../db/client.js");
    const { pages, pageEmbeddings } = await import("../db/schema.js");
    const { eq, isNull } = await import("drizzle-orm");
    const { canUseAIToday } = await import("../utils/ai-limiters.js");
    const { embedPersistedPage, embedStateDeltaEntities } = await import("../services/vector-memory.js");
    const { delay } = await import("../utils/time.js");

    // Currently always true — jina has no rpd/rpmo configured in
    // AI_RATE_LIMITS (it's RPM/TPM-based, not daily-budget-based, same as
    // mistral/nvidia). Kept for pattern-consistency with other cron jobs;
    // the RateLimiter's RPM throttling inside embedText/embedBatch is what
    // actually protects this provider, not this check.
    const canRun = await canUseAIToday('jina');
    if (!canRun) {
      console.log("[backfill-embeddings] ⏸️ Skipped — canUseAIToday('jina') returned false");
      return;
    }

    // Pages with no matching page_embeddings row. Pages themselves are never
    // deleted by cleanupStoryStatesWithStrategy() (only story_states rows
    // are), so this only ever catches genuinely missed live embeds — not
    // reconstruction-related gaps.
    const rows = await dbRead
      .select()
      .from(pages)
      .leftJoin(pageEmbeddings, eq(pages.id, pageEmbeddings.pageId))
      .where(isNull(pageEmbeddings.id))
      .limit(EMBEDDING_GENERATION_LIMIT);

    const pagesToEmbed = rows.map(r => r.pages);

    if (pagesToEmbed.length === 0) {
      console.log("[backfill-embeddings] ✨ No pages missing embeddings");
      return;
    }

    console.log(`[backfill-embeddings] ⚠️ Found ${pagesToEmbed.length} page(s) missing embeddings, backfilling...`);

    let succeededCount = 0;
    let failedCount = 0;

    for (const page of pagesToEmbed) {
      try {
        // embedPersistedPage/embedStateDeltaEntities expect PersistedStoryPage —
        // the raw `pages` row satisfies that shape (the table definition
        // itself is declared `satisfies Record<keyof StoryPage | ..., unknown>`
        // in schema.ts, so this should line up; if TS disagrees on your
        // exact version, map the row explicitly instead of casting).
        await embedPersistedPage(page as unknown as Parameters<typeof embedPersistedPage>[0]);
        await embedStateDeltaEntities(page as unknown as Parameters<typeof embedStateDeltaEntities>[0]);
        succeededCount++;
      } catch (error) {
        failedCount++;
        console.error(`[backfill-embeddings] ❌ Failed to embed page ${page.page} (${page.id}):`, getErrorMessage(error));
      }

      await delay(EMBEDDING_GENERATION_DELAY);
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[backfill-embeddings] ✅ Embedding backfill completed in ${durationMs}ms:`, {
      total: pagesToEmbed.length,
      succeeded: succeededCount,
      failed: failedCount,
    });
  } catch (error) {
    console.error("[backfill-embeddings] ❌ Embedding backfill failed:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for embedding backfill cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await runEmbeddingBackfill();
    const durationMs = Date.now() - startedAt;
    console.log(`[backfill-embeddings] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[backfill-embeddings] ❌ Embedding backfill job failed:", error);
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[backfill-embeddings] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[backfill-embeddings] Uncaught exception", error);
  process.exit(1);
});

void main();
