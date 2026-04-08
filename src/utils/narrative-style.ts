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
 *   page: 5,
 *   isEnding: false
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
 * Determines narrative mode based on style vector and conditions
 * 
 * Maps calculated style to human-readable narrative modes
 * that define the overall feel of the writing.
 * 
 * @param vector - Style vector from calculateStyle
 * @param sanity - Current sanity level for mode determination
 * @param isEnding - Whether story is in ending phase
 * @returns Narrative mode (grounded | uneasy | fractured)
 */
export function determineNarrativeMode(vector: StyleVector, sanity: number, isEnding: boolean): NarrativeMode {
  // Ending phase always tends toward fractured
  if (isEnding) {
    return "fractured";
  }
  
  // Mode thresholds based on key style dimensions
  const highFragmentation = vector.fragmentation > 0.6;
  const lowClarity = vector.clarity < 0.4;
  const highContradiction = vector.contradiction > 0.5;
  
  // Fractured: significant psychological distress indicators
  if (highFragmentation && lowClarity && highContradiction) {
    return "fractured";
  }
  
  // Uneasy: moderate distress with some coherence
  if (vector.fragmentation > 0.3 || vector.contradiction > 0.3) {
    return "uneasy";
  }
  
  // Grounded: relatively stable and coherent
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
 * @param isEnding - Whether story is in ending phase
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