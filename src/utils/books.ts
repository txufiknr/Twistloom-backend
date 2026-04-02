import { PsychologicalProfile, HiddenState, TruthLevel, ProfileShift, EndingPlan, ThreatProximity, RealityStability, Archetype, StabilityLevel, ManipulationAffinity, EndingPlanType, ProfileShiftType, Ending } from "../types/story.js";

/**
 * Creates initial psychological profile for new stories
 * 
 * @returns Baseline psychological profile for story start
 */
export function createInitialPsychologicalProfile(): PsychologicalProfile {
  return {
    archetype: 'the_explorer' satisfies Archetype,
    stability: 'stable' satisfies StabilityLevel,
    dominantTraits: ['curious', 'cautious'],
    manipulationAffinity: 'fear' satisfies ManipulationAffinity,
  };
}

/**
 * Creates initial hidden state for new stories
 * 
 * @returns Baseline hidden state for story start
 */
export function createInitialHiddenState(): HiddenState {
  return {
    truthLevel: 'mostly_true' satisfies TruthLevel,
    threatProximity: 'distant' satisfies ThreatProximity,
    realityStability: 'stable' satisfies RealityStability,
    endingPlan: {
      type: 'fake_relief_twist' satisfies EndingPlanType,
      armed: false,
      triggerPage: 15,
      fakeToReal: false
    } satisfies EndingPlan,
    profileShift: {
      detected: false,
      shiftType: 'curiosity_collapse' satisfies ProfileShiftType,
      detectedAt: 0,
      originalEnding: 'fake_escape' satisfies Ending
    } satisfies ProfileShift
  } satisfies HiddenState;
}