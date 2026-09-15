import { notInArray } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { userAchievements, userCounters } from '../db/schema.js';
import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';
import { checkAndAwardAchievements } from '../services/achievements.js';

/**
 * Re-alignment script for Twistloom Achievement System.
 * 
 * Synchronizes user_achievements table with the newly calibrated
 * longevity thresholds and canonical achievement rule IDs:
 * 1. Prunes obsolete achievement IDs that are no longer part of ACHIEVEMENT_REGISTRY.
 * 2. Evaluates all users in user_counters against the 100 canonical rules.
 * 3. Idempotently awards badges that users qualify for under the new thresholds.
 * 
 * Usage:
 *   bun --env-file=.env.production src/scripts/realign-achievements.ts
 */
async function realignAchievements() {
  console.log('⚙️  Starting achievement database re-alignment...');

  const validRuleIds = ACHIEVEMENT_REGISTRY.map((r) => r.id);
  console.log(`  → Loaded ${validRuleIds.length} canonical achievement rules from SSOT.`);

  // 1. Find and purge obsolete achievement IDs
  const obsoleteRows = await dbRead
    .select({ id: userAchievements.id, achievementId: userAchievements.achievementId, userId: userAchievements.userId })
    .from(userAchievements)
    .where(notInArray(userAchievements.achievementId, validRuleIds));

  console.log(`  → Found ${obsoleteRows.length} obsolete achievement records in user_achievements.`);

  if (obsoleteRows.length > 0) {
    const deleted = await dbWrite
      .delete(userAchievements)
      .where(notInArray(userAchievements.achievementId, validRuleIds))
      .returning({ id: userAchievements.id });
    console.log(`  ✅ Purged ${deleted.length} obsolete achievement records.`);
  }

  // 2. Fetch all user IDs from user_counters
  const users = await dbRead
    .select({ userId: userCounters.userId })
    .from(userCounters);

  console.log(`  → Re-evaluating achievement qualifications for ${users.length} active users...`);

  let totalNewBadges = 0;
  let usersUpdated = 0;

  for (const user of users) {
    try {
      const newlyAwarded = await checkAndAwardAchievements(user.userId);
      if (newlyAwarded.length > 0) {
        totalNewBadges += newlyAwarded.length;
        usersUpdated++;
      }
    } catch (err) {
      console.error(`  ⚠️ Failed to re-align user ${user.userId}:`, err);
    }
  }

  console.log('\n📊 Re-alignment Summary:');
  console.log(`  • Canonical Rules in SSOT: ${validRuleIds.length}`);
  console.log(`  • Obsolete Badges Purged:  ${obsoleteRows.length}`);
  console.log(`  • Total Users Evaluated:   ${users.length}`);
  console.log(`  • Users Awarded New Badges: ${usersUpdated}`);
  console.log(`  • Badges Awarded:          ${totalNewBadges}`);
  console.log('✨ Achievement database re-alignment complete!\n');

  process.exit(0);
}

realignAchievements().catch((err) => {
  console.error('❌ Failed to re-align achievements:', err);
  process.exit(1);
});
