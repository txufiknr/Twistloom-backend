/**
 * Centralized enum arrays for prompt-side AI consumption.
 *
 * Imports all const arrays from their canonical type-file definitions so that
 * prompt.ts (and other prompt-builder modules) can import every enum list
 * from a single location.  Rules sections and field-instruction builders
 * reference these to give the model explicit value constraints.
 *
 * Also provides pre-computed value strings (`moodValues`, `sceneTypeValues`,
 * etc.) that collapse `"One of: ${formatOneOf(x)}"` into a single variable,
 * keeping output-format templates in prompt.ts DRY.
 *
 * To add a new enum: define it in the appropriate `src/types/*.ts` file
 * (near its type), import it here, and add it to the export list below.
 * Never define an enum string inline inside a prompt builder — always go
 * through this barrel.
 */

import { formatOneOf } from "../utils/text-processing.js";

// ── Character ─────────────────────────────────────────────────────────────
import {
  characterImportances,
  characterRecognitionLevels,
  characterStatuses,
  healthConditions,
  injuryCategories,
  potentialTwistTypes,
  relationshipStatuses,
  relationshipTypes,
} from "../types/character.js";

// ── Story ─────────────────────────────────────────────────────────────────
import {
  actionTypes,
  actionHintTypes,
  archetypes,
  characterSceneRoles,
  difficulties,
  endingTypes,
  factTypes,
  finalePhases,
  flagLevels,
  manipulationAffinities,
  memoryIntegrities,
  moods,
  plotFlagTypes,
  psychologicalFlagsTypes,
  realityStabilities,
  sceneTypes,
  stabilityLevels,
  storyMomentums,
  storyPhaseKeys,
  threatProximities,
  truthLevels,
} from "../types/story.js";

// ── Places ────────────────────────────────────────────────────────────────
import {
  canonicalPlaceTypes,
  placeAccessibilities,
  placeWeathers,
} from "../types/places.js";

// ── Story Threads ─────────────────────────────────────────────────────────
import {
  threadPriorities,
  threadStatuses,
  threadTruths,
} from "../types/story-thread.js";

// ── User ──────────────────────────────────────────────────────────────────
import { genders } from "../types/user.js";

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  characterImportances,
  characterRecognitionLevels,
  characterStatuses,
  healthConditions,
  injuryCategories,
  potentialTwistTypes,
  relationshipStatuses,
  relationshipTypes,
  actionTypes,
  actionHintTypes,
  archetypes,
  characterSceneRoles,
  difficulties,
  endingTypes,
  factTypes,
  finalePhases,
  flagLevels,
  manipulationAffinities,
  memoryIntegrities,
  moods,
  plotFlagTypes,
  psychologicalFlagsTypes,
  realityStabilities,
  sceneTypes,
  stabilityLevels,
  storyMomentums,
  storyPhaseKeys,
  threatProximities,
  truthLevels,
  canonicalPlaceTypes,
  placeAccessibilities,
  placeWeathers,
  threadPriorities,
  threadStatuses,
  threadTruths,
  genders,
};

// ═══════════════════════════════════════════════════════════════════════════
// Pre-computed value strings for prompt output-format templates
// ═══════════════════════════════════════════════════════════════════════════

// ── Mood / Weather / Scene ───────────────────────────────────────────────
export const moodValues = `One of: ${formatOneOf(moods)}`;
export const weatherValues = `One of: ${formatOneOf(placeWeathers)}`;
export const sceneTypeValues = `One of: ${formatOneOf(Object.keys(sceneTypes))}`;
export const sceneRoleValues = `One of: ${formatOneOf(characterSceneRoles)}`;

// ── Momentum / Action ────────────────────────────────────────────────────
export const momentumValues = `One of: ${formatOneOf(Object.keys(storyMomentums))}`;
export const actionTypeValues = `One of: ${formatOneOf(Object.keys(actionTypes))}`;
export const hintTypeValues = `One of: ${formatOneOf(actionHintTypes)}`;

// ── State ────────────────────────────────────────────────────────────────
export const memoryIntegrityValues = `One of: ${formatOneOf(memoryIntegrities)}`;
export const difficultyValues = `One of: ${formatOneOf(difficulties)}`;

// ── Plot / Injury / Thread ───────────────────────────────────────────────
export const plotFlagTypeValues = `One of: ${formatOneOf(plotFlagTypes)}`;
export const injuryCategoryValues = `One of: ${formatOneOf(injuryCategories)}`;
export const threadPriorityValues = `One of: ${formatOneOf(threadPriorities)}`;
export const threadTruthValues = `One of: ${formatOneOf(threadTruths)}`;
export const threadStatusValues = `One of: ${formatOneOf(threadStatuses)}`;

// ── Ending / Future Notes ────────────────────────────────────────────────
export const endingTypeValues = `One of: ${formatOneOf(Object.keys(endingTypes))}`;
export const factTypeValues = `One of: ${formatOneOf(Object.keys(factTypes))}`;
export const phaseValues = `One of: ${formatOneOf(storyPhaseKeys, '|')}`;
export const stabilityLevelValues = `One of: ${formatOneOf(Object.keys(stabilityLevels), '|')}`;
export const healthConditionValues = `One of: ${formatOneOf(healthConditions, '|')}`;

// ── Places ───────────────────────────────────────────────────────────────
export const canonicalPlaceTypeValues = `One of: ${formatOneOf(canonicalPlaceTypes)}`;
export const accessibilityValues = `One of: ${formatOneOf(placeAccessibilities)}`;

// ── Character ────────────────────────────────────────────────────────────
export const recognitionLevelValues = `One of: ${formatOneOf(characterRecognitionLevels)}`;
export const genderValues = `One of: ${formatOneOf(genders)}`;
export const characterStatusValues = `One of: ${formatOneOf(characterStatuses)}`;
export const characterImportanceValues = `One of: ${formatOneOf(characterImportances)}`;
export const relationshipTypeValues = `One of: ${formatOneOf(relationshipTypes)}`;
export const relationshipStatusValues = `One of: ${formatOneOf(relationshipStatuses)}`;
export const twistTypeValues = `One of: ${formatOneOf(potentialTwistTypes)}`;

// ── Flag updates (no "One of:" prefix — inline inside a JSON example) ────
export const psychologicalFlagTypeValues = `${formatOneOf(psychologicalFlagsTypes)}`;
export const flagLevelValues = `${formatOneOf(flagLevels)}`;
