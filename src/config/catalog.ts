/**
 * Catalogue facet vocabularies — backend SSOT for the values users and clients
 * may use for explore filtering, discovery and narration.
 *
 * F-13 (see `Twistloom-web/docs/roadmap/OPEN_FINDINGS_REGISTER.md`):
 * Exposes the authoritative facet lists so clients (Web and Flutter) can sync
 * vocabularies rather than maintaining disjoint hardcoded copies.
 */

import { type BookMode, bookModes } from "../types/book.js";

/** ISO 639-1 book languages supported by the explore `?language=` filter. */
export const BOOK_LANGUAGES = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ru',
  'zh',
  'ja',
  'ko',
  'ar',
  'hi',
  'id',
  'th',
  'vi',
] as const;

export type BookLanguageCode = (typeof BOOK_LANGUAGES)[number];

/**
 * Explore `?ageRange=` buckets, as `n-m` spans.
 */
export const BOOK_AGE_RANGES = [
  '13-15',
  '16-18',
  '19-21',
  '22-25',
  '26-40',
  '41-65',
] as const;

export type BookAgeRangeCode = (typeof BOOK_AGE_RANGES)[number];

/**
 * Explore `?gender=` POV filter options.
 */
export const BOOK_GENDERS = ['male', 'female'] as const;

export type BookGenderCode = (typeof BOOK_GENDERS)[number];

/**
 * Explore `?mode=` options.
 */
export const BOOK_MODES = bookModes;
export type BookModeCode = BookMode;
