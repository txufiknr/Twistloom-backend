/**
 * Player Profile Analysis System
 * 
 * This system analyzes action history to calculate psychological traits
 * that influence narrative style and AI configuration.
 * 
 * This enables personalized storytelling based on individual player behavior patterns.
 */

import type { StoryState, StyleInput, PsychologicalProfileMetrics, TrustLevel, GuiltLevel, MemoryIntegrity, ActionType, SelectedAction } from '../types/story.js';
import { getStoryStateInfo } from './story.js';
import { normalize } from './parser.js';

/**
 * Action type influence weights for psychological traits
 */
const ACTION_INFLUENCES: Record<ActionType, Partial<PsychologicalProfileMetrics>> = {
  explore: { curiosity: 0.2, fear: -0.1 },
  escape: { fear: 0.3, trust: -0.1 },
  social: { fear: -0.1, curiosity: 0.1, trust: 0.1, guilt: 0.05 },
  risk: { aggression: 0.15, fear: 0.05, trust: -0.2, guilt: 0.1 },
  ignore: { denial: 0.2, curiosity: -0.1, trust: -0.1, guilt: 0.1 },
  attack: { aggression: 0.3, fear: 0.1, trust: -0.2, guilt: 0.15 },
  deceive: { denial: 0.25, aggression: 0.05, trust: -0.3, guilt: 0.2 },
  protect: { aggression: -0.1, curiosity: 0.05, trust: 0.2 },
  create: { curiosity: 0.15, fear: -0.1, trust: 0.05 },
  heal: { aggression: -0.05, curiosity: 0.05, trust: 0.15 },
  dialogue: { curiosity: 0.1, fear: -0.05, trust: 0.1 },
  custom: { curiosity: 0.1 },
  other: { curiosity: 0.05 }
} as const;

/**
 * Calculates base psychological traits from action history
 */
function calculateBaseTraits(actionsHistory: SelectedAction[]): Pick<PsychologicalProfileMetrics, 'curiosity' | 'fear' | 'aggression' | 'denial'> {
  const traits = {
    curiosity: 0,
    fear: 0,
    aggression: 0,
    denial: 0
  };
  
  actionsHistory.forEach(action => {
    const influences = ACTION_INFLUENCES[action.type as keyof typeof ACTION_INFLUENCES] || ACTION_INFLUENCES.other;
    
    Object.entries(influences).forEach(([trait, influence]) => {
      traits[trait as keyof typeof traits] += influence as number;
    });
  });
  
  return traits;
}

/**
 * Calculates player psychological profile from action history
 * 
 * Analyzes the pattern of actions to determine player's behavioral tendencies
 * and psychological characteristics that influence narrative style.
 * 
 * @param state - Current story state
 * @returns Psychological profile with calculated traits
 * 
 * @example
 * ```typescript
 * const profile = calculatePlayerProfile({
 *   actionsHistory: [
 *     { page: 1, text: "investigate", type: "explore" },
 *     { page: 2, text: "run away", type: "escape" },
 *     { page: 3, text: "help friend", type: "social" }
 *   ],
 *   flags: {
 *     trust: 50,
 *     guilt: 30
 *   }
 * });
 * // Returns: { curiosity: 0.7, fear: 0.2, aggression: 0.1, denial: 0.0, ... }
 * ```
 */
export function calculatePlayerProfile(state: StoryState): PsychologicalProfileMetrics {
  const { actionsHistory, flags } = state;
  
  // Calculate base traits from action patterns
  const baseTraits = calculateBaseTraits(actionsHistory);
  
  // Essential psychological factors from flags
  const trust = mapTrustLevel(flags.trust);
  const guilt = mapGuiltLevel(flags.guilt);
  
  // Contextual factors from story state
  const traumaWeight = normalize(state.traumaTags.length * 0.2);
  const physicalState = calculateInjurySeverity(state.injuries);
  
  // Social context from character interactions
  const socialContext = calculateSocialEngagement(state.characters);
  
  // Cognitive state from memory integrity
  const cognitiveState = 1 - mapMemoryIntegrity(state.memoryIntegrity);
  
  return {
    curiosity: normalize(baseTraits.curiosity),
    fear: normalize(baseTraits.fear),
    aggression: normalize(baseTraits.aggression),
    denial: normalize(baseTraits.denial),
    trust,
    guilt,
    traumaWeight,
    physicalState,
    socialContext,
    cognitiveState
  };
}

/**
 * Maps trust level to numeric value
 */
function mapTrustLevel(trust: TrustLevel): number {
  return trust === 'high' ? 1.0 : trust === 'medium' ? 0.5 : 0.2;
}

/**
 * Maps guilt level to numeric value
 */
function mapGuiltLevel(guilt: GuiltLevel): number {
  return guilt === 'high' ? 1.0 : guilt === 'medium' ? 0.5 : 0.2;
}

/**
 * Maps memory integrity to numeric value
 */
function mapMemoryIntegrity(memoryIntegrity: MemoryIntegrity): number {
  return memoryIntegrity === 'stable' ? 0.0 : memoryIntegrity === 'fragmented' ? 0.5 : 1.0;
}

/**
 * Calculates social engagement based on character interactions
 */
function calculateSocialEngagement(characters: Record<string, unknown>): number {
  const characterCount = Object.keys(characters).length;
  if (characterCount === 0) return 0;
  return Math.min(1, characterCount * 0.15);
}

/**
 * Calculates injury severity from accumulated injuries
 */
function calculateInjurySeverity(injuries: Array<{ severity?: number }>): number {
  if (injuries.length === 0) return 0;
  const totalSeverity = injuries.reduce((sum, injury) => sum + (injury.severity ?? 0.5), 0);
  return Math.min(1, totalSeverity * 0.2);
}

/**
 * Creates StyleInput for narrative style calculation
 * 
 * Converts current story state and player profile into the format
 * expected by the Narrative Style Engine with essential psychological context.
 * 
 * @param state - Current story state
 * @returns Complete StyleInput for style calculation
 */
export function createStyleInput(state: StoryState): StyleInput {
  const { page, traumaTags } = state;
  const { isFinale } = getStoryStateInfo(state);
  return {
    sanity: state.memoryIntegrity === 'stable' ? 1.0 : state.memoryIntegrity === 'fragmented' ? 0.5 : 0.2,
    tension: state.flags.fear === 'high' ? 0.8 : state.flags.fear === 'medium' ? 0.5 : 0.3,
    entropy: (state.page / state.maxPage) * 0.5, // Increases with story progress
    traumaTags,
    profile: calculatePlayerProfile(state),
    page,
    isEnding: isFinale
  };
}
