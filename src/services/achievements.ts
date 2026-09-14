import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { userCounters, userAchievements } from '../db/schema.js';
import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';
import type { AchievementMetric } from '../types/achievements.js';
import type { UserAchievement } from '../types/user.js';

export async function getUserAchievements(userId: string): Promise<UserAchievement[]> {
  // 1. Evaluate metrics right before serving, instantly triggering retroactive syncs
  await checkAndAwardAchievements(userId);

  const metrics = await getUserMetrics(userId);
  const unlockedRows = await dbRead
    .select()
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

  const unlockedMap = new Map(unlockedRows.map(r => [r.achievementId, r]));

  // 2. Map structural values over rules to assemble progress bar information
  const badges = ACHIEVEMENT_REGISTRY.map<UserAchievement>((rule) => {
    const unlockData = unlockedMap.get(rule.id);
    const currentValue = metrics[rule.metric];
    const isUnlocked = !!unlockData;
    
    const progressValue = Math.min(currentValue, rule.threshold);
    const progressPercent = Math.round((progressValue / rule.threshold) * 100);

    return {
      id: rule.id,
      title: rule.title,
      description: rule.description,
      badgeImageUrl: rule.badgeImageUrl,
      tier: rule.tier,
      currentProgress: currentValue,
      threshold: rule.threshold,
      progressPercent,
      isUnlocked,
      unlockedAt: unlockData ? unlockData.unlockedAt : null,
      isNotified: unlockData ? unlockData.isNotified : false, // Frontend can check if it needs to pop up
    };
  });

  return badges;
}

/**
 * Safe utility to query user statistics. Defaults to 0 if record doesn't exist yet.
 */
export async function getUserMetrics(userId: string) {
  const [stats] = await dbRead
    .select()
    .from(userCounters)
    .where(eq(userCounters.userId, userId))
    .limit(1);

  return {
    booksGenerated: stats?.booksGenerated ?? 0,
    booksCompleted: stats?.booksCompleted ?? 0,
    pagesRead: stats?.pagesRead ?? 0,
    pagesGenerated: stats?.pagesGenerated ?? 0,
    branchesOpened: stats?.branchesOpened ?? 0,
    topupCredits: stats?.topupCredits ?? 0,
    referredUsers: stats?.referredUsers ?? 0,
    followersCount: stats?.followersCount ?? 0,
    maxCheckinStreak: stats?.maxCheckinStreak ?? 0,
    customActionsWritten: stats?.customActionsWritten ?? 0,
    easterEggsFound: stats?.easterEggsFound ?? 0,
    creatorsSupported: stats?.creatorsSupported ?? 0,
    wallNotesPosted: stats?.wallNotesPosted ?? 0,
    wallNoteLikesReceived: stats?.wallNoteLikesReceived ?? 0,
    endingsSharedToWall: stats?.endingsSharedToWall ?? 0,
  } satisfies Record<AchievementMetric, number>;
}

/**
 * Evaluates real-time stats against rules. Automatically calculates retroactively
 * if new rules are deployed to the registry code file.
 */
export async function checkAndAwardAchievements(userId: string): Promise<string[]> {
  const metrics = await getUserMetrics(userId);
  const unlockedBadges = await dbRead
    .select({ achievementId: userAchievements.achievementId })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

  const unlockedIdsSet = new Set(unlockedBadges.map((b) => b.achievementId));
  const newlyUnlocked: string[] = [];
  const toInsert: Array<{ userId: string; achievementId: string; isNotified: boolean }> = [];

  for (const rule of ACHIEVEMENT_REGISTRY) {
    if (unlockedIdsSet.has(rule.id)) continue; // Already awarded

    const userValue = metrics[rule.metric];
    if (userValue >= rule.threshold) {
      toInsert.push({
        userId,
        achievementId: rule.id,
        isNotified: false, // Flagged for frontend celebratory animation
      });
      newlyUnlocked.push(rule.id);
    }
  }

  if (toInsert.length > 0) {
    await dbWrite
      .insert(userAchievements)
      .values(toInsert)
      .onConflictDoNothing();
  }

  return newlyUnlocked;
}
