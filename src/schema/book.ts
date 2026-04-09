import type { AIJsonProperty } from "../types/ai-chat.js";
import type { BookCreationResponse } from "../types/book.js";

/**
 * Common schema definition for BookCreationResponse type
 * 
 * This is the single source of truth for BookCreationResponse schema.
 * All helper functions reference this to avoid duplication.
 */
export const BOOK_CREATION_SCHEMA_DEFINITION = {
  title: { type: 'string' },
  totalPages: { type: 'number' },
  language: { type: 'string' },
  hook: { type: 'string' },
  summary: { type: 'string' },
  keywords: { type: 'array', items: { type: 'string' } },
  firstPage: { type: 'object' },
  initialState: { type: 'object' },
  initialPlace: { type: 'object' },
  initialCharacters: { type: 'array', items: { type: 'object' } },
  mainCharacter: { type: 'object' }
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
