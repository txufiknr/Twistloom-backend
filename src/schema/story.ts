import { FACT_KEY_FORMAT, MAX_CHARACTER_SECRETS, MAX_FUTURE_NOTES, MAX_TRAUMA_TAGS, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT, RELATIONSHIP_TO_MC_LENGTH } from "../config/story.js";
import { characterStatuses, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import type { CharacterMemory, NarrativeFlags, CharacterUpdates, RelationshipUpdate, InitialInventoryItem, InitialInjury, InventoryItem, Injury } from "../types/character.js";
import { placeMoods, placeTypes, placeWeathers, type NewPlace, type PlaceUpdates } from "../types/places.js";
import { actionHintTypes, factTypes, moods } from "../types/story.js";
import type { AIJsonEvaluation, AIJsonProperty, AIPromptOptions } from "../types/ai-chat.js";
import type { ActionHint, Archetype, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, TagUpdates, ThreatProximity, TruthLevel, MemoryIntegrity, Difficulty, TrustLevel, FearLevel, GuiltLevel, CuriosityLevel, StoryPageGeneration, TagItem, FutureNote, FactUpdate, StateDeltaGeneration, ActionGeneration } from "../types/story.js";
import type { ThreadUpdates } from "../types/thread.js";
import type { CandidatePagesGeneration } from "../types/candidate-generation.js";
import { genders } from "../types/user.js";

export const STORY_ACTION_SCHEMA: AIJsonProperty = { type: 'array', items: {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text of the action as presented to the player' },
    type: { type: 'string', description: 'Type of the action' },
    hint: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What will happen as a consequence for the action' },
        type: { type: 'string', description: 'The type of the hint', enum: [...actionHintTypes] },
      } satisfies Record<keyof ActionHint, AIJsonProperty>,
      required: ['text', 'type'] satisfies (keyof ActionHint)[],
      additionalProperties: false
    },
  } satisfies Record<keyof ActionGeneration, AIJsonProperty>,
  required: ['text', 'type', 'hint'] satisfies (keyof ActionGeneration)[],
  additionalProperties: false
} };

export const INITIAL_INVENTORY_ITEM_PROPERTIES: Record<keyof InitialInventoryItem, AIJsonProperty> = {
  name:   { type: 'string', description: 'Name of the inventory item' },
  traits: { type: 'object', description: 'Traits or properties of the inventory item' },
  amount: { type: 'integer', description: 'Quantity of the inventory item' },
  where:  { type: 'string', description: 'Where the inventory item is located' },
};

export const INITIAL_INVENTORY_ITEM_KEYS: (keyof InitialInventoryItem)[] = ['name', 'amount', 'where'];

export const INITIAL_INVENTORY_ITEM_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_INVENTORY_ITEM_PROPERTIES,
  required: INITIAL_INVENTORY_ITEM_KEYS,
  additionalProperties: false
};

export const INVENTORY_ITEM_SCHEMA: AIJsonProperty = {
  ...INITIAL_INVENTORY_ITEM_SCHEMA,
  properties: {
    ...INITIAL_INVENTORY_ITEM_PROPERTIES,
    pageAcquired: { type: 'integer', description: 'Page number when the item was acquired' }
  } satisfies Record<keyof Omit<InventoryItem, 'place'>, AIJsonProperty>,
  required: [...INITIAL_INVENTORY_ITEM_KEYS, 'pageAcquired'] satisfies (keyof InventoryItem)[],
};

export const INITIAL_INJURY_PROPERTIES: Record<keyof InitialInjury, AIJsonProperty> = {
  bodyPart:      { type: 'string', description: 'Body part that was injured' },
  description:   { type: 'string', description: 'Description of the injury' },
  consequences:  { type: 'string', description: 'Consequences of the injury that can affect the storyline' },
  severity:      { type: 'number', description: 'Severity of the injury (0-1)' },
  decayPerPage:  { type: 'number', description: 'Rate at which the injury decays per page' },
};

export const INITIAL_INJURY_KEYS: (keyof InitialInjury)[] = ['bodyPart', 'description', 'severity', 'decayPerPage'];
export const INITIAL_INJURY_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_INJURY_PROPERTIES,
  required: INITIAL_INJURY_KEYS,
  additionalProperties: false
};

export const INJURY_SCHEMA: AIJsonProperty = {
  ...INITIAL_INJURY_SCHEMA,
  properties: {
    ...INITIAL_INJURY_PROPERTIES,
    pageAcquired: { type: 'integer', description: 'Page number when the item was acquired' }
  } satisfies Record<keyof Omit<Injury, 'place'>, AIJsonProperty>,
  required: [...INITIAL_INJURY_KEYS, 'pageAcquired'] satisfies (keyof Injury)[],
};

export const CHARACTER_NARRATIVE_FLAGS_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    isSuspicious: { type: 'boolean' },
    isMissing: { type: 'boolean' },
    isDead: { type: 'boolean' },
    hasSecret: { type: 'boolean' },
    potentialTwist: { type: 'string', enum: [...potentialTwistTypes] }
  } satisfies Record<keyof NarrativeFlags, AIJsonProperty>,
  required: ['isSuspicious', 'isMissing', 'isDead', 'hasSecret', 'potentialTwist'] satisfies (keyof NarrativeFlags)[],
  additionalProperties: false
};

function getTagUpdatesSchema<T extends TagItem>(description?: string): AIJsonProperty {
  return {
    type: 'object',
    description,
    properties: {
      add:    { type: 'array', items: { type: 'string' } },
      remove: { type: 'array', items: { type: 'string' } },
    } satisfies Record<keyof TagUpdates<T>, AIJsonProperty>,
    required: ['add', 'remove'] satisfies (keyof TagUpdates<T>)[],
    additionalProperties: false
  };
};

export const STORY_PAGE_GENERATION_SCHEMA: Record<keyof StoryPageGeneration, AIJsonProperty> = {
  text: { type: 'string', description: `Main story page content. First-person central ("I") POV as MC. Max ${MAX_WORDS_PER_PAGE} words.` },
  mood: { type: 'string', description: 'Current emotional atmosphere', enum: [...moods] },
  place: { type: 'string', description: 'Current place name' },
  timeOfDay: { type: 'string', description: `Current time mark, e.g. time range, 'night', 'HH:mm', 'unknown'` },
  charactersPresent: { type: 'array', items: { type: 'string' }, description: 'Names of characters present in this page besides MC' },
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Key events that occurred in this page' },
  importantObjects: { type: 'array', items: { type: 'string' }, description: 'Important objects in this page' },
  actions: STORY_ACTION_SCHEMA
};

export const STORY_STATE_GENERATION_SCHEMA: Record<keyof StateDeltaGeneration, AIJsonProperty> = {
  traumaTagUpdates: getTagUpdatesSchema<string>(`Max ${MAX_TRAUMA_TAGS} items — representing haunting experiences that can be referenced by the story and affect MC's psychological profile.`),
  futureNoteUpdates: getTagUpdatesSchema<FutureNote>(`Max ${MAX_FUTURE_NOTES} items — important notes for future AI turns representing narrative obligations towards the viableEnding (future incidents, characters, place, etc).`),
  factUpdates: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: `${FACT_KEY_FORMAT} (new or existing)` },
        value: { type: 'string' },
        page: { type: 'integer' },
        type: { type: 'string', enum: [...Object.keys(factTypes)] },
        reason: { type: 'string', description: 'Explain why or how it happened in 1 sentence' },
      } satisfies Record<keyof FactUpdate, AIJsonProperty>,
      required: ['key', 'value', 'page'] satisfies (keyof FactUpdate)[],
      additionalProperties: false
    }
  },

  placeUpdates: {
    type: 'object',
    properties: {
      newPlaces: {
        type: 'array',
        description: 'New places visited if any.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Place name as it appears in the narrative' },
            type: { type: 'string', enum: [...placeTypes], description: 'Type of place for categorization and behavior patterns' },
            context: { type: 'string', description: 'Short human-readable description for immediate recall' },
            locationHint: { type: 'string', description: 'Spatial relationship to other places' },
            visitCount: { type: 'integer', description: 'Number of times the place has been visited. One for first visit.' },
            lastVisitedAtPage: { type: 'integer', description: 'The page number when the place was last visited. Current page for first visit.' },
            familiarity: { type: 'number', description: 'A measure of how familiar the character is with the place (0-1)' }, // 0-1, important for reuse priority
            events: { type: 'array', items: { type: 'string' }, description: 'Meaningful events that occurred at this place, e.g. "MC discovered the place", "first meeting with Character A"' },
            knownCharacters: { type: 'object', description: 'A map of characters known to be at this place' },
            sensoryDetails: { type: 'object', description: 'Optional sensory details for consistent atmosphere' },
            weather: { type: 'string', enum: [...placeWeathers], description: 'Current weather conditions at the place' },
            currentMood: { type: 'string', enum: [...placeMoods], description: 'Current emotional atmosphere of the place' },
            moodHistory: { type: 'array', items: { type: 'string', enum: [...placeMoods] }, description: 'A history of moods associated with the place. Contains only current mood for first visit.' },
          } satisfies Record<keyof NewPlace, AIJsonProperty>,
          required: ['name', 'type', 'context', 'lastVisitedAtPage', 'familiarity'] satisfies (keyof NewPlace)[],
          additionalProperties: false
        },
      },
      updatedPlaces: {
        type: 'array',
        description: 'Places which details have been updated if any.',
        items: { type: 'object' },
      },
    } satisfies Record<keyof PlaceUpdates, AIJsonProperty>,
    required: ['newPlaces', 'updatedPlaces'] satisfies (keyof PlaceUpdates)[],
    additionalProperties: false
  },

  characterUpdates: {
    type: 'object',
    properties: {
      newCharacters: {
        type: 'array',
        description: 'New characters introduced if any.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            gender: { type: "string", enum: [...genders] },
            status: { type: 'string', enum: [...characterStatuses] },
            relationshipToMC: { type: 'string', description: `Specific dynamic, not generic (${RELATIONSHIP_TO_MC_LENGTH}).` },
            bio: { type: 'string', description: "Brief character description. Include one trait that could become a source of threat or betrayal." },
            visualDescription: { type: 'string', description: "Character visual description (e.g. height, skin color, eye color, hair, etc)." },
            secrets: { type: 'array', items: { type: 'string' }, description: `Any secrets the character has that the MC doesn't know (max ${MAX_CHARACTER_SECRETS}).` },
            narrativeFlags: CHARACTER_NARRATIVE_FLAGS_SCHEMA,
            injuries: { type: 'array', items: { type: 'object' } },
            relationships: { type: 'array', items: { type: 'object' } },
            pastInteractions: { type: 'array', items: { type: 'object' } },
            introducedAtPage: { type: 'integer' }
          } satisfies Record<keyof CharacterMemory, AIJsonProperty>,
          required: ['name', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription', 'secrets', 'introducedAtPage'] satisfies (keyof CharacterMemory)[],
          additionalProperties: false
        },
      },
      updatedCharacters: {
        type: 'array',
        // TODO: object schema
        description: 'Characters whose details have been updated if any.',
        items: { type: 'object' },
      },
    } satisfies Record<keyof CharacterUpdates, AIJsonProperty>,
    required: ['newCharacters', 'updatedCharacters'] satisfies (keyof CharacterUpdates)[],
    additionalProperties: false
  },

  relationshipUpdates: {
    type: 'array',
    description: 'Updates to relationships between side characters if any.',
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

  isMajorEvent: { type: 'boolean', description: 'Whether this page contains a major event that significantly impacts the story trajectory. Major events include: a) major secrets revealed, b) critical evidence discovered, c) key relationship changes, d) significant story direction pivots.' },
  contextHistory: { type: 'string', description: `Summary of important story context from page 1 up to this point. Focus on key facts, relationships, and developments for story continuity. Max ${MAX_WORDS_SUMMARIZED_CONTEXT} words.` },
  
  // Optional objects, can omit or empty if no updates
  threadUpdates: {
    type: 'object',
    description: 'Updates to narrative threads. Omit if no update.',
    properties: {
      newThreads: { type: 'array', description: 'New important core mysteries if any.', items: { type: 'object' } },
      updateThreads: { type: 'array', description: 'Updates to existing threads if any.', items: { type: 'object' } },
      addClues: { type: 'array', description: 'Clues to be added to existing threads if any.', items: { type: 'object' } },
      closeThreads: { type: 'array', description: 'Threads to be closed if any.', items: { type: 'string' } },
    } satisfies Record<keyof ThreadUpdates, AIJsonProperty>,
    // Note: no any required fields, but Cohere requires at least one field in `required` array
    required: ['newThreads'] satisfies (keyof ThreadUpdates)[],
    additionalProperties: false
  },
  flagUpdates: { type: 'object', description: 'Updates to psychological flags (trust, fear, guilt, curiosity). Omit if no update.' },
  addPlotFlag: { type: 'object', description: 'What already happened — Significant plot development that impact narrative trajectory.' },
  viableEnding: { type: 'object', description: 'An ending plan for the story. Omit if no update.' },

  // Provide full to overwrite current. Can omit or empty if no changes.
  inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA, description: 'Items added to or removed from inventory on this page. Empty array if no changes.' },
  injuries: { type: 'array', items: INJURY_SCHEMA, description: 'Injuries sustained on this page. Injuries severity are automatically decaying. Empty array if no changes.' },
}

/**
 * Common schema definition for StoryGeneration type
 * 
 * This is the single source of truth for StoryGeneration schema.
 * All helper functions reference this to avoid duplication.
 */
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  ...STORY_PAGE_GENERATION_SCHEMA, // Page
  ...STORY_STATE_GENERATION_SCHEMA // State Delta
} satisfies Record<keyof StoryGeneration, AIJsonProperty>;

export const STORY_GENERATION_REQUIRED_FIELDS = ['text', 'actions'] satisfies Array<keyof StoryGeneration>;

/**
 * Schema definition for PageTranslation type
 */
export const CANDIDATE_GENERATION_SCHEMA_DEFINITION = {
  generatedPages: { type: 'array', description: 'Generated story pages — alternative fates sourced from the same action', items: {
    type: 'object',
    properties: STORY_GENERATION_SCHEMA_DEFINITION,
    required: STORY_GENERATION_REQUIRED_FIELDS,
    additionalProperties: false
  } },
  output: { type: 'string', description: "Concise comment or verdict" }
} satisfies Record<keyof CandidatePagesGeneration, AIJsonProperty>;

export const CANDIDATE_GENERATION_REQUIRED_FIELDS = ['generatedPages'] satisfies Array<keyof CandidatePagesGeneration>;

export function buildEvaluationSchemaDefinition<T extends Record<string, unknown>>(options: AIPromptOptions): Record<keyof AIJsonEvaluation<T>, AIJsonProperty> {
  const { outputJsonStructure, outputJsonRequired } = options;
  return {
    output: {
      type: 'object',
      properties: outputJsonStructure,
      required: outputJsonRequired,
      additionalProperties: outputJsonStructure ? false : undefined
    },
    // TODO: object schema
    scoreBefore: { type: 'object' },
    scoreAfter: { type: 'object' },
    // TODO: object schema
    actionFlags: { type: 'array', items: { type: 'object' } },
    integrityFlags: { type: 'array', items: { type: 'object' } },
  } satisfies Record<keyof AIJsonEvaluation<T>, AIJsonProperty>;
}

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
  factsHistory: {},
  actionsHistory: [],
  contextHistory: '',
  isMajorEvent: false,
  inventory: [],
  injuries: [],
};