/**
 * AI-based translation utilities for books and pages.
 *
 * This module handles the "quality backfill" path: AI translation is more
 * expensive than LibreTranslate but produces far better literary results.
 * It is used by the Indonesian cron job and the single-page translate endpoint.
 *
 * LibreTranslate (fast/cheap, instant-demand) lives in `services/translation.ts`.
 *
 * Architecture notes:
 * - `translateBook` / `translatePage` — single-item endpoints
 * - `translateBooksBulk` / `translatePagesBulk` — batch cron paths (AI documents API)
 * - `formatPagePrompt` — serialises ALL translatable state fields into the prompt
 *   so the AI has every string it needs to fill in the translation schema.
 * - `normalizeActionTranslations` — shared helper that ensures `originalText`
 *   always matches the source and that missing translations fall back gracefully.
 */

import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_TRANSLATION, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import type { AIDocument, AIPromptForJson, AIResponse } from "../types/ai-chat.js";
import { SUMMARY_LENGTH, KEYWORDS_COUNT } from "../config/story.js";
import type { ActionTranslation } from "../types/story.js";
import type {
  BookTranslation,
  PageTranslation,
  PageTranslationBulk,
  PageTranslationBulkResponse,
  BookTranslationBulkResponse,
  BookTranslationBulk,
  PageToTranslate,
  BookToTranslate,
} from "../types/book.js";
import {
  BOOK_TRANSLATION_REQUIRED_FIELDS,
  BOOK_TRANSLATION_SCHEMA_DEFINITION,
  BULK_BOOK_TRANSLATION_REQUIRED_FIELDS,
  BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION,
  PAGE_TRANSLATION_REQUIRED_FIELDS,
  PAGE_TRANSLATION_SCHEMA_DEFINITION,
  BULK_PAGE_TRANSLATION_REQUIRED_FIELDS,
  BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION,
} from "../schema/story.js";
import { executePromptForJSON } from "./prompt.js";
import { formatLanguage } from "./translation.js";
import { getMainCharacterInfo } from "./characters.js";
import { formatBookMetaForPrompt } from "./books.js";

// ── System prompts ─────────────────────────────────────────────────────────────

/**
 * Core translation system prompt shared by both book-meta and page paths.
 */
const PROMPT_SYSTEM_TRANSLATION = `You are an expert literary translator specializing in thriller, suspense, mystery, horror, and young-adult fiction.

Translate the story into the target language while preserving the author's original storytelling experience.

PRIMARY GOAL:
- Produce a natural, professionally localized story text that feels as if it were originally written by a skilled thriller novelist in the target language.
- Readers should never feel they are reading a translation.

TRANSLATION GUIDELINES:
- Maintain first-person central (MC = narrator) POV throughout.
- Preserve psychological thriller atmosphere, tension, and horror elements.
- Use natural, idiomatic language in the target language.
- Keep the same emotional tone (fear, dread, suspense, etc.).
- Ensure action choices remain meaningful and intriguing.
- Maintain the mystery and intrigue of the original text.
- Keep the same level of intensity and suspense.
- Ensure cultural appropriateness for the target language.

PRESERVE EXACTLY:
- Story facts, events, clues, foreshadowing, and continuity.
- Narrative perspective and tense.
- Character personalities, voices, relationships, and intentions.
- Dialogue meaning, emotion, subtext, and formality level.
- Suspense, atmosphere, pacing, and emotional impact.
- Names, locations, objects, terminology, lore, and canon.

STORYTELLING STYLE:
- Preserve the original pacing, atmosphere, tension, suspense, emotional intensity, and narrative momentum.
- Maintain cliffhangers, mystery, dread, fear, anticipation, sudden reveals, and other thriller or horror storytelling techniques.
- Translation should evoke the same emotional experience as the original.

LOCALIZATION:
- Translate idioms and colloquial expressions naturally. Prefer equivalent emotional impact over literal wording.
- Maintain consistent translations for recurring names, places, objects, organizations, and key terminology.
- Translate, do not rewrite. Improve only linguistic naturalness, never story content.

PROHIBITED (DO NOT):
- Add, remove, alter, summarize, reinterpret, or censor information.
- Explain the translation.
- Add notes, commentary, footnotes, or warnings.
- Change names, locations, lore, worldbuilding, or canon.`;

const PROMPT_SYSTEM_PAGE_TRANSLATION: string = `${PROMPT_SYSTEM_TRANSLATION}

PAGE RULES:
- Preserve paragraph breaks, line breaks, dialogue formatting, scene transitions, and emphasis structure.
- This page belongs to a branching interactive narrative. Future pages may depend on exact details from this page.
- Translate dialogue naturally for native speakers while preserving intent, emotion, personality, subtext, and level of formality.
- Do not make dialogue more formal, literary, or sophisticated than the original.`;

// ── Book translation ───────────────────────────────────────────────────────────

const bookTranslationOutputFormat: string = `{
  "title": "Translated book title",
  "hook": "Translated hook text",
  "summary": "Translated summary",
  "keywords": ["translated-keyword-1", "translated-keyword-2", "..."],
  "mc": {
    "bio": "Translated bio"
  }
}`;

const bulkBookTranslationOutputFormat: string = `{
  "translations": [
    {
      "bookId": "book-uuid-1",
      "title": "Translated book title",
      "hook": "Translated hook text",
      "summary": "Translated summary",
      "keywords": ["translated-keyword-1", "translated-keyword-2", "..."],
      "mc": { "bio": "Translated bio" }
    }
  ]
}`;

const bookTranslationFieldInstructions: string = `
- title: Translate the book title. Keep it catchy and mysterious.
- hook: Translate the hook. Maintain the intrigue and psychological tension.
- summary: Translate the summary. Keep it ${SUMMARY_LENGTH}, preserving the psychological thriller atmosphere.
- keywords: Translate keywords. Provide ${KEYWORDS_COUNT} relevant tags in the target language.
- mc.bio: Translate main character's bio.`;

/**
 * Translates book metadata (title, hook, summary, keywords, mc.bio) to the
 * target language using AI.
 */
export async function translateBook(
  book: BookToTranslate,
  targetLanguage: string
): Promise<AIResponse<BookTranslation>> {
  const sourceLanguage = book.language || 'en';
  const prompt = `TASK: Translate the following book metadata from ${formatLanguage(sourceLanguage)} to ${formatLanguage(targetLanguage)}.\n\n${formatBookPrompt(book)}`;
  const response = await executePromptForJSON<BookTranslation>({
    prompt,
    configs: {
      schema: BOOK_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BOOK_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'title',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_WRITING,
        systemPrompt: PROMPT_SYSTEM_TRANSLATION,
        context: 'book-translation',
        logPrompts: true,
      }
    } satisfies AIPromptForJson<BookTranslation>,
    jsonStructure: bookTranslationOutputFormat,
    fieldInstructions: bookTranslationFieldInstructions,
  });

  if (!response.result) {
    throw new Error(`Failed to translate book: ${response.finishReason ?? 'UNKNOWN'} (${response.provider ?? 'unknown'})`);
  }

  return response;
}

/**
 * Translates multiple books to the target language in a single AI request,
 * using the documents API for efficient batching.
 */
export async function translateBooksBulk(
  books: BookToTranslate[],
  targetLanguage: string
): Promise<BookTranslationBulkResponse> {
  const documents: AIDocument[] = books.map(formatBookDocument);
  const prompt = `TASK: Translate ${documents.length} books provided in the documents to ${formatLanguage(targetLanguage)}.`;
  const response = await executePromptForJSON<BookTranslationBulk>({
    prompt,
    configs: {
      schema: BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BULK_BOOK_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'translations',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_TRANSLATION,
        systemPrompt: PROMPT_SYSTEM_TRANSLATION,
        context: 'bulk-book-translation',
        logPrompts: true,
        documents,
      }
    } satisfies AIPromptForJson<BookTranslationBulk>,
    jsonStructure: bulkBookTranslationOutputFormat,
    fieldInstructions: `- bookId: Don't change. Should match to its source book.${bookTranslationFieldInstructions}`,
  });

  if (!response.result) {
    throw new Error(`Failed to translate books in bulk: ${response.finishReason ?? 'UNKNOWN'} (${response.provider ?? 'unknown'})`);
  }

  const { provider, model, result } = response;
  return { provider, model, translations: result.translations };
}

// ── Page translation ───────────────────────────────────────────────────────────

const pageTranslationReview: string = `
□ All story information preserved.
□ Tone matches the original.
□ Character voices remain distinct.
□ Suspense level maintained.
□ Narrative perspective unchanged.
□ Tense consistency preserved.
□ Formatting preserved.
□ Output reads like native fiction, not translation.`;

const pageTranslationOutputFormat: string = `{
  "text": "Translated page text",
  "timeOfDay": "Translated time of day",
  "mood": "Translated mood",
  "weather": "Translated weather",
  "keyEvents": ["Translated key event 1", "Translated key event 2"],
  "keyObjects": ["translated-object-1", "translated-object-2"],
  "contextHistory": "Translated context history",
  "places": [
    {
      "placeId": "place_id_1 (unchanged)",
      "knownName": "Translated known name",
      "realName": "Translated real name",
      "context": "Translated short description of place",
      "type": "house",
      "traits": [{ "key": "smell (unchanged)", "value": "damp earth (translated)" }]
    }
  ],
  "characters": [
    {
      "characterId": "character_id_1 (unchanged)",
      "role": "Translated role/occupation",
      "bio": "Translated one-sentence bio",
      "traits": [{ "key": "skill (unchanged)", "value": "lockpicking (translated)" }]
    }
  ],
  "inventory": [
    {
      "originalName": "rusty key (unchanged)",
      "name": "Translated rusty key",
      "traits": [{ "key": "material (unchanged)", "value": "iron (translated)" }, { "key": "state (unchanged)", "value": "rusty (translated)" }],
      "where": "Translated location (e.g. in the drawer)"
    }
  ],
  "injuries": [
    {
      "bodyPart": "Translated body part",
      "description": "Translated short injury description",
      "consequences": "Translated consequences (e.g. cannot grip)"
    }
  ],
  "threads": [
    {
      "threadId": "thread_id_1 (unchanged)",
      "title": "Translated thread title",
      "question": "Translated investigative question",
      "summary": "Translated short summary",
      "clues": [{ "originalClue": "blood on the floor (unchanged)", "clue": "Translated clue text" }]
    }
  ],
  "actions": [
    {
      "originalText": "Original action text (unchanged)",
      "text": "Translated action text",
      "hint": "Translated hint text"
    }
  ],
  "actionsHistory": [
    {
      "originalText": "Look under the bed (unchanged)",
      "text": "Translated historical action text",
      "hint": "Translated hint for the historical action"
    }
  ]
}`;

const bulkPageTranslationOutputFormat: string = `{
  "translations": [
    {
      "pageId": "page-uuid-1 (unchanged)",
      "text": "Translated page text",
      "timeOfDay": "Translated time of day",
      "mood": "Translated mood",
      "weather": "Translated weather",
      "keyEvents": ["Translated key event 1"],
      "keyObjects": ["translated-object-1"],
      "contextHistory": "Translated context history",
      "places": [{ "placeId": "place_id_1 (unchanged)", "knownName": "Translated", "realName": "Translated", "context": "Translated", "type": "house", "traits": [{ "key": "smell (unchanged)", "value": "damp earth (translated)" }] }],
      "characters": [{ "characterId": "character_id_1 (unchanged)", "role": "Translated role", "bio": "Translated bio", "traits": [{ "key": "skill (unchanged)", "value": "lockpicking (translated)" }] }],
      "inventory": [{ "originalName": "rusty key (unchanged)", "name": "Translated", "traits": [{ "key": "material (unchanged)", "value": "iron (translated)" }], "where": "Translated" }],
      "injuries": [{ "bodyPart": "Translated", "description": "Translated", "consequences": "Translated" }],
      "threads": [{ "threadId": "thread_id_1 (unchanged)", "title": "Translated", "question": "Translated", "summary": "Translated", "clues": [{ "originalClue": "old note (unchanged)", "clue": "Translated clue" }] }],
      "actions": [{ "originalText": "Open the door (unchanged)", "text": "Translated", "hint": "Translated" }],
      "actionsHistory": [{ "originalText": "Look under the bed (unchanged)", "text": "Translated", "hint": "Translated" }]
    }
  ]
}`;

/**
 * Builds the per-request field instructions for page translation.
 *
 * @param hasAsterisks - Whether the source text contains `*` emphasis markers
 * @param isBulk       - Whether this is a multi-page bulk request (adds `pageId` rule)
 */
const buildPageTranslationFieldInstructions = (hasAsterisks: boolean, isBulk = false): string => {
  const asteriskRule = hasAsterisks ? ' Keep text styling using asterisks (if any).' : '';
  return `${isBulk ? `- pageId: Don't change. Must match its source page.\n` : ''}\
- text: Translate page narrative.${asteriskRule}
- timeOfDay: Translate time of day.
- mood: Translate current mood.
- weather: Translate current weather.
- keyEvents: Translate key events. Preserve the sequence and importance.
- keyObjects: Translate important objects. Keep them relevant to the story.
- contextHistory: Translate story summary until the current page — key plot developments, hard facts, major events.
- places: For each place, keep 'placeId' unchanged and translate 'knownName', 'realName', and 'context'. Translate 'type' only if it is free-form prose; leave it unchanged if it is a simple category word (e.g. "house", "hospital"). Translate trait values but keep trait keys identical.
- characters: Keep 'characterId' unchanged. Translate 'role', 'bio', and trait values (keep trait keys identical). Do not invent new characters or alter identities.
- inventory: Translate 'name' and 'where'. Keep 'originalName' exactly as shown. Translate trait values but keep trait keys identical.
- injuries: Translate 'bodyPart', 'description', and 'consequences'. Preserve meaning and severity implications.
- threads: Keep 'threadId' unchanged. Translate 'title', 'question', and 'summary'. For each clue keep 'originalClue' unchanged and provide a translated 'clue'.
- actions: Keep 'originalText' exactly as shown. Translate 'text' and 'hint', preserving the original intent.
- actionsHistory: Same rules as 'actions' — keep 'originalText' unchanged, translate 'text' and 'hint'.
- Formatting: Preserve paragraph breaks, dialogue formatting, and emphasis markers. Do not add, remove, or alter facts, names, or plot-critical details.`;
};

/**
 * Translates a single page and its associated state to the target language.
 *
 * Post-processes actions and actionsHistory to ensure `originalText` always
 * matches the source, with graceful fallback to the original when the AI
 * omits or mis-identifies an entry.
 */
export async function translatePage(
  page: PageToTranslate,
  targetLanguage: string
): Promise<AIResponse<PageTranslation>> {
  // TODO: should we add previous page text (translated) for context & natural continuation writing?
  const prompt = `TASK: Translate the following page content to ${formatLanguage(targetLanguage)}.\n\n${formatPagePrompt(page)}`;
  const hasAsterisks = page.text.includes('*');
  const response = await executePromptForJSON<PageTranslation>({
    prompt,
    configs: {
      schema: PAGE_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: PAGE_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'text',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_WRITING,
        systemPrompt: PROMPT_SYSTEM_PAGE_TRANSLATION,
        context: 'page-translation',
        logPrompts: true,
      }
    } satisfies AIPromptForJson<PageTranslation>,
    jsonStructure: pageTranslationOutputFormat,
    fieldInstructions: buildPageTranslationFieldInstructions(hasAsterisks),
    reviewChecklist: pageTranslationReview
  });

  if (!response.result) {
    throw new Error(`Failed to translate page: ${response.finishReason ?? 'UNKNOWN'} (${response.provider ?? 'unknown'})`);
  }

  const result: PageTranslation = {
    ...response.result,
    actions: normalizeActionTranslations(page.actions ?? [], response.result.actions),
    actionsHistory: normalizeActionTranslations(page.state.actionsHistory ?? [], response.result.actionsHistory),
  };

  return { ...response, result };
}

/**
 * Translates multiple pages and their states in a single AI request using the
 * documents API for efficient batching.
 *
 * Applies the same `originalText` normalization as `translatePage` so callers
 * can rely on every returned `ActionTranslation` having a correct `originalText`.
 */
export async function translatePagesBulk(
  pages: PageToTranslate[],
  targetLanguage: string
): Promise<PageTranslationBulkResponse> {
  const documents: AIDocument[] = pages.map(formatPageDocument);
  const prompt = `TASK: Translate ${documents.length} pages provided in the documents to ${formatLanguage(targetLanguage)}.`;
  const hasAsterisks = pages.some((p) => p.text.includes('*'));
  const response = await executePromptForJSON<PageTranslationBulk>({
    prompt,
    configs: {
      schema: BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BULK_PAGE_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'translations',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_TRANSLATION,
        systemPrompt: PROMPT_SYSTEM_PAGE_TRANSLATION,
        context: 'bulk-page-translation',
        logPrompts: true,
        documents,
      }
    } satisfies AIPromptForJson<PageTranslationBulk>,
    jsonStructure: bulkPageTranslationOutputFormat,
    fieldInstructions: buildPageTranslationFieldInstructions(hasAsterisks, true),
    reviewChecklist: pageTranslationReview
  });

  if (!response.result) {
    throw new Error(`Failed to translate pages in bulk: ${response.finishReason ?? 'UNKNOWN'} (${response.provider ?? 'unknown'})`);
  }

  const translations = response.result.translations.map((translation) => {
    const originalPage = pages.find((p) => p.id === translation.pageId);
    if (!originalPage) return translation;

    return {
      ...translation,
      actions: normalizeActionTranslations(originalPage.actions ?? [], translation.actions),
      actionsHistory: normalizeActionTranslations(
        originalPage.state.actionsHistory ?? [],
        translation.actionsHistory,
      ),
    };
  });

  const { provider, model } = response;
  return { provider, model, translations };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Normalises an array of AI-returned `ActionTranslation` against the source
 * actions so every entry is guaranteed to have:
 * - `originalText` — the exact source text (never the AI's version)
 * - `text` — translated text, falling back to source if the AI missed it
 * - `hint` — translated hint text, falling back to source hint if missing
 *
 * Works for both `actions` (current page) and `actionsHistory` (past actions).
 *
 * @param sourceActions     - Original actions from the page or state
 * @param translatedActions - AI-returned translation array (may be incomplete)
 */
function normalizeActionTranslations(
  sourceActions: Array<{ text: string; hint?: { text?: string } }>,
  translatedActions: ActionTranslation[] = [],
): ActionTranslation[] {
  return sourceActions.map((orig) => {
    const match = translatedActions.find((t) => t.originalText === orig.text);
    return {
      originalText: orig.text,
      text:         match?.text ?? orig.text,
      hint:         match?.hint ?? orig.hint?.text ?? '',
    };
  });
}

// ── Document / prompt formatters ───────────────────────────────────────────────

function formatPageDocument(page: PageToTranslate, index: number): AIDocument {
  return {
    title: `Page ${index + 1}`,
    snippet: `Page ID: ${page.id}\n\n${formatPagePrompt(page)}`
  };
}

function formatBookDocument(book: BookToTranslate, index: number): AIDocument {
  return {
    title: `Book ${index + 1}: ${book.title}`,
    snippet: `Book ID: ${book.id}\n\n${formatBookPrompt(book)}`
  };
}

/**
 * Serialises all translatable content for a page into a compact prompt string.
 *
 * Two sections are emitted:
 * 1. **TO TRANSLATE — PAGE**: page-level fields (text, time, mood, weather,
 *    keyEvents, keyObjects, actions).
 * 2. **TO TRANSLATE — STATE**: state-level fields (contextHistory, places,
 *    characters, inventory, injuries, threads, actionsHistory).
 *
 * Without section 2, the AI has no source data for state fields and would
 * return empty arrays or hallucinate content.
 *
 * Format guidelines:
 * - IDs are shown verbatim so the AI can echo them back unchanged.
 * - `originalText` / `originalClue` / `originalName` patterns are shown
 *   explicitly so the AI understands the "keep this, translate that" contract.
 * - Arrays are one entry per line with a consistent `key: "value"` layout for
 *   easy scanning by the model.
 * 
 * Example:
 * BOOK META:
 * Title: The Hollow Ward
 * Language: English
 * Hook: Some say the patients never truly left. The hospital still breathes.
 * Summary: You are Maya Renn, a forensic archivist assigned to catalogue
 * Blackmoor Psychiatric's sealed records before demolition. What begins as
 * routine archival work unravels into something the building never meant
 * for you to find.
 * 
 * ---
 * MAIN CHARACTER (POV):
 * Name: Maya Renn | Age: 29 | Gender: Female
 * Bio: A methodical forensic archivist whose compulsive need for order
 * conceals a deep terror of ambiguity. She documents everything — it is
 * the only way she knows to feel safe.
 * 
 * ---
 * TO TRANSLATE — PAGE:
 * Text:
 * """
 * The filing cabinet is still warm.
 * 
 * That is the first thing I notice — not the smell of mildew, not the
 * flicker of the dying fluorescent above me, not even the handprint
 * smeared across the frosted glass of the director's door. The cabinet.
 * Warm, as though someone stood here moments ago.
 * 
 * I pull the top drawer. The folders inside are arranged by date, but
 * the most recent one — dated three days ago — is wrong. The hospital
 * has been sealed for eleven years.
 * 
 * My fingers find the edge of the folder. I could open it. I could
 * pretend I didn't see the date and walk back down the corridor the way
 * I came. I could lock the office behind me and call this a clerical
 * error and go back to the city.
 * 
 * I don't do any of those things.
 * """
 * 
 * Time: Late night
 * Mood: Dread, curiosity
 * Weather: Rain against sealed windows
 * Key Events: Maya found a recently-dated file in a sealed building, discovered the filing cabinet was warm
 * Important Objects: Patient file dated three days ago, filing cabinet, director's office frosted glass
 * Actions:
 *   originalText: "Open the folder — read what's inside" | hint: "Some knowledge is a door that won't close again"
 *   originalText: "Take the folder without opening it" | hint: "Evidence first. Understanding later."
 *   originalText: "Leave the office immediately and lock the door" | hint: "Whatever you don't know can't follow you home"
 * 
 * ---
 * TO TRANSLATE — STATE:
 * Context History:
 * Maya arrived at Blackmoor Psychiatric to catalogue records before the
 * building is demolished. She gained access using a key provided by the
 * city archivist. On the second floor she encountered Nurse Mira — a
 * woman who should not exist — who warned her away from the basement.
 * Maya found Patient 47's intake photo: the patient is Maya herself,
 * dated 1987, four years before her birth.
 * 
 * Places:
 *   placeId: "place_ward_b2" | knownName: "Ward B — Second Floor" | realName: "Blackmoor Psychiatric Ward B" | type: "abandoned hospital ward" | context: "Long corridor of patient cells, most still locked. Fluorescent lights fail one by one as you move deeper."
 *   placeId: "place_directors_office" | knownName: "The Director's Office" | realName: "Director Harlan Voss — Administrative Suite" | type: "office" | context: "Sealed since the closure. Contains the master patient registry and administrative records. Smells of old tobacco and rust."
 *   placeId: "place_basement_stairs" | knownName: "The Stairs Down" | realName: "Basement Access — Sub-level 1" | type: "stairwell" | context: "Padlocked from this side. Nurse Mira specifically told Maya not to go down."
 *   placeId: "place_entrance_lobby" | knownName: "The Lobby" | realName: "Blackmoor Psychiatric — Main Entrance" | type: "lobby" | context: "Where Maya entered. Exit is here. Functioning phone line."
 * 
 * Characters:
 *   characterId: "char_nurse_mira" | role: "Former psychiatric nurse, deceased 1989" | bio: "Appears solid and calm, gives directions as though still on duty — but her badge photo shows a woman who died in the hospital fire."
 *   characterId: "char_dr_voss" | role: "Former hospital director, disappeared 1989" | bio: "His name is on every administrative document. His portrait at the end of Ward B watches the corridor. Patients called him The Architect."
 *   characterId: "char_patient_47" | role: "Unknown patient, intake 1987" | bio: "The intake photograph shows Maya's face. The name on the file reads only: SUBJECT RENN."
 * 
 * Inventory:
 *   originalName: "city archivist key" | where: "in coat pocket" | traits: [key: "material", value: "brass"; key: "condition", value: "new, recently cut"]
 *   originalName: "forensic documentation kit" | where: "left in lobby near the entrance" | traits: [key: "contents", value: "camera, evidence bags, latex gloves, UV light"]
 *   originalName: "torn patient intake form" | where: "in hand" | traits: [key: "condition", value: "torn along the top third"; key: "subject", value: "Patient 47 — photo matches Maya"]
 * 
 * Injuries:
 *   bodyPart: "right palm" | description: "Clean slice from a shard of broken window glass on the first floor" | consequences: "Wrapped in torn sleeve lining; gripping things firmly causes pain and bleeding through the makeshift bandage"
 * 
 * Story Threads:
 *   threadId: "thread_patient_47" | title: "Who Is Patient 47?" | question: "How does a patient intake form from 1987 carry Maya's face and name?" | summary: "The form predates Maya's birth. The photograph is unmistakably her — same scar above the left eyebrow from a childhood accident."
 *     clues:
 *       originalClue: "intake photograph matches Maya's face exactly"
 *       originalClue: "admission date is four years before Maya was born"
 *       originalClue: "the name field reads SUBJECT RENN — her mother's maiden name"
 *   threadId: "thread_basement_lock" | title: "The Locked Basement" | question: "What is Nurse Mira protecting in Sub-level 1?" | summary: "The padlock is new — replaced recently despite the building being sealed."
 *     clues:
 *       originalClue: "padlock is brand new, not original to the building"
 *       originalClue: "faint sound of movement heard from below on arrival"
 * 
 * Actions History:
 *   originalText: "Enter through the main service door" | hint: "The key the archivist gave you fits too perfectly"
 *   originalText: "Follow the sound to the second floor" | hint: "Curiosity is just fear wearing different clothes"
 *   originalText: "Speak to Nurse Mira" | hint: "She answers like someone still on shift"
 *   originalText: "Ask Mira about the basement" | hint: "Her pause lasts exactly three seconds too long"
 *   originalText: "Take the patient intake form from the records room" | hint: "You tell yourself it is evidence"
 *   originalText: "Go to the director's office" | hint: "The door was unlocked. It should not be."
 */
function formatPagePrompt(page: PageToTranslate): string {
  const { book, state } = page;
  const parts: string[] = [];

  // — Book & character context (not translated, provides narrative grounding) ──
  parts.push(`BOOK META:\n${formatBookMetaForPrompt(book)}`);
  parts.push(`MAIN CHARACTER (POV):\n${getMainCharacterInfo({ mc: book.mc, state })}`);

  // ── PAGE-LEVEL FIELDS ───────────────────────────────────────────────────────
  const pageLines: string[] = [
    `Text:\n"""\n${page.text}\n"""`,
    page.timeOfDay             ? `Time: ${page.timeOfDay}` : null,
    page.mood                  ? `Mood: ${page.mood}` : null,
    page.weather               ? `Weather: ${page.weather}` : null,
    page.keyEvents?.length     ? `Key Events: ${page.keyEvents.join(', ')}` : null,
    page.keyObjects?.length
                               ? `Important Objects: ${page.keyObjects.join(', ')}` : null,
  ].filter((l): l is string => l !== null);

  if (page.actions?.length) {
    pageLines.push(
      `Actions:\n${page.actions.map((a) =>
        `  originalText: "${a.text}" | hint: "${a.hint?.text ?? ''}"`,
      ).join('\n')}`,
    );
  }

  parts.push(`TO TRANSLATE — PAGE:\n${pageLines.join('\n')}`);

  // ── STATE-LEVEL FIELDS ──────────────────────────────────────────────────────
  const stateLines: string[] = [];

  // contextHistory
  if (state.contextHistory) {
    stateLines.push(`Context History:\n${state.contextHistory}`);
  }

  // places — Record<placeId, PlaceMemory>
  const placeEntries = Object.entries(state.places ?? {});
  if (placeEntries.length) {
    stateLines.push(
      `Places:\n${placeEntries.map(([id, p]) =>
        `  placeId: "${id}" | knownName: "${p.knownName ?? ''}" | realName: "${p.realName ?? ''}" | type: "${p.type ?? ''}" | context: "${p.context ?? ''}" | traits: [${(p.traits ?? []).map((t) => `"${t}"`).join(', ')}]`,
      ).join('\n')}`,
    );
  }

  // characters — Record<characterId, CharacterMemory>
  const characterEntries = Object.entries(state.characters ?? {});
  if (characterEntries.length) {
    stateLines.push(
      `Characters:\n${characterEntries.map(([id, ch]) =>
        `  characterId: "${id}" | role: "${ch.role ?? ''}" | bio: "${ch.bio ?? ''}" | traits: [${(ch.traits ?? []).map((t) => `"${t}"`).join(', ')}]`,
      ).join('\n')}`,
    );
  }

  // inventory — InventoryItem[]
  if (state.inventory?.length) {
    stateLines.push(
      `Inventory:\n${state.inventory.map((item) =>
        `  originalName: "${item.name}" | where: "${item.where ?? ''}" | traits: [${
          (item.traits ?? []).map((t) => `"${t}"`).join(', ')
        }]`,
      ).join('\n')}`,
    );
  }

  // injuries — Injury[]  (matched by array position, not an ID)
  if (state.injuries?.length) {
    stateLines.push(
      `Injuries:\n${state.injuries.map((inj) =>
        `  bodyPart: "${inj.bodyPart ?? ''}" | description: "${inj.description ?? ''}" | consequences: "${inj.consequences ?? ''}"`,
      ).join('\n')}`,
    );
  }

  // threads — StoryThread[]
  if (state.threads?.length) {
    stateLines.push(
      `Story Threads:\n${state.threads.map((th) => {
        const clueBlock = th.clues?.length
          ? `\n    clues:\n${th.clues.map((c) => `      originalClue: "${c.clue}"`).join('\n')}`
          : '';
        return `  threadId: "${th.threadId}" | title: "${th.title ?? ''}" | question: "${th.question ?? ''}" | summary: "${th.summary ?? ''}"${clueBlock}`;
      }).join('\n')}`,
    );
  }

  // actionsHistory — SelectedAction[]
  if (state.actionsHistory?.length) {
    stateLines.push(
      `Actions History:\n${state.actionsHistory.map((a) =>
        `  originalText: "${a.text}" | hint: "${a.hint?.text ?? ''}"`,
      ).join('\n')}`,
    );
  }

  if (stateLines.length) {
    parts.push(`TO TRANSLATE — STATE:\n${stateLines.join('\n\n')}`);
  }

  return parts.join('\n\n---\n');
}

function formatBookPrompt(book: BookToTranslate): string {
  return `Title: ${book.title}
Hook: ${book.hook}
Summary: ${book.summary}
Keywords: ${book.keywords?.join(', ') || 'none'}
Language: ${book.language || 'en'}`;
}