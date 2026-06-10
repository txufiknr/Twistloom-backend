import type { ActionType, AIActionConfig } from "../types/story.js";

export const BOOK_MIN_PAGES = 80;
export const BOOK_MAX_PAGES = 200;
export const MIN_CHARS_PER_PAGE = 200;
export const MAX_WORDS_PER_PAGE = 120;
export const MAX_WORDS_SUMMARIZED_CONTEXT = 300;

export const MAX_CHARACTERS = 6;
export const MIN_CHARACTER_AGE = 13;
export const MAX_CHARACTER_AGE = 27;
export const MAX_CHARACTER_SECRETS = 3;
export const MAX_PLACES = 6;
export const MAX_ACTIVE_THREADS = 5;
export const MAX_THREADS_PER_PAGE = 2;
export const MAX_INVENTORY_ITEM = 5;

export const MIN_ACTION_CHOICES = 1;
export const MAX_ACTION_CHOICES = 3;
export const MAX_ACTION_CHOICES_FIRST_PAGE = 2;
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

// /**
//  * Maximum number of mood history entries to store per place
//  * 
//  * This maintains emotional atmosphere evolution while preventing
//  * excessive memory usage for place mood tracking.
//  */
// export const MAX_PLACE_MOOD_HISTORY = 5;

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

// ============================================================================
// PLACE SELECTION CONFIGURATION
// ============================================================================

/**
 * Pages over which recency score decays in place selection
 * 
 * How many pages it takes for recency score to fully decay
 * when selecting places for scenes.
 */
export const PLACE_SELECTION_RECENCY_DECAY = 10;

/**
 * Maximum characters for character connection scoring
 * 
 * How many characters a place needs to have maximum
 * character connection score in place selection.
 */
export const PLACE_MAX_CHARACTERS_SCORE = 3;

/**
 * Randomness bonus in place selection scoring
 * 
 * Small random factor to prevent predictable place selection patterns.
 */
export const PLACE_RANDOMNESS_BONUS = 0.05;

// ============================================================================
// PLACE SELECTION WEIGHTS
// ============================================================================

/**
 * Weight for familiarity in place selection (40%)
 */
export const PLACE_WEIGHT_FAMILIARITY = 0.4;

/**
 * Weight for recency in place selection (20%)
 */
export const PLACE_WEIGHT_RECENCY = 0.2;

/**
 * Weight for trauma relevance in place selection (30%)
 */
export const PLACE_WEIGHT_TRAUMA = 0.3;

/**
 * Weight for character connections in place selection (10%)
 */
export const PLACE_WEIGHT_CHARACTERS = 0.1;

// ============================================================================
// TRAUMA RELEVANCE SCORES
// ============================================================================

/**
 * Score for direct event tag matches in trauma relevance
 */
export const TRAUMA_SCORE_DIRECT_MATCH = 0.5;

/**
 * Score for mood-based trauma relevance matches
 */
export const TRAUMA_SCORE_MOOD_MATCH = 0.3;

/**
 * Score for location hint-based trauma relevance matches
 */
export const TRAUMA_SCORE_LOCATION_MATCH = 0.2;

// ============================================================================
// DIFFICULTY-BASED SELECTION
// ============================================================================

/**
 * Probability of selecting top place at high difficulty
 */
export const HIGH_DIFFICULTY_TOP_PLACE_PROBABILITY = 0.7;

/**
 * Probability of creating new place at low difficulty
 */
export const LOW_DIFFICULTY_NEW_PLACE_PROBABILITY = 0.4;

/**
 * Maximum places for low difficulty random selection
 */
export const LOW_DIFFICULTY_MAX_PLACES = 8;

/**
 * Weighted selection probabilities for medium difficulty
 */
export const MEDIUM_DIFFICULTY_WEIGHTS = [0.5, 0.3, 0.2];

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

/**
 * Temperature threshold for JSON reliability capping
 */
export const JSON_RELIABILITY_TEMPERATURE_THRESHOLD = 0.8;

// ============================================================================
// AI CONFIGURATION FOR ACTION TYPES
// ============================================================================

/**
 * Neutral adjustment.
 *
 * Used for actions that should not meaningfully affect
 * generation creativity or sampling behavior.
 */
export const DEFAULT_ACTION_AI_CONFIG: AIActionConfig = {
  temperature: { adjustment: 0, min: 0.6, max: 0.8 },
  topP: { adjustment: 0, min: 0.85, max: 0.95 },
  topK: { adjustment: 0, min: 40, max: 50 }
};

/**
 * Action-specific sampling adjustments.
 *
 * These provide subtle nudges to generation style.
 *
 * Important:
 * - Action configs should NEVER drastically change model behavior.
 * - Large behavioral changes belong in prompting.
 * - Sampling changes should stay small enough that story tone remains stable.
 */
export const ACTION_AI_CONFIG: Record<ActionType, AIActionConfig> = {
  attack: {
    temperature: { adjustment: 0.02, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.01, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  escape: {
    temperature: { adjustment: 0.01, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.01, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  risk: {
    temperature: { adjustment: 0.03, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.02, min: 0.85, max: 0.95 },
    topK: { adjustment: 3, min: 40, max: 50 }
  },
  social: {
    temperature: { adjustment: 0.04, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.02, min: 0.85, max: 0.95 },
    topK: { adjustment: 2, min: 40, max: 50 }
  },
  deceive: {
    temperature: { adjustment: 0.02, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.01, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  create: {
    temperature: { adjustment: 0.05, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.03, min: 0.85, max: 0.95 },
    topK: { adjustment: 5, min: 40, max: 50 }
  },
  explore: {
    temperature: { adjustment: 0.05, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.03, min: 0.85, max: 0.95 },
    topK: { adjustment: 5, min: 40, max: 50 }
  },
  protect: {
    temperature: { adjustment: -0.01, min: 0.6, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  heal: DEFAULT_ACTION_AI_CONFIG,
  ignore: DEFAULT_ACTION_AI_CONFIG,
  dialogue: DEFAULT_ACTION_AI_CONFIG,
  custom: DEFAULT_ACTION_AI_CONFIG,
  other: DEFAULT_ACTION_AI_CONFIG
};

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
 * Finale configuration.
 *
 * As the story approaches resolution,
 * consistency becomes more important than novelty.
 *
 * This reduces randomness slightly to improve:
 * - callbacks
 * - payoff delivery
 * - narrative consistency
 * - ending quality
 */
export const FINALE_CONFIG: AIActionConfig = {
  temperature: { adjustment: -0.08, min: 0.55, max: 0.7 },
  topP: { adjustment: -0.04, min: 0.82, max: 0.9 },
  topK: { adjustment: -5, min: 30, max: 45 }
};

/**
 * Reliability caps for structured output generation.
 *
 * High sampling values can occasionally reduce JSON reliability.
 * These caps provide a final safeguard without noticeably affecting prose quality.
 */
export const JSON_RELIABILITY_CAPS = {
  maxTemperature: 0.85,
  maxTopP: 0.95,
  maxTopK: 50
};