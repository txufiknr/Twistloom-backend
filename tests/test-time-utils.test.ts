import { describe, expect, it } from 'bun:test';
import { daysBetween, toUtcMidnight } from '../src/utils/time.js';

describe('time utilities', () => {
  it('normalizes wildcard years before computing day deltas', () => {
    expect(Number.isFinite(toUtcMidnight('20XX-10-27'))).toBe(true);
    expect(daysBetween('20XX-10-27', '20XX-10-29')).toBe(2);
    expect(daysBetween('20XX-10-27', '20XX-10-27')).toBe(0);

    expect(Number.isFinite(toUtcMidnight('2xxx-02-29'))).toBe(true);
    expect(daysBetween('19??-01-01', '19??-01-03')).toBe(2);
    expect(Number.isFinite(toUtcMidnight('XXXX-01-01'))).toBe(true);
    expect(Number.isFinite(toUtcMidnight('????-06-15'))).toBe(true);
  });

  it('returns a safe result for invalid/unparseable dates', () => {
    expect(Number.isFinite(toUtcMidnight('unknown'))).toBe(false);
    expect(Number.isNaN(daysBetween('unknown', '2026-01-02'))).toBe(true);
  });
});
