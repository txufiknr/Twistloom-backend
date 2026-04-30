/**
 * Player Profile Analysis System
 * 
 * This system analyzes action history to calculate psychological traits
 * that influence narrative style and AI configuration.
 * 
 * This enables personalized storytelling based on individual player behavior patterns.
 */

import type { StoryState, StyleInput, PsychologicalProfileMetrics, ActionHistory, TrustLevel, GuiltLevel, MemoryIntegrity, ActionType } from '../types/story.js';
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
function calculateBaseTraits(actionsHistory: ActionHistory[]): Pick<PsychologicalProfileMetrics, 'curiosity' | 'fear' | 'aggression' | 'denial'> {
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

// /**
//  * Maps curiosity level to numeric value
//  */
// function mapCuriosityLevel(curiosity: CuriosityLevel): number {
//   return curiosity === 'high' ? 1.0 : curiosity === 'medium' ? 0.5 : 0.2;
// }

// /**
//  * Maps fear level to numeric value
//  */
// function mapFearLevel(fear: FearLevel): number {
//   return fear === 'high' ? 1.0 : fear === 'medium' ? 0.5 : 0.2;
// }

/**
 * Maps memory integrity to numeric value
 */
function mapMemoryIntegrity(memoryIntegrity: MemoryIntegrity): number {
  return memoryIntegrity === 'stable' ? 0.0 : memoryIntegrity === 'fragmented' ? 0.5 : 1.0;
}

// /**
//  * Maps difficulty to numeric value
//  */
// function mapDifficulty(difficulty: Difficulty): number {
//   return difficulty === 'nightmare' ? 1.0 : difficulty === 'high' ? 0.75 : difficulty === 'medium' ? 0.5 : 0.25;
// }

// /**
//  * Calculates trauma density based on tags per page
//  */
// function calculateTraumaDensity(traumaTags: string[], page: number): number {
//   if (page === 0) return 0;
//   const density = traumaTags.length / page;
//   return Math.min(1, density * 2); // Scale to 0-1 range
// }

// /**
//  * Calculates trauma severity weighted by tag types
//  */
// function calculateTraumaSeverity(traumaTags: string[]): number {
//   if (traumaTags.length === 0) return 0;
//   // Simple severity based on tag count - can be enhanced with keyword analysis
//   const severity = Math.min(1, traumaTags.length * 0.15);
//   return severity;
// }

// /**
//  * Calculates whether high trauma occurred in recent pages
//  */
// function calculateRecentTrauma(traumaTags: string[], page: number, actionsHistory: ActionHistory[]): number {
//   if (traumaTags.length === 0) return 0;
//   // Check if trauma tags were added in last 3 pages
//   const recentActions = actionsHistory.filter(a => a.page >= page - 3);
//   const recentTraumaCount = recentActions.length > 0 ? traumaTags.length / recentActions.length : 0;
//   return Math.min(1, recentTraumaCount * 0.5);
// }

/**
 * Calculates social engagement based on character interactions
 */
function calculateSocialEngagement(characters: Record<string, unknown>): number {
  const characterCount = Object.keys(characters).length;
  if (characterCount === 0) return 0;
  return Math.min(1, characterCount * 0.15);
}

// /**
//  * Calculates relationship stability from character memory
//  */
// function calculateRelationshipStability(characters: Record<string, unknown>): number {
//   // Placeholder - can be enhanced with actual relationship analysis
//   const characterCount = Object.keys(characters).length;
//   if (characterCount === 0) return 0.5; // Neutral when no characters
//   return 0.7; // Default moderate stability
// }

// /**
//  * Calculates isolation level from low social engagement
//  */
// function calculateIsolationLevel(socialEngagement: number): number {
//   return Math.max(0, 1 - socialEngagement);
// }

/**
 * Calculates injury severity from accumulated injuries
 */
function calculateInjurySeverity(injuries: Array<{ severity?: number }>): number {
  if (injuries.length === 0) return 0;
  const totalSeverity = injuries.reduce((sum, injury) => sum + (injury.severity ?? 0.5), 0);
  return Math.min(1, totalSeverity * 0.2);
}

// /**
//  * Calculates resource scarcity based on inventory vs progress
//  */
// function calculateResourceScarcity(inventory: string[], page: number, maxPage: number): number {
//   if (inventory.length === 0) return 1.0; // High scarcity when no inventory
//   const progressRatio = page / maxPage;
//   const expectedInventory = progressRatio * 5; // Expect 5 items by end
//   const scarcity = Math.max(0, 1 - (inventory.length / expectedInventory));
//   return Math.min(1, scarcity);
// }

// /**
//  * Calculates physical vulnerability from injury + scarcity
//  */
// function calculatePhysicalVulnerability(injurySeverity: number, resourceScarcity: number): number {
//   return (injurySeverity + resourceScarcity) / 2;
// }

// /**
//  * Calculates thread complexity from active narrative threads
//  */
// function calculateThreadComplexity(threads: unknown[]): number {
//   if (threads.length === 0) return 0;
//   return Math.min(1, threads.length * 0.2);
// }

// /**
//  * Calculates plot flag intensity from narrative flags
//  */
// function calculatePlotFlagIntensity(plotFlags: string[]): number {
//   if (plotFlags.length === 0) return 0;
//   return Math.min(1, plotFlags.length * 0.15);
// }

// /**
//  * Calculates paranoia index from fear + trust + memory
//  */
// function calculateParanoiaIndex(fearLevel: number, trustLevel: number, memoryFragmentation: number): number {
//   return (fearLevel * 0.4) + ((1 - trustLevel) * 0.3) + (memoryFragmentation * 0.3);
// }

// /**
//  * Calculates perception reliability from memory + difficulty
//  */
// function calculatePerceptionReliability(memoryFragmentation: number, difficulty: number): number {
//   return Math.max(0, 1 - (memoryFragmentation * 0.6) - (difficulty * 0.4));
// }

// /**
//  * Calculates story phase modifier for adaptive behavior
//  */
// function calculatePhaseModifier(page: number, maxPage: number): number {
//   const progress = page / maxPage;
//   if (progress < 0.25) return 0.3; // Early phase
//   if (progress < 0.7) return 0.5; // Mid phase
//   if (progress < 0.9) return 0.7; // Late phase
//   return 1.0; // Finale phase
// }

// /**
//  * Calculates early game exploration tendency
//  */
// function calculateEarlyGameExploration(page: number, maxPage: number, curiosity: number): number {
//   const progress = page / maxPage;
//   if (progress > 0.3) return 0; // Only applies in early game
//   return curiosity * (1 - progress); // Higher curiosity early = more exploration
// }

// /**
//  * Calculates late game desperation level
//  */
// function calculateLateGameDesperation(page: number, maxPage: number, fear: number): number {
//   const progress = page / maxPage;
//   if (progress < 0.7) return 0; // Only applies in late game
//   return fear * progress; // Higher fear late = more desperation
// }

// /**
//  * Calculates finale intensity amplification
//  */
// function calculateFinaleIntensity(page: number, maxPage: number, isFinale: boolean): number {
//   if (!isFinale) return 0;
//   const progress = page / maxPage;
//   return progress; // Increases as we approach final page
// }

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
