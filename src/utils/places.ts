import { 
  MAX_PLACE_EVENTS, 
  FAMILIARITY_RECENCY_DECAY,
  FAMILIARITY_RECENCY_WEIGHT,
  FAMILIARITY_EVENT_BONUS,
  FAMILIARITY_MAX_VISITS,
  SIGNIFICANT_EVENT_KEYWORDS,
  FAMILIARITY_MAX_SIGNIFICANT_EVENTS,
  FAMILIARITY_VISIT_WEIGHT,
  MAX_PLACES
} from "../config/story.js";
import type { NewPlace, PlaceConnectionUpdate, PlaceMemory, PlaceUpdate, PlaceUpdates } from "../types/places.js";
import type { PastEvent, StoryScene, StoryState } from "../types/story.js";
import { cleanUpInventory } from "./story.js";
import { slugify } from "./text-processing.js";

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
    knownConnections: [] // will be processed later in `processPlaceUpdates`
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
export function updatePlace(params: {
  existing: PlaceMemory,
  update: PlaceUpdate,
  page: number,
  scene?: StoryScene,
  placeId?: string
  previousPlaceId?: string
}): PlaceMemory {
  const { existing, update, page, scene, placeId, previousPlaceId } = params;
  const updated: PlaceMemory = structuredClone(existing);
  const { weather, mood, placeId: currentPlaceId } = scene ?? {};
  const { familiarityCorrection = 0, updateTraits = [], removeTraits = [], addHints = [], removeHints = [] } = update;
  const { visitCount = 0, keyEvents = [], knownCharacters = [], traits = [], hints = [] } = existing;
  
  // Update basic properties if provided
  if (update.type) updated.type = update.type;
  if (update.context) updated.context = update.context;
  if (update.isRealNameKnown !== undefined) updated.isRealNameKnown = update.isRealNameKnown;

  // Add or remove hints if provided
  if (addHints.length || removeHints.length) {
    updated.hints = [
      ...hints.filter(h => !removeHints.includes(h)),
      ...addHints,
    ];
  }

  // This place is where the MC currently is this page
  const isCurrentPlace = update.placeId === currentPlaceId;

  if (isCurrentPlace) {
    updated.lastWeather = weather;
    updated.lastMood = mood;

    // Only counts as a new "visit" if the MC wasn't already here last page —
    // a continuous stay across pages isn't a fresh visit, but returning
    // after being elsewhere is.
    if (placeId !== previousPlaceId) {
      updated.visitCount = visitCount + 1;
    }

    updated.lastVisitedAtPage = page;
  }

  // Apply keyObjects updates (full replacements, remove which has amount of 0)
  if (update.keyObjects?.length) updated.keyObjects = cleanUpInventory(update.keyObjects);
  
  // Merge event tags with sliding window
  if (update.addKeyEvents) {
    updated.keyEvents = [...keyEvents, ...update.addKeyEvents.map<PastEvent>(e => ({ page, event: e }))].slice(-MAX_PLACE_EVENTS);
  }
  
  // Merge known characters
  if (update.knownCharacters?.length) {
    updated.knownCharacters = [
      ...knownCharacters.filter(c => !update.knownCharacters!.some(u => u.key === c.key)),
      ...update.knownCharacters
    ];
  }
  
  // Update traits if provided
  if (updateTraits.length) {
    updated.traits = [
      ...traits.filter(t => !updateTraits.some(u => u.key === t.key)),
      ...updateTraits
    ];
  }

  // Remove traits
  if (removeTraits.length) {
    updated.traits = [
      ...traits.filter(t => !removeTraits.includes(t.key)),
    ];
  }

  // Deliberate place familiarity change if provided
  if (familiarityCorrection !== 0) {
    updated.familiarity = Math.min(Math.max(updated.familiarity + familiarityCorrection, 0), 1);
  }

  // Re-calculate familiarity last, once visitCount/lastVisitedAtPage/keyEvents
  // all reflect this page's updates
  updated.familiarity = calculatePlaceFamiliarity(updated, page);
  
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
export function processPlaceUpdates(state: StoryState, placeUpdates?: PlaceUpdates, placeConnectionUpdates?: PlaceConnectionUpdate[], scene?: StoryScene, previousPlaceId?: string): void {
  const { newPlaces = [], updatedPlaces = [] } = placeUpdates || {};

  // Early exit: if no updates to process
  if (!newPlaces.length && !updatedPlaces.length && !placeConnectionUpdates?.length) return;
  
  // Add new places into place memory
  if (newPlaces.length) {
    for (const newPlace of newPlaces) {
      const place = createPlace(newPlace, state.page, scene);
      const placeId = slugify(newPlace.placeId);
      state.places[placeId] = place;
    }
  }
  
  // Update existing places
  if (updatedPlaces.length) {
    for (const update of updatedPlaces) {
      const placeId = slugify(update.placeId);
      const existing = state.places[placeId];
      if (existing) {
        state.places[placeId] = updatePlace({
          existing,
          update,
          page: state.page,
          scene,
          placeId,
          previousPlaceId
        });
      }
    }
  }

  // Process relationship updates
  if (placeConnectionUpdates?.length) {
    for (const conUpdate of placeConnectionUpdates) {
      const sourcePlace = state.places[conUpdate.sourceId];
      if (sourcePlace) {
        state.places[conUpdate.sourceId] = updateConnection(sourcePlace, conUpdate, state.page);
      }
    }
  }
}

/**
 * 
 * @param place 
 * @param update 
 * @param currentPage 
 * @returns 
 */
export function updateConnection(place: PlaceMemory, update: PlaceConnectionUpdate, currentPage: number): PlaceMemory {
  const updated: PlaceMemory = structuredClone(place);
  
  // Find existing relationship to target
  const existingIndex = updated.knownConnections.findIndex(r => r.targetId === update.targetId);
  
  if (existingIndex >= 0) {
    // Update existing relationship
    updated.knownConnections[existingIndex] = {
      ...updated.knownConnections[existingIndex],
      ...(update.travelTime ? {travelTime: update.travelTime} : {}),
      ...(update.routeType ? {routeType: update.routeType} : {}),
      ...(update.accessibility ? {accessibility: update.accessibility} : {}),
      ...(update.bidirectional ? {bidirectional: update.bidirectional} : {}),
      ...(update.notes ? {notes: update.notes} : {}),
      updatedAtPage: currentPage,
    };

    // Update obstacles
    const { add: addObstacles = [], remove: removeObstacles = [] } = update.updateObstacles;
    updated.knownConnections[existingIndex].obstacles = [
      ...updated.knownConnections[existingIndex].obstacles.filter(o => !removeObstacles.includes(o)),
      ...addObstacles
    ];
  } else if (updated.knownConnections.length < MAX_PLACES - 1) {
    // Create new relationship
    updated.knownConnections.push({
      targetId: update.targetId,
      travelTime: update.travelTime,
      routeType: update.routeType,
      accessibility: update.accessibility || "open",
      obstacles: update.updateObstacles.add ?? [],
      bidirectional: update.bidirectional ?? true,
      notes: update.notes,
      updatedAtPage: currentPage,
    });
  }
  
  return updated;
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
 * • Old River (river) [CURRENT] - familiarity: 0.8 [ID: old_river]
 *   - Real name: Simatra River (revealed: true)
 *   - Visited 3 times (last visited: page 12, last mood: threatening, last weather: misty)
 *   - Context: narrow river behind the school
 *   - Location: 500 meters south of the school
 *   - Traits:
 *     → Smell: ...
 *   - Key events:
 *     → Page 3: Body discovered
 *     → Page 14: First meeting with Lisa
 *   - Key objects:
 *     → 1x Large Mirror (in the corner of the room, color: black)
 *   - Associated characters:
 *     → Lisa (first met here)
 *     → Tom (saved from drowning here)
 * 
 * • Abandoned Church (building) - familiarity: 0.6 [ID: abandoned_church] [Parent ID: oakhaven_city]
 *   - Real name: Project Lazarus Research Facility (revealed: false)
 *   - Visited 2 times (last visited: page 30)
 *   - Context: abandoned stone church outside town
 *   - Key events:
 *     → Page 24: Hidden tunnel discovered
 *     → Page 30: Cult symbol found
 *   - Associated characters:
 *     → Marcus (first met here)
 *   - Known routes:
 *     → old_river: route-specific details (2 minutes walk, alley, open)
 */
export function formatPlacesForPrompt(places: Record<string, PlaceMemory>, currentPage: number): string {
  const placeEntries = Object.entries(places);
  if (!placeEntries.length) return 'No known places.';

  const sortedEntries = [...placeEntries].sort(([, a], [, b]) => {
    const aCurrent = a.lastVisitedAtPage === currentPage ? 1 : 0;
    const bCurrent = b.lastVisitedAtPage === currentPage ? 1 : 0;

    if (aCurrent !== bCurrent) return bCurrent - aCurrent;

    if (a.lastVisitedAtPage !== b.lastVisitedAtPage) {
      return b.lastVisitedAtPage - a.lastVisitedAtPage;
    }

    return b.familiarity - a.familiarity;
  });

  return sortedEntries.map(([id, place]) => {
    const lines: string[] = [];
    const { type, context, hints, traits, knownName, realName, isRealNameKnown = false, lastVisitedAtPage, visitCount = 1, keyEvents, knownCharacters = [] } = place;
    const currentMarker = lastVisitedAtPage === currentPage ? ' [CURRENT]' : '';
    const placeName = knownName || (isRealNameKnown ? realName : 'Unknown');

    // Main place info and identifier
    const parentMarker = place.parentPlaceId ? ` [Parent ID: ${place.parentPlaceId}]` : '';
    lines.push(`• ${placeName} (${type})${currentMarker} - familiarity: ${place.familiarity.toFixed(1)} [ID: ${id}]${parentMarker}`);

    // Real name and whether it's revealed to the MC (matches jsdoc example format)
    lines.push(`  - Real name: ${realName} (revealed: ${place.isRealNameKnown ? 'true' : 'false'})`);
    lines.push(`  - Visited ${visitCount} time${visitCount > 1 ? 's' : ''} (last visited: page ${place.lastVisitedAtPage}${place.lastMood ? `, last mood: ${place.lastMood}`: ''}${place.lastWeather ? `, last weather: ${place.lastWeather}`: ''})`);
    lines.push(`  - Context: ${context}`);

    if (hints?.length) {
      lines.push(`  - Hints: ${hints.join('; ')}`);
    }

    if (traits?.length) {
      lines.push('  - Traits:');
      traits.forEach(t => {
        lines.push(`    → ${t.key}: ${t.value}`);
      });
    }

    if (keyEvents?.length) {
      lines.push('  - Key events:');
      keyEvents
        .slice(-MAX_PLACE_EVENTS)
        .sort((a, b) => a.page - b.page)
        .forEach(event => {
          lines.push(`    → Page ${event.page}: ${event.event}`);
        });
    }

    const keyObjects = place.keyObjects?.filter(i => i.amount);
    if (keyObjects?.length) {
      lines.push('  - Key objects:');
      keyObjects.forEach(item => {
        // TODO: make DRY (traitEntries)
        const traitEntries = item.traits?.map(t => `${t.key}: ${t.value}`) ?? [];
        const itemInfo = [item.where, ...traitEntries].filter(Boolean).join(', ');
        lines.push(`    → ${item.amount}x ${item.name}${itemInfo ? ` (${itemInfo})` : ''}`);
      });
    }

    if (knownCharacters.length) {
      lines.push('  - Associated characters:');
      knownCharacters.forEach(character => {
        lines.push(`    → ${character.key}: ${character.value}`);
      });
    }

    // if (place.parentPlaceId) {
    //   // Also include explicit parent reference (helpful for nested places)
    //   // Note: parent already appears in header, but keep a separate line for clarity
    //   // to match the jsdoc example style.
    //   // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    //   lines.push(`  - Parent ID: ${place.parentPlaceId}`);
    // }

    if (place.knownConnections?.length) {
      lines.push('  - Known routes:');
      place.knownConnections.forEach(conn => {
        const parts = [conn.travelTime, conn.routeType, conn.accessibility].filter(Boolean);
        const details = parts.length ? ` (${parts.join(', ')})` : '';
        const notes = conn.notes ? ` ${conn.notes}` : '';
        lines.push(`    → ${conn.targetId}:${notes}${details}`);
      });
    }

    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Calculates place familiarity score based on visit patterns
 *
 * Combines three independently-capped components so no single factor
 * saturates familiarity on its own:
 * - Visit count (diminishing returns, capped at FAMILIARITY_VISIT_WEIGHT)
 * - Recency of last visit (capped at FAMILIARITY_RECENCY_WEIGHT, decays
 *   even for well-visited places — a long-abandoned "home base" should
 *   feel less familiar again over time)
 * - Significant past events (capped at FAMILIARITY_MAX_SIGNIFICANT_EVENTS
 *   × FAMILIARITY_EVENT_BONUS, so a couple of major events matter but a
 *   dozen don't matter ten times as much)
 *
 * @param place - Place memory to calculate familiarity for
 * @param currentPage - Current story page
 * @returns Familiarity score between 0 and 1
 *
 * @example
 * ```typescript
 * const familiarity = calculatePlaceFamiliarity(place, state.page);
 * ```
 */
export function calculatePlaceFamiliarity(place: PlaceMemory, currentPage: number): number {
  const { visitCount = 0, keyEvents = [] } = place;

  // Visit-count component — diminishing returns, capped at FAMILIARITY_VISIT_WEIGHT
  const visitScore = Math.min(1, Math.log(visitCount + 1) / Math.log(FAMILIARITY_MAX_VISITS));
  const visitComponent = visitScore * FAMILIARITY_VISIT_WEIGHT;

  // Recency component — decays back toward 0 the longer the place goes
  // unvisited, regardless of how familiar it once was
  const pagesSinceVisit = Math.max(0, currentPage - place.lastVisitedAtPage);
  const recencyScore = Math.max(0, 1 - pagesSinceVisit / FAMILIARITY_RECENCY_DECAY);
  const recencyComponent = recencyScore * FAMILIARITY_RECENCY_WEIGHT;

  // Event-significance component — narratively significant moments that
  // happened here, capped so a handful of major events doesn't
  // single-handedly saturate familiarity
  const significantEvents = keyEvents.filter(e => {
    const text = e.event.toLowerCase();
    return SIGNIFICANT_EVENT_KEYWORDS.some(keyword => text.includes(keyword));
  }).length;
  const eventComponent = Math.min(significantEvents, FAMILIARITY_MAX_SIGNIFICANT_EVENTS) * FAMILIARITY_EVENT_BONUS;

  return Math.min(1, Math.max(0, visitComponent + recencyComponent + eventComponent));
}