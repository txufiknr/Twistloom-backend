/**
 * Translation configuration
 */

/**
 * Maximum number of books to translate per cron job run
 * This prevents the job from taking too long and consuming too many API credits
 */
export const MAX_BOOKS_PER_TRANSLATION_RUN = 10;

/**
 * Maximum number of pages to translate per cron job run
 * This prevents the job from taking too long and consuming too many API credits
 */
export const MAX_PAGES_PER_TRANSLATION_RUN = 10;

/**
 * Number of books to translate in a single AI request (bulk processing)
 * Higher values are more cost-efficient but may hit token limits
 */
export const BOOKS_PER_BULK_TRANSLATION = 10;

/**
 * Number of pages to translate in a single AI request (bulk processing)
 * Higher values are more cost-efficient but may hit token limits
 */
export const PAGES_PER_BULK_TRANSLATION = 10;

/**
 * Maps ISO 639-1 language codes to their language names
 * @see https://en.wikipedia.org/wiki/ISO_639-1
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  // Major languages
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  hi: 'Hindi',
  // Southeast Asian
  id: 'Indonesian',
  ms: 'Malay',
  th: 'Thai',
  vi: 'Vietnamese',
  tl: 'Filipino',
  my: 'Burmese',
  kh: 'Khmer',
  la: 'Lao',
  // South Asian
  bn: 'Bengali',
  ur: 'Urdu',
  pa: 'Punjabi',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  gu: 'Gujarati',
  // European
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  el: 'Greek',
  cs: 'Czech',
  ro: 'Romanian',
  hu: 'Hungarian',
  tr: 'Turkish',
  he: 'Hebrew',
  // Other
  fa: 'Persian',
  sw: 'Swahili',
  af: 'Afrikaans',
};