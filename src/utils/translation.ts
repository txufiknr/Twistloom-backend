import { FastText } from '@rafaelkallis/fasttext';
import path from 'path';

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

let detector: FastText | null = null;

async function getDetector(): Promise<FastText> {
  if (detector) return detector;
  const modelPath = path.join(process.cwd(), 'models', 'lid.176.bin');
  detector = await FastText.from(modelPath);
  return detector;
}

/**
 * Detects the language of a given text using FastText WebAssembly model.
 * 
 * @param text - The text to detect language for
 * @returns ISO 639-1 language code (e.g., "en", "id") or null if confidence is below threshold
 * 
 * @example
 * ```typescript
 * const lang = await detectLanguage("Hello world");
 * // Returns: "en"
 * ```
 */
export async function detectLanguage(text: string): Promise<string | null> {
  const model = await getDetector();
  const predictions = await model.predict(text);

  if (predictions.length === 0) return null;

  const [label, confidence] = predictions[0];
  if (confidence < 0.5) return null;

  return label.replace('__label__', '');
}