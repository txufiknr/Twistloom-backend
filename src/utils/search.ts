/**
 * @overview Search Utility Module
 * 
 * Provides search-related utilities including input validation,
 * fuzzy matching algorithms, and search query building.
 * 
 * Features:
 * - Input validation and sanitization
 * - Jaccard similarity for typo tolerance
 * - Trigram-based fuzzy matching
 * - Search query builders for Drizzle ORM
 * - Relevance scoring
 */

import { sql, and, or } from "drizzle-orm";
import { sanitizeText } from "./text-processing.js";
import type { KnownGender } from "../types/user.js";

/**
 * Maximum search query length to prevent abuse
 */
export const MAX_SEARCH_LENGTH = 200;

/**
 * Minimum search query length for meaningful results
 */
export const MIN_SEARCH_LENGTH = 2;

/**
 * Jaccard similarity threshold for fuzzy matching (0-1)
 * Higher values = stricter matching
 */
export const JACCARD_THRESHOLD = 0.3;

/**
 * Trigram similarity threshold (PostgreSQL pg_trgm)
 */
export const TRIGRAM_THRESHOLD = 0.3;

/**
 * Search parameters interface
 */
export interface SearchParams {
  /** Search query string */
  search?: string;
  /** Language filter (ISO 639-1 code) */
  language?: string;
  /** Enable fuzzy matching for typo tolerance */
  fuzzy?: boolean;
  /** Minimum similarity threshold for fuzzy match */
  similarityThreshold?: number;
}

/**
 * Search validation result
 */
export interface ValidationResult {
  /** Whether the search query is valid */
  isValid: boolean;
  /** Sanitized search query */
  sanitized?: string;
  /** Error message if invalid */
  error?: string;
}

/**
 * Validates and sanitizes search query input
 * 
 * @param searchQuery - Raw search query from user input
 * @returns Validation result with sanitized query or error
 * 
 * @example
 * ```typescript
 * const result = validateSearchQuery("mystery thriller");
 * // { isValid: true, sanitized: "mystery thriller" }
 * 
 * const invalid = validateSearchQuery("");
 * // { isValid: false, error: "Search query must be at least 2 characters" }
 * ```
 */
export function validateSearchQuery(searchQuery: string): ValidationResult {
  // Check if search is provided
  if (!searchQuery || typeof searchQuery !== 'string') {
    return {
      isValid: false,
      error: 'Search query must be a non-empty string'
    };
  }

  // Trim whitespace
  const trimmed = searchQuery.trim();

  // Check minimum length
  if (trimmed.length < MIN_SEARCH_LENGTH) {
    return {
      isValid: false,
      error: `Search query must be at least ${MIN_SEARCH_LENGTH} characters`
    };
  }

  // Check maximum length
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    return {
      isValid: false,
      error: `Search query cannot exceed ${MAX_SEARCH_LENGTH} characters`
    };
  }

  // Sanitize the input
  const sanitized = sanitizeText(trimmed);

  // Check if sanitization removed too much content
  if (sanitized.length < MIN_SEARCH_LENGTH) {
    return {
      isValid: false,
      error: 'Search query contains invalid characters'
    };
  }

  return {
    isValid: true,
    sanitized
  };
}

/**
 * Validates ISO 639-1 language code
 * 
 * @param language - Language code to validate
 * @returns Validation result with sanitized language or error
 * 
 * @example
 * ```typescript
 * const result = validateLanguageCode("en");
 * // { isValid: true, sanitized: "en" }
 * 
 * const invalid = validateLanguageCode("invalid");
 * // { isValid: false, error: "Invalid language code" }
 * ```
 */
export function validateLanguageCode(language: string | undefined): { isValid: boolean; sanitized?: string; error?: string } {
  // If no language provided, it's valid
  if (!language) return { isValid: true };

  const trimmed = language.trim();
  
  // Check if it's a valid ISO 639-1 code (2-3 letters)
  const isoPattern = /^[a-z]{2,3}$/;
  if (!isoPattern.test(trimmed)) {
    return {
      isValid: false,
      error: 'Invalid language code. Must be 2-3 letter ISO 639-1 code (e.g., en, es, fr)'
    };
  }

  return {
    isValid: true,
    sanitized: trimmed.toLowerCase()
  };
}

/**
 * Validates age range parameter (format: n-m, e.g., 18-30)
 * 
 * @param ageRange - Age range string to validate
 * @returns Validation result with parsed min/max ages or error
 * 
 * @example
 * ```typescript
 * const result = validateAgeRange("18-30");
 * // { isValid: true, minAge: 18, maxAge: 30 }
 * 
 * const invalid = validateAgeRange("invalid");
 * // { isValid: false, error: "Invalid age range format. Must be n-m (e.g., 18-30)" }
 * ```
 */
export function validateAgeRange(ageRange: string | undefined): { isValid: boolean; minAge?: number; maxAge?: number; error?: string } {
  if (!ageRange) return { isValid: true };

  const trimmed = ageRange.trim();
  const parts = trimmed.split('-');

  if (parts.length !== 2) {
    return {
      isValid: false,
      error: 'Invalid age range format. Must be n-m (e.g., 18-30)'
    };
  }

  const minAge = parseInt(parts[0]);
  const maxAge = parseInt(parts[1]);

  if (isNaN(minAge) || isNaN(maxAge)) {
    return {
      isValid: false,
      error: 'Invalid age range. Both values must be numbers'
    };
  }

  if (minAge < 0 || maxAge < 0) {
    return {
      isValid: false,
      error: 'Invalid age range. Ages must be non-negative'
    };
  }

  if (minAge > maxAge) {
    return {
      isValid: false,
      error: 'Invalid age range. Minimum age cannot be greater than maximum age'
    };
  }

  if (maxAge > 150) {
    return {
      isValid: false,
      error: 'Invalid age range. Maximum age cannot exceed 150'
    };
  }

  return {
    isValid: true,
    minAge,
    maxAge
  };
}

/**
 * Validates gender parameter (male/female)
 * 
 * @param gender - Gender string to validate
 * @returns Validation result with sanitized gender or error
 * 
 * @example
 * ```typescript
 * const result = validateGender("male");
 * // { isValid: true, sanitized: "male" }
 * 
 * const invalid = validateGender("invalid");
 * // { isValid: false, error: "Invalid gender. Must be male or female" }
 * ```
 */
export function validateGender(gender: string | undefined): { isValid: boolean; sanitized?: string; error?: string } {
  if (!gender) return { isValid: true };

  const trimmed = gender.trim().toLowerCase();
  const validGenders: KnownGender[] = ['male', 'female'];

  if (!validGenders.includes(trimmed)) {
    return {
      isValid: false,
      error: 'Invalid gender. Must be male or female'
    };
  }

  return {
    isValid: true,
    sanitized: trimmed
  };
}

/**
 * Calculates Jaccard similarity between two strings
 * Jaccard similarity = |intersection| / |union|
 * 
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Similarity score between 0 and 1
 * 
 * @example
 * ```typescript
 * jaccardSimilarity("hello", "helo"); // 0.8
 * jaccardSimilarity("thriller", "thriler"); // 0.89
 * ```
 */
export function jaccardSimilarity(str1: string, str2: string): number {
  const set1 = new Set(str1.toLowerCase().split(''));
  const set2 = new Set(str2.toLowerCase().split(''));

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Calculates Jaccard similarity for word-level comparison
 * More suitable for phrase matching than character-level
 * 
 * @param str1 - First string/phrase
 * @param str2 - Second string/phrase
 * @returns Similarity score between 0 and 1
 * 
 * @example
 * ```typescript
 * wordJaccardSimilarity("psychological thriller", "psych thriller");
 * // 0.5 (matches "psychological" vs "psych")
 * ```
 */
export function wordJaccardSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\s+/));
  const words2 = new Set(str2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Generates trigrams from a string for fuzzy matching
 * A trigram is a sequence of 3 consecutive characters
 * 
 * @param str - Input string
 * @returns Set of trigrams
 * 
 * @example
 * ```typescript
 * generateTrigrams("hello"); // ["  h", " he", "hel", "ell", "llo", "lo ", "o  "]
 * ```
 */
export function generateTrigrams(str: string): Set<string> {
  const padded = `  ${str.toLowerCase()}  `;
  const trigrams = new Set<string>();

  for (let i = 0; i <= padded.length - 3; i++) {
    trigrams.add(padded.substring(i, i + 3));
  }

  return trigrams;
}

/**
 * Calculates trigram similarity between two strings
 * Similar to PostgreSQL's pg_trgm extension
 * 
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Similarity score between 0 and 1
 * 
 * @example
 * ```typescript
 * trigramSimilarity("thriller", "thriler"); // 0.85
 * ```
 */
export function trigramSimilarity(str1: string, str2: string): number {
  const trigrams1 = generateTrigrams(str1);
  const trigrams2 = generateTrigrams(str2);

  const intersection = new Set([...trigrams1].filter(x => trigrams2.has(x)));
  const union = new Set([...trigrams1, ...trigrams2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Checks if a string matches another with fuzzy tolerance
 * Uses both exact match and similarity algorithms
 * 
 * @param query - Search query
 * @param target - Target string to match against
 * @param threshold - Minimum similarity threshold (default: JACCARD_THRESHOLD)
 * @param fuzzy - Enable fuzzy matching (default: true)
 * @returns True if match found
 * 
 * @example
 * ```typescript
 * fuzzyMatch("thriller", "thriler"); // true (typo tolerance)
 * fuzzyMatch("thriller", "thriller"); // true (exact match)
 * fuzzyMatch("thriller", "comedy"); // false
 * ```
 */
export function fuzzyMatch(
  query: string,
  target: string,
  threshold: number = JACCARD_THRESHOLD,
  fuzzy: boolean = true
): boolean {
  if (!query || !target) return false;

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Exact match (case-insensitive)
  if (targetLower.includes(queryLower)) {
    return true;
  }

  // If fuzzy matching is disabled, return false after exact match check
  if (!fuzzy) return false;

  // Try word-level Jaccard similarity
  const wordSimilarity = wordJaccardSimilarity(query, target);
  if (wordSimilarity >= threshold) {
    return true;
  }

  // Try trigram similarity
  const trigramSim = trigramSimilarity(query, target);
  if (trigramSim >= threshold) {
    return true;
  }

  return false;
}

/**
 * Extracts search terms from a query string
 * Handles quoted phrases and special characters
 * 
 * @param query - Search query string
 * @returns Array of search terms
 * 
 * @example
 * ```typescript
 * extractSearchTerms('"psychological thriller" mystery');
 * // ["psychological thriller", "mystery"]
 * ```
 */
export function extractSearchTerms(query: string): string[] {
  const terms: string[] = [];
  let currentTerm = '';
  let inQuotes = false;

  for (let i = 0; i < query.length; i++) {
    const char = query[i];

    if (char === '"' && (i === 0 || query[i - 1] !== '\\')) {
      if (inQuotes) {
        // Closing quote
        if (currentTerm.trim()) {
          terms.push(currentTerm.trim());
        }
        currentTerm = '';
        inQuotes = false;
      } else {
        // Opening quote
        if (currentTerm.trim()) {
          terms.push(currentTerm.trim());
        }
        currentTerm = '';
        inQuotes = true;
      }
    } else if (char === ' ' && !inQuotes) {
      // Space outside quotes - term separator
      if (currentTerm.trim()) {
        terms.push(currentTerm.trim());
      }
      currentTerm = '';
    } else {
      currentTerm += char;
    }
  }

  // Add last term
  if (currentTerm.trim()) {
    terms.push(currentTerm.trim());
  }

  return terms.filter(term => term.length > 0);
}

/**
 * Builds search conditions for Drizzle ORM queries
 * Supports exact match, keyword search, and language filtering
 * 
 * @param params - Search parameters
 * @param booksTable - Drizzle books table reference
 * @returns SQL condition object or undefined if no search
 * 
 * @example
 * ```typescript
 * const condition = buildSearchConditions(
 *   { search: "thriller", language: "en" },
 *   books
 * );
 * // Returns SQL condition for title, hook, summary, keywords, and language
 * ```
 */
export function buildSearchConditions(
  params: SearchParams,
  booksTable: any
): any | undefined {
  const { search, language } = params;

  // Validate search query if provided
  let sanitizedSearch: string | undefined;
  if (search) {
    const validation = validateSearchQuery(search);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }
    sanitizedSearch = validation.sanitized;
  }

  // If no search and no language filter, return undefined
  if (!sanitizedSearch && !language) {
    return undefined;
  }

  const conditions: any[] = [];

  // Add language filter if provided
  if (language) {
    conditions.push(sql`${booksTable.language} = ${language}`);
  }

  // Add search conditions if provided
  if (sanitizedSearch) {
    const searchPattern = `%${sanitizedSearch}%`;

    // Search in text fields
    const textSearchConditions = [
      sql`${booksTable.title} ILIKE ${searchPattern}`,
      sql`${booksTable.hook} ILIKE ${searchPattern}`,
      sql`${booksTable.summary} ILIKE ${searchPattern}`
    ];

    // Search in keywords (JSONB array)
    // Use jsonb_array_elements_text to expand array and search each element
    const keywordSearchCondition = sql`
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${booksTable.keywords}) as keyword
        WHERE keyword ILIKE ${searchPattern}
      )
    `;

    conditions.push(or(...textSearchConditions, keywordSearchCondition));
  }

  // Combine all conditions with AND
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Calculates relevance score for a search match
 * Higher score = more relevant match
 * 
 * @param query - Search query
 * @param title - Book title
 * @param hook - Book hook
 * @param summary - Book summary
 * @param keywords - Book keywords array
 * @returns Relevance score (0-1)
 * 
 * @example
 * ```typescript
 * const score = calculateRelevance(
 *   "thriller",
 *   "The Thriller",
 *   "A mystery",
 *   "Psychological thriller story",
 *   ["thriller", "mystery"]
 * );
 * // Returns score based on match quality and field importance
 * ```
 */
export function calculateRelevance(
  query: string,
  title: string,
  hook: string | null,
  summary: string | null,
  keywords: string[]
): number {
  if (!query) return 0;

  const queryLower = query.toLowerCase();
  let score = 0;

  // Title match (highest weight)
  if (title.toLowerCase().includes(queryLower)) {
    score += 0.4;
    // Bonus for exact title match
    if (title.toLowerCase() === queryLower) {
      score += 0.2;
    }
  }

  // Hook match (medium-high weight)
  if (hook && hook.toLowerCase().includes(queryLower)) {
    score += 0.25;
  }

  // Summary match (medium weight)
  if (summary && summary.toLowerCase().includes(queryLower)) {
    score += 0.2;
  }

  // Keyword match (medium weight)
  const keywordMatch = keywords.some(kw => 
    kw.toLowerCase().includes(queryLower) || 
    queryLower.includes(kw.toLowerCase())
  );
  if (keywordMatch) {
    score += 0.15;
  }

  return Math.min(score, 1);
}

/**
 * Creates SQL expression for relevance scoring in database query
 * Enables database-level sorting by relevance instead of in-memory sorting
 * 
 * @param query - Search query
 * @param booksTable - Drizzle books table reference
 * @returns SQL expression for relevance calculation
 */
export function createRelevanceExpression(
  query: string,
  booksTable: any
): any {
  if (!query) return sql`0`;
  
  const queryLower = query.toLowerCase();
  
  // Calculate relevance using CASE statements in SQL
  return sql`
    CASE
      WHEN ${booksTable.title} ILIKE ${'%' + queryLower + '%'} THEN 0.4
      WHEN ${booksTable.title} ILIKE ${queryLower} THEN 0.6
      ELSE 0
    END::real +
    CASE
      WHEN ${booksTable.hook} ILIKE ${'%' + queryLower + '%'} THEN 0.25
      ELSE 0
    END::real +
    CASE
      WHEN ${booksTable.summary} ILIKE ${'%' + queryLower + '%'} THEN 0.2
      ELSE 0
    END::real +
    CASE
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${booksTable.keywords}) as kw
        WHERE kw ILIKE ${'%' + queryLower + '%'}
      ) THEN 0.15
      ELSE 0
    END::real
  `;
}
