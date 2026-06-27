import type { AIChatProvider, AIResponseProvider } from "./ai-chat.js";
import type { ResourceAIProvider, ResourceTimestamp } from "./api.js";
import type { Book, PageTranslation } from "./book.js";
import type { CharacterMemory, CharacterUpdates, Injury, InitialInjury, InventoryItem, RelationshipUpdate, HealthStatus, StoryMCCandidate, CharacterPlan } from "./character.js";
import type { PlaceConnectionUpdate, PlaceMemory, PlaceUpdates, PlaceWeather } from "./places.js";
import type { DBNewPage, DBPage, DBUserSession } from "./schema.js";
import type { StoryThread, ThreadUpdates } from "./story-thread.js";

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
] as const;

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
  // /** Whether story is in ending phase */
  // isEnding: boolean;
};

/**
 * Style vector controlling narrative characteristics
 * 
 * Each dimension affects how the story feels and is written
 */
export type StyleVector = {
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
export const psychologicalFlagsTypes = ['trust', 'fear', 'guilt', 'curiosity'];

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
  "mystery_started", // A new mystery, question, puzzle, or investigation begins.
  "clue_found", // Information that helps solve a mystery.
  "discovery", // Something important is uncovered, but not necessarily explanatory.
  "revelation", // A truth becomes known.
  "threat_emerged", // Danger becomes present or understood.
  "conflict_escalated", // Tension increases.
  "alliance_formed", // Relationship becomes cooperative.
  "betrayal", // Trust is broken.
  "obstacle_encountered", // Forward progress blocked.
  "loss_experienced", // Something important is lost.
  "turning_point", // Major story direction change.
  "other"
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
  /** Indicates whether the flagged event is a major plot point. */
  isMajorEvent: boolean;
} & Pick<StoryScene, 'placeId' | 'calendarDate' | 'timeOfDay'>;

export type InitialPlotFlag = Omit<PlotFlag, 'page' | 'placeId' | 'calendarDate' | 'timeOfDay'>;

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

/**
 * What does the future need to remember?
 * What should future AI generations remember that hasn't happened yet?
 */
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
  /** Optional if related to any active thread */
  relatedThreadId?: string;
  // TODO: refactor to targetConditions: [{ "type": "phase", "value": "MID" }]
  /** Optional target story phase for when this note should become relevant */
  targetPhase?: StoryPhase;
  /** Optional target page number for when this note should become relevant */
  targetPageRange?: string;
  /** Optional target date for when this note should become relevant */
  targetDate?: string;
  /** Optional target day for when this note should become relevant */
  targetDay?: number;
};

export type FutureNoteTarget = {
  type: FutureNoteTargetType;
  phase: string;
}

export type FutureNoteTargetType =
| 'phase' // e.g. 'MID'
| 'pageRange' // e.g. '25-30'
| 'date' // e.g. '<yyyy-MM-dd>'
| 'day' // e.g. '7' or '10-14' (exact or range)
// state.psychologicalProfile:
| 'stability'
// state.healthStatus:
| 'condition' // e.g. 'critial'
| 'healthPercent' // e.g. '< 75'
| 'mobilityPercent'
| 'actionPercent'
| 'mentalPercent';

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

/**
 * Structured recommendation for the optimal story ending
 */
export type EndingRecommendation = {
  /** The specific ending archetype recommended */
  type: EndingType;
  /** Human-readable summary of why this ending was chosen */
  summary: string;
  /** Traceable data object explaining the heuristic logic (excellent for debugging) */
  because: {
    tier: "ending_plan" | "profile_shift" | "base_archetype" | "fallback";
    [key: string]: string | number | boolean | undefined;
  };
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
  /** In-fiction world clock tracking elapsed time between actions */
  worldClock?: WorldClock;
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
export const difficulties = ["low", "medium", "high", "nightmare"] as const;
export type Difficulty = typeof difficulties[number];

/**
 * Available psychological archetypes and their AI narrative tactics
 * 
 * These define the primary behavioral patterns and give the AI explicit 
 * instructions on how to exploit those patterns to generate personalized horror.
 */
export const archetypes = {
  /** Curious, seeks knowledge, investigates */
  "the_explorer": "Exploit their curiosity. Lure them deeper with partial answers, then trap them with terrifying truths.",
  /** Cautious, avoids danger, prefers safety */
  "the_avoider": "Punish their hesitation. Slowly close off safe routes and force claustrophobic, unavoidable confrontations.",
  /** Bold, takes chances, confrontational */
  "the_risk_taker": "Turn their boldness against them. Let their rash actions trigger immediate, devastating environmental consequences.",
  /** Suspicious, distrustful, fearful */
  "the_paranoid": "Validate their worst fears. Scatter subtle, unreliable clues that make every shadow and ally seem like a lethal threat.",
  /** Remorseful, self-blaming, haunted */
  "the_guilty": "Haunt them with their past. Echo their past mistakes in the environment and leverage heavy moral pressure.",
  /** In denial, avoids truth, rationalizes */
  "the_denier": "Shatter their rationalizations. Introduce undeniable, grotesque reality breaks that force them to face the horrifying truth."
};

/**
 * Available stability levels for psychological profiles
 * 
 * These define the MC's mental coherence and act as a strict "narrative lens"
 * for the AI, dictating how reliably it is allowed to describe reality.
 * Answers: "How psychologically compromised is the MC?"
 */
export const stabilityLevels = {
  /** Mentally coherent, rational thinking → Subtle manipulation, gradual escalation */
  stable: "Mentally coherent and rational → Describe events objectively. Shadows are just shadows. Noises have logical sources. Do NOT introduce impossible geometry. Rarely introduce subtle hallucinations.",
  /** Under stress, showing cracks in composure → More direct psychological attacks, visible stress */
  cracking: "Under psychological stress → Distort sensory details. Describe ordinary objects in sinister, threatening ways, with growing suspicion. Make the MC question if what they saw/heard was real or just their imagination.",
  /** Severely distressed, reality breakdown → Full psychological warfare, reality breakdown */
  unstable: "Severely psychologically compromised → Present broken perception, delusions, hallucinations, impossible events, identity breakdown, increased paranoia, and distorted interpretations while preserving narrative coherence."
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

/**
 * Post-ending psychological profile result surfaced to the reader
 *
 * This is the "psychological autopsy" — shows the reader who they became,
 * what drove it, and what they missed by not playing differently.
 */
export type PsychologicalProfileResult = {
  /** The MC's dominant behavioral archetype */
  archetype: Archetype;
  /** Mental stability at story end */
  stability: StabilityLevel;
  /** Prominent traits that defined the MC's journey */
  dominantTraits: string[];
  /** Most effective manipulation vector */
  manipulationAffinity: ManipulationAffinity;
  /** The ending the MC reached */
  ending: {
    type: EndingType;
    summary: string;
  };
  /** Teasers for paths/endings NOT triggered, driving replay curiosity */
  missedTeasers: MissedEndingTeaser[];
};

/**
 * A teaser about an ending/archetype the reader didn't trigger
 */
export type MissedEndingTeaser = {
  /** The archetype they didn't become */
  archetype: Archetype;
  /** What would have driven them toward this archetype */
  trigger: string;
  /** The ending they would have faced */
  wouldHaveEnded: EndingType;
  /** Human-readable teaser text */
  teaser: string;
};

/**
 * In-fiction world clock — tracks elapsed time between actions.
 *
 * NOT a duplicate of timeOfDay and calendarDate — those are per-page
 * sensory scene data. This tracks the *delta* between actions for
 * schedule enforcement ("the guard leaves at dawn; 45min just passed").
 *
 * Minutes are the base unit; can be formatted as "1m", "45m", "2h", etc.
 */
export type WorldClock = {
  /** In-fiction minutes since the reader's last action */
  elapsedMinutes: number;
};

/**
 * Reader-facing sanity/composure resource — the horror-themed "ticking clock."
 *
 * Decays under sustained critical momentum and can be deliberately spent
 * by the reader to resist realityStability collapse. Depletion at high
 * danger forces bad endings rather than being purely flavor text.
 *
 * Unlike a fixed-page timer (which fights variable AI pacing), this
 * is threat-proximity-driven and momentum-aware — the inputs
 * `updateHiddenState` already computes.
 */
export type SanityState = {
  /** Current composure 0–100. At 0, the reader is in crisis. */
  composure: number;
  /** Maximum composure (starts at 100, can be permanently reduced by trauma). */
  maxComposure: number;
  /** Base decay per page when momentum is critical (default ~5). */
  decayRate: number;
  /** Whether the reader has hit 0 composure this story. */
  hasCrashed: boolean;
  /** Page number when composure last hit 0 (for ending forcing). */
  crashedAtPage?: number;
};

/**
 * A record of something becoming permanently inaccessible to the reader.
 *
 * Surfaced to the player as "this path is now closed" — the *80 Days*-style
 * visible consequence that makes choices feel irreversible.
 */
export type LockedPathEvent = {
  /** Type of what was locked */
  kind: 'place' | 'place_connection' | 'thread';
  /** Human-readable name of what was lost */
  label: string;
  /** The restriction that was applied */
  restriction: string;
  /** Page number when this happened */
  page: number;
  /** Optional explanation of what closed this path */
  context?: string;
};

export type PsychologicalProfileMetrics = {
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
  /** Direct core psychological vulnerability to leverage in choices */
  primaryWeakness?: PrimaryWeakness;
  // /** Secondary or environmental vulnerability backing the narrative tension */
  // secondaryWeakness?: string;
} & PsychologicalProfileTraits;

/**
 * The player's dominant psychological vulnerability, synthesized from cumulative
 * behavioral patterns and bridged from the current archetype.
 *
 * This is the single most targetable "button" for the story to exploit —
 * the thing that produces the "this story knows exactly how I think" effect.
 *
 * Stored in PsychologicalProfileMetrics.primaryWeakness (typed as `string` in story.ts).
 * The union here provides type-safe usage within this module.
 *
 * Intentionally different from ManipulationAffinity (which drives exploitation tactics):
 * this label describes the player's core vulnerability, not the delivery mechanism.
 */
export type PrimaryWeakness =
  | 'truth_seeking'    // Explorer/risk-taker: compulsively pursues answers regardless of cost
  | 'fear_of_loss'     // Protector/healer: fiercely attached to people, objects, or safety
  | 'need_for_control' // Aggressor: psychologically destabilized by helplessness
  | 'trust_hunger'     // Social/trusting: deeply vulnerable to betrayal by relied-upon figures
  | 'guilt'            // Guilty: haunted by past choices that resurface in the present
  | 'avoidance';       // Paranoid/denier/avoider: retreats from hard truths, inevitabilities

export type PsychologicalProfileTraits = {
  /** Curiosity level from actions */
  curiosity: number;
  /** Fear level from actions */
  fear: number;
  /** Aggression level from actions */
  aggression: number;
  /** Denial level from actions */
  denial: number;
};

// TODO: separate time-related props into new TemporalContext type
export type StoryScene = {
  /** Current emotional atmosphere */
  mood?: Mood;
  /** Current place ID where the story is taking place */
  placeId?: string;
  /** Current weather conditions at the place */
  weather?: PlaceWeather;
  /** Current in-world date (e.g., "2026-07-26") */
  calendarDate?: string; // Good for: immersion, newspapers, journals, police reports, anniversaries, holidays, birthdays
  /** Current time mark (e.g., time range, 'night', 'HH:mm', 'unknown') */
  timeOfDay?: string;
  /** Current narrative function (scene purpose) */
  sceneType?: SceneType;
  /** Current narrative pressure (tension level) */
  momentum?: StoryMomentum;
  /** Characters physically present in the scene */
  charactersPresent?: SceneCharacter[];

  // /** How much time duration of this page? */
  // timeElapsed: { // Or ISO 8601 format: 'P1D', 'PT24H', etc
  //   value: number;
  //   unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
  // };
};

/**
 * Representation of a character who is physically present and
 * actively influences the current scene.
 *
 * Used to generate focused prompts, prioritize context and memories,
 * and balance which characters receive narrative attention on the next
 * page or scene.
 */
export type SceneCharacter = {
  /**
   * Unique identifier of the character (character ID string).
   */
  characterId: string;
  /**
   * Role the character plays within this scene's dynamics.
   * Use values from {@link CharacterSceneRole} (e.g. 'supporting', 'opposition').
   */
  sceneRole: CharacterSceneRole;
  /**
   * Relative narrative importance or focus weight for this scene.
   * Higher values indicate the character should receive more attention
   * or drive the upcoming narrative actions.
   */
  sceneFocus: number;
}

/**
 * Enumerates possible roles a character can have within a scene.
 *
 * - 'supporting': assists or allies the protagonist or focal characters.
 * - 'opposition': actively opposes the focal characters but is not an existential threat.
 * - 'neutral': present without strong alignment or impact on immediate conflict.
 * - 'threat': poses a danger or significant obstacle in the scene.
 */
export const characterSceneRoles = [
  'supporting',
  'opposition',
  'neutral',
  'threat'
];

/**
 * Type union of allowed CharacterSceneRole string literals derived from
 * the characterSceneRoles array.
 */
export type CharacterSceneRole = typeof characterSceneRoles[number];

/**
 * Narrative pressure and urgency level guidance for story generation.
 *
 * Story momentum reflects the current level of tension, urgency, and
 * narrative pressure experienced by the reader.
 *
 * Unlike story phase, momentum is dynamic and may rise or fall
 * throughout the story depending on recent events, unresolved
 * conflicts, active mysteries, and immediate stakes.
 *
 * Descriptive, not prescriptive:
 * This is guidance rather than a strict requirement. The next page
 * should evolve naturally from previous events and may increase,
 * maintain, decrease, or resolve pressure when justified.
 */
export const storyMomentums = {
  /** Calm progression, setup, exploration, and foreshadowing. */
  building: "Characterized by atmosphere, curiosity, setup, exploration, and subtle developments. Introduce questions, clues, or concerns without immediate payoff.",
  /** Escalating tension, stakes, and uncertainty. */
  rising: "Characterized by increasing tension, complications, uncertainty, and mounting pressure. Escalate stakes while avoiding major resolution.",
  /** Maximum urgency, danger, or emotional intensity. */
  critical: "Characterized by urgency, major consequences, decisive actions, revelations, and strong emotional intensity.",
  /** Recovery, reflection, resolution, and emotional payoff. */
  resolution: "Characterized by consequences, reflection, recovery, closure, and emotional payoff for what just happened. Resolve prior tension rather than escalate — but still close the page on a forward-pulling beat per PAGE NARRATIVE RULES (a new doubt or quiet wrongness), never total closure.",
} as const;

/**
 * Union type of all possible story momentum keys
 */
export type StoryMomentum = keyof typeof storyMomentums;

export interface CalculateStoryMomentumParams {
  /** Final story state for the new page (after applyStateDelta). */
  state: StoryState;
  /** The new page's number — pass explicitly rather than relying on state.page. */
  currentPage: number;
  /** Scene type for the new page (StoryGeneration.sceneType). */
  sceneType?: SceneType;
  /** Characters IDs present in the new page's scene. */
  charactersPresent?: SceneCharacter[];
  /** Momentum of the parent page (actionedPage.momentum), if known. */
  previousMomentum?: StoryMomentum;
}

export interface StoryMomentumResult {
  momentum: StoryMomentum;
  rawScore: number;
  smoothedScore: number;
  factors: {
    plotPressure: number;
    threadPressure: number;
    dangerLevel: number;
    urgencyLevel: number;
    psychPressure: number;
  };
}

/**
 * Immediate narrative function of the current scene.
 *
 * Scene type describes what role the current scene serves in the story.
 * It helps guide pacing, focus, information flow, and prose style.
 *
 * Unlike story phase or momentum, scene type is highly local and may
 * change from page to page.
 * 
 * Priority when multiple types strongly apply:
 * revelation
 * > confrontation
 * > escape
 * > investigation
 * > deception
 * > horror
 * > dream
 * > dialogue
 * > aftermath
 * > transition
 */
export const sceneTypes = {
  /** Expose important truths, hidden information, or major twists. */
  "revelation": "Reveal hidden truths, connect clues, and permanently twist the MC's understanding of the plot.",
  /** Direct conflict, forced choices, or decisive confrontations. */
  "confrontation": "Drive direct conflict. Force a high-stakes clash of motives, difficult choices, and immediate consequences.",
  /** Immediate danger requiring flight, pursuit, or survival. */
  "escape": "Maximize urgency and pacing. Write frantic, survival-focused action with immediate physical threats and zero time to think.",
  /** Gather clues, explore surroundings, or build understanding. */
  "investigation": "Focus heavily on environmental storytelling, sensory details, clues, and gradual understanding.",
  /** Conceal intentions, manipulate perceptions, or mislead. */
  "deception": "Focus on secrets, lies, manipulation, hidden motives, and unreliable information.",
  /** Evoke dread, fear, or psychological threat — anticipated or active. */
  "horror": "Focus on dread, anticipation, fear, vulnerability, disturbing discoveries, and psychological or physical threat.",
  /** Surreal, symbolic, memory-like, or subconscious experience. */
  "dream": "Focus on symbolism, distorted logic, emotional imagery, and subconscious or fractured-reality themes.",
  /** Character interaction and relationship development. */
  "dialogue": "Focus on conversation, subtext, relationships, emotions, motives, and interpersonal dynamics.",
  /** Process consequences, recover, or move toward what's next. */
  "aftermath": "Focus on the emotional fallout, physical exhaustion, and the realization of what was just lost or survived.",
  /** Connect major scenes or story developments. */
  "transition": "Focus on movement, preparation, travel, recovery, or progression toward the next major event.",
} as const;

/**
 * Union type of all possible story momentum keys
 */
export type SceneType = keyof typeof sceneTypes;

/**
 * Story page structure for AI-generated content
 * 
 * Contains the complete page content, metadata, and character updates
 * for maintaining narrative consistency and character development.
 * 
 * @interface StoryPage
 */
export type StoryPage = StoryScene & {
  /** Main story page content (60-120 words, first-person POV) */
  text: string;
  /** Key events that occurred in the page */
  keyEvents?: string[];
  /** Important objects mentioned in the page */
  importantObjects?: string[];
  /** Next branching actions for user choice (2-3 options) */
  actions: Action[];
  /** Changes to the story state */
  stateDelta: StateDelta;
};

export type StoryPageMeta = Pick<DBNewPage, 'bookId' | 'branchId' | 'parentId'> & {
  // /** Optional selected action that triggered this page generation (for duplicate prevention) */
  // selectedAction?: SelectedAction;
  aiResponseProvider: AIResponseProvider;
  storyStartDate?: string;
};

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
  flagUpdates?: FlagUpdate[];
  /** Updates to trauma tags (add/remove) based on page events */
  traumaTagUpdates?: TagUpdates<string>;
  /** Updates to future notes (add/remove) based on story progression */
  futureNoteUpdates?: TagUpdates<FutureNote>;
  /** Updates to plot flags (add) for story progression */
  addPlotFlags?: InitialPlotFlag[];
  /** What durable facts about the story world changed */
  factUpdates?: FactUpdate[];
  /** Updates to characters (new and existing) with changes */
  characterUpdates?: CharacterUpdates;
  /** Updates to character relationships and dynamics */
  relationshipUpdates?: RelationshipUpdate[];
  /** Updates to connection between places */
  placeConnectionUpdates?: PlaceConnectionUpdate[];
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
  /** AI-authored minutes elapsed for this scene (fallback to heuristic if omitted) */
  minutesPassed?: number;

  /** Psychological state */
  psychologicalProfileUpdates?: Partial<PsychologicalProfile>;
  hiddenStateUpdates?: Partial<HiddenState>;
  memoryIntegrity?: MemoryIntegrity;
  difficulty?: Difficulty;
};

export type FlagUpdate = {
  type: keyof PsychologicalFlags;
  level: FlagLevel;
};

export type PsychologicalStateDelta = Pick<StateDelta, 'psychologicalProfileUpdates' | 'hiddenStateUpdates' | 'memoryIntegrity' | 'difficulty'>;

export type StateDeltaGeneration = Omit<StateDelta, keyof PsychologicalStateDelta | 'futureNoteUpdates' | 'isMajorEvent'> & {
  futureNoteUpdates?: {
    add?: FutureNoteGeneration[];
    remove?: string[];
  }
};
export type StoryPageGeneration = Omit<StoryPage, ResourceAIProvider | 'stateDelta' | 'momentum' | 'elapsedDays'>;
export type StoryGeneration = StoryPageGeneration & StateDeltaGeneration;
export type InitialStoryPageGeneration = Omit<StoryPageGeneration, 'placeId'> & Pick<StoryPage, 'momentum'>;

export type PersistedStoryPage = StoryPage & Pick<DBPage, 'id' | 'bookId' | 'branchId' | 'parentId' | 'page' | 'elapsedDays' | ResourceAIProvider | ResourceTimestamp>;
export type UserStoryPage = PersistedStoryPage & { selectedActions: SelectedAction[] };
export type ActionedStoryPage = PersistedStoryPage & { selectedAction: SelectedAction };
export interface CommunityAction {
  text: string;
  plausibilityScore: number;
}

export type EnrichedStoryPage = Partial<Omit<UserStoryPage, 'stateDelta'>> & {
  originalActionsCount: number;
  translation?: PageTranslation;
  sourceAction?: SelectedAction;
  shownActionHint: string[];
  context?: EnrichedStoryPageContext;
  elapsedDays?: number;
  /** Previously-submitted custom actions from other readers on this page,
   * filtered to the same headerLanguage, sorted by plausibilityScore DESC (max MAX_ACTION_CHOICES_COMMUNITY).
   * Frontend may surface these as one-click action suggestions. */
  communityActions?: CommunityAction[];
  aiProvider?: AIChatProvider | 'none';
  aiModel?: string;
};

export type TranslatedStoryPage = Omit<PersistedStoryPage, 'weather' | 'mood'> & { weather?: string; mood?: string; };

export type EnrichedStoryPageContext = {
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
  places: EnrichedStoryPagePlace[];
  /** All known characters so far */
  characters: EnrichedStoryPageCharacter[];
  /** Collection of narrative flags and hints for the current page */
  plotFlags: PlotFlag[];
  /** Collection of ongoing narrative threads in the story */
  threads: StoryThread[];
};

export type EnrichedStoryPagePlace = Pick<PlaceMemory, 'type' | 'context'> & { placeId: string; name: string; };
export type EnrichedStoryPageCharacter = Pick<CharacterMemory, 'gender' | 'role' | 'bio'> & { characterId: string; name: string; };

export type NarrativeContext = {
  momentum?: StoryMomentum;
  sceneType?: SceneType;
  phase?: StoryPhase;
};

export type ActionSource = 'ai' | 'custom' | 'community';

export type Action = {
  /** Action text (serves as unique identifier) */
  text: string;
  /** Category of action for psychological impact */
  type: ActionType;
  /** Consequence hint for the action (for AI guidance) */
  hint: ActionHint;
  /** Destination meta for the action */
  destinationPageIds?: string[];
  source?: ActionSource;
  /**
   * 0–1 alignment score between this action and the reader's established
   * psychological pattern (computed post-generation).
   */
  tendency?: number;
};

export type SelectedAction = Pick<Action, 'text' | 'type' | 'hint' | 'source'> & {
  /** Action source */
  pageId: string;
  /** Action source page number */
  page: number;
  /** Action destination */
  nextPageId: string;
  // /** Whether this selection is paid (not primary selection) */
  // isPaid?: boolean;
};

export type ActionGeneration = Omit<Action, 'destinationPageIds' | 'source' | 'tendency'>;
// export type ActionHistory = Action & { page: number };
export type ActionTranslation = {
  /** Original action text (serves as unique identifier) */
  originalText: string;
  /** Translated action text */
  text: string;
  /** Translated action hint */
  hint: string;
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
   * Key: character ID
   */
  characters: Record<string, CharacterMemory>;
  plannedCharacters: CharacterPlan[];

  /**
   * Place memory system for narrative consistency
   * 
   * Stores all places encountered in the story with their
   * visit history, emotional associations, and narrative connections.
   * This enables consistent world-building and psychological anchoring.
   * 
   * Key: place ID
   */
  places: Record<string, PlaceMemory>;
  // To consider: plannedPlaces: PlacePlan[];

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

  /** Narrative reminders for future AI generations */
  futureNotes: FutureNote[];

  // /** How much time duration until this page? */
  // planning & concerns:
  // - track and handle time skips (but this is a fast-paced thriller story)
  // - if total duration >= 1 year, increment MC's age (inaccurate and not really important)
  // - how can timeOfDay of next page generation be consistent?
  // - but sometimes time elapsed is unknown/unreliable in mystery story
  //
  // timePassed: // ISO 8601 format: 'P1D', 'PT24H', etc
  // only if `timeElapsed` implemented
} & StoryMCState;

export type StoryMCState = {
  /**
   * Collection of items and resources present in the world at the current page
   * 
   * Stores information about items and resources that are available
   * in the world at the current page and their potential impact on the story.
   */
  inventory: InventoryItem[];

  /** Represents injuries sustained by the MC */
  injuries: Injury[];

  /** Deterministically derived (never authored by AI). */
  healthStatus?: HealthStatus;

  /**
   * Reader-facing sanity/composure resource.
   * Decays under pressure, can be spent to resist reality collapse.
   * At 0, forces crisis mode that can lock in bad endings.
   */
  sanityState?: SanityState;
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

export type StoryStateSnapshotType = "interval" | "first" | "middle" | "last" | "checkpoint";

export type StoryStateSource = 'original' | 'reconstructed';

export type InitialStoryState = Partial<Pick<StoryState, 'flags' | 'difficulty' | 'traumaTags' | 'plotFlags' | 'inventory'> & {
  injuries: InitialInjury[];
}>;

/**
 * Story Phase Directives
 */
export const storyPhases = {
  EARLY: `(Intrigue & Seeding) — Ground the character and introduce the core mystery. Establish an atmosphere of subtle unease by planting initial seeds of unreliability and doubt. Keep tension light, prioritizing intrigue over outright dread.`,
  MID: `(Escalation & Rhythm) — Warp the MC's grip on reality and actively escalate psychological pressure. Balance active threads using varied build-and-release tension cycles, exploiting established character patterns to complicate the horror.`,
  LATE: `(Convergence & Fracture) — Drive tensions to a volatile flashpoint where mental distortions reach full parity. Introduce no new major threads; focus strictly on converging existing storylines and collapsing open questions toward the viable ending.`,
  FINALE: `(Collapse & Resolution) — Execute full psychological and narrative collapse at maximum "NIGHTMARE" difficulty. Prefer a focused cast. Introduce no new characters or mysteries—every active thread must definitively resolve or deliberately shatter.`,
};

export const finalePhases = {
  EARLY: `
- Phase: FALSE SAFETY / ILLUSION OF RESOLUTION
- Goals: Provide a false sense of closure. Resolve the surface-level tension, slow the pacing, and give the protagonist (and reader) emotional release.
- Tone: Calm, hopeful, but underscored with a deeply buried, uncanny wrongness.
- Rules: Absolutely NO obvious horror. The threat appears completely gone.`,

  MID: `
- Phase: THE CRACK / DISTORTION
- Goals: Introduce the first undeniable proof that the safety is a lie, specifically setting up this ending: [{endingDescription}].
- Techniques: Do not jump straight to the reveal. Introduce a small, fatal contradiction. A dropped word, a physical impossibility, a character breaking pattern, or a sudden horrifying realization of consequence.
- End With: A quiet, internal realization sentence from the protagonist that something is terribly wrong.`,

  END: `
- Phase: IMPACT / PARADIGM SHIFT
- Goals: Execute the final twist: [{endingDescription}]. Recontextualize the entire story and hit psychologically.
- Structure: The Reveal → The Hopeless Recontextualization → The Final Haunting Line.
- Rules: The final line must be short, clear, and haunting. It should confirm the horror of the new reality without over-explaining it.`
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
  /** Page number of the interaction */
  page: number;
  /** Interaction between characters */
  event: string;
  /** Place ID where the interaction occurred. */
  placeId?: string;
};

export type TraitItem = {
  key: string;
  value: string;
};

export type StoryPlan = {
  /** Detected language code (ISO 639-1) */
  language: string;
  /** Book title idea for the story based on the theme */
  titleIdea?: string;
  /** Inferred main character who perfectly fit with the story theme */
  mcCandidate?: StoryMCCandidate;
}