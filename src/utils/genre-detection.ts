/**
 * Genre Detection Utility
 *
 * Heuristic genre classification from book keywords. Provides:
 * - `GenreCategory` type for type-safe genre keys
 * - `GENRE_KEYWORD_MAP` — keyword patterns per genre
 * - `detectGenre(keywords)` — first-match genre detection
 * - `GenreContextConfig` — prompt-facing genre config (examples + rule)
 * - `GENRE_CONTEXT_CONFIGS` — per-genre prompt configs
 *
 * Decoupled from custom-actions so it can be reused by any system
 * that needs genre awareness (e.g., content moderation, recommendation).
 */

import type { GenreCategory } from "../types/story.js";

// ============================================================================
// Keyword → Genre Mapping
// ============================================================================

/**
 * Keyword patterns that signal each genre. Lowercase, substring-matched.
 * Order within array doesn't matter; detection order is defined by `GENRE_DETECTION_ORDER`.
 */
export const GENRE_KEYWORD_MAP: Record<Exclude<GenreCategory, 'general'>, readonly string[]> = {
  fantasy: ['fantasy', 'magic', 'dragon', 'medieval', 'swords', 'sorcery', 'mythology', 'fairy-tale', 'epic-fantasy', 'dark-fantasy'],
  scifi: ['sci-fi', 'cyberpunk', 'space', 'alien', 'robot', 'dystopia', 'technology', 'future', 'post-apocalyptic', 'mecha'],
  horror: ['horror', 'supernatural', 'ghost', 'haunted', 'occult', 'psychological-horror', 'cosmic-horror', 'survival-horror', 'body-horror'],
  thriller: ['thriller', 'mystery', 'crime', 'detective', 'noir', 'spy', 'heist', 'conspiracy', 'psychological-thriller'],
  drama: ['romance', 'drama', 'historical', 'literary-fiction', 'family-saga', 'coming-of-age', 'period-piece'],
} as const;

/** Detection priority — first match wins */
const GENRE_DETECTION_ORDER: readonly Exclude<GenreCategory, 'general'>[] = [
  'fantasy', 'scifi', 'horror', 'thriller', 'drama',
];

/**
 * Detect the dominant genre from a book's keywords.
 * Returns the first matching genre category, or 'general' if none match.
 *
 * @param keywords - Array of raw tags/keywords provided by the user or metadata.
 * @returns {GenreCategory} The resolved genre category.
 * 
 * @example
 * detectGenre(['dark-fantasy', 'dragons']) // → 'fantasy'
 * detectGenre(['cooking', 'travel'])       // → 'general'
 */
export function detectGenre(keywords: string[]): GenreCategory {
  if (!keywords || keywords.length === 0) return 'general';
  
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  
  for (const genre of GENRE_DETECTION_ORDER) {
    const patterns = GENRE_KEYWORD_MAP[genre];
    if (lowerKeywords.some((kw) => patterns.some((p) => kw.includes(p)))) {
      return genre;
    }
  }
  return 'general';
}

// ============================================================================
// Prompt-Facing Genre Context Configs
// ============================================================================

export interface GenreContextConfig {
  /** Example actions for the prompt (2-3 max for token efficiency) */
  readonly examples: readonly string[];
  /** One-line rule for the evaluator using prescriptive AI commands */
  readonly rule: string;
}

export const GENRE_CONTEXT_CONFIGS: Record<Exclude<GenreCategory, 'general'>, GenreContextConfig> = {
  fantasy: {
    examples: ['attack the dragon', 'cast a fireball', 'draw my sword'],
    rule: 'Combat magic, sword fights, and monster battles are standard tropes. NEVER reject fictional fantasy violence as a policy violation.',
  },
  scifi: {
    examples: ['hack the mainframe', 'board the alien ship', 'activate my implant'],
    rule: 'Tech/combat actions, hacking, and alien encounters are standard tropes. NEVER reject sci-fi conflict as a policy violation.',
  },
  horror: {
    examples: ['confront the ghost', 'explore the haunted house', 'banish the demon'],
    rule: 'Ghost/demon confrontation, dark exploration, and survival actions are core mechanics. NEVER reject horror atmosphere or dread as a policy violation.',
  },
  thriller: {
    examples: ['interrogate the suspect', 'chase the fleeing figure', 'search for clues'],
    rule: 'Interrogation, pursuit, and investigation actions are standard. NEVER reject tense dramatic conflict as a policy violation.',
  },
  drama: {
    examples: ['confront the betrayal', 'confess my feelings', 'defy the tyrant'],
    rule: 'Emotional confrontation, betrayal, and intense personal conflict are core dramatic actions. NEVER reject romantic or dramatic tension as a policy violation.',
  },
} as const;
