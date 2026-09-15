/**
 * @summary One-time migration backfill for user narrative accomplishment counters
 * @description Computes historical stories_completed, alternate_endings_discovered,
 * deep_branch_completions, distinct_ending_types_reached, and rare_endings_found
 * from user_completed_books and awards retroactive badges.
 */
import { dbWrite, dbRead } from "../db/client.js";
import { userCounters } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { checkAndAwardAchievements } from "../services/achievements.js";

export async function backfillNarrativeCounters(): Promise<void> {
  console.log("⚙️ Starting narrative counters backfill...");
  const startedAt = Date.now();

  try {
    // 1. Backfill stories_completed and alternate_endings_discovered
    console.log("  → Aggregating stories completed and alternate endings...");
    await dbWrite.execute(sql`
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

    // 2. Backfill deep_branch_completions (15+ pages on divergent branch)
    console.log("  → Aggregating deep branch completions...");
    await dbWrite.execute(sql`
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

    // 3. Backfill distinct_ending_types_reached
    console.log("  → Aggregating distinct psychological ending types reached...");
    await dbWrite.execute(sql`
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

    // 4. Backfill rare_endings_found
    console.log("  → Aggregating rare endings found...");
    await dbWrite.execute(sql`
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

    // 5. Retroactively evaluate achievements for active users
    console.log("  → Re-evaluating achievement badges for users with completions...");
    const activeUsers = await dbRead
      .select({ userId: userCounters.userId })
      .from(userCounters);

    let unlockedTotal = 0;
    for (const { userId } of activeUsers) {
      const newlyUnlocked = await checkAndAwardAchievements(userId);
      unlockedTotal += newlyUnlocked.length;
    }

    const elapsed = Date.now() - startedAt;
    console.log(`✅ Backfill complete in ${elapsed}ms! Unlocked ${unlockedTotal} retroactive badges across ${activeUsers.length} users.`);
  } catch (error) {
    console.error("❌ Failed to backfill narrative counters:", error);
    throw error;
  }
}

// Allow direct CLI execution: bun src/scripts/backfill-narrative.ts
if (import.meta.main) {
  backfillNarrativeCounters()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
