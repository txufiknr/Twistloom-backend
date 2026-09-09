/**
 * Time-related utility functions
 */

import { getErrorMessage } from "./error.js";
// import { differenceInCalendarDays, parse } from 'date-fns';

/**
 * @summary Validates and parses a date string with comprehensive error handling
 * @description Safely parses date strings with validation and detailed error reporting
 * @param dateString - Date string to parse
 * @param context - Context for error logging (e.g., item title)
 * @returns Object with parsed date and validation status
 */
export function validateAndParseDate(
  dateString: string, 
  context?: string
): {
  date: Date | null;
  isValid: boolean;
  error?: string;
} {
  if (!dateString) {
    return {
      date: null,
      isValid: false,
      error: context ? `No date available for ${context}` : 'No date available'
    };
  }

  try {
    const parsedDate = new Date(dateString);
    
    if (!isNaN(parsedDate.getTime()) && 
      dateString.length <= 100 && // Reasonable length limit
      (
        /^\d{4}-\d{2}-\d{2}$/.test(dateString) || // YYYY-MM-DD format
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateString) || // ISO format
        /^\d{1,2}-\d{2}-\d{2}$/.test(dateString) // RFC 2822 formatting
      )
    ) {
      return {
        date: parsedDate,
        isValid: true
      };
    }

    return {
      date: null,
      isValid: false,
      error: `Invalid date format${context ? ` for ${context}` : ''}: ${dateString}`
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return {
      date: null,
      isValid: false,
      error: `Error parsing date${context ? ` for ${context}` : ''}: ${errorMessage}`
    };
  }
}

/**
 * @summary Normalizes a date to UTC with consistent precision
 * @description Converts any date to UTC and removes milliseconds for consistent comparison
 * @param dateInput - Date to normalize (Date object, string, or number)
 * @returns Normalized UTC Date
 */
export function normalizeToUTC(dateInput: Date | string | number): Date | null {
  try {
    const date = typeof dateInput === 'string' || typeof dateInput === 'number' 
      ? new Date(dateInput) 
      : dateInput;
    
    if (isNaN(date.getTime())) {
      return null;
    }

    // Convert to UTC and remove milliseconds for consistent comparison
    const isoString = date.toISOString();
    if (!isoString) return null; // Handle invalid dates
    
    const utcDate = new Date(isoString);
    if (isNaN(utcDate.getTime())) return null; // Validate created date
    
    utcDate.setUTCMilliseconds(0); // Remove milliseconds
    
    return utcDate;
  } catch {
    return null;
  }
}

/**
 * @summary Delays execution by specified milliseconds
 * @description Utility function for rate limiting and staggered processing
 * @param ms - Milliseconds to delay
 * @returns Promise that resolves after the delay
 */
export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get the start of day for a given date (UTC)
 * @param date - Date to get start of day for (defaults to now)
 * @returns Date representing start of day (00:00:00.000 UTC)
 */
export function startOfDay(date: Date = new Date()): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Check if two dates are the same day (UTC)
 * @param date1 - First date to compare
 * @param date2 - Second date to compare
 * @returns True if dates are on the same day
 */
export function isSameDay(date1: Date, date2: Date): boolean {
  const start1 = startOfDay(date1);
  const start2 = startOfDay(date2);
  return start1.getTime() === start2.getTime();
}

/**
 * Check if a date is today (UTC)
 * @param date - Date to check if it's today (defaults to now)
 * @returns True if the date is today
 */
export function isDateToday(date: Date = new Date()): boolean {
  return isSameDay(date, new Date());
}

/**
 * Normalizes a concealed year component for relative date arithmetic.
 *
 * Story dates may intentionally contain fictional placeholders such as `20XX`,
 * `19??`, or `2xxx`. Those values are still valid for in-fiction display, but
 * they are not valid for real calendar math. This helper swaps the concealed
 * year digits with zeroes (for example `20XX-10-27` -> `2000-10-27`) so that
 * comparisons remain deterministic without mutating the original story text.
 *
 * Unknown month/day placeholders remain intentionally unnormalized because they
 * represent indeterminate time precision rather than a concrete date.
 *
 * @param date - Date-like value to normalize for arithmetic comparisons.
 * @returns The original value when no concealed-year pattern is present; otherwise,
 * a version with the year concealment converted to a concrete numeric year.
 */
function normalizeDateForMath(date: Date | string): Date | string {
  if (typeof date !== 'string') {
    return date;
  }

  const trimmed = date.trim();
  if (!trimmed) {
    return date;
  }

  const wildcardYearMatch = trimmed.match(/^([0-9Xx?*_█]{4})(?:-(\d{1,2})-(\d{1,2}))?(?:[T\s].*)?$/);
  if (!wildcardYearMatch) {
    return date;
  }

  const [, yearPart] = wildcardYearMatch;
  const normalizedYear = yearPart.replace(/[Xx?*_█]/g, '0');
  const safeNormalizedYear = normalizedYear === '0000' ? '2000' : normalizedYear;
  if (!/^\d{4}$/.test(safeNormalizedYear)) {
    return date;
  }

  const remainder = trimmed.slice(yearPart.length);
  return `${safeNormalizedYear}${remainder}`;
}

/**
 * Detects date strings whose precision is intentionally indeterminate.
 *
 * Some story dates intentionally hide information instead of specifying a full
 * Gregorian date, such as `████`, `20XX-??-??`, `2030-??-??`, or `XXXX`.
 * These are valid narrative placeholders but must not participate in real day-
 * difference math because the missing fields would otherwise be guessed.
 *
 * Dates with a concealed year but concrete month/day remain valid for arithmetic
 * because the year is recoverable enough to produce a stable relative timeline.
 *
 * @param date - Date-like value to inspect.
 * @returns `true` when the date is structurally indeterminate enough that a
 * synthetic elapsed-day calculation would be misleading or invalid.
 */
export function isIndeterminateDate(date: Date | string): boolean {
  if (typeof date !== 'string') {
    return false;
  }

  const trimmed = date.trim();
  if (!trimmed) {
    return false;
  }

  const match = trimmed.match(/^([0-9Xx?*_█]{4})(?:-([0-9Xx?*_█]{1,2}))?(?:-([0-9Xx?*_█]{1,2}))?(?:[T\s].*)?$/);
  if (!match) {
    return false;
  }

  const [, yearPart, monthPart, dayPart] = match;

  const allYearConcealed = /^[Xx?*_█]{4}$/.test(yearPart);
  if (allYearConcealed) {
    return true;
  }

  return Boolean(
    (monthPart && /[Xx?*_█]/.test(monthPart)) ||
    (dayPart && /[Xx?*_█]/.test(dayPart))
  );
}

/**
 * Converts a date-like value into a UTC midnight timestamp.
 *
 * This helper is designed for day-difference math and therefore normalizes
 * compatible wildcard date forms before parsing. It intentionally returns
 * `NaN` for genuinely unparseable values so callers can decide whether to
 * reject, skip, or fall back without introducing invalid database values.
 *
 * @param date - Date object, ISO-like string, or a story-placeholder date.
 * @returns The UTC timestamp for the start of that day, or `NaN` if the value
 * cannot be resolved to a valid calendar date.
 */
export function toUtcMidnight(date: Date | string): number {
  if (typeof date === 'string') {
    const normalized = normalizeDateForMath(date) as string;

    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const [year, month, day] = normalized.split('-').map(Number);
      const utcTime = Date.UTC(year, month - 1, day);
      return Number.isFinite(utcTime) ? utcTime : NaN;
    }

    if (normalized !== date) {
      date = normalized;
    }
  }

  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) {
    return NaN;
  }

  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Calculates the whole calendar-day delta between two dates using UTC midnight.
 *
 * The result ignores time-of-day precision and is intended to support stable,
 * story-facing elapsed-day counters. For indeterminate placeholder dates
 * (for example `2030-??-??` or `████`), this function intentionally returns
 * `0` instead of guessing a timeline.
 *
 * @param startDate - Starting date for the comparison.
 * @param endDate - Ending date for the comparison.
 * @returns The difference in whole calendar days, or `0` when the precision is
 * intentionally indeterminate.
 *
 * @example
 * daysBetween('2025-06-10', '2025-06-23') === 13
 */
export function daysBetween(startDate: Date | string, endDate: Date | string): number {
  if (startDate === endDate) {
    return 0;
  }

  if (isIndeterminateDate(startDate) || isIndeterminateDate(endDate)) {
    return 0;
  }

  const msPerDay = 24 * 60 * 60 * 1000; // 86400000
  const startUtc = toUtcMidnight(startDate);
  const endUtc = toUtcMidnight(endDate);

  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) {
    return NaN;
  }

  // Math.round purely as a safety net for any JS engine quirks
  return Math.round((endUtc - startUtc) / msPerDay);
}

/**
 * Calculate the number of hours between two dates
 * @param date1 - First date
 * @param date2 - Second date
 * @returns Number of hours between dates (can be negative)
 */
export function hoursBetween(date1: Date, date2: Date): number {
  const msDiff = date1.getTime() - date2.getTime();
  return msDiff / (1000 * 60 * 60);
}

/**
 * Check if a date is within the grace window (36 hours)
 * @param date1 - Current date
 * @param date2 - Date to check against (e.g., last read date)
 * @returns True if date2 is within 36 hours of date1
 */
export function isWithinGraceWindow(date1: Date, date2: Date): boolean {
  return hoursBetween(date1, date2) <= 36;
}

/**
 * Get today's date in YYYY-MM-DD format
 * @returns Today's date as string in YYYY-MM-DD format
 */
export function getTodayDate(): string {
  return formatDateToYYYYMMDD(new Date());
}

/**
 * Convert a Date object to YYYY-MM-DD format string
 * @param date - Date to convert
 * @returns Date as string in YYYY-MM-DD format
 */
export function formatDateToYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns ISO date strings for the first day of the current month and the first day of next month */
export function getCurrentMonthBounds(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start, end };
}

/**
 * Check if a timestamp is within cooldown period
 * @description Reusable helper for time-based cooldown checks
 * @param lastTimestamp - Last action timestamp (can be null/undefined)
 * @param cooldownMs - Cooldown period in milliseconds
 * @returns True if still within cooldown period, false if cooldown has expired
 */
export function isWithinCooldown(
  lastTimestamp: Date | string | null | undefined,
  cooldownMs: number
): boolean {
  if (!lastTimestamp) return false;
  
  const lastTime = typeof lastTimestamp === 'string' 
    ? new Date(lastTimestamp).getTime() 
    : lastTimestamp.getTime();
    
  const now = Date.now();
  return (now - lastTime) < cooldownMs;
}

/**
 * Calculate how many hours have passed since a given date
 * @param date - Date to calculate hours from (defaults to now)
 * @returns Number of hours since the given date
 */
export function hoursOld(date: Date): number {
  const now = Date.now();
  const dateMs = date.getTime();
  return (now - dateMs) / 36e5; // 3.6 × 10^5 = 360,000 (milliseconds in an hour)
}

/**
 * Converts an ISO 8601 duration string (e.g. "PT1H3M33S", "PT4M13S", "PT45S")
 * to whole seconds. Returns undefined if the string is missing or unparseable.
 */
export function iso8601DurationToSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;

  // Pattern: P[nY][nM][nD]T[nH][nM][nS]
  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i
  );
  if (!match) return undefined;

  const [, , , days, hours, minutes, seconds] = match;
  const total =
    (parseInt(days    ?? "0", 10) * 86_400) +
    (parseInt(hours   ?? "0", 10) *  3_600) +
    (parseInt(minutes ?? "0", 10) *     60) +
    (parseFloat(seconds ?? "0"));

  return total > 0 ? Math.round(total) : undefined;
}

/**
 * Gets the current UTC date in YYYY-MM-DD format
 * @returns Current UTC date string
 */
export function getCurrentUTCDay(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// TODO: jsdoc
export function formatMinutes(m: number): string {
  if (m >= 120) return `${Math.round(m / 60)}h`;
  if (m >= 60) return `1h ${m % 60}m`;
  return `${m}m`;
};