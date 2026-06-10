/**
 * Narrative Style Engine
 * 
 * Advanced system for controlling narrative feel and writing style
 * based on psychological state, story progression, and player behavior.
 * 
 * This transforms raw story metrics into sophisticated narrative guidance
 * that creates authored, human-like storytelling rather than AI generation.
 */

import type { StyleVector, NarrativeMode, NarrativeStyle, StyleInput, StoryState, PsychologicalProfileMetrics } from '../types/story.js';
import { createStyleInput } from './player-profile.js';
import { getStoryStateInfo } from './story.js';
import { normalize, stripEmptyLines } from './parser.js';

/**
 * Calculates base style metrics from core story inputs
 */
function calculateBaseMetrics(input: StyleInput): StyleVector {
  const { sanity, tension, entropy, traumaTags, profile } = input;
  
  return {
    /** Increases as sanity decreases and entropy rises */
    fragmentation: (1 - sanity) * 0.8 + entropy * 0.3,
    /** Driven by tension and accumulated trauma */
    repetition: tension * 0.6 + traumaTags.length * 0.1,
    /** Self-doubt increases as sanity drops */
    contradiction: (1 - sanity) * 0.7,
    /** Decreases with entropy and psychological distress */
    clarity: sanity * 0.8 - entropy * 0.3,
    /** Faster with high tension, slower when stable */
    pacing: tension * 0.7,
    /** Detail-oriented when curious, abstract when distressed */
    sensoryFocus: tension * 0.5 + profile.curiosity * 0.3
  };
}

/**
 * Applies psychological adjustments to base metrics
 */
function applyPsychologicalAdjustments(base: StyleVector, profile: PsychologicalProfileMetrics): StyleVector {
  const { cognitiveState, trust, traumaWeight, physicalState } = profile;
  // TODO: which one is correct for base.fragmentation (+) and base.clarity (-)?
  // /** Cognitive distortion increases as cognitiveState drops (Fixed mathematical inversion bug) */
  // const cognitiveDistortion = (1 - cognitiveState) * 0.25;
  /** Cognitive state affects clarity and fragmentation */
  const cognitiveAdjustment = cognitiveState * 0.2;
  /** Trust affects contradiction (low trust = more self-doubt) */
  const trustAdjustment = (1 - trust) * 0.15;
  /** Trauma affects repetition and sensory focus */
  const traumaAdjustment = traumaWeight * 0.2;
  /** Physical state affects pacing */
  const physicalAdjustment = physicalState * 0.15;
  
  return {
    fragmentation: base.fragmentation + cognitiveAdjustment,
    repetition: base.repetition + traumaAdjustment,
    contradiction: base.contradiction + trustAdjustment,
    clarity: base.clarity - cognitiveAdjustment,
    pacing: base.pacing + physicalAdjustment,
    sensoryFocus: base.sensoryFocus + traumaAdjustment
  };
}

/**
 * Calculates narrative style vector from story inputs
 * 
 * This function implements the core style calculation algorithm
 * that maps psychological and story metrics to writing characteristics.
 * 
 * @param input - Style input containing story state and player metrics
 * @returns Style vector controlling narrative characteristics
 * 
 * @example
 * ```typescript
 * // Early game, stable player
 * const style = calculateStyle({
 *   sanity: 0.9,
 *   tension: 0.3,
 *   entropy: 0.1,
 *   traumaTags: [],
 *   profile: { curiosity: 0.8, fear: 0.2, aggression: 0.1, denial: 0.1 },
 *   page: 5
 * });
 * // Returns: { fragmentation: 0.15, ... }
 * ```
 */
export function calculateStyleVector(input: StyleInput): StyleVector {
  const base = calculateBaseMetrics(input);
  const adjusted = applyPsychologicalAdjustments(base, input.profile);
  
  return {
    fragmentation: normalize(adjusted.fragmentation),
    repetition: normalize(adjusted.repetition),
    contradiction: normalize(adjusted.contradiction),
    clarity: normalize(adjusted.clarity),
    pacing: normalize(adjusted.pacing),
    sensoryFocus: normalize(adjusted.sensoryFocus)
  };
}

/**
 * Determines narrative mode based on style vector, sanity level, and story conditions
 * 
 * Maps calculated style to human-readable narrative modes that define the overall
 * feel of the writing. Uses multi-factor analysis incorporating psychological state,
 * narrative progression, and style dimensions for accurate mode determination.
 * 
 * The function follows these principles:
 * - Sanity level is the primary driver of psychological distress
 * - Style dimensions provide secondary confirmation and nuance
 * - Ending phase forces fractured mode regardless of other factors
 * - Progressive thresholds ensure smooth transitions between modes
 * 
 * @param vector - Style vector from calculateStyle with all narrative dimensions
 * @param sanity - Current sanity level (0.0 = completely insane, 1.0 = completely sane)
 * @param isEnding - Whether story is in ending phase (final pages)
 * @returns Narrative mode (grounded | uneasy | fractured)
 * 
 * @example
 * ```typescript
 * // Early story with high sanity and stable style
 * const mode1 = determineNarrativeMode(
 *   { fragmentation: 0.2, clarity: 0.8, contradiction: 0.1 },
 *   0.9, false
 * ); // Returns: "grounded"
 * 
 * // Mid story with moderate sanity and some distortion
 * const mode2 = determineNarrativeMode(
 *   { fragmentation: 0.4, clarity: 0.6, contradiction: 0.3 },
 *   0.6, false
 * ); // Returns: "uneasy"
 * 
 * // Ending phase with any sanity level
 * const mode3 = determineNarrativeMode(
 *   { fragmentation: 0.3, clarity: 0.7, contradiction: 0.2 },
 *   0.8, true
 * ); // Returns: "fractured"
 * ```
 */
export function determineNarrativeMode(vector: StyleVector, sanity: number, isEnding: boolean): NarrativeMode {
  // Ending phase always forces fractured mode for psychological impact
  if (isEnding) return "fractured";
  
  // Sanity-based primary classification (0.0 = completely insane, 1.0 = completely sane)
  const sanityLevel = sanity;
  const veryLowSanity = sanityLevel <= 0.3;
  const lowSanity = sanityLevel <= 0.5;
  const moderateSanity = sanityLevel <= 0.7;
  const highSanity = sanityLevel > 0.7;
  
  // Style-based secondary indicators
  const highFragmentation = vector.fragmentation > 0.6;
  const moderateFragmentation = vector.fragmentation > 0.3;
  const lowClarity = vector.clarity < 0.4;
  const moderateClarity = vector.clarity < 0.6;
  const highContradiction = vector.contradiction > 0.5;
  const moderateContradiction = vector.contradiction > 0.3;
  const lowPacing = vector.pacing < 0.4; // Slow, deliberate pacing
  const highRepetition = vector.repetition > 0.6; // Repetitive thoughts/phrases
  
  // Calculate psychological distress score from style dimensions
  const distressScore = 
    (vector.fragmentation * 0.3) +      // Fragmented thoughts
    (vector.contradiction * 0.25) +    // Self-contradiction
    ((1 - vector.clarity) * 0.2) +     // Lack of clarity
    (vector.repetition * 0.15) +      // Repetitive loops
    ((1 - vector.pacing) * 0.1);       // Slow, heavy pacing
  
  // FRACTURED MODE: Severe psychological breakdown
  // Triggered by very low sanity OR high distress with moderate-low sanity OR specific severe style combinations
  if (veryLowSanity || 
      (lowSanity && distressScore > 0.6) ||
      (moderateSanity && (highFragmentation && lowClarity && highContradiction)) ||
      (moderateSanity && (highFragmentation && highRepetition && lowPacing))) {
    return "fractured";
  }
  
  // UNEASY MODE: Moderate psychological distress
  // Triggered by moderate-low sanity OR moderate distress with sane-moderate sanity OR specific style indicators
  if (lowSanity || 
      (moderateSanity && distressScore > 0.4) ||
      (highSanity && (moderateFragmentation || moderateContradiction || moderateClarity)) ||
      (highSanity && (highRepetition || lowPacing))) {
    return "uneasy";
  }
  
  // GROUNDED MODE: Relatively stable psychological state
  // Default case for high sanity with low distress indicators
  return "grounded";
}

/**
 * Generates narrative style instructions for AI
 * Creates detailed, human-readable guidance that translates style vectors 
 * into specific writing behaviors and techniques. It isolates prose directives 
 * completely from diagnostic psychological parameters or numerical telemetry data
 * to maintain extreme token optimization and preserve true separation of concerns.
 * @param style - Complete narrative style configuration
 * @param styleInput - Enhanced input for multi-factor guidance
 * @param state - Story state to get phase information
 * @returns Human-readable atmosphere and prose directives for AI
 * @example
 * ```typescript
 * const instructions = generateStyleInstructions({
 *   mode: "fractured",
 *   vector: { fragmentation: 0.8, contradiction: 0.7, ... }
 * }, styleInput, state);
 * // Returns structured instructions focusing entirely on prose and atmosphere
 * ```
 */
export function generateStyleInstructions(style: Pick<NarrativeStyle, 'mode' | 'vector'>, styleInput: StyleInput, state: StoryState): string {
  const { mode, vector } = style;
  const { phase } = getStoryStateInfo(state);
  
  // TODO: is `styleInput.profile` really unused?
  // const { profile } = styleInput;

  // 1. Mode-specific base atmospheric foundation
  let baseToneInstructions: string;
  
  switch (mode) {
    case "grounded":
      baseToneInstructions = `- Minimal fragmentation. Describe environmental events cleanly and directly.\n- Maintain logical flow, tracking objective surroundings with slight underlying discomfort.`;
      break;
      
    case "uneasy":
      baseToneInstructions = `- Break sentences or thoughts at erratic intervals to show subtle stress.\n- Inject light phrase repetition to reflect internal tension and growing doubt.`;
      break;
      
    case "fractured":
      baseToneInstructions = `- Frequently cut off thoughts or sever sentences using sudden em dashes (—).\n- Loop key words or recurring phrases to mirror obsessive or cyclic psychological loops.\n- Allow blatant sensory contradictions to stand completely uncorrected or unacknowledged.\n- Reduce narrative clarity substantially, allowing paranoia to color structural visibility.`;
      break;
      
    default:
      baseToneInstructions = `- Formulate narrative style organically to suit the immediate threat landscape.`;
  }
  
  // 2. Structural tactical prose directives (Generated strictly through metric logic thresholds)
  const structuralDirectives: string[] = [];

  // Fragmentation parsing
  if (vector.fragmentation > 0.6) {
    structuralDirectives.push("- Enforce heavy structural fragmentation, fragmented clauses, and broken thought bursts.");
  } else if (vector.fragmentation > 0.3) {
    structuralDirectives.push("- Introduce selective sentence fragments and abrupt narrative transitions.");
  }

  // Repetition parsing
  if (vector.repetition > 0.6) {
    structuralDirectives.push("- Re-echo intense keywords, visceral trauma hooks, or core realizations across adjacent blocks.");
  }

  // Contradiction parsing
  if (vector.contradiction > 0.6) {
    structuralDirectives.push("- Allow descriptions to reverse or conflict with prior assertions within the same sequence.");
  }

  // Clarity parsing
  if (vector.clarity < 0.4) {
    structuralDirectives.push("- Abstract the physical setting; prioritize raw somatic sensations over factual descriptions.");
  } else if (vector.clarity > 0.7) {
    structuralDirectives.push("- Keep prose sharp, grounded, and intensely focused on realistic observation.");
  }

  // Pacing parsing
  if (vector.pacing > 0.6) {
    structuralDirectives.push("- Accelerate narrative rhythm using immediate action verbs, brief clauses, and minimal introspection.");
  } else if (vector.pacing < 0.4) {
    structuralDirectives.push("- Retard narrative pacing using prolonged sentences, heavy pauses, and deep internal monologues.");
  }

  // Sensory focus parsing
  if (vector.sensoryFocus > 0.6) {
    structuralDirectives.push("- Focus deeply on restrictive sensory inputs: cold touch, ambient sounds, skin pressure, and odors.");
  } else {
    structuralDirectives.push("- Emphasize abstract dread, contextual environmental themes, and existential vulnerability.");
  }

  // // Psychological Weaponization (Turning behavioral tendencies into structural writing traps)
  // if (profile.curiosity > 0.6) {
  //   structuralDirectives.push("- WEAPONIZE CURIOSITY: The player wants to discover things. Punish their exploration: force the prose to hyper-fixate on morbid details or disturbing structural anomalies in the surroundings, making them regret looking closer.");
  // }
  // if (profile.fear > 0.6) {
  //   structuralDirectives.push("- WEAPONIZE FEAR: Enforce absolute hyper-vigilance. Shape the narration so harmless shifting shadows, normal ambient noise, or neutral micro-expressions are tracked as imminent, personal threats.");
  // }
  // if (profile.aggression > 0.6) {
  //   structuralDirectives.push("- WEAPONIZE AGGRESSION: Color the voice with a sharp, hostile edge. Use violent, confrontational action verbs and an internal monologue that treats secondary characters and settings as targets to smash or overcome.");
  // }
  // if (profile.denial > 0.6) {
  //   structuralDirectives.push("- WEAPONIZE DENIAL: Force the protagonist to frantically rationalize surreal or outright terrifying anomalies using fragile, paper-thin logic that strains belief.");
  // }
  // if (profile.trust < 0.4) {
  //   structuralDirectives.push("- WEAPONIZE DISTRUST: Parse conversations and environmental actions with intense suspicion, actively dissecting spoken dialogue for indicators of ultimate deception or trap doors.");
  // }
  // if (profile.guilt > 0.6) {
  //   structuralDirectives.push("- WEAPONIZE GUILT: Saturate descriptions with themes of culpability, rot, or lingering punishment. The environment must look and act like an active physical manifestation of the protagonist's unresolved remorse.");
  // }

  // Phase-based stylistic modifiers
  if (phase === 'EARLY') structuralDirectives.push("- Lay faint tracks of structural unreliability and emphasize an ambiguous atmosphere.");
  if (phase === 'MID') structuralDirectives.push("- Escalate mechanical prose distortions, letting tension disrupt simple narrative tracks.");
  if (phase === 'LATE') structuralDirectives.push("- Funnel prose anomalies toward critical peaks, making self-delusion an active narrational conflict.");
  if (phase === 'FINALE') structuralDirectives.push("- Release structural control entirely to create maximum atmospheric breakdown or visceral release.");

  structuralDirectives.push("- CRITICAL OPERATIONAL RULE: Style modifications must shift seamlessly across pages; do not execute jarring style jumps.");

  // Build isolated structured payload
  const formattedAtmospherePayload = [
    `NARRATIVE STYLE & PROSE ATMOSPHERE`,
    `Base Mode Instructions (${mode.toUpperCase()}):\n${baseToneInstructions}`,
    `Prose Implementation Directives:\n${structuralDirectives.join('\n')}`
  ].join('\n\n');

  return stripEmptyLines(formattedAtmospherePayload);
}

/**
 * Creates complete narrative style configuration
 * Answers: "How should the story be written?"
 * 
 * Combines mode determination and instruction generation
 * into a single, comprehensive style configuration.
 * 
 * @param state - Story state
 * @returns Complete narrative style for AI guidance
 */
export function createNarrativeStyle(state: StoryState): NarrativeStyle {
  const { isFinale } = getStoryStateInfo(state);
  const styleInput = createStyleInput(state);
  const vector = calculateStyleVector(styleInput);
  const mode = determineNarrativeMode(vector, styleInput.sanity, isFinale);
  const instructions = generateStyleInstructions({ mode, vector }, styleInput, state);
  
  return {
    mode,
    vector,
    instructions
  };
}