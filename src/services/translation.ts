/**
 * Translation Service Module
 *
 * Provides cached translation functionality for page text using LibreTranslate API.
 * Implements LRU cache to reduce database reads and improve performance.
 *
 * @example
 * ```typescript
 * // Get page translation with caching
 * const result = await getPageTranslation({
 *   page: dbPage,
 *   bookLanguage: "en",
 *   targetLanguage: "es"
 * });
 * if (result.translation) {
 *   const enriched = applyPageTranslation(persistedPage, result.translation);
 * }
 * ```
 */

import { dbRead, dbWrite } from "../db/client.js";
import { pageTranslations } from "../db/schema.js";
import { getErrorMessage } from "../utils/error.js";
import { eq, and } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { translateTexts } from "../utils/translation.js";
import type { DBBookTranslations, DBPage, DBPageTranslations } from "../types/schema.js";
import type { ActionTranslation, PersistedStoryPage, TranslatedStoryPage } from "../types/story.js";
import type { BookTranslation, PageToTranslate, PageTranslation } from "../types/book.js";
import type { PlaceMemoryTranslation } from "../types/places.js";
import type { CharacterMemoryTranslation, InventoryItemTranslation, InjuryTranslation } from "../types/character.js";
import type { TraitItem } from "../types/story.js";
import type { StoryThreadTranslation, ThreadClueTranslation } from "../types/story-thread.js";
import { isValidLanguageCode } from "../utils/search.js";
import { getBook, mapToPersistedStoryPage } from "./book.js";
import { getStoryStateFromPage } from "./story.js";

// Global translation cache instance using lru-cache package
const translationCache = new LRUCache<string, PageTranslation>({
  max: 1000,
  ttl: 1000 * 60 * 60, // 1 hour TTL
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * Translation request parameters
 */
interface GetPageTranslationParams {
  /** Page object for caching and database storage */
  page: PageToTranslate;
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
 * Translation Scope:
 * Translates all page content in a single bulk API call for efficiency:
 * - Main page text
 * - Time of day (if present)
 * - Mood (if present)
 * - Weather (if present)
 * - Key events (if present)
 * - Important objects (if present)
 * - Action texts (if present)
 * - Context history (from state, if present)
 * - Places (from state, if present)
 *
 * Error Handling:
 * Returns error metadata instead of throwing to allow graceful fallback.
 * The caller can display the original text if translation fails.
 *
 * @param params - Translation parameters
 * @returns Translation result with complete page translation data or error information
 */
export async function getPageTranslation({
  page,
  bookLanguage,
  targetLanguage,
}: GetPageTranslationParams): Promise<PageTranslationResult> {
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
      translationCache.set(cacheKey, translation);
      return { translation };
    }

    // No existing translation — translate all fields via LibreTranslate in one call
    const translation = await translatePageWithLibre({ page, bookLanguage, targetLanguage, cacheKey });
    return { translation };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.warn(`[translate] ⚠️ Failed to translate page ${page.id} to ${targetLanguage}:`, errorMessage);

    return {
      error: {
        message: "Translation failed",
        details: errorMessage,
        originalText: page.text,
      },
    };
  }
}

/**
 * Translates page content using LibreTranslate API with bulk optimisation.
 *
 * All translatable fields are collected into a single flat array so the API is
 * called exactly once, regardless of how many optional fields the page has.
 * Indices are tracked up-front; after the call each field is sliced/indexed back
 * out of the result array.
 *
 * Index Tracking Rules:
 * - Use `!== undefined` (never truthiness) when reading back optional indices,
 *   because an index of `0` is falsy but perfectly valid.
 * - Each optional scalar gets a dedicated index variable.
 * - Each optional array gets a start-index variable; the slice length equals the
 *   original array length, which is known before the API call.
 *
 * Fields Translated:
 * · text
 * · timeOfDay
 * · mood
 * · weather
 * · keyEvents
 * · importantObjects
 * · actions (text, hint)
 * · actionsHistory (text, hint)
 * · contextHistory
 * · places (knownName, realName, type, context)
 * · characters (knownName, realName, role, bio)
 * · inventory (name, where, traits)
 * · injuries (bodyPart, description, consequences)
 * · threads (title, question, summary, clues)
 */
async function translatePageWithLibre({
  page,
  bookLanguage,
  targetLanguage,
  cacheKey,
}: GetPageTranslationParams & { cacheKey: string }): Promise<PageTranslation> {

  // ── Build the flat batch array ───────────────────────────────────────────────
  const batch: string[] = [page.text]; // index 0 is always the main text

  // Optional scalar fields — each may or may not exist
  let timeOfDayIndex: number | undefined;
  if (page.timeOfDay) {
    timeOfDayIndex = batch.length;
    batch.push(page.timeOfDay);
  }

  let moodIndex: number | undefined;
  if (page.mood) {
    moodIndex = batch.length;
    batch.push(page.mood);
  }

  let weatherIndex: number | undefined;
  if (page.weather) {
    weatherIndex = batch.length;
    batch.push(page.weather);
  }

  let contextHistoryIndex: number | undefined;
  if (page.state.contextHistory) {
    contextHistoryIndex = batch.length;
    batch.push(page.state.contextHistory);
  }

  // Optional places map — translate select fields for each place (knownName, realName, context)
  // We push three strings per place and remember start indices per place key.
  let placeIds: string[] = [];
  let placesStartMap: Record<string, number> | undefined;
  if (page.state?.places && Object.keys(page.state.places).length) {
    placeIds = Object.keys(page.state.places);
    placesStartMap = {};
    for (const placeKey of placeIds) {
      const place = page.state.places[placeKey];
      // Record the start index for this place and push the three fields
      placesStartMap[placeKey] = batch.length;
      batch.push(place.knownName ?? '', place.realName ?? '', place.context ?? '');
    }
  }

  // Optional array fields — push all elements; remember where each starts
  let keyEventsStart: number | undefined;
  if (page.keyEvents?.length) {
    keyEventsStart = batch.length;
    batch.push(...page.keyEvents);
  }

  let importantObjectsStart: number | undefined;
  if (page.importantObjects?.length) {
    importantObjectsStart = batch.length;
    batch.push(...page.importantObjects);
  }

  // Optional: characters (Record<string, CharacterMemory>) — translate role + bio per character
  let characterIds: string[] = [];
  let charactersStartMap: Record<string, number> | undefined;
  if (page.state?.characters && Object.keys(page.state.characters).length) {
    characterIds = Object.keys(page.state.characters);
    charactersStartMap = {};
    for (const cid of characterIds) {
      const ch = page.state.characters[cid];
      charactersStartMap[cid] = batch.length;
      batch.push(ch.role ?? '', ch.bio ?? '');
    }
  }

  // Optional: inventory — translate name, where, plus trait values (preserve trait keys)
  let inventoryStartMap: Record<number, { start: number; traitKeys: string[]; traitCount: number }> | undefined;
  let inventoryCount = 0;
  if (page.state?.inventory && page.state.inventory.length) {
    inventoryStartMap = {};
    for (let i = 0; i < page.state.inventory.length; i++) {
      const item = page.state.inventory[i];
      const traitKeys: string[] = (item.traits ?? []).map((t) => t.key);
      inventoryStartMap[i] = { start: batch.length, traitKeys, traitCount: (item.traits ?? []).length };
      batch.push(item.name ?? '', item.where ?? '');
      // push trait values
      for (const t of (item.traits ?? [])) batch.push(t.value ?? '');
      inventoryCount++;
    }
  }

  // Optional: injuries — translate bodyPart, description, consequences per injury
  let injuriesStart: number | undefined;
  if (page.state?.injuries && page.state.injuries.length) {
    injuriesStart = batch.length;
    for (const inj of page.state.injuries) {
      batch.push(inj.bodyPart ?? '', inj.description ?? '', inj.consequences ?? '');
    }
  }

  // Optional: threads — translate title, question, summary, plus clues
  let threadIds: string[] = [];
  let threadsStartMap: Record<string, { start: number; clueCount: number }> | undefined;
  if (page.state?.threads && page.state.threads.length) {
    threadIds = page.state.threads.map((t) => t.threadId);
    threadsStartMap = {};
    for (const th of page.state.threads) {
      threadsStartMap[th.threadId] = { start: batch.length, clueCount: (th.clues ?? []).length };
      batch.push(th.title ?? '', th.question ?? '', th.summary ?? '');
      for (const clue of (th.clues ?? [])) batch.push(clue.clue ?? '');
    }
  }

  // Optional: actions history (SelectedAction[]) — translate text + hint per history item
  let actionsHistoryStart: number | undefined;
  if (page.state?.actionsHistory && page.state.actionsHistory.length) {
    actionsHistoryStart = batch.length;
    for (const sa of page.state.actionsHistory) {
      batch.push(sa.text ?? '', sa.hint?.text ?? '');
    }
  }

  let actionsStart: number | undefined;
  if (page.actions?.length) {
    actionsStart = batch.length;
    for (const a of page.actions) batch.push(a.text ?? '', a.hint?.text ?? '');
  }

  // ── Single API call for the whole page ───────────────────────────────────────
  const translated = await translateTexts({
    texts: batch,
    target: targetLanguage,
    source: bookLanguage,
  });

  // ── Extract results using pre-calculated indices ─────────────────────────────
  // IMPORTANT: use `!== undefined` (not truthiness) — index 0 would be falsy.
  const translatedText = translated[0];

  const translatedTimeOfDay      = timeOfDayIndex      !== undefined ? translated[timeOfDayIndex]      : undefined;
  const translatedMood           = moodIndex           !== undefined ? translated[moodIndex]           : undefined;
  const translatedWeather        = weatherIndex        !== undefined ? translated[weatherIndex]        : undefined;
  const translatedContextHistory = contextHistoryIndex !== undefined ? translated[contextHistoryIndex] : undefined;

  const translatedKeyEvents: string[] = keyEventsStart !== undefined
    ? translated.slice(keyEventsStart, keyEventsStart + (page.keyEvents?.length ?? 0))
    : [];

  const translatedImportantObjects: string[] = importantObjectsStart !== undefined
    ? translated.slice(importantObjectsStart, importantObjectsStart + (page.importantObjects?.length ?? 0))
    : [];

  const translatedActions: ActionTranslation[] = actionsStart !== undefined
    ? page.actions!.map((action, i) => ({
        originalText: action.text,
        text: translated[actionsStart! + i * 2],
        hint: translated[actionsStart! + i * 2 + 1],
      }))
    : [];

  // ── Map translated places back to PlaceMemoryTranslation array ─────────
  const translatedPlaces: PlaceMemoryTranslation[] = [];
  if (placesStartMap) {
    for (const placeId of placeIds) {
      const start = placesStartMap[placeId];
      const originalPlace = page.state.places[placeId];
      translatedPlaces.push({
        placeId,
        knownName: translated[start],
        realName:  translated[start + 1],
        context:   translated[start + 2],
        type: originalPlace?.type,
      });
    }
  }

  // ── Map translated characters ────────────────────────────────────────
  const translatedCharacters: CharacterMemoryTranslation[] = [];
  if (charactersStartMap) {
    for (const cid of characterIds) {
      const start = charactersStartMap[cid];
      translatedCharacters.push({
        characterId: cid,
        role: translated[start],
        bio:  translated[start + 1],
      });
    }
  }

  // ── Map translated inventory ─────────────────────────────────────────
  const translatedInventory: InventoryItemTranslation[] = [];
  if (inventoryStartMap) {
    for (let i = 0; i < inventoryCount; i++) {
      const meta = inventoryStartMap[i];
      const start = meta.start;
      const name = translated[start];
      const where = translated[start + 1];
      const traits: TraitItem[] = [];
      for (let t = 0; t < meta.traitCount; t++) {
        const translatedValue = translated[start + 2 + t];
        traits.push({ key: meta.traitKeys[t], value: translatedValue });
      }
      translatedInventory.push({ originalName: page.state.inventory[i].name, name, where, traits });
    }
  }

  // ── Map translated injuries ─────────────────────────────────────────
  const translatedInjuries: InjuryTranslation[] = [];
  if (injuriesStart !== undefined) {
    for (let i = 0; i < page.state.injuries.length; i++) {
      const start = injuriesStart + i * 3;
      translatedInjuries.push({
        bodyPart: translated[start],
        description: translated[start + 1],
        consequences: translated[start + 2],
      });
    }
  }

  // ── Map translated threads ──────────────────────────────────────────
  const translatedThreads: StoryThreadTranslation[] = [];
  if (threadsStartMap) {
    for (const tid of threadIds) {
      const meta = threadsStartMap[tid];
      const tstart = meta.start;
      const title = translated[tstart];
      const question = translated[tstart + 1];
      const summary = translated[tstart + 2];
      const clues: ThreadClueTranslation[] = [];
      for (let c = 0; c < meta.clueCount; c++) {
        const original = page.state.threads.find((th) => th.threadId === tid)!.clues[c].clue;
        const translatedClue = translated[tstart + 3 + c];
        clues.push({ originalClue: original, clue: translatedClue });
      }
      translatedThreads.push({ threadId: tid, title, question, summary, clues });
    }
  }

  // ── Map translated actionsHistory ───────────────────────────────────
  const translatedActionsHistory: ActionTranslation[] = [];
  if (actionsHistoryStart !== undefined) {
    for (let i = 0; i < page.state.actionsHistory.length; i++) {
      const start = actionsHistoryStart + i * 2;
      const orig = page.state.actionsHistory[i];
      translatedActionsHistory.push({ originalText: orig.text, text: translated[start], hint: translated[start + 1] });
    }
  }

  // TODO: also translate characters
  // TODO: also translate inventory (name, where, traits)
  // TODO: also translate injuries (bodyPart, description, consequences)
  // TODO: also translate threads (title, question, summary, clues)
  // TODO: also translate actionsHistory (SelectedAction[] -> ActionTranslation[])

  // ── Persist to database for future cache hits ────────────────────────────────
  const [newTranslation] = await dbWrite
    .insert(pageTranslations)
    .values({
      pageId:           page.id,
      language:         targetLanguage,
      text:             translatedText,
      timeOfDay:        translatedTimeOfDay,
      mood:             translatedMood,
      weather:          translatedWeather,
      keyEvents:        translatedKeyEvents,
      importantObjects: translatedImportantObjects,
      actions:          translatedActions,
      // actionsHistory:       translatedActionsHistory,
      contextHistory:   translatedContextHistory,
      // characters:       translatedCharacters,
      places:           translatedPlaces,
      // inventory:       translatedInventory,
      // injuries:       translatedInjuries,
      // threads:       translatedThreads,
      providerType:     'translator',
      providerName:     'libre',
      updatedAt:        new Date(),
    })
    .returning();

  const translation = mapToPageTranslation(newTranslation);
  translationCache.set(cacheKey, translation);
  return translation;
}

/**
 * Applies a `PageTranslation` overlay onto a `PersistedStoryPage`.
 *
 * Only overrides fields that have a non-null translation value; optional fields
 * that were absent or untranslatable fall back silently to the original page data.
 *
 * **Action merging:** translated action texts are matched back to their original
 * action objects via `originalText`, so every other action field
 * (destinationPageIds, id, …) is preserved intact.
 *
 * @param page        - Original persisted story page
 * @param translation - Translation data from DB or LibreTranslate
 * @returns New page object with translated fields merged in
 */
export function applyPageTranslation(
  page: PersistedStoryPage,
  translation: PageTranslation
// ): PageTranslation {
): TranslatedStoryPage {
  // Re-map translated action texts onto the original action objects
  const translatedActions = (page.actions ?? []).map((action) => {
    const match = translation.actions.find((t) => t.originalText === action.text);
    return match ? { ...action, text: match.text } : action;
  });

  return {
    ...page,
    text: translation.text,
    // Scalar fields: only override when the translation has a non-null value
    ...(translation.timeOfDay      && { timeOfDay:      translation.timeOfDay }),
    ...(translation.mood           && { mood:           translation.mood }),
    ...(translation.weather        && { weather:        translation.weather }),
    ...(translation.contextHistory && { contextHistory: translation.contextHistory }),
    ...(translation.places         && { places:         translation.places }),
    // Array fields: only override when the translated array is non-empty
    ...(translation.keyEvents.length        && { keyEvents:        translation.keyEvents }),
    ...(translation.importantObjects.length && { importantObjects: translation.importantObjects }),
    actions: translatedActions,
  };
}

// ── Mapper helpers ─────────────────────────────────────────────────────────────

export function mapToPageTranslation(dbPageTranslations: DBPageTranslations): PageTranslation {
  return {
    text:             dbPageTranslations.text,
    timeOfDay:        dbPageTranslations.timeOfDay,
    mood:             dbPageTranslations.mood,
    weather:          dbPageTranslations.weather,
    keyEvents:        dbPageTranslations.keyEvents,
    importantObjects: dbPageTranslations.importantObjects,
    actions:          dbPageTranslations.actions,
    actionsHistory:   dbPageTranslations.actionsHistory,
    contextHistory:   dbPageTranslations.contextHistory,
    characters:       dbPageTranslations.characters,
    places:           dbPageTranslations.places,
    inventory:        dbPageTranslations.inventory,
    injuries:         dbPageTranslations.injuries,
    threads:          dbPageTranslations.threads,
  } satisfies Record<keyof PageTranslation, unknown>;
}

export function mapToBookTranslation(dbBookTranslations: DBBookTranslations): BookTranslation {
  return {
    title:    dbBookTranslations.title,
    hook:     dbBookTranslations.hook,
    summary:  dbBookTranslations.summary,
    keywords: dbBookTranslations.keywords,
    mc:       dbBookTranslations.mc,
  } satisfies Record<keyof BookTranslation, unknown>;
}

// ── Public helpers ─────────────────────────────────────────────────────────────

/**
 * Checks if translation is needed based on language codes.
 *
 * @param bookLanguage   - Source language code of the book (e.g. "en")
 * @param headerLanguage - Accept-Language header value from the request
 * @returns Target language code if translation is needed, `undefined` otherwise
 *
 * @example
 * shouldTranslate("en", "es-MX")  // → "es"
 * shouldTranslate("en", "en-US")  // → undefined (same language)
 * shouldTranslate("en", null)     // → undefined (no header)
 */
export function shouldTranslate(
  bookLanguage: string,
  headerLanguage?: string | null
): string | undefined {
  if (!headerLanguage || !bookLanguage) return undefined;

  // Extract primary language code (e.g. "en-US" → "en")
  const targetLanguage = headerLanguage.split('-')[0].toLowerCase();

  if (!isValidLanguageCode(targetLanguage) || !isValidLanguageCode(bookLanguage)) {
    console.warn(`[translate] ❓ Invalid language codes — book: ${bookLanguage}, target: ${targetLanguage}`);
    return undefined;
  }

  return targetLanguage !== bookLanguage.toLowerCase() ? targetLanguage : undefined;
}

/**
 * Returns current LRU cache statistics for monitoring / health checks.
 */
export function getTranslationCacheStats() {
  return {
    size:      translationCache.size,
    maxSize:   translationCache.max,
    itemCount: translationCache.size,
    ttl:       translationCache.ttl,
  };
}

/**
 * Clears the in-memory translation cache.
 * Useful for testing or emergency memory management.
 */
export function clearTranslationCache() {
  translationCache.clear();
}

export async function getPageToTranslate(dbPage: DBPage): Promise<PageToTranslate | null> {
  const page = mapToPersistedStoryPage(dbPage);
  const [book, state] = await Promise.all([
    getBook(page.bookId),
    // getStoryStateWithBranch(page.bookId, page.id),
    getStoryStateFromPage(dbPage),
  ]);

  if (!book || !state) {
    console.warn(`[getPageToTranslate] ⚠️ Book or state missing for page ${page.id}`);
    return null;
  }

  return { ...page, book, state };
}