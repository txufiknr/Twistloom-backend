/**
 * Capitalizes the first letter of a string
 * @param str - The string to format
 * @returns The string with the first letter capitalized
 */
export function ucfirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Creates a safe filename by removing invalid characters and replacing spaces with underscores
 * @param filename - The original filename to sanitize
 * @returns Safe filename suitable for file system
 */
export function sanitizeFilename(filename: string): string {
  return filename
    // Remove or replace invalid characters for filenames
    .replace(/[<>:"/\\|?*]/g, '') // Remove < > : " / \ | ? * 
    .replace(/&/g, '') // Remove ampersands (problematic for URLs/file systems)
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .toLowerCase(); // Convert to lowercase for URL consistency
}

/**
 * Converts a string to Title Case.
 *
 * - Capitalizes principal words.
 * - Keeps short words (articles, short prepositions, coordinating conjunctions)
 *   lowercase unless they appear as the first or last word.
 * - Preserves surrounding punctuation and handles hyphenated words by
 *   capitalizing each hyphenated segment.
 *
 * @param str - The input string to convert
 * @returns The string converted to title case
 */
export const titleCase = (str: string): string => {
  if (!str) return '';

  const smallWords = new Set([
    'a','an','the',
    'and','but','or','for','so','nor','yet',
    'of','in','on','to','with','at','by','from','up','about','into','over','after','near','per','via'
  ]);

  const words = str.split(/\s+/);

  const capitalizeCore = (coreOriginal: string) => {
    return coreOriginal
      .split('-')
      .map(part => {
        if (!part) return part;
        const hasUpperBeyondFirst = /[A-Z]/.test(part.slice(1));
        const isAllUpper = part === part.toUpperCase();
        if (hasUpperBeyondFirst || isAllUpper) return part;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      })
      .join('-');
  };

  return words.map((word, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === words.length - 1;

    // Preserve leading/trailing punctuation around the core word
    const m = word.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'\u2019-]+)([^A-Za-z0-9]*)$/);
    if (!m) {
      // Fallback: just capitalize hyphen parts
      return capitalizeCore(word.toLowerCase());
    }

    const [, leading, coreRaw, trailing] = m;
    const coreLower = coreRaw.toLowerCase();

    if (!isFirst && !isLast && smallWords.has(coreLower)) {
      return leading + coreLower + trailing;
    }

    return leading + capitalizeCore(coreRaw) + trailing;
  }).join(' ');
}

/**
 * Formats a number with optional decimal places and suffix
 *
 * @param number - The number to format
 * @param options - Formatting options
 * @param options.decimals - Number of decimal places (default: 0)
 * @param options.suffix - Optional suffix to append (e.g., '%', '$')
 * @returns The formatted number string
 */
export const formatNumber = (
  number?: number | null,
  options?: { decimals?: number; suffix?: string } | string
): string => {
  if (number === null || number === undefined) return '0';

  // Handle backward compatibility with string suffix
  const decimals = typeof options === 'object' ? options.decimals ?? 0 : 0;
  const suffix = typeof options === 'string' ? options : options?.suffix ?? '';

  const formatted = number.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });

  return `${formatted}${suffix}`;
};

/**
 * Format milliseconds to human-readable time string (e.g., "2m 13s")
 */
export function formatDuration(ms: number): string {
  if (!ms || ms === 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}