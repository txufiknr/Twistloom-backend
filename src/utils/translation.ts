import { franc } from 'franc';

/**
 * Translates text using LibreTranslate API
 * 
 * @param params - Translation parameters
 * @param params.text - Text to translate
 * @param params.target - Target language code (ISO 639-1: en, es, fr, etc.)
 * @param params.source - Source language code (default: "auto" for auto-detection)
 * @returns Translated text
 * 
 * @throws Error if translation request fails
 * 
 * @example
 * ```typescript
 * const translated = await translateText({
 *   text: "The hallway stretched endlessly before me...",
 *   target: "es"
 * });
 * // Returns: "El pasillo se extendía infinitamente ante mí..."
 * ```
 */
export async function translateText({
  text,
  target,
  source = "auto",
}: {
  text: string;
  target: string;
  source?: string;
}): Promise<string> {
  const res = await fetch("https://libretranslate.com/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: text,
      source,
      target,
      format: "text",
    }),
  });

  if (!res.ok) {
    throw new Error(`LibreTranslate API returned status ${res.status}`);
  }

  const data = await res.json();
  
  if (!data.translatedText) {
    throw new Error("No translated text returned from LibreTranslate API");
  }

  return data.translatedText;
}

/**
 * Translates multiple texts in a single API call for efficiency
 * 
 * @param params - Translation parameters
 * @param params.texts - Array of texts to translate
 * @param params.target - Target language code (ISO 639-1: en, es, fr, etc.)
 * @param params.source - Source language code (default: "auto" for auto-detection)
 * @returns Array of translated texts in the same order as input
 * 
 * @throws Error if translation request fails
 * 
 * @example
 * ```typescript
 * const translated = await translateTexts({
 *   texts: ["Hello", "World", "Goodbye"],
 *   target: "es"
 * });
 * // Returns: ["Hola", "Mundo", "Adiós"]
 * ```
 */
export async function translateTexts({
  texts,
  target,
  source = "auto",
}: {
  texts: string[];
  target: string;
  source?: string;
}): Promise<string[]> {
  if (texts.length === 0) return [];

  // Single text, use the simpler function
  if (texts.length === 1) {
    return [await translateText({ text: texts[0], target, source })];
  }

  // LibreTranslate supports batch translation by sending an array
  const res = await fetch("https://libretranslate.com/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: texts,
      source,
      target,
      format: "text",
    }),
  });

  if (!res.ok) {
    throw new Error(`LibreTranslate API returned status ${res.status}`);
  }

  const data = await res.json();
  
  if (!data.translatedText || !Array.isArray(data.translatedText)) {
    throw new Error("No translated text array returned from LibreTranslate API");
  }

  return data.translatedText;
}

/**
 * Formats a language code into a human-readable label
 * 
 * @param languageCode - ISO 639-1 language code (e.g., 'id', 'es', 'fr')
 * @returns Formatted language label (e.g., "Indonesian (id)" or "id" if unknown)
 * 
 * @example
 * ```typescript
 * formatLanguage('id'); // "Indonesian (id)"
 * formatLanguage('es'); // "Spanish (es)"
 * formatLanguage('xx'); // "xx"
 * ```
 */
export function formatLanguage(languageCode: string): string {
  const languageName = getLanguageName(languageCode);
  if (languageName) return `${languageName} (${languageCode})`;
  return languageCode;
}

/**
 * Convert a BCP 47 / ISO 639-1 code into a human-readable language name.
 *
 * @example
 * getLanguageName('id')  // "Indonesian"
 * getLanguageName('fr')  // "French"
 * getLanguageName('xyz') // "xyz" (unknown codes returned as-is)
 */
export function getLanguageName(languageCode: string): string | null {
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' });
    return display.of(languageCode) ?? null;
  } catch {
    return null;
  }
}

/**
 * Maps ISO 639-3 codes (franc output) to ISO 639-1 codes.
 * Only includes languages that franc may return.
 */
const ISO_639_3_TO_1: Record<string, string> = {
  'afr': 'af', 'alb': 'sq', 'amh': 'am', 'ara': 'ar', 'arm': 'hy',
  'asm': 'as', 'aze': 'az', 'bak': 'ba', 'bel': 'be', 'ben': 'bn',
  'bos': 'bs', 'bul': 'bg', 'bur': 'my', 'cat': 'ca', 'ceb': 'ceb',
  'chi': 'zh', 'cze': 'cs', 'dan': 'da', 'dut': 'nl', 'eng': 'en',
  'epo': 'eo', 'est': 'et', 'fin': 'fi', 'fra': 'fr', 'fre': 'fr',
  'geo': 'ka', 'ger': 'de', 'gla': 'gd', 'gle': 'ga', 'glg': 'gl',
  'gre': 'el', 'guj': 'gu', 'hau': 'ha', 'heb': 'he', 'hin': 'hi',
  'hrv': 'hr', 'hun': 'hu', 'ice': 'is', 'ind': 'id', 'ita': 'it',
  'jav': 'jv', 'jpn': 'ja', 'kan': 'kn', 'kaz': 'kk', 'khm': 'km',
  'kin': 'rw', 'kir': 'ky', 'kor': 'ko', 'kur': 'ku', 'lao': 'lo',
  'lav': 'lv', 'lit': 'lt', 'mac': 'mk', 'mal': 'ml', 'mao': 'mi',
  'mar': 'mr', 'may': 'ms', 'mlg': 'mg', 'mlt': 'mt', 'mon': 'mn',
  'nep': 'ne', 'nor': 'no', 'ori': 'or', 'pan': 'pa', 'per': 'fa',
  'pol': 'pl', 'por': 'pt', 'pus': 'ps', 'rum': 'ro', 'rus': 'ru',
  'sin': 'si', 'slo': 'sk', 'slv': 'sl', 'smo': 'sm', 'sna': 'sn',
  'som': 'so', 'spa': 'es', 'srp': 'sr', 'sun': 'su', 'swa': 'sw',
  'swe': 'sv', 'tam': 'ta', 'tat': 'tt', 'tel': 'te', 'tgk': 'tg',
  'tgl': 'tl', 'tha': 'th', 'tib': 'bo', 'tir': 'ti', 'tsn': 'tn',
  'tso': 'ts', 'tuk': 'tk', 'tur': 'tr', 'uig': 'ug', 'ukr': 'uk',
  'urd': 'ur', 'uzb': 'uz', 'vie': 'vi', 'wel': 'cy', 'xho': 'xh',
  'yid': 'yi', 'yor': 'yo', 'zul': 'zu',
};

/**
 * Detects the language of a given text using franc.
 *
 * @param text - The text to detect language for
 * @returns ISO 639-1 language code (e.g., "en", "id") or null if the result is
 *   unreliable (undetermined) or unsupported
 *
 * @example
 * ```typescript
 * const lang = await detectLanguage("Hello world");
 * // Returns: "en"
 * ```
 */
export async function detectLanguage(text: string): Promise<string | null> {
  const iso6393 = franc(text);
  if (!iso6393 || iso6393 === 'und') return null;
  return ISO_639_3_TO_1[iso6393] ?? null;
}