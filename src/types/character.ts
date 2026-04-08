import type { Gender, KnownGender } from "./user.js";

export const injurySeverities = [
  "mild",
  "moderate", 
  "severe",
  "critical",
  "none"
] as const;

export type InjurySeverity = typeof injurySeverities[number];

/**
 * Main character profile for psychological thriller stories
 * 
 * This type defines the core character information and psychological profile
 * of the main character (MC) for branching narrative stories. The psychological
 * profile enables personalized narrative manipulation and adaptive storytelling
 * based on character behavior patterns.
 * 
 * @interface StoryMCCandidate
 */
export type StoryMCCandidate = {
  /** Character's display name used throughout the narrative */
  name?: string;
  /** Character's age in years, influences perspective and experiences */
  age?: number;
  /** Character's gender, affects narrative voice and social dynamics */
  gender?: KnownGender;
};

export type StoryMC = Required<StoryMCCandidate>;

// ============================================================================
// NARRATIVE CHARACTER MEMORY SYSTEM
// ============================================================================

/**
 * Available character statuses for tracking narrative relationships
 * 
 * These statuses determine how characters behave and interact with the MC,
 * driving their behavior more than basic demographics.
 */
export const characterStatuses = [
  "trusting",    // Friendly, helpful, reliable
  "suspicious",  // Distrustful, hiding something, potentially hostile
  "neutral",     // Indifferent, background character
  "missing",     // Disappeared, absent from story
  "hostile",     // Actively working against MC
  "injured",
  "dead"         // Deceased, may appear in memories/ghosts
] as const;

/**
 * Union type of all possible character status values
 */
export type CharacterStatus = typeof characterStatuses[number];

/**
 * Available potential twist types for characters
 * 
 * These determine the type of plot twist or revelation that may
 * occur involving this character, enabling narrative planning.
 */
export const potentialTwistTypes = [
  "betrayal",     // Character betrays MC or others
  "identity",      // Character is not who they appear to be
  "disappearance", // Character vanishes mysteriously
  "possession",   // Character is possessed or controlled
  "none"          // No planned twist
] as const;

/**
 * Union type of all possible potential twist type values
 */
export type PotentialTwistType = typeof potentialTwistTypes[number];

/**
 * Narrative flags for character plot control and twist setup
 * 
 * These flags control character behavior patterns and enable narrative twists.
 * They serve as the control layer for character-driven plot developments.
 */
export type NarrativeFlags = {
  /** Whether character is hiding something important */
  isSuspicious: boolean;
  /** Whether character has disappeared from the story */
  isMissing: boolean;
  /** Whether character is deceased */
  isDead: boolean;
  /** Whether character has injury */
  hasInjury: InjurySeverity;
  /** Whether character holds a secret that could be revealed */
  hasSecret: boolean;
  /** Potential twist type for this character */
  potentialTwist: PotentialTwistType;
};

/**
 * Complete character memory structure for narrative consistency
 * 
 * This type defines the full character schema including relationships
 * to other characters, enabling complex character dynamics and plot development.
 * 
 * @interface CharacterMemory
 */
export type CharacterMemory = {
  /** Character's unique name identifier */
  name: string;
  /** Character's gender (male/female/unknown) */
  gender: Gender;
  /** Character's role in the story */
  role: string;
  /** Brief 1-sentence character description with hints */
  bio: string;
  /** Current relationship status affecting behavior */
  status: CharacterStatus;
  /** Relationship to main character */
  relationshipToMC: string;
  /** Directional relationships to other characters (max 3) */
  relationships: CharacterRelationship[];
  /** Recent important interactions (max 5, sliding window) */
  pastInteractions: string[];
  /** Last page where character appeared */
  lastInteractionAtPage: number;
  /** Narrative control flags for plot development */
  narrativeFlags: NarrativeFlags;
};

/**
 * Character update structure for AI output
 * 
 * When AI modifies existing characters, it provides updates in this format
 * to maintain character development and plot progression.
 * 
 * @interface CharacterUpdate
 */
export type CharacterUpdate = Pick<CharacterMemory, 'name' | 'gender' | 'status' | 'pastInteractions' | 'lastInteractionAtPage' | 'narrativeFlags'>;

/**
 * Available relationship types for character connections
 * 
 * Lightweight set of relationship categories to avoid over-complexity
 * while enabling meaningful character dynamics.
 */
export const relationshipTypes = [
  "friend",      // Close personal bond
  "family",      // Blood or chosen family
  "knows",       // Acquaintance/familiarity
  "stranger",    // Unknown character
  "enemy"        // Hostile relationship
] as const;

/**
 * Union type of all possible relationship type values
 */
export type RelationshipType = typeof relationshipTypes[number];

/**
 * Available relationship status values for dynamic evolution
 * 
 * These represent the emotional state that can change over time,
 * enabling plot developments and betrayals.
 */
export const relationshipStatuses = [
  "trusting",    // Positive, reliable connection
  "neutral",     // Indifferent, baseline state
  "uneasy",      // Suspicious but not hostile
  "suspicious",  // Distrustful, hiding something
  "hostile"      // Actively opposed
] as const;

/**
 * Union type of all possible relationship status values
 */
export type RelationshipStatus = typeof relationshipStatuses[number];

/**
 * Individual relationship between two characters
 * 
 * Represents a directional connection from one character to another,
 * with type and current emotional status.
 */
export type CharacterRelationship = {
  /** Target character name */
  target: string;
  /** Type of relationship connection */
  type: RelationshipType;
  /** Current emotional status of relationship */
  status: RelationshipStatus;
};

/**
 * Relationship update structure for AI output
 * 
 * Used to modify existing relationships or create new ones
 * based on story events.
 */
export type RelationshipUpdate = {
  /** Source character initiating the relationship change */
  source: string;
  /** Target character being related to */
  target: string;
  /** New relationship type (optional) */
  type?: RelationshipType;
  /** New relationship status */
  status: RelationshipStatus;
};

/**
 * Complete character updates structure for AI JSON output
 * 
 * This structure allows the AI to create new characters and update
 * existing ones in a single response, maintaining narrative flow.
 */
export type CharacterUpdates = {
  /** New characters introduced in this page */
  newCharacters: CharacterMemory[];
  /** Updates to existing characters */
  updatedCharacters: CharacterUpdate[];
  /** Updates to character relationships */
  relationshipUpdates?: RelationshipUpdate[];
};