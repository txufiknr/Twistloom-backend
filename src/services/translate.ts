/**
 * Translation Service Module
 * 
 * Provides text translation functionality using LibreTranslate API.
 * Supports automatic language detection and multi-language translation.
 * 
 * @example
 * ```typescript
 * // Basic translation
 * const translated = await translateText({
 *   text: "Hello world",
 *   target: "es"
 * });
 * 
 * // Translation with explicit source language
 * const translated = await translateText({
 *   text: "Bonjour le monde",
 *   source: "fr",
 *   target: "en"
 * });
 * ```
 */

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
