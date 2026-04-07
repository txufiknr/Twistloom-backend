import { 
  MAX_PLACE_MOOD_HISTORY, 
  MAX_PLACE_EVENT_TAGS, 
  // MAX_KNOWN_CHARACTERS, 
  // MAX_ACTIVE_PLACES, 
  INITIAL_PLACE_FAMILIARITY,
  PLACE_FAMILIARITY_WEIGHT,
  FAMILIARITY_RECENCY_DECAY,
  FAMILIARITY_RECENCY_WEIGHT,
  FAMILIARITY_EVENT_BONUS,
  FAMILIARITY_MAX_VISITS,
  PLACE_SELECTION_RECENCY_DECAY,
  PLACE_MAX_CHARACTERS_SCORE,
  PLACE_RANDOMNESS_BONUS,
  PLACE_WEIGHT_FAMILIARITY,
  PLACE_WEIGHT_RECENCY,
  PLACE_WEIGHT_TRAUMA,
  PLACE_WEIGHT_CHARACTERS,
  TRAUMA_SCORE_DIRECT_MATCH,
  TRAUMA_SCORE_MOOD_MATCH,
  TRAUMA_SCORE_LOCATION_MATCH,
  HIGH_DIFFICULTY_TOP_PLACE_PROBABILITY,
  LOW_DIFFICULTY_NEW_PLACE_PROBABILITY,
  LOW_DIFFICULTY_MAX_PLACES,
  MEDIUM_DIFFICULTY_WEIGHTS
} from "../config/story.js";
import type { PlaceMemory, PlaceUpdate, PlaceMood, PlaceUpdates } from "../types/places.js";
import type { StoryState } from "../types/story.js";
import { filterTruthyAndDedupe } from "./parser.js";

/**
 * Creates a new place with default values
 * 
 * @param id - Unique identifier for the place
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
  // placeId: string,
  name: string,
  type: PlaceMemory['type'],
  context: string,
  currentPage: number,
  currentMood: PlaceMood = "neutral"
): PlaceMemory {
  return {
    // placeId,
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
  
  // Merge mood history with sliding window
  if (update.moodHistory) {
    updated.moodHistory = [...existing.moodHistory, ...update.moodHistory].slice(-MAX_PLACE_MOOD_HISTORY);
  }
  
  // Merge event tags with sliding window
  if (update.eventTags) {
    updated.eventTags = [...existing.eventTags, ...update.eventTags].slice(-MAX_PLACE_EVENT_TAGS);
  }
  
  // Merge known characters
  if (update.knownCharacters) {
    updated.knownCharacters = filterTruthyAndDedupe([...existing.knownCharacters, ...update.knownCharacters]);
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
      const events = place.eventTags.length > 0 ? `  Events: ${place.eventTags.join(', ')}` : '';
      const characters = place.knownCharacters.length > 0 ? `  Characters: ${place.knownCharacters.join(', ')}` : '';
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
  let familiarity = 0;
  
  // Base familiarity from visit count (diminishing returns)
  familiarity += Math.log(place.visitCount + 1) / Math.log(FAMILIARITY_MAX_VISITS); // Max ~1 at configured visits
  
  // Recency bonus
  const pagesSinceVisit = currentPage - place.lastVisitedAtPage;
  const recencyBonus = Math.max(0, 1 - (pagesSinceVisit / FAMILIARITY_RECENCY_DECAY)); // Decays over configured pages
  familiarity += recencyBonus * FAMILIARITY_RECENCY_WEIGHT;
  
  // Event significance bonus
  const significantEvents = place.eventTags.filter(tag => 
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

/**
 * Selects the most appropriate place for the next story scene
 * 
 * This function implements sophisticated place selection logic that balances
 * familiarity, recency, narrative relevance, and psychological manipulation.
 * 
 * @param state - Current story state
 * @param traumaRelevance - Optional trauma tags to prioritize matching places
 * @returns Selected place or null if no suitable place exists
 * 
 * @example
 * ```typescript
 * const place = selectNextPlace(state, ["betrayal", "abandonment"]);
 * // Returns a place that echoes the specified trauma themes
 * ```
 */
export function selectNextPlace(state: StoryState, traumaRelevance: string[] = []): PlaceMemory | null {
  const places = Object.values(state.places);
  
  if (places.length === 0) return null;
  
  // Calculate scores for each place
  const scoredPlaces = places.map(place => ({
    place,
    score: calculatePlaceScore(place, state, traumaRelevance)
  }));
  
  // Sort by score (highest first)
  scoredPlaces.sort((a, b) => b.score - a.score);
  
  // Apply selection strategy
  return applyPlaceSelectionStrategy(scoredPlaces, state);
}

/**
 * Calculates a score for place selection based on multiple factors
 * 
 * This function implements the scoring algorithm that balances
 * familiarity, recency, trauma relevance, and randomness.
 * 
 * @param place - Place to score
 * @param state - Current story state
 * @param traumaRelevance - Trauma tags to prioritize
 * @returns Score between 0 and 1 (higher is better)
 */
function calculatePlaceScore(place: PlaceMemory, state: StoryState, traumaRelevance: string[]): number {
  let score = 0;
  
  // 1. Familiarity (40% weight) - Places MC knows well feel more real
  score += place.familiarity * PLACE_WEIGHT_FAMILIARITY;
  
  // 2. Recency (20% weight) - Recently visited places feel more immediate
  const pagesSinceVisit = state.page - place.lastVisitedAtPage;
  const recencyScore = Math.max(0, 1 - (pagesSinceVisit / PLACE_SELECTION_RECENCY_DECAY)); // Decays over configured pages
  score += recencyScore * PLACE_WEIGHT_RECENCY;
  
  // 3. Trauma Relevance (30% weight) - Places that echo trauma are psychologically powerful
  const traumaScore = calculateTraumaRelevance(place, traumaRelevance);
  score += traumaScore * PLACE_WEIGHT_TRAUMA;
  
  // 4. Character Connections (10% weight) - Places with known characters enable interactions
  const characterScore = Math.min(1, place.knownCharacters.length / PLACE_MAX_CHARACTERS_SCORE);
  score += characterScore * PLACE_WEIGHT_CHARACTERS;
  
  // 5. Randomness (5% bonus) - Prevents predictable patterns
  score += Math.random() * PLACE_RANDOMNESS_BONUS;
  
  return Math.min(1, score);
}

/**
 * Calculates how relevant a place is to specific trauma themes
 * 
 * @param place - Place to evaluate
 * @param traumaRelevance - Trauma tags to match against
 * @returns Trauma relevance score between 0 and 1
 */
function calculateTraumaRelevance(place: PlaceMemory, traumaRelevance: string[]): number {
  if (traumaRelevance.length === 0) return 0;
  
  let relevanceScore = 0;
  
  for (const traumaTag of traumaRelevance) {
    // Direct event tag matches
    if (place.eventTags.includes(traumaTag)) {
      relevanceScore += TRAUMA_SCORE_DIRECT_MATCH;
    }
    
    // Mood matches trauma type
    if (traumaTag.includes("betrayal") && place.currentMood === "threatening") {
      relevanceScore += TRAUMA_SCORE_MOOD_MATCH;
    }
    if (traumaTag.includes("loss") && place.currentMood === "contaminated") {
      relevanceScore += TRAUMA_SCORE_MOOD_MATCH;
    }
    if (traumaTag.includes("fear") && (place.currentMood === "eerie" || place.currentMood === "threatening")) {
      relevanceScore += TRAUMA_SCORE_MOOD_MATCH;
    }
    
    // Location hints match trauma themes
    if (place.locationHint) {
      const hint = place.locationHint.toLowerCase();
      if (traumaTag.includes("abandon") && hint.includes("abandon")) {
        relevanceScore += TRAUMA_SCORE_LOCATION_MATCH;
      }
      if (traumaTag.includes("death") && (hint.includes("grave") || hint.includes("memorial"))) {
        relevanceScore += TRAUMA_SCORE_LOCATION_MATCH;
      }
    }
  }
  
  return Math.min(1, relevanceScore);
}

/**
 * Applies the final selection strategy to scored places
 * 
 * This function implements the selection logic that determines
 * which place should be used, considering psychological manipulation.
 * 
 * @param scoredPlaces - Array of places with their scores
 * @param state - Current story state
 * @returns Selected place or null
 */
function applyPlaceSelectionStrategy(scoredPlaces: Array<{place: PlaceMemory, score: number}>, state: StoryState): PlaceMemory | null {
  if (scoredPlaces.length === 0) return null;
  
  const { difficulty, psychologicalProfile } = state;
  const { archetype, stability, manipulationAffinity } = psychologicalProfile;
  
  // Apply psychological profile modifiers to base difficulty strategies
  return applyPsychologicalModifiers(scoredPlaces, difficulty, archetype, stability, manipulationAffinity);
}

/**
 * Applies psychological profile-based modifiers to place selection
 * 
 * This function enhances the base difficulty strategies with psychological
 * profile considerations for more targeted narrative manipulation.
 * 
 * @param scoredPlaces - Array of places with their scores
 * @param difficulty - Base difficulty level
 * @param archetype - MC's behavioral archetype
 * @param stability - MC's mental stability
 * @param manipulationAffinity - MC's psychological vulnerability
 * @returns Selected place or null
 */
function applyPsychologicalModifiers(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string,
  archetype: string,
  stability: string,
  manipulationAffinity: string
): PlaceMemory | null {
  
  // ARCHETYPE-BASED MODIFICATIONS
  switch (archetype) {
    case "the_explorer":
      // Explorers prefer new places but can be drawn to familiar ones at high stability
      return applyExplorerStrategy(scoredPlaces, difficulty, stability);
      
    case "the_paranoid":
      // Paranoid characters prefer familiar, "safe" places
      return applyParanoidStrategy(scoredPlaces, difficulty);
      
    case "the_avoider":
      // Avoiders prefer places they haven't had negative experiences in
      return applyAvoiderStrategy(scoredPlaces, difficulty);
      
    case "the_risk_taker":
      // Risk takers are drawn to places with danger/threat history
      return applyRiskTakerStrategy(scoredPlaces, difficulty);
      
    case "the_guilty":
      // Guilty characters are drawn to places connected to their past mistakes
      return applyGuiltyStrategy(scoredPlaces, difficulty, manipulationAffinity);
      
    case "the_denier":
      // Deniers prefer places that don't challenge their worldview
      return applyDenierStrategy(scoredPlaces, difficulty, stability);
  }
  
  // Default: apply base difficulty strategy
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Explorer strategy: Balances novelty with familiarity based on stability
 */
function applyExplorerStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string,
  stability: string
): PlaceMemory | null {
  if (stability === "stable") {
    // Stable explorers are more open to new places
    return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
  } else {
    // Unstable explorers retreat to familiar places
    const familiarPlaces = scoredPlaces.filter(sp => sp.place.familiarity > 0.3);
    if (familiarPlaces.length > 0) {
      return applyBaseDifficultyStrategy(familiarPlaces, difficulty);
    }
  }
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Paranoid strategy: Strongly prefers familiar places
 */
function applyParanoidStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string
): PlaceMemory | null {
  // Prioritize high familiarity places
  const familiarPlaces = scoredPlaces
    .map(sp => ({ ...sp, score: sp.score + (sp.place.familiarity * 0.3) }))
    .sort((a, b) => b.score - a.score);
  
  // 80% chance of most familiar place
  if (Math.random() < 0.8 && familiarPlaces.length > 0) {
    return familiarPlaces[0].place;
  }
  
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Avoider strategy: Avoids places with negative event history
 */
function applyAvoiderStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string
): PlaceMemory | null {
  // Filter out places with negative events
  const safePlaces = scoredPlaces.filter(sp => 
    !sp.place.eventTags.some(tag => 
      tag.includes("death") || 
      tag.includes("betrayal") || 
      tag.includes("abandon") ||
      tag.includes("trauma")
    )
  );
  
  if (safePlaces.length > 0) {
    return applyBaseDifficultyStrategy(safePlaces, difficulty);
  }
  
  // If no safe places, fall back to least threatening
  const leastThreatening = scoredPlaces
    .filter(sp => sp.place.currentMood !== "threatening" && sp.place.currentMood !== "contaminated")
    .sort((a, b) => b.score - a.score);
    
  if (leastThreatening.length > 0) {
    return leastThreatening[0].place;
  }
  
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Risk taker strategy: Drawn to dangerous/threatening places
 */
function applyRiskTakerStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string
): PlaceMemory | null {
  // Boost scores for dangerous places
  const dangerousPlaces = scoredPlaces.map(sp => {
    let boost = 0;
    if (sp.place.currentMood === "threatening" || sp.place.currentMood === "eerie") {
      boost += 0.2;
    }
    if (sp.place.eventTags.some(tag => tag.includes("danger") || tag.includes("death"))) {
      boost += 0.15;
    }
    return { ...sp, score: sp.score + boost };
  }).sort((a, b) => b.score - a.score);
  
  return applyBaseDifficultyStrategy(dangerousPlaces, difficulty);
}

/**
 * Guilty strategy: Drawn to places connected to past mistakes
 */
function applyGuiltyStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string,
  manipulationAffinity: string
): PlaceMemory | null {
  if (manipulationAffinity === "guilt") {
    // Boost places with guilt-related events
    const guiltPlaces = scoredPlaces.map(sp => {
      let boost = 0;
      if (sp.place.eventTags.some(tag => 
        tag.includes("betrayal") || 
        tag.includes("abandon") || 
        tag.includes("failure")
      )) {
        boost += 0.25;
      }
      if (sp.place.currentMood === "contaminated") {
        boost += 0.15;
      }
      return { ...sp, score: sp.score + boost };
    }).sort((a, b) => b.score - a.score);
    
    return applyBaseDifficultyStrategy(guiltPlaces, difficulty);
  }
  
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Denier strategy: Prefers places that don't challenge their worldview
 */
function applyDenierStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string,
  stability: string
): PlaceMemory | null {
  if (stability === "cracking" || stability === "unstable") {
    // Unstable deniers avoid places that might reveal truth
    const comfortablePlaces = scoredPlaces.filter(sp => 
      sp.place.currentMood === "safe" || 
      sp.place.currentMood === "familiar" ||
      sp.place.currentMood === "neutral"
    );
    
    if (comfortablePlaces.length > 0) {
      return applyBaseDifficultyStrategy(comfortablePlaces, difficulty);
    }
  }
  
  return applyBaseDifficultyStrategy(scoredPlaces, difficulty);
}

/**
 * Base difficulty strategy without psychological modifications
 */
function applyBaseDifficultyStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string
): PlaceMemory | null {
  if (scoredPlaces.length === 0) return null;
  
  // HIGH DIFFICULTY: More predictable place patterns for psychological impact
  if (difficulty === "high" || difficulty === "nightmare") {
    // 70% chance of highest scoring place, 30% of second highest
    const topPlace = scoredPlaces[0];
    const secondPlace = scoredPlaces[1];
    
    if (Math.random() < HIGH_DIFFICULTY_TOP_PLACE_PROBABILITY || !secondPlace) {
      return topPlace.place;
    } else {
      return secondPlace.place;
    }
  }
  
  // MEDIUM DIFFICULTY: Balanced between familiarity and variety
  if (difficulty === "medium") {
    // Weighted random selection favoring top 3 places
    const topThree = scoredPlaces.slice(0, 3);
    const weights = MEDIUM_DIFFICULTY_WEIGHTS; // Configured weights
    
    const random = Math.random();
    let cumulative = 0;
    
    for (let i = 0; i < topThree.length; i++) {
      cumulative += weights[i];
      if (random < cumulative) {
        return topThree[i].place;
      }
    }
    
    return topThree[0].place; // Fallback
  }
  
  // LOW DIFFICULTY: More variety and exploration
  if (difficulty === "low") {
    // 40% chance of new place (if available), otherwise random from top 5
    if (Math.random() < LOW_DIFFICULTY_NEW_PLACE_PROBABILITY && scoredPlaces.length < LOW_DIFFICULTY_MAX_PLACES) {
      return null; // Signal to create new place
    }
    
    const topFive = scoredPlaces.slice(0, LOW_DIFFICULTY_MAX_PLACES);
    const randomIndex = Math.floor(Math.random() * topFive.length);
    return topFive[randomIndex].place;
  }
  
  // Default: return highest scoring place
  return scoredPlaces[0].place;
}

/**
 * Gets place suggestions for AI prompt context
 * 
 * This function provides the AI with recommended places for the next scene,
 * helping guide place selection while maintaining creative freedom.
 * 
 * @param state - Current story state
 * @param traumaRelevance - Optional trauma tags to prioritize
 * @returns Formatted string of place suggestions
 */
export function getPlaceSuggestions(state: StoryState, traumaRelevance: string[] = []): string {
  const selectedPlace = selectNextPlace(state, traumaRelevance);
  
  if (!selectedPlace) {
    return "Consider introducing a new meaningful location for this scene.";
  }
  
  const suggestions = [`PRIMARY SUGGESTION: ${selectedPlace.name} (${selectedPlace.type}) - ${selectedPlace.context}`];
  
  // Add alternative suggestions
  const alternatives = Object.values(state.places)
    .filter(p => p.name !== selectedPlace.name)
    .slice(0, 2);
  
  if (alternatives.length > 0) {
    suggestions.push("ALTERNATIVES:");
    alternatives.forEach(place => {
      suggestions.push(`- ${place.name} (${place.type}) - ${place.context}`);
    });
  }
  
  return suggestions.join('\n');
}
