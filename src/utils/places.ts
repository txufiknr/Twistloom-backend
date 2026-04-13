import { 
  MAX_PLACE_MOOD_HISTORY, 
  MAX_PLACE_EVENT_TAGS, 
  INITIAL_PLACE_FAMILIARITY,
  FAMILIARITY_RECENCY_DECAY,
  FAMILIARITY_RECENCY_WEIGHT,
  FAMILIARITY_EVENT_BONUS,
  FAMILIARITY_MAX_VISITS} from "../config/story.js";
import type { PlaceMemory, PlaceUpdate, PlaceMood, PlaceUpdates, PlaceType } from "../types/places.js";
import type { StoryState } from "../types/story.js";
import { filterTruthyAndDedupe } from "./parser.js";

/**
 * Creates a new place with default values
 * 
 * @param name - Place name as it appears in narrative
 * @param type - Type of place for categorization
 * @param context - Short human-readable description
 * @param currentPage - Current page number for tracking
 * @param currentMood - Initial emotional atmosphere
 * @returns New place memory structure
 * 
 * @example
 * ```typescript
 * const place = createPlace("old_river", "Old River", "river", "narrow river behind the school", 5, "eerie");
 * ```
 */
export function createPlace(
  name: string,
  type: PlaceType,
  context: string,
  currentPage: number,
  currentMood: PlaceMood = "neutral"
): PlaceMemory {
  return {
    name,
    type,
    context,
    visitCount: 1,
    lastVisitedAtPage: currentPage,
    familiarity: INITIAL_PLACE_FAMILIARITY, // Starts low, increases with visits
    moodHistory: [currentMood],
    eventTags: [],
    knownCharacters: [],
    currentMood,
  };
}

/**
 * Updates an existing place with new information
 * 
 * Merges new data with existing place memory, maintaining sliding windows
 * for arrays and updating numerical values appropriately.
 * 
 * @param existing - Current place memory
 * @param update - Update data from AI output
 * @returns Updated place memory
 * 
 * @example
 * ```typescript
 * const updated = updatePlace(existing, {
 *   visitCount: 3,
 *   eventTags: ["betrayal"],
 *   currentMood: "threatening"
 * });
 * ```
 */
export function updatePlace(existing: PlaceMemory, update: PlaceUpdate): PlaceMemory {
  const updated = { ...existing };
  
  // Update basic properties if provided
  if (update.name) updated.name = update.name;
  if (update.context) updated.context = update.context;
  if (update.visitCount !== undefined) updated.visitCount = update.visitCount;
  if (update.lastVisitedAtPage !== undefined) updated.lastVisitedAtPage = update.lastVisitedAtPage;
  if (update.familiarity !== undefined) updated.familiarity = update.familiarity;
  if (update.currentMood !== undefined) updated.currentMood = update.currentMood;

  const { moodHistory = [], eventTags = [], knownCharacters = [] } = existing;
  
  // Merge mood history with sliding window
  if (update.moodHistory) {
    updated.moodHistory = [...moodHistory, ...update.moodHistory].slice(-MAX_PLACE_MOOD_HISTORY);
  }
  
  // Merge event tags with sliding window
  if (update.eventTags) {
    updated.eventTags = [...eventTags, ...update.eventTags].slice(-MAX_PLACE_EVENT_TAGS);
  }
  
  // Merge known characters
  if (update.knownCharacters) {
    updated.knownCharacters = filterTruthyAndDedupe([...knownCharacters, ...update.knownCharacters]);
  }
  
  // Update sensory details if provided
  if (update.sensoryDetails) {
    updated.sensoryDetails = {...existing.sensoryDetails, ...update.sensoryDetails};
  }
  
  return updated;
}

/**
 * Adds or updates places in the story state
 * 
 * Processes AI output for new places and updates, maintaining
 * place dictionary structure and active place limits.
 * 
 * @param state - Current story state
 * @param page - Story page containing place updates
 * 
 * @example
 * ```typescript
 * processPlaceUpdates(state, storyPage);
 * ```
 */
export function processPlaceUpdates(state: StoryState, placeUpdates?: PlaceUpdates): void {
  if (!placeUpdates) return;
  
  const {
    newPlaces = [],
    updatedPlaces = [],
  } = placeUpdates;
  
  // Add new places
  for (const newPlace of newPlaces) {
    const place = createPlace(
      // generatePlaceId(newPlace.name, Object.keys(state.places)),
      newPlace.name,
      newPlace.type,
      newPlace.context,
      state.page,
      newPlace.currentMood || "neutral"
    );
    
    // Copy optional properties
    if (newPlace.locationHint) place.locationHint = newPlace.locationHint;
    if (newPlace.sensoryDetails) place.sensoryDetails = newPlace.sensoryDetails;
    if (newPlace.knownCharacters) place.knownCharacters = newPlace.knownCharacters;
    if (newPlace.eventTags) place.eventTags = newPlace.eventTags;
    if (newPlace.moodHistory) place.moodHistory = newPlace.moodHistory;
    
    state.places[place.name] = place;
  }
  
  // Update existing places
  for (const update of updatedPlaces) {
    const existing = state.places[update.name];
    if (existing) {
      state.places[update.name] = updatePlace(existing, update);
    }
  }
  
  // // Maintain active place limit
  // maintainActivePlaceLimit(state);
}

// /**
//  * Maintains the active place limit by archiving old places
//  * 
//  * When the number of active places exceeds the limit, this function
//  * archives the least recently used places to prevent memory bloat.
//  * 
//  * @param state - Current story state
//  */
// function maintainActivePlaceLimit(state: StoryState): void {
//   const places = Object.values(state.places);
  
//   if (places.length <= MAX_ACTIVE_PLACES) return;
  
//   // Sort by last visit (least recent first) and familiarity
//   const sortedPlaces = places.sort((a, b) => {
//     const scoreA = a.lastVisitedAtPage + (a.familiarity * PLACE_FAMILIARITY_WEIGHT);
//     const scoreB = b.lastVisitedAtPage + (b.familiarity * PLACE_FAMILIARITY_WEIGHT);
//     return scoreA - scoreB;
//   });
  
//   // Remove least relevant places
//   const placesToRemove = sortedPlaces.slice(0, places.length - MAX_ACTIVE_PLACES);
  
//   for (const place of placesToRemove) {
//     delete state.places[place.name];
//   }
// }

/**
 * Formats places for prompt injection
 * 
 * Creates a compact, readable string representation of relevant places
 * for inclusion in AI prompts.
 * 
 * @param state - Current story state
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const placeText = formatPlacesForPrompt(state);
 * // Returns: "Old River (river) - eerie - visited 3 times\n..."
 * ```
 */
export function formatPlacesForPrompt(state: StoryState): string {
  const allPlaces = Object.values(state.places);
  
  if (allPlaces.length === 0) {
    return "No specific places established yet.";
  }
  
  return allPlaces
    .sort((a, b) => b.lastVisitedAtPage - a.lastVisitedAtPage) // Sort by most recent visit first
    .map(place => {
      const context = `  Context: ${place.context}`;
      const events = place.eventTags && place.eventTags.length > 0 ? `  Events: ${place.eventTags.join(', ')}` : '';
      const characters = place.knownCharacters && place.knownCharacters.length > 0 ? `  Characters: ${place.knownCharacters.join(', ')}` : '';
      const currentPage = state.page;
      const visitStatus = place.lastVisitedAtPage === currentPage ? ' (CURRENT)' : ` (last visited page ${place.lastVisitedAtPage})`;
      return `• ${place.name} (${place.type}) - ${place.currentMood} - visited ${place.visitCount} times${visitStatus}\n${[context, events, characters].filter(Boolean).join('\n')}`;
    })
    .join('\n');
}

/**
 * Calculates place familiarity score based on visit patterns
 * 
 * This function determines how familiar the MC should be with a place
 * based on visit count, recency, and events that occurred there.
 * 
 * @param place - Place memory to calculate familiarity for
 * @param currentPage - Current story page
 * @returns Familiarity score between 0 and 1
 */
export function calculatePlaceFamiliarity(place: PlaceMemory, currentPage: number): number {
  const { visitCount = 0, eventTags = [] } = place;
  let familiarity = 0;
  
  // Base familiarity from visit count (diminishing returns)
  familiarity += Math.log(visitCount + 1) / Math.log(FAMILIARITY_MAX_VISITS); // Max ~1 at configured visits
  
  // Recency bonus
  const pagesSinceVisit = currentPage - place.lastVisitedAtPage;
  const recencyBonus = Math.max(0, 1 - (pagesSinceVisit / FAMILIARITY_RECENCY_DECAY)); // Decays over configured pages
  familiarity += recencyBonus * FAMILIARITY_RECENCY_WEIGHT;
  
  // Event significance bonus
  const significantEvents = eventTags.filter(tag => 
    tag.includes("betrayal") || 
    tag.includes("death") || 
    tag.includes("discovery") ||
    tag.includes("trauma") ||
    tag.includes("first_meeting")
  ).length;
  familiarity += significantEvents * FAMILIARITY_EVENT_BONUS;
  
  // Clamp between 0 and 1
  return Math.min(1, Math.max(0, familiarity));
}