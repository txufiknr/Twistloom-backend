/**
 * @overview Check-in Streak Helpers
 *
 * Pure, dependency-free date/streak computations shared by every daily
 * check-in read and write path (`getCheckInStatus`, `getCheckInStreaks`,
 * `performDailyCheckIn`).
 *
 * Why this module exists (F-3):
 * The grace/streak logic previously lived in three hand-rolled loops with two
 * different date-iteration styles (`shiftIsoDate` vs a manual `Date.UTC`
 * walk). That duplication is exactly the class of drift that let
 * `longestStreak` and `currentStreak` disagree (F-1). There is now exactly
 * ONE definition of "grace" (a single skipped-day token per evaluation,
 * invariant I4 of the check-in architecture) and ONE definition of "best run".
 *
 * Invariants guaranteed here:
 * - I4: one grace token per evaluation — a streak walk may bridge exactly one
 *   skipped day before terminating.
 * - Best >= Streak by construction: `computeLongestRun` maximises over the
 *   same grace-windowed evaluation the active walk performs, so the all-time
 *   best can never come out below the current streak.
 *
 * All functions are pure (no I/O, no clock reads — the caller supplies
 * `todayIso`), which makes them trivially unit-testable and safe to call
 * inside database transactions.
 */

/** Snapshot of the derived streak metrics for one user at a point in time. */
export interface CheckinStreakSnapshot {
  /** Grace-protected consecutive-day streak ending at today (or yesterday). */
  activeStreak: number;
  /** All-time best grace-protected run; always >= activeStreak. */
  longestStreak: number;
  /** Whether a check-in exists for `todayIso`. */
  isCheckedInToday: boolean;
}

/**
 * Shifts a YYYY-MM-DD date string by a number of days (positive or negative).
 *
 * @param iso - Date in YYYY-MM-DD format
 * @param days - Number of days to shift (negative goes back in time)
 * @returns Shifted date in YYYY-MM-DD format
 *
 * @example
 * ```typescript
 * shiftIsoDate('2026-08-03', -1) // '2026-08-02'
 * shiftIsoDate('2026-08-03', 1)  // '2026-08-04'
 * ```
 */
export function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Counts consecutive check-in days walking backwards from `startIso`,
 * tolerating exactly one skipped day (the single grace token, invariant I4).
 *
 * The count includes PRESENT days only — a bridged gap does not add to the
 * streak. The walk terminates on the second skipped day (or at the 366-day
 * evaluation cap).
 *
 * @param dateSet - Set of YYYY-MM-DD dates the user checked in
 * @param startIso - Anchor date (usually "today" in UTC)
 * @param startOffset - 0 to include the anchor day itself, 1 to start from
 *   the day before (used when the anchor day has not been claimed yet)
 * @returns Grace-protected backwards streak length
 */
export function computeBackwardsStreak(
  dateSet: ReadonlySet<string>,
  startIso: string,
  startOffset: 0 | 1,
): number {
  let streak = 0;
  let graceDaysRemaining = 1; // one free streak freeze per evaluation
  for (let i = startOffset; i <= 366; i++) {
    const targetDate = shiftIsoDate(startIso, -i);
    if (dateSet.has(targetDate)) {
      streak++;
    } else if (graceDaysRemaining > 0) {
      // Grace day bridges this single skipped day; streak continues across it
      graceDaysRemaining--;
    } else {
      break;
    }
  }
  return streak;
}

/** Whole-day distance from `fromIso` to `toIso` (`to - from`), UTC-normalised. */
function daySpan(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Longest grace-aligned run anywhere in the history: the largest PRESENT-day
 * count of any contiguous window containing at most one absent day.
 *
 * This is the all-time mirror of {@link computeBackwardsStreak}: evaluating
 * every present-day anchor with the same one-token rule is equivalent to a
 * two-pointer sweep over the sorted dates where the window's day span exceeds
 * the number of present dates by at most one. Consequently
 * `computeLongestRun >= computeBackwardsStreak` for any anchor — the HUD's
 * "Best" can never render below "Current" (fixes F-1 / Scenario 7: Mon, skip
 * Tue, Wed–Fri gives Best 4, not the strict-run 3).
 *
 * @param dates - Check-in dates in any order; duplicates are ignored
 * @returns Length of the best grace-protected run (0 for empty history)
 */
export function computeLongestRun(dates: Iterable<string>): number {
  const sorted = [...new Set(dates)].sort();
  let longest = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    // Shrink from the left until the window [left..right] holds at most one
    // absent day. Day-span vs present-count is monotone as the window grows,
    // so the left pointer only moves forward (O(n) total).
    while (left < right) {
      const spanDays = daySpan(sorted[left], sorted[right]) + 1;
      const presentDays = right - left + 1;
      if (spanDays - presentDays <= 1) break;
      left++;
    }
    const presentDays = right - left + 1;
    if (presentDays > longest) longest = presentDays;
  }
  return longest;
}

/**
 * Derives all streak metrics from a user's distinct check-in dates.
 *
 * @param dates - Distinct YYYY-MM-DD check-in dates (order irrelevant)
 * @param todayIso - Current UTC date (YYYY-MM-DD)
 * @returns Active/longest streak and today flag
 *
 * @example
 * ```typescript
 * const { activeStreak, longestStreak } = computeStreaks(dates, getCurrentUTCDay());
 * ```
 */
export function computeStreaks(dates: Iterable<string>, todayIso: string): CheckinStreakSnapshot {
  const dateSet = new Set(dates);
  const isCheckedInToday = dateSet.has(todayIso);
  return {
    activeStreak: computeBackwardsStreak(dateSet, todayIso, isCheckedInToday ? 0 : 1),
    longestStreak: computeLongestRun(dateSet),
    isCheckedInToday,
  };
}
