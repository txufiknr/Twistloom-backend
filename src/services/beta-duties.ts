import { eq, and, sql, inArray } from 'drizzle-orm';
import { dbRead, dbWrite, type DBTransaction } from '../db/client.js';
import {
  userBetaDuties,
  users,
  books,
  pages,
  userFeedbacks,
  platformTestimonials,
} from '../db/schema.js';
import { BETA_DUTY_REGISTRY } from '../config/beta-duties.js';
import { addCredits } from './credits.js';
import { logUserActivity } from './user.js';
import { invalidateUserProfileCache } from './cache.js';
import type { BetaDutyStatus, UserBetaDutyState, BetaDutiesSummary } from '../types/beta-duties.js';

interface BetaDutiesMetrics {
  hasPenBook: boolean;
  hasPublishedPage: boolean;
  hasFinishedBook: boolean;
  hasFeedback: boolean;
  hasTestimony: boolean;
}

/**
 * Loads raw metric inputs for beta duty evaluation.
 */
async function loadBetaDutiesMetrics(userId: string): Promise<BetaDutiesMetrics> {
  const [penBooks, feedbackRows, testimonyRows] = await Promise.all([
    dbRead
      .select({ id: books.id, authoringStatus: books.authoringStatus })
      .from(books)
      .where(and(eq(books.userId, userId), eq(books.isPenBook, true))),

    dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userFeedbacks)
      .where(eq(userFeedbacks.userId, userId)),

    dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(platformTestimonials)
      .where(and(eq(platformTestimonials.userId, userId), sql`${platformTestimonials.status} != 'rejected'`)),
  ]);

  const hasPenBook = penBooks.length > 0;
  const hasFinishedBook = penBooks.some((b) => b.authoringStatus === 'complete');
  const hasFeedback = (feedbackRows[0]?.count ?? 0) > 0;
  const hasTestimony = (testimonyRows[0]?.count ?? 0) > 0;

  let hasPublishedPage = false;
  if (hasPenBook) {
    const penBookIds = penBooks.map((b) => b.id);
    const [pageRow] = await dbRead
      .select({ bookId: pages.bookId })
      .from(pages)
      .where(inArray(pages.bookId, penBookIds))
      .limit(1);
    hasPublishedPage = !!pageRow;
  }

  return {
    hasPenBook,
    hasPublishedPage,
    hasFinishedBook,
    hasFeedback,
    hasTestimony,
  };
}

/**
 * Evaluates live database signals against the registry and persists newly completed duties.
 *
 * @param userId - User to evaluate
 * @returns Array of duty IDs that were newly marked completed
 */
export async function evaluateBetaDuties(userId: string): Promise<string[]> {
  const metrics = await loadBetaDutiesMetrics(userId);

  const completionMap: Record<string, boolean> = {
    bd_create_pen: metrics.hasPenBook,
    bd_publish_page: metrics.hasPublishedPage,
    bd_finish_writing: metrics.hasFinishedBook,
    bd_send_feedback: metrics.hasFeedback,
    bd_platform_testimony: metrics.hasTestimony,
  };

  const existingRows = await dbRead
    .select({ dutyId: userBetaDuties.dutyId, status: userBetaDuties.status })
    .from(userBetaDuties)
    .where(eq(userBetaDuties.userId, userId));

  const existingMap = new Map(existingRows.map((r) => [r.dutyId, r.status]));
  const newlyCompleted: string[] = [];

  for (const rule of BETA_DUTY_REGISTRY) {
    const isMet = completionMap[rule.id] ?? false;
    const currentStatus = existingMap.get(rule.id);

    if (isMet && !currentStatus) {
      await dbWrite
        .insert(userBetaDuties)
        .values({
          userId,
          dutyId: rule.id,
          status: 'completed',
          completedAt: new Date(),
        })
        .onConflictDoNothing();

      await logUserActivity({
        userId,
        activityType: 'beta_duty_completed',
        targetType: 'duty',
        metadata: { dutyId: rule.id },
      });

      newlyCompleted.push(rule.id);
    }
  }

  return newlyCompleted;
}

/**
 * Retrieves the full user beta duties state (evaluating on read).
 */
export async function getUserBetaDuties(userId: string): Promise<UserBetaDutyState[]> {
  // Sync live database completions before reading
  await evaluateBetaDuties(userId);

  const rows = await dbRead
    .select()
    .from(userBetaDuties)
    .where(eq(userBetaDuties.userId, userId));

  const stateMap = new Map(rows.map((r) => [r.dutyId, r]));

  return BETA_DUTY_REGISTRY.map((rule) => {
    const state = stateMap.get(rule.id);
    const status: BetaDutyStatus = state?.status ?? 'in_progress';

    return {
      id: rule.id,
      titleKey: rule.titleKey,
      descriptionKey: rule.descriptionKey,
      rewardCredits: rule.rewardCredits,
      status,
      completedAt: state?.completedAt ? state.completedAt.toISOString() : null,
      claimedAt: state?.claimedAt ? state.claimedAt.toISOString() : null,
      actionPath: rule.actionPath,
      iconName: rule.iconName,
      order: rule.order,
    };
  });
}

/**
 * Summarizes duty states for badges and progress UI.
 */
export function summarizeBetaDuties(duties: UserBetaDutyState[]): BetaDutiesSummary {
  const claimable = duties.filter((d) => d.status === 'completed');
  const finished = duties.filter((d) => d.status === 'completed' || d.status === 'claimed');

  return {
    completed: finished.length,
    claimable: claimable.length,
    totalReward: duties.reduce((sum, d) => sum + d.rewardCredits, 0),
    unclaimedReward: claimable.reduce((sum, d) => sum + d.rewardCredits, 0),
    allDone: finished.length === duties.length,
  };
}

/**
 * Atomically claims a single beta duty's credit reward.
 */
export async function claimBetaDutyReward(
  userId: string,
  dutyId: string,
): Promise<{
  status: 'claimed' | 'already_claimed' | 'not_completed' | 'not_found';
  creditsAwarded: number;
  newBalance: number;
}> {
  const rule = BETA_DUTY_REGISTRY.find((r) => r.id === dutyId);
  if (!rule) {
    return { status: 'not_found', creditsAwarded: 0, newBalance: 0 };
  }

  return dbWrite.transaction(async (tx: DBTransaction) => {
    const [claimed] = await tx
      .update(userBetaDuties)
      .set({ status: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(userBetaDuties.userId, userId),
          eq(userBetaDuties.dutyId, dutyId),
          eq(userBetaDuties.status, 'completed'),
        ),
      )
      .returning({ id: userBetaDuties.id });

    if (!claimed) {
      const [existing] = await tx
        .select({ status: userBetaDuties.status, credits: users.credits })
        .from(userBetaDuties)
        .innerJoin(users, eq(users.userId, userId))
        .where(and(eq(userBetaDuties.userId, userId), eq(userBetaDuties.dutyId, dutyId)))
        .limit(1);

      if (!existing) {
        return { status: 'not_completed', creditsAwarded: 0, newBalance: 0 };
      }
      const status = existing.status === 'claimed' ? 'already_claimed' : 'not_completed';
      return { status, creditsAwarded: 0, newBalance: existing.credits };
    }

    const newBalance = await addCredits(userId, rule.rewardCredits, {
      context: 'beta_duty_reward',
      metadata: { dutyId },
      tx,
    });

    await logUserActivity(
      {
        userId,
        activityType: 'beta_duty_reward_claimed',
        targetType: 'duty',
        targetId: claimed.id,
        metadata: { dutyId: rule.id, creditsAwarded: rule.rewardCredits },
      },
      { client: tx },
    );

    return {
      status: 'claimed',
      creditsAwarded: rule.rewardCredits,
      newBalance,
    };
  });
}

/**
 * Atomically claims all completed beta duties in a single transaction.
 */
export async function claimAllBetaDutyRewards(
  userId: string,
): Promise<{
  status: 'claimed' | 'none_claimable';
  claimedCount: number;
  creditsAwarded: number;
  newBalance: number;
}> {
  return dbWrite.transaction(async (tx: DBTransaction) => {
    const claimable = await tx
      .select({ dutyId: userBetaDuties.dutyId })
      .from(userBetaDuties)
      .where(and(eq(userBetaDuties.userId, userId), eq(userBetaDuties.status, 'completed')));

    if (claimable.length === 0) {
      const [user] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);
      return { status: 'none_claimable', claimedCount: 0, creditsAwarded: 0, newBalance: user?.credits ?? 0 };
    }

    const dutyIds = claimable.map((r) => r.dutyId);
    const rewardByDutyId = new Map<string, number>(BETA_DUTY_REGISTRY.map((r) => [r.id, r.rewardCredits]));
    const totalReward = dutyIds.reduce((sum, id) => sum + (rewardByDutyId.get(id) ?? 0), 0);

    await tx
      .update(userBetaDuties)
      .set({ status: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userBetaDuties.userId, userId), eq(userBetaDuties.status, 'completed')));

    const newBalance = await addCredits(userId, totalReward, {
      context: 'beta_duty_reward',
      metadata: { dutyIds },
      tx,
    });

    await logUserActivity(
      {
        userId,
        activityType: 'beta_duty_reward_claimed',
        targetType: 'duty',
        metadata: { creditsAwarded: totalReward, dutyCount: dutyIds.length, dutyIds },
      },
      { client: tx },
    );

    return {
      status: 'claimed',
      claimedCount: dutyIds.length,
      creditsAwarded: totalReward,
      newBalance,
    };
  });
}

/**
 * Claim single duty and invalidate user cache.
 */
export async function claimBetaDutyRewardAndInvalidate(userId: string, dutyId: string) {
  const result = await claimBetaDutyReward(userId, dutyId);
  if (result.status === 'claimed') {
    await invalidateUserProfileCache(userId);
  }
  return result;
}

/**
 * Claim all duties and invalidate user cache.
 */
export async function claimAllBetaDutyRewardsAndInvalidate(userId: string) {
  const result = await claimAllBetaDutyRewards(userId);
  if (result.status === 'claimed') {
    await invalidateUserProfileCache(userId);
  }
  return result;
}

/**
 * Explicit re-check function.
 */
export async function recheckBetaDuties(userId: string): Promise<string[]> {
  return evaluateBetaDuties(userId);
}
