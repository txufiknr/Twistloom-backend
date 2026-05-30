import type { AIJsonProperty } from "../types/ai-chat.js";
import type { BookCreationResponse, BookTranslation, PageTranslation } from "../types/book.js";
import { characterStatuses, type InitialCharacterMemory, type StoryMC, type StoryMCTranslation } from "../types/character.js";
import { placeMoods, placeTypes, type InitialPlaceMemory } from "../types/places.js";
import type { PlotFlag, PlotFlagType, ActionTranslation, CuriosityLevel, FearLevel, GuiltLevel, PsychologicalFlags, InitialStoryState, TrustLevel, StoryOutline, Ending, StoryPageGeneration } from "../types/story.js";
import type { AIDetectedItem, AIDetectedItemType, AIValidationResult, ThemeValidationCategory } from "../types/theme-validation.js";
import { difficulties, endingTypes, flagLevels, plotFlagTypes } from "../types/story.js";
import { genders, type KnownGender } from "../types/user.js";
import { INJURY_SCHEMA, INVENTORY_ITEM_SCHEMA, STORY_PAGE_GENERATION_SCHEMA } from "./story.js";
import { MAX_CHARACTER_SECRETS, VIABLE_ENDING_LENGTH } from "../config/story.js";

/**
 * Schema definition for AI validation response
 * 
 * Matches the flat object pattern used in the codebase (see schema/story.ts)
 * instead of nested JSON Schema format.
 */
export const THEME_VALIDATION_CATEGORIES: ThemeValidationCategory[] = ['INAPPROPRIATE_CONTENT', 'SUSPICIOUS_PATTERN', 'INVALID_THEME', 'POLICY_VIOLATION', 'OTHER', 'NONE'];
export const THEME_VALIDATION_DETECTED_ITEM_TYPES: AIDetectedItemType[] = ['word', 'pattern', 'pov_instruction', 'invalid_format', 'other'];
// export const THEME_VALIDATION_SCHEMA: { [K in keyof AIValidationResult]: AIJsonProperty } = {
export const THEME_VALIDATION_SCHEMA: Record<keyof AIValidationResult, AIJsonProperty> = {
  isViolating: { type: 'boolean' },
  category: { type: 'string', enum: THEME_VALIDATION_CATEGORIES },
  confidence: { type: 'number' },
  detectedItems: { type: 'array', items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: THEME_VALIDATION_DETECTED_ITEM_TYPES },
      value: { type: 'string' },
      context: { type: 'string' },
      reason: { type: 'string' },
    } satisfies Record<keyof AIDetectedItem, AIJsonProperty>,
    required: ['type', 'value', 'context', 'reason'] satisfies (keyof AIDetectedItem)[],
    additionalProperties: false
  } },
  suggestion: { type: 'string', description: '1-sentence suggestion on how to fix the issue, or empty string if theme is valid' },
  comment: { type: 'string', description: 'Max 250 chars - complimentary comment about theme idea. Empty string if theme is invalid.' },
  language: { type: 'string', description: 'Detected language code (ISO 639-1)' }
};

export const VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'A viable doom ending plan based on current story trajectory and theme.',
  properties: {
    text: { type: 'string', description: `Write the story ending plan in ${VIABLE_ENDING_LENGTH}. Be specific to MC and theme.` },
    type: { type: 'string', enum: Object.keys(endingTypes) as EndingType[] },
    outline: {
      type: 'array',
      description: 'A roadmap to reach the ending. 1-2 sentence per item. Align done count with current phase.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          isDone: { type: 'boolean' },
        },
        required: ['text', 'isDone'] satisfies (keyof StoryOutline)[],
        additionalProperties: false
      }
    },
  } satisfies Record<keyof Ending, AIJsonProperty>,
  required: ['text', 'type'] satisfies (keyof Ending)[],
  additionalProperties: false
};

/**
 * Common schema definition for BookCreationResponse type
 * 
 * This is the single source of truth for BookCreationResponse schema.
 * All helper functions reference this to avoid duplication.
 */
export const BOOK_CREATION_SCHEMA_DEFINITION = {
  title: { type: 'string' },
  alternativeTitles: { type: 'array', items: { type: 'string' } },
  totalPages: { type: 'integer' },
  language: { type: 'string', description: 'ISO 639-1 language code' },
  hook: { type: 'string' },
  summary: { type: 'string' },
  keywords: { type: 'array', items: { type: 'string' } },
  firstPage: {
    type: 'object',
    properties: STORY_PAGE_GENERATION_SCHEMA,
    required: ['text', 'actions'] satisfies (keyof StoryPageGeneration)[],
    additionalProperties: false
  },
  initialState: {
    type: 'object',
    properties: {
      flags: {
        type: 'object',
        properties: {
          trust: { type: 'string', enum: [...flagLevels] satisfies TrustLevel[] },
          fear: { type: 'string', enum: [...flagLevels] satisfies FearLevel[] },
          guilt: { type: 'string', enum: [...flagLevels] satisfies GuiltLevel[] },
          curiosity: { type: 'string', enum: [...flagLevels] satisfies CuriosityLevel[] },
        },
        required: ['trust', 'fear', 'guilt', 'curiosity'] satisfies (keyof PsychologicalFlags)[],
        additionalProperties: false
      },
      difficulty: { type: 'string', enum: [...difficulties] },
      viableEnding: VIABLE_ENDING_SCHEMA,
      traumaTags: { type: 'array', items: { type: 'string' } },
      futureNotes: { type: 'array', items: { type: 'string' } },
      plotFlags: { type: 'array', items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          fact: { type: 'string' },
          type: { type: 'string', enum: [...plotFlagTypes] satisfies PlotFlagType[] },
        },
        required: ['page', 'fact', 'type'] satisfies (keyof PlotFlag)[],
        additionalProperties: false
      } },
      isMajorEvent: { type: 'boolean' },
      inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA },
      injuries: { type: 'array', items: INJURY_SCHEMA },
    } satisfies Record<keyof InitialStoryState, AIJsonProperty>,
    required: ['flags', 'difficulty', 'viableEnding', 'traumaTags', 'plotFlags', 'isMajorEvent'] satisfies (keyof InitialStoryState)[],
    additionalProperties: false
  },
  initialPlace: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: [...placeTypes] },
      currentMood: { type: 'string', enum: [...placeMoods] },
      context: { type: 'string' },
      familiarity: { type: 'number' },
    } satisfies Record<keyof InitialPlaceMemory, AIJsonProperty>,
    required: ['name', 'type', 'currentMood', 'context', 'familiarity'] satisfies (keyof InitialPlaceMemory)[],
    additionalProperties: false
  },
  initialCharacters: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        gender: { type: "string", enum: [...genders] },
        status: { type: 'string', enum: [...characterStatuses] },
        relationshipToMC: { type: 'string', description: "Specific dynamic, not generic, ${RELATIONSHIP_TO_MC_LENGTH} (e.g. 'Close childhood friend who knows too much.')" },
        bio: { type: 'string', description: "Brief character description. Include one trait that could become a source of threat or betrayal." },
        visualDescription: { type: 'string', description: "Character visual description (e.g. height, skin color, eye color, hair, etc)." },
        secrets: { type: 'array', items: { type: 'string' }, description: `Any secrets the character has that the MC doesn't know (max ${MAX_CHARACTER_SECRETS}).` },
      } satisfies Record<keyof InitialCharacterMemory, AIJsonProperty>,
      required: ['name', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription', 'secrets'] satisfies (keyof InitialCharacterMemory)[],
      additionalProperties: false
    }
  },
  mainCharacter: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
      gender: { type: 'string', enum: ['male', 'female'] satisfies KnownGender[] },
      bio: { type: 'string' },
    } satisfies Record<keyof StoryMC, AIJsonProperty>,
    required: ['name', 'age', 'gender', 'bio'] satisfies (keyof StoryMC)[],
    additionalProperties: false
  }
} satisfies Record<keyof BookCreationResponse, AIJsonProperty>;

export const BOOK_CREATION_REQUIRED_FIELDS = [
  'title',
  'totalPages',
  'language',
  'hook',
  'summary',
  'keywords',
  'firstPage',
  'initialState',
  'initialPlace',
  'initialCharacters',
  'mainCharacter'
] satisfies Array<keyof BookCreationResponse>;

/**
 * Schema definition for BookTranslation type
 */
export const BOOK_TRANSLATION_SCHEMA_DEFINITION = {
  title: { type: 'string' },
  hook: { type: 'string' },
  summary: { type: 'string' },
  keywords: { type: 'array', items: { type: 'string' } },
  mc: {
    type: 'object',
    properties: {
      bio: { type: 'string' },
    },
    required: ['bio'] satisfies (keyof StoryMCTranslation)[],
    additionalProperties: false
  }
} satisfies Record<keyof BookTranslation, AIJsonProperty>;

export const BOOK_TRANSLATION_REQUIRED_FIELDS = ['title', 'hook', 'summary', 'keywords', 'mc'] satisfies Array<keyof BookTranslation>;

/**
 * Schema definition for bulk book translation
 */
export const BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION = {
  translations: { type: 'array', items: {
    type: 'object',
    properties: { bookId: { type: 'string' }, ...BOOK_TRANSLATION_SCHEMA_DEFINITION },
    required: ['bookId', 'title', 'hook', 'summary', 'keywords', 'mc'] satisfies (keyof BookTranslation | 'bookId')[],
    additionalProperties: false
  } }
} satisfies Record<keyof { translations: BookTranslation[] }, AIJsonProperty>;

export const BULK_BOOK_TRANSLATION_REQUIRED_FIELDS = ['translations'] satisfies Array<keyof { translations: BookTranslation[] }>;

/**
 * Schema definition for PageTranslation type
 */
export const PAGE_TRANSLATION_SCHEMA_DEFINITION = {
  text: { type: 'string' },
  place: { type: 'string' },
  keyEvents: { type: 'array', items: { type: 'string' } },
  importantObjects: { type: 'array', items: { type: 'string' } },
  actions: { type: 'array', items: {
    type: 'object',
    properties: {
      originalText: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['originalText', 'text'] satisfies (keyof ActionTranslation)[],
    additionalProperties: false
  } }
} satisfies Record<keyof PageTranslation, AIJsonProperty>;

export const PAGE_TRANSLATION_REQUIRED_FIELDS = ['text', 'actions'] satisfies Array<keyof PageTranslation>;

/**
 * Schema definition for bulk page translation
 */
export const BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION = {
  translations: { type: 'array', items: {
    type: 'object',
    properties: { pageId: { type: 'string' }, ...PAGE_TRANSLATION_SCHEMA_DEFINITION },
    required: ['pageId', 'text', 'place', 'keyEvents', 'importantObjects', 'actions'] satisfies (keyof PageTranslation | 'pageId')[],
    additionalProperties: false
  } }
} satisfies Record<keyof { translations: PageTranslation[] }, AIJsonProperty>;

export const BULK_PAGE_TRANSLATION_REQUIRED_FIELDS = ['translations'] satisfies Array<keyof { translations: PageTranslation[] }>;
