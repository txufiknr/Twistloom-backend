import type { ActionType, AIActionConfig, CharacterSceneRole, SceneType, StoryMomentum, ThreatProximity } from "../types/story.js";
import type { ThreadPriority } from "../types/story-thread.js";

export const BOOK_MIN_PAGES = 80;
export const BOOK_MAX_PAGES = 200;
export const MIN_CHARS_PER_PAGE = 200;
export const MAX_WORDS_PER_PAGE = 120;
export const MAX_WORDS_SUMMARIZED_CONTEXT = 300;

export const MAX_CHARACTERS = 6; // Only count side characters, excluding MC
export const MIN_CHARACTER_AGE = 13;
export const MAX_CHARACTER_AGE = 27;
export const MAX_CHARACTER_SECRETS = 3;
export const MAX_PLACES = 6;
export const MAX_ACTIVE_THREADS = 5;
export const MAX_THREADS_PER_PAGE = 2;
export const MAX_THREADS_CLUES = 5;
export const MAX_INVENTORY_ITEM = 5;

export const MIN_ACTION_CHOICES = 1;
export const MAX_ACTION_CHOICES = 3;
export const MAX_ACTION_CHOICES_FIRST_PAGE = 2;
export const MAX_ACTION_CHOICES_FINALE = 2;
export const MAX_OLDER_PLOT_FLAGS = 15;

export const MAX_BRANCHING_RETRIES = 3;
export const MAX_BRANCHING_PREGENERATION_DEPTH = 2; // How deep to pre-generate deeper level page candidates
export const MAX_BRANCHING_PREGENERATION_LIMIT = 3; // How many pages to process its actions at once
export const MAX_TRAVERSAL_DEPTH_SHALLOW = 3;

export const FREE_ACTION_SELECTION_UNTIL_PAGE = 1;
export const FREE_GUEST_SELECT_ACTION_UNTIL_PAGE = 5;

export const ACTION_TEXT_LENGTH = '1 short sentence';
export const KEY_EVENT_LENGTH = '1-4 short phrases';
export const VIABLE_ENDING_LENGTH = '1-3 sentences';
export const PLACE_CONTEXT_LENGTH = '1 sentence max';
export const BOOK_TITLE_LENGTH = '2-5 words';
export const HOOK_LENGTH = '1-2 sentences';
export const RELATIONSHIP_TO_MC_LENGTH = '1-2 sentences';
export const SUMMARY_LENGTH = '50-100 words';
export const KEYWORDS_COUNT = '3-5';
export const FACT_KEY_FORMAT = '3-segment dot-separated key: "{type}.{entity_name}.{property_name}"';

export const FUTURE_NOTE_LOOKAHEAD_PAGES = 2;
export const MAX_RECENT_MAJOR_EVENTS = 5;

/**
 * Maximum number of trauma tags to maintain in story state
 * 
 * Limits trauma accumulation to prevent overwhelming the narrative
 * while maintaining relevant psychological markers for story development.
 */
export const MAX_TRAUMA_TAGS = 5;

export const MAX_FUTURE_NOTES = 10;

/**
 * Maximum number of dominant traits for psychological profiles
 * 
 * Keeps character profiles focused and manageable, preventing
 * trait explosion while enabling meaningful psychological analysis.
 */
export const MAX_DOMINANT_TRAITS = 3;

/**
 * Maximum number of past interactions to store per character
 * 
 * This maintains a sliding window of recent interactions to keep
 * character context relevant without overwhelming memory.
 */
export const MAX_PAST_INTERACTIONS = 5;

/**
 * Maximum number of event tags to store per place
 * 
 * This limits the number of significant events tracked per place
 * to maintain relevance and prevent memory bloat.
 */
export const MAX_PLACE_EVENTS = 8;

/**
 * Maximum number of character-place relations per character
 * 
 * This limits how many places a character can be associated with,
 * maintaining manageable character-place connections.
 */
export const MAX_CHARACTER_PLACES = 5;

/**
 * Maximum number of past pages to track for context
 * 
 * This maintains a sliding window of recent pages to keep
 * context relevant without overwhelming memory.
 */
export const MAX_PAGE_HISTORY = 3;
export const MAX_ACTION_HISTORY = 5;

/**
 * Delta and snapshot cleanup configuration
 * 
 * These constants control the strategic retention of story states
 * for optimal performance and storage efficiency in the delta/snapshot system.
 */
export const SNAPSHOT_INTERVAL = 10; // Keep snapshot every 10 pages
export const MIN_PAGES_FOR_MIDDLE = 20; // Only keep middle if book is substantial

// ============================================================================
// PLACE MEMORY CONFIGURATION
// ============================================================================

/**
 * Pages back to consider a place "recent"
 * 
 * Determines how many pages back a place must have been visited
 * to be considered recent for relevance calculations.
 */
export const PLACE_RECENT_THRESHOLD = 5;

/**
 * Minimum familiarity score for places to be considered relevant
 * 
 * Places with familiarity below this threshold won't be considered
 * relevant unless they have other qualifying factors.
 */
export const PLACE_MIN_FAMILIARITY = 0.5;

/**
 * Number of recent events to show in place context
 * 
 * Limits how many recent events are included when formatting
 * places for AI context to prevent overwhelming detail.
 */
export const PLACE_RECENT_EVENTS = 3;

/**
 * Number of recent characters to show in place context
 * 
 * Limits how many recent characters are included when formatting
 * places for AI context.
 */
export const PLACE_RECENT_CHARACTERS = 2;

/**
 * Weight multiplier for familiarity in place archiving
 * 
 * How much familiarity affects place relevance when determining
 * which places to archive.
 */
export const PLACE_FAMILIARITY_WEIGHT = 10;

/**
 * Pages over which recency bonus decays for familiarity
 * 
 * How many pages it takes for the recency bonus to fully decay
 * in familiarity calculations.
 */
export const FAMILIARITY_RECENCY_DECAY = 20;

/**
 * Recency bonus weight in familiarity calculations
 * 
 * How much recency contributes to the total familiarity score.
 */
export const FAMILIARITY_RECENCY_WEIGHT = 0.3;

/**
 * Event significance bonus in familiarity calculations
 * 
 * How much each significant event contributes to familiarity.
 */
export const FAMILIARITY_EVENT_BONUS = 0.1;

/**
 * Visit count for maximum familiarity from visits
 * 
 * The number of visits at which familiarity from visit count
 * approaches its maximum (logarithmic scale).
 */
export const FAMILIARITY_MAX_VISITS = 9;

/**
 * Maximum contribution of visit count to familiarity (0-1).
 * Reached once visitCount hits FAMILIARITY_MAX_VISITS.
 */
export const FAMILIARITY_VISIT_WEIGHT = 0.6;

/**
 * Maximum number of significant events that contribute to familiarity.
 * Caps the event-significance component at
 * FAMILIARITY_MAX_SIGNIFICANT_EVENTS * FAMILIARITY_EVENT_BONUS.
 */
export const FAMILIARITY_MAX_SIGNIFICANT_EVENTS = 2;

/**
 * Keywords used to detect narratively significant past events for
 * familiarity scoring. Case-insensitive substring matching against
 * free-text `keyEvents` entries.
 */
export const SIGNIFICANT_EVENT_KEYWORDS = [
  'betray', 'death', 'died', 'kill', 'murder',
  'discover', 'found', 'reveal', 'secret',
  'trauma', 'attack', 'hurt', 'injur',
  'meet', 'escape', 'trap', 'ambush',
];

// ============================================================================
// AI CONFIGURATION BOUNDS AND LIMITS
// ============================================================================

/**
 * Maximum temperature value for AI configurations
 */
export const MAX_TEMPERATURE = 1.0;

/**
 * Minimum temperature value for AI configurations
 */
export const MIN_TEMPERATURE = 0.0;

/**
 * Maximum topP value for AI configurations
 */
export const MAX_TOP_P = 1.0;

/**
 * Minimum topP value for AI configurations
 */
export const MIN_TOP_P = 0.0;

/**
 * Maximum topK value for AI configurations
 */
export const MAX_TOP_K = 100;

/**
 * Minimum topK value for AI configurations
 */
export const MIN_TOP_K = 1;

/**
 * Maximum output tokens for AI configurations
 */
export const MAX_OUTPUT_TOKENS = 4000;

/**
 * Minimum output tokens for AI configurations
 */
export const MIN_OUTPUT_TOKENS = 1;

// ============================================================================
// SPECIAL AI CONFIGURATIONS FOR STORY MOMENTS
// ============================================================================

/**
 * AI configuration for twist injection moments
 * 
 * Temporary creativity boost to increase dramatic impact and unpredictability for:
 * - Major revelations
 * - Betrayals
 * - Plot twists
 * - Unexpected discoveries
 *
 * Purpose:
 * Encourage slightly less predictable narrative choices
 * while preserving coherence.
 */
export const TWIST_INJECTION_CONFIG: AIActionConfig = {
  temperature: { adjustment: 0.05, min: 0.65, max: 0.8 },
  topP: { adjustment: 0.02, min: 0.88, max: 0.95 },
  topK: { adjustment: 5, min: 40, max: 55 }
};

/**
 * Reliability caps for structured output generation.
 *
 * High sampling values can occasionally reduce JSON reliability.
 * These caps provide a final safeguard without noticeably affecting prose quality.
 */
export const JSON_RELIABILITY_CAPS = {
  /** Temperature controls randomness and elevates the creative vocabulary (0.6 - 0.85): > 0.85 → messy / incoherent, < 0.6 → robotic */
  maxTemperature: 0.85,
  /** Top-p (nucleus) sampling: 0.0 = all tokens, 1.0 = only most likely tokens */
  maxTopP: 0.95,
  /** Top-k sampling: considers top K most likely tokens */
  maxTopK: 50
};

export const MOMENTUM_WEIGHTS = {
  plotPressure:   0.25, // recent major plot flags
  threadPressure: 0.15, // open mysteries demanding attention
  dangerLevel:    0.25, // immediate physical/narrative threat
  urgencyLevel:   0.15, // scene type + thread urgency
  psychPressure:  0.20, // player's psychological state
} as const;

export const MOMENTUM_RECENCY_WINDOW = 3; // pages over which a major plot flag's pressure decays

export const THREAT_PROXIMITY_SCORE: Record<ThreatProximity, number> = {
  immediate: 1.0,
  near: 0.55,
  distant: 0.2,
};

export const THREAD_PRIORITY_WEIGHT: Record<ThreadPriority, number> = {
  main: 1.0,
  secondary: 0.6,
  minor: 0.3,
};

export const DANGEROUS_ACTIONS: ActionType[] = ['attack', 'escape', 'risk'];
export const SAFE_ACTIONS: ActionType[] = ['heal', 'protect'];

export const SCENE_TYPE_URGENCY: Record<SceneType, number> = {
  escape: 1.0,
  confrontation: 0.9,
  revelation: 0.8,
  horror: 0.75,
  deception: 0.55,
  dream: 0.5,
  investigation: 0.45,
  dialogue: 0.35,
  aftermath: 0.2,
  transition: 0.1,
};

export const DEFAULT_SCENE_URGENCY = 0.4;

/**
 * Base danger score per character scene role.
 * Weighted by sceneFocus before accumulation, so a background threat
 * contributes less than a focused one.
 */
export const SCENE_ROLE_DANGER: Record<CharacterSceneRole, number> = {
  threat:     1.0,
  opposition: 0.55,
  neutral:    0.0,
  supporting: 0.0,   // safe presence; threat/fear signals already capture base danger
};

// previous-momentum → baseline score, used both for smoothing and
// for detecting a drop-from-peak ("resolving")
export const MOMENTUM_BASELINE_SCORE: Record<StoryMomentum, number> = {
  building: 0.2,
  rising: 0.5,
  critical: 0.85,
  resolution: 0.35,
};

export const MOMENTUM_THRESHOLDS: { max: number; momentum: StoryMomentum }[] = [
  { max: 0.35, momentum: 'building' },
  { max: 0.65, momentum: 'rising' },
  { max: 1.0, momentum: 'critical' },
];

export const MOMENTUM_PERSISTENCE = 0.35;     // how much of the previous momentum carries forward
export const RESOLVING_DROP_THRESHOLD = 0.25; // drop from a peak large enough to read as "winding down"
export const MAJOR_EVENT_CLIMAX_FLOOR = 0.55; // minimum raw score for a major event to still register as climactic
