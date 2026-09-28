import { describe, expect, it } from 'bun:test';
import {
  computeBackwardsStreak,
  computeLongestRun,
  computeStreaks,
  shiftIsoDate,
} from '../src/services/checkin-streak.js';

// Scenario calendar from docs/architecture/DAILY_CHECKIN_ARCHITECTURE.md §6:
// Mon 2026-08-03 … Fri 2026-08-07 (weekday labels are fixed dates; the
// helpers only care about relative day distances).
const MON = '2026-08-03';
const TUE = '2026-08-04';
const WED = '2026-08-05';
const THU = '2026-08-06';
const FRI = '2026-08-07';
const SAT = '2026-08-08';

describe('shiftIsoDate', () => {
  it('shifts forward and backward by one day', () => {
    expect(shiftIsoDate('2026-08-03', -1)).toBe('2026-08-02');
    expect(shiftIsoDate('2026-08-03', 1)).toBe('2026-08-04');
  });

  it('shifts across month, year, and leap-day boundaries', () => {
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIsoDate('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('computeBackwardsStreak', () => {
  it('counts present days ending at the anchor (offset 0)', () => {
    expect(computeBackwardsStreak(new Set([MON, TUE]), TUE, 0)).toBe(2);
  });

  it('bridges one skipped day with the grace token (Scenario 2)', () => {
    // Wednesday not yet claimed, Monday checked in, Tuesday skipped → 1
    expect(computeBackwardsStreak(new Set([MON]), WED, 1)).toBe(1);
  });

  it('resets after two skipped days (Scenario 3)', () => {
    expect(computeBackwardsStreak(new Set([MON]), THU, 1)).toBe(0);
  });

  it('matches the Scenario 7 active walk (4 with the grace bridge)', () => {
    expect(computeBackwardsStreak(new Set([MON, WED, THU, FRI]), FRI, 0)).toBe(4);
  });
});

describe('computeLongestRun', () => {
  it('grace-aligns the best run: Scenario 7 yields 4, not the strict-run 3 (F-1)', () => {
    expect(computeLongestRun([MON, WED, THU, FRI])).toBe(4);
  });

  it('remains a plain run metric when history has no gaps', () => {
    expect(computeLongestRun([MON, TUE, WED, THU])).toBe(4);
    expect(computeLongestRun([MON])).toBe(1);
    expect(computeLongestRun([])).toBe(0);
  });

  it('takes the max across runs separated by more than one absent day', () => {
    expect(computeLongestRun([MON, TUE, FRI, SAT])).toBe(2);
  });

  it('ignores duplicates and input ordering', () => {
    expect(computeLongestRun([WED, MON, WED, THU])).toBe(3);
  });
});

describe('computeStreaks', () => {
  it('reports today as claimed when the anchor day has a check-in', () => {
    const s = computeStreaks([MON, TUE], TUE);
    expect(s.isCheckedInToday).toBe(true);
    expect(s.activeStreak).toBe(2);
    expect(s.longestStreak).toBe(2);
  });

  it('anchors on yesterday when today is unclaimed', () => {
    const s = computeStreaks([MON, TUE], WED);
    expect(s.isCheckedInToday).toBe(false);
    expect(s.activeStreak).toBe(2);
    expect(s.longestStreak).toBe(2);
  });

  it('Scenario 7 renders current 4 / best 4 — no inversion (F-1 regression)', () => {
    const s = computeStreaks([MON, WED, THU, FRI], FRI);
    expect(s.activeStreak).toBe(4);
    expect(s.longestStreak).toBe(4);
  });

  it('keeps Best >= Streak across every architecture scenario', () => {
    const cases: Array<{ dates: string[]; today: string }> = [
      { dates: [MON, WED, THU, FRI], today: FRI }, // Scenario 7
      { dates: [MON], today: WED }, // Scenario 2 (streak 1)
      { dates: [MON], today: THU }, // Scenario 3 (streak 0)
      { dates: [MON, TUE, WED, THU, FRI], today: SAT },
      { dates: [MON, TUE], today: WED }, // Scenario 4-style full week
      { dates: [], today: MON },
    ];
    for (const { dates, today } of cases) {
      const s = computeStreaks(dates, today);
      expect(s.longestStreak).toBeGreaterThanOrEqual(s.activeStreak);
    }
  });
});
