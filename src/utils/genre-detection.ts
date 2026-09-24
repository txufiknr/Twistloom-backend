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
 *
 * Behavior note (see `scoreKeywordForGenre`): a prior version could silently
 * downgrade a genuine exact-match compound keyword (e.g. "high-fantasy",
 * "psychological-horror") to a lower bounded-match score, purely because of
 * pattern-array ordering. That's fixed now. The fix is intentional and can
 * change the tie-break winner for books tagged with strong (explicit-tier)
 * keywords from two different genres at once — two scores that used to
 * differ by 1 solely because of the bug can now correctly tie and fall to
 * `GENRE_DETECTION_ORDER`. Single-genre tagging is unaffected.
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
 * Signal tiers in strongest-to-weakest order. Declared once at module scope
 * — rather than as a local array literal inside `scoreKeywordForGenre` — so
 * the same tier list isn't reallocated on every keyword/genre pair scored,
 * and so the iteration order has a single named source of truth rather than
 * a hardcoded array that could quietly drift from `SIGNAL_SCORE`'s keys.
 */
const SIGNAL_TIERS_DESCENDING: readonly GenreSignalStrength[] = [
  'explicit',
  'high',
  'medium',
  'low',
];

/**
 * Minimum cumulative genre score required before resolving a non-general
 * genre. This is a floor, not an exact target: it's cleared by a single
 * exact high-tier match (score 3), a single exact explicit-tier match
 * (score 4), two exact medium matches (score 2+2=4), or one medium plus one
 * low match (2+1=3) — but NOT by two low matches alone (1+1=2).
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
      'quests',
      // Indonesian aliases
      'mitologi',
      'dongeng',
      'petualangan',
    ],
    low: [
      'sword',
      'swords',
      'kingdom',
      'kingdoms',
      'wizard',
      'wizards',
      'elf',
      'elves',
      'orc',
      'orcs',
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
      'androids',
      // "hack"/"hacker"/"hacking" are genre-ambiguous ("life hacking", a
      // hacking cough, a clever "hack") so they're kept at medium rather
      // than high/explicit — they can help confirm a cyberpunk signal
      // alongside other evidence, but can never single-handedly classify
      // something as scifi.
      'hack',
      'hacker',
      'hacking',
      // Indonesian alias for "hacker"
      'peretas',
      // "wasteland" is genre-ambiguous (post-apocalyptic scifi vs. the
      // literary/metaphorical sense, e.g. a "cultural wasteland") — kept at
      // medium for the same reason.
      'wasteland',
      // Indonesian aliases
      'distopia',
      'futuristik',
      'pasca-apokaliptik',
    ],
    low: [
      'space',
      'implant',
      'implants',
      'spaceship',
      'spaceships',
      'laser',
      'lasers',
      'cyborg',
      'cyborgs',
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
      'demonic',
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
      'zombies',
      'vampire',
      'vampires',
      // "asylum" is genre-ambiguous (mental institution vs. political/
      // refugee asylum — a completely unrelated, often serious drama
      // subject) so it's kept at medium rather than high: enough to help
      // confirm a haunted-asylum horror premise alongside other evidence,
      // never enough on its own to mislabel an asylum-seeker story.
      'asylum',
      // Indonesian aliases
      'supranatural',
    ],
    low: [
      'fear',
      'dark',
      'nightmare',
      'nightmares',
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
      'detectives',
      'noir',
      'espionage',
      'suspense',
      'investigation',
      'murder',
      'murders',
      'hitman',
      'hitmen',
      // Indonesian aliases
      'detektif',
    ],
    medium: [
      'crime',
      'spy',
      'spies',
      'heist',
      'heists',
      'conspiracy',
      'whodunit',
      // "killer" is genre-ambiguous ("killer app", "killer deal") so it's
      // kept at medium rather than high — enough to help confirm a real
      // thriller/horror signal, never enough by itself.
      'killer',
      'killers',
      // Indonesian aliases
      'kriminal',
      'mata-mata',
      'konspirasi',
    ],
    low: [
      'secret',
      'secrets',
      'chase',
      'pursuit',
      'clue',
      'clues',
      'alibi',
      'alibis',
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
      'relationships',
      'friendship',
      // Indonesian aliases
      'sejarah',
    ],
    low: [
      'emotional',
      'love',
      'betrayal',
      'betrayals',
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

/**
 * Compile-time guard ensuring every `DetectableGenre` has an entry in
 * `GENRE_DETECTION_ORDER`. `GENRE_KEYWORD_MAP` and `GENRE_CONTEXT_CONFIGS`
 * get this guarantee for free via `satisfies Record<DetectableGenre, ...>`;
 * a plain tuple has no built-in equivalent, so without this check, adding a
 * new genre to `GenreCategory` without also listing it here would compile
 * fine — the new genre's score would just sit at 0 forever inside
 * `detectGenre` (both loops there only visit genres this array lists), so
 * it could never be selected, with nothing to say why. This turns that into
 * a compile error instead.
 *
 * Both sides are wrapped in single-element tuples to stop TypeScript from
 * distributing the conditional over each member of `DetectableGenre`;
 * without that, a genre missing from `GENRE_DETECTION_ORDER` would
 * silently vanish from the union instead of failing the check.
 *
 * Type-only — erased at compile time, no runtime cost or behavior.
 */
type GenreDetectionOrderIsExhaustive = [DetectableGenre] extends [
  (typeof GENRE_DETECTION_ORDER)[number],
]
  ? true
  : never;
void (true satisfies GenreDetectionOrderIsExhaustive);

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
 * Iterates signal tiers from strongest to weakest, stopping at the first
 * tier that produces a match — so an explicit-tier match always outranks
 * any high/medium/low-tier match, even a merely bounded one. This is also
 * what prevents compound terms such as "psychological-horror" from being
 * double-counted for also containing "horror": once the explicit tier
 * matches on either pattern, scoring stops there and the lower tiers are
 * never consulted.
 *
 * Within a tier, EVERY pattern is checked for an exact match before ANY
 * pattern is checked for a bounded match. This two-pass order matters:
 * tier lists are authored with the bare genre name first (e.g. "horror")
 * followed by its compound subgenres (e.g. "psychological-horror"), so a
 * single-pass scan would find "horror" as a bounded match inside the
 * keyword "psychological-horror" before ever reaching the exact
 * "psychological-horror" entry later in the same array — silently
 * downgrading a genuine exact match to a lower bounded score purely
 * because of list order. Checking all exact matches first makes the result
 * independent of how the pattern arrays happen to be ordered.
 */
function scoreKeywordForGenre(
  normalizedKeyword: string,
  genre: DetectableGenre,
): number {
  for (const tier of SIGNAL_TIERS_DESCENDING) {
    const patterns = GENRE_KEYWORD_MAP[genre][tier];

    // Pass 1: exact matches only.
    for (const pattern of patterns) {
      if (normalizedKeyword === pattern) {
        return scoreMatch(tier, true);
      }
    }

    // Pass 2: bounded matches — only reached if no exact match exists
    // anywhere in this tier.
    for (const pattern of patterns) {
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

  // Deduplicate keywords that normalize to the exact same string, so
  // formatting-only variants of one tag (e.g. "Horror", "horror ", "HORROR")
  // don't each add their own score. This does NOT catch different
  // spellings of the same concept: "horror", "horor" (Indonesian), and
  // "horror-story" each normalize to different strings and are scored
  // independently below, so if a caller ever emits more than one of those
  // for what is really a single underlying genre selection, they'll still
  // be weighed as separate evidence. Collapsing genuine cross-spelling
  // synonyms would need concept-level grouping this function doesn't
  // attempt — if that turns out to matter in practice, dedupe at the
  // source (one canonical keyword per selection) rather than here.
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

  // Formats the example list into natural English: "A" / "A or B" /
  // "A, B, or C". Every current config has exactly 3 examples (so only the
  // last branch is reachable today), but this stays grammatically correct
  // if a config is ever trimmed to 1-2 examples.
  const examples: readonly string[] = config.examples;
  const formattedExamples =
    examples.length === 0
      ? ''
      : examples.length === 1
        ? examples[0]
        : examples.length === 2
          ? `${examples[0]} or ${examples[1]}`
          : `${examples.slice(0, -1).join(', ')}, or ${examples[examples.length - 1]}`;

  const examplesLine = formattedExamples
    ? `\nExample standard actions: ${formattedExamples}.`
    : '';

  return `GENRE CONTEXT (${GENRE_CONTEXT_LABELS[genreCategory]}): ${config.rule}${examplesLine}
${UNIVERSAL_CONTENT_POLICY}`;
}
