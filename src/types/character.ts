import type { TraitItem, MemoryIntegrity, FearLevel } from "./story.js";
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
  /** Character's known name in narrative */
  knownName?: string;
  /** Character's picture (uploaded by author) */
  imageUrl?: string;
  /** Character's uploaded image ID */
  imageId?: string;
}

export type StoryMCGeneration = Omit<StoryMC, 'imageId' | 'imageUrl'>;
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
  // TODO: add "partner"?
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
  "stranger",    // Never met nor get to know
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
  /** Target character ID (excluding MC, for MC use `relationshipToMC`) */
  targetId: string;
};

export type CharacterRelationshipContext = {
  /** Type of relationship connection */
  type: RelationshipType;
  /** Current emotional status of relationship */
  status: RelationshipStatus;
  /** Define relationship context */
  context: string;
  /** Character recognition level */
  recognitionLevel: CharacterRecognitionLevel;
  // /** Trust level (0.0 - 1.0). But redundant with `RelationshipStatus.trusting`. */
  // trust: number;
};

/**
 * Relationship update structure for AI output
 * 
 * Used to modify existing relationships or create new ones
 * based on story events.
 */
export type RelationshipUpdate =
  Pick<CharacterRelationship, 'targetId' | 'context' | 'recognitionLevel'> &
  Partial<Pick<CharacterRelationship, 'type' | 'status'>> & {
  /** Source character ID initiating the relationship change (excluding MC) */
  sourceId: string;
};

/**
 * Character Recognition Level
 * This mirrors how humans actually learn people.
 * 
 * | Level              | Meaning                                | Allowed                            |
 * | ------------------ | -------------------------------------- | ---------------------------------- |
 * | `never_seen`       | Never encountered this character       | "someone", "a figure"              |
 * | `seen`             | Encountered them but doesn't know name | "the tall man", "the woman in red" |
 * | `alias_known`      | Knows a nickname/codename              | "The Janitor"                      |
 * | `first_name_known` | Knows first name                       | "Elias"                            |
 * | `full_name_known`  | Knows full identity                    | "Elias Voss"                       |
 */
export const characterRecognitionLevels = [
  'never_seen',
  'seen',
  'alias_known',
  'first_name_known',
  'full_name_known'
] as const;

export type CharacterRecognitionLevel = typeof characterRecognitionLevels[number];

/**
 * Available character statuses for tracking narrative relationships
 * 
 * These statuses determine how characters behave and interact with the MC,
 * driving their behavior more than basic demographics.
 */
export const characterStatuses = [
  "active",      // Present and healthy
  "missing",     // Disappeared from the current setting
  "dead"         // Deceased
] as const;

/**
 * Union type of all possible character status values
 */
export type CharacterStatus = typeof characterStatuses[number];

export const characterImportances = ['major', 'supporting', 'minor'] as const;
export type CharacterImportance = typeof characterImportances[number];

export type CharacterPlan = Pick<CharacterMemory, 'knownName' | 'realName' | 'gender' | 'role' | 'bio' | 'visualDescription' | 'importance'> & {
  characterId: string;
  plannedIntroduction?: string;
  storyPurpose?: string;
};

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
  /** Potential twist type planned for this character */
  potentialTwist: PotentialTwistType;
  // Any other non-status mechanical flags (e.g., isPlotEssential: boolean)
};

/**
 * Complete character memory structure for narrative consistency
 * 
 * This type defines the full character schema including relationships
 * to other characters, enabling complex character dynamics and plot development.
 * 
 * @interface CharacterMemory
 */
/**
 * Schedule window for an NPC — when they are available / present.
 *
 * The world doesn't wait for the reader; characters have routines
 * that create natural friction and consequence.
 */
export type CharacterSchedule = {
  /** When in the day this character is typically present */
  availabilityWindow: string; // e.g., "night", "day", "evening", "dawn", "all", "unknown"
  /** Location/placeId they are usually found at during their window */
  locationId: string;
  /** Optional description of what happens if the reader misses them */
  missedConsequence?: string;
};

export type CharacterMemory = {
  /** Character's known name in narrative (e.g., "The Janitor") */
  knownName: string;
  /** Character's real full name - never changed throughout story */
  realName: string;
  /** Character's gender (male/female/unknown) */
  gender: Gender;
  /** Character's role or occupation in the story */
  role: string;
  /** Brief 1-sentence character description with hints */
  bio: string;
  /** Character visual description, e.g. "tall, pale, messy black hair, hollow eyes" */
  visualDescription: string;
  /** Character significance */
  importance: CharacterImportance;
  /** Physical narrative state (active/missing/dead) */
  status: CharacterStatus;
  /** Secret or hint for AI guidance (spoiler) */
  secrets: string[];
  /** Relationship to main character/behavioral state (trusting/suspicious/etc.) */
  relationshipToMC: CharacterRelationshipContext;
  /** Directional relationships to other characters (max 3) */
  relationships: CharacterRelationship[];
  /** Recent important interactions (max MAX_PAST_INTERACTIONS, sliding window) */
  pastInteractions: PastInteraction[];
  /** Narrative control flags (strict structural plot setup) */
  narrativeFlags: NarrativeFlags;
  /** Whether character has injury */
  injuries: Injury[];
  /** The page number at which the character was introduced */
  introducedAtPage: number;
  /** How well does MC know this character */
  recognitionLevel: CharacterRecognitionLevel;
  // /** Specific person they trust in an urgent situation */
  // emergencyContacts: string[];
  /**
   * NPC schedule: when/where this character can be found.
   * If set, the AI should respect these windows when deciding
   * whether a character is present.
   */
  schedule?: CharacterSchedule; // TODO: where it displayed?
  /** The traits of the character (e.g., skills, hobbies) */
  traits?: TraitItem[];
};

export type CharacterMemoryTranslation = Pick<CharacterMemory, 'role' | 'bio'> & { characterId: string };

// TODO: include schedule?
export type NewCharacter = Omit<CharacterMemory, 'introducedAtPage' | 'pastInteractions' | 'injuries' | 'relationships' | 'schedule'> & {
  characterId: string;
  pastInteractions?: string[];
  injuries?: InitialInjury[];
};

/**
 * Character update structure for AI output
 * 
 * When AI modifies existing characters, it provides updates in this format
 * to maintain character development and plot progression.
 * 
 * @interface CharacterUpdate
 */
export type CharacterUpdate = Partial<Omit<NewCharacter, 'realName' | 'pastInteractions' | 'traits'>> & {
  characterId: string;
  newInteractions?: string[];
  updateTraits?: TraitItem[];
  removeTraits?: string[];
};

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

export type ObjectItem = {
  /** The name of the item */
  name: string;
  /** The traits of the item (e.g., color, size, length, material, state, rules) */
  traits?: TraitItem[];
  /** The quantity of the item */
  amount?: number;
  /** The location or context of the item (e.g., "in backpack", "on the table", "worn by the character") */
  where?: string;
}

export type InventoryItem = ObjectItem & {
  /** The page number where the item was acquired */
  pageAcquired?: number;
  /** Place ID where the item acquired (optional). */
  placeId?: string;
}

export type InventoryItemTranslation = Pick<ObjectItem, 'name' | 'traits' | 'where'> & { originalName: string };

export type InitialInventoryItem = ObjectItem;

/**
 * Broad injury classification.
 *
 * Used by the health calculator to determine both physical and
 * psychological severity multipliers for each injury type.
 */
export const injuryCategories = [
  'bruise',
  'cut',
  'fracture',
  'burn',
  'internal',
  'poison',
  'infection',
  'exhaustion',
  'psychological',
] as const;

export type InjuryCategory = typeof injuryCategories[number];

/**
 * Represents an injury sustained by a character.
 */
export type Injury = {
  /** Body part affected. */
  bodyPart: string;
  /** Human-readable injury description. */
  description: string;
  /** Severity level (0–1), decays over time (0.1 = minor, 0.3 = moderate, 0.6 = severe, 0.9 = critical). */
  severity?: number;
  /** Broad injury classification. */
  category?: InjuryCategory;
  /** Severity reduction applied per page. */
  decayPerPage?: number;
  /** Functional consequences (e.g., "Cannot run", "Breathing is painful", "Left hand unusable"). */
  consequences?: string;
  /** Page where injury occurred. */
  pageAcquired?: number;
  /** Place where injury occurred. */
  placeId?: string;
};

export type InjuryTranslation = Pick<Injury, 'bodyPart' | 'description' | 'consequences'>;

export type InitialInjury = Omit<Injury, 'pageAcquired' | 'placeId'>;

export const injurySeverities = [
  "mild",
  "moderate",
  "severe",
  "critical",
  "permanent",
  "requires_treatment",
  "none"
] as const;

export type InjurySeverity = typeof injurySeverities[number];

/** Represents a past interaction between characters */
export type PastInteraction = {
  /** Page number of the interaction */
  page: number;
  /** Interaction between characters */
  interaction: string;
  /** Place ID where the interaction occurred. */
  placeId?: string;
};

/**
 * Per-dimension impact shape for a single body part.
 *
 * Splitting into four axes lets the config express the thriller-specific
 * truth that a knee fracture destroys mobility but barely touches action
 * capability, while a hand laceration destroys dexterity but doesn't
 * slow movement at all.
 *
 * These values are consumed directly by `getBodyPartImpact` and
 * `getInjuryScores` inside `calculateHealthStatus`.
 */
export type BodyPartImpact = {
  /**
   * Vitality drain — contributes to overall `healthPercent` loss.
   * Reflects systemic risk: how dangerous is damage to this body part?
   */
  health: number;
  /**
   * Movement cost — contributes to `mobilityPercent` loss.
   * Represents walking, running, climbing, and fleeing capability.
   * Leg/knee/ankle injuries dominate this axis in a thriller context.
   */
  mobility: number;
  /**
   * Dexterity cost — contributes to `actionPercent` loss.
   * Represents the ability to use hands/arms: opening doors, using tools,
   * climbing ropes, writing, wielding improvised weapons.
   * Shoulder/hand/wrist injuries dominate this axis.
   */
  action: number;
  /**
   * Psychological weight — multiplied by the category's `mental` factor.
   * Captures how traumatic this body part is to injure (head/eye → very high;
   * finger → low). Contributes to `mentalPercent` loss.
   */
  trauma: number;
};

/**
 * Per-dimension impact shape for an injury category.
 *
 * `physical` scales all three physical stat axes uniformly because a
 * fracture is more limiting than a bruise regardless of the affected body part.
 * `mental` is independent — each category carries its own psychological weight
 * (e.g. burns are far more mentally scarring than equivalent cuts; psychological
 * injuries barely register physically but spike mental damage).
 */
export type InjuryCategoryImpact = {
  /**
   * Physical severity multiplier.
   * Applied to all three physical damage dimensions: health, mobility, and action.
   */
  physical: number;
  /**
   * Mental/psychological impact multiplier.
   * Applied independently to the trauma dimension, decoupled from physical scaling.
   */
  mental: number;
};

/**
 * Context inputs required to compute `mentalPercent` in {@link HealthStatus}.
 *
 * These values come from the broader `StoryState` and are passed explicitly
 * to keep `calculateHealthStatus` a pure function of its inputs — no
 * implicit state threading required.
 *
 * When omitted, `mentalPercent` is derived from injury-based trauma only,
 * which underestimates deterioration. Always pass `mentalInputs` whenever
 * `StoryState` is available at the call site.
 */
export type MentalHealthInputs = {
  /** Total number of accumulated trauma tags (state.traumaTags.length). */
  traumaTagCount: number;
  /** Memory coherence level from state.memoryIntegrity. */
  memoryIntegrity: MemoryIntegrity;
  /** Current fear flag from state.flags.fear. */
  fearLevel: FearLevel;
};

export type HealthCondition = 'healthy' | 'injured' | 'wounded' | 'critical' | 'dying';

/**
 * Complete health status derived deterministically from `StoryMCState.injuries`
 * and optional `MentalHealthInputs`.
 * 
 * Axis:
 * - health: Systemic vitality drain
 * - mobility: Ability to flee and climb — the primary thriller tension axis
 * - action: Ability to use hands/tools — doors, phones, weapons, climbing
 * - trauma: Psychological weight of being injured there
 * 
 * Note:
 * Never authored by AI — always computed by `calculateHealthStatus`.
 *
 * Four independently-scaled 0–100 percentages (higher = better):
 *
 * | Stat             | Driven by                                                      |
 * |------------------|----------------------------------------------------------------|
 * | `healthPercent`  | Physical vitality — severity × category × body part (health)  |
 * | `mobilityPercent`| Flee/escape capability — lower-body and back injuries dominate |
 * | `actionPercent`  | Tool/hand use — upper-limb injuries dominate                   |
 * | `mentalPercent`  | Psychological integrity — injury trauma + memory + fear + tags |
 *
 * `condition` is a narrative label derived from `healthPercent` thresholds:
 * ≥ 85 → healthy | ≥ 65 → injured | ≥ 40 → wounded | ≥ 15 → critical | < 15 → dying
 *
 * `actionPercent` for thriller appropriateness to manipulate objects,
 * open doors, climb, and wield improvised items.
 */
export type HealthStatus = {
  /** Narrative label useful for UI display. */
  condition: HealthCondition;
  /** Overall physical health (100 = fully healthy, 0 = near death). */
  healthPercent: number;
  /** Movement capability: running, climbing, fleeing (100 = unimpaired). */
  mobilityPercent: number;
  /** Action capability: using hands/arms/tools, defending self (100 = unimpaired). */
  actionPercent: number;
  /** Psychological integrity (100 = mentally intact, 0 = complete breakdown). */
  mentalPercent: number;
};