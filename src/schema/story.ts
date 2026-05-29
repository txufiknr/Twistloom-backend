import type { AIJsonEvaluation, AIJsonProperty } from "../types/ai-chat.js";
import { relationshipStatuses, relationshipTypes, type CharacterUpdates, type Injury, type InventoryItem, type RelationshipUpdate } from "../types/character.js";
import { endingTypes } from "../types/story.js";
import type { StoryOutline, Action, ActionHint, Archetype, Ending, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, TagUpdates, ThreatProximity, TruthLevel, MemoryIntegrity, Difficulty, TrustLevel, FearLevel, GuiltLevel, CuriosityLevel } from "../types/story.js";

export const STORY_ACTION_SCHEMA: AIJsonProperty = { type: 'array', items: {
  type: 'object',
  properties: {
    text: { type: 'string' },
    type: { type: 'string' },
    hint: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        type: { type: 'string' },
      },
      required: ['text', 'type'] satisfies (keyof ActionHint)[],
      additionalProperties: false
    },
  },
  required: ['text', 'type', 'hint'] satisfies (keyof Action)[],
  additionalProperties: false
} };

export const INVENTORY_ITEM_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    name:   { type: 'string' },
    traits: { type: 'object' },
    amount: { type: 'integer' },
    where:  { type: 'string' },
  },
  required: ['name', 'amount', 'where'] satisfies (keyof InventoryItem)[],
  additionalProperties: false
};

export const INJURY_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    bodyPart:      { type: 'string' },
    description:   { type: 'string' },
    consequences:  { type: 'string' },
    pageAcquired:  { type: 'integer' },
    severity:      { type: 'number' },
    decayPerPage:  { type: 'number' },
  },
  required: ['bodyPart', 'description', 'severity', 'decayPerPage', 'pageAcquired'] satisfies (keyof Injury)[],
  additionalProperties: false
};

export const VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    type: { type: 'string', enum: Object.keys(endingTypes) as EndingType[] },
    outline: { type: 'array', items: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        isDone: { type: 'boolean' },
      },
      required: ['text', 'isDone'] satisfies (keyof StoryOutline)[],
      additionalProperties: false
    } },
  } satisfies Record<keyof Ending, AIJsonProperty>,
  required: ['text', 'type'] satisfies (keyof Ending)[],
  additionalProperties: false
};

export const TAG_UPDATES_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    add:    { type: 'array', items: { type: 'string' } },
    remove: { type: 'array', items: { type: 'string' } },
  } satisfies Record<keyof TagUpdates, AIJsonProperty>,
  required: ['add', 'remove'] satisfies (keyof TagUpdates)[],
  additionalProperties: false
};

/**
 * Common schema definition for StoryGeneration type
 * 
 * This is the single source of truth for StoryGeneration schema.
 * All helper functions reference this to avoid duplication.
 */
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  // Page
  text: { type: 'string' },
  mood: { type: 'string' },
  place: { type: 'string' },
  timeOfDay: { type: 'string' },
  charactersPresent: { type: 'array', items: { type: 'string' } },
  keyEvents: { type: 'array', items: { type: 'string' } },
  importantObjects: { type: 'array', items: { type: 'string' } },
  actions: STORY_ACTION_SCHEMA,

  // State Delta
  // TODO: object schema
  flagUpdates: { type: 'object' },
  addPlotFlag: { type: 'object' },

  traumaTagUpdates: TAG_UPDATES_SCHEMA,
  futureNoteUpdates: TAG_UPDATES_SCHEMA,

  characterUpdates: {
    type: 'object',
    properties: {
      newCharacters: {
        type: 'array',
        // TODO: object schema
        description: 'New characters introduced in this page. Empty array if none.',
        items: { type: 'object' },
      },
      updatedCharacters: {
        type: 'array',
        // TODO: object schema
        description: 'Characters whose details have been updated in this page. Empty array if none.',
        items: { type: 'object' },
      },
    } satisfies Record<keyof CharacterUpdates, AIJsonProperty>,
    required: ['newCharacters', 'updatedCharacters'] satisfies (keyof CharacterUpdates)[],
    additionalProperties: false
  },
  relationshipUpdates: {
    type: 'array',
    description: 'Updates to relationships between side characters in this page. Empty array if none.',
    items: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        type: { type: 'string', enum: [...relationshipTypes] },
        status: { type: 'string', enum: [...relationshipStatuses] },
      } satisfies Record<keyof RelationshipUpdate, AIJsonProperty>,
      required: ['source', 'target', 'status'] satisfies (keyof RelationshipUpdate)[],
      additionalProperties: false
    },
  },
  // TODO: object schema
  placeUpdates: { type: 'object' },
  threadUpdates: { type: 'object' },
  viableEnding: { type: 'object' },
  // viableEnding: VIABLE_ENDING_SCHEMA,

  isMajorEvent: { type: 'boolean' },
  contextHistory: { type: 'string' },
  inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA },
  injuries: { type: 'array', items: INJURY_SCHEMA },
} satisfies Record<keyof StoryGeneration, AIJsonProperty>;

export const STORY_GENERATION_REQUIRED_FIELDS = ['text', 'actions'] satisfies Array<keyof StoryGeneration>;

export const EVALUATION_SCHEMA_DEFINITION = {
  // TODO: object schema
  output: { type: 'object' },
  scoreBefore: { type: 'object' },
  scoreAfter: { type: 'object' },
  // TODO: object schema
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
    trust: 'medium' satisfies TrustLevel,
    fear: 'low' satisfies FearLevel,
    guilt: 'low' satisfies GuiltLevel,
    curiosity: 'medium' satisfies CuriosityLevel
  },
  threads: [],
  traumaTags: [],
  futureNotes: [],
  plotFlags: [],
  psychologicalProfile: PSYCHOLOGICAL_PROFILE_DEFAULTS,
  hiddenState: HIDDEN_STATE_DEFAULTS,
  memoryIntegrity: 'stable' satisfies MemoryIntegrity,
  difficulty: 'medium' satisfies Difficulty,
  viableEnding: undefined,
  characters: {},
  places: {},
  actionsHistory: [],
  contextHistory: '',
  isMajorEvent: false,
  inventory: [],
  injuries: [],
};