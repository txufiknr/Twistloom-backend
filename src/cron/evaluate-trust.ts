/**
 * Trust Score Batch Evaluation Cron Job
 *
 * Runs daily to re-evaluate all users with active enforcement actions
 * or recent violation events. Applies exponential time-decay to reduce
 * the impact of older violations, recalculates risk tiers, and sets
 * probation periods as needed.
 *
 * Schedule: Daily at 04:00 UTC (off-peak)
 *
 * @see services/trust-score.ts — Core scoring engine
 * @see docs/architecture/TRUST_AND_SAFETY_ARCHITECTURE.md §6
 */

import { batchEvaluateTrustScores } from "../services/trust-score.js";

export async function evaluateTrustScores(): Promise<void> {
  console.log("[TrustScore] 🚀 Starting daily trust score evaluation...");

  const result = await batchEvaluateTrustScores();

  console.log("[TrustScore] 📊 Summary:");
  console.log(`  - Users evaluated: ${result.evaluatedCount}`);
  console.log(`  - Tier changes: ${result.tierChanges}`);
  console.log(`  - Scores changed: ${result.scoresChanged}`);
  console.log(`  - Probations set: ${result.probationSet}`);

  if (result.errors.length > 0) {
    console.error(`[TrustScore] ⚠️ ${result.errors.length} errors encountered:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
  }

  console.log("[TrustScore] ✅ Daily trust score evaluation complete.");
}
