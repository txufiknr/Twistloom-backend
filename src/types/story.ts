import type { AIChatProvider } from "./ai-chat.js";
import type { Book } from "./book.js";
import type { CharacterMemory, CharacterUpdates, Injury, InitialInjury, InventoryItem, RelationshipUpdate } from "./character.js";
import type { PlaceMemory, PlaceUpdates, PlaceWeather } from "./places.js";
import type { DBNewPage, DBPage, DBPageTranslations, DBUserSession } from "./schema.js";
import type { StoryThread, ThreadUpdates } from "./thread.js";

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
  "eerie",        // unsettling, strange atmosphere
  "tense",        // high tension, anticipation of danger
  "dread",        // deep feeling of impending doom
  "panic",        // overwhelming fear and urgency
  "confusion",    // disorientation, unclear reality
  "suspicious",   // distrust, feeling of being watched
  "hopeless",     // no escape, despair
  "relief",       // temporary safety or resolution
  "sad",          // grief, loss, melancholy
  "distorted",    // wrong, altered, warped perception, unreality
  "urgency",      // time pressure, immediate need to act
  "shock",        // sudden revelation or horror
  "safe",         // feels secure, protected
  "threatening",  // dangerous, hostile
  "familiar",     // known, comfortable
  "unfamiliar",   // new, unknown
  "sacred",       // special, meaningful
  "contaminated", // corrupted, tainted
  "neutral",      // no strong atmosphere
  "other"         // catch-all for unique emotional states
];

/**
 * Available ending archetypes for psychological thriller stories
 * 
 * These define the ultimate resolution pattern and twist type
 * that the story will build toward throughout its progression.
 */
export const endingTypes = {
  /** MC thinks they escaped → final twist reveals they didn't */
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
  /** MC is taken over or controlled by an external force */
  "possession": "MC is taken over or controlled by an external force → loss of agency, mind/body takeover, external influence",
  /** Key relationships/events are products of MC's mental state */
  "mental_fabrication": "Key relationships/events are products of MC's mental state → questionable relationships, inconsistent memories, unreliable perceptions",
  /** All choices lead to the same predetermined outcome */
  "predetermined": "All choices lead to the same predetermined outcome → illusion of agency, convergent paths, inevitable fate",
  /** MC becomes the antagonist/monster they were fighting */
  "become_threat": "MC becomes the antagonist/monster they were fighting → moral corruption, gradual transformation, role reversal",
  /** Multiple endings exist simultaneously based on different choices */
  "multiverse": "Multiple endings exist simultaneously based on different choices → parallel realities, choice echoes, quantum states",
  /** The story was a test/simulation all along */
  "simulation": "The story was a test/simulation all along → artificial constraints, observed behavior, breaking the fourth wall",
  /** MC's actions created a worse threat than the original */
  "escalation": "MC's actions created a worse threat than the original → unintended consequences, solution becomes problem",
  /** The true villain was someone the MC trusted completely */
  "betrayal": "The true villain was someone the MC trusted completely → hidden agendas, manipulated relationships, trust collapse",
  /** MC achieves their goal but at an unacceptable moral cost */
  "pyrrhic_victory": "MC achieves their goal but at an unacceptable moral cost → moral compromise, hollow success, ethical erosion",
  /** The threat was never real - it was all in MC's head */
  "collective_delusion": "The threat was never real - it was all in MC's head → shared hallucination, mass hysteria, social contagion",
  /** MC is trapped in someone else's story/memory */
  "nested_narrative": "MC is trapped in someone else's story/memory → borrowed identity, inherited trauma, story within story",
  /** The cycle continues regardless of MC's choices */
  "cosmic_cycle": "The cycle continues regardless of MC's choices → ancient patterns, cosmic indifference, eternal recurrence"
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
  "dialogue": "Interact with other characters, self-talk, mutter",
  "custom": "Custom prompt from reader",
  "other": "Catch-all for uncategorized actions"
};

/**
 * Action relationship/directional modifiers
 * 
 * This gives you a two-dimensional system: action type (psychological) +
 * relationship (directional), providing richer narrative context.
 */
export const actionRelationships = {
  "trust": "Place faith in, rely upon, believe",
  "doubt": "Question, suspect, withhold belief",
  "deny": "Refuse, contradict, reject",
  "follow": "Obey, trail, emulate",
  "approach": "Move toward, initiate contact",
  "withdraw": "Pull back, retreat, distance"
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
export type EndingType = keyof typeof endingTypes;

/**
 * Union type of all possible action type values
 * 
 * Generated from the actionTypes array to ensure type safety
 * for categorizing user actions.
 */
export type ActionType = keyof typeof actionTypes;

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
  // /** Sentence length: short ↔ mixed ↔ longer */
  // sentenceLength: number;
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

export type FlagLevel = 'low' | 'medium' | 'high';
export const flagLevels: FlagLevel[] = ['low', 'medium', 'high'];

/**
 * Level of trust the main character has toward others/environment.
 * - 'low': distrustful, suspicious, unlikely to rely on others
 * - 'medium': cautious but open to cooperation
 * - 'high': trusting, likely to depend on others or form bonds
 */
export type TrustLevel = FlagLevel;
/**
 * Level of fear influencing perception and behavior.
 * - 'low': calm, clear-headed, minimal threat response
 * - 'medium': wary, tentative, occasional panic or avoidance
 * - 'high': terrified, prone to flight/freeze and impaired judgment
 */
export type FearLevel = FlagLevel;
/**
 * Level of guilt from past actions affecting choices.
 * - 'low': little remorse, guilt-free or justified feelings
 * - 'medium': nagging regret, influences decisions
 * - 'high': overwhelming guilt, may seek redemption or self-punishment
 */
export type GuiltLevel = FlagLevel;
/**
 * Level of curiosity driving investigation and risk-taking.
 * - 'low': avoids exploration, prefers safety and routine
 * - 'medium': cautiously inquisitive, investigates when prompted
 * - 'high': actively seeks answers, takes risks to discover truth
 */
export type CuriosityLevel = FlagLevel;

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

/**
 * Available plot flag types for story progression tracking
 * 
 * These types categorize different kinds of plot developments
 * and narrative events that drive the story forward.
 */
export const plotFlagTypes = [
  "clue_found",         // Discovery of important information or evidence
  "secret_revealed",    // Hidden truth comes to light
  "betrayal_witnessed", // Character betrayal observed or experienced
  "mystery_started",    // New storyline or puzzle begins
  "threat_identified",  // Danger or antagonist becomes clear
  "alliance_formed",    // Partnership or cooperation established
  "conflict_escalated", // Tension or confrontation increases
  "sacrifice_made",     // Character gives up something important
  "truth_hidden",       // Information deliberately concealed
  "deception_detected", // Lie or manipulation uncovered
  "escape_attempted",   // Character tries to flee or avoid situation
  "confrontation",      // Direct face-off between characters
  "revelation",         // Major truth or discovery revealed
  "loss_experienced",   // Significant setback or damage occurs
  "hope_found",         // Positive development or opportunity emerges
  "other"               // Catch-all for unique plot developments
] as const;

/**
 * Union type of all possible plot flag type values
 * 
 * Generated from the plotFlagTypes array to ensure type safety
 * and autocomplete support for plot flag categorization.
 */
export type PlotFlagType = typeof plotFlagTypes[number];

/** A plot flag representing a significant narrative event. */
export type PlotFlag = {
  /** Page number where the flag was added. */
  page: number;
  /** Description of the flagged event. */
  fact: string;
  /** Type of the flag indicating its category. */
  type: PlotFlagType;
  /** Place where the flagged event occurred (optional). */
  place?: string;
  /** Indicates whether the flagged event is a major plot point. */
  isMajorEvent: boolean;
}

export type InitialPlotFlag = Omit<PlotFlag, 'page' | 'place'>;

export const factTypes = {
  character: "About characters, including status, goals, traits, conditions, locations, and major developments.",
  relationship: "Describing relationships, trust, loyalty, hostility, romance, or other connections between characters.",
  inventory: "About items, objects, evidence, weapons, documents, ownership, possession, or condition.",
  location: "About places, buildings, rooms, landmarks, accessibility, security, or location status.",
  organization: "About groups, companies, governments, factions, cults, teams, or institutions.",
  world: "About the broader world state, environment, weather, disasters, laws, politics, infrastructure, or global conditions.",
  mystery: "Related to investigations, clues, suspects, evidence, revelations, secrets, or unresolved questions.",
  knowledge: "Describing what a character knows, believes, suspects, remembers, or has learned. Represents character knowledge rather than objective truth.",
  other: "Important durable story facts that do not fit any other category."
};

export type FactType = keyof typeof factTypes;

export type FactHistory = {
  page: number;
  value: string;
  type?: FactType;
  reason?: string;
};

export type FactUpdate = { key: string; } & FactHistory
export type InitialFact = Omit<FactUpdate, 'page'>;

export type FutureNote = {
  /** Unique identifier for the note (for updates) */
  key: string;
  /** Text of the future note */
  note: string;
  /** Whether the note is a major plot point or minor detail */
  isMajor?: boolean;
  /** Page number where the note was added */
  addedAtPage?: number;
  /** Optional tag for categorizing the note (e.g. 'relationship', 'clue') */
  tag?: FactType;
  /** Optional target story phase for when this note should become relevant */
  targetPhase?: StoryPhase;
  /** Optional target page number for when this note should become relevant */
  targetPageRange?: string;
};

export type FutureNoteGeneration = Omit<FutureNote, 'key' | 'addedAtPage'>;

/** An ending of a story with optional text and type. */
export type Ending = {
  /** Text describing the ending (optional). */
  text?: string;
  /** Type of the ending (optional). */
  type?: EndingType;
  /** Outline hint for the ending (optional). */
  outline?: StoryOutline[];
  /** Optional note about changes to the ending plan based on story progression */
  changeNote?: EndingChangeNote;
}

/** Details of the change that triggered the ending mutation */
export type EndingChangeNote = {
  reason: string;
  viabilityBefore: number; // 0-1
  viabilityAfter: number; // 0-1
};

export type InitialEnding = Omit<Ending, 'outline' | 'changeNote'> & { outline: string[] };

export type StoryOutline = {
  text: string;
  isDone: boolean;
}

/**
 * Available ending execution strategy types
 * 
 * These define the different approaches to executing story endings,
 * each creating unique psychological experiences and narrative patterns.
 */
export type EndingPlanType = 
  | "fake_relief_twist"  // False sense of security followed by horror
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

export const majorEventTypes = [
  "revelation", // Important truth discovered
  "betrayal", // Trust broken
  "death", // Major character death
  "disappearance", // Character vanishes
  "identity_exposed", // Secret identity revealed
  "alliance", // Unexpected partnership
  "escape", // Escapes danger
  "capture", // Falls into enemy control
  "sacrifice", // Gives up something significant
  "corruption", // Character morally declines
  "transformation", // Fundamental character change
  "victory", // Major objective achieved
  "defeat", // Major setback
  "point_of_no_return", // Story direction permanently changes
  "other",
  "none",
];
export type MajorEventType = typeof majorEventTypes[number];

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
  "mostly_true": "Mostly True→grounded | Minimal deception, reliable information",
  /** Mix of truth and inconsistencies */
  "partially_true": "Partially True→inconsistencies | Some deception, unreliable narrator",
  /** Heavy deception and manipulation */
  "mostly_false": "Mostly False→deception/contradictions | Heavy deception, gaslighting"
};

/**
 * Available threat proximity levels
 * 
 * These define the proximity of immediate danger or threat
 * and guide the pacing and intensity of narrative tension.
 */
export const threatProximities = {
  /** Distant threat, slow build */
  "distant": "Far→slow build | Distant threat, atmospheric tension, gradual escalation",
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
export type TruthLevel = keyof typeof truthLevels;

/**
 * Union type of all possible threat proximity keys
 */
export type ThreatProximity = keyof typeof threatProximities;

/**
 * Union type of all possible reality stability keys
 */
export type RealityStability = keyof typeof realityStabilities;

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
export const difficulties = ["low", "medium", "high", "nightmare"];
export type Difficulty = typeof difficulties[number];

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
 * How psychologically compromised is the protagonist?
 */
// export const stabilityLevels = {
//   /** Mentally coherent, rational thinking */
//   "stable": "Mentally coherent, rational thinking → Subtle manipulation, gradual escalation",
//   /** Under stress, showing cracks in composure */
//   "cracking": "Under stress, showing cracks in composure → More direct psychological attacks, visible stress",
//   /** Severely distressed, reality breakdown */
//   "unstable": "Severely distressed, reality breakdown → Full psychological warfare, reality breakdown"
// };

export const stabilityLevels = {
  /** Mentally coherent, rational thinking */
  stable: "Mentally coherent and rational. Trusts perception and reasoning. → Interpret events objectively.",
  /** Under stress, showing cracks in composure */
  cracking: "Under psychological stress. Experiencing paranoia, doubt, intrusive thoughts, or growing instability. → Interpret ambiguous events with growing suspicion.",
  /** Severely distressed, reality breakdown */
  unstable: "Severely psychologically compromised. Reality perception is unreliable, with possible delusions, hallucinations, or identity breakdown. → Unreliable perception. Increased paranoia, self-doubt, and distorted interpretations while preserving narrative coherence."
} as const;

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
export type Archetype = keyof typeof archetypes;

/**
 * Union type of all possible stability level keys
 * 
 * Generated from the stabilityLevels object to ensure type safety
 * when specifying MC mental states.
 */
export type StabilityLevel = keyof typeof stabilityLevels;

/**
 * Union type of all possible manipulation affinity keys
 * 
 * Generated from the manipulationAffinities object to ensure type safety
 * when specifying psychological targeting vectors.
 */
export type ManipulationAffinity = keyof typeof manipulationAffinities;

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
  /** Trust level affecting social interactions and paranoia (0.0-1.0) */
  trust: number;
  /** Guilt level influencing self-perception and decisions (0.0-1.0) */
  guilt: number;
  /** Trauma weight based on accumulated psychological impact (0.0-1.0) */
  traumaWeight: number;
  /** Physical state: injury severity affecting vulnerability (0.0-1.0) */
  physicalState: number;
  /** Social context: isolation vs connection (0.0-1.0) */
  socialContext: number;
  /** Cognitive state: memory clarity and perception (0.0-1.0) */
  cognitiveState: number;
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
  /** Current weather conditions at the place */
  weather?: PlaceWeather;
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
  /** Changes to the story state */
  stateDelta: StateDelta;
  /** AI provider used for generating the page content */
  aiProvider?: AIChatProvider | 'none';
  /** AI model used for generating the page content */
  aiModel?: string;
};

export type StoryPageMeta = Pick<DBNewPage, 'bookId' | 'branchId' | 'parentId'> & {
  // /** Optional selected action that triggered this page generation (for duplicate prevention) */
  // selectedAction?: SelectedAction;
};

export type StoryPageScene = Pick<StoryPage, 'place' | 'weather' | 'mood'>;

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
  /** Updates to psychological flags (trust, fear, guilt, curiosity) */
  flagUpdates?: Partial<PsychologicalFlags>;
  /** Updates to trauma tags (add/remove) based on page events */
  traumaTagUpdates?: TagUpdates<string>;
  /** Updates to future notes (add/remove) based on story progression */
  futureNoteUpdates?: TagUpdates<FutureNote>;
  /** Updates to plot flags (add) for story progression */
  addPlotFlag?: InitialPlotFlag;
  /** What durable facts about the story world changed */
  factUpdates?: FactUpdate[];
  /** Updates to characters (new and existing) with changes */
  characterUpdates?: CharacterUpdates;
  /** Updates to character relationships and dynamics */
  relationshipUpdates?: RelationshipUpdate[];
  /** Updates to places (new and existing) with modifications */
  placeUpdates?: PlaceUpdates;
  /** Updates to story threads (new, modify, add clues, close) */
  threadUpdates?: ThreadUpdates;
  /** Partial ending information if this page leads to an ending */
  viableEnding?: Ending;
  /** Flag indicating if this is a major story event */
  isMajorEvent?: boolean;
  /** Updated AI-summarized context of the entire story */
  contextHistory?: string;
  /** Object in MC's possession */
  inventory?: InventoryItem[];
  /** Represents injuries sustained by the MC */
  injuries?: Injury[];

  /** Psychological state */
  psychologicalProfileUpdates?: Partial<PsychologicalProfile>;
  hiddenStateUpdates?: Partial<HiddenState>;
  memoryIntegrity?: MemoryIntegrity;
  difficulty?: Difficulty;
};

export type PsychologicalStateDelta = Pick<StateDelta, 'psychologicalProfileUpdates' | 'hiddenStateUpdates' | 'memoryIntegrity' | 'difficulty'>;

// export type StateDeltaGeneration = Omit<StateDelta, 'psychologicalProfileUpdates' | 'hiddenStateUpdates' | 'memoryIntegrity' | 'difficulty'>;
export type StateDeltaGeneration = Omit<StateDelta, keyof PsychologicalStateDelta | 'futureNoteUpdates' | 'isMajorEvent'> & {
  futureNoteUpdates?: {
    add?: FutureNoteGeneration[];
    remove?: string[];
  }
};
export type StoryPageGeneration = Omit<StoryPage, 'aiProvider' | 'aiModel' | 'stateDelta'>;
export type StoryGeneration = StoryPageGeneration & StateDeltaGeneration;

export type PersistedStoryPage = StoryPage & Pick<DBPage, 'id' | 'bookId' | 'branchId' | 'parentId' | 'page' | 'createdAt' | 'updatedAt'>;
export type UserStoryPage = PersistedStoryPage & { selectedActions: SelectedAction[] };
export type ActionedStoryPage = PersistedStoryPage & { selectedAction: SelectedAction };
export type EnrichedStoryPage = Partial<UserStoryPage> & {
  originalActionsCount: number, 
  translation?: DBPageTranslations,
  sourceAction?: SelectedAction,
  sourceNav?: StoryPageNav,
  shownActionHint: string[],
  context?: {
    /** Current story phase classification */
    phase: StoryPhase;
    /** Collection of items and resources present in the world at the current page */
    inventory: InventoryItem[];
    /** Represents injuries sustained by the MC */
    injuries: Injury[];
    /** AI-summarized context of the story until this page */
    contextHistory: string;
    /** History of actions made until this page */
    actionsHistory: SelectedAction[];
    /** All known places so far */
    places: Array<Pick<PlaceMemory, 'name' | 'type' | 'context'>>;
    /** All known characters so far */
    characters: Array<Pick<CharacterMemory, 'name' | 'gender' | 'role' | 'bio'>>;
  }
};

export type StoryPageNav = Record<number, StoryPageNavItem>;
export type StoryPageNavItem = { pageId: string; selectedAction: SelectedAction; plotFlag?: InitialPlotFlag; };

export type Action = {
  /** Action text (serves as unique identifier) */
  text: string;
  /** Category of action for psychological impact */
  type: ActionType;
  /** Consequence hint for the action (for AI guidance) */
  hint: ActionHint;
  /** Destination meta for the action */
  destinationPageIds?: string[];
};

export type SelectedAction = Pick<Action, 'text' | 'type' | 'hint'> & {
  /** Action source */
  pageId: string;
  /** Action source page number */
  page: number;
  /** Action destination */
  nextPageId: string;
  // /** Whether this selection is paid (not primary selection) */
  // isPaid?: boolean;
};

export type ActionGeneration = Omit<Action, 'destinationPageIds'>;
// export type ActionHistory = Action & { page: number };
export type ActionTranslation = {
  /** Original action text (serves as unique identifier) */
  originalText: string;
  /** Translated action text */
  text: string;
};

export type TagItem = string | { key: string };
export type TagUpdates<T extends TagItem> = {
  add?: T[];
  remove?: string[];
}

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

  /**
   * Planned viable ending for story direction and foreshadowing
   * 
   * This is set dynamically between early-late story progress to allow
   * proper foreshadowing while maintaining narrative consistency.
   */
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

  /** History of all user actions made throughout the story */
  actionsHistory: SelectedAction[];

  /**
   * AI-summarized context of the entire story from page 1 to current
   * 
   * This provides a comprehensive narrative summary that helps maintain
   * story coherence and continuity across all pages. Updated incrementally
   * as the story progresses using specialized summarization models.
   */
  contextHistory: string;

  /**
   * History of all known facts in the story and their updates
   * 
   * Track the evolution of the story's mysteries, clues, and revelations over time,
   * enabling consistent narrative development and foreshadowing.
   * Updated incrementally as new facts are discovered.
   */
  factsHistory: Record<string, FactHistory[]>;

  /**
   * Indicates whether the current page contains a major event
   * 
   * Major events are plot-level facts that have significant impact
   * on the story's narrative arc and can introduce new plot twists.
   */
  isMajorEvent?: boolean;

  /**
   * Collection of ongoing narrative threads in the story
   * 
   * Stores information about ongoing storylines, conflicts, and
   * the characters involved in them.
   */
  threads: StoryThread[];

  /**
   * Collection of narrative flags and hints for the current page
   * 
   * Stores information about ongoing storylines, conflicts, and
   * the characters involved in them.
   */
  plotFlags: PlotFlag[];

  /**
   * Collection of items and resources present in the world at the current page
   * 
   * Stores information about items and resources that are available
   * in the world at the current page and their potential impact on the story.
   */
  inventory: InventoryItem[];

  /** Represents injuries sustained by the MC */
  injuries: Injury[];

  /** Important notes for future AI turns */
  futureNotes: FutureNote[];
};

/**
 * Comprehensive information about the current state of a story
 * 
 * Provides detailed metrics and phase information for tracking story progress,
 * including page counts, progress percentages, and story phase classification.
 * 
 * @example
 * ```typescript
 * const storyInfo: StoryStateInfo = {
 *   currentPage: 5,
 *   totalPages: 20,
 *   remainingPages: 15,
 *   pageProgress: 0.25,
 *   isEarlyPhase: true,
 *   isLatePhase: false,
 *   isMidPhase: false,
 *   isFinale: false,
 *   phase: 'EARLY',
 *   phaseGoal: 'Introduce main characters and setting'
 * };
 * ```
 */
export type StoryStateInfo = {
  /** Current page number in the story (1-indexed) */
  currentPage: number;
  /** Total number of pages in the story */
  totalPages: number;
  /** Number of pages remaining until the story ends */
  remainingPages: number;
  /** Progress through the story as a decimal (0.0 to 1.0) */
  pageProgress: number;
  /** Whether the story is in the early phase (first 25%) */
  isEarlyPhase: boolean;
  /** Whether the story is in the late phase (last 30%) */
  isLatePhase: boolean;
  /** Whether the story is in the middle phase (25%-70%) */
  isMidPhase: boolean;
  /** Whether the story is in the finale phase (last 10%) */
  isFinale: boolean;
  /** Whether the current page is the first page of the story */
  isFirstPage: boolean;
  /** Whether the current page is the last page of the story */
  isLastPage: boolean;
  /** Current story phase classification */
  phase: StoryPhase;
  /** Goal or objective for the current story phase */
  phaseGoal: string;
  /** Phase of the finale, only when isFinale is true. */
  finalePhase?: FinalePhase;
  /** Number of characters remaining can be added */
  charactersSlot: number;
  /** Number of places remaining can be added */
  placesSlot: number;
}

export type StoryStateSource = 'original' | 'reconstructed';

export type InitialStoryState = Partial<Pick<
  StoryState,
    'flags' |
    'difficulty' |
    'traumaTags' |
    'plotFlags' |
    'inventory'
  > & {
    injuries: InitialInjury[];
    futureNotes: FutureNoteGeneration[];
    viableEnding: InitialEnding;
  }>;

export const storyPhases = {
  EARLY: `Priority: mystery seeding, unreliability introduction, character grounding.
Weight tension lightly. Prioritize intrigue over dread.`,
  MID: `Priority: tension rhythm, thread balance, psychological escalation.
Exploit established character and flag patterns. Vary build/release cycles.`,
  LATE: `Priority: thread convergence, payoff setup, reality fracture.
No new major threads. Begin collapsing open questions toward the viable ending.`,
  FINALE: `Priority: ending delivery, full psychological collapse.
No new characters. No new mysteries. Every active thread must resolve or deliberately shatter.
Behave as NIGHTMARE difficulty regardless of setting.`,
};

export const finalePhases = {
  EARLY: `PHASE 1 → "FALSE SAFETY" (if fake_to_real ending)
Goals: Resolve main tension, slow pacing, give emotional release
Tone: Calm, hopeful, slightly uncanny
Rules: No obvious horror, subtle unease only`,
  MID: `PHASE 2 → "DISTORTION"
Goals: Break reality slightly, create doubt
Techniques: Repeated dialogue, impossible object, memory glitch, time inconsistency
End with: Realization sentence ("I've been here before.")`,
  END: `PHASE 3 → "IMPACT"
Goals: Reveal truth, reframe entire story, hit psychologically
Structure: Reveal → Recontextualization → Final haunting line
Final line rule: Short, clear, haunting ("It was never outside.")`,
};

export type StoryPhase = keyof typeof storyPhases;
export type FinalePhase = keyof typeof finalePhases;

export type UserSession = Pick<DBUserSession, 'bookId' | 'pageId' | 'previousPageId' | 'status'> & {
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
  /** User session linking user to current book and page */
  session?: UserSession | null;
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
  /** Whether to persist reconstructed state to database (default: false) */
  persistState?: boolean;
};

/**
 * State reconstruction dependencies
 */
export type StateReconstructionDeps = {
  /** Get page by ID */
  getPageById: (pageId: string) => Promise<DBPage | null>;
  /** Get book by ID to retrieve totalPages */
  getBook: (bookId: string) => Promise<{ totalPages: number } | null>;
  /** Get story state by page ID (DB + cache fallback) */
  getStoryState?: (pageId: string) => Promise<StoryState | null>;
};

/** Represents a past interaction between characters */
export type PastEvent = {
  /** The page number of the interaction */
  page: number;
  /** The interaction between characters */
  event: string;
  /** The place where the interaction occurred. */
  place?: string;
};