import type { AIJsonProperty } from "../types/ai-chat.js";
import type { BookCreationResponse, BookTranslation, PageTranslation } from "../types/book.js";
import type { CharacterMemory, StoryMC, StoryMCTranslation } from "../types/character.js";
import type { PlaceMemory } from "../types/places.js";
import type { Action, ActionHint, ActionTranslation, PsychologicalFlags, StoryPage, StoryStateInitialGeneration } from "../types/story.js";

/**
 * Common schema definition for BookCreationResponse type
 * 
 * This is the single source of truth for BookCreationResponse schema.
 * All helper functions reference this to avoid duplication.
 */
export const BOOK_CREATION_SCHEMA_DEFINITION = {
  title: { type: 'string' },
  alternativeTitles: { type: 'array', items: { type: 'string' } },
  totalPages: { type: 'number' },
  language: { type: 'string' },
  hook: { type: 'string' },
  summary: { type: 'string' },
  keywords: { type: 'array', items: { type: 'string' } },
  firstPage: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      mood: { type: 'string' },
      place: { type: 'string' },
      timeOfDay: { type: 'string' },
      charactersPresent: { type: 'array', items: { type: 'string' } },
      keyEvents: { type: 'array', items: { type: 'string' } },
      importantObjects: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string' },
          hint: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['text', 'type'] satisfies (keyof ActionHint)[],
            additionalProperties: false
          },
        },
        required: ['text', 'type', 'hint'] satisfies (keyof Action)[],
        additionalProperties: false
      } },
    },
    required: ['text'] satisfies (keyof StoryPage)[],
    additionalProperties: false
  },
  initialState: {
    type: 'object',
    properties: {
      flags: {
        type: 'object',
        properties: {
          trust: { type: 'string' },
          fear: { type: 'string' },
          guilt: { type: 'string' },
          curiosity: { type: 'string' },
        },
        required: ['trust', 'fear', 'guilt', 'curiosity'] satisfies (keyof PsychologicalFlags)[],
        additionalProperties: false
      },
      difficulty: { type: 'string' },
      viableEnding: { type: 'object' },
      traumaTags: { type: 'array', items: { type: 'string' } },
      plotFlags: { type: 'array', items: { type: 'object' } },
      isMajorEvent: { type: 'boolean' },
      inventory: { type: 'array', items: { type: 'object' } },
      injuries: { type: 'array', items: { type: 'object' } },
    },
    required: ['flags', 'difficulty', 'viableEnding', 'traumaTags', 'plotFlags', 'isMajorEvent'] satisfies (keyof StoryStateInitialGeneration)[],
    additionalProperties: false
  },
  initialPlace: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string' },
      currentMood: { type: 'string' },
      context: { type: 'string' },
      familiarity: { type: 'number' },
    },
    required: ['name', 'type', 'currentMood', 'context', 'familiarity'] satisfies (keyof PlaceMemory)[],
    additionalProperties: false
  },
  initialCharacters: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        gender: { type: 'string' },
        status: { type: 'string' },
        relationshipToMC: { type: 'string' },
        bio: { type: 'string' },
        visualDescription: { type: 'string' },
      },
      required: ['name', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription'] satisfies (keyof CharacterMemory)[],
      additionalProperties: false
    }
  },
  mainCharacter: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      gender: { type: 'string' },
      bio: { type: 'string' },
    },
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
    required: ['title', 'hook', 'summary', 'keywords', 'mc'] satisfies (keyof BookTranslation)[],
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
    required: ['text', 'place', 'keyEvents', 'importantObjects', 'actions'] satisfies (keyof PageTranslation)[],
    additionalProperties: false
  } }
} satisfies Record<keyof { translations: PageTranslation[] }, AIJsonProperty>;

export const BULK_PAGE_TRANSLATION_REQUIRED_FIELDS = ['translations'] satisfies Array<keyof { translations: PageTranslation[] }>;
