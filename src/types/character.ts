import type { Gender, KnownGender } from "./user.js";

/**
 * Main character profile for psychological thriller stories
 * 
 * This type defines the core character information and psychological profile
 * of the main character (MC) for branching narrative stories. The psychological
 * profile enables personalized narrative manipulation and adaptive storytelling
 * based on character behavior patterns.
 * 
 * @interface StoryMC
 */
export interface StoryMC {
  /** Character's display name used throughout the narrative */
  name: string;
  /** Character's age in years, influences perspective and experiences */
  age: number;
  /** Character's gender, affects narrative voice and social dynamics */
  gender: KnownGender;
  /** Character's bio */
  bio: string;
}

export type StoryMCCandidate = Partial<StoryMC>;
export type StoryMCTranslation = Pick<StoryMC, 'bio'>;

// ============================================================================
// NARRATIVE CHARACTER MEMORY SYSTEM
// ============================================================================

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
  "enemy",       // Hostile relationship
  "mentor",      // Teacher/student, guidance relationship
  "rival"        // Competitive relationship
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
 * 
 * - "trusting": Helpful, shares items, believes the target's warnings.
 * - "neutral": Passive, follows the group, doesn't interfere.
 * - "suspicious": Questions the target, refuses to share info, acts paranoid.
 * - "hostile": Actively dangerous, sets traps, alerts enemies.
 */
export const relationshipStatuses = [
  "trusting",    // Positive, friendly, helpful, reliable connection
  "neutral",     // Indifferent, baseline state, background character
  "suspicious",  // Distrustful, hiding something, potentially hostile
  "hostile",     // Actively opposed/working against target
  "afraid"
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
export type CharacterRelationship = CharacterRelationshipContext & {
  /** Target character name (excluding MC, for MC use `relationshipToMC`) */
  target: string;
};

export type CharacterRelationshipContext = {
  /** Type of relationship connection */
  type: RelationshipType;
  /** Current emotional status of relationship */
  status: RelationshipStatus;
  /** Define relationship context */
  context: string;
  // /** Trust level (0.0 - 1.0) */
  // trust: number;
};

/**
 * Relationship update structure for AI output
 * 
 * Used to modify existing relationships or create new ones
 * based on story events.
 */
export type RelationshipUpdate =
  Pick<CharacterRelationship, 'target' | 'context'> &
  Partial<Pick<CharacterRelationship, 'type' | 'status'>> & {
  /** Source character initiating the relationship change (excluding MC) */
  source: string;
};

/**
 * Available character statuses for tracking narrative relationships
 * 
 * These statuses determine how characters behave and interact with the MC,
 * driving their behavior more than basic demographics.
 */
export const characterStatuses = [
  ...relationshipStatuses,
  "missing",     // Disappeared, absent from story
  "injured",     // 
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
  "betrayal",      // Character betrays MC or others
  "identity",      // Character is not who they appear to be
  "disappearance", // Character vanishes mysteriously
  "possession",    // Character is possessed or controlled
  "none"           // No planned twist
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
  /** Character visual description, e.g. "tall, pale, messy black hair, hollow eyes" */
  visualDescription: string;
  /** Current relationship status affecting behavior */
  status: CharacterStatus;
  /** Secret or hint for AI guidance (spoiler) */
  secrets: string[];
  /** Relationship to main character */
  relationshipToMC: CharacterRelationshipContext;
  /** Directional relationships to other characters (max 3) */
  relationships: CharacterRelationship[];
  /** Recent important interactions (max MAX_PAST_INTERACTIONS, sliding window) */
  pastInteractions: PastInteraction[];
  /** Narrative control flags for plot development */
  narrativeFlags: NarrativeFlags;
  /** Whether character has injury */
  injuries: Injury[];
  /** The page number at which the character was introduced */
  introducedAtPage: number;
};

export type NewCharacter = Omit<CharacterMemory, 'introducedAtPage' | 'pastInteractions' | 'injuries' | 'relationships'> & { pastInteractions?: string[], injuries: InitialInjury[] };

/**
 * Character update structure for AI output
 * 
 * When AI modifies existing characters, it provides updates in this format
 * to maintain character development and plot progression.
 * 
 * @interface CharacterUpdate
 */
export type CharacterUpdate = Partial<NewCharacter>;

/**
 * Complete character updates structure for AI JSON output
 * 
 * This structure allows the AI to create new characters and update
 * existing ones in a single response, maintaining narrative flow.
 */
export type CharacterUpdates = {
  /** New characters introduced in this page */
  newCharacters?: NewCharacter[];
  /** Updates to existing characters */
  updatedCharacters?: CharacterUpdate[];
};

export type InventoryItem = {
  /** The name of the item */
  name: string;
  /** The traits of the item (e.g., color, length, state, rules, etc) */
  traits?: Record<string, string>;
  /** The quantity of the item */
  amount?: number;
  /** The location or context of the item (e.g., "in backpack", "on the table", "worn by the character") */
  where?: string;
  /** The page number where the item was acquired */
  pageAcquired?: number;
  /** Place where the item acquired (optional). */
  place?: string;
}

export type InitialInventoryItem = Omit<InventoryItem, 'pageAcquired' | 'place'>;

/** Represents an injury sustained by a character */
export type Injury = {
  /** The body part that was injured */
  bodyPart?: string;
  /** Description of the injury */
  description?: string;
  /** Severity level of the injury (0.0-1.0), decays overtime */
  severity?: number;
  /** Severity decay rate per page (0.0-1.0) */
  decayPerPage?: number;
  /** Consequences of the injury, e.g. "Cannot run fast" */
  consequences?: string;
  /** The page number where the injury was acquired */
  pageAcquired?: number;
  /** Place where the injury acquired (optional). */
  place?: string;
};

export type InitialInjury = Omit<Injury, 'pageAcquired' | 'place'>;

export const injurySeverities = [
  "mild",
  "moderate", 
  "severe",
  "critical",
  "permanent",
  "none"
] as const;

export type InjurySeverity = typeof injurySeverities[number];

/** Represents a past interaction between characters */
export type PastInteraction = {
  /** The page number of the interaction */
  page: number;
  /** The interaction between characters */
  interaction: string;
  /** The place where the interaction occurred. */
  place?: string;
};