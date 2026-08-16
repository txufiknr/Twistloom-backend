import { eq, and, sql } from 'drizzle-orm';
import { dbRead, dbWrite, type DBTransaction } from '../db/client.js';
import {
  userCounters,
  userQuests,
  users,
  userLikes,
  userFavorites,
  userFollows,
  bookTestimonials,
  userCompletedBooks,
  userPageProgress,
  userSessions,
  pages,
  books,
  penSessions,
  penEdits,
  canonValidations,
} from '../db/schema.js';
import { QUEST_REGISTRY } from '../config/quests.js';
import { addCredits } from './credits.js';
import { logUserActivity } from './user.js';
import { invalidateUserProfileCache } from './cache.js';
import type { QuestDetector, QuestStatus, UserQuestState } from '../types/quests.js';

/**
 * Aggregate snapshot of every value a detector can read. Computed once per
 * evaluation and reused across all registry rules, so a full quest-log read
 * costs a fixed handful of user-scoped, indexed queries rather than one query
 * per quest.
 */
interface QuestMetricSnapshot {
  counters: Partial<Record<'booksGenerated' | 'booksCompleted' | 'pagesRead' | 'pagesGenerated' | 'branchesOpened' | 'followersCount' | 'customActionsWritten', number>>;
  profileComplete: boolean;
  likes: number;
  favorites: number;
  follows: number;
  testimonials: number;
  completedBooks: number;
  nonMainBranch: number;
  distinctBooks: number;
  distinctAuthors: number;
  novelBooks: number;
  multiverseBooks: number;
  thrillerBooks: number;
  resumedSessions: number;
  distinctBranchContexts: number;
  penSessions: number;
  penEdits: Partial<Record<string, number>>;
  authorPages: number;
  publishedBook: boolean;
  canonValidations: number;
}

/**
 * Loads every value quest detectors can read, for one user.
 *
 * All queries are user-scoped and backed by the existing indexes on each
 * table. This is the evaluate-on-read analog of `getUserMetrics` in the
 * achievements service, extended with the derived aggregates that quests need.
 *
 * @param userId - User whose data is measured
 * @returns A flat snapshot of all detector inputs
 */
async function loadQuestMetrics(userId: string): Promise<QuestMetricSnapshot> {
  const [
    countersRows,
    profileRows,
    likesRows,
    favoritesRows,
    followsRows,
    testimonialsRows,
    completedRows,
    nonMainRows,
    distinctBooksRows,
    authorsRows,
    modeRows,
    thrillerRows,
    resumedRows,
    branchRows,
    penSessionRows,
    penEditRows,
    authorPageRows,
    publishedRows,
    canonRows,
  ] = await Promise.all([
    dbRead.select().from(userCounters).where(eq(userCounters.userId, userId)).limit(1),

    dbRead
      .select({
        isNewUser: users.isNewUser,
        name: users.name,
        bio: users.bio,
        imageUrl: users.imageUrl,
        gender: users.gender,
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userLikes)
      .where(and(eq(userLikes.userId, userId), eq(userLikes.targetType, 'book'))),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userFavorites)
      .where(eq(userFavorites.userId, userId)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userFollows)
      .where(eq(userFollows.followerId, userId)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(bookTestimonials)
      .where(eq(bookTestimonials.userId, userId)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userCompletedBooks)
      .where(eq(userCompletedBooks.userId, userId)),

    // Alternate / hidden endings: completions whose ending page lives on a
    // non-main branch (pages.branch_id != 'main').
    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userCompletedBooks)
      .innerJoin(pages, eq(userCompletedBooks.pageId, pages.id))
      .where(and(eq(userCompletedBooks.userId, userId), sql`${pages.branchId} != 'main'`)),

    // Distinct books read (one open session per book).
    dbRead
      .select({ value: sql<number>`count(distinct ${userSessions.bookId})::int` })
      .from(userSessions)
      .where(eq(userSessions.userId, userId)),

    // Distinct authors across the user's reads.
    dbRead
      .select({ value: sql<number>`count(distinct ${books.userId})::int` })
      .from(userSessions)
      .innerJoin(books, eq(userSessions.bookId, books.id))
      .where(and(eq(userSessions.userId, userId), sql`${books.userId} IS NOT NULL`)),

    // User's own books by mode.
    dbRead
      .select({ mode: books.mode, value: sql<number>`count(*)::int` })
      .from(books)
      .where(and(eq(books.userId, userId), sql`${books.mode} IS NOT NULL`))
      .groupBy(books.mode),

    // Distinct psychological-thriller books read (keywords carry a psychological prefix).
    dbRead
      .select({ value: sql<number>`count(distinct ${userSessions.bookId})::int` })
      .from(userSessions)
      .innerJoin(books, eq(userSessions.bookId, books.id))
      .where(and(
        eq(userSessions.userId, userId),
        sql`exists (select 1 from unnest(${books.keywords}) kw where kw ilike 'psychological%')`,
      )),

    // Sessions resumed (updated after created).
    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), sql`${userSessions.updatedAt} > ${userSessions.createdAt}`)),

    // Distinct (book, branch) contexts the reader actually progressed through.
    dbRead
      .select({ value: sql<number>`count(distinct (${userPageProgress.bookId}, ${pages.branchId}))::int` })
      .from(userPageProgress)
      .innerJoin(pages, eq(userPageProgress.actionedPageId, pages.id))
      .where(eq(userPageProgress.userId, userId)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(penSessions)
      .where(eq(penSessions.userId, userId)),

    dbRead
      .select({ editType: penEdits.editType, value: sql<number>`count(*)::int` })
      .from(penEdits)
      .where(eq(penEdits.userId, userId))
      .groupBy(penEdits.editType),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(pages)
      .where(eq(pages.humanAuthorUserId, userId)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(books)
      .where(and(eq(books.userId, userId), eq(books.status, 'active'), sql`${books.visibility} != 'private'`)),

    dbRead
      .select({ value: sql<number>`count(*)::int` })
      .from(canonValidations)
      .innerJoin(books, eq(canonValidations.bookId, books.id))
      .where(eq(books.userId, userId)),
  ]);

  const counters = countersRows[0] ?? {};
  const profile = profileRows[0];
  const modeMap = new Map(modeRows.map((r) => [r.mode, r.value ?? 0]));

  return {
    counters: {
      booksGenerated: counters.booksGenerated ?? 0,
      booksCompleted: counters.booksCompleted ?? 0,
      pagesRead: counters.pagesRead ?? 0,
      pagesGenerated: counters.pagesGenerated ?? 0,
      branchesOpened: counters.branchesOpened ?? 0,
      followersCount: counters.followersCount ?? 0,
      customActionsWritten: counters.customActionsWritten ?? 0,
    },
    profileComplete: !!profile && profile.isNewUser === false && !!profile.name &&
      (!!profile.bio || !!profile.imageUrl || !!profile.gender),
    likes: likesRows[0]?.value ?? 0,
    favorites: favoritesRows[0]?.value ?? 0,
    follows: followsRows[0]?.value ?? 0,
    testimonials: testimonialsRows[0]?.value ?? 0,
    completedBooks: completedRows[0]?.value ?? 0,
    nonMainBranch: nonMainRows[0]?.value ?? 0,
    distinctBooks: distinctBooksRows[0]?.value ?? 0,
    distinctAuthors: authorsRows[0]?.value ?? 0,
    novelBooks: modeMap.get('novel') ?? 0,
    multiverseBooks: modeMap.get('multiverse') ?? 0,
    thrillerBooks: thrillerRows[0]?.value ?? 0,
    resumedSessions: resumedRows[0]?.value ?? 0,
    distinctBranchContexts: branchRows[0]?.value ?? 0,
    penSessions: penSessionRows[0]?.value ?? 0,
    penEdits: Object.fromEntries(penEditRows.map((r) => [r.editType, r.value ?? 0])),
    authorPages: authorPageRows[0]?.value ?? 0,
    publishedBook: (publishedRows[0]?.value ?? 0) > 0,
    canonValidations: canonRows[0]?.value ?? 0,
  };
}

/**
 * Evaluates one detector against the snapshot, returning the current value,
 * the quest's threshold, and whether the goal is met.
 *
 * @param detector - The registry detector to evaluate
 * @param m - Loaded metric snapshot
 */
export function evaluateDetector(
  detector: QuestDetector,
  m: QuestMetricSnapshot,
): { current: number; threshold: number; completed: boolean } {
  let current = 0;
  let threshold = 1;

  switch (detector.kind) {
    case 'counter':
      threshold = detector.threshold;
      current = m.counters[detector.metric] ?? 0;
      break;
    case 'profile':
      threshold = detector.threshold;
      current = m.profileComplete ? 1 : 0;
      break;
    case 'likes':
      threshold = detector.threshold;
      current = m.likes;
      break;
    case 'favorites':
      threshold = detector.threshold;
      current = m.favorites;
      break;
    case 'follows':
      threshold = detector.threshold;
      current = m.follows;
      break;
    case 'testimonials':
      threshold = detector.threshold;
      current = m.testimonials;
      break;
    case 'completedBooks':
      threshold = detector.threshold;
      current = m.completedBooks;
      break;
    case 'nonMainBranch':
      threshold = detector.threshold;
      current = m.nonMainBranch;
      break;
    case 'distinctBooks':
      threshold = detector.threshold;
      current = m.distinctBooks;
      break;
    case 'distinctAuthors':
      threshold = detector.threshold;
      current = m.distinctAuthors;
      break;
    case 'bookMode':
      threshold = detector.threshold;
      current = detector.mode === 'novel' ? m.novelBooks : m.multiverseBooks;
      break;
    case 'thrillerGenre':
      threshold = detector.threshold;
      current = m.thrillerBooks;
      break;
    case 'resumedSession':
      threshold = detector.threshold;
      current = m.resumedSessions;
      break;
    case 'distinctBranchContexts':
      threshold = detector.threshold;
      current = m.distinctBranchContexts;
      break;
    case 'penSessions':
      threshold = detector.threshold;
      current = m.penSessions;
      break;
    case 'penEdits':
      threshold = detector.threshold;
      current = m.penEdits[detector.editType] ?? 0;
      break;
    case 'authorPages':
      threshold = detector.threshold;
      current = m.authorPages;
      break;
    case 'publishedBook':
      current = m.publishedBook ? 1 : 0;
      break;
    case 'canonValidations':
      threshold = detector.threshold;
      current = m.canonValidations;
      break;
  }

  return { current, threshold, completed: current >= threshold };
}

/**
 * Evaluates all enabled registry quests against the user's live data and
 * records newly-met quests as `completed` (mirrors `checkAndAwardAchievements`).
 *
 * Idempotent: a quest that is already `completed`/`claimed` is never re-written.
 *
 * @param userId - User to evaluate
 * @param m - Optional pre-loaded snapshot (skips re-querying)
 * @returns The quest ids that were newly marked completed
 */
export async function evaluateQuests(
  userId: string,
  m?: QuestMetricSnapshot,
): Promise<string[]> {
  const metrics = m ?? await loadQuestMetrics(userId);

  const existingRows = await dbRead
    .select({ questId: userQuests.questId })
    .from(userQuests)
    .where(eq(userQuests.userId, userId));

  const existingIds = new Set(existingRows.map((r) => r.questId));
  const newlyCompleted: string[] = [];

  for (const rule of QUEST_REGISTRY) {
    if (!rule.enabled || existingIds.has(rule.id)) continue;

    const { completed } = evaluateDetector(rule.detector, metrics);
    if (!completed) continue;

    await dbWrite
      .insert(userQuests)
      .values({
        userId,
        questId: rule.id,
        status: 'completed',
        completedAt: new Date(),
      })
      .onConflictDoNothing();

    newlyCompleted.push(rule.id);
  }

  return newlyCompleted;
}

/**
 * Builds the full `UserQuest` state for every enabled registry quest, using
 * the user's persisted progress (status/timestamps) and the live metric values.
 *
 * Disabled quests are omitted entirely so the UI never renders them.
 *
 * The metric snapshot is loaded exactly once and shared between the
 * evaluate-on-read pass and the progress rendering below — a separate load
 * would duplicate ~19 user-scoped queries per request for identical data.
 *
 * @param userId - User whose quest log is being read
 * @returns The ordered list of `UserQuestState` rows
 */
export async function getUserQuests(userId: string): Promise<UserQuestState[]> {
  const metrics = await loadQuestMetrics(userId);

  // Evaluate on read (like getUserAchievements) so retroactive completion syncs.
  await evaluateQuests(userId, metrics);

  const rows = await dbRead
    .select()
    .from(userQuests)
    .where(eq(userQuests.userId, userId));

  const stateMap = new Map(rows.map((r) => [r.questId, r]));

  return QUEST_REGISTRY
    .filter((rule) => rule.enabled)
    .map<UserQuestState>((rule) => {
      const state = stateMap.get(rule.id);
      const { current, threshold } = evaluateDetector(rule.detector, metrics);
      const status: QuestStatus = state?.status ?? 'in_progress';
      const progressPercent = threshold > 0
        ? Math.min(100, Math.round((current / threshold) * 100))
        : 0;

      return {
        id: rule.id,
        chapterId: rule.chapterId,
        title: rule.title,
        description: rule.description,
        rewardCredits: rule.rewardCredits,
        currentProgress: current,
        threshold,
        progressPercent,
        status,
        completedAt: state?.completedAt ? state.completedAt.toISOString() : null,
        claimedAt: state?.claimedAt ? state.claimedAt.toISOString() : null,
        enabled: rule.enabled,
      };
    });
}

/**
 * Computes the quest-log summary (completed / claimable / reward totals).
 *
 * @param quests - The full user quest state list
 */
export function summarizeQuests(quests: UserQuestState[]): {
  completed: number;
  claimable: number;
  totalReward: number;
  unclaimedReward: number;
} {
  const claimable = quests.filter((q) => q.status === 'completed');
  return {
    completed: claimable.length,
    claimable: claimable.length,
    totalReward: quests.reduce((sum, q) => sum + q.rewardCredits, 0),
    unclaimedReward: claimable.reduce((sum, q) => sum + q.rewardCredits, 0),
  };
}

/**
 * Atomically claims a completed quest's credit reward.
 *
 * Modeled on `joinBetaTesterProgram`: the claim is a guarded
 * `UPDATE ... WHERE status = 'completed' RETURNING` inside one transaction —
 * a concurrent double-claim affects zero rows and is detected as
 * `already_claimed`. On success the credit payout (`addCredits`, same `tx`) and
 * the activity log are committed together; the profile cache is invalidated
 * afterwards so the `CreditsChip` reflects the new balance.
 *
 * @param userId - Claiming user
 * @param questId - Registry quest id to claim
 * @returns Status plus the awarded credits and new balance
 */
export async function claimQuestReward(
  userId: string,
  questId: string,
): Promise<{
  status: 'claimed' | 'already_claimed' | 'not_completed' | 'not_found';
  creditsAwarded: number;
  newBalance: number;
}> {
  const rule = QUEST_REGISTRY.find((r) => r.id === questId);
  if (!rule || !rule.enabled) {
    return { status: 'not_found', creditsAwarded: 0, newBalance: 0 };
  }

  return dbWrite.transaction(async (tx: DBTransaction) => {
    const [claimed] = await tx
      .update(userQuests)
      .set({ status: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(userQuests.userId, userId),
          eq(userQuests.questId, questId),
          eq(userQuests.status, 'completed'),
        ),
      )
      .returning({ id: userQuests.id });

    // Guard hit zero rows → either already claimed or never completed.
    if (!claimed) {
      const [existing] = await tx
        .select({ status: userQuests.status, credits: users.credits })
        .from(userQuests)
        .innerJoin(users, eq(users.userId, userId))
        .where(and(eq(userQuests.userId, userId), eq(userQuests.questId, questId)))
        .limit(1);

      if (!existing) {
        return { status: 'not_completed', creditsAwarded: 0, newBalance: 0 };
      }
      const status = existing.status === 'claimed' ? 'already_claimed' : 'not_completed';
      return { status, creditsAwarded: 0, newBalance: existing.credits };
    }

    // Award credits inside the same transaction (atomic with the claim).
    const newBalance = await addCredits(userId, rule.rewardCredits, {
      context: 'quest_reward',
      metadata: { questId },
      tx,
    });

    await logUserActivity(
      {
        userId,
        activityType: 'quest_reward_claimed',
        targetType: 'quest',
        // target_id is a UUID column; point it at the user_quests row (uuid v7)
        // and keep the registry slug in metadata for reference.
        targetId: claimed.id,
        metadata: { questId: rule.id, creditsAwarded: rule.rewardCredits },
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
 * Explicit re-evaluation entry point for events that don't move counters
 * (e.g. after favoriting, following, or finishing a branch). Runs the same
 * evaluation as a read and returns the newly-completed quest ids.
 *
 * @param userId - User to re-check
 */
export async function recheckQuests(userId: string): Promise<string[]> {
  return evaluateQuests(userId);
}

export type { QuestMetricSnapshot };

/**
 * Atomically claims EVERY currently-completed quest in one transaction —
 * the bulk sibling of `claimQuestReward`. The reward total is the sum of the
 * registry payout for each claimable quest; a single `addCredits` call pays
 * it out and one activity log records the batch. Safely idempotent: with zero
 * claimable quests it returns `none_claimable` with no writes.
 *
 * @param userId - Claiming user
 * @returns claimedCount / creditsAwarded / newBalance plus a status flag
 */
export async function claimAllQuestRewards(
  userId: string,
): Promise<{
  status: 'claimed' | 'none_claimable';
  claimedCount: number;
  creditsAwarded: number;
  newBalance: number;
}> {
  return dbWrite.transaction(async (tx: DBTransaction) => {
    const claimable = await tx
      .select({ questId: userQuests.questId })
      .from(userQuests)
      .where(and(eq(userQuests.userId, userId), eq(userQuests.status, 'completed')));

    if (claimable.length === 0) {
      const [user] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);
      return { status: 'none_claimable', claimedCount: 0, creditsAwarded: 0, newBalance: user?.credits ?? 0 };
    }

    const questIds = claimable.map((r) => r.questId);
    const rewardByQuestId = new Map(QUEST_REGISTRY.map((r) => [r.id, r.rewardCredits]));
    const totalReward = questIds.reduce((sum, id) => sum + (rewardByQuestId.get(id) ?? 0), 0);

    await tx
      .update(userQuests)
      .set({ status: 'claimed', claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userQuests.userId, userId), eq(userQuests.status, 'completed')));

    const newBalance = await addCredits(userId, totalReward, {
      context: 'quest_reward',
      metadata: { questIds },
      tx,
    });

    await logUserActivity(
      {
        userId,
        activityType: 'quest_reward_claimed',
        targetType: 'quest',
        // Batch claim has no single user_quests row — omit target_id (UUID
        // column) and carry the slugs in metadata instead.
        metadata: { creditsAwarded: totalReward, questCount: questIds.length, questIds },
      },
      { client: tx },
    );

    return { status: 'claimed', claimedCount: questIds.length, creditsAwarded: totalReward, newBalance };
  });
}

/**
 * Full claim-all pipeline used by the route: performs the atomic bulk claim and
 * then invalidates the user's cached profile so the credits chip updates.
 *
 * @param userId - Claiming user
 */
export async function claimAllQuestRewardsAndInvalidate(
  userId: string,
): Promise<Awaited<ReturnType<typeof claimAllQuestRewards>>> {
  const result = await claimAllQuestRewards(userId);
  if (result.status === 'claimed') {
    await invalidateUserProfileCache(userId);
  }
  return result;
}

/**
 * Full single-claim pipeline used by the route: performs the atomic claim and
 * then invalidates the user's cached profile so the credits chip updates.
 *
 * @param userId - Claiming user
 * @param questId - Quest id to claim
 */
export async function claimQuestRewardAndInvalidate(
  userId: string,
  questId: string,
): Promise<Awaited<ReturnType<typeof claimQuestReward>>> {
  const result = await claimQuestReward(userId, questId);
  if (result.status === 'claimed') {
    await invalidateUserProfileCache(userId);
  }
  return result;
}
