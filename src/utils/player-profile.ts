/**
 * Player Profile Analysis System
 *
 * Analyzes action history to calculate numeric psychological traits that feed
 * the Narrative Style Engine. This is the continuous/quantitative layer of the
 * psychology system.
 *
 * Architecture note:
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  advanceStoryState() (before every generation turn)             │
 * │    → updateFlags()              → state.flags (discrete)        │
 * │    → updateHiddenState()        → state.hiddenState +           │
 * │                                   memoryIntegrity + difficulty  │
 * │    → updateSanity()             → state.sanityState (HUD meter) │
 * │    → applySanityCrisisEffects() → crisis ending pressure        │
 * │    → derivePsychologicalProfile()→ state.psychologicalProfile   │
 * │                                   (archetype, stability,        │
 * │                                    dominantTraits,              │
 * │                                    manipulationAffinity)        │
 * └──────────────────────────────────────────────────────────────────┘
 *    ↓ (consumed by prompt builder)
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  calculatePlayerProfile()  →  PsychologicalProfileMetrics      │
 * │    Numeric traits derived from cumulative action history.        │
 * │    Bridges to state.psychologicalProfile for primaryWeakness    │
 * │    instead of re-deriving archetype/stability (redundant).       │
 * └──────────────────────────────────────────────────────────────────┘
 *    ↓
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  createStyleInput() → createNarrativeStyle()                    │
 * │    memoryClarity from memoryIntegrity (NOT sanityState)          │
 * │    NARRATIVE STYLE: "How should the story be written?"           │
 * └──────────────────────────────────────────────────────────────────┘
 */

import type { CharacterMemory } from '../types/character.js';
import type { StoryState, StyleInput, PsychologicalProfileMetrics, TrustLevel, GuiltLevel, MemoryIntegrity, ActionType, SelectedAction, PsychologicalProfileTraits, Archetype, PrimaryWeakness } from '../types/story.js';
import { normalize } from './parser.js';

/**
 * Per-action influence weights for the four accumulation traits.
 *
 * Only curiosity, fear, aggression, and denial are accumulated here.
 * trust and guilt entries are defined for semantic clarity but are ignored
 * during accumulation — those traits are authoritative from state.flags,
 * which updateFlags() maintains with hysteresis and context modifiers.
 */
const ACTION_INFLUENCES: Record<ActionType, Partial<PsychologicalProfileMetrics>> = {
  explore:  { curiosity: 0.2, fear: -0.1 },
  escape:   { fear: 0.3, trust: -0.1 },
  social:   { fear: -0.1, curiosity: 0.1, trust: 0.1, guilt: 0.05 },
  risk:     { aggression: 0.15, fear: 0.05, trust: -0.2, guilt: 0.1 },
  ignore:   { denial: 0.2, curiosity: -0.1, trust: -0.1, guilt: 0.1 },
  attack:   { aggression: 0.3, fear: 0.1, trust: -0.2, guilt: 0.15 },
  deceive:  { denial: 0.25, aggression: 0.05, trust: -0.3, guilt: 0.2 },
  protect:  { aggression: -0.1, curiosity: 0.05, trust: 0.2 },
  create:   { curiosity: 0.15, fear: -0.1, trust: 0.05 },
  heal:     { aggression: -0.05, curiosity: 0.05, trust: 0.15 },
  dialogue: { curiosity: 0.1, fear: -0.05, trust: 0.1 },
  custom:   { curiosity: 0.1 },
  other:    { curiosity: 0.05 }
} as const;

/**
 * Maps the current `Archetype` (from derivePsychologicalProfile) to a PrimaryWeakness.
 *
 * Bridges the flag-based archetype system and the action-history metrics layer,
 * avoiding redundant re-derivation of behavioral patterns that advanceStoryState()
 * already computes fresh before every generation turn.
 *
 * @param archetype - Archetype from state.psychologicalProfile
 * @param traits - Numeric trait scores for tie-breaking when archetype is ambiguous
 */
function derivePrimaryWeakness(
  archetype: Archetype,
  traits: Pick<PsychologicalProfileMetrics, 'curiosity' | 'fear' | 'aggression' | 'denial' | 'trust' | 'guilt'>
): PrimaryWeakness {
  switch (archetype) {
    case 'obsessive_investigator': return 'truth_seeking';
    case 'reckless_gambler':       return traits.guilt > 0.6 ? 'guilt' : 'need_for_control';
    case 'hyper_vigilant':         return 'avoidance';
    case 'selfless_martyr':        return 'guilt';
    case 'the_fatalist':           return 'avoidance';
    case 'cold_realist':           return traits.trust > 0.6 ? 'trust_hunger' : 'avoidance';
    default:                       return 'fear_of_loss';
  }
}

/**
 * Calculates base psychological traits from the full action history.
 *
 * Accumulates only the four action-derived traits (curiosity, fear, aggression, denial).
 * trust and guilt entries in ACTION_INFLUENCES are intentionally skipped here —
 * they are sourced from state.flags (maintained by updateFlags() with hysteresis).
 *
 * Recency-weighted: later actions matter more, via an EMA-style 0.95 decay per
 * step back from the most recent action (see below). Without it, an early-game
 * burst of noise (e.g. `custom`/`other` free-text actions) would permanently
 * skew the profile regardless of the reader's actual later behavior.
 */
function calculateBaseTraits(actionsHistory: SelectedAction[]): PsychologicalProfileTraits {
  const traits: PsychologicalProfileTraits = {
    curiosity: 0,
    fear: 0,
    aggression: 0,
    denial: 0
  };
  
  actionsHistory.forEach((action, idx) => {
    const influences = ACTION_INFLUENCES[action.type as keyof typeof ACTION_INFLUENCES] ?? ACTION_INFLUENCES.other;

    // Recency weighting: later actions matter more. Without this, early-game
    // noise (e.g. a burst of `custom`/`other` free-text actions) permanently
    // skews the profile regardless of the reader's actual later behavior.
    // EMA-style decay — older actions are discounted toward 0.
    const recency = Math.pow(0.95, actionsHistory.length - 1 - idx);

    Object.entries(influences).forEach(([trait, influence]) => {
      // Only accumulate the four declared base traits; trust/guilt are flags-authoritative
      if (trait in traits) {
        traits[trait as keyof typeof traits] += (influence as number) * recency;
      }
    });
  });
  
  return traits;
}

/**
 * Calculates the player's psychological profile from cumulative action history.
 *
 * Produces numeric metrics for the Narrative Style Engine. Does NOT re-derive
 * archetype/stability/manipulationAffinity — those are already computed by
 * derivePsychologicalProfile() before every generation turn and live in
 * state.psychologicalProfile. Instead, bridges to it for primaryWeakness.
 *
 * @param state - Current story state
 * @returns Psychological metrics with numeric traits and synthesized weakness
 *
 * @example
 * ```typescript
 * const profile = calculatePlayerProfile(state);
 * // { curiosity: 0.7, fear: 0.2, primaryWeakness: 'truth_seeking', ... }
 * ```
 */
export function calculatePlayerProfile(state: StoryState): PsychologicalProfileMetrics {
  const { actionsHistory, flags } = state;

  // ── Accumulation-based numeric traits ──────────────────────────────────────
  const baseTraits = calculateBaseTraits(actionsHistory);
  
  // Essential psychological factors from flags
  const curiosity   = normalize(baseTraits.curiosity);
  const fear        = normalize(baseTraits.fear);
  const aggression  = normalize(baseTraits.aggression);
  const denial      = normalize(baseTraits.denial);

  // ── Flag-authoritative traits (discrete → numeric) ─────────────────────────
  const trust = mapTrustLevel(flags.trust);
  const guilt = mapGuiltLevel(flags.guilt);

  // ── Contextual state factors ────────────────────────────────────────────────
  const traumaWeight   = normalize(state.traumaTags.length * 0.2);
  const physicalState  = calculateInjurySeverity(state.injuries);
  const socialContext  = calculateSocialEngagement(state.characters);

  // Cognitive state: memory clarity level.
  // 1.0 = stable (clear perception), 0.0 = corrupted (severely disordered).
  // The style engine uses (1 - cognitiveState) where it needs the disorder amount.
  const cognitiveState = 1 - mapMemoryIntegrity(state.memoryIntegrity);

  const traits = { curiosity, fear, aggression, denial, trust, guilt };

  // ── Synthesized weakness ────────────────────────────────────────────────────
  // Bridges to state.psychologicalProfile.archetype which derivePsychologicalProfile()
  // already computed fresh this turn, then sharpens it using action-history signals.
  const primaryWeakness = derivePrimaryWeakness(state.psychologicalProfile.archetype, traits);

  return {
    curiosity,
    fear,
    aggression,
    denial,
    trust,
    guilt,
    traumaWeight,
    physicalState,
    socialContext,
    cognitiveState,
    primaryWeakness
  };
}

/**
 * Maps trust flag level to numeric value (low → 0.2, medium → 0.5, high → 1.0).
 */
function mapTrustLevel(trust: TrustLevel): number {
  return trust === 'high' ? 1.0 : trust === 'medium' ? 0.5 : 0.2;
}

/**
 * Maps guilt flag level to numeric value (low → 0.2, medium → 0.5, high → 1.0).
 */
function mapGuiltLevel(guilt: GuiltLevel): number {
  return guilt === 'high' ? 1.0 : guilt === 'medium' ? 0.5 : 0.2;
}

/**
 * Maps memory integrity to cognitive disorder offset.
 * 
 * Returns 0.0 for stable, 0.5 for fragmented, 1.0 for corrupted.
 * Inverted by callers when cognitive clarity is needed (1 - offset).
 */
function mapMemoryIntegrity(memoryIntegrity: MemoryIntegrity): number {
  return memoryIntegrity === 'stable' ? 0.0 : memoryIntegrity === 'fragmented' ? 0.5 : 1.0;
}

/**
 * Estimates social connectedness from the number of known characters with a
 * positive relationship to the MC (friend, or trusting status) -- hostile-only
 * encounters don't count toward connectedness.
 */
function calculateSocialEngagement(characters: Record<string, CharacterMemory>): number {
  const characterCount = Object.values(characters).filter(c => c.relationshipToMC.type === 'friend' || c.relationshipToMC.status === 'trusting').length;
  if (characterCount === 0) return 0;
  return Math.min(1, characterCount * 0.15);
}

/**
 * Calculates accumulated injury severity as a 0–1 vulnerability score.
 */
function calculateInjurySeverity(injuries: Array<{ severity?: number }>): number {
  if (injuries.length === 0) return 0;
  const totalSeverity = injuries.reduce((sum, injury) => sum + (injury.severity ?? 0.5), 0);
  return Math.min(1, totalSeverity * 0.2);
}

/**
 * Creates StyleInput for the Narrative Style Engine.
 *
 * Converts the current story state and computed player profile into the unified
 * format consumed by createNarrativeStyle().
 *
 * Key design decisions:
 * - memoryClarity: from `memoryIntegrity` only — how reliably the MC recalls.
 *   Intentionally NOT from `sanityState.composure` (reader HUD resource).
 * - tension: from fear flag (immediate emotional state)
 * - entropy: weighted blend of trauma, cognitive disorder, and story progress
 *
 * @param state - Current story state
 * @returns StyleInput ready for the Narrative Style Engine
 */
export function createStyleInput(state: StoryState): StyleInput {
  const { page, maxPage, traumaTags } = state;
  const profile = calculatePlayerProfile(state);
  const pageProgress = page / maxPage;

  // Entropy: weighted psychological chaos signal.
  // Trauma accumulation and cognitive deterioration dominate over linear progress.
  // (1 - cognitiveState) = cognitive disorder level (cognitiveState is clarity, 1 = clear)
  const cognitiveDisorder = 1 - profile.cognitiveState;
  const entropy = normalize(
    pageProgress * 0.25 +
    profile.traumaWeight * 0.35 +
    cognitiveDisorder * 0.40
  );

  return {
    // memoryIntegrity → prose clarity. Do not substitute sanityState.composure.
    memoryClarity: state.memoryIntegrity === 'stable' ? 1.0 : state.memoryIntegrity === 'fragmented' ? 0.5 : 0.2,
    tension: state.flags.fear === 'high' ? 0.8 : state.flags.fear === 'medium' ? 0.5 : 0.3,
    entropy,
    traumaTags,
    profile,
    page
  };
}
