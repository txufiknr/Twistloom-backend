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
import { translateTexts } from "../utils/translation.js";
import type { DBBookTranslations, DBPage, DBPageTranslations } from "../types/schema.js";
import type { ActionTranslation } from "../types/story.js";
import type { BookTranslation, PageTranslation } from "../types/book.js";
import { isValidLanguageCode } from "../utils/search.js";

// Global translation cache instance using lru-cache package
const translationCache = new LRUCache<string, PageTranslation>({
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
  translation?: PageTranslation;
  /** Error information if translation failed */
  error?: {
    message: string;
    details: string;
    originalText: string;
  };
}

/**
 * Gets translated page text with multi-level caching and database persistence
 * 
 * This function implements a three-tier caching strategy:
 * 1. Memory cache (LRU) - Fastest, for frequently accessed translations
 * 2. Database cache - Persistent storage for all translations
 * 3. Translation API - LibreTranslate for new translations
 * 
 * **Translation Scope:**
 * Translates all page content in a single bulk API call for efficiency:
 * - Main page text
 * - Location/place name (if present)
 * - Key events (if present)
 * - Important objects (if present)
 * - Action texts (if present)
 * 
 * **Error Handling:**
 * Returns error metadata instead of throwing to allow graceful fallback.
 * The caller can display the original text if translation fails.
 * 
 * @param params - Translation parameters
 * @param params.page - Page object containing text and metadata to translate
 * @param params.bookLanguage - Source language code (e.g., 'en', 'es')
 * @param params.targetLanguage - Target language code for translation
 * @returns Translation result with complete page translation data or error information
 * 
 * @example
 * ```typescript
 * // Successful translation
 * const result = await getPageTranslation({
 *   page: dbPage,
 *   bookLanguage: "en",
 *   targetLanguage: "es"
 * });
 * if (result.translation) {
 *   console.log('Translated text:', result.translation.text);
 * }
 * 
 * // Handle translation failure gracefully
 * if (result.error) {
 *   console.warn('Translation failed:', result.error.message);
 *   // Fall back to original text
 *   displayOriginalText(page.text);
 * }
 * ```
 */
export async function getPageTranslation({
  page,
  bookLanguage,
  targetLanguage
}: GetPageTranslationParams): Promise<PageTranslationResult> {
  // Create cache key with safer separator
  const cacheKey = `${page.id}|${targetLanguage}`;

  // Check memory cache first (fastest path)
  const cachedTranslation = translationCache.get(cacheKey);
  if (cachedTranslation) return { translation: cachedTranslation };

  try {
    // Check database for existing translation (second fastest path)
    const [dbTranslation] = await dbRead
      .select()
      .from(pageTranslations)
      .where(
        and(
          eq(pageTranslations.pageId, page.id),
          eq(pageTranslations.language, targetLanguage)
        )
      )
      .limit(1);

    if (dbTranslation) {
      const translation = mapToPageTranslation(dbTranslation);
      // Cache the result for future requests
      translationCache.set(cacheKey, translation);
      return { translation };
    }

    // No existing translation, translate all fields using LibreTranslate API
    const translation = await translatePageWithLibre({ page, bookLanguage, targetLanguage, cacheKey });
    return { translation };
  } catch (error) {
    // Log translation error but return error metadata to allow graceful fallback
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
 * Translates page content using LibreTranslate API with bulk optimization
 * 
 * This function implements efficient bulk translation by collecting all page texts
 * into a single array and translating them in one API call. This significantly reduces
 * API overhead compared to translating each text individually.
 * 
 * **Translation Strategy:**
 * 1. Collect all translatable texts into a single array with index tracking
 * 2. Make single bulk API call to LibreTranslate
 * 3. Extract translated values using pre-calculated indices
 * 4. Persist to database for future use
 * 5. Cache in memory for fastest subsequent access
 * 
 * **Translated Fields:**
 * - Main page text (always translated)
 * - Place/location name (optional)
 * - Key events array (optional)
 * - Important objects array (optional)
 * - Action texts array (optional)
 * 
 * **Index Tracking:**
 * Uses index-based extraction to map translated results back to their original fields.
 * This approach is more efficient than object-based tracking for array operations.
 * 
 * @param params - Translation parameters
 * @param params.page - Page object containing text and metadata to translate
 * @param params.bookLanguage - Source language code (e.g., 'en', 'es')
 * @param params.targetLanguage - Target language code for translation
 * @param params.cacheKey - Cache key for storing the translation result
 * @returns Complete translation object with all translated fields
 * 
 * @example
 * ```typescript
 * const translation = await translatePageWithLibre({
 *   page: {
 *     id: "page123",
 *     text: "The hallway stretched endlessly...",
 *     place: "Abandoned Mansion",
 *     keyEvents: ["Door creaked", "Lights flickered"],
 *     actions: [{ text: "Open the door" }]
 *   },
 *   bookLanguage: "en",
 *   targetLanguage: "es",
 *   cacheKey: "page123|es"
 * });
 * // Returns: { id: "trans456", pageId: "page123", language: "es", text: "El pasillo...", ... }
 * ```
 */
async function translatePageWithLibre({
  page,
  bookLanguage,
  targetLanguage,
  cacheKey
}: GetPageTranslationParams & { cacheKey: string }): Promise<PageTranslation> {
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

  // Translate all texts in a single API call (bulk optimization)
  const translatedTexts = await translateTexts({
    texts: textsToTranslate,
    target: targetLanguage,
    source: bookLanguage
  });

  // Extract translated values from the result array using pre-calculated indices
  const translatedText = translatedTexts[0];
  const translatedPlace = placeIndex ? translatedTexts[placeIndex] : undefined;
  const translatedKeyEvents = keyEventsStartIndex ? translatedTexts.slice(keyEventsStartIndex, keyEventsStartIndex + (page.keyEvents?.length || 0)) : [];
  const translatedImportantObjects = importantObjectsStartIndex ? translatedTexts.slice(importantObjectsStartIndex, importantObjectsStartIndex + (page.importantObjects?.length || 0)) : [];
  const translatedActions: ActionTranslation[] = actionsStartIndex ? page.actions!.map((action, i) => ({
    originalText: action.text,
    text: translatedTexts[actionsStartIndex! + i]
  })) : [];

  // Persist new translation to database
  const [newTranslation] = await dbWrite.insert(pageTranslations).values({
    pageId: page.id,
    language: targetLanguage,
    text: translatedText,
    place: translatedPlace,
    // TODO: timeOfDay: translatedTimeOfDay,
    // TODO: mood: translatedMood,
    // TODO: weather: translatedWeather,
    keyEvents: translatedKeyEvents,
    importantObjects: translatedImportantObjects,
    // TODO: contextHistory: translatedContextHistory,
    actions: translatedActions,
    providerType: 'translator',
    providerName: 'libre',
    updatedAt: new Date()
  }).returning();

  const translation = mapToPageTranslation(newTranslation);
  translationCache.set(cacheKey, translation); // Cache the result for future requests
  return translation;
}

export function mapToPageTranslation(dbPageTranslations: DBPageTranslations): PageTranslation {
  return {
    text: dbPageTranslations.text,
    place: dbPageTranslations.place,
    timeOfDay: dbPageTranslations.timeOfDay,
    mood: dbPageTranslations.mood,
    weather: dbPageTranslations.weather,
    keyEvents: dbPageTranslations.keyEvents,
    importantObjects: dbPageTranslations.importantObjects,
    actions: dbPageTranslations.actions,
    contextHistory: dbPageTranslations.contextHistory,
  } satisfies Record<keyof PageTranslation, unknown>;
}

export function mapToBookTranslation(dbBookTranslations: DBBookTranslations): BookTranslation {
  return {
    title: dbBookTranslations.title,
    hook: dbBookTranslations.hook,
    summary: dbBookTranslations.summary,
    keywords: dbBookTranslations.keywords,
    mc: dbBookTranslations.mc,
  } satisfies Record<keyof BookTranslation, unknown>;
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
