import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { userCounters, userAchievements } from '../db/schema.js';
import { ACHIEVEMENT_REGISTRY } from '../config/achievements.js';
import type { AchievementMetric } from '../types/achievements.js';
import type { UserAchievement } from '../types/user.js';

// ── Reader Mastery Types ────────────────────────────────────────────────────

export type MasteryArchetype =
  | 'explorer'    // branch points explored
  | 'seeker'      // secrets and rare endings found
  | 'survivor'    // stories completed, especially under tension
  | 'worldwalker' // multiverse exploration breadth
  | 'storyteller' // custom actions, wall posts, community contribution
  | 'chronicler'; // threads resolved, narrative depth

export interface ReaderMasteryScores {
  explorer: number;
  seeker: number;
  survivor: number;
  worldwalker: number;
  storyteller: number;
  chronicler: number;
}

export interface ReaderMastery {
  primary: MasteryArchetype;
  secondary: MasteryArchetype;
  tertiary: MasteryArchetype;
  scores: ReaderMasteryScores;
}

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
      tier: rule.tier,
      category: rule.category,
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

// ── Reader Mastery ─────────────────────────────────────────────────────────

/**
 * Normalize a metric value to a 0–100 score.
 */
function normalizeMetric(value: number, maxThreshold: number): number {
  return Math.min(100, Math.round((value / maxThreshold) * 100));
}

/**
 * Compute a user's Reader Mastery — a multidimensional identity derived
 * from existing achievement metrics. No new tables needed; this is a
 * computed view of `user_counters` data.
 *
 * Each archetype maps to a combination of metrics:
 *  - explorer:    branchesOpened
 *  - seeker:      easterEggsFound + endingsSharedToWall
 *  - survivor:    booksCompleted
 *  - worldwalker: branchesOpened + endingsSharedToWall (breadth)
 *  - storyteller: customActionsWritten + wallNotesPosted
 *  - chronicler:  wallNoteLikesReceived (narrative resonance)
 */
export async function computeReaderMastery(userId: string): Promise<ReaderMastery> {
  const metrics = await getUserMetrics(userId);

  const scores: ReaderMasteryScores = {
    explorer: normalizeMetric(metrics.branchesOpened, 100),
    seeker: normalizeMetric(metrics.easterEggsFound + metrics.endingsSharedToWall, 50),
    survivor: normalizeMetric(metrics.booksCompleted, 50),
    worldwalker: normalizeMetric(metrics.endingsSharedToWall + metrics.branchesOpened, 100),
    storyteller: normalizeMetric(metrics.customActionsWritten + metrics.wallNotesPosted, 50),
    chronicler: normalizeMetric(metrics.wallNoteLikesReceived, 100),
  };

  const sorted = (Object.entries(scores) as [MasteryArchetype, number][])
    .sort(([, a], [, b]) => b - a);

  return {
    primary: sorted[0][0],
    secondary: sorted[1][0],
    tertiary: sorted[2][0],
    scores,
  };
}
