/**
 * Session Weave (Completion Drive Mechanic) Service
 *
 * Pulls the reader toward finishing narrative loops during a reading session
 * across 3 interlocking strands:
 * 1. story (pages read in session, threshold = 3)
 * 2. choice (decisions made, threshold = 1)
 * 3. discovery (clues, plot flags, secrets, characters found, threshold = 1)
 *
 * Guarded Claim & Economy Defenses:
 * - Guarded Claim pattern: atomic UPDATE with WHERE is_complete = false RETURNING id.
 * - Server-side Daily Cap: Exactly 1 weave credit bonus (+5 cr) per UTC day.
 * - Subsequent completed weaves on the same UTC day record completion (knots)
 *   without dispensing infinite credits.
 *
 * @see docs/architecture/SESSION_WEAVE_SYSTEM_ARCHITECTURE.md
 */

import { and, count, eq, gte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import { sessionWeave, users } from "../db/schema.js";
import { addCredits } from "./credits.js";

export type WeaveStrand = "story" | "choice" | "discovery";

export const WEAVE_THRESHOLDS = {
  story: 3,
  choice: 1,
  discovery: 1,
} as const;

export const WEAVE_BONUS = 5;
export const DAILY_WEAVE_CAP = 1;

export interface WeaveState {
  sessionId: string;
  bookId: string;
  storyStrand: number;
  choiceStrand: number;
  discoveryStrand: number;
  isComplete: boolean;
  completedAt: Date | null;
  dailyBonusClaimed: boolean;
}

export interface WeaveProgressResult {
  isComplete: boolean;
  weaveBonus: number;
  dailyBonusClaimed: boolean;
  strands: {
    story: number;
    choice: number;
    discovery: number;
  };
}

export interface TodayWeaveStatus {
  dailyBonusClaimed: boolean;
  bonusAmount: number;
  dailyCap: number;
  completedCountToday: number;
}

/**
 * Returns UTC midnight Date for today
 */
function getStartOfDayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Retrieves the current Session Weave progress for a reading session.
 */
export async function getWeaveProgress(
  userId: string,
  sessionId: string,
): Promise<WeaveState | null> {
  const [row] = await dbRead
    .select({
      sessionId: sessionWeave.sessionId,
      bookId: sessionWeave.bookId,
      storyStrand: sessionWeave.storyStrand,
      choiceStrand: sessionWeave.choiceStrand,
      discoveryStrand: sessionWeave.discoveryStrand,
      isComplete: sessionWeave.isComplete,
      completedAt: sessionWeave.completedAt,
      dailyBonusClaimed: sessionWeave.dailyBonusClaimed,
    })
    .from(sessionWeave)
    .where(and(eq(sessionWeave.userId, userId), eq(sessionWeave.sessionId, sessionId)))
    .limit(1);

  if (!row) return null;

  return {
    sessionId: row.sessionId,
    bookId: row.bookId,
    storyStrand: row.storyStrand,
    choiceStrand: row.choiceStrand,
    discoveryStrand: row.discoveryStrand,
    isComplete: row.isComplete,
    completedAt: row.completedAt,
    dailyBonusClaimed: row.dailyBonusClaimed,
  };
}

/**
 * Updates a strand's counter and checks whether the Session Weave completes.
 *
 * Enforces atomic guarded claim and server-side daily cap.
 */
export async function updateWeaveProgress(
  userId: string,
  sessionId: string,
  bookId: string,
  strand: WeaveStrand,
): Promise<WeaveProgressResult> {
  if (!["story", "choice", "discovery"].includes(strand)) {
    throw new Error(`Invalid strand: ${strand}`);
  }

  const column = `${strand}Strand` as const;

  // 1. Upsert strand counter increment
  await dbWrite
    .insert(sessionWeave)
    .values({
      userId,
      sessionId,
      bookId,
      [column]: 1,
    })
    .onConflictDoUpdate({
      target: [sessionWeave.userId, sessionWeave.sessionId],
      set: {
        bookId,
        [column]: sql`${sessionWeave[column]} + 1`,
        updatedAt: new Date(),
      },
    });

  // 2. Read back current strand state
  const [weave] = await dbRead
    .select()
    .from(sessionWeave)
    .where(and(eq(sessionWeave.userId, userId), eq(sessionWeave.sessionId, sessionId)))
    .limit(1);

  if (!weave) {
    return {
      isComplete: false,
      weaveBonus: 0,
      dailyBonusClaimed: false,
      strands: { story: 0, choice: 0, discovery: 0 },
    };
  }

  const meetsThresholds =
    weave.storyStrand >= WEAVE_THRESHOLDS.story &&
    weave.choiceStrand >= WEAVE_THRESHOLDS.choice &&
    weave.discoveryStrand >= WEAVE_THRESHOLDS.discovery;

  // 3. Handle Completion & Guarded Claim inside an atomic transaction
  if (meetsThresholds && !weave.isComplete) {
    const todayStart = getStartOfDayUTC();

    return await dbWrite.transaction(async (tx) => {
      // Row-lock user record to serialize concurrent weave completions across sessions
      await tx
        .select({ id: users.userId })
        .from(users)
        .where(eq(users.userId, userId))
        .for("update")
        .limit(1);

      // Re-verify that this specific session weave is not already complete
      const [currentWeave] = await tx
        .select()
        .from(sessionWeave)
        .where(and(eq(sessionWeave.id, weave.id), eq(sessionWeave.isComplete, false)))
        .for("update")
        .limit(1);

      if (!currentWeave) {
        // Already completed concurrently
        const [existing] = await tx
          .select()
          .from(sessionWeave)
          .where(eq(sessionWeave.id, weave.id))
          .limit(1);

        return {
          isComplete: true,
          weaveBonus: 0,
          dailyBonusClaimed: existing?.dailyBonusClaimed ?? false,
          strands: {
            story: existing?.storyStrand ?? weave.storyStrand,
            choice: existing?.choiceStrand ?? weave.choiceStrand,
            discovery: existing?.discoveryStrand ?? weave.discoveryStrand,
          },
        };
      }

      // Check if the user already claimed their daily weave bonus today
      const [todayClaims] = await tx
        .select({ count: count() })
        .from(sessionWeave)
        .where(
          and(
            eq(sessionWeave.userId, userId),
            gte(sessionWeave.completedAt, todayStart),
            eq(sessionWeave.dailyBonusClaimed, true),
          ),
        );

      const alreadyClaimedToday = (todayClaims?.count ?? 0) >= DAILY_WEAVE_CAP;
      const shouldAwardBonus = !alreadyClaimedToday;

      await tx
        .update(sessionWeave)
        .set({
          isComplete: true,
          completedAt: new Date(),
          dailyBonusClaimed: shouldAwardBonus,
          updatedAt: new Date(),
        })
        .where(eq(sessionWeave.id, weave.id));

      if (shouldAwardBonus) {
        // Award credits atomically inside this same transaction
        await addCredits(userId, WEAVE_BONUS, {
          tx,
          context: "weave_completion",
          metadata: { bookId, sessionId },
        });

        return {
          isComplete: true,
          weaveBonus: WEAVE_BONUS,
          dailyBonusClaimed: true,
          strands: {
            story: currentWeave.storyStrand,
            choice: currentWeave.choiceStrand,
            discovery: currentWeave.discoveryStrand,
          },
        };
      }

      return {
        isComplete: true,
        weaveBonus: 0,
        dailyBonusClaimed: false,
        strands: {
          story: currentWeave.storyStrand,
          choice: currentWeave.choiceStrand,
          discovery: currentWeave.discoveryStrand,
        },
      };
    });
  }

  return {
    isComplete: weave.isComplete,
    weaveBonus: 0,
    dailyBonusClaimed: weave.dailyBonusClaimed,
    strands: {
      story: weave.storyStrand,
      choice: weave.choiceStrand,
      discovery: weave.discoveryStrand,
    },
  };
}

/**
 * Checks whether the user has claimed today's weave bonus and how many weaves
 * have been completed today.
 */
export async function getTodayWeaveStatus(userId: string): Promise<TodayWeaveStatus> {
  const todayStart = getStartOfDayUTC();

  const [claimedRow] = await dbRead
    .select({ count: count() })
    .from(sessionWeave)
    .where(
      and(
        eq(sessionWeave.userId, userId),
        gte(sessionWeave.completedAt, todayStart),
        eq(sessionWeave.dailyBonusClaimed, true),
      ),
    );

  const [totalCompletedRow] = await dbRead
    .select({ count: count() })
    .from(sessionWeave)
    .where(
      and(
        eq(sessionWeave.userId, userId),
        gte(sessionWeave.completedAt, todayStart),
        eq(sessionWeave.isComplete, true),
      ),
    );

  const claimedCount = claimedRow?.count ?? 0;
  const totalCompleted = totalCompletedRow?.count ?? 0;

  return {
    dailyBonusClaimed: claimedCount >= DAILY_WEAVE_CAP,
    bonusAmount: WEAVE_BONUS,
    dailyCap: DAILY_WEAVE_CAP,
    completedCountToday: totalCompleted,
  };
}
