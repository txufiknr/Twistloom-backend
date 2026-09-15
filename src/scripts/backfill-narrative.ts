/**
 * @summary One-time migration & recalculation script for user narrative accomplishment counters
 * @description Backfills and synchronizes historical narrative metrics in user_counters:
 * - stories_completed & alternate_endings_discovered
 * - deep_branch_completions
 * - distinct_ending_types_reached
 * - rare_endings_found
 * - branch_points_explored
 * - high_risk_choices_taken
 * - consequence_experienced
 * - threads_resolved & clues_uncovered
 *
 * After updating counters, evaluates and retroactively awards any newly earned badges
 * across the entire achievement registry via checkAndAwardAchievements.
 *
 * @remarks
 * This script is **100% idempotent** — safe to run multiple times. All counter updates
 * recompute absolute metrics from source-of-truth tables (CTEs) using `SET col = agg.val`,
 * never additive increments. Badges use `ON CONFLICT DO NOTHING`.
 *
 * Usage:
 *   bun src/scripts/backfill-narrative.ts           # Run backfill and award retroactive badges
 *   bun src/scripts/backfill-narrative.ts --dry-run # Preview affected reader counts without mutating
 *   bun src/scripts/backfill-narrative.ts --force   # Accepted for compatibility (same as default)
 */
import { dbWrite, dbRead, type DBClient } from "../db/client.js";
import { userCounters, userCompletedBooks, userPageProgress } from "../db/schema.js";
import { sql, countDistinct } from "drizzle-orm";
import { checkAndAwardAchievements } from "../services/achievements.js";

export interface BackfillStats {
  usersWithCompletions: number;
  usersWithProgress: number;
  badgesUnlocked: number;
  elapsedMs: number;
}

export async function backfillNarrativeCounters(
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<BackfillStats> {
  const { dryRun = false } = options;

  console.log("⚙️  Starting narrative counters backfill...");
  if (dryRun) {
    console.log("   [DRY RUN] Mode enabled — scanning records without modifying database.");
  }
  const startedAt = Date.now();

  // 1. Inspect source records to determine affected cohort
  const [completionsRes] = await dbRead
    .select({ cnt: countDistinct(userCompletedBooks.userId) })
    .from(userCompletedBooks);
  const [progressRes] = await dbRead
    .select({ cnt: countDistinct(userPageProgress.userId) })
    .from(userPageProgress);

  const stats: BackfillStats = {
    usersWithCompletions: Number(completionsRes?.cnt ?? 0),
    usersWithProgress: Number(progressRes?.cnt ?? 0),
    badgesUnlocked: 0,
    elapsedMs: 0,
  };

  if (dryRun) {
    console.log(`\n🔍 [DRY RUN] Inspection complete:`);
    console.log(`   Users with book completions: ${stats.usersWithCompletions}`);
    console.log(`   Users with reading choices:   ${stats.usersWithProgress}`);
    console.log(`   [DRY RUN] All counter CTEs and retroactive badge checks would execute for these users.`);
    stats.elapsedMs = Date.now() - startedAt;
    return stats;
  }

  try {
    // 2. Execute all counter updates inside a single atomic transaction
    await dbWrite.transaction(async (tx) => {
      await runCounterUpdates(tx);
    });

    // 3. Retroactively evaluate achievements (outside transaction — idempotent by design)
    console.log("  → Re-evaluating achievement badges...");
    const activeUsers = await dbRead
      .select({ userId: userCounters.userId })
      .from(userCounters);

    let unlockedTotal = 0;
    let processedUsers = 0;
    for (const { userId } of activeUsers) {
      const newlyUnlocked = await checkAndAwardAchievements(userId);
      unlockedTotal += newlyUnlocked.length;
      processedUsers++;
      if (unlockedTotal > 0 && unlockedTotal % 50 === 0) {
        console.log(`     ... ${unlockedTotal} badges unlocked so far (${processedUsers}/${activeUsers.length} users)`);
      }
    }
    stats.badgesUnlocked = unlockedTotal;
    stats.elapsedMs = Date.now() - startedAt;

    logStats(stats);
    return stats;
  } catch (error) {
    console.error("❌ Failed to backfill narrative counters:", error);
    throw error;
  }
}

/**
 * Execute pre-seeding and all 8 counter-update CTE statements.
 *
 * @param client - Transaction client `tx` for atomic writes
 */
async function runCounterUpdates(client: DBClient): Promise<void> {
  // 0. Ensure user_counters rows exist for all active readers
  console.log("  → Ensuring user_counters exist for all active readers...");
  await client.execute(sql`
    INSERT INTO user_counters (user_id, updated_at)
    SELECT DISTINCT user_id, NOW() FROM user_completed_books
    ON CONFLICT (user_id) DO NOTHING;
  `);
  await client.execute(sql`
    INSERT INTO user_counters (user_id, updated_at)
    SELECT DISTINCT user_id, NOW() FROM user_page_progress
    ON CONFLICT (user_id) DO NOTHING;
  `);

  // 1. stories_completed and alternate_endings_discovered
  console.log("  → Aggregating stories completed and alternate endings...");
  await client.execute(sql`
    WITH user_completions AS (
      SELECT
        user_id,
        COUNT(DISTINCT book_id) AS distinct_books,
        COUNT(page_id) AS total_endings
      FROM user_completed_books
      GROUP BY user_id
    )
    UPDATE user_counters uc
    SET
      stories_completed = uc_agg.distinct_books,
      alternate_endings_discovered = GREATEST(0, uc_agg.total_endings - uc_agg.distinct_books),
      updated_at = NOW()
    FROM user_completions uc_agg
    WHERE uc.user_id = uc_agg.user_id;
  `);

  // 2. deep_branch_completions (15+ pages on divergent branch)
  console.log("  → Aggregating deep branch completions...");
  await client.execute(sql`
    WITH deep_completions AS (
      SELECT
        ucb.user_id,
        COUNT(*) AS deep_count
      FROM user_completed_books ucb
      JOIN pages p ON p.id = ucb.page_id
      WHERE p.page >= 15 AND p.branch_id != 'main'
      GROUP BY ucb.user_id
    )
    UPDATE user_counters uc
    SET
      deep_branch_completions = dc.deep_count,
      updated_at = NOW()
    FROM deep_completions dc
    WHERE uc.user_id = dc.user_id;
  `);

  // 3. distinct_ending_types_reached
  console.log("  → Aggregating distinct psychological ending types reached...");
  await client.execute(sql`
    WITH ending_types AS (
      SELECT
        ucb.user_id,
        COUNT(DISTINCT (p.delta->'viableEnding'->>'type')) AS distinct_types
      FROM user_completed_books ucb
      JOIN pages p ON p.id = ucb.page_id
      WHERE p.delta->'viableEnding'->>'type' IS NOT NULL
      GROUP BY ucb.user_id
    )
    UPDATE user_counters uc
    SET
      distinct_ending_types_reached = et.distinct_types,
      updated_at = NOW()
    FROM ending_types et
    WHERE uc.user_id = et.user_id;
  `);

  // 4. rare_endings_found
  console.log("  → Aggregating rare endings found...");
  await client.execute(sql`
    WITH rare_endings AS (
      SELECT
        ucb.user_id,
        COUNT(*) AS rare_count
      FROM user_completed_books ucb
      JOIN books b ON b.id = ucb.book_id
      WHERE b.complete_count <= 5 OR b.completion_rate < 20
      GROUP BY ucb.user_id
    )
    UPDATE user_counters uc
    SET
      rare_endings_found = re.rare_count,
      updated_at = NOW()
    FROM rare_endings re
    WHERE uc.user_id = re.user_id;
  `);

  // 5. branch_points_explored (choices diverging onto non-main branches)
  console.log("  → Aggregating branch points explored...");
  await client.execute(sql`
    WITH branch_forks AS (
      SELECT upp.user_id, COUNT(*) AS fork_count
      FROM user_page_progress upp
      JOIN pages p ON p.id = upp.next_page_id
      WHERE p.branch_id IS NOT NULL AND p.branch_id != 'main'
      GROUP BY upp.user_id
    )
    UPDATE user_counters uc
    SET branch_points_explored = bf.fork_count,
        updated_at = NOW()
    FROM branch_forks bf
    WHERE uc.user_id = bf.user_id;
  `);

  // 6. high_risk_choices_taken (perilous decisions)
  console.log("  → Aggregating high-risk choices taken...");
  await client.execute(sql`
    WITH risk_choices AS (
      SELECT upp.user_id, COUNT(*) AS risk_count
      FROM user_page_progress upp
      WHERE (upp.action->>'type' IN ('attack', 'risk', 'escape', 'deceive'))
         OR (upp.action->'risk'->>'severity' IN ('high', 'extreme'))
         OR (COALESCE((upp.action->'risk'->>'isHighRisk')::boolean, false) = true)
      GROUP BY upp.user_id
    )
    UPDATE user_counters uc
    SET high_risk_choices_taken = rc.risk_count,
        updated_at = NOW()
    FROM risk_choices rc
    WHERE uc.user_id = rc.user_id;
  `);

  // 7. consequence_experienced (choice fallout & narrative repercussions)
  console.log("  → Aggregating consequence experiences...");
  await client.execute(sql`
    WITH consequence_choices AS (
      SELECT upp.user_id, COUNT(*) AS conseq_count
      FROM user_page_progress upp
      WHERE (upp.action->>'type' = 'consequence')
         OR (upp.action->>'source' = 'consequence')
         OR (upp.action->'hint'->>'type' IN ('betrayal', 'confrontation'))
      GROUP BY upp.user_id
    )
    UPDATE user_counters uc
    SET consequence_experienced = cc.conseq_count,
        updated_at = NOW()
    FROM consequence_choices cc
    WHERE uc.user_id = cc.user_id;
  `);

  // 8. threads_resolved & clues_uncovered from terminal story states
  console.log("  → Aggregating narrative threads resolved and clues uncovered...");
  await client.execute(sql`
    WITH thread_clue_agg AS (
      SELECT
        ucb.user_id,
        SUM(COALESCE((
          SELECT COUNT(*)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ss.threads) = 'array' THEN ss.threads ELSE '[]'::jsonb END) t
          WHERE t->>'status' = 'closed'
        ), 0)) AS resolved_count,
        SUM(COALESCE((
          SELECT COUNT(*)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ss.threads) = 'array' THEN ss.threads ELSE '[]'::jsonb END) t,
               jsonb_array_elements(CASE WHEN jsonb_typeof(t->'clues') = 'array' THEN t->'clues' ELSE '[]'::jsonb END) c
        ), 0)) AS clue_count
      FROM user_completed_books ucb
      JOIN story_states ss ON ss.page_id = ucb.page_id
      GROUP BY ucb.user_id
    )
    UPDATE user_counters uc
    SET threads_resolved = tca.resolved_count,
        clues_uncovered = tca.clue_count,
        updated_at = NOW()
    FROM thread_clue_agg tca
    WHERE uc.user_id = tca.user_id;
  `);
}

function logStats(stats: BackfillStats): void {
  console.log("\n📊 Backfill Summary:");
  console.log(`   Users with completions:  ${stats.usersWithCompletions}`);
  console.log(`   Users with progress:     ${stats.usersWithProgress}`);
  console.log(`   Badges unlocked:         ${stats.badgesUnlocked}`);
  console.log(`   Elapsed:                 ${stats.elapsedMs}ms`);
  console.log("✅ Backfill complete.");
}

// Allow direct CLI execution: bun src/scripts/backfill-narrative.ts [--force] [--dry-run]
if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  backfillNarrativeCounters({ force, dryRun })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
