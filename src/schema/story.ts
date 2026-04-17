import type { AIJsonEvaluation, AIJsonProperty } from "../types/ai-chat.js";
import type { Archetype, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, ThreatProximity, TruthLevel } from "../types/story.js";

/**
 * Common schema definition for StoryGeneration type
 * 
 * This is the single source of truth for StoryGeneration schema.
 * All helper functions reference this to avoid duplication.
 */
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  text: { type: 'string' },
  mood: { type: 'string' },
  place: { type: 'string' },
  timeOfDay: { type: 'string' },
  charactersPresent: { type: 'array', items: { type: 'string' } },
  keyEvents: { type: 'array', items: { type: 'string' } },
  importantObjects: { type: 'array', items: { type: 'string' } },
  actions: { type: 'array', items: { type: 'object' } },
  addTraumaTag: { type: 'string' },
  characterUpdates: { type: 'object' },
  relationshipUpdates: { type: 'array', items: { type: 'object' } },
  placeUpdates: { type: 'object' },
  threadUpdates: { type: 'object' },
  viableEnding: { type: 'object' },
  isMajorEvent: { type: 'boolean' }
} satisfies Record<keyof StoryGeneration, AIJsonProperty>;

export const STORY_GENERATION_REQUIRED_FIELDS = ['text', 'actions'] satisfies Array<keyof StoryGeneration>;

export const EVALUATION_SCHEMA_DEFINITION = {
  output: { type: 'object' },
  scoreBefore: { type: 'object' },
  scoreAfter: { type: 'object' },
  actionFlags: { type: 'array', items: { type: 'object' } },
  integrityFlags: { type: 'array', items: { type: 'object' } },
} satisfies Record<keyof AIJsonEvaluation<Record<string, unknown>>, AIJsonProperty>;

export const EVALUATION_REQUIRED_FIELDS = ['output', 'scoreBefore', 'scoreAfter', 'actionFlags', 'integrityFlags'] satisfies Array<keyof AIJsonEvaluation<Record<string, unknown>>>;

export const PSYCHOLOGICAL_PROFILE_DEFAULTS: PsychologicalProfile = {
  archetype: 'the_explorer' satisfies Archetype,
  stability: 'stable' satisfies StabilityLevel,
  dominantTraits: ['curious', 'cautious'],
  manipulationAffinity: 'fear' satisfies ManipulationAffinity,
};

export const HIDDEN_STATE_DEFAULTS: HiddenState = {
  truthLevel: 'mostly_true' satisfies TruthLevel,
  threatProximity: 'distant' satisfies ThreatProximity,
  realityStability: 'stable' satisfies RealityStability,
}

export const STORY_STATE_DEFAULTS: Omit<StoryState, 'pageId' | 'page' | 'maxPage'> = {
  flags: {
    trust: 'medium',
    fear: 'low',
    guilt: 'low',
    curiosity: 'medium'
  },
  threads: [],
  traumaTags: [],
  psychologicalProfile: PSYCHOLOGICAL_PROFILE_DEFAULTS,
  hiddenState: HIDDEN_STATE_DEFAULTS,
  memoryIntegrity: 'stable',
  difficulty: 'medium',
  viableEnding: undefined,
  characters: {},
  places: {},
  pageHistory: [],
  actionsHistory: [],
  contextHistory: ''
};