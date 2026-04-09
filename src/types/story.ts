import type { Book } from "./book.js";
import type { CharacterMemory, CharacterUpdates } from "./character.js";
import type { PlaceMemory, PlaceUpdates } from "./places.js";
import type { DBPage, DBUserSession } from "./schema.js";

/**
 * Available moods for story pages
 * 
 * These moods define the emotional atmosphere of each story page
 * and help guide the AI's tone and emotional direction.
 * 
 * Additionally, moods can be used to determine appropriate
 * background music or audio atmosphere for enhanced immersion.
 */
export const moods = [
  "calm",
  "uneasy",
  "fear",
  "eerie", // unsettling, strange atmosphere
  "tense", // high tension, anticipation of danger
  "dread", // deep feeling of impending doom
  "panic", // overwhelming fear and urgency
  "confusion", // disorientation, unclear reality
  "suspicious", // distrust, feeling of being watched
  "hopeless", // no escape, despair
  "relief", // temporary safety or resolution
  "sad", // grief, loss, melancholy
  "distorted", // warped perception, unreality
  "urgency", // time pressure, immediate need to act
  "shock", // sudden revelation or horror
  "other" // catch-all for unique emotional states
];

/**
 * Available ending archetypes for psychological thriller stories
 * 
 * These define the ultimate resolution pattern and twist type
 * that the story will build toward throughout its progression.
 */
export const endingTypes = {
  /** MC thinks they escaped → final twist reveals they didn’t */
  "fake_escape": "MC thinks they escaped → final twist reveals they didn't; temporary escapes, recurring situations",
  /** Story ends where it began (or implied repetition) */
  "loop": "Story ends where it began → déjà vu, familiar patterns, repeated phrases, cyclical events",
  /** MC is not who they think they are */
  "identity_twist": "MC is not who they think they are → memory contradictions, reflection issues, questioned identity",
  /** MC loses something crucial permanently */
  "irreversible_loss": "MC loses something crucial permanently → permanent consequences, stake emphasis, unrecoverable things",
  /** Ending is unclear and open to interpretation */
  "ambiguity": "Ending is unclear and open to interpretation → multiple interpretations, unclear resolutions, missing details",
  /** The world itself is not real (or partially fabricated) */
  "false_reality": "The world itself is not real → reality inconsistencies, strange objects, 'wrong' world moments",
  /** Key relationships/events are products of MC's mental state */
  "mental_fabrication": "Key relationships/events are products of MC's mental state → questionable relationships, inconsistent memories, unreliable perceptions"
};

/**
 * Available action types for user choices
 * 
 * These categorize player actions to determine psychological impact
 * and appropriate narrative responses from the AI.
 */
export const actionTypes = {
  "explore": "Investigate, examine, search, discover, observe, learn",
  "escape": "Run away, hide, avoid danger, withdraw, panic",
  "social": "Interact, communicate, help, console, cooperate, teach",
  "risk": "Take chances, make bold moves, challenge, resist",
  "ignore": "Avoid engagement, dismiss events, submit, surrender",
  "attack": "Aggressive actions, fight, confront, destroy",
  "deceive": "Lie, manipulate, hide truth, betray",
  "protect": "Defend others, shield from harm, sacrifice",
  "create": "Build something new, artistic expression, innovate",
  "heal": "Repair damage, restore health/trust",
  "dialogue": "Interact with other characters",
  "custom": "Custom prompt from reader",
  "other": "Catch-all for uncategorized actions"
};

/**
 * Union type of all possible mood values
 * 
 * Generated from the moods array to ensure type safety
 * and autocomplete support for mood selection.
 */
export type Mood = typeof moods[number];

/**
 * Union type of all possible ending archetype keys
 * 
 * Generated from the endings object to ensure type safety
 * when specifying target story endings.
 */
export type EndingType = typeof endingTypes[keyof typeof endingTypes];

/**
 * Union type of all possible action type values
 * 
 * Generated from the actionTypes array to ensure type safety
 * for categorizing user actions.
 */
export type ActionType = typeof actionTypes[keyof typeof actionTypes];

export type AIParameterValue = { adjustment: number, min: number, max: number };
export type AIActionConfig = { temperature: AIParameterValue, topP: AIParameterValue, topK: AIParameterValue };

/**
 * Core inputs for Narrative Style Engine
 * 
 * These represent the fundamental inputs that determine narrative style
 * based on story state, player psychology, and progression.
 */
export type StyleInput = {
  /** Current sanity level (0.0–1.0) */
  sanity: number;
  /** Current tension level (0.0–1.0) */
  tension: number;
  /** World entropy/instability (from entropy controller) */
  entropy: number;
  /** Accumulated trauma tags affecting narrative tone */
  traumaTags: string[];
  /** Player psychological profile based on action history */
  profile: PsychologicalProfileMetrics;
  /** Current page number */
  page: number;
  /** Whether story is in ending phase */
  isEnding: boolean;
};

/**
 * Style vector controlling narrative characteristics
 * 
 * Each dimension affects how the story feels and is written
 */
export type StyleVector = {
  /** Sentence length: short ↔ mixed ↔ longer */
  sentenceLength: number;
  /** Fragmentation: broken thoughts, interrupted sentences */
  fragmentation: number;
  /** Repetition: emotional echo, recurring phrases */
  repetition: number;
  /** Contradiction: self-doubt, reversal of thoughts */
  contradiction: number;
  /** Clarity: how understandable the narration is */
  clarity: number;
  /** Pacing: fast vs slow narration */
  pacing: number;
  /** Sensory focus: detail vs abstract descriptions */
  sensoryFocus: number;
};

/**
 * Narrative style modes with human-readable characteristics
 */
export type NarrativeMode = "grounded" | "uneasy" | "fractured";

/**
 * Complete narrative style configuration
 */
export type NarrativeStyle = {
  /** Current mode based on sanity and conditions */
  mode: NarrativeMode;
  /** Calculated style vector for AI guidance */
  vector: StyleVector;
  /** Human-readable instructions for AI */
  instructions: string;
};

/**
 * Available action types for user choices
 * 
 * These categorize player actions to determine psychological impact
 * and appropriate narrative responses from AI.
 */
export const actionHintTypes = [
  "dark_discovery",
  "relationship_revelation",
  "betrayal",
  "confrontation",
  "truth_revelation",
  "survival",
  "psychological",
  "custom",
  "none",
] as const;

export type ActionHintType = typeof actionHintTypes[number];

export type ActionHint = {
  text: string;
  type: ActionHintType;
}

export type TrustLevel = "low" | "medium" | "high";
export type FearLevel = "low" | "medium" | "high";
export type GuiltLevel = "low" | "medium" | "high";
export type CuriosityLevel = "low" | "medium" | "high";

/**
 * Psychological flags that influence narrative direction
 * 
 * These flags track the MC's mental state and affect how
 * the world responds and events unfold.
 */
export type PsychologicalFlags = {
  /** Level of trust in other characters and environment */
  trust: TrustLevel;
  /** Current fear level affecting perception and actions */
  fear: FearLevel;
  /** Accumulated guilt from past actions and consequences */
  guilt: GuiltLevel;
  /** Drive to investigate vs avoid danger */
  curiosity: CuriosityLevel;
};

export type Ending = {
  text?: string;
  type?: EndingType;
}

/**
 * Available ending execution strategy types
 * 
 * These define the different approaches to executing story endings,
 * each creating unique psychological experiences and narrative patterns.
 */
export type EndingPlanType = 
  | "fake_relief_twist"   // False sense of security followed by horror
  | "loop_trap"          // Time loop or repeating nightmare
  | "identity_reveal"    // Shocking truth about MC's identity
  | "unreliable_reality" // Reality distortion and unreliability
  | "possession"         // Supernatural possession or control
  | "silent_void"        // Existential dread and emptiness
  | "observer_twist";    // Being watched by unknown entity

/**
 * Advanced ending execution plan
 */
export type EndingPlan = {
  /** Type of ending execution strategy */
  type: EndingPlanType;
  /** Whether the ending plan is armed and ready to execute */
  armed: boolean;
  /** Page number to trigger the ending sequence */
  triggerPage: number;
  /** Whether this is a fake ending followed by real ending */
  fakeToReal?: boolean;
};

/**
 * Types of behavioral shifts that can trigger dynamic ending mutations
 */
export type ProfileShiftType = 
  | "curiosity_collapse" // Explorer becomes avoidant
  | "fear_spike" // Brave character becomes panicked
  | "aggression_turn" // Peaceful becomes aggressive
  | "deception_onset" // Honest becomes deceptive
  | "social_withdrawal" // Social becomes isolated
  | "protective_to_aggressive" // Protector becomes attacker
  | "creative_to_destructive" // Creator becomes destroyer
  | "denial_break" // Reality denial breaks
  | "trust_betrayal" // Trust is broken
  | "archetype_collapse" // Fundamental behavioral pattern change
  | "reality_breakdown" // Mental coherence collapse
  | "manipulation_acceptance" // Accepts manipulation
  | "trait_inversion" // Dominant traits reverse
  | "fear_to_aggression"; // Fear turns to rage

/**
 * Profile shift detection for dynamic ending mutation
 */
export type ProfileShift = {
  /** Whether a significant behavior change was detected */
  detected: boolean;
  /** Type of behavioral shift */
  shiftType: ProfileShiftType;
  /** When the shift was detected */
  detectedAt: number;
  /** Original ending type before shift */
  originalEnding?: EndingType;
};

/**
 * Available truth levels for narrative deception
 * 
 * These define how much truth vs deception is present in the narrative
 * and guide the AI's approach to information and reliability.
 */
export const truthLevels = {
  /** Grounded in reality, minimal deception */
  "low": "Low→grounded | Minimal deception, reliable information, clear cause and effect",
  /** Mix of truth and inconsistencies */
  "medium": "Medium→inconsistencies | Some deception, unreliable narrator, contradictory information",
  /** Heavy deception and manipulation */
  "high": "High→deception/contradictions | Heavy deception, gaslighting, reality manipulation"
};

/**
 * Available threat proximity levels
 * 
 * These define the proximity of immediate danger or threat
 * and guide the pacing and intensity of narrative tension.
 */
export const threatProximities = {
  /** Distant threat, slow build */
  "far": "Far→slow build | Distant threat, atmospheric tension, gradual escalation",
  /** Approaching danger, increasing urgency */
  "near": "Near→approaching | Approaching danger, time pressure, mounting stakes",
  /** Immediate confrontation or danger */
  "immediate": "Immediate→confrontation/urgency | Immediate threat, life-or-death, panic responses"
};

/**
 * Available reality stability levels
 * 
 * These define the stability of reality and physical laws
 * and guide how much the world can break or warp.
 */
export const realityStabilities = {
  /** Normal, predictable reality */
  "stable": "Stable→logical | Normal reality, consistent physics, reliable world rules",
  /** Reality starting to break down */
  "slipping": "Slipping→strange events | Reality breaking, impossible events, world inconsistencies",
  /** Completely broken or surreal reality */
  "broken": "Broken→surreal/impossible | Surreal reality, broken physics, dream logic"
};

/**
 * Union type of all possible truth level keys
 */
export type TruthLevel = typeof truthLevels[keyof typeof truthLevels];

/**
 * Union type of all possible threat proximity keys
 */
export type ThreatProximity = typeof threatProximities[keyof typeof threatProximities];

/**
 * Union type of all possible reality stability keys
 */
export type RealityStability = typeof realityStabilities[keyof typeof realityStabilities];

/**
 * Hidden narrative state not directly visible to users
 * 
 * These values guide the AI's narrative decisions without explicitly revealing story mechanics to the player.
 */
export type HiddenState = {
  /** How much truth vs deception is present in the narrative */
  truthLevel: TruthLevel;
  /** Proximity of immediate danger or threat */
  threatProximity: ThreatProximity;
  /** Stability of reality and physical laws */
  realityStability: RealityStability;
  /** Advanced ending execution plan */
  endingPlan?: EndingPlan;
  /** Profile shift detection for dynamic ending mutation */
  profileShift?: ProfileShift;
};

/**
 * Integrity of the MC's memory and perception
 * 
 * Affects how reliably past events are recalled and
 * whether contradictions appear in the narrative.
 */
export type MemoryIntegrity = "stable" | "fragmented" | "corrupted";

/**
 * Overall story difficulty and psychological pressure
 * 
 * Determines the intensity of psychological elements,
 * frequency of twists, and reliability of narration.
 */
export type Difficulty = "low" | "medium" | "high" | "nightmare";

/**
 * Available psychological archetypes for MC behavior patterns
 * 
 * These define the primary behavioral patterns that influence how the MC
 * approaches challenges and responds to narrative events.
 */
export const archetypes = {
  /** Curious, seeks knowledge, investigates */
  "the_explorer": "Curious, seeks knowledge, investigates",
  /** Cautious, avoids danger, prefers safety */
  "the_avoider": "Cautious, avoids danger, prefers safety",
  /** Bold, takes chances, confrontational */
  "the_risk_taker": "Bold, takes chances, confrontational",
  /** Suspicious, distrustful, fearful */
  "the_paranoid": "Suspicious, distrustful, fearful",
  /** Remorseful, self-blaming, haunted */
  "the_guilty": "Remorseful, self-blaming, haunted",
  /** In denial, avoids truth, rationalizes */
  "the_denier": "In denial, avoids truth, rationalizes"
};

/**
 * Available stability levels for psychological profiles
 * 
 * These define the current mental coherence and stability of the MC.
 */
export const stabilityLevels = {
  /** Mentally coherent, rational thinking */
  "stable": "Mentally coherent, rational thinking → Subtle manipulation, gradual escalation",
  /** Under stress, showing cracks in composure */
  "cracking": "Under stress, showing cracks in composure → More direct psychological attacks, visible stress",
  /** Severely distressed, reality breakdown */
  "unstable": "Severely distressed, reality breakdown → Full psychological warfare, reality breakdown"
};

/**
 * Available manipulation affinities for psychological targeting
 * 
 * These define the most effective psychological manipulation vectors
 * for each MC profile.
 */
export const manipulationAffinities = {
  /** Threats, danger, pursuit, urgency */
  "fear": "Immediate dangers, pursuit, time pressure, personally targeted threats",
  /** Past mistakes, moral pressure, consequences */
  "guilt": "Echo past mistakes, deserved consequences, moral pressure",
  /** Contradictions, unclear reality, memory issues */
  "confusion": "Target reasoning patterns, distorted reality, question perceptions",
  /** Relationships, emotional bonds, loss */
  "attachment": "Painful relationships, threatened connections, emotional leverage",
  /** Helplessness, traps, forced situations */
  "control_loss": "Removed agency, decision-based traps, personal helplessness"
};

/**
 * Union type of all possible archetype keys
 * 
 * Generated from the archetypes object to ensure type safety
 * when specifying MC behavioral patterns.
 */
export type Archetype = typeof archetypes[keyof typeof archetypes];

/**
 * Union type of all possible stability level keys
 * 
 * Generated from the stabilityLevels object to ensure type safety
 * when specifying MC mental states.
 */
export type StabilityLevel = typeof stabilityLevels[keyof typeof stabilityLevels];

/**
 * Union type of all possible manipulation affinity keys
 * 
 * Generated from the manipulationAffinities object to ensure type safety
 * when specifying psychological targeting vectors.
 */
export type ManipulationAffinity = typeof manipulationAffinities[keyof typeof manipulationAffinities];

/**
 * Psychological profile of the main character based on behavior patterns
 * 
 * This profile tracks MC's behavioral archetype and mental state to enable
 * personalized narrative manipulation and adaptive storytelling.
 */
export type PsychologicalProfile = {
  /** Primary behavioral pattern that defines MC's approach to challenges */
  archetype: Archetype;
  /** Current mental stability and coherence */
  stability: StabilityLevel;
  /** Prominent behavioral traits that influence decision-making */
  dominantTraits: string[];
  /** Most effective psychological manipulation vector for this MC */
  manipulationAffinity: ManipulationAffinity;
};

export type PsychologicalProfileMetrics = {
  /** Curiosity level from actions */
  curiosity: number;
  /** Fear level from actions */
  fear: number;
  /** Aggression level from actions */
  aggression: number;
  /** Denial level from actions */
  denial: number;
};

/**
 * Story page structure for AI-generated content
 * 
 * Contains the complete page content, metadata, and character updates
 * for maintaining narrative consistency and character development.
 * 
 * @interface StoryPage
 */
export type StoryPage = {
  /** Main story page content (60-120 words, first-person POV) */
  text: string;
  /** Current emotional atmosphere */
  mood?: Mood;
  /** Current place where the story is taking place */
  place?: string;
  /** Current time mark, e.g. time range, 'night', 'HH:mm', 'unknown' */
  timeOfDay?: string;
  /** Characters present in the page */
  charactersPresent?: string[];
  /** Key events that occurred in the page */
  keyEvents?: string[];
  /** Important objects mentioned in the page */
  importantObjects?: string[];
  /** Next branching actions for user choice (2-3 options) */
  actions: Action[];
  /** New trauma tag based on page events (empty string if none) */
  addTraumaTag?: string;
  /** Updates to characters (new and existing) */
  characterUpdates?: CharacterUpdates;
  /** Updates to places (new and existing) */
  placeUpdates?: PlaceUpdates;
};

export type StoryGeneration = StoryPage & {
  viableEnding?: Partial<Ending>;
  isMajorEvent?: boolean;
}

// export type PersistedStoryPage = StoryPage & { id: string, bookId: string, parentId?: string | null };
export type PersistedStoryPage = StoryPage & Pick<DBPage, 'id' | 'bookId' | 'branchId' | 'parentId' | 'page'>;
// export type ActionedStoryPage = Omit<PersistedStoryPage, 'selectedAction'> & { selectedAction: Action };
export type UserStoryPage = PersistedStoryPage & { selectedAction?: Action };
export type ActionedStoryPage = PersistedStoryPage & { selectedAction: Action };

export type Action = {
  /** Action text */
  text: string;
  /** Category of action for psychological impact */
  type: ActionType;
  /** Consequence hint for the action (for AI guidance) */
  hint: ActionHint;
  /** Destination page ID for the action */
  pageId?: string;
};

/**
 * Complete story state tracking all narrative and psychological elements
 * 
 * This comprehensive type maintains the entire state of a branching
 * psychological thriller story, including progression, psychological
 * flags, trauma accumulation, and hidden narrative mechanics.
 * 
 * @interface StoryState
 */
export type StoryState = {
  /** Page ID for the story */
  pageId: string;
  /** Current page number in the story progression */
  page: number;
  /** Maximum planned pages for the story */
  maxPage: number;

  /**
   * Psychological flags that influence narrative direction
   * These flags track the MC's mental state and affect how
   * the world responds and events unfold.
   */
  flags: PsychologicalFlags;

  /**
   * Collection of traumatic events and psychological markers
   * 
   * These tags echo throughout the narrative, influencing
   * hallucinations, environmental details, and character behavior.
   * Maximum of MAX_TRAUMA_TAGS most recent tags are maintained.
   */
  traumaTags: string[];

  /**
   * Psychological profile derived from behavior patterns
   * 
   * This structured profile enables personalized narrative manipulation
   * and adaptive storytelling based on MC's observed behaviors.
   * It tracks behavioral patterns, mental stability, and manipulation
   * vectors to enable adaptive storytelling that targets the character's
   * specific psychological makeup.
   */
  psychologicalProfile: PsychologicalProfile;

  /**
   * Hidden narrative state not directly visible to users
   * 
   * These values guide the AI's narrative decisions without explicitly revealing story mechanics to the player.
   */
  hiddenState: HiddenState;

  /**
   * Integrity of the MC's memory and perception
   * 
   * Affects how reliably past events are recalled and
   * whether contradictions appear in the narrative.
   */
  memoryIntegrity: MemoryIntegrity;

  /**
   * Overall story difficulty and psychological pressure
   * 
   * Determines the intensity of psychological elements,
   * frequency of twists, and reliability of narration.
   */
  difficulty: Difficulty;

  // /**
  //  * Cached ending archetype assigned at story progression milestone
  //  * 
  //  * This is set dynamically between 30-50% story progress to allow
  //  * proper foreshadowing while maintaining narrative consistency.
  //  * undefined until the assignment timing is reached.
  //  */
  // cachedEndingArchetype?: Ending;
  viableEnding?: Ending;

  /**
   * Character memory system for narrative consistency
   * 
   * Stores all characters encountered in the story with their
   * relationships, interactions, and narrative flags. This enables
   * consistent character behavior and plot twist setup.
   * 
   * Key: character name
   */
  characters: Record<string, CharacterMemory>;

  /**
   * Place memory system for narrative consistency
   * 
   * Stores all places encountered in the story with their
   * visit history, emotional associations, and narrative connections.
   * This enables consistent world-building and psychological anchoring.
   * 
   * Key: place name
   */
  places: Record<string, PlaceMemory>;

  /**
   * History of recent MAX_PAGE_HISTORY generated page content
   * 
   * Maintains a sliding window of recent pages for context
   * and narrative continuity in AI prompts.
   */
  pageHistory: ActionedStoryPage[];

  /** History of all user actions made throughout the story */
  actionsHistory: Action[];

  /**
   * AI-summarized context of the entire story from page 1 to current
   * 
   * This provides a comprehensive narrative summary that helps maintain
   * story coherence and continuity across all pages. Updated incrementally
   * as the story progresses using specialized summarization models.
   */
  contextHistory: string;
};

export type StoryStateSnapshotReason = 'periodic' | 'major_event' | 'branch_start' | 'user_request';

export type UserPageProgress = {
  id: string;
  userId: string;
  bookId: string;
  pageId: string;
  actionId: string;
  nextPageId?: string;
  createdAt: number;
}

export type UserActiveSession = Pick<DBUserSession, 'bookId' | 'pageId' | 'previousPageId'> & {
  branchId: string;
};

/**
 * Complete story progress information for a user
 * 
 * This type aggregates all the information needed for story progression:
 * current page, story state, active session, and main character data.
 * It provides a comprehensive view of where the user is in their story.
 * 
 * @interface StoryProgress
 */
export type StoryProgress = {
  /** Current book */
  book?: Book | null;
  /** Current story page with all content and actions */
  page?: UserStoryPage | null;
  /** Current story state with psychological profile and progression */
  state?: StoryState | null;
  /** Active user session linking user to current book and page */
  session?: UserActiveSession | null;
};

/**
 * Enhanced story progress with branch traversal information
 * 
 * This type extends the standard story progress with branch-specific data
 * including path information, statistics, and sibling pages for navigation.
 * 
 * @interface StoryProgressWithBranch
 */
export type StoryProgressWithBranch = StoryProgress & {
  /** Branch path from root to current page */
  branchPath: BranchPath | null;
  
  /** Branch statistics including depth and branching factor */
  branchStats: Awaited<BranchStats> | null;
  
  /** Sibling pages for navigation context */
  siblings: PersistedStoryPage[];
};

/**
 * Previous page navigation result with branch context
 * 
 * @interface PreviousPageResult
 */
export type PreviousPageResult = {
  /** Previous page data */
  previousPage: PersistedStoryPage | null;
  
  /** Branch path from root to previous page */
  branchPath: BranchPath | null;
  
  /** Whether user can navigate back further */
  canGoBackFurther: boolean;
};

/**
 * Branch integrity validation result
 * 
 * @interface BranchValidationResult
 */
export type BranchValidationResult = {
  /** Whether branch is valid */
  isValid: boolean;
  
  /** List of validation issues */
  issues: string[];
  
  /** Branch path if validation succeeded */
  path: BranchPath | null;
};

/**
 * Branch navigation options
 * 
 * @interface BranchNavigationOptions
 */
export type BranchNavigationOptions = {
  /** Whether user can navigate back */
  canGoBack: boolean;
  
  /** Whether user can navigate forward */
  canGoForward: boolean;
  
  /** Available sibling pages */
  siblingPages: PersistedStoryPage[];
  
  /** Current branch depth */
  branchDepth: number;
  
  /** Total number of branches */
  totalBranches: number;
};

/**
 * Story state cleanup result
 * 
 * @interface StoryStateCleanupResult
 */
export type StoryStateCleanupResult = {
  /** Number of deleted states */
  deletedCount: number;
  
  /** Number of kept states */
  keptCount: number;
};

// ============================================================================
// STATE RECONSTRUCTION TYPES
// ============================================================================

/**
 * State delta representing incremental changes between pages
 * 
 * This structure captures the differences between story states,
 * enabling efficient reconstruction without storing full snapshots
 * for every page.
 * 
 * @interface StateDelta
 */
export type StateDelta = {
  /** Page ID where this delta was created */
  pageId: string;
  
  /** Page number for ordering */
  page: number;
  
  /** Characters added in this delta */
  addedCharacters?: Record<string, CharacterMemory>;
  
  /** Characters updated in this delta */
  updatedCharacters?: Record<string, Partial<CharacterMemory>>;
  
  /** Characters removed in this delta */
  removedCharacters?: string[];
  
  /** Places added in this delta */
  addedPlaces?: Record<string, PlaceMemory>;
  
  /** Places updated in this delta */
  updatedPlaces?: Record<string, Partial<PlaceMemory>>;
  
  /** Places removed in this delta */
  removedPlaces?: string[];
  
  /** Trauma tags added in this delta */
  addedTraumaTags?: string[];
  
  /** Trauma tags removed in this delta */
  removedTraumaTags?: string[];
  
  /** Psychological flags changes */
  flagsDelta?: Partial<PsychologicalFlags>;
  
  /** Psychological profile changes */
  profileDelta?: Partial<PsychologicalProfile>;
  
  /** Hidden state changes */
  hiddenStateDelta?: Partial<HiddenState>;
  
  /** Memory integrity change */
  memoryIntegrity?: MemoryIntegrity;
  
  /** Difficulty change */
  difficulty?: Difficulty;
  
  /** Viable ending change */
  viableEnding?: Ending;
  
  /** Context history addition */
  contextHistoryAddition?: string;
  
  /** Full context history replacement (when context is completely different) */
  fullContextHistory?: string;
  
  /** Actions added to history */
  addedActions?: Action[];
  
  /** Full actions history replacement (when actions are completely different) */
  fullActionsHistory?: Action[];
};

/**
 * State snapshot representing a complete story state at a point in time
 * 
 * Snapshots serve as checkpoints for efficient state reconstruction.
 * They contain the complete state at a specific page, allowing
 * deltas to be applied forward from that point.
 * 
 * @interface StateSnapshot
 */
export type StateSnapshot = {
  /** Page ID where snapshot was taken */
  pageId: string;
  
  /** Page number for ordering */
  page: number;
  
  /** Complete story state at this point */
  state: StoryState;
  
  /** Timestamp when snapshot was created */
  createdAt: Date;
  
  /** Snapshot version for future-proofing */
  version: number;
  
  /** Whether this is a major event checkpoint */
  isMajorCheckpoint: boolean;
  
  /** Reason for snapshot creation */
  reason: 'periodic' | 'major_event' | 'branch_start' | 'user_request';
};

/**
 * State reconstruction result with metadata
 * 
 * @interface StateReconstructionResult
 */
export type StateReconstructionResult = {
  /** Reconstructed story state */
  state: StoryState;

  /** Number of snapshots used */
  snapshotsUsed: number;

  /** Number of deltas applied */
  deltasApplied: number;

  /** Reconstruction method used */
  method: 'direct' | 'snapshot_plus_deltas' | 'fallback';

  /** Performance metrics */
  reconstructionTimeMs: number;

  /** Source page ID of base snapshot */
  baseSnapshotPageId?: string;
};

// ============================================================================
//  BRANCH TRAVERSAL TYPES
// ============================================================================

/**
 * Branch path with full timeline information
 */
export type BranchPath = {
  /** Ordered array of pages from root to current */
  pages: PersistedStoryPage[];
  /** Root page ID (first page in the branch) */
  rootId: string;
  /** Current page ID (last page in the branch) */
  currentId: string;
  /** Total depth/length of the branch */
  depth: number;
  /** Timestamp when path was cached */
  cachedAt?: number;
};

/**
 * Branch statistics for analytics and navigation
 * 
 * @interface BranchStats
 */
export type BranchStats = {
  /** Depth of the branch from root to current page */
  depth: number;
  /** Total number of branches across all levels */
  totalBranches: number;
  /** Average branching factor (branches per level) */
  avgBranchingFactor: number;
};

/**
 * Parameters for setting an active user session
 * 
 * Contains all required and optional parameters needed to create or update
 * a user's active session in a specific book and page.
 */
export type SetActiveSessionParams = {
  /** User ID who owns the session */
  userId: string;
  /** Book ID where the session is active */
  bookId: string;
  /** Current page ID in the session */
  pageId: string;
  /** Previous page ID (optional, for tracking navigation) */
  previousPageId?: string;
};

/**
 * Cache entry for branch paths
 */
export type CacheEntry = {
  path: BranchPath;
  expiresAt: number;
};

/**
 * Cache entry for reconstructed states
 */
export type StateCacheEntry = {
  state: StoryState;
  result: StateReconstructionResult;
  expiresAt: number;
};

/**
 * Traversal options for performance tuning
 */
export type TraversalOptions = {
  /** Maximum depth to traverse (default: MAX_TRAVERSAL_DEPTH) */
  maxDepth?: number;
  /** Whether to use cache (default: true) */
  useCache?: boolean;
  /** Whether to validate path integrity (default: true) */
  validatePath?: boolean;
};

/**
 * State reconstruction dependencies
 */
export type StateReconstructionDeps = {
  /** Get page by ID */
  getPageById: (pageId: string) => Promise<DBPage | null>;
  /** Get book by ID to retrieve totalPages */
  getBook: (bookId: string) => Promise<{ totalPages: number } | null>;
  /** Get state snapshot by page ID */
  getSnapshot: (pageId: string) => Promise<StateSnapshot | null>;
  /** Get state delta by page ID */
  getDelta: (pageId: string) => Promise<StateDelta | null>;
  /** Get story state by page ID (DB + cache fallback) */
  getStoryState?: (pageId: string) => Promise<StoryState | null>;
};

/**
 * Type definitions for snapshot and delta operations
 * 
 * Active types are defined above in the main type section.
 * The older commented definitions have been removed to eliminate confusion.
 */

export interface SnapshotCreationDecision {
  shouldCreate: boolean;
  reason: 'periodic' | 'major_event' | 'branch_start' | 'user_request';
  priority: number;
}