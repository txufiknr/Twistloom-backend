/**
 * Time-related utility functions
 */

/**
 * @summary Validates and parses a date string with comprehensive error handling
 * @description Safely parses date strings with validation and detailed error reporting
 * @param dateString - Date string to parse
 * @param context - Context for error logging (e.g., feed ID, item title)
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
      error: context 
        ? `Invalid date format for ${context}: ${dateString}`
        : `Invalid date format: ${dateString}`
    };
  } catch (error) {
    return {
      date: null,
      isValid: false,
      error: context 
        ? `Error parsing date for ${context}: ${error instanceof Error ? error.message : String(error)}`
        : `Error parsing date: ${error instanceof Error ? error.message : String(error)}`
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
 * Calculate the number of days between two dates (UTC)
 * @param date1 - First date
 * @param date2 - Second date
 * @returns Number of days between dates (can be negative)
 */
export function daysBetween(date1: Date, date2: Date): number {
  const start1 = startOfDay(date1);
  const start2 = startOfDay(date2);
  const msDiff = start1.getTime() - start2.getTime();
  return Math.round(msDiff / (1000 * 60 * 60 * 24));
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