/**
 * Translation Service Module
 * 
 * Provides cached translation functionality for page text using LibreTranslate API.
 * Implements LRU cache to reduce database reads and improve performance.
 * 
 * @example
 * ```typescript
 * // Get translated text with caching
 * const translatedText = await getTranslatedText({
 *   pageId: "page123",
 *   text: "Hello world",
 *   bookLanguage: "en",
 *   targetLanguage: "es"
 * });
 * ```
 */

import { dbRead, dbWrite } from "../db/client.js";
import { pageTranslations } from "../db/schema.js";
import { getErrorMessage } from "../utils/error.js";
import { translateText } from "./translate.js";
import { eq, and } from "drizzle-orm";
import { LRUCache } from "lru-cache";

// Global translation cache instance using lru-cache package
const translationCache = new LRUCache<string, string>({
  max: 1000, // Maximum number of items
  ttl: 1000 * 60 * 60, // 1 hour TTL
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * Translation request parameters
 */
interface GetTranslatedTextParams {
  /** Page ID for caching and database storage */
  pageId: string;
  /** Original text to translate */
  text: string;
  /** Source language code (ISO 639-1) */
  bookLanguage: string;
  /** Target language code (ISO 639-1) */
  targetLanguage: string;
}

/**
 * Translation result interface
 */
export interface TranslationResult {
  /** Translated text if successful */
  text?: string;
  /** Error information if translation failed */
  error?: {
    message: string;
    details: string;
    originalText: string;
  };
}

/**
 * Gets translated text with caching and database persistence
 * 
 * @param params - Translation parameters
 * @returns Translation result with text or error information
 * 
 * @example
 * ```typescript
 * const result = await getTranslatedText({
 *   pageId: "page123",
 *   text: "The hallway stretched endlessly before me...",
 *   bookLanguage: "en",
 *   targetLanguage: "es"
 * });
 * // Returns: { text: "El pasillo se extendía infinitamente ante mí..." } 
 * // or: { error: { message: "Translation failed", details: "...", originalText: "..." } }
 * ```
 */
export async function getTranslatedText({
  pageId,
  text,
  bookLanguage,
  targetLanguage
}: GetTranslatedTextParams): Promise<TranslationResult> {
  // Create cache key with safer separator
  const cacheKey = `${pageId}|${targetLanguage}`;

  // Check memory cache first
  const cachedTranslation = translationCache.get(cacheKey);
  if (cachedTranslation) {
    return { text: cachedTranslation };
  }

  try {
    // Check database for existing translation
    const existingTranslation = await dbRead
      .select()
      .from(pageTranslations)
      .where(
        and(
          eq(pageTranslations.pageId, pageId),
          eq(pageTranslations.language, targetLanguage)
        )
      )
      .limit(1);

    if (existingTranslation.length > 0) {
      const translatedText = existingTranslation[0].translatedText;
      
      // Cache the result for future requests
      translationCache.set(cacheKey, translatedText);
      
      return { text: translatedText };
    }

    // No existing translation, translate and cache
    const translatedText = await translateText({
      text,
      target: targetLanguage,
      source: bookLanguage
    });

    // Persist translation to database
    await dbWrite.insert(pageTranslations).values({
      pageId,
      language: targetLanguage,
      translatedText,
      updatedAt: new Date()
    });

    // Cache the result for future requests
    translationCache.set(cacheKey, translatedText);

    return { text: translatedText };
  } catch (error) {
    // Log translation error but return undefined to allow fallback
    const errorMessage = getErrorMessage(error);
    console.warn(`[translate] ⚠️ Failed to translate page ${pageId} to ${targetLanguage}:`, errorMessage);
    
    // Return error metadata for transparency
    return {
      error: {
        message: "Translation failed",
        details: errorMessage,
        originalText: text
      }
    };
  }
}

/**
 * Validates language code format (ISO 639-1)
 * 
 * @param languageCode - Language code to validate
 * @returns Whether the language code is valid
 */
function isValidLanguageCode(languageCode: string): boolean {
  // Basic validation for ISO 639-1 (2-letter codes)
  return /^[a-z]{2}$/.test(languageCode.toLowerCase());
}

/**
 * Checks if translation is needed based on language codes
 * 
 * @param bookLanguage - Source language code
 * @param acceptLanguage - Accept-Language header value
 * @returns Target language code if translation needed, undefined otherwise
 * 
 * @example
 * ```typescript
 * const targetLang = shouldTranslate("en", "es-MX");
 * // Returns: "es"
 * 
 * const targetLang = shouldTranslate("en", "en-US");
 * // Returns: undefined (no translation needed)
 * ```
 */
export function shouldTranslate(
  bookLanguage: string,
  acceptLanguage: string | undefined
): string | undefined {
  if (!acceptLanguage || !bookLanguage) {
    return undefined;
  }

  // Extract primary language code (e.g., "en-US" -> "en")
  const targetLanguage = acceptLanguage.split('-')[0].toLowerCase();

  // Validate language codes
  if (!isValidLanguageCode(targetLanguage) || !isValidLanguageCode(bookLanguage)) {
    console.warn(`[translate] ❓ Invalid language codes - book: ${bookLanguage}, target: ${targetLanguage}`);
    return undefined;
  }

  // Only translate if languages differ
  if (targetLanguage !== bookLanguage.toLowerCase()) {
    return targetLanguage;
  }

  return undefined;
}

/**
 * Gets translation cache statistics
 * 
 * @returns Cache size and capacity information
 */
export function getTranslationCacheStats() {
  return {
    size: translationCache.size,
    maxSize: translationCache.max,
    itemCount: translationCache.size,
    ttl: translationCache.ttl
  };
}

/**
 * Clears the translation cache
 * 
 * Useful for testing or memory management
 */
export function clearTranslationCache() {
  translationCache.clear();
}
