import type { InitialInventoryItem } from "./character.js";
import type { Mood, PastEvent, TraitItem } from "./story.js";

/**
 * Available place types for categorizing locations
 * 
 * These types help the AI understand the nature and function
 * of each place within the narrative world.
 */
export const placeTypes = [
  "house",        // Residential buildings, homes
  "school",       // Educational institutions
  "forest",       // Natural wooded areas
  "river",        // Water bodies, streams
  "road",         // Transportation routes
  "building",     // General structures
  "room",         // Indoor spaces
  "outdoor",      // Open areas
  "unknown",      // Mysterious/unidentified places
  "other"         // Catch-all for unique locations
] as const;

/**
 * Union type of all possible place type values
 */
export type PlaceType = typeof placeTypes[number];

// /**
//  * Available emotional atmospheres for places
//  * 
//  * These moods track how places feel to the MC and can
//  * influence narrative tone and psychological effects.
//  */
// export const placeMoods = [
//   "safe",         // Feels secure, protected
//   "threatening",  // Dangerous, hostile
//   "eerie",        // Unsettling, strange
//   "familiar",     // Known, comfortable
//   "unfamiliar",   // New, unknown
//   "distorted",    // Wrong, altered
//   "sacred",       // Special, meaningful
//   "contaminated", // Corrupted, tainted
//   "neutral"       // No strong atmosphere
// ] as const;

// /**
//  * Union type of all possible place mood values
//  */
// export type PlaceMood = typeof placeMoods[number];

/**
 * Available weather conditions for places
 * 
 * These weather patterns can influence atmosphere, mood,
 * and narrative opportunities for scene setting.
 */
export const placeWeathers = [
  "clear",        // Sunny, clear skies
  "cloudy",       // Overcast, gray skies
  "rainy",        // Rain falling
  "stormy",       // Thunder, lightning, heavy rain
  "foggy",        // Thick fog, low visibility
  "windy",        // Strong winds
  "snowy",        // Snow falling
  "misty",        // Light mist, haze
  "humid",        // Heavy moisture in air
  "dry",          // Low humidity, arid
  "unknown"       // Weather not specified
] as const;

/**
 * Union type of all possible weather values
 */
export type PlaceWeather = typeof placeWeathers[number];

// /**
//  * Sensory details for immersive place descriptions
//  * 
//  * These optional details help the AI create consistent
//  * atmospheric descriptions across multiple visits.
//  */
// export type SensoryDetails = {
//   /** Smell characteristics of the place */
//   smell?: string;
//   /** Sound environment of the place */
//   sound?: string;
//   /** Visual appearance and lighting */
//   visual?: string;
//   /** Physical sensations (temperature, texture) */
//   feeling?: string;
// };

/**
 * Complete place memory structure for narrative consistency
 * 
 * This type defines the full place schema including visit history,
 * emotional associations, and narrative connections.
 */
export type PlaceMemory = {
  /** Place name as it appears in the narrative (preferred name) */
  knownName: string;
  /** Original name unrevealed (e.g., institution name) - never changed throughout story */
  realName: string;
  /** Type of place for categorization and behavior patterns */
  type: PlaceType;
  /** Short human-readable description for immediate recall */
  context: string;
  /** Known clues, obstacles, spatial relationship to other places */
  hints?: string[];
  /** Visit tracking metrics */
  visitCount?: number;
  /** Last visited by main character */
  lastVisitedAtPage: number;
  /** Weather condition of the place on last visit */
  lastWeather?: PlaceWeather;
  /** Emotional atmosphere of the place on last visit */
  lastMood?: Mood;
  /** The traits of the item (e.g., smell, sound, visual, feeling) */
  traits?: TraitItem[];
  /** Familiarity scale */
  familiarity: number; // 0-1, important for reuse priority
  /** Emotional and narrative associations */
  keyEvents?: PastEvent[]; // [{page: 1, event: "MC discovered the place"}, {page: 3, event: "first meeting with Character A"}]
  /** Objects associated to this place (e.g., wooden chair, cupboard, large mirror, etc) */
  keyObjects?: InitialInventoryItem[];
  /** Characters encountered here with context */
  knownCharacters?: TraitItem[];
  /** Whether the place's real name known to MC */
  isRealNameKnown?: boolean;
};

export type PlaceMemoryTranslation = Pick<PlaceMemory, 'knownName' | 'realName' | 'context'> & { placeId: string };

/**
 * Place creation structure for AI output
 * 
 * When AI introduces new places, it provides them in this format
 * for consistent integration into the place memory system.
 * 
 * Notes:
 * - Initial visitCount (always 1 for new places)
 * - Initial lastVisitedAtPage (always current page)
 */
export type NewPlace = Omit<PlaceMemory, 'visitCount' | 'lastVisitedAtPage' | 'lastWeather' | 'lastMood' | 'keyEvents'> & {
  placeId: string;
  keyEvents?: string[];
};

/**
 * Place update structure for AI output
 * 
 * When AI modifies existing places, it provides updates in this format
 * to maintain place development and narrative consistency.
 */
export type PlaceUpdate = Partial<Omit<NewPlace, 'realName' | 'keyEvents' | 'familiarity' | 'traits' | 'hints'>> & {
  placeId: string;
  updateTraits?: TraitItem[];
  addKeyEvents?: string[];
  removeTraits?: string[];
  familiarityCorrection?: number;
  addHints?: string[];
  removeHints?: string[];
};

/**
 * Complete place updates structure for AI JSON output
 * 
 * This structure allows the AI to create new places and update
 * existing ones in a single response, maintaining narrative flow.
 */
export type PlaceUpdates = {
  /** New places introduced in this page */
  newPlaces?: NewPlace[];
  /** Updates to existing places */
  updatedPlaces?: PlaceUpdate[];
};
