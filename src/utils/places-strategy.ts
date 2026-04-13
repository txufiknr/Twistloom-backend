import { 
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
import type { PlaceMemory } from "../types/places.js";
import type { StoryState } from "../types/story.js";

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
  const { knownCharacters = [] } = place;
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
  const characterScore = Math.min(1, knownCharacters.length / PLACE_MAX_CHARACTERS_SCORE);
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
    if (place.eventTags && place.eventTags.includes(traumaTag)) {
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
 * Avoider strategy: Avoids places with negative event history and threatening atmospheres
 * 
 * This strategy prioritizes places that feel safe and familiar to the avoider personality type.
 * It considers both historical events and emotional atmosphere to create a comprehensive
 * safety assessment for place selection.
 * 
 * Safety criteria (in order of priority):
 * 1. No traumatic event history (death, betrayal, abandonment, trauma)
 * 2. Non-threatening current atmosphere (avoid threatening, contaminated, eerie)
 * 3. Positive mood history (prefer safe, familiar, sacred over negative moods)
 * 4. Higher familiarity scores for known safe locations
 * 
 * @param scoredPlaces - Array of places with their base scores
 * @param difficulty - Story difficulty level affecting fallback behavior
 * @returns Most suitable safe place for avoider personality, or fallback if none available
 */
function applyAvoiderStrategy(
  scoredPlaces: Array<{place: PlaceMemory, score: number}>, 
  difficulty: string
): PlaceMemory | null {
  // First filter: Remove places with traumatic event history
  const traumaFreePlaces = scoredPlaces.filter(sp => {
    const { eventTags = [] } = sp.place;
    return !eventTags.some(tag => 
      tag.includes("death") || 
      tag.includes("betrayal") || 
      tag.includes("abandon") ||
      tag.includes("trauma")
    )
  });
  
  // Second filter: Remove places with threatening current atmosphere
  const atmosphereSafePlaces = traumaFreePlaces.filter(sp => {
    const { currentMood } = sp.place;
    // Avoid clearly threatening moods
    return currentMood !== "threatening" && 
           currentMood !== "contaminated" && 
           currentMood !== "eerie";
  });
  
  // Third filter: Score places based on mood history and familiarity
  const moodScoredPlaces = atmosphereSafePlaces.map(sp => {
    let moodScore = 0;
    const { moodHistory = [] } = sp.place;
    
    // Analyze mood history for safety patterns
    if (moodHistory.length > 0) {
      // Count positive vs negative moods in history
      const positiveMoods = moodHistory.filter(mood => 
        mood === "safe" || mood === "familiar" || mood === "sacred" || mood === "neutral"
      ).length;
      
      const negativeMoods = moodHistory.filter(mood => 
        mood === "threatening" || mood === "contaminated" || mood === "eerie" || mood === "distorted"
      ).length;
      
      // Score based on mood history balance
      if (negativeMoods === 0) {
        moodScore += 20; // Bonus for consistently positive history
      } else if (positiveMoods > negativeMoods) {
        moodScore += 10; // Partial bonus for mostly positive
      } else if (negativeMoods > positiveMoods) {
        moodScore -= 10; // Penalty for mostly negative
      }
      
      // Extra bonus for recent safe moods
      const recentMoods = moodHistory.slice(-3);
      if (recentMoods.every(mood => mood === "safe" || mood === "familiar" || mood === "neutral")) {
        moodScore += 15;
      }
    }
    
    // Current mood bonus/penalty
    const { currentMood } = sp.place;
    switch (currentMood) {
      case "safe": moodScore += 25; break;
      case "familiar": moodScore += 20; break;
      case "sacred": moodScore += 15; break;
      case "neutral": moodScore += 10; break;
      case "unfamiliar": moodScore += 5; break;
      case "distorted": moodScore -= 5; break;
      case "eerie": moodScore -= 10; break;
      case "threatening": moodScore -= 15; break;
      case "contaminated": moodScore -= 20; break;
    }
    
    // Familiarity bonus (avoiders prefer known safe places)
    moodScore += sp.place.familiarity * 10;
    
    return {
      ...sp,
      score: sp.score + moodScore
    };
  });
  
  // Select best option from mood-scored places
  if (moodScoredPlaces.length > 0) {
    return applyBaseDifficultyStrategy(moodScoredPlaces, difficulty);
  }
  
  // Fallback 1: Try trauma-free places even with threatening atmosphere
  if (traumaFreePlaces.length > 0) {
    // Prioritize least threatening current mood
    const leastThreatening = traumaFreePlaces
      .sort((a, b) => {
        const moodPriority = {
          "safe": 8, "familiar": 7, "sacred": 6, "neutral": 5, "unfamiliar": 4,
          "distorted": 3, "eerie": 2, "threatening": 1, "contaminated": 0
        };
        const aPriority = moodPriority[a.place.currentMood || "neutral"] || 5;
        const bPriority = moodPriority[b.place.currentMood || "neutral"] || 5;
        return bPriority - aPriority;
      });
    
    return applyBaseDifficultyStrategy(leastThreatening, difficulty);
  }
  
  // Fallback 2: Use base difficulty strategy (may select any place)
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
    const { currentMood, eventTags = [] } = sp.place;
    let boost = 0;
    if (currentMood === "threatening" || currentMood === "eerie") {
      boost += 0.2;
    }
    if (eventTags.some(tag => tag.includes("danger") || tag.includes("death"))) {
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
      const { currentMood, eventTags = [] } = sp.place;
      let boost = 0;
      if (eventTags.some(tag => 
        tag.includes("betrayal") || 
        tag.includes("abandon") || 
        tag.includes("failure")
      )) {
        boost += 0.25;
      }
      if (currentMood === "contaminated") {
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
  
  if (!selectedPlace) return "Consider introducing a new meaningful location for this scene.";
  
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