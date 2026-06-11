import { 
  MAX_PLACE_EVENTS, 
  FAMILIARITY_RECENCY_DECAY,
  FAMILIARITY_RECENCY_WEIGHT,
  FAMILIARITY_EVENT_BONUS,
  FAMILIARITY_MAX_VISITS} from "../config/story.js";
import type { NewPlace, PlaceMemory, PlaceUpdate, PlaceUpdates } from "../types/places.js";
import type { PastEvent, StoryScene, StoryState } from "../types/story.js";
import { cleanUpInventory } from "./story.js";

/**
 * Creates a new place with default values
 * 
 * @param name - Place name as it appears in narrative
 * @param type - Type of place for categorization
 * @param context - Short human-readable description
 * @param currentPage - Current page number for tracking
 * @returns New place memory structure
 * 
 * @example
 * ```typescript
 * const place = createPlace("old_river", "Old River", "river", "narrow river behind the school", 5, "eerie");
 * ```
 */
export function createPlace(params: NewPlace, currentPage: number, scene?: StoryScene): PlaceMemory {
  return {
    ...params,
    visitCount: 1,
    lastVisitedAtPage: currentPage,
    keyEvents: params.keyEvents ? params.keyEvents.map<PastEvent>(e => ({ page: currentPage, event: e })) : undefined,
    lastWeather: scene?.weather,
    lastMood: scene?.mood,
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
 * });
 * ```
 */
export function updatePlace(existing: PlaceMemory, update: PlaceUpdate, page: number, scene?: StoryScene): PlaceMemory {
  const updated = { ...existing };
  
  // Update basic properties if provided
  if (update.name) updated.name = update.name;
  if (update.type) updated.type = update.type;
  if (update.context) updated.context = update.context;
  if (update.locationHint) updated.locationHint = update.locationHint;
  if (update.familiarity !== undefined) updated.familiarity = update.familiarity;
  if (update.visitCount !== undefined) updated.visitCount = update.visitCount;
  if (update.lastVisitedAtPage !== undefined) updated.lastVisitedAtPage = update.lastVisitedAtPage;
  if (update.name === scene?.place) {
    updated.lastWeather = scene?.weather;
    updated.lastMood = scene?.mood;
  }

  const { keyEvents = [], knownCharacters = {} } = existing;

  // Apply keyObjects updates (full replacements, remove which has amount of 0)
  if (update.keyObjects?.length) updated.keyObjects = cleanUpInventory(update.keyObjects);
  
  // Merge event tags with sliding window
  if (update.addKeyEvents) {
    updated.keyEvents = [...keyEvents, ...update.addKeyEvents.map<PastEvent>(e => ({ page, event: e }))].slice(-MAX_PLACE_EVENTS);
  }
  
  // Merge known characters
  if (update.knownCharacters) {
    updated.knownCharacters = {
      ...knownCharacters,
      ...update.knownCharacters
    };
  }
  
  // Update traits if provided
  if (update.traits) {
    updated.traits = {...existing.traits, ...update.traits};
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
export function processPlaceUpdates(state: StoryState, placeUpdates?: PlaceUpdates, scene?: StoryScene): void {
  const { newPlaces = [], updatedPlaces = [] } = placeUpdates || {};

  // Early exit: if no updates to process
  if (!newPlaces.length && !updatedPlaces.length) return;
  
  // Add new places into place memory
  for (const newPlace of newPlaces) {
    const place = createPlace(newPlace, state.page, scene);
    state.places[place.name] = place;
  }
  
  // Update existing places
  for (const update of updatedPlaces) {
    if (!update.name) continue;
    const existing = state.places[update.name];
    if (existing) {
      state.places[update.name] = updatePlace(existing, update, state.page, scene);
    }
  }
}

/**
 * Formats places for prompt injection with comprehensive narrative information
 * 
 * Creates a rich, detailed string representation of places including context,
 * location hint, key events, key objects, traits, and associated characters
 * for inclusion in AI prompts.
 * 
 * Focuses on narrative continuity rather than atmospheric detail.
 * Prioritizes:
 * - Place identity
 * - Familiarity
 * - Recency
 * - Important events
 * - Character associations
 *
 * @param state - Current story state
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const placeText = formatPlacesForPrompt(state);
 * ```
 * 
 * • Old River (river) [CURRENT] - familiarity: 0.8
 *   - Visited 3 times (last visited: page 12, last mood: threatening, last weather: misty)
 *   - Context: narrow river behind the school
 *   - Location: 500 meters south of the school
 *   - Traits:
 *     • Smell: ...
 *   - Key events:
 *     • Page 3: Body discovered
 *     • Page 14: First meeting with Lisa
 *   - Key objects:
 *     • 1x Large Mirror (in the corner of the room)
 *       → traits: color: black
 *   - Associated characters:
 *     • Lisa (first met here)
 *     • Tom (saved from drowning here)
 * 
 * • Abandoned Church (building) [CURRENT] - familiarity: 0.6
 *   - Visited 2 times (last visited: page 30)
 *   - Context: abandoned stone church outside town
 *   - Key events:
 *     • Page 24: Hidden tunnel discovered
 *     • Page 30: Cult symbol found
 *   - Associated characters:
 *     • Marcus (first met here)
 */
export function formatPlacesForPrompt(
  places: Record<string, PlaceMemory>,
  currentPage: number,
): string {
  const placeArray = Object.values(places);
  if (!placeArray.length) return 'No known places.';

  const sortedPlaces = [...placeArray].sort((a, b) => {
    const aCurrent = a.lastVisitedAtPage === currentPage ? 1 : 0;
    const bCurrent = b.lastVisitedAtPage === currentPage ? 1 : 0;

    if (aCurrent !== bCurrent) return bCurrent - aCurrent;

    if (a.lastVisitedAtPage !== b.lastVisitedAtPage) {
      return b.lastVisitedAtPage - a.lastVisitedAtPage;
    }

    return b.familiarity - a.familiarity;
  });

  return sortedPlaces.map(place => {
    const lines: string[] = [];
    const currentMarker = place.lastVisitedAtPage === currentPage ? ' [CURRENT]' : '';

    lines.push(`• ${place.name} (${place.type})${currentMarker} - familiarity: ${place.familiarity.toFixed(1)}`);
    lines.push(`  - Visited ${place.visitCount ?? 1} time${(place.visitCount ?? 1) > 1 ? 's' : ''} (last visited: page ${place.lastVisitedAtPage}${place.lastMood ? `, last mood: ${place.lastMood}`: ''}${place.lastWeather ? `, last weather: ${place.lastWeather}`: ''})`);
    lines.push(`  - Context: ${place.context}`);

    if (place.locationHint) {
      lines.push(`  - Location: ${place.locationHint}`);
    }

    const traits = Object.entries(place.traits ?? {});
    if (traits.length) {
      lines.push('  - Traits:');
      traits.forEach(([traitName, traitValue]) => {
        lines.push(`    • ${traitName}: ${traitValue}`);
      });
    }

    if (place.keyEvents?.length) {
      lines.push('  - Key events:');
      place.keyEvents
        .slice(-MAX_PLACE_EVENTS)
        .sort((a, b) => a.page - b.page)
        .forEach(event => {
          lines.push(`    • Page ${event.page}: ${event.event}`);
        });
    }

    const keyObjects = place.keyObjects?.filter(i => i.amount);
    if (keyObjects?.length) {
      lines.push('  - Key objects:');
      keyObjects.forEach(item => {
        lines.push(`    • ${item.amount}x ${item.name} (${item.where})`);
        if (item.traits && Object.keys(item.traits).length > 0) {
          const traitEntries = Object.entries(item.traits).map(([key, value]) => `${key}: ${value}`);
          lines.push(`      → traits: ${traitEntries.join(', ')}`);
        }
      });
    }

    const characters = Object.entries(place.knownCharacters ?? {});
    if (characters.length) {
      lines.push('  - Associated characters:');
      characters.sort(([a], [b]) => a.localeCompare(b)).forEach(([name, context]) => {
        lines.push(`    • ${name}${context ? ` (${context})` : ''}`);
      });
    }

    return lines.join('\n');
  }).join('\n\n');
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
  const { visitCount = 0, keyEvents = [] } = place;
  let familiarity = 0;
  
  // Base familiarity from visit count (diminishing returns)
  familiarity += Math.log(visitCount + 1) / Math.log(FAMILIARITY_MAX_VISITS); // Max ~1 at configured visits
  
  // Recency bonus
  const pagesSinceVisit = currentPage - place.lastVisitedAtPage;
  const recencyBonus = Math.max(0, 1 - (pagesSinceVisit / FAMILIARITY_RECENCY_DECAY)); // Decays over configured pages
  familiarity += recencyBonus * FAMILIARITY_RECENCY_WEIGHT;
  
  // Event significance bonus
  const significantEvents = keyEvents.filter(e => 
    e.event.includes("betray") || 
    e.event.includes("death") || 
    e.event.includes("discover") ||
    e.event.includes("trauma") ||
    e.event.includes("meet")
  ).length;
  familiarity += significantEvents * FAMILIARITY_EVENT_BONUS;
  
  // Clamp between 0 and 1
  return Math.min(1, Math.max(0, familiarity));
}