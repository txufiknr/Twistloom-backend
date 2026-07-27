/**
 * Translation Service Module
 *
 * Three-tier translation strategy for Twistloom story pages:
 *  1. LRU in-memory cache   — sub-ms, for repeated hits within an hour
 *  2. PostgreSQL cache      — persistent, survives restarts
 *  3. LibreTranslate API    — on-demand for missing translations
 *
 * The AI-based translation path (for cron backfills) lives in
 * `utils/prompt-translation.ts` and writes through the same DB table.
 *
 * @example
 * ```typescript
 * const result = await getPageTranslation({ page: pageToTranslate, bookLanguage: 'en', targetLanguage: 'id' });
 * if (result.translation) {
 *   const translated = applyPageTranslation(persistedPage, result.translation);
 *   const translatedState = applyStateTranslation(state, result.translation);
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
import type { ActionTranslation, PersistedStoryPage, TranslatedStoryPage, StoryState } from "../types/story.js";
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
  max: 1000, // max entries
  ttl: 1000 * 60 * 60, // 1 hour TTL
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * Translation request parameters
 */
interface GetPageTranslationParams {
  /** Full page-with-state object (used by the LibreTranslate path for field extraction) */
  page: PageToTranslate;
  /** Source language code (ISO 639-1) */
  language: string;
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

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetches a page translation using a three-tier caching strategy:
 *   LRU cache → PostgreSQL → LibreTranslate API
 *
 * The LibreTranslate path translates ALL translatable fields for the page
 * and its associated state in a single bulk API call (see `translatePageWithLibre`).
 *
 * On failure, returns an error descriptor rather than throwing so callers
 * can fall back gracefully to the original text.
 */
export async function getPageTranslation({
  page,
  language,
  targetLanguage,
}: GetPageTranslationParams): Promise<PageTranslationResult> {
  const cacheKey = `${page.id}|${targetLanguage}`;

  // Check memory cache first (fastest path)
  const cached = translationCache.get(cacheKey);
  if (cached) return { translation: cached };

  try {
    // Check database for existing translation (second fastest path)
    const [dbTranslation] = await dbRead
      .select()
      .from(pageTranslations)
      .where(and(eq(pageTranslations.pageId, page.id), eq(pageTranslations.language, targetLanguage)))
      .limit(1);

    if (dbTranslation) {
      const translation = mapToPageTranslation(dbTranslation);
      translationCache.set(cacheKey, translation);
      return { translation };
    }

    // No existing translation — translate all fields via LibreTranslate in one call
    const translation = await translatePageWithLibre({ page, language, targetLanguage, cacheKey });
    return { translation };
  } catch (error) {
    const details = getErrorMessage(error);
    console.warn(`[translate] ⚠️ Failed page ${page.id} → ${targetLanguage}:`, details);
    return { error: { message: "Translation failed", details, originalText: page.text } };
  }
}

/**
 * Applies a `PageTranslation` overlay onto a `PersistedStoryPage`.
 *
 * Covers page-level fields only: text, calendarDate, timeOfDay, mood, weather,
 * keyEvents, keyObjects, and actions.
 *
 * State-level translations (contextHistory, places, characters, inventory,
 * injuries, threads, actionsHistory) must be applied separately via
 * `applyStateTranslation`.
 *
 * Action merging rules:
 * - Matched by `originalText` so all other Action fields are preserved
 * - Both `action.text` AND `action.hint.text` are updated when a match exists
 * - Unmatched actions are returned unchanged (safety fallback)
 *
 * @param page        - Original persisted page
 * @param translation - Translation from DB or LibreTranslate
 * @returns New page object with translated fields merged in
 */
export function applyPageTranslation(
  page: PersistedStoryPage,
  translation: PageTranslation
): TranslatedStoryPage {
  const translatedActions = (page.actions ?? []).map((action) => {
    const match = translation.actions.find((t) => t.originalText === action.text);
    if (!match) return action;
    return {
      ...action,
      text: match.text,
      // Preserve hint.type; only overwrite hint.text
      hint: { ...action.hint, text: match.hint },
    };
  });

  return {
    ...page,
    text: translation.text,
    // Use != null (not &&): empty string is a valid translation result
    ...(translation.timeOfDay  != null && { timeOfDay: translation.timeOfDay }),
    ...(translation.mood       != null && { mood:      translation.mood }),
    ...(translation.weather    != null && { weather:   translation.weather }),
    // Arrays: only override when the translated array is non-empty
    ...(translation.keyEvents.length        > 0 && { keyEvents:        translation.keyEvents }),
    ...(translation.keyObjects.length > 0 && { keyObjects: translation.keyObjects }),
    actions: translatedActions,
  };
}

/**
 * Applies state-level translations from a `PageTranslation` onto a `StoryState`.
 *
 * Covers all state fields that can be translated:
 * - `contextHistory` — AI-summarized story context
 * - `places`         — Record<placeId, PlaceMemory>: knownName, realName, context, type
 * - `characters`     — Record<characterId, CharacterMemory>: role, bio
 * - `inventory`      — InventoryItem[]: name, where, traits values (matched by originalName)
 * - `injuries`       — Injury[]: bodyPart, description, consequences (matched by index)
 * - `threads`        — StoryThread[]: title, question, summary, clues (matched by threadId)
 * - `actionsHistory` — SelectedAction[]: text, hint.text (matched by originalText)
 *
 * All overrides are non-destructive: if the translated value is empty/missing,
 * the original is preserved.
 *
 * @param state       - Original story state
 * @param translation - Translation from DB or AI
 * @returns New state object with translated fields merged in
 */
export function applyStateTranslation(state: StoryState, translation: PageTranslation): StoryState {
  // ── contextHistory ──────────────────────────────────────────────────────────
  const contextHistory = translation.contextHistory ?? state.contextHistory;

  // ── places ─────────────────────────────────────────────────────────────────
  let places = state.places;
  if (translation.places && translation.places.length > 0) {
    places = { ...state.places };
    for (const pt of translation.places) {
      const orig = state.places[pt.placeId];
      if (!orig) continue;
      places[pt.placeId] = {
        ...orig,
        ...(pt.knownName && { knownName: pt.knownName }),
        ...(pt.realName  && { realName:  pt.realName }),
        ...(pt.context   && { context:   pt.context }),
        ...(pt.type      && { type:      pt.type as typeof orig.type }),
        ...(pt.traits && pt.traits.length > 0 && { traits: pt.traits }),
      };
    }
  }

  // ── characters ─────────────────────────────────────────────────────────────
  let characters = state.characters;
  if (translation.characters && translation.characters.length > 0) {
    characters = { ...state.characters };
    for (const ct of translation.characters) {
      const orig = state.characters[ct.characterId];
      if (!orig) continue;
      characters[ct.characterId] = {
        ...orig,
        ...(ct.role && { role: ct.role }),
        ...(ct.bio  && { bio:  ct.bio }),
        ...(ct.traits && ct.traits.length > 0 && { traits: ct.traits }),
      };
    }
  }

  // ── inventory ──────────────────────────────────────────────────────────────
  let inventory = state.inventory;
  if (translation.inventory && translation.inventory.length > 0) {
    inventory = state.inventory.map((item) => {
      const it = translation.inventory!.find((t) => t.originalName === item.name);
      if (!it) return item;
      return {
        ...item,
        ...(it.name  && { name:  it.name }),
        ...(it.where && { where: it.where }),
        ...(it.traits && it.traits.length > 0 && { traits: it.traits }),
      };
    });
  }

  // ── injuries ───────────────────────────────────────────────────────────────
  // Injuries have no stable identifier, so matched by array position.
  let injuries = state.injuries;
  if (translation.injuries && translation.injuries.length > 0) {
    injuries = state.injuries.map((inj, i) => {
      const it = translation.injuries![i];
      if (!it) return inj;
      return {
        ...inj,
        ...(it.bodyPart     && { bodyPart:     it.bodyPart }),
        ...(it.description  && { description:  it.description }),
        ...(it.consequences && { consequences: it.consequences }),
      };
    });
  }

  // ── threads ────────────────────────────────────────────────────────────────
  let threads = state.threads;
  if (translation.threads && translation.threads.length > 0) {
    threads = state.threads.map((th) => {
      const tt = translation.threads!.find((t) => t.threadId === th.threadId);
      if (!tt) return th;
      return {
        ...th,
        ...(tt.title    && { title:    tt.title }),
        ...(tt.question && { question: tt.question }),
        ...(tt.summary  && { summary:  tt.summary }),
        clues: th.clues.map((clue) => {
          const ct = tt.clues.find((c) => c.originalClue === clue.clue);
          return ct ? { ...clue, clue: ct.clue } : clue;
        }),
      };
    });
  }

  // ── actionsHistory ─────────────────────────────────────────────────────────
  // SelectedAction.hint is ActionHint { text, type }; ActionTranslation.hint is a flat string.
  let actionsHistory = state.actionsHistory;
  if (translation.actionsHistory && translation.actionsHistory.length > 0) {
    actionsHistory = state.actionsHistory.map((action) => {
      const at = translation.actionsHistory!.find((t) => t.originalText === action.text);
      if (!at) return action;
      return {
        ...action,
        ...(at.text && { text: at.text }),
        hint: { ...action.hint, ...(at.hint && { text: at.hint }) },
      };
    });
  }

  return {
    ...state,
    contextHistory,
    places,
    characters,
    inventory,
    injuries,
    threads,
    actionsHistory,
  };
}

// ── LibreTranslate bulk engine ─────────────────────────────────────────────────

/**
 * Translates every translatable field on a page and its state in a single
 * LibreTranslate API call.
 *
 * **Strategy — flat index batch:**
 * All strings are pushed into one flat array (`batch`). Each field records the
 * index at which its strings start. After the API call, values are sliced/indexed
 * back out using those pre-recorded indices.
 *
 * Index Tracking Rules:
 * - Always use `!== undefined` when reading optional start indices — `0` is falsy
 *   but a valid index.
 * - Scalar fields: one index per field.
 * - Array fields: a start index + the original array's length (known up-front).
 * - Struct fields (places, characters, inventory, injuries, threads): a start index
 *   per struct, recording the fixed number of strings pushed per entry.
 *
 * Fields Translated (in batch order):
 * ```
 *  0        : page.text
 *  1?       : page.timeOfDay
 *  2?       : page.mood
 *  3?       : page.weather
 *  4?       : state.contextHistory
 *  places   : [knownName, realName, context, type] × N places
 *  keyEvts  : keyEvents[] × M
 *  impObjs  : keyObjects[] × M
 *  chars    : [role, bio] × N characters
 *  inventory: [name, where, trait₀.value, …] × N items
 *  injuries : [bodyPart, description, consequences] × N injuries
 *  threads  : [title, question, summary, clue₀, clue₁, …] × N threads
 *  actHist  : [text, hint.text] × N history entries
 *  actions  : [text, hint.text] × N actions
 * ```
 *
 * @param params.page           - Full page-with-state object
 * @param params.bookLanguage   - Source language
 * @param params.targetLanguage - Target language
 * @param params.cacheKey       - LRU cache key for post-insert warm-up
 */
async function translatePageWithLibre({
  page,
  language,
  targetLanguage,
  cacheKey,
}: GetPageTranslationParams & { cacheKey: string }): Promise<PageTranslation> {

  // ── Build flat batch ─────────────────────────────────────────────────────────
  const batch: string[] = [page.text]; // index 0 — always present

  // — scalar fields ——————————————————————————————————————————————————————————
  let timeOfDayIndex:      number | undefined;
  let moodIndex:           number | undefined;
  let weatherIndex:        number | undefined;
  let contextHistoryIndex: number | undefined;

  if (page.timeOfDay)           { timeOfDayIndex      = batch.length; batch.push(page.timeOfDay); }
  if (page.mood)                { moodIndex           = batch.length; batch.push(page.mood); }
  if (page.weather)             { weatherIndex        = batch.length; batch.push(page.weather); }
  if (page.state.contextHistory){ contextHistoryIndex = batch.length; batch.push(page.state.contextHistory); }

  // — places (4 + N strings per place: knownName, realName, context, type, then one slot per trait string) —
  type PlaceFieldIndices = { start: number; traitCount: number; };
  let placeIds: string[] = [];
  let placesMap: Record<string, PlaceFieldIndices> | undefined;

  if (page.state?.places && Object.keys(page.state.places).length) {
    placeIds = Object.keys(page.state.places);
    placesMap = {};
    for (const pid of placeIds) {
      const p = page.state.places[pid];
      const pt = p.traits ?? [];
      placesMap[pid] = { start: batch.length, traitCount: pt.length };
      // Fixed 4-slot layout: [knownName, realName, context, type] + variable trait strings
      batch.push(p.knownName ?? '', p.realName ?? '', p.context ?? '', p.type ?? '');
      for (const t of pt) batch.push(t);
    }
  }

  // — keyEvents & keyObjects ────────────────────────────────────────────
  let keyEventsStart:         number | undefined;
  let keyObjectsStart:  number | undefined;

  if (page.keyEvents?.length) {
    keyEventsStart = batch.length;
    batch.push(...page.keyEvents);
  }
  if (page.keyObjects?.length) {
    keyObjectsStart = batch.length;
    batch.push(...page.keyObjects);
  }

  // — characters (2 + N strings per character: role, bio, then one slot per trait string) ──
  let characterIds: string[] = [];
  let charactersMap: Record<string, { start: number; traitCount: number }> | undefined;

  if (page.state?.characters && Object.keys(page.state.characters).length) {
    characterIds = Object.keys(page.state.characters);
    charactersMap = {};
    for (const cid of characterIds) {
      const ch = page.state.characters[cid];
      const ct = ch.traits ?? [];
      charactersMap[cid] = { start: batch.length, traitCount: ct.length };
      batch.push(ch.role ?? '', ch.bio ?? '');
      for (const t of ct) batch.push(t);
    }
  }

  // — inventory (variable width: name, where, then one slot per trait string) ──
  type InventoryMeta = { start: number; traitCount: number; };
  let inventoryMap: Record<number, InventoryMeta> | undefined;
  let inventoryCount = 0;

  if (page.state?.inventory?.length) {
    inventoryMap = {};
    for (let i = 0; i < page.state.inventory.length; i++) {
      const item = page.state.inventory[i];
      const it = item.traits ?? [];
      inventoryMap[i] = { start: batch.length, traitCount: it.length };
      batch.push(item.name ?? '', item.where ?? '');
      for (const t of it) batch.push(t);
      inventoryCount++;
    }
  }

  // — injuries (3 strings per injury: bodyPart, description, consequences) ────
  let injuriesStart: number | undefined;
  if (page.state?.injuries?.length) {
    injuriesStart = batch.length;
    for (const inj of page.state.injuries) {
      batch.push(inj.bodyPart ?? '', inj.description ?? '', inj.consequences ?? '');
    }
  }

  // — threads (3 + clueCount strings per thread: title, question, summary, clues…) ─
  type ThreadMeta = { start: number; clueCount: number };
  let threadIds: string[] = [];
  let threadsMap: Record<string, ThreadMeta> | undefined;

  if (page.state?.threads?.length) {
    threadIds = page.state.threads.map((t) => t.threadId);
    threadsMap = {};
    for (const th of page.state.threads) {
      const clues = th.clues ?? [];
      threadsMap[th.threadId] = { start: batch.length, clueCount: clues.length };
      batch.push(th.title ?? '', th.question ?? '', th.summary ?? '');
      for (const c of clues) batch.push(c.clue ?? '');
    }
  }

  // — actionsHistory (2 strings per entry: text, hint.text) ───────────────────
  let actionsHistoryStart: number | undefined;
  if (page.state?.actionsHistory?.length) {
    actionsHistoryStart = batch.length;
    for (const sa of page.state.actionsHistory) {
      batch.push(sa.text ?? '', sa.hint?.text ?? '');
    }
  }

  // — current page actions (2 strings per action: text, hint.text) ────────────
  let actionsStart: number | undefined;
  if (page.actions?.length) {
    actionsStart = batch.length;
    for (const a of page.actions) batch.push(a.text ?? '', a.hint?.text ?? '');
  }

  // ── Single API call ──────────────────────────────────────────────────────────
  const translated = await translateTexts({ texts: batch, target: targetLanguage, source: language });

  // ── Extract — scalars ────────────────────────────────────────────────────────
  // Use !== undefined guards: index 0 is falsy but valid.
  const translatedText           = translated[0];
  const translatedTimeOfDay      = timeOfDayIndex      !== undefined ? translated[timeOfDayIndex]      : undefined;
  const translatedMood           = moodIndex           !== undefined ? translated[moodIndex]           : undefined;
  const translatedWeather        = weatherIndex        !== undefined ? translated[weatherIndex]        : undefined;
  const translatedContextHistory = contextHistoryIndex !== undefined ? translated[contextHistoryIndex] : undefined;

  // ── Extract — keyEvents / keyObjects ───────────────────────────────────
  const translatedKeyEvents: string[] = keyEventsStart !== undefined
    ? translated.slice(keyEventsStart, keyEventsStart + (page.keyEvents?.length ?? 0))
    : [];

  const translatedKeyObjects: string[] = keyObjectsStart !== undefined
    ? translated.slice(keyObjectsStart, keyObjectsStart + (page.keyObjects?.length ?? 0))
    : [];

  // ── Extract — actions ────────────────────────────────────────────────────────
  const translatedActions: ActionTranslation[] = actionsStart !== undefined
    ? page.actions!.map((a, i) => ({
        originalText: a.text,
        text: translated[actionsStart! + i * 2],
        hint: translated[actionsStart! + i * 2 + 1],
      }))
    : [];

  // ── Extract — places (4 + N slot layout: knownName, realName, context, type, trait strings) ──
  const translatedPlaces: PlaceMemoryTranslation[] = [];
  if (placesMap) {
    for (const pid of placeIds) {
      const { start, traitCount } = placesMap[pid];
      const orig = page.state.places[pid];
      const traits: TraitItem[] = Array.from({ length: traitCount }, (_, t) =>
        translated[start + 4 + t] || (orig.traits?.[t] ?? ''),
      );
      translatedPlaces.push({
        placeId:   pid,
        knownName: translated[start]     || orig.knownName,
        realName:  translated[start + 1] || orig.realName,
        context:   translated[start + 2] || orig.context,
        type:      translated[start + 3] || orig.type,
        traits,
      });
    }
  }

  // ── Extract — characters ─────────────────────────────────────────────────────
  const translatedCharacters: CharacterMemoryTranslation[] = [];
  if (charactersMap) {
    for (const cid of characterIds) {
      const { start, traitCount } = charactersMap[cid];
      const orig  = page.state.characters[cid];
      const traits: TraitItem[] = Array.from({ length: traitCount }, (_, t) =>
        translated[start + 2 + t] || (orig.traits?.[t] ?? ''),
      );
      translatedCharacters.push({
        characterId: cid,
        role: translated[start]     || orig.role,
        bio:  translated[start + 1] || orig.bio,
        traits,
      });
    }
  }

  // ── Extract — inventory ──────────────────────────────────────────────────────
  const translatedInventory: InventoryItemTranslation[] = [];
  if (inventoryMap) {
    for (let i = 0; i < inventoryCount; i++) {
      const { start, traitCount } = inventoryMap[i];
      const orig = page.state.inventory[i];
      const traits: TraitItem[] = Array.from({ length: traitCount }, (_, t) =>
        translated[start + 2 + t] || (orig.traits?.[t] ?? ''),
      );
      translatedInventory.push({
        originalName: orig.name,
        name:  translated[start]     || orig.name,
        where: translated[start + 1] || orig.where,
        traits,
      });
    }
  }

  // ── Extract — injuries ───────────────────────────────────────────────────────
  const translatedInjuries: InjuryTranslation[] = [];
  if (injuriesStart !== undefined) {
    for (let i = 0; i < page.state.injuries.length; i++) {
      const start = injuriesStart + i * 3;
      const orig  = page.state.injuries[i];
      translatedInjuries.push({
        bodyPart:     translated[start]     || orig.bodyPart,
        description:  translated[start + 1] || orig.description,
        consequences: translated[start + 2] || orig.consequences,
      });
    }
  }

  // ── Extract — threads ────────────────────────────────────────────────────────
  const translatedThreads: StoryThreadTranslation[] = [];
  if (threadsMap) {
    for (const tid of threadIds) {
      const { start, clueCount } = threadsMap[tid];
      const origThread = page.state.threads.find((t) => t.threadId === tid)!;
      const clues: ThreadClueTranslation[] = origThread.clues.slice(0, clueCount).map((c, i) => ({
        originalClue: c.clue,
        clue: translated[start + 3 + i] || c.clue,
      }));
      translatedThreads.push({
        threadId: tid,
        title:    translated[start]     || origThread.title,
        question: translated[start + 1] || origThread.question,
        summary:  translated[start + 2] || origThread.summary,
        clues,
      });
    }
  }

  // ── Extract — actionsHistory ─────────────────────────────────────────────────
  const translatedActionsHistory: ActionTranslation[] = [];
  if (actionsHistoryStart !== undefined) {
    for (let i = 0; i < page.state.actionsHistory.length; i++) {
      const start = actionsHistoryStart + i * 2;
      const orig  = page.state.actionsHistory[i];
      translatedActionsHistory.push({
        originalText: orig.text,
        text: translated[start]     || orig.text,
        hint: translated[start + 1] || orig.hint.text,
      });
    }
  }

  // ── Persist ──────────────────────────────────────────────────────────────────
  const [newRow] = await dbWrite
    .insert(pageTranslations)
    .values({
      pageId:           page.id,
      language:         targetLanguage,
      text:             translatedText,
      timeOfDay:        translatedTimeOfDay,
      mood:             translatedMood,
      weather:          translatedWeather,
      keyEvents:        translatedKeyEvents,
      keyObjects:       translatedKeyObjects,
      actions:          translatedActions,
      actionsHistory:   translatedActionsHistory,
      contextHistory:   translatedContextHistory,
      characters:       translatedCharacters,
      places:           translatedPlaces,
      inventory:        translatedInventory,
      injuries:         translatedInjuries,
      threads:          translatedThreads,
      providerType:     'translator',
      providerName:     'libre',
      updatedAt:        new Date(),
    })
    .returning();

  const translation = mapToPageTranslation(newRow);
  translationCache.set(cacheKey, translation);
  return translation;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Builds a `PageToTranslate` from a raw `DBPage` by hydrating its book and state.
 * Returns `null` if either cannot be resolved (e.g. deleted book or missing state).
 */
export async function getPageToTranslate(dbPage: DBPage): Promise<PageToTranslate | null> {
  const page = mapToPersistedStoryPage(dbPage);
  const [book, state] = await Promise.all([
    getBook(page.bookId),
    getStoryStateFromPage(dbPage),
  ]);

  if (!book || !state) {
    console.warn(`[getPageToTranslate] ⚠️ Book or state missing for page ${page.id}`);
    return null;
  }

  return { ...page, book, state };
}

// ── Mapper helpers ─────────────────────────────────────────────────────────────

export function mapToPageTranslation(row: DBPageTranslations): PageTranslation {
  return {
    text:             row.text,
    timeOfDay:        row.timeOfDay,
    mood:             row.mood,
    weather:          row.weather,
    keyEvents:        row.keyEvents,
    keyObjects: row.keyObjects,
    actions:          row.actions,
    actionsHistory:   row.actionsHistory,
    contextHistory:   row.contextHistory,
    characters:       row.characters,
    places:           row.places,
    inventory:        row.inventory,
    injuries:         row.injuries,
    threads:          row.threads,
  } satisfies Record<keyof PageTranslation, unknown>;
}

export function mapToBookTranslation(row: DBBookTranslations): BookTranslation {
  return {
    title:    row.title,
    hook:     row.hook,
    summary:  row.summary,
    keywords: row.keywords,
    mc:       row.mc,
  } satisfies Record<keyof BookTranslation, unknown>;
}

// ── Language utilities ─────────────────────────────────────────────────────────

/**
 * Determines whether translation is needed by comparing the book's source
 * language to the request's Accept-Language header.
 *
 * Returns the target language code if translation is needed, `undefined` if
 * - the header is absent or invalid
 * - either code fails ISO 639-1 validation
 * - source and target are the same language
 *
 * @example
 * shouldTranslate('en', 'id-ID')  // → 'id'
 * shouldTranslate('en', 'en-US')  // → undefined
 * shouldTranslate('en', null)     // → undefined
 */
export function shouldTranslate(
  bookLanguage: string,
  headerLanguage?: string | null
): string | undefined {
  if (!headerLanguage || !bookLanguage) return undefined;

  const target = headerLanguage.split('-')[0].toLowerCase();

  if (!isValidLanguageCode(target) || !isValidLanguageCode(bookLanguage)) {
    console.warn(`[translate] ❓ Invalid language codes — book: ${bookLanguage}, target: ${target}`);
    return undefined;
  }

  return target !== bookLanguage.toLowerCase() ? target : undefined;
}

/**
 * Formats a BCP 47 / ISO 639-1 code into a human-readable language name.
 *
 * @example
 * formatLanguage('id')  // → 'Indonesian'
 * formatLanguage('fr')  // → 'French'
 * formatLanguage('xyz') // → 'xyz' (unknown codes returned as-is)
 */
export function formatLanguage(code: string): string {
  try {
    const display = new Intl.DisplayNames(['en'], { type: 'language' });
    return display.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Returns LRU cache statistics for monitoring / health checks. */
export function getTranslationCacheStats() {
  return {
    size:      translationCache.size,
    maxSize:   translationCache.max,
    itemCount: translationCache.size,
    ttl:       translationCache.ttl,
  };
}

/** Clears the in-memory translation cache (testing / emergency memory relief). */
export function clearTranslationCache() {
  translationCache.clear();
}