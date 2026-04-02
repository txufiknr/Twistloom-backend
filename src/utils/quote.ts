/**
 * Builds a quote index for efficient O(1) quote position lookups.
 * 
 * Pre-computes quote state for every position in a single O(n) pass.
 * All subsequent lookups are O(1) array reads, avoiding the O(n²) cost of
 * scanning from position 0 on every call.
 * 
 * Only straight double-quotes `"` are tracked. Rationale:
 * - Straight single-quotes `'` are indistinguishable from apostrophes (Allah's, Prophet's, don't)
 * - Islamic text uses double-quotes for hadiths and Quranic verses
 * - With only `"` (self-closing), the quote stack never exceeds depth 1
 * 
 * @param text - The input text to analyze for quote positions
 * @returns Boolean array where `quoteOpen[i]` is true if position i is inside an open `"…"` block
 * 
 * @example
 * ```typescript
 * const index = buildQuoteIndex('Start "quote" end');
 * // index[0] = false (before first character)
 * // index[6] = true (inside quote)
 * // index[12] = false (after quote closes)
 * ```
 */
export function buildQuoteIndex(text: string): boolean[] {
  const quoteOpen: boolean[] = new Array(text.length + 1).fill(false);
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inside = !inside;
    quoteOpen[i + 1] = inside;
  }
  return quoteOpen;
}

/**
 * Checks if a specific position is inside a quote block.
 * 
 * Provides O(1) lookup to determine if a position falls within an open `"…"` block.
 * Uses the pre-computed quote index from `buildQuoteIndex()`.
 * 
 * @param quoteOpen - The quote index array from `buildQuoteIndex()`
 * @param position - The position to check (0-based index)
 * @returns True if the position is inside a quote, false otherwise
 * 
 * @example
 * ```typescript
 * const index = buildQuoteIndex('Start "quote" end');
 * isInsideQuote(index, 8); // true (inside quote)
 * isInsideQuote(index, 15); // false (after quote)
 * ```
 */
export function isInsideQuote(quoteOpen: boolean[], position: number): boolean {
  return quoteOpen[position] === true;
}

/**
 * Finds the end position of a quote starting from a given position.
 * 
 * Scans forward from `fromPosition` for the next closing double-quote `"`
 * and returns the index immediately after it, consuming any trailing punctuation
 * marks (. ! ? , ; ) ]).
 * 
 * Designed to work with positions known to be inside quotes, returning the
 * safe cut point that preserves the complete quote including its closing punctuation.
 * 
 * @param text - The text to search within
 * @param fromPosition - Starting position to search from (typically inside a quote)
 * @returns Index immediately after the closing quote and punctuation, or -1 if no closing quote found
 * 
 * @example
 * ```typescript
 * findQuoteEnd('Start "quote." more text', 6); // returns 14 (after "quote.")
 * findQuoteEnd('Start "unclosed quote', 6); // returns -1 (no closing quote)
 * ```
 */
export function findQuoteEnd(text: string, fromPosition: number): number {
  for (let i = fromPosition; i < text.length; i++) {
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && /[.!?,;)\]]/.test(text[end])) end++;
      return end;
    }
  }
  return -1;
}

/**
 * Converts single-quoted string literals to double-quoted ones.
 * Handles escaped single quotes inside single-quoted strings.
 * Skips characters that are already inside double-quoted regions.
 */
export function convertSingleToDoubleQuotes(input: string): string {
  let result = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    if (ch === '"') {
      // Skip over a double-quoted string
      result += ch;
      i++;
      while (i < len) {
        const c = input[i];
        result += c;
        if (c === '\\') { i++; if (i < len) { result += input[i]; } }
        else if (c === '"') break;
        i++;
      }
      i++;
    } else if (ch === "'") {
      // Convert single-quoted string to double-quoted
      result += '"';
      i++;
      while (i < len) {
        const c = input[i];
        if (c === '\\' && i + 1 < len && input[i + 1] === "'") {
          result += "'"; // unescape \'  → '
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else if (c === '"') {
          result += '\\"'; // escape bare " inside single-quoted string
          i++;
        } else {
          result += c;
          i++;
        }
      }
      result += '"';
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

/**
 * Removes paired quote marks from the start and end of text.
 * 
 * @description This function removes matching quote characters from both the beginning
 * and end of a string. It handles various types of quotes including straight quotes,
 * smart quotes, and single/double variations. Only removes quotes if they appear as
 * matching pairs at both ends of the text.
 * 
 * Features:
 * - Multiple quote types: Handles ", ', ', ", ', and '
 * - Paired removal: Only removes quotes if they appear as matching pairs
 * - Preserves internal quotes: Does not affect quotes within the text
 * - Whitespace tolerant: Handles quotes around whitespace-trimmed content
 * - Mixed quote handling: Removes quotes even if they're different types (e.g., "text')
 * 
 * @param text - The text to strip quotes from
 * @returns Text without surrounding quote marks, or original text if no paired quotes found
 * 
 * @example
 * ```typescript
 * const text1 = '"Refined Title"';
 * const clean1 = stripQuotes(text1);
 * // Returns: "Refined Title"
 * 
 * const text2 = 'No quotes here';
 * const clean2 = stripQuotes(text5);
 * // Returns: "No quotes here" (unchanged)
 * 
 * const text3 = '"Unmatched quotes';
 * const clean3 = stripQuotes(text6);
 * // Returns: '"Unmatched quotes' (unchanged)
 * ```
 */
export function stripQuotes(text: string): string {
  if (!text || typeof text !== 'string') return '';
  
  const trimmedText = text.trim();
  if (trimmedText.length === 0) return '';
  
  // Define all types of quote characters we want to handle
  const quoteChars = ['"', "'", '\u2018', '\u2019', '\u201C', '\u201D', '\u0060', '\u00B4'];
  
  // Check if the text starts and ends with quote characters
  const firstChar = trimmedText[0];
  const lastChar = trimmedText[trimmedText.length - 1];
  
  const isFirstCharQuote = quoteChars.includes(firstChar);
  const isLastCharQuote = quoteChars.includes(lastChar);
  
  // Only remove quotes if both first and last characters are quote characters
  if (isFirstCharQuote && isLastCharQuote) {
    // Remove the first and last characters
    return trimmedText.slice(1, -1).trim();
  }
  
  // Return original text if no paired quotes found
  return trimmedText;
}

/**
 * Corrects double quote marks inside text and strips surrounding quotes.
 * 
 * @description This function first converts double double-quotes (`""`) to single quotes (`"`)
 * throughout the text, then removes surrounding quote marks using the stripQuotes function.
 * This handles cases where text contains incorrectly doubled quotes that need normalization.
 * 
 * Features:
 * - Double quote correction: Converts `""text""` to `"text"` throughout
 * - Surrounding quote removal: Uses stripQuotes for consistent outer quote handling
 * - Preserves internal quotes: Only fixes doubled quotes, leaves single quotes intact
 * - Multiple quote types: Handles various quote character combinations
 * 
 * @param text - The text to correct and strip quotes from
 * @returns Text with corrected quotes and no surrounding quote marks
 * 
 * @example
 * ```typescript
 * const text1 = '"President Trump, dismissing climate change as a ""hoax,"" criticized finding as a ""scam"" and praised fossil fuels for their global benefits."';
 * const clean1 = correctDoubleQuotes(text1);
 * // Returns: "President Trump, dismissing climate change as a "hoax," criticized the finding as a "scam" and praised fossil fuels for their global benefits."
 * ```
 */
export function correctDoubleQuotes(text: string): string {
  if (!text || typeof text !== 'string') return '';
  
  // First, correct double double-quotes throughout the text
  // Pattern: "" (two double quotes) -> " (single double quote)
  const correctedText = text.replace(/""/g, '"');
  
  // Then use stripQuotes to handle any surrounding quotes
  return stripQuotes(correctedText);
}

/**
 * Normalizes all smart/curly/modifier quote characters to plain ASCII.
 *
 * Double-quote targets  →  "  (U+0022)
 *   U+201C  "  LEFT DOUBLE QUOTATION MARK
 *   U+201D  "  RIGHT DOUBLE QUOTATION MARK
 *   U+201E  „  DOUBLE LOW-9 QUOTATION MARK
 *   U+201F  ‟  DOUBLE HIGH-REVERSED-9 QUOTATION MARK
 *
 * Single-quote targets  →  '  (U+0027)
 *   U+2018  '  LEFT SINGLE QUOTATION MARK
 *   U+2019  '  RIGHT SINGLE QUOTATION MARK  (also used as typographic apostrophe)
 *   U+201A  ‚  SINGLE LOW-9 QUOTATION MARK
 *   U+02BC  ʼ  MODIFIER LETTER APOSTROPHE
 *   U+02B9  ʹ  MODIFIER LETTER PRIME
 */
export function normalizeQuotemarks(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u02BC\u02B9]/g, "'");
}