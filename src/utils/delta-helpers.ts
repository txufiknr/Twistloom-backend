/**
 * Delta Creation Helper Utilities
 * 
 * Provides reusable utility functions for creating StateDelta objects
 * to eliminate code duplication and ensure type safety.
 */

import type { 
  StateDelta, 
  PsychologicalFlags, 
  PsychologicalProfile, 
  HiddenState
} from "../types/story.js";
import type { CharacterMemory, CharacterRelationship, NarrativeFlags } from "../types/character.js";
import type { PlaceMemory } from "../types/places.js";

/**
 * Creates a partial delta object for complex nested objects
 * 
 * @param fromObj - Previous object state
 * @param toObj - New object state
 * @param typedKeys - Valid keys for the object type
 * @returns Partial delta object with only changed fields
 */
function createObjectDelta<T extends Record<string, any>>(
  fromObj: T,
  toObj: T,
  typedKeys: (keyof T)[]
): Partial<T> {
  const delta: Partial<T> = {};
  
  for (const key of typedKeys) {
    const typedKey = key as keyof T;
    const fromValue = fromObj[typedKey];
    const toValue = toObj[typedKey];
    
    // Deep comparison for complex objects
    if (typeof fromValue === 'object' && typeof toValue === 'object') {
      if (JSON.stringify(fromValue) !== JSON.stringify(toValue)) {
        // Use proper type assertion instead of 'any'
        (delta as Record<keyof T, T[keyof T]>)[typedKey] = toValue;
      }
    } else if (fromValue !== toValue) {
      // Use proper type assertion instead of 'any'
      (delta as Record<keyof T, T[keyof T]>)[typedKey] = toValue;
    }
  }
  
  return delta;
}

/**
 * Creates delta for PsychologicalFlags object
 */
export function createPsychologicalFlagsDelta(
  fromFlags: PsychologicalFlags,
  toFlags: PsychologicalFlags
): Partial<PsychologicalFlags> {
  return createObjectDelta(fromFlags, toFlags, [
    'trust', 'fear', 'guilt', 'curiosity'
  ] as const);
}

/**
 * Creates delta for PsychologicalProfile object
 */
export function createPsychologicalProfileDelta(
  fromProfile: PsychologicalProfile,
  toProfile: PsychologicalProfile
): Partial<PsychologicalProfile> {
  return createObjectDelta(fromProfile, toProfile, [
    'archetype', 'stability', 'dominantTraits', 'manipulationAffinity'
  ] as const);
}

/**
 * Creates delta for HiddenState object
 */
export function createHiddenStateDelta(
  fromHidden: HiddenState,
  toHidden: HiddenState
): Partial<HiddenState> {
  return createObjectDelta(fromHidden, toHidden, [
    'truthLevel', 'threatProximity', 'realityStability'
  ] as const);
}

/**
 * Creates delta for CharacterMemory object
 */
export function createCharacterMemoryDelta(
  fromChar: CharacterMemory,
  toChar: CharacterMemory
): Partial<CharacterMemory> {
  return createObjectDelta(fromChar, toChar, [
    'name', 'gender', 'age', 'role', 'bio', 'status', 'relationshipToMC',
    'relationships', 'pastInteractions', 'lastInteractionAtPage', 'narrativeFlags'
  ] as (keyof CharacterMemory)[]);
}

/**
 * Creates delta for PlaceMemory object
 */
export function createPlaceMemoryDelta(
  fromPlace: PlaceMemory,
  toPlace: PlaceMemory
): Partial<PlaceMemory> {
  return createObjectDelta(fromPlace, toPlace, [
    'name', 'type', 'description', 'atmosphere', 'security', 'resources', 'secrets'
  ] as (keyof PlaceMemory)[]);
}
