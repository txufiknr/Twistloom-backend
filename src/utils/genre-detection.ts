/**
 * Genre Detection Utility
 *
 * Heuristic genre classification from book keywords using weighted signal
 * strength scoring. Provides:
 * - `GenreCategory` type for type-safe genre keys
 * - `GENRE_KEYWORD_MAP` — keyword patterns per genre organized by signal strength
 * - `detectGenre(keywords)` — weighted dominant-genre detection with deduplication
 * - `GenreContextConfig` — prompt-facing genre config (examples + rule)
 * - `GENRE_CONTEXT_CONFIGS` — per-genre prompt configs
 *
 * Keywords are classified into four signal strength tiers (explicit/high/medium/low)
 * that map to numeric scores (4/3/2/1). Both quantity and quality of evidence contribute
 * to the final genre classification, with exact matches scoring higher than bounded matches.
 *
 * Decoupled from custom-actions so it can be reused by any system
 * that needs genre awareness (e.g., content moderation, recommendation).
 */

// ============================================================================
// Types & Constants
// ============================================================================

export type GenreCategory =
  | 'fantasy'
  | 'scifi'
  | 'horror'
  | 'thriller'
  | 'drama'
  | 'general';

type DetectableGenre = Exclude<GenreCategory, 'general'>;

/**
 * Universal content policy guardrails applied to all genres.
 * Extracted to maintain a Single Source of Truth (SSOT).
 *
 * Genre context must never act as a safety-policy bypass. Its purpose is only
 * to prevent ordinary fictional genre conventions from being misclassified
 * merely because they contain conflict, violence, horror, or dramatic tension.
 */
const UNIVERSAL_CONTENT_POLICY =
  `CRITICAL RESTRAINT: Genre context does not override the platform's universal content policy. Do not reject ordinary fictional combat, genre-appropriate violence, horror atmosphere, or dramatic tension solely because of genre; evaluate the actual content against the applicable policy rules.`;

/**
 * Keyword signal strength tiers representing classification confidence.
 *
 * `explicit` = literally names the genre or a recognized subgenre
 * `high`     = strongly characteristic, nearly unambiguous
 * `medium`   = meaningful evidence, shared across 2-3 genres
 * `low`      = weak supporting clue, many possible interpretations
 *
 * These map to numeric scores so that both quantity AND quality of evidence
 * contribute to the final genre classification. A single explicit match
 * outweighs several low matches.
 */
type GenreSignalStrength = 'explicit' | 'high' | 'medium' | 'low';

const SIGNAL_SCORE: Record<GenreSignalStrength, number> = {
  low: 1,
  medium: 2,
  high: 3,
  explicit: 4,
};

/**
 * Minimum evidence required before resolving a non-general genre.
 *
 * Equivalent to one exact high-strength match (3) or two exact medium matches.
 * Prevents false positives from weak/ambiguous keyword combinations.
 */
const MIN_GENRE_SCORE = 3;

// ============================================================================
// Keyword → Genre Mapping
// ============================================================================

/**
 * Keyword patterns that signal each genre, organized by signal strength.
 *
 * Patterns use normalized lowercase kebab-case. Input keywords are normalized
 * before comparison, so values such as "Dark Fantasy", "dark_fantasy", and
 * "dark/fantasy" all resolve consistently.
 *
 * Signal strength tiers:
 * - `explicit`: Literally names the genre or a recognized subgenre (score 4)
 * - `high`:     Strongly characteristic, nearly unambiguous (score 3)
 * - `medium`:   Meaningful evidence, shared across 2-3 genres (score 2)
 * - `low`:      Weak supporting clue, many possible interpretations (score 1)
 *
 * Order within each tier does not matter. All genres are scored independently;
 * `GENRE_DETECTION_ORDER` is used only as a deterministic tie-breaker.
 */
export const GENRE_KEYWORD_MAP = {
  fantasy: {
    explicit: [
      'fantasy',
      'high-fantasy',
      'urban-fantasy',
      'epic-fantasy',
      'dark-fantasy',
      // Indonesian aliases
      'fantasi',
    ],
    high: [
      'sword-and-sorcery',
      'sorcery',
      'magic',
      'magical',
      'dragon',
      'dragons',
      // Indonesian aliases
      'sihir',
      'naga',
    ],
    medium: [
      'mythology',
      'fairy-tale',
      'quest',
      // Indonesian aliases
      'mitologi',
      'dongeng',
      'petualangan',
    ],
    low: [
      'sword',
      'swords',
      'kingdom',
      'wizard',
      'elf',
      'elves',
      'orc',
      // Indonesian aliases
      'pedang',
      'kerajaan',
    ],
  },

  scifi: {
    explicit: [
      'sci-fi',
      'scifi',
      'science-fiction',
      'space-opera',
      'cyberpunk',
      // Indonesian aliases
      'fiksi-ilmiah',
    ],
    high: [
      'alien',
      'aliens',
      'mecha',
      'post-apocalyptic',
      'post-apocalypse',
    ],
    medium: [
      'robot',
      'robots',
      'dystopia',
      'dystopian',
      'futuristic',
      'android',
      // Indonesian aliases
      'distopia',
      'futuristik',
      'pasca-apokaliptik',
    ],
    low: [
      'space',
      'implant',
      'spaceship',
      'laser',
      'cyborg',
      // Indonesian aliases
      'luar-angkasa',
    ],
  },

  horror: {
    explicit: [
      'horror',
      'psychological-horror',
      'cosmic-horror',
      'survival-horror',
      'body-horror',
      'folk-horror',
      'supernatural-horror',
      // Indonesian aliases
      'horor',
      'horor-psikologis',
    ],
    high: [
      'haunted',
      'occult',
      'ghost',
      'ghosts',
      'demon',
      'demons',
      'possession',
      // Indonesian aliases
      'hantu',
      'berhantu',
      'okultisme',
    ],
    medium: [
      'supernatural',
      'paranormal',
      'undead',
      'zombie',
      'vampire',
      // Indonesian aliases
      'supranatural',
    ],
    low: [
      'fear',
      'dark',
      'nightmare',
      'creepy',
      'eerie',
    ],
  },

  thriller: {
    explicit: [
      'thriller',
      'psychological-thriller',
      'crime-thriller',
      'spy-thriller',
      'mystery',
      // Indonesian aliases
      'misteri',
    ],
    high: [
      'detective',
      'noir',
      'espionage',
      'suspense',
      'investigation',
      // Indonesian aliases
      'detektif',
    ],
    medium: [
      'crime',
      'spy',
      'heist',
      'conspiracy',
      'whodunit',
      // Indonesian aliases
      'kriminal',
      'mata-mata',
      'konspirasi',
    ],
    low: [
      'secret',
      'chase',
      'pursuit',
      'clue',
      'alibi',
    ],
  },

  drama: {
    explicit: [
      'drama',
      'literary-fiction',
      'family-saga',
      'coming-of-age',
      'historical-fiction',
      // Indonesian aliases
      'fiksi-sejarah',
      'fiksi-sastra',
      'saga-keluarga',
    ],
    high: [
      'romance',
      'romantic',
      'period-piece',
      'slice-of-life',
      // Indonesian aliases
      'romansa',
      'romantis',
    ],
    medium: [
      'historical',
      'family',
      'relationship',
      'friendship',
      // Indonesian aliases
      'sejarah',
    ],
    low: [
      'emotional',
      'love',
      'betrayal',
      'grief',
      'hope',
      // Indonesian aliases
      'kehidupan-sehari-hari',
    ],
  },
} as const satisfies Record<
  DetectableGenre,
  Record<GenreSignalStrength, readonly string[]>
>;

/**
 * Detection priority used only when two or more genres receive exactly
 * the same score.
 *
 * This preserves deterministic behavior for genuinely hybrid books without
 * allowing the first weak match to override stronger evidence from later tags.
 */
const GENRE_DETECTION_ORDER = [
  'fantasy',
  'scifi',
  'horror',
  'thriller',
  'drama',
] as const satisfies readonly DetectableGenre[];

// ============================================================================
// Genre Detection Helpers
// ============================================================================

/**
 * Normalize a raw keyword into the canonical form used by
 * `GENRE_KEYWORD_MAP`.
 *
 * Normalization intentionally:
 * - lowercases
 * - trims whitespace
 * - strips Unicode diacritics
 * - converts spaces/punctuation/separators to "-"
 * - collapses repeated separators
 *
 * @example
 * normalizeGenreKeyword(' Dark Fantasy ')         // → 'dark-fantasy'
 * normalizeGenreKeyword('psychological_horror')   // → 'psychological-horror'
 * normalizeGenreKeyword('SCI FI')                 // → 'sci-fi'
 */
function normalizeGenreKeyword(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check whether a normalized genre pattern occurs as a complete token or
 * phrase inside a normalized keyword.
 *
 * This intentionally avoids raw substring matching.
 *
 * @example
 * isBoundedGenreMatch('dark-fantasy-romance', 'dark-fantasy') // → true
 * isBoundedGenreMatch('deep-space-opera', 'space')             // → true
 * isBoundedGenreMatch('workspace', 'space')                    // → false
 * isBoundedGenreMatch('alienation', 'alien')                   // → false
 */
function isBoundedGenreMatch(
  normalizedKeyword: string,
  normalizedPattern: string,
): boolean {
  return `-${normalizedKeyword}-`.includes(`-${normalizedPattern}-`);
}

/**
 * Compute the score for a keyword match given its signal strength and match type.
 *
 * Exact matches return the full signal score. Bounded matches (where the
 * pattern is found as a complete token inside a compound keyword) return
 * one less, with a floor of 1 to preserve minimum evidence from bounded hits.
 *
 * @example
 * scoreMatch('explicit', true)  // → 4  (exact explicit)
 * scoreMatch('explicit', false) // → 3  (bounded explicit)
 * scoreMatch('high', true)      // → 3  (exact high)
 * scoreMatch('high', false)     // → 2  (bounded high)
 * scoreMatch('low', true)       // → 1  (exact low)
 * scoreMatch('low', false)      // → 1  (bounded low, floored)
 */
function scoreMatch(strength: GenreSignalStrength, exact: boolean): number {
  const base = SIGNAL_SCORE[strength];
  return exact ? base : Math.max(1, base - 1);
}

/**
 * Resolve the strongest match score for one keyword against one genre.
 *
 * Iterates signal tiers from strongest to weakest. Only the strongest
 * matching pattern contributes for a given keyword/genre pair, preventing
 * compound terms such as "psychological-horror" from being double-counted
 * because they also contain "horror".
 */
function scoreKeywordForGenre(
  normalizedKeyword: string,
  genre: DetectableGenre,
): number {
  const tiers: GenreSignalStrength[] = ['explicit', 'high', 'medium', 'low'];

  for (const tier of tiers) {
    for (const pattern of GENRE_KEYWORD_MAP[genre][tier]) {
      if (normalizedKeyword === pattern) {
        return scoreMatch(tier, true);
      }

      if (isBoundedGenreMatch(normalizedKeyword, pattern)) {
        return scoreMatch(tier, false);
      }
    }
  }

  return 0;
}

/**
 * Detect the dominant genre from a book's keywords.
 *
 * Each genre is scored independently using weighted signal strength:
 * - `explicit` keywords (score 4): literally name the genre or subgenre
 * - `high` keywords (score 3): strongly characteristic, nearly unambiguous
 * - `medium` keywords (score 2): meaningful evidence, shared across genres
 * - `low` keywords (score 1): weak supporting clue, many interpretations
 *
 * Exact matches return the full signal score; bounded matches (where the
 * pattern appears as a complete token inside a compound keyword) return
 * one less. Duplicate normalized keywords are deduplicated to prevent
 * synonym inflation.
 *
 * If multiple genres have the same final score, `GENRE_DETECTION_ORDER`
 * provides a deterministic tie-breaker.
 *
 * Returns 'general' when no sufficiently strong genre signal is present.
 *
 * This function is intentionally heuristic and is best suited to controlled
 * tags/keywords rather than arbitrary full prose or book summaries.
 *
 * @param keywords - Array of raw tags/keywords provided by the user or metadata.
 * @returns {GenreCategory} The resolved dominant genre category.
 *
 * @example
 * detectGenre(['dark-fantasy', 'dragons']) // → 'fantasy'
 * detectGenre(['cooking', 'travel'])       // → 'general'
 * detectGenre(['workspace'])               // → 'general'
 * detectGenre(['crime', 'detective'])      // → 'thriller'
 * detectGenre(['horor psikologis'])        // → 'horror'
 */
export function detectGenre(
  keywords?: readonly string[] | null,
): GenreCategory {
  if (!keywords || keywords.length === 0) {
    return 'general';
  }

  // Deduplicate normalized keywords to prevent duplicate synonyms from
  // inflating scores (e.g., ["horror", "horror-story", "horor"] all
  // mapping to the same concept and scoring 4+4+4 = 12).
  const normalizedKeywords = [
    ...new Set(
      keywords
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .map(normalizeGenreKeyword)
        .filter(Boolean),
    ),
  ];

  if (normalizedKeywords.length === 0) {
    return 'general';
  }

  const scores: Record<DetectableGenre, number> = {
    fantasy: 0,
    scifi: 0,
    horror: 0,
    thriller: 0,
    drama: 0,
  };

  for (const normalizedKeyword of normalizedKeywords) {
    for (const genre of GENRE_DETECTION_ORDER) {
      scores[genre] += scoreKeywordForGenre(normalizedKeyword, genre);
    }
  }

  let bestGenre: GenreCategory = 'general';
  let bestScore = 0;

  for (const genre of GENRE_DETECTION_ORDER) {
    const score = scores[genre];

    // Intentionally use ">" rather than ">=" so equal scores preserve the
    // deterministic priority defined by GENRE_DETECTION_ORDER.
    if (score > bestScore) {
      bestGenre = genre;
      bestScore = score;
    }
  }

  return bestScore >= MIN_GENRE_SCORE ? bestGenre : 'general';
}

// ============================================================================
// Prompt-Facing Genre Context Configs
// ============================================================================

export interface GenreContextConfig {
  /** Example actions for the prompt (2-3 max for token efficiency) */
  readonly examples: readonly string[];

  /**
   * One-line rule for the evaluator using concise, prescriptive AI commands.
   *
   * Rules clarify ordinary genre conventions but never override universal
   * content-policy evaluation.
   */
  readonly rule: string;
}

export const GENRE_CONTEXT_CONFIGS = {
  fantasy: {
    examples: ['attack the dragon', 'cast a fireball', 'draw my sword'],
    rule:
      'Combat magic, sword fights, and monster battles are standard fictional tropes. Do not reject them solely for containing genre-appropriate fantasy conflict or violence.',
  },

  scifi: {
    examples: [
      'hack the mainframe',
      'board the alien ship',
      'activate my implant',
    ],
    rule:
      'Clearly fictional technology, combat, hacking, and alien encounters are standard sci-fi tropes. Do not reject them solely because they depict genre-appropriate conflict.',
  },

  horror: {
    examples: [
      'confront the ghost',
      'explore the haunted house',
      'banish the demon',
    ],
    rule:
      'Ghost/demon confrontation, dark exploration, dread, and survival scenarios are core horror mechanics. Do not reject them solely for horror atmosphere or fictional threat.',
  },

  thriller: {
    examples: [
      'interrogate the suspect',
      'chase the fleeing figure',
      'search for clues',
    ],
    rule:
      'Interrogation, pursuit, investigation, and suspense are standard thriller mechanics. Do not reject them solely for tense fictional conflict.',
  },

  drama: {
    examples: [
      'confront the betrayal',
      'confess my feelings',
      'defy the tyrant',
    ],
    rule:
      'Emotional confrontation, betrayal, romance, and intense personal conflict are core dramatic mechanics. Do not reject them solely for romantic or dramatic tension.',
  },
} as const satisfies Record<DetectableGenre, GenreContextConfig>;

// ============================================================================
// GENRE CONTEXT — Prompt Builder
// ============================================================================

/**
 * Human-readable genre labels used in the generated prompt.
 */
const GENRE_CONTEXT_LABELS = {
  fantasy: 'FANTASY',
  scifi: 'SCI-FI',
  horror: 'HORROR',
  thriller: 'THRILLER',
  drama: 'DRAMA',
} as const satisfies Record<DetectableGenre, string>;

/**
 * Builds a concise genre context block for the evaluator prompt.
 * Uses configs to inject only the detected genre's rule plus a generic fallback,
 * keeping the system prompt lean and preventing over-censorship.
 *
 * Genre context is descriptive rather than authoritative for safety: it helps
 * the evaluator understand normal fictional conventions without weakening the
 * platform's universal content-policy checks.
 *
 * @param genreCategory - Detected genre key from `detectGenre()`
 * @returns Formatted genre context block string
 */
export function buildGenreContextBlock(
  genreCategory: GenreCategory,
): string {
  if (genreCategory === 'general') {
    return `GENRE CONTEXT (MULTI-GENRE/GENERAL): Fiction commonly explores conflict, violence, horror, danger, and mature dramatic themes. Do not reject ordinary fictional genre conventions solely because they contain those elements.
${UNIVERSAL_CONTENT_POLICY}`;
  }

  const config = GENRE_CONTEXT_CONFIGS[genreCategory];

  // Formats array into "A, B, or C" for clean prompt injection.
  const examples: readonly string[] = config.examples;
  const formattedExamples =
    examples.length === 0
      ? ''
      : examples.length === 1
        ? examples[0]
        : `${examples.slice(0, -1).join(', ')}, or ${examples[examples.length - 1]}`;

  const examplesLine = formattedExamples
    ? `\nExample standard actions: ${formattedExamples}.`
    : '';

  return `GENRE CONTEXT (${GENRE_CONTEXT_LABELS[genreCategory]}): ${config.rule}${examplesLine}
${UNIVERSAL_CONTENT_POLICY}`;
}