import { correctDoubleQuotes } from "./quote.js";

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
  if (cleaned.length < 10 && text.length > 100) {
    console.warn('Text became extremely short after sanitization, possible corruption detected');
    return ''; // Return empty string to prevent corrupted data
  }
  
  // Check for excessive repetition (indicates corruption)
  const repeatedChars = cleaned.match(/(.)\1{10,}/g);
  if (repeatedChars && repeatedChars.length > 3) {
    console.warn('Text contains excessive repeated characters, possible corruption detected');
    return '';
  }
  
  return cleaned;
}

export function sanitizeText(text: string): string {
  return correctDoubleQuotes(sanitizeTextForDB(text.trim()));
}