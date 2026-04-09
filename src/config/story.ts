import type { ActionType, AIActionConfig } from "../types/story.js";

export const MAX_WORDS_PER_PAGE = 60;
export const MAX_WORDS_SUMMARIZED_CONTEXT = 300;
export const BOOK_MAX_PAGES = 150;
export const BOOK_AVERAGE_PAGES = 120;

export const MAX_CHARACTERS = 6;
export const MIN_CHARACTER_AGE = 13;
export const MAX_CHARACTER_AGE = 25;
export const MAX_PLACES = 6;
export const MAX_ACTION_CHOICES = 3;
export const MAX_ACTION_CHOICES_FIRST_PAGE = 2;

export const NEAR_ENDING_PAGES = 10;

/**
 * Maximum number of trauma tags to maintain in story state
 * 
 * Limits trauma accumulation to prevent overwhelming the narrative
 * while maintaining relevant psychological markers for story development.
 */
export const MAX_TRAUMA_TAGS = 5;

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
 * Maximum number of mood history entries to store per place
 * 
 * This maintains emotional atmosphere evolution while preventing
 * excessive memory usage for place mood tracking.
 */
export const MAX_PLACE_MOOD_HISTORY = 5;

/**
 * Maximum number of event tags to store per place
 * 
 * This limits the number of significant events tracked per place
 * to maintain relevance and prevent memory bloat.
 */
export const MAX_PLACE_EVENT_TAGS = 8;

// /**
//  * Maximum number of known characters to store per place
//  * 
//  * This maintains a manageable list of characters encountered
//  * at each location for narrative consistency.
//  */
// export const MAX_KNOWN_CHARACTERS = 5;

// /**
//  * Maximum number of active places to maintain in memory
//  * 
//  * This prevents memory bloat by limiting the number of places
//  * tracked simultaneously, archiving least relevant ones.
//  */
// export const MAX_ACTIVE_PLACES = 10;

// /**
//  * Maximum number of relevant places to show in AI context
//  * 
//  * This limits the number of places provided to the AI to prevent
//  * overwhelming it with too much context while maintaining variety.
//  */
// export const MAX_RELEVANT_PLACES = 8;

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
export const MAX_PAGE_HISTORY = 5;

/**
 * Delta and snapshot cleanup configuration
 * 
 * These constants control the strategic retention of story states
 * for optimal performance and storage efficiency in the delta/snapshot system.
 */
export const SNAPSHOT_INTERVAL = 10; // Every 10 pages
export const MIN_PAGES_FOR_MIDDLE = 20; // Only keep middle if book is substantial

// ============================================================================
// PLACE MEMORY CONFIGURATION
// ============================================================================

/**
 * Initial familiarity score for new places
 * 
 * Places start with low familiarity that increases with visits.
 */
export const INITIAL_PLACE_FAMILIARITY = 0.1;

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
 * AI parameter adjustments for different action types
 * 
 * These configurations define how AI parameters should be adjusted based on
 * the type of action the user selects. All adjustments are conservative to
 * maintain narrative consistency while providing subtle variations in tone
 * and creativity appropriate to each action type.
 * 
 * Specific Action Adjustments:
 * 
 * | Action Type | Temp Change | topP Change | topK Change | Purpose |
 * |-------------|-------------|-------------|-------------|---------|
 * | `attack` | -0.05 | - | - | Controlled violence |
 * | `escape` | -0.03 | -0.02 | - | Panic responses |
 * | `risk` | -0.02 | - | -3 | Bold moves |
 * | `social` | +0.02 | +0.01 | - | Dialogue creativity |
 * | `deceive` | -0.02 | - | -3 | Psychological manipulation |
 * | `create` | +0.03 | +0.02 | - | Creative expression |
 * | `heal` | -0.04 | -0.02 | - | Recovery scenes |
 * | `ignore` | -0.03 | - | -5 | Avoidance |
 * | `explore` | +0.02 | +0.01 | - | Discovery |
 * | `protect` | -0.02 | - | -3 | Defense |
 * 
 * All adjustments are conservative (±0.05 max temp, ±0.02 max topP, ±5 max topK) to maintain
 * narrative consistency and prevent sudden style changes between actions.
 */
export const ACTION_AI_CONFIG: Record<ActionType, AIActionConfig> = {
  "attack": {
    temperature: { adjustment: -0.05, min: 0.6, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "escape": {
    temperature: { adjustment: -0.03, min: 0.65, max: 0.8 },
    topP: { adjustment: -0.02, min: 0.88, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "risk": {
    temperature: { adjustment: -0.02, min: 0.65, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: -3, min: 40, max: 50 }
  },
  "social": {
    temperature: { adjustment: 0.02, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.01, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "deceive": {
    temperature: { adjustment: -0.02, min: 0.7, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: -3, min: 45, max: 50 }
  },
  "create": {
    temperature: { adjustment: 0.03, min: 0.6, max: 0.8 },
    topP: { adjustment: 0.02, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "heal": {
    temperature: { adjustment: -0.04, min: 0.6, max: 0.8 },
    topP: { adjustment: -0.02, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "ignore": {
    temperature: { adjustment: -0.03, min: 0.65, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: -5, min: 40, max: 50 }
  },
  "explore": {
    temperature: { adjustment: 0.02, min: 0.6, max: 0.75 },
    topP: { adjustment: 0.01, min: 0.85, max: 0.9 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "protect": {
    temperature: { adjustment: -0.02, min: 0.65, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: -3, min: 40, max: 50 }
  },
  "custom": {
    temperature: { adjustment: 0, min: 0.6, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  },
  "other": {
    temperature: { adjustment: 0, min: 0.6, max: 0.8 },
    topP: { adjustment: 0, min: 0.85, max: 0.95 },
    topK: { adjustment: 0, min: 40, max: 50 }
  }
};

/**
 * Type definition for action AI parameter configuration
 */
export type ActionAIConfig = typeof ACTION_AI_CONFIG[keyof typeof ACTION_AI_CONFIG];

// ============================================================================
// SPECIAL AI CONFIGURATIONS FOR STORY MOMENTS
// ============================================================================

/**
 * AI configuration for psychologically distressed states
 * 
 * Applied when character stability is 'unstable' or 'fractured'
 * to increase creativity and unpredictability.
 */
export const PSYCHOLOGICAL_DISTRESS_CONFIG: AIActionConfig = {
  temperature: { adjustment: 0.8, min: 0.8, max: 0.9 },
  topP: { adjustment: 0.95, min: 0.95, max: 0.98 },
  topK: { adjustment: 60, min: 60, max: 70 }
};

/**
 * AI configuration for twist injection moments
 * 
 * Applied during major reveals, betrayals, or near ending
 * to increase dramatic impact and unpredictability.
 */
export const TWIST_INJECTION_CONFIG: AIActionConfig = {
  temperature: { adjustment: 0.1, min: 0.7, max: 0.8 },
  topP: { adjustment: 0.05, min: 0.9, max: 0.95 },
  topK: { adjustment: 10, min: 40, max: 60 }
};

/**
 * AI configuration for JSON reliability layer
 * 
 * Applied when temperature is too high to ensure structured output
 * by capping topK for better sentence structure.
 */
export const JSON_RELIABILITY_CAPS = {
  maxTopK: 50
};