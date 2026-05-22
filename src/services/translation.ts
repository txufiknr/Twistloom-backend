/**
 * Translation Service Module
 * 
 * Provides cached translation functionality for page text using LibreTranslate API.
 * Implements LRU cache to reduce database reads and improve performance.
 * 
 * @example
 * ```typescript
 * // Get page translation with caching
 * const translation = await getPageTranslation({
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
import { eq, and } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import type { DBPage, DBPageTranslations } from "../types/schema.js";
import type { ActionTranslation } from "../types/story.js";
import { translateTexts } from "../utils/translation.js";

// Global translation cache instance using lru-cache package
const translationCache = new LRUCache<string, DBPageTranslations>({
  max: 1000, // Maximum number of items
  ttl: 1000 * 60 * 60, // 1 hour TTL
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * Translation request parameters
 */
interface GetPageTranslationParams {
  /** Page object for caching and database storage */
  page: DBPage;
  /** Source language code (ISO 639-1) */
  bookLanguage: string;
  /** Target language code (ISO 639-1) */
  targetLanguage: string;
}

/**
 * Translation result interface
 */
export interface PageTranslationResult {
  /** Complete page translation data if successful */
  translation?: DBPageTranslations;
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
 * @returns Translation result with complete page translation data or error information
 * 
 * @example
 * ```typescript
 * const result = await getPageTranslation({
 *   pageId: "page123",
 *   text: "The hallway stretched endlessly before me...",
 *   bookLanguage: "en",
 *   targetLanguage: "es"
 * });
 * // Returns: { translation: { id: "trans123", pageId: "page123", language: "es", text: "El pasillo...", ... } } 
 * // or: { error: { message: "Translation failed", details: "...", originalText: "..." } }
 * ```
 */
export async function getPageTranslation({
  page,
  bookLanguage,
  targetLanguage
}: GetPageTranslationParams): Promise<PageTranslationResult> {
  // TODO: I've refactored this function to accept whole DBPage object instead of just text
  // can you continue complete the implementation to translate all necessary texts (text, place, keyEvents, importantObjects, actions) optimally & efficiently?

  // Create cache key with safer separator
  const cacheKey = `${page.id}|${targetLanguage}`;

  // Check memory cache first
  const cachedTranslation = translationCache.get(cacheKey);
  if (cachedTranslation) {
    return { translation: cachedTranslation };
  }

  try {
    // Check database for existing translation
    const existingTranslation = await dbRead
      .select()
      .from(pageTranslations)
      .where(
        and(
          eq(pageTranslations.pageId, page.id),
          eq(pageTranslations.language, targetLanguage)
        )
      )
      .limit(1);

    if (existingTranslation.length > 0) {
      const translation = existingTranslation[0];
      
      // Cache the result for future requests
      translationCache.set(cacheKey, translation);
      
      return { translation };
    }

    // No existing translation, translate all fields efficiently
    // Collect all texts to translate in bulk
    const textsToTranslate: string[] = [page.text];
    const textIndices: { [key: string]: number } = { text: 0 };

    let placeIndex: number | undefined;
    if (page.place) {
      placeIndex = textsToTranslate.length;
      textIndices.place = placeIndex;
      textsToTranslate.push(page.place);
    }

    let keyEventsStartIndex: number | undefined;
    if (page.keyEvents && page.keyEvents.length > 0) {
      keyEventsStartIndex = textsToTranslate.length;
      textsToTranslate.push(...page.keyEvents);
    }

    let importantObjectsStartIndex: number | undefined;
    if (page.importantObjects && page.importantObjects.length > 0) {
      importantObjectsStartIndex = textsToTranslate.length;
      textsToTranslate.push(...page.importantObjects);
    }

    let actionsStartIndex: number | undefined;
    if (page.actions && page.actions.length > 0) {
      actionsStartIndex = textsToTranslate.length;
      textsToTranslate.push(...page.actions.map((a) => a.text));
    }

    // Translate all texts in a single API call
    const translatedTexts = await translateTexts({
      texts: textsToTranslate,
      target: targetLanguage,
      source: bookLanguage
    });

    // Extract translated values from the result array
    const translatedText = translatedTexts[0];
    const translatedPlace = placeIndex !== undefined ? translatedTexts[placeIndex] : undefined;
    const translatedKeyEvents = keyEventsStartIndex !== undefined 
      ? translatedTexts.slice(keyEventsStartIndex, keyEventsStartIndex + (page.keyEvents?.length || 0))
      : [];
    const translatedImportantObjects = importantObjectsStartIndex !== undefined
      ? translatedTexts.slice(importantObjectsStartIndex, importantObjectsStartIndex + (page.importantObjects?.length || 0))
      : [];
    const translatedActions: ActionTranslation[] = actionsStartIndex !== undefined
      ? page.actions!.map((action, i) => ({
          originalText: action.text,
          text: translatedTexts[actionsStartIndex! + i]
        }))
      : [];

    // Persist translation to database
    const newTranslation = await dbWrite.insert(pageTranslations).values({
      pageId: page.id,
      language: targetLanguage,
      text: translatedText,
      place: translatedPlace,
      keyEvents: translatedKeyEvents,
      importantObjects: translatedImportantObjects,
      actions: translatedActions,
      providerType: 'translator',
      providerName: 'libre',
      updatedAt: new Date()
    }).returning();

    const translation = newTranslation[0];

    // Cache the result for future requests
    translationCache.set(cacheKey, translation);

    return { translation };
  } catch (error) {
    // Log translation error but return undefined to allow fallback
    const errorMessage = getErrorMessage(error);
    console.warn(`[translate] ⚠️ Failed to translate page ${page.id} to ${targetLanguage}:`, errorMessage);
    
    // Return error metadata for transparency
    return {
      error: {
        message: "Translation failed",
        details: errorMessage,
        originalText: page.text
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
 * @param headerLanguage - Accept-Language header value
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
  headerLanguage?: string | null
): string | undefined {
  // Early exit: source or target language are not provided
  if (!headerLanguage || !bookLanguage) return undefined;

  // Extract primary language code (e.g., "en-US" -> "en")
  const targetLanguage = headerLanguage.split('-')[0].toLowerCase();

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
