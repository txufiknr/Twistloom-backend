import { dedupe } from "./parser.js";
import { correctDoubleQuotes } from "./quote.js";

/**
 * Finds all keywords from a list that appear as whole words in the text
 * @summary Uses regex with word boundaries to prevent false positives from substring matches
 * @description Prevents false positives like "elected" matching "selected" by ensuring
 * keywords are matched as whole words only using \b word boundaries.
 *
 * @param text - Text to search within
 * @param keywords - Array of keywords to search for (readonly supported)
 * @returns Array of matched keywords (original case), empty array if none found
 *
 * @example
 * ```typescript
 * hasKeywords("the selected item", ["elected"]); // [] - "elected" doesn't match "selected"
 * hasKeywords("the elected official", ["elected"]); // ["elected"] - exact word match
 * hasKeywords("president was elected", ["president", "elected"]); // ["president", "elected"] - matches both
 * ```
 */
export function hasKeywords(text: string | undefined | null, keywords: readonly string[]): string[] {
  if (!text || !keywords || keywords.length === 0) return [];

  const textLower = text.toLowerCase();
  const matched: string[] = [];

  for (const keyword of keywords) {
    // Escape special regex characters in the keyword
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Use word boundaries to match whole words only
    const regex = new RegExp(`\\b${escapedKeyword}\\b`);
    if (regex.test(textLower)) {
      matched.push(keyword);
    }
  }

  return matched;
}

/**
 * Formats an array of strings as a quoted-or-separated string for inclusion in prompts
 * @param items - Array of strings to format
 * @param separator - Separator to use between items (default: ', ')
 * @returns Formatted string with items quoted and joined by the separator
 */
export function formatOneOf(items: string[] | readonly string[], separator: string = ', '): string {
  return `'${items.join(`'${separator}'`)}'`;
}

/**
 * Enhanced HTML entity decoding with fallback
 * Handles numeric entities, named entities, and common edge cases
 */
function decodeHTMLEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';
  
  try {
    // Try to use html-entities library if available (imported in rss.ts)
    // For now, use our comprehensive manual implementation
    let decoded = text;
    
    // Comprehensive entity mapping for common and problematic entities
    const entityMap: Record<string, string> = {
      // Basic HTML entities
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&nbsp;': ' ',
      
      // Common punctuation and typography
      '&#8211;': '–',   // en dash
      '&#8212;': '—',   // em dash  
      '&#8216;': '\u2018',   // left single quote
      '&#8217;': '\u2019',   // right single quote
      '&#8220;': '\u201C',   // left double quote
      '&#8221;': '\u201D',   // right double quote
      '&#8230;': '\u2026',   // ellipsis
      '&#8242;': '\u2032',   // prime
      '&#8243;': '\u2033',   // double prime
      '&#8249;': '\u2039',   // left angle quote
      '&#8250;': '\u203A',   // right angle quote
      
      // Spanish characters (common in Latin American news)
      '&#225;': 'á',    // á
      '&#233;': 'é',    // é
      '&#237;': 'í',    // í
      '&#243;': 'ó',    // ó
      '&#250;': 'ú',    // ú
      '&#241;': 'ñ',    // ñ
      '&#193;': 'Á',    // Á
      '&#201;': 'É',    // É
      '&#205;': 'Í',    // Í
      '&#211;': 'Ó',    // Ó
      '&#218;': 'Ú',    // Ú
      '&#209;': 'Ñ',    // Ñ
      '&#252;': 'ü',    // ü
      '&#220;': 'Ü',    // Ü
      '&#224;': 'à',    // à
      '&#232;': 'è',    // è
      '&#236;': 'ì',    // ì
      '&#242;': 'ò',    // ò
      '&#249;': 'ù',    // ù
      '&#192;': 'À',    // À
      '&#200;': 'È',    // È
      '&#204;': 'Ì',    // Ì
      '&#210;': 'Ò',    // Ò
      '&#217;': 'Ù',    // Ù
      '&#231;': 'ç',    // ç
      '&#199;': 'Ç',    // Ç
      
      // German characters
      '&#228;': 'ä',    // ä
      '&#196;': 'Ä',    // Ä
      '&#246;': 'ö',    // ö
      '&#214;': 'Ö',    // Ö
      '&#223;': 'ß',    // ß
      
      // French characters
      '&#226;': 'â',    // â
      '&#234;': 'ê',    // ê
      '&#238;': 'î',    // î
      '&#244;': 'ô',    // ô
      '&#251;': 'û',    // û
      '&#239;': 'ï',    // ï
      '&#254;': 'þ',    // þ
      '&#255;': 'ÿ',    // ÿ
      '&#194;': 'Â',    // Â
      '&#202;': 'Ê',    // Ê
      '&#206;': 'Î',    // Î
      '&#212;': 'Ô',    // Ô
      '&#219;': 'Û',    // Û
      '&#207;': 'Ï',    // Ï
      '&#222;': 'Þ',    // Þ
      
      // Currency symbols
      '&#8364;': '€',   // Euro
      '&#163;': '£',   // Pound
      '&#165;': '¥',   // Yen
      '&#162;': '¢',   // Cent
      
      // Mathematical symbols
      '&#8804;': '≤',   // less than or equal
      '&#8805;': '≥',   // greater than or equal
      '&#8776;': '≈',   // approximately equal
      '&#8800;': '≠',   // not equal
      '&#8734;': '∞',   // infinity
      '&#8721;': '∑',   // summation
      '&#8730;': '√',   // square root
      '&#8719;': '∏',   // product
      
      // Common symbols
      '&#169;': '©',   // copyright
      '&#174;': '®',   // registered
      '&#8482;': '™',  // trademark
      '&#176;': '°',   // degree
      '&#8240;': '‰',  // per mille
      '&#8226;': '•',  // bullet
      '&#8224;': '†',  // dagger
      '&#8225;': '‡',  // double dagger
      '&#8218;': '‚',  // single low-9 quotation mark
      '&#8219;': '‛',  // single high-reversed-9 quotation mark
      '&#8222;': '„',  // double low-9 quotation mark
      '&#8223;': '‟',  // double high-reversed-9 quotation mark
      
      // Arrows
      '&#8592;': '←',  // left arrow
      '&#8593;': '↑',  // up arrow
      '&#8594;': '→',  // right arrow
      '&#8595;': '↓',  // down arrow
      '&#8596;': '↔',  // left right arrow
      '&#8597;': '↕',  // up down arrow
      
      // Geometric shapes
      '&#9632;': '■',  // black square
      '&#9633;': '□',  // white square
      '&#9642;': '▪',  // black small square
      '&#9643;': '▫',  // white small square
      '&#9650;': '▲',  // black up-pointing triangle
      '&#9660;': '▼',  // black down-pointing triangle
      '&#9654;': '▶',  // black right-pointing triangle
      '&#9664;': '◀',  // black left-pointing triangle
      '&#9670;': '◊',  // lozenge
      '&#9679;': '●',  // black circle
      '&#9700;': '◐',  // circle with left half black
      '&#9701;': '◑',  // circle with right half black
      '&#9702;': '◒',  // circle with lower half black
      '&#9703;': '◓',  // circle with upper half black
      '&#9704;': '◔',  // circle with dot
      '&#9705;': '◕',  // circle with two dots
      '&#9708;': '◖',  // left half black circle
      '&#9709;': '◗',  // right half black circle
      '&#9711;': '○',  // white circle
    };
    
    // Apply manual entity mapping
    for (const [entity, char] of Object.entries(entityMap)) {
      decoded = decoded.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), char);
    }
    
    // Handle numeric entities with error handling
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
      try {
        const code = parseInt(dec, 10);
        // Validate code point range
        if (code >= 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)) {
          return String.fromCodePoint(code);
        }
        return match; // Return original if invalid
      } catch {
        return match; // Return original if conversion fails
      }
    });
    
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      try {
        const code = parseInt(hex, 16);
        // Validate code point range
        if (code >= 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)) {
          return String.fromCodePoint(code);
        }
        return match; // Return original if invalid
      } catch {
        return match; // Return original if conversion fails
      }
    });
    
    return decoded;
  } catch (error) {
    console.warn('HTML entity decoding failed, returning original text:', error);
    return text;
  }
}

/**
 * Removes control characters and corruption indicators from text
 * This is a shared utility used by both sanitizeTextForDB and cleanHtmlContent
 * 
 * @param text - The text to clean
 * @returns Text with control characters and corruption removed
 */
export function removeControlCharacters(text: string): string {
  return text
    // Remove null bytes (most critical)
    .replace(/\0/g, '')
    // Remove UTF-8 replacement characters (corruption indicators)
    .replace(/\uFFFD/g, '')
    // Remove control characters (except common whitespace: tab, newline, carriage return)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remove Unicode non-characters and reserved code points
    .replace(/[\uFFFE\uFFFF]/g, '')
    // Remove invisible Unicode characters that can cause issues
    .replace(/[\u00AD\u200B\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2060\uFEFF]/g, '')
    // Remove bidirectional override characters (can be used in attacks)
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    // Remove zero-width characters
    .replace(/[\u200E\u200F]/g, '');
}

/**
 * Normalize text before matching — NFKC + strip zero-width chars.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

export function cleanText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' '); // Remove CDATA sections
}

/**
 * Unicode normalize (NFKC) and strip diacritics (NFD + remove marks)
 */
export function normalizeTextForCompare(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Sanitizes text to remove binary/null bytes and invalid characters
 * Ensures text is safe for database insertion and XML parsing, includes html entity decoding and tag removal
 * @param text - The text to sanitize
 * @returns Sanitized text safe for database storage
 */
export function sanitizeTextForDB(text: string): string {
  if (!text || typeof text !== 'string') return '';
  
  // Step 1: Decode HTML entities
  let cleaned = decodeHTMLEntities(text);
  
  // Step 2: Remove HTML tags and broken fragments with enhanced patterns
  cleaned = cleaned
    // Remove complete HTML tags
    .replace(/<[^>]*>/g, ' ')
    // Remove broken/incomplete tags at end of strings
    .replace(/<[^>]*$/g, '')
    // Remove orphaned closing tags
    .replace(/<\/[^>]*$/g, '')
    // Remove any remaining tag fragments
    .replace(/<[^>]*\s*$/g, '')
    // Remove CDATA sections that might contain problematic content
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ');
  
  // Step 3: Enhanced control character and corruption filtering
  cleaned = removeControlCharacters(cleaned);
  
  // Step 4: Final cleanup and validation
  cleaned = cleaned
    // Normalize whitespace again after character removal
    .replace(/\s+/g, ' ')
    // Remove leading/trailing whitespace
    .trim();
  
  // Step 5: Additional safety checks
  // If the text is extremely short after cleaning, it might have been corrupted
  if (cleaned.length < text.length / 10) {
    console.warn('[sanitizeTextForDB] ⚠️ Text became extremely short after sanitization, possible corruption detected');
    return ''; // Return empty string to prevent corrupted data
  }
  
  // Check for excessive repetition (indicates corruption)
  const repeatedChars = cleaned.match(/(.)\1{10,}/g);
  if (repeatedChars && repeatedChars.length > 3) {
    console.warn('[sanitizeTextForDB] ⚠️ Text contains excessive repeated characters, possible corruption detected');
    return '';
  }
  
  return cleaned;
}

/**
 * Generates a clean, URL-friendly slug from text
 * 
 * Creates SEO-friendly slugs by:
 * - Converting to lowercase
 * - Removing special characters and punctuation
 * - Replacing spaces and separators with hyphens
 * - Removing minimal stop words for cleaner URLs
 * - Ensuring valid slug format
 * 
 * @param text - The text to convert to slug (typically book title)
 * @returns Clean, URL-friendly slug string
 * 
 * @example
 * ```typescript
 * generateSlug("The Amazing Adventure of Tom Sawyer") // "amazing-adventure-tom-sawyer"
 * generateSlug("Mystery & Crime: A Detective's Story") // "mystery-crime-detectives-story"
 * generateSlug("  Hello, World!  ") // "hello-world"
 * ```
 */
export function generateSlug(text: string): string {
  if (!text || typeof text !== 'string') return '';
  
  // Step 1: Sanitize and normalize the text
  const cleaned = sanitizeText(text);
  
  // Step 2: Remove only the most common stop words that don't add meaning
  const stopWords = new Set([
    'a', 'an', 'the' // Only remove articles, keep meaningful words
  ]);
  
  // Step 3: Convert to lowercase and split into words
  const words = cleaned
    .toLowerCase()
    .split(/\s+/) // Split on whitespace
    .filter(word => word.length > 0) // Remove empty strings
    .filter(word => !stopWords.has(word)) // Remove minimal stop words
    .filter(word => word.length > 0); // Keep all words including single letters
  
  // Step 4: Join with hyphens and clean up
  let slug = words.join('-');
  
  // Step 5: Handle special characters and numbers better
  slug = slug
    .replace(/[^a-z0-9-]/g, '') // Keep only lowercase letters, numbers, and hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  
  // Step 6: Ensure minimum length and maximum length
  if (slug.length < 1 && words.length > 0) {
    // If slug is empty after cleaning, use first word
    slug = words[0].substring(0, 20);
  }
  
  // Limit slug length to reasonable size (50 characters max)
  if (slug.length > 50) {
    slug = slug.substring(0, 50).replace(/-[^-]*$/, ''); // Don't cut off in middle of word
  }
  
  return slug;
}

/**
 * Converts text into a normalized, lowercase slug.
 *
 * Unicode diacritics are removed, non-alphanumeric characters are
 * replaced with the specified separator, repeated separators are
 * collapsed, and leading/trailing separators are trimmed.
 *
 * Guaranteed to be idempotent.
 *
 * @param text - Text to slugify.
 * @param separator - Segment separator. Defaults to "_".
 * @returns The normalized slug.
 */
export function slugify(text: string, separator: string = "_"): string {
  if (!text) return "";

  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escapedSeparator}+`, "g"), separator)
    .replace(
      new RegExp(`^${escapedSeparator}|${escapedSeparator}$`, "g"),
      "",
    );
}

/**
 * Optimized pure function.
 * Note: Caller must pass a Set, not an Array, to prevent O(N^2) recreation.
 * 
 * @example
 * const baseId = generateCharacterId(name);
 * const uniqueId = ensureUniqueId(baseId, existingIds);
 */
export function ensureUniqueId(id: string, existingIds: Set<string>, options?: { separator?: string, alwaysShowSuffix?: boolean }): string {
  const { separator = "_", alwaysShowSuffix = false } = options ?? {};
  
  // if `alwaysShowSuffix` true, always show "_1" counter suffix when no duplicate
  if (!existingIds.has(id)) return alwaysShowSuffix ? `${id}${separator}1` : id;
  
  let suffix = 2;
  while (existingIds.has(`${id}${separator}${suffix}`)) {
    suffix++;
  }

  return `${id}${separator}${suffix}`;
}

/**
 * Truncates text to fit within `maxLength` while preserving complete sentences.
 *
 * If the hard cut at `maxLength` falls mid-sentence, the function backs up to
 * the last sentence-ending punctuation (`.`, `!`, `?`) within the limit. If no
 * sentence boundary exists within the limit, it falls back to the last word
 * boundary. The truncation is then trimmed of trailing whitespace/punctuation.
 *
 * @param text      - Text to truncate.
 * @param maxLength - Maximum character length (must be > 0).
 * @returns Truncated text ending on a complete sentence when possible.
 *
 * @example
 * truncateToLastCompleteSentence("Hello world. This is a test.", 20)
 * // → "Hello world."
 *
 * truncateToLastCompleteSentence("No punctuation here at all", 15)
 * // → "No punctuation"
 *
 * truncateToLastCompleteSentence("Short.", 100)
 * // → "Short."
 */
export function truncateToLastCompleteSentence(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const trimmed = text.trim();

  // Sentence-ending punctuation
  const SENTENCE_BOUNDARY = /[.!?]/;

  // 1. Try to find the last sentence boundary within the limit
  const candidate = trimmed.substring(0, maxLength);
  const lastBoundary = candidate.search(SENTENCE_BOUNDARY);

  if (lastBoundary !== -1) {
    // Find the last occurrence of sentence-ending punctuation within the candidate
    let cutAt = -1;
    for (let i = maxLength - 1; i >= 0; i--) {
      if (SENTENCE_BOUNDARY.test(candidate[i])) {
        cutAt = i + 1; // Include the punctuation
        break;
      }
    }
    if (cutAt !== -1) {
      return trimmed.substring(0, cutAt).trimEnd();
    }
  }

  // 2. Fall back to last word boundary within the limit
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace !== -1) {
    return trimmed.substring(0, lastSpace).trimEnd();
  }

  // 3. Hard fallback — single word exceeding limit
  return candidate;
}

export function sanitizeText(text: string): string {
  return correctDoubleQuotes(sanitizeTextForDB(text.trim()));
}

export function sanitizeKeywords(keywords: string[]): string[] {
  return dedupe(keywords?.map(k => k.trim().toLowerCase()).filter(Boolean) ?? []);
}