/**
 * Player Profile Analysis System
 * 
 * This system analyzes action history to calculate psychological traits
 * that influence narrative style and AI configuration.
 * 
 * This enables personalized storytelling based on individual player behavior patterns.
 */

import { NEAR_ENDING_PAGES } from '../config/story.js';
import type { 
  ActionType, 
  Action, 
  StoryState, 
  StyleInput,
  PsychologicalProfileMetrics
} from '../types/story.js';

/**
 * Calculates player psychological profile from action history
 * 
 * Analyzes the pattern of actions to determine player's behavioral tendencies
 * and psychological characteristics that influence narrative style.
 * 
 * @param actionsHistory - Array of all actions taken by player
 * @returns Psychological profile with calculated traits
 * 
 * @example
 * ```typescript
 * const profile = calculatePlayerProfile([
 *   { text: "investigate", type: "explore" },
 *   { text: "run away", type: "escape" },
 *   { text: "help friend", type: "social" }
 * ]);
 * // Returns: { curiosity: 0.7, fear: 0.2, aggression: 0.1, denial: 0.0 }
 * ```
 */
export function calculatePlayerProfile(actionsHistory: Action[]): PsychologicalProfileMetrics {
  // Initialize profile with zero values
  const profile = {
    curiosity: 0,
    fear: 0,
    aggression: 0,
    denial: 0
  };
  
  // Calculate traits based on action type patterns
  actionsHistory.forEach(action => {
    switch (action.type) {
      case "explore":
        profile.curiosity += 0.2;
        break;
        
      case "escape":
        profile.fear += 0.3;
        break;
        
      case "social":
        // Social actions reduce fear and increase trust
        profile.fear = Math.max(0, profile.fear - 0.1);
        profile.curiosity += 0.1;
        break;
        
      case "risk":
        // Risk actions increase aggression slightly
        profile.aggression += 0.15;
        profile.fear += 0.05;
        break;
        
      case "ignore":
        // Ignore actions increase denial and reduce curiosity
        profile.denial += 0.2;
        profile.curiosity = Math.max(0, profile.curiosity - 0.1);
        break;
        
      case "attack":
        // Attack actions significantly increase aggression
        profile.aggression += 0.3;
        profile.fear += 0.1;
        break;
        
      case "deceive":
        // Deceptive actions increase denial and manipulation
        profile.denial += 0.25;
        profile.aggression += 0.05;
        break;
        
      case "protect":
        // Protect actions reduce aggression and increase trust
        profile.aggression = Math.max(0, profile.aggression - 0.1);
        profile.curiosity += 0.05;
        break;
        
      case "create":
        // Creative actions increase curiosity and reduce fear
        profile.curiosity += 0.15;
        profile.fear = Math.max(0, profile.fear - 0.1);
        break;
        
      case "heal":
        // Healing actions reduce aggression and increase trust
        profile.aggression = Math.max(0, profile.aggression - 0.05);
        profile.curiosity += 0.05;
        break;
    }
  });
  
  // Normalize values to 0-1 range
  const normalizeValue = (value: number) => Math.min(1, Math.max(0, value));
  
  return {
    curiosity: normalizeValue(profile.curiosity),
    fear: normalizeValue(profile.fear),
    aggression: normalizeValue(profile.aggression),
    denial: normalizeValue(profile.denial)
  };
}

/**
 * Creates StyleInput for narrative style calculation
 * 
 * Converts current story state and player profile into the format
 * expected by the Narrative Style Engine.
 * 
 * @param state - Current story state
 * @returns Complete StyleInput for style calculation
 */
export function createStyleInput(state: StoryState): StyleInput {
  return {
    sanity: state.memoryIntegrity === 'stable' ? 1.0 : 
      state.memoryIntegrity === 'fragmented' ? 0.5 : 0.2,
    tension: state.flags.fear === 'high' ? 0.8 : 
      state.flags.fear === 'medium' ? 0.5 : 0.3,
    entropy: (state.page / state.maxPage) * 0.5, // Increases with story progress
    traumaTags: state.traumaTags,
    profile: calculatePlayerProfile(state.actionsHistory),
    page: state.page,
    isEnding: state.page >= state.maxPage - NEAR_ENDING_PAGES
  };
}
