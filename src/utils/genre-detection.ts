/**
 * Genre Detection Utility
 *
 * Heuristic genre classification from book keywords. Provides:
 * - `GenreCategory` type for type-safe genre keys
 * - `GENRE_KEYWORD_MAP` — keyword patterns per genre
 * - `detectGenre(keywords)` — weighted dominant-genre detection
 * - `GenreContextConfig` — prompt-facing genre config (examples + rule)
 * - `GENRE_CONTEXT_CONFIGS` — per-genre prompt configs
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
 * Exact keyword matches are stronger evidence than matches embedded inside
 * a compound tag or phrase.
 *
 * Example:
 * - "horror"               → exact match
 * - "gothic-horror-story"  → bounded match
 */
const EXACT_MATCH_SCORE = 3;
const BOUNDED_MATCH_SCORE = 2;

/**
 * Minimum evidence required before resolving a non-general genre.
 *
 * A bounded phrase match is sufficient, while arbitrary substring matches
 * are intentionally unsupported to prevent false positives such as:
 * - "workspace"   → "space"
 * - "alienation"  → "alien"
 */
const MIN_GENRE_SCORE = BOUNDED_MATCH_SCORE;

// ============================================================================
// Keyword → Genre Mapping
// ============================================================================

/**
 * Keyword patterns that signal each genre.
 *
 * Patterns use normalized lowercase kebab-case. Input keywords are normalized
 * before comparison, so values such as "Dark Fantasy", "dark_fantasy", and
 * "dark/fantasy" all resolve consistently.
 *
 * Order within each array does not matter. All genres are scored independently;
 * `GENRE_DETECTION_ORDER` is used only as a deterministic tie-breaker.
 */
export const GENRE_KEYWORD_MAP = {
  fantasy: [
    'fantasy',
    'high-fantasy',
    'urban-fantasy',
    'epic-fantasy',
    'dark-fantasy',
    'magic',
    'magical',
    'sorcery',
    'dragon',
    'dragons',
    'sword-and-sorcery',
    'swords',
    'mythology',
    'fairy-tale',

    // Indonesian aliases
    'fantasi',
    'sihir',
    'naga',
    'pedang',
    'mitologi',
    'dongeng',
  ],

  scifi: [
    'sci-fi',
    'scifi',
    'science-fiction',
    'cyberpunk',
    'space-opera',
    'space',
    'alien',
    'aliens',
    'robot',
    'robots',
    'dystopia',
    'dystopian',
    'futuristic',
    'post-apocalyptic',
    'post-apocalypse',
    'mecha',

    // Indonesian aliases
    'fiksi-ilmiah',
    'luar-angkasa',
    'distopia',
    'futuristik',
    'pasca-apokaliptik',
  ],

  horror: [
    'horror',
    'psychological-horror',
    'cosmic-horror',
    'survival-horror',
    'body-horror',
    'folk-horror',
    'supernatural-horror',
    'supernatural',
    'ghost',
    'ghosts',
    'haunted',
    'occult',
    'demon',
    'demons',

    // Indonesian aliases
    'horor',
    'horor-psikologis',
    'hantu',
    'berhantu',
    'supranatural',
    'okultisme',
  ],

  thriller: [
    'thriller',
    'psychological-thriller',
    'mystery',
    'crime',
    'crime-fiction',
    'detective',
    'noir',
    'spy',
    'espionage',
    'heist',
    'conspiracy',
    'suspense',

    // Indonesian aliases
    'misteri',
    'kriminal',
    'detektif',
    'mata-mata',
    'konspirasi',
  ],

  drama: [
    'romance',
    'romantic',
    'drama',
    'historical',
    'historical-fiction',
    'literary-fiction',
    'family-saga',
    'coming-of-age',
    'period-piece',
    'slice-of-life',

    // Indonesian aliases
    'romansa',
    'romantis',
    'sejarah',
    'fiksi-sejarah',
    'fiksi-sastra',
    'saga-keluarga',
    'kehidupan-sehari-hari',
  ],
} as const satisfies Record<DetectableGenre, readonly string[]>;

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
 * Resolve the strongest match score for one keyword against one genre.
 *
 * Only the strongest matching pattern contributes for a given keyword/genre
 * pair. This prevents compound genre terms such as "psychological-horror"
 * from being double-counted because they also contain "horror".
 */
function scoreKeywordForGenre(
  normalizedKeyword: string,
  genre: DetectableGenre,
): number {
  let bestScore = 0;

  for (const pattern of GENRE_KEYWORD_MAP[genre]) {
    if (normalizedKeyword === pattern) {
      return EXACT_MATCH_SCORE;
    }

    if (
      bestScore < BOUNDED_MATCH_SCORE &&
      isBoundedGenreMatch(normalizedKeyword, pattern)
    ) {
      bestScore = BOUNDED_MATCH_SCORE;
    }
  }

  return bestScore;
}

/**
 * Detect the dominant genre from a book's keywords.
 *
 * Each genre is scored independently instead of using a first-match strategy.
 * Exact tags receive more weight than patterns embedded inside compound tags.
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

  const scores: Record<DetectableGenre, number> = {
    fantasy: 0,
    scifi: 0,
    horror: 0,
    thriller: 0,
    drama: 0,
  };

  for (const rawKeyword of keywords) {
    // Defensive runtime guard: TypeScript types can still be bypassed by
    // malformed external data, JSON payloads, migrations, or stale records.
    if (typeof rawKeyword !== 'string') {
      continue;
    }

    const normalizedKeyword = normalizeGenreKeyword(rawKeyword);

    if (!normalizedKeyword) {
      continue;
    }

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