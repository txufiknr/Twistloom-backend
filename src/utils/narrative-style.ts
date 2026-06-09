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
    // /** Longer sentences when sane, shorter when fracturing */
    // sentenceLength: 0.3 + sanity * 0.5,
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
  /** Cognitive state affects clarity and fragmentation */
  const cognitiveAdjustment = profile.cognitiveState * 0.2;
  /** Trust affects contradiction (low trust = more self-doubt) */
  const trustAdjustment = (1 - profile.trust) * 0.15;
  /** Trauma affects repetition and sensory focus */
  const traumaAdjustment = profile.traumaWeight * 0.2;
  /** Physical state affects pacing */
  const physicalAdjustment = profile.physicalState * 0.15;
  
  return {
    // sentenceLength: base.sentenceLength,
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
 * // Returns: { sentenceLength: 0.75, fragmentation: 0.15, ... }
 * ```
 */
export function calculateStyleVector(input: StyleInput): StyleVector {
  const base = calculateBaseMetrics(input);
  const adjusted = applyPsychologicalAdjustments(base, input.profile);
  
  return {
    // sentenceLength: normalize(adjusted.sentenceLength),
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
 * 
 * Creates detailed, human-readable guidance that translates
 * style vectors into specific writing behaviors and techniques.
 * 
 * @param style - Complete narrative style configuration
 * @param enhancedInput - Optional enhanced input for multi-factor guidance
 * @param state - Optional story state to get phase information
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

  // 1. Mode-specific base instructions
  let instructions: string;

  // TODO: is this good? I want consistent writing style and sentence length variations
  
  switch (mode) {
    case "grounded":
      instructions = `
- Minimal fragmentation.
- Describe events directly.
- Slight unease but logical flow.`;
      break;
      
    case "uneasy":
      instructions = `
- Occasionally break sentences or thoughts.
- Use light repetition for tension.
- Allow small contradictions in thoughts.
- Emphasize growing unease and doubt.`;
      break;
      
    case "fractured":
      instructions = `
- Frequently interrupt thoughts with em dashes (—).
- Repeat key words or phrases.
- Let MC doubt what they see.
- Allow contradictions without resolving them.
- Reduce clarity but maintain readability.
- Emphasize psychological distress and confusion.`;
      break;
      
    default:
      instructions = `Develop naturally with appropriate tone for current context.`;
  }
  
  // 2. Add vector-specific refinements
  // - Sentence length: ${vector.sentenceLength.toFixed(2)} (short ↔ mixed ↔ longer)
  const vectorInstructions = `
Current style metrics:
- Fragmentation: ${vector.fragmentation.toFixed(2)} (broken thoughts, interruptions)
- Repetition: ${vector.repetition.toFixed(2)} (emotional echo, recurring phrases)
- Contradiction: ${vector.contradiction.toFixed(2)} (self-doubt, thought reversals)
- Clarity: ${vector.clarity.toFixed(2)} (how understandable narration is)
- Pacing: ${vector.pacing.toFixed(2)} (fast vs slow narration)
- Sensory focus: ${vector.sensoryFocus.toFixed(2)} (detail vs abstract descriptions)

Apply these behaviors:
- Break sentences when fragmentation is high (${vector.fragmentation.toFixed(2)})
- Use repetition meaningfully when repetition is elevated (${vector.repetition.toFixed(2)})
- Allow MC to misinterpret events when contradiction is high (${vector.contradiction.toFixed(2)})
- Do not explain contradictions - let them stand
- Adjust sentence length based on clarity needs (${vector.clarity.toFixed(2)})
- Control pacing based on tension level (${vector.pacing.toFixed(2)})
- Focus on ${vector.sensoryFocus > 0.6 ? 'detailed sensory descriptions' : 'more abstract narrative'}
- CRITICAL: Never suddenly jump between styles - gradual evolution only`;
  
  // 3. Add psychological guidance
  const multiFactorInstructions = `
Psychological context for creative guidance:
- Trust level: ${profile.trust.toFixed(2)} (${profile.trust > 0.7 ? 'trusting' : profile.trust > 0.4 ? 'cautious' : 'distrustful'})
- Guilt level: ${profile.guilt.toFixed(2)} (${profile.guilt > 0.7 ? 'burdened by guilt' : profile.guilt > 0.4 ? 'some regrets' : 'clear conscience'})
- Trauma weight: ${profile.traumaWeight.toFixed(2)} (${profile.traumaWeight > 0.6 ? 'heavily traumatized' : profile.traumaWeight > 0.3 ? 'some trauma' : 'minimal trauma'})
- Physical state: ${profile.physicalState.toFixed(2)} (${profile.physicalState > 0.6 ? 'vulnerable/injured' : profile.physicalState > 0.3 ? 'some strain' : 'physically capable'})
- Social context: ${profile.socialContext.toFixed(2)} (${profile.socialContext > 0.6 ? 'well-connected' : profile.socialContext > 0.3 ? 'some connections' : 'isolated'})
- Cognitive state: ${profile.cognitiveState.toFixed(2)} (${profile.cognitiveState > 0.6 ? 'clear thinking' : profile.cognitiveState > 0.3 ? 'some confusion' : 'fragmented perception'})

Creative suggestions:
${profile.trust < 0.4 ? '- Consider themes of betrayal, deception, or unreliable narrators\n' : ''}
${profile.guilt > 0.6 ? '- Explore past mistakes haunting the present\n' : ''}
${profile.traumaWeight > 0.6 ? '- Trauma may manifest as hallucinations, flashbacks, or distorted reality\n' : ''}
${profile.physicalState > 0.6 ? '- Physical vulnerability can heighten psychological tension\n' : ''}
${profile.socialContext < 0.4 ? '- Isolation can amplify paranoia and internal conflict\n' : ''}
${profile.cognitiveState < 0.4 ? '- Question the reliability of memories and perceptions\n' : ''}
${phase === 'EARLY' ? '- Establish mystery and plant seeds of doubt\n' : ''}
${phase === 'MID' ? '- Escalate psychological pressure and complications\n' : ''}
${phase === 'LATE' ? '- Bring tensions to a head, confront truths\n' : ''}
${phase === 'FINALE' ? '- Deliver emotional and psychological payoff\n' : ''}`;
  
  return [instructions, vectorInstructions, multiFactorInstructions].map(stripEmptyLines).join('\n');
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