import type { AIJsonProperty } from "../types/ai-chat.js";
import type { BookCreationResponse, BookTranslation, PageTranslation } from "../types/book.js";
import { type StoryMC, type StoryMCTranslation } from "../types/character.js";
import type { PlotFlagType, ActionTranslation, CuriosityLevel, FearLevel, GuiltLevel, PsychologicalFlags, InitialStoryState, TrustLevel, StoryOutline, StoryPageGeneration, InitialFact, InitialEnding, InitialPlotFlag, Ending, EndingChangeNote } from "../types/story.js";
import type { AIDetectedItem, AIDetectedItemType, AIValidationResult, ThemeValidationCategory } from "../types/theme-validation.js";
import { difficulties, endingTypes, factTypes, flagLevels, plotFlagTypes } from "../types/story.js";
import { type KnownGender } from "../types/user.js";
import { FUTURE_NOTE_SCHEMA, INITIAL_CHARACTER_SCHEMA, INITIAL_INJURY_SCHEMA, INITIAL_INVENTORY_ITEM_SCHEMA, INITIAL_PLACE_SCHEMA, RELATIONSHIP_UPDATE_SCHEMA, STORY_PAGE_GENERATION_SCHEMA } from "./story.js";
import { BOOK_TITLE_LENGTH, FACT_KEY_FORMAT, MAX_CHARACTER_AGE, MAX_FUTURE_NOTES, MIN_CHARACTER_AGE, VIABLE_ENDING_LENGTH } from "../config/story.js";

/**
 * Schema definition for AI validation response
 * 
 * Matches the flat object pattern used in the codebase (see schema/story.ts)
 * instead of nested JSON Schema format.
 */
export const MAIN_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Inferred main character who perfectly fit with the story theme',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', description: `Between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}` },
    gender: { type: 'string', enum: ['male', 'female'] satisfies KnownGender[] },
    bio: { type: 'string', description: 'Trait-forward description. Include at least one psychological vulnerability.' },
  } satisfies Record<keyof StoryMC, AIJsonProperty>,
  required: ['name', 'age', 'gender', 'bio'] satisfies (keyof StoryMC)[],
  additionalProperties: false
};

export const THEME_VALIDATION_CATEGORIES: ThemeValidationCategory[] = ['INAPPROPRIATE_CONTENT', 'SUSPICIOUS_PATTERN', 'INVALID_THEME', 'POLICY_VIOLATION', 'OTHER', 'NONE'];
export const THEME_VALIDATION_DETECTED_ITEM_TYPES: AIDetectedItemType[] = ['word', 'pattern', 'pov_instruction', 'invalid_format', 'other'];
export const THEME_VALIDATION_SCHEMA: Record<keyof AIValidationResult, AIJsonProperty> = {
  isViolating: { type: 'boolean', description: 'If theme is valid and safe, output false' },
  category: { type: 'string', enum: THEME_VALIDATION_CATEGORIES, description: 'If theme is valid and safe, output "NONE"' },
  confidence: { type: 'number' },
  detectedItems: {
    type: 'array',
    description: 'If theme is valid and safe, output empty array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: THEME_VALIDATION_DETECTED_ITEM_TYPES },
        value: { type: 'string' },
        context: { type: 'string' },
        reason: { type: 'string' },
      } satisfies Record<keyof AIDetectedItem, AIJsonProperty>,
      required: ['type', 'value', 'context', 'reason'] satisfies (keyof AIDetectedItem)[],
      additionalProperties: false
    }
  },
  suggestion: { type: 'string', description: '1-sentence suggestion on how to fix the issue. Empty string if theme is valid.' },
  // comment: { type: 'string', description: 'Max 250 chars - complimentary comment about theme idea. Empty string if theme is invalid.' },
  comment: { type: 'string', description: 'Your complimentary comment (follow comment structure & example). Empty string if theme is invalid.' },
  language: { type: 'string', description: 'Detected language code (ISO 639-1)' },
  titleIdea: { type: 'string', description: `${BOOK_TITLE_LENGTH}. Empty string if theme is invalid.` },
  // mcCandidate: MAIN_CHARACTER_SCHEMA
  mcCandidate: {
    ...MAIN_CHARACTER_SCHEMA,
    description: `${MAIN_CHARACTER_SCHEMA.description}. Output empty object "{}" if theme is invalid.`
  }
};

export const INITIAL_VIABLE_ENDING_PROPERTIES: Record<keyof InitialEnding, AIJsonProperty> = {
  text: { type: 'string', description: `Write the story ending plan in ${VIABLE_ENDING_LENGTH}. Be specific to MC and theme.` },
  type: { type: 'string', enum: Object.keys(endingTypes) as EndingType[] },
  outline: {
    type: 'array',
    description: 'A roadmap to reach the ending. 1-2 sentence per item.',
    items: { type: 'string' }
  }
};

export const INITIAL_VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'A viable doom ending plan based on current story trajectory and theme.',
  properties: INITIAL_VIABLE_ENDING_PROPERTIES,
  required: ['text', 'type'] satisfies (keyof InitialEnding)[],
  additionalProperties: false
};

export const VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  ...INITIAL_VIABLE_ENDING_SCHEMA,
  properties: {
    ...INITIAL_VIABLE_ENDING_PROPERTIES,
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
    changeNote: {
      type: 'object',
      description: 'Note about ending plan shift or changes.',
      properties: {
        reason: { type: 'string', description: `Concise. 1-2 sentence.` },
        viabilityBefore: { type: 'number', description: '0-1' },
        viabilityAfter: { type: 'number', description: '0-1' },
      } satisfies Record<keyof EndingChangeNote, AIJsonProperty>,
      required: ['reason'] satisfies (keyof EndingChangeNote)[],
      additionalProperties: false
    }
  } satisfies Record<keyof Ending, AIJsonProperty>
}

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
        } satisfies Record<keyof PsychologicalFlags, AIJsonProperty>,
        required: ['trust', 'fear', 'guilt', 'curiosity'] satisfies (keyof PsychologicalFlags)[],
        additionalProperties: false
      },
      difficulty: { type: 'string', enum: [...difficulties] },
      viableEnding: INITIAL_VIABLE_ENDING_SCHEMA,
      traumaTags: { type: 'array', items: { type: 'string' } },
      futureNotes: {
        type: 'array',
        description: `Forward-looking narrative obligations ("what should happen later") — Foreshadowing notes for future AI turns (max ${MAX_FUTURE_NOTES}).`,
        items: FUTURE_NOTE_SCHEMA
      },
      plotFlags: {
        type: 'array',
        description: 'Historical facts ("what already happened") — Significant story events or revelations that impact narrative trajectory.',
        items: {
          type: 'object',
          properties: {
            fact: { type: 'string' },
            type: { type: 'string', enum: [...plotFlagTypes] satisfies PlotFlagType[] },
            isMajorEvent: { type: 'boolean' },
          } satisfies Record<keyof InitialPlotFlag, AIJsonProperty>,
          required: ['fact', 'type'] satisfies (keyof InitialPlotFlag)[],
          additionalProperties: false
        }
      },
      inventory: { type: 'array', items: INITIAL_INVENTORY_ITEM_SCHEMA },
      injuries: { type: 'array', items: INITIAL_INJURY_SCHEMA },
    } satisfies Record<keyof InitialStoryState, AIJsonProperty>,
    required: ['flags', 'difficulty', 'viableEnding', 'traumaTags', 'plotFlags'] satisfies (keyof InitialStoryState)[],
    additionalProperties: false
  },
  initialFacts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: FACT_KEY_FORMAT },
        value: { type: 'string' },
        type: { type: 'string', enum: [...Object.keys(factTypes)] },
        reason: { type: 'string', description: 'Explain why in 1 sentence' },
      } satisfies Record<keyof InitialFact, AIJsonProperty>,
      required: ['key', 'value'] satisfies (keyof InitialFact)[],
      additionalProperties: false
    }
  },
  initialPlace: INITIAL_PLACE_SCHEMA,
  initialCharacters: { type: 'array', items: INITIAL_CHARACTER_SCHEMA },
  initialRelationships: { type: 'array', items: RELATIONSHIP_UPDATE_SCHEMA },
  mainCharacter: MAIN_CHARACTER_SCHEMA
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
  'initialRelationships',
  'initialFacts',
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
