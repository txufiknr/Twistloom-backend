/**
 * Narrative Style Engine
 *
 * Transforms raw story metrics into concrete prose directives.
 * Answers one question only: "How should this page be written?"
 *
 * Separation of concerns:
 * - NARRATIVE STYLE       → prose atmosphere, sentence texture, structural rhythm
 * - PSYCHOLOGICAL FLAGS   → current discrete emotional state (trust/fear/guilt/curiosity)
 * - PSYCHOLOGICAL PROFILE → behavioral archetype, manipulation affinity, exploit tactics
 *
 * This module deliberately contains no exploitation logic and no diagnostic
 * labels. That belongs in PSYCHOLOGICAL PROFILE. Clean separation reduces token
 * duplication and ensures the AI uses each section for its intended purpose.
 */

import type { StyleVector, NarrativeMode, NarrativeStyle, StyleInput, StoryState, PsychologicalProfileMetrics, PrimaryWeakness } from '../types/story.js';
import { createStyleInput } from './player-profile.js';
import { getStoryStateInfo } from './story.js';
import { normalize, stripEmptyLines } from './parser.js';

/**
 * Calculates base style metrics from core story inputs.
 *
 * Uses profile traits to enrich base calculations beyond just sanity/tension/entropy:
 * - denial amplifies contradiction (the MC rationalizes what they shouldn't)
 * - guilt amplifies repetition (intrusive echoes of past choices)
 * - aggression tightens pacing (urgency, forward pressure)
 */
function calculateBaseMetrics(input: StyleInput): StyleVector {
  const { sanity, tension, entropy, traumaTags, profile } = input;
  
  return {
    /** Increases as sanity decreases and entropy rises */
    fragmentation: (1 - sanity) * 0.8 + entropy * 0.3,
    /** Driven by tension, trauma, and guilt-driven intrusive echoes */
    repetition:    tension * 0.6 + traumaTags.length * 0.1 + profile.guilt * 0.1,
    /** Self-doubt from sanity collapse, amplified by active denial */
    contradiction: (1 - sanity) * 0.7 + profile.denial * 0.2,
    /** Decreases with entropy and psychological distress */
    clarity:       sanity * 0.8 - entropy * 0.3,
    /** Faster with tension, tightened by aggression, slowed by physical injury */
    pacing:        tension * 0.7 + profile.aggression * 0.1,
    /** Detail-oriented when curious; abstract when distressed */
    sensoryFocus:  tension * 0.5 + profile.curiosity * 0.3
  };
}

/**
 * Applies psychological adjustments to base style metrics.
 *
 * Corrections vs. previous version:
 * - cognitiveState is a CLARITY value (1.0 = stable, 0.0 = corrupted).
 *   Using (1 - cognitiveState) gives the cognitive DISORDER amount, so
 *   high clarity → near-zero adjustment (correct), corrupted → max adjustment (correct).
 *   The previous version used cognitiveState directly, which inverted the effect:
 *   stable players incorrectly received higher fragmentation than corrupted ones.
 */
function applyPsychologicalAdjustments(base: StyleVector, profile: PsychologicalProfileMetrics): StyleVector {
  const { cognitiveState, trust, traumaWeight, physicalState } = profile;

  /** Cognitive disorder increases fragmentation and reduces clarity */
  const cognitiveAdjustment = (1 - cognitiveState) * 0.2;
  /** Low trust increases self-doubt and contradiction */
  const trustAdjustment     = (1 - trust) * 0.15;
  /** Trauma deepens repetition (flashbacks, intrusive echoes) and sensory intrusion */
  const traumaAdjustment    = traumaWeight * 0.2;
  /** Physical injury slows pacing (pain, exhaustion, impaired movement) */
  const physicalAdjustment  = physicalState * 0.15;

  return {
    fragmentation: base.fragmentation + cognitiveAdjustment,
    repetition:    base.repetition    + traumaAdjustment,
    contradiction: base.contradiction + trustAdjustment,
    clarity:       base.clarity       - cognitiveAdjustment,
    pacing:        base.pacing        + physicalAdjustment,
    sensoryFocus:  base.sensoryFocus  + traumaAdjustment
  };
}

/**
 * Calculates the narrative style vector from story inputs.
 *
 * Maps psychological and story metrics to writing characteristics via a
 * two-pass pipeline: base metrics → psychological adjustments → normalization.
 *
 * @param input - Style input from createStyleInput()
 * @returns Normalized style vector (all dimensions clamped to [0, 1])
 *
 * @example
 * ```typescript
 * const vector = calculateStyleVector({
 *   sanity: 0.9, tension: 0.3, entropy: 0.1,
 *   traumaTags: [],
 *   profile: { curiosity: 0.8, fear: 0.2, cognitiveState: 1.0, ... },
 *   page: 5, isEnding: false
 * });
 * // → { fragmentation: ~0.15, clarity: ~0.7, ... }
 * ```
 */
export function calculateStyleVector(input: StyleInput): StyleVector {
  const base = calculateBaseMetrics(input);
  const adjusted = applyPsychologicalAdjustments(base, input.profile);
  
  return {
    fragmentation: normalize(adjusted.fragmentation),
    repetition:    normalize(adjusted.repetition),
    contradiction: normalize(adjusted.contradiction),
    clarity:       normalize(adjusted.clarity),
    pacing:        normalize(adjusted.pacing),
    sensoryFocus:  normalize(adjusted.sensoryFocus)
  };
}

/**
 * Determines narrative mode from style vector, sanity level, and story conditions.
 *
 * Mapping:
 * - grounded  — stable psychology, coherent prose, unease in implication
 * - uneasy    — moderate distress, growing instability, occasional breaks
 * - fractured — severe breakdown, unreliable perception, maximum distortion
 *
 * Decision Hierarchy:
 * 1. Ending phase → always fractured (psychological impact at finale)
 * 2. Sanity level → primary driver
 * 3. distressScore → multi-factor confirmation
 * 4. Specific style combinations → catch edge cases
 *
 * @param vector - Normalized style vector
 * @param sanity - Current sanity (0.0 = completely insane, 1.0 = completely sane)
 * @param isEnding - Whether the story is in its ending phase
 *
 * @example
 * ```typescript
 * determineNarrativeMode({ fragmentation: 0.2, clarity: 0.8, ... }, 0.9, false); // "grounded"
 * determineNarrativeMode({ fragmentation: 0.4, clarity: 0.6, ... }, 0.6, false); // "uneasy"
 * determineNarrativeMode({ fragmentation: 0.3, clarity: 0.7, ... }, 0.8, true);  // "fractured"
 * ```
 */
export function determineNarrativeMode(vector: StyleVector, sanity: number, isEnding: boolean): NarrativeMode {
  // Ending phase forces fractured regardless of other factors
  if (isEnding) return 'fractured';

  // ── Sanity thresholds ──────────────────────────────────────────────────────
  const veryLowSanity  = sanity <= 0.3;
  const lowSanity      = sanity <= 0.5;
  const moderateSanity = sanity <= 0.7;
  const highSanity     = sanity >  0.7;

  // ── Style-based secondary indicators ──────────────────────────────────────
  const highFragmentation     = vector.fragmentation > 0.6;
  const moderateFragmentation = vector.fragmentation > 0.3;
  const lowClarity            = vector.clarity       < 0.4;
  const moderateClarity       = vector.clarity       < 0.6;
  const highContradiction     = vector.contradiction > 0.5;
  const moderateContradiction = vector.contradiction > 0.3;
  const lowPacing             = vector.pacing        < 0.4;
  const highRepetition        = vector.repetition    > 0.6;

  // ── Composite distress score ───────────────────────────────────────────────
  const distressScore =
    vector.fragmentation * 0.30 +   // fragmented thoughts
    vector.contradiction * 0.25 +   // self-contradiction
    (1 - vector.clarity) * 0.20 +   // lack of clarity
    vector.repetition    * 0.15 +   // obsessive loops
    (1 - vector.pacing)  * 0.10;    // slow, heavy pacing

  // ── FRACTURED: severe psychological breakdown ──────────────────────────────
  if (
    veryLowSanity ||
    (lowSanity      && distressScore > 0.6) ||
    (moderateSanity && highFragmentation && lowClarity && highContradiction) ||
    (moderateSanity && highFragmentation && highRepetition && lowPacing)
  ) {
    return 'fractured';
  }

  // ── UNEASY: moderate psychological distress ────────────────────────────────
  if (
    lowSanity ||
    (moderateSanity && distressScore > 0.4) ||
    (highSanity     && (moderateFragmentation || moderateContradiction || moderateClarity)) ||
    (highSanity     && (highRepetition || lowPacing))
  ) {
    return 'uneasy';
  }

  // ── GROUNDED: relatively stable ────────────────────────────────────────────
  return 'grounded';
}

// /**
//  * Maps a numeric style value to a qualitative level label.
//  *
//  * LLMs interpret categorical labels more consistently than raw decimals —
//  * they bucket 0.43 and 0.47 as "moderate" anyway. Explicit labels remove
//  * prompt noise and cut token count without any loss of accuracy.
//  *
//  * @param value - Normalized value [0, 1]
//  * @param low  - Upper bound for 'low' (default: 0.33)
//  * @param high - Lower bound for 'high' (default: 0.66)
//  */
// function level(value: number, low = 0.33, high = 0.66): 'low' | 'moderate' | 'high' {
//   if (value >= high) return 'high';
//   if (value >= low)  return 'moderate';
//   return 'low';
// }

/**
 * Generates a single prose-texture line based on the player's primary weakness.
 *
 * This is a WRITING TECHNIQUE directive — how the MC's perspective is colored —
 * not an exploitation tactic. Exploitation belongs in PSYCHOLOGICAL PROFILE.
 *
 * @param weakness - The player's dominant psychological vulnerability
 */
function primaryWeaknessProseHint(weakness: PrimaryWeakness): string {
  switch (weakness) {
    case 'truth_seeking':    return 'The MC scans everything as if it might be a clue. Write observations with latent significance.';
    case 'fear_of_loss':     return 'Anchor details in what the MC values. Let those things feel quietly, persistently fragile.';
    case 'need_for_control': return 'Emphasize constraints and what the MC cannot reach, change, or predict.';
    case 'trust_hunger':     return 'The MC reads too much into others\' behavior. Every tone of voice, every pause, is analyzed.';
    case 'guilt':            return 'Filter sensory details through residue of past choices. Familiar things carry weight.';
    case 'avoidance':        return 'The MC\'s attention drifts away from the most important things. The truth is always slightly off-frame.';
  }
}

/**
 * Generates narrative style instructions for AI.
 *
 * Produces concise, action-oriented prose directives (target ~150–200 tokens).
 * Focused purely on atmosphere and writing technique.
 *
 * What this section answers: "How should this page be written?"
 * What this section does NOT contain: psychology diagnostics, numeric telemetry,
 * exploitation tactics, or manipulation vectors (those are in PSYCHOLOGICAL PROFILE).
 *
 * @param style      - Mode and style vector
 * @param styleInput - Provides phase, sanity, and profile context
 * @param state      - Story state for phase information
 * @returns Structured prose directives ready for injection into the generation prompt
 *
 * @example
 * ```typescript
 * const instructions = generateStyleInstructions(
 *   { mode: 'fractured', vector: { fragmentation: 0.8, ... } },
 *   styleInput, state
 * );
 * // → "NARRATIVE STYLE & PROSE ATMOSPHERE\n\nBase Mode (FRACTURED):\n..."
 * ```
 */
export function generateStyleInstructions(style: Pick<NarrativeStyle, 'mode' | 'vector'>, styleInput: StyleInput, state: StoryState): string {
  const { mode, vector } = style;
  const { phase } = getStoryStateInfo(state);
  const { profile } = styleInput;

  // ── 1. Mode-specific atmospheric foundation ────────────────────────────────
  const baseToneInstructions: Record<NarrativeMode, string> = {
    grounded: [
      '- Describe events directly and logically. Minimal distortion.',
      '- Maintain coherent flow; let unease live in implication, not broken syntax.',
      '- Plant subtle inconsistencies the MC notices but does not consciously register.'
    ].join('\n'),
    uneasy: [
      '- Occasionally break sentences mid-thought or let them trail.',
      '- Use light phrase repetition to build quiet dread.',
      '- Let the MC second-guess observations without full breakdown.',
      '- Allow small contradictions to stand unresolved.'
    ].join('\n'),
    fractured: [
      '- Frequently cut thoughts with em dashes (—). Let sentences fail to finish.',
      '- Loop key words or phrases with obsessive weight.',
      '- The MC misremembers, misreads, or doubts what they witness.',
      '- Contradictions stand without resolution — never explain them.',
      '- Reduce clarity while preserving readability.'
    ].join('\n')
  };

  // ── 2. Structural prose directives (threshold-driven) ─────────────────────
  // Exploitation-based "WEAPONIZE" directives have been removed from this section.
  // If psychological targeting of player traits is desired, it belongs in the
  // PSYCHOLOGICAL PROFILE section, not here.
  const structuralDirectives: string[] = [];

  // Fragmentation vector
  if (vector.fragmentation > 0.6) structuralDirectives.push('- Heavy fragmentation: broken clauses, fractured thought bursts.');
  else if (vector.fragmentation > 0.3) structuralDirectives.push('- Selective fragmentation: abrupt transitions and incomplete thoughts.');

  // Repetition vector
  if (vector.repetition > 0.6) structuralDirectives.push('- Re-echo key words, trauma hooks, or core realizations across adjacent beats.');

  // Contradiction vector
  if (vector.contradiction > 0.6) structuralDirectives.push('- Allow descriptions to reverse prior assertions within the same sequence.');

  // Clarity vector
  if (vector.clarity < 0.4) structuralDirectives.push('- Abstract the setting; prioritize raw sensation over factual description.');
  else if (vector.clarity > 0.7) structuralDirectives.push('- Sharp, grounded prose focused on realistic observation.');

  // Pacing vector
  if (vector.pacing > 0.6) structuralDirectives.push('- Fast rhythm: immediate action verbs, short clauses, minimal introspection.');
  else if (vector.pacing < 0.4) structuralDirectives.push('- Slow rhythm: prolonged sentences, heavy pauses, deep internal monologue.');

  // Sensory focus vector
  if (vector.sensoryFocus > 0.6) structuralDirectives.push('- Sensory immersion: cold touch, ambient sounds, skin pressure, smell.');
  else structuralDirectives.push('- Abstract dread: existential unease, environmental themes over physical detail.');

  // Phase directive
  const phaseDirectives: Record<string, string> = {
    EARLY:  '- Phase: Establish the world. Let unease grow beneath the surface.',
    MID:    '- Phase: Escalate pressure. Complicate what the MC thinks they know.',
    LATE:   '- Phase: Converge. Force confrontation with suppressed truths.',
    FINALE: '- Phase: Deliver psychological and emotional payoff. Release structural control.'
  };
  if (phaseDirectives[phase]) structuralDirectives.push(phaseDirectives[phase]);

  // Style evolution rule — allows earned dramatic breaks
  structuralDirectives.push('- Style evolves gradually. Sudden breaks are acceptable after major revelations, trauma, or reality collapse.');

  // ── 3. Prose texture from primary weakness ─────────────────────────────────
  // A single writing-technique hint based on the player's behavioral archetype.
  // This colors the MC's perspective without duplicating exploitation logic.
  const primaryWeakness = profile.primaryWeakness;
  const textureHint = primaryWeakness ? primaryWeaknessProseHint(primaryWeakness) : null;

  // ── Build output ────────────────────────────────────────────────────────────
  const sections: string[] = [
    `Base Mode (${mode.toUpperCase()}):\n${baseToneInstructions[mode]}`,
    `Prose Directives:\n${structuralDirectives.join('\n')}`,
    ...(textureHint ? [`Perspective Texture:\n- ${textureHint}`] : [])
  ];

  return sections.map(stripEmptyLines).join('\n\n');
}

/**
 * Creates the complete narrative style configuration for a story state.
 * Answers: "How should the story be written?"
 *
 * Pipeline: state → StyleInput → StyleVector → NarrativeMode → instructions
 *
 * @param state - Current story state
 * @returns Complete NarrativeStyle for injection into the generation prompt
 */
export function createNarrativeStyle(state: StoryState): NarrativeStyle {
  const { isFinale } = getStoryStateInfo(state);
  const styleInput   = createStyleInput(state);
  const vector       = calculateStyleVector(styleInput);
  const mode         = determineNarrativeMode(vector, styleInput.sanity, isFinale);
  const instructions = generateStyleInstructions({ mode, vector }, styleInput, state);
  
  return {
    mode,
    vector,
    instructions
  };
}