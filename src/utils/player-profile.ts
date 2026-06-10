/**
 * Player Profile Analysis System
 * 
 * This system analyzes action history to calculate psychological traits
 * that influence narrative style and AI configuration.
 * 
 * This enables personalized storytelling based on individual player behavior patterns.
 */

import type { CharacterMemory } from '../types/character.js';
import type { StoryState, StyleInput, PsychologicalProfileMetrics, TrustLevel, GuiltLevel, MemoryIntegrity, ActionType, SelectedAction, PsychologicalProfileTraits } from '../types/story.js';
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
 * Calculates base psychological traits from action history.
 * Uses an exponential moving average decay factor to emphasize recency
 * and prevent late-game metric saturation.
 */
function calculateBaseTraits(actionsHistory: SelectedAction[]): PsychologicalProfileTraits {
  const traits: PsychologicalProfileTraits = {
    curiosity: 0,
    fear: 0,
    aggression: 0,
    denial: 0
  };
  
  actionsHistory.forEach(action => {
    const influences = ACTION_INFLUENCES[action.type as keyof typeof ACTION_INFLUENCES] || ACTION_INFLUENCES.other;
    
    // // Smoothly decay existing values before applying updates to ensure long-term fluidity
    // traits.curiosity *= 0.9;
    // traits.fear *= 0.9;
    // traits.aggression *= 0.9;
    // traits.denial *= 0.9;
    
    Object.entries(influences).forEach(([trait, influence]) => {
      if (trait in traits) {
        traits[trait as keyof typeof traits] += influence as number;
      }
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
  
  // Cognitive state from memory integrity (1.0 = clear thinking, 0.0 = completely corrupted perception)
  const cognitiveState = 1 - mapMemoryIntegrity(state.memoryIntegrity);

  const normalizedCuriosity = normalize(baseTraits.curiosity);
  const normalizedFear = normalize(baseTraits.fear);
  const normalizedAggression = normalize(baseTraits.aggression);
  const normalizedDenial = normalize(baseTraits.denial);

  // // 1. Determine Dominant Archetype based on the highest underlying behavioral trait score
  // const archetype: PsychologicalProfileArchetype = (
  //   [
  //     ['truth_seeker', normalizedCuriosity],
  //     ['paranoid_survivor', normalizedFear],
  //     ['defiant_combatant', normalizedAggression],
  //     ['escapist', normalizedDenial],
  //   ] as const
  // ).reduce((max, current) => (current[1] > max[1] ? current : max))[0];

  // // 2. Determine stability status based on cognitive deterioration and accumulated trauma
  // let stability: PsychologicalProfileStability = 'stable';
  // if (cognitiveState > 0.7) {
  //   stability = 'shattered';
  // } else if (cognitiveState > 0.4 || traumaWeight > 0.6) {
  //   stability = 'cracking';
  // } else if (traumaWeight > 0.3) {
  //   stability = 'strained';
  // }

  // // 3. Assign sharp, actionable weaknesses based on archetype to offer clear manipulation hooks
  // let primaryWeakness = 'need_for_answers';
  // switch (archetype) {
  //   case 'truth_seeker': primaryWeakness = 'need_for_answers'; break;
  //   case 'paranoid_survivor': primaryWeakness = 'fear_of_unknown'; break;
  //   case 'defiant_combatant': primaryWeakness = 'impulsive_retaliation'; break;
  //   case 'escapist': primaryWeakness = 'refusal_to_accept_reality'; break;
  // }

  // // 4. Assign contextual secondary weakness to drive highly specialized narrative conflict
  // let secondaryWeakness = 'fear_of_being_wrong';
  // if (guilt > 0.6) {
  //   secondaryWeakness = 'haunted_by_past';
  // } else if (trust < 0.4) {
  //   secondaryWeakness = 'inability_to_trust';
  // } else if (physicalState > 0.5) {
  //   secondaryWeakness = 'physical_vulnerability';
  // }

  // // 5. Establish strategic manipulation affinity vector for targeted narrative exploitation
  // let manipulationAffinity: PsychologicalProfileAffinity = 'contradiction';
  // switch (archetype) {
  //   case 'truth_seeker': manipulationAffinity = 'contradiction'; break;
  //   case 'paranoid_survivor': manipulationAffinity = 'uncertainty'; break;
  //   case 'defiant_combatant': manipulationAffinity = 'provocation'; break;
  //   case 'escapist': manipulationAffinity = 'illusion'; break;
  // }
  
  return {
    curiosity: normalizedCuriosity,
    fear: normalizedFear,
    aggression: normalizedAggression,
    denial: normalizedDenial,
    trust,
    guilt,
    traumaWeight,
    physicalState,
    socialContext,
    cognitiveState,
    // archetype,
    // stability,
    // primaryWeakness,
    // secondaryWeakness,
    // manipulationAffinity
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
function calculateSocialEngagement(characters: Record<string, CharacterMemory>): number {
  // TODO: shouldn't it filter by positive `relationshipToMC`? e.g., type === "friend" OR status === "trusting"
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
  return {
    sanity: state.memoryIntegrity === 'stable' ? 1.0 : state.memoryIntegrity === 'fragmented' ? 0.5 : 0.2,
    tension: state.flags.fear === 'high' ? 0.8 : state.flags.fear === 'medium' ? 0.5 : 0.3,

    // entropy: state.maxPage ? (state.page / state.maxPage) * 0.5 : 0.2, // Protected against division by zero
    entropy: (state.page / state.maxPage) * 0.5, // Increases with story progress

    // TODO: but this means entropy is basically page progression, not actual entropy.
    // This means:
    // page 1 = low entropy
    // page 50 = high entropy
    // regardless of what happened.

    // A better entropy signal might include:
    // memoryIntegrity
    // traumaTags
    // contradictedFacts
    // realityDistortions
    // majorEvents

    // For example:
    // entropy =
    //   pageProgress * 0.3 +
    //   traumaFactor * 0.3 +
    //   memoryDamage * 0.4;

    // This makes the style react to story state instead of page count.

    // OR:
    // const entropy = normalize(
    //   (state.page / state.maxPage) * 0.25 +
    //   traumaWeight * 0.35 +
    //   cognitiveState * 0.4
    // );

    // Now entropy represents actual psychological disorder.

    traumaTags,
    profile: calculatePlayerProfile(state),
    page
  };
}
