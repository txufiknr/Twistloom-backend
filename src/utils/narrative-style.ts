/**
 * Narrative Style Engine
 * 
 * Advanced system for controlling narrative feel and writing style
 * based on psychological state, story progression, and player behavior.
 * 
 * This transforms raw story metrics into sophisticated narrative guidance
 * that creates authored, human-like storytelling rather than AI generation.
 */

import type { StyleVector, NarrativeMode, NarrativeStyle, StyleInput } from '../types/story.js';

// /**
//  * Core inputs for Narrative Style Engine
//  * 
//  * These represent the fundamental inputs that determine narrative style
//  * based on story state, player psychology, and progression.
//  */
// export type StyleInput = {
//   /** Current sanity level (0.0–1.0) */
//   sanity: number;
//   /** Current tension level (0.0–1.0) */
//   tension: number;
//   /** World entropy/instability (from entropy controller) */
//   entropy: number;
//   /** Accumulated trauma tags affecting narrative tone */
//   traumaTags: string[];
//   /** Player psychological profile based on action history */
//   profile: {
//     /** Curiosity level from actions */
//     curiosity: number;
//     /** Fear level from actions */
//     fear: number;
//     /** Aggression level from actions */
//     aggression: number;
//     /** Denial level from actions */
//     denial: number;
//   };
//   /** Current page number */
//   page: number;
//   /** Whether story is in ending phase */
//   isEnding: boolean;
// };

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
  // Base calculations influenced by sanity (primary driver)
  const sanity = input.sanity;
  const tension = input.tension;
  const entropy = input.entropy;
  
  // Sentence length: longer when sane, shorter when fracturing
  const sentenceLength = 0.3 + sanity * 0.5;
  
  // Fragmentation: increases as sanity decreases and entropy rises
  const fragmentation = (1 - sanity) * 0.8 + entropy * 0.3;
  
  // Repetition: driven by tension and accumulated trauma
  const repetition = tension * 0.6 + input.traumaTags.length * 0.1;
  
  // Contradiction: self-doubt increases as sanity drops
  const contradiction = (1 - sanity) * 0.7;
  
  // Clarity: decreases with entropy and psychological distress
  const clarity = sanity * 0.8 - entropy * 0.3;
  
  // Pacing: faster with high tension, slower when stable
  const pacing = tension * 0.7;
  
  // Sensory focus: detail-oriented when curious, abstract when distressed
  const sensoryFocus = tension * 0.5 + input.profile.curiosity * 0.3;
  
  return {
    sentenceLength,
    fragmentation,
    repetition,
    contradiction,
    clarity,
    pacing,
    sensoryFocus
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
export function generateStyleInstructions(style: Pick<NarrativeStyle, 'mode' | 'vector'>): string {
  const { mode, vector } = style;
  
  // Mode-specific base instructions
  let instructions = "";
  
  switch (mode) {
    case "grounded":
      instructions = `
• Use clear, simple sentences.
• Minimal fragmentation.
• Describe events directly.
• Slight unease but logical flow.`;
      break;
      
    case "uneasy":
      instructions = `
Mix short and medium sentences.
Occasionally break sentences or thoughts.
Use light repetition for tension.
Allow small contradictions in thoughts.
Emphasize growing unease and doubt.`;
      break;
      
    case "fractured":
      instructions = `
Use short, fragmented sentences.
Frequently interrupt thoughts with em dashes (—).
Repeat key words or phrases.
Let MC doubt what they see.
Allow contradictions without resolving them.
Reduce clarity but maintain readability.
Emphasize psychological distress and confusion.`;
      break;
      
    default:
      instructions = `Develop naturally with appropriate tone for current context.`;
  }
  
  // Add vector-specific refinements
  const vectorInstructions = `
Current style metrics:
- Sentence length: ${vector.sentenceLength.toFixed(2)} (short ↔ mixed ↔ longer)
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
  
  return instructions + vectorInstructions;
}

/**
 * Creates complete narrative style configuration
 * 
 * Combines mode determination and instruction generation
 * into a single, comprehensive style configuration.
 * 
 * @param input - Style input from story state
 * @returns Complete narrative style for AI guidance
 */
export function createNarrativeStyle(input: StyleInput): NarrativeStyle {
  const vector = calculateStyleVector(input);
  const mode = determineNarrativeMode(vector, input.sanity, input.isEnding);
  const instructions = generateStyleInstructions({ mode, vector });
  
  return {
    mode,
    vector,
    instructions
  };
}