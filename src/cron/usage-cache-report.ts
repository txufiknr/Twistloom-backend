/**
 * @summary Per-book Gemini cache-economics report (dev command — not a cron)
 * @description Answers the two questions from TOKEN_SAVING_ROADMAP Part 3:
 *
 *   1. "Is Gemini explicit caching paying for this book?" — compares
 *      cached-token reads against total input tokens per book context.
 *   2. "Which providers need the repair pipeline?" — surfaces per-context
 *      request/token volumes across every provider.
 *
 * Reads ONLY the `usage` table (aggregated per-day rows tagged with the
 * per-book `story-page-candidate:b-{bookId}` context from Step 2) — no writes,
 * no serverless route. Run on demand via:
 *
 *   bun --env-file=.env.local src/cron/usage-cache-report.ts
 *
 * Interpretation rule (from TOKEN_SAVING_ROADMAP Part 3): a `gemini` row whose
 * `cachedTokens / inputTokens` ratio is low *and* whose request count is low is
 * a candidate for explicit-cache opt-out — the $1.00/1M-tokens/hr Flash storage
 * fee accrues even when nothing reads the cache.
 */
import { and, desc, gte, sql } from "drizzle-orm";
import { usage } from "../db/schema.js";
import { dbRead } from "../db/client.js";
import { estimateCost } from "../utils/ai-cost.js";
import { getTodayDate } from "../utils/time.js";

/** Number of past days (including today) to include in the report. */
const REPORT_DAYS = 7;

/**
 * Runs the Step-2b aggregation: per (context, provider, model) sums over the
 * trailing window, ordered by total tokens so the expensive lines surface first.
 */
async function runCacheEconomicsReport(): Promise<void> {
  // Only rows tagged by the Step-2 per-book context shape.
  const contextPattern = 'story-page-candidate%';

  // Window start in YYYY-MM-DD (the usage.date column is a text date).
  const today = getTodayDate();
  const startDate = new Date(`${today}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - (REPORT_DAYS - 1));
  const startDateISO = startDate.toISOString().slice(0, 10);

  const rows = await dbRead
    .select({
      context: usage.context,
      provider: usage.provider,
      model: usage.model,
      requests: sql<number>`sum(${usage.requests})`,
      inputTokens: sql<number>`sum(${usage.inputTokens})`,
      outputTokens: sql<number>`sum(${usage.outputTokens})`,
      totalTokens: sql<number>`sum(${usage.totalTokens})`,
      cachedTokens: sql<number>`sum(${usage.cachedTokens})`,
    })
    .from(usage)
    .where(
      and(
        gte(usage.date, startDateISO),
        sql`${usage.context} LIKE ${contextPattern}`,
      ),
    )
    .groupBy(usage.context, usage.provider, usage.model)
    .orderBy(desc(sql`sum(${usage.totalTokens})`));

  console.log(`📊 Cache-economics report — last ${REPORT_DAYS} days (${startDateISO} → ${today})`);
  console.log('(per-book context · provider · model — by total tokens, desc)\n');

  if (rows.length === 0) {
    console.log('No story-page rows found yet — the Step-2 context tag must not');
    console.log('have emitted traffic in this window.');
    return;
  }

  for (const row of rows) {
    const requests = row.requests ?? 0;
    const inputTokens = row.inputTokens ?? 0;
    const cachedTokens = row.cachedTokens ?? 0;
    const totalTokens = row.totalTokens ?? inputTokens + (row.outputTokens ?? 0);
    // Cache-hit ratio of input tokens: high = cache paying for itself,
    // low = explicit-cache opt-out candidate (Gemini storage fee).
    const cacheRatio = inputTokens > 0 ? cachedTokens / inputTokens : 0;
    const cost = estimateCost(row.provider, row.model, row.inputTokens, row.outputTokens);

    console.log(
      [
        `• ${row.context}`,
        `  ${row.provider}/${row.model}`,
        `  requests=${requests}`,
        `  input=${inputTokens} cached=${cachedTokens} (${(cacheRatio * 100).toFixed(1)}%)`,
        `  total=${totalTokens}`,
        `  est≈$${cost.toFixed(4)}`,
        cacheRatio < 0.1 && requests > 0
          ? '  ⚠️ low cache-hit → opt-out candidate'
          : '',
      ].join(' | '),
    );
  }

  console.log('\n⚠️ low cache-hit = candidate for explicit-cache opt-out (Step 5c).');
  console.log('Numbers are USD estimates for budgeting — never an invoice source.');
}

// Run only when executed directly (not when imported)
// (Bun sets import.meta.main true only for the entry module)
if (import.meta.main) {
  runCacheEconomicsReport().catch((error) => {
    console.error('Failed to run cache-economics report:', error);
    process.exit(1);
  });
}