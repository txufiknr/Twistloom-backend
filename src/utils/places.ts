import { 
  MAX_PLACE_MOOD_HISTORY, 
  MAX_PLACE_EVENTS, 
  FAMILIARITY_RECENCY_DECAY,
  FAMILIARITY_RECENCY_WEIGHT,
  FAMILIARITY_EVENT_BONUS,
  FAMILIARITY_MAX_VISITS} from "../config/story.js";
import type { PlaceMemory, PlaceUpdate, PlaceUpdates, NewPlace } from "../types/places.js";
import type { StoryState } from "../types/story.js";

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
export function createPlace(params: NewPlace, currentPage: number): PlaceMemory {
  return {
    ...params,
    visitCount: 1,
    lastVisitedAtPage: currentPage,
    moodHistory: params.currentMood ? [params.currentMood] : [],
  } satisfies PlaceMemory;
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
 *   events: ["Character A betray MC"],
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

  const {
    moodHistory = [],
    events = [],
    knownCharacters = {}
  } = existing;
  
  // Merge mood history with sliding window
  if (update.moodHistory) {
    updated.moodHistory = [...moodHistory, ...update.moodHistory].slice(-MAX_PLACE_MOOD_HISTORY);
  }
  
  // Merge event tags with sliding window
  if (update.events) {
    updated.events = [...events, ...update.events].slice(-MAX_PLACE_EVENTS);
  }
  
  // Merge known characters (Record<string, { page: number, context: string }>)
  if (update.knownCharacters) {
    updated.knownCharacters = {
      ...knownCharacters,
      ...update.knownCharacters,
    };
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
  
  // Add new places into place memory
  for (const newPlace of newPlaces) {
    const place = createPlace(newPlace, state.page);
    state.places[place.name] = place;
  }
  
  // Update existing places
  for (const update of updatedPlaces) {
    const existing = state.places[update.name];
    if (existing) {
      state.places[update.name] = updatePlace(existing, update);
    }
  }
}

/**
 * Formats places for prompt injection with comprehensive narrative information
 * 
 * Creates a rich, detailed string representation of places including weather,
 * sensory details, character history, events, and atmospheric information
 * for inclusion in AI prompts.
 * 
 * @param state - Current story state
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const placeText = formatPlacesForPrompt(state);
 * // Output example:
 * // · Old River (river) - eerie, rainy - visited 3 times (last visited page 12) [familiarity: 0.8]
 * //   Context: narrow river behind the school
 * //   Location: 500 meters behind the school (south)
 * //   Sensory: cold water rushing, distant thunder, damp earth smell
 * //   Mood history: safe -> eerie -> threatening
 * //   Events: discovered body, first meeting with Lisa
 * //   Characters: Lisa (page 15: first meeting here), Tom (page 8: saved from drowning)
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
      const details = [];
      
      // Basic context
      details.push(`  Context: ${place.context}`);
      
      // Location hint if available
      if (place.locationHint) {
        details.push(`  Location: ${place.locationHint}`);
      }
      
      // Sensory details (combine all available senses)
      const sensoryDetails = [];
      if (place.sensoryDetails) {
        if (place.sensoryDetails.sound) sensoryDetails.push(place.sensoryDetails.sound);
        if (place.sensoryDetails.visual) sensoryDetails.push(place.sensoryDetails.visual);
        if (place.sensoryDetails.feeling) sensoryDetails.push(place.sensoryDetails.feeling);
        if (place.sensoryDetails.smell) sensoryDetails.push(place.sensoryDetails.smell);
      }
      if (sensoryDetails.length > 0) {
        details.push(`  Sensory: ${sensoryDetails.join(', ')}`);
      }
      
      // Mood history for atmospheric development
      if (place.moodHistory && place.moodHistory.length > 0) {
        details.push(`  Mood history: ${place.moodHistory.join(' -> ')}`);
      }
      
      // Events that occurred at this place
      if (place.events && place.events.length > 0) {
        details.push(`  Events: ${place.events.join(', ')}`);
      }
      
      // Known characters with contextual history
      const characterEntries = Object.entries(place.knownCharacters || {});
      if (characterEntries.length > 0) {
        const characters = characterEntries
          .map(([name, info]) => `${name} (page ${info.page}${info.context ? ': ' + info.context : ''})`)
          .join(', ');
        details.push(`  Characters: ${characters}`);
      }
      
      // Build the main line with comprehensive info
      const currentPage = state.page;
      const visitStatus = place.lastVisitedAtPage === currentPage ? ' (CURRENT)' : ` (last visited page ${place.lastVisitedAtPage})`;
      const familiarityInfo = place.familiarity ? ` [familiarity: ${place.familiarity.toFixed(1)}]` : '';
      
      // Combine mood and weather in the main line for atmosphere
      const atmosphere = [place.currentMood, place.weather].filter(Boolean).join(', ');
      
      return `· ${place.name} (${place.type}) - ${atmosphere} - visited ${place.visitCount} times${visitStatus}${familiarityInfo}\n${details.join('\n')}`;
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
  const { visitCount = 0, events = [] } = place;
  let familiarity = 0;
  
  // Base familiarity from visit count (diminishing returns)
  familiarity += Math.log(visitCount + 1) / Math.log(FAMILIARITY_MAX_VISITS); // Max ~1 at configured visits
  
  // Recency bonus
  const pagesSinceVisit = currentPage - place.lastVisitedAtPage;
  const recencyBonus = Math.max(0, 1 - (pagesSinceVisit / FAMILIARITY_RECENCY_DECAY)); // Decays over configured pages
  familiarity += recencyBonus * FAMILIARITY_RECENCY_WEIGHT;
  
  // Event significance bonus
  const significantEvents = events.filter(e => 
    e.includes("betray") || 
    e.includes("death") || 
    e.includes("discover") ||
    e.includes("trauma") ||
    e.includes("meet")
  ).length;
  familiarity += significantEvents * FAMILIARITY_EVENT_BONUS;
  
  // Clamp between 0 and 1
  return Math.min(1, Math.max(0, familiarity));
}