/**
 * Narrative Style Engine
 * 
 * Advanced system for controlling narrative feel and writing style
 * based on psychological state, story progression, and player behavior.
 * 
 * This transforms raw story metrics into sophisticated narrative guidance
 * that creates authored, human-like storytelling rather than AI generation.
 */

import type { StyleVector, NarrativeMode, NarrativeStyle, StyleInput, StoryState } from '../types/story.js';
import { createStyleInput } from './player-profile.js';
import { getStoryStateInfo } from './story.js';
import { normalize, stripEmptyLines } from './parser.js';

/**
 * Calculates base style metrics from core story inputs
 */
function calculateBaseMetrics(input: StyleInput) {
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
function applyPsychologicalAdjustments(base: ReturnType<typeof calculateBaseMetrics>, profile: StyleInput['profile']) {
  /** Cognitive distortion increases as cognitiveState drops (Fixed mathematical inversion bug) */
  const cognitiveDistortion = (1 - profile.cognitiveState) * 0.25;
  /** Trust affects contradiction (low trust = more self-doubt) */
  const trustAdjustment = (1 - profile.trust) * 0.15;
  /** Trauma affects repetition and sensory focus */
  const traumaAdjustment = profile.traumaWeight * 0.2;
  /** Physical state affects pacing */
  const physicalAdjustment = profile.physicalState * 0.15;
  
  return {
    fragmentation: base.fragmentation + cognitiveDistortion,
    repetition: base.repetition + traumaAdjustment,
    contradiction: base.contradiction + trustAdjustment,
    clarity: base.clarity - cognitiveDistortion,
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
 * // Returns: { sentenceLength: 0.75, fragmentation: 0.15, ... }
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
  const lowClarity = vector.clarity < 0.4;
  const highContradiction = vector.contradiction > 0.5;
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
      (highSanity && (vector.fragmentation > 0.3 || vector.contradiction > 0.3 || vector.clarity < 0.6)) ||
      (highSanity && (highRepetition || lowPacing))) {
    return "uneasy";
  }
  
  // GROUNDED MODE: Relatively stable psychological state
  // Default case for high sanity with low distress indicators
  return "grounded";
}

/**
 * Generates narrative style instructions for AI
 * Creates detailed, atmospheric guidance translating numerical metrics 
 * into evocative writing directives. Eliminates token bloat by focusing 
 * purely on execution, tailoring the prose style to weaponize the player's profile.
 * @param style - Complete narrative style configuration
 * @param styleInput - Style input containing story state and player metrics
 * @param state - Complete story state
 * @returns Human-readable instructions for AI
 * 
 * @example
 * ```typescript
 * const instructions = generateStyleInstructions({
 *   mode: "fractured",
 *   vector: { fragmentation: 0.8, contradiction: 0.7, ... }
 * });
 * // Returns detailed instructions for fragmented writing style
 * ```
 */
export function generateStyleInstructions(style: Pick<NarrativeStyle, 'mode' | 'vector'>, styleInput: StyleInput, state: StoryState): string {
  const { mode, vector } = style;
  const { profile } = styleInput;
  const { phase } = getStoryStateInfo(state);

  const directives: string[] = [];

  // 1. Core Narrative Mode Constraints (Voice & General Syntax Length)
  if (mode === "grounded") {
    directives.push(
      "- VOICE: Grounded, clear, and objective. Maintain structured logical flow with natural transitions.",
      "- SYNTAX: Rich, expressive sentences with eloquent vocabulary and comprehensive length variations."
    );
  } else if (mode === "uneasy") {
    directives.push(
      "- VOICE: Unsettled and destabilized. Weave an undercurrent of paranoia, quiet anxiety, and creeping doubt into descriptions.",
      "- SYNTAX: Introduce sudden rhythm breaks, shorter clauses, and minor instances of internal second-guessing."
    );
  } else if (mode === "fractured") {
    directives.push(
      "- VOICE: Deeply fractured and psychologically compromised. The barrier between real events and internal terror has dissolved.",
      "- SYNTAX: Use breathless, broken, and halting sentence fragments. Frequent em-dashes (—) and looping mental syntax are highly encouraged, while preserving structural prose readability."
    );
  }

  // 2. Metric Vector Translations (Prose Dynamics)
  if (vector.fragmentation > 0.6) {
    directives.push("- FRAGMENTATION: Sever ideas mid-sentence; allow descriptive imagery to shatter or trail off uncompleted.");
  }
  if (vector.repetition > 0.6) {
    directives.push("- REPETITION: Implement echoing recurring phrases or obsessive structural loops to trap the reader in the MC's fixation.");
  }
  if (vector.contradiction > 0.6) {
    directives.push("- CONTRADICTION: Let the protagonist observe an immediate detail and rewrite it moments later out of sheer confusion (do not explain the anomaly away).");
  }
  if (vector.sensoryFocus > 0.6) {
    directives.push("- SENSORY FOCUS: Hyper-fixate intensely on raw, visceral stimuli—the exact pitch of a sound, sudden light shifts, or sharp physical reactions.");
  } else if (vector.sensoryFocus < 0.4) {
    directives.push("- SENSORY FOCUS: Keep environmental descriptions abstract and surreal, as though the setting is obscured through a psychological lens.");
  }
  
  if (vector.pacing > 0.6) {
    directives.push("- PACING: Accelerate tension with urgent, snappy clauses to mimic a racing heartbeat.");
  } else if (vector.pacing < 0.4) {
    directives.push("- PACING: Intentionally stall the pacing; force sentences to feel heavy, lethargic, or numbly slow.");
  }

  // 3. Psychological Weaponization (Turning behavioral tendencies into structural writing traps)
  if (profile.curiosity > 0.6) {
    directives.push("- WEAPONIZE CURIOSITY: The player wants to discover things. Punish their exploration: force the prose to hyper-fixate on morbid details or disturbing structural anomalies in the surroundings, making them regret looking closer.");
  }
  if (profile.fear > 0.6) {
    directives.push("- WEAPONIZE FEAR: Enforce absolute hyper-vigilance. Shape the narration so harmless shifting shadows, normal ambient noise, or neutral micro-expressions are tracked as imminent, personal threats.");
  }
  if (profile.aggression > 0.6) {
    directives.push("- WEAPONIZE AGGRESSION: Color the voice with a sharp, hostile edge. Use violent, confrontational action verbs and an internal monologue that treats secondary characters and settings as targets to smash or overcome.");
  }
  if (profile.denial > 0.6) {
    directives.push("- WEAPONIZE DENIAL: Force the protagonist to frantically rationalize surreal or outright terrifying anomalies using fragile, paper-thin logic that strains belief.");
  }
  if (profile.trust < 0.4) {
    directives.push("- WEAPONIZE DISTRUST: Parse conversations and environmental actions with intense suspicion, actively dissecting spoken dialogue for indicators of ultimate deception or trap doors.");
  }
  if (profile.guilt > 0.6) {
    directives.push("- WEAPONIZE GUILT: Saturate descriptions with themes of culpability, rot, or lingering punishment. The environment must look and act like an active physical manifestation of the protagonist's unresolved remorse.");
  }

  // 4. Story Phase Milestones
  if (phase === 'EARLY') {
    directives.push("- CONTEXT: Establish mystery. Focus on building an atmosphere of subtle unease and planting initial seeds of doubt.");
  } else if (phase === 'MID') {
    directives.push("- CONTEXT: Escalate pressure. Complicate the horror and warp the protagonist's grip on factual reality.");
  } else if (phase === 'LATE' || phase === 'FINALE') {
    directives.push("- CONTEXT: Psychological climax. Bring all tensions to a volatile flashpoint; allow the mental distortions to reach full parity.");
  }

  directives.push("- CRITICAL EVOLUTION: Writing transitions must build fluidly and organically across changes—never execute sudden, unearned stylistic jumps.");

  return stripEmptyLines(directives.join('\n'));
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
  const styleInput = createStyleInput(state);
  const vector = calculateStyleVector(styleInput);
  const mode = determineNarrativeMode(vector, styleInput.sanity, styleInput.isEnding);
  const instructions = generateStyleInstructions({ mode, vector }, styleInput, state);
  
  return {
    mode,
    vector,
    instructions
  };
}