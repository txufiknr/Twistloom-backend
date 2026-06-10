import { FACT_KEY_FORMAT, MAX_CHARACTER_SECRETS, MAX_FUTURE_NOTES, MAX_TRAUMA_TAGS, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT, RELATIONSHIP_TO_MC_LENGTH } from "../config/story.js";
import { characterStatuses, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import type { NarrativeFlags, CharacterUpdates, RelationshipUpdate, InitialInventoryItem, InitialInjury, InventoryItem, Injury, NewCharacter } from "../types/character.js";
import { type NewPlace, placeTypes, type PlaceUpdate, placeWeathers, type PlaceUpdates } from "../types/places.js";
import { actionHintTypes, factTypes, flagLevels, moods, plotFlagTypes, psychologicalFlagsTypes, storyPhases } from "../types/story.js";
import type { AIJsonActionFlag, AIJsonEvaluation, AIJsonEvaluationFix, AIJsonEvaluationIssue, AIJsonIntegrityFlag, AIJsonProperty, AIJsonScoreAfter, AIJsonScoreBefore, AIJsonScoreBreakdown, AIPromptOptions } from "../types/ai-chat.js";
import type { ActionHint, Archetype, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, TagUpdates, ThreatProximity, TruthLevel, MemoryIntegrity, Difficulty, TrustLevel, FearLevel, GuiltLevel, CuriosityLevel, StoryPageGeneration, TagItem, FutureNote, FactUpdate, StateDeltaGeneration, ActionGeneration, FutureNoteGeneration, FlagUpdate, PlotFlagType, InitialPlotFlag } from "../types/story.js";
import { type ThreadClue, threadPriorities, threadStatuses, threadTruths, type UpdateThread, type NewThread, type ThreadUpdates } from "../types/thread.js";
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
    amount: { type: 'integer', description: 'Quantity of the inventory item. Set amount to 0 to remove item.' },
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

export const PLACE_KEY_OBJECT_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    traits: { type: 'object' },
    amount: { type: 'integer' },
    where: { type: 'string', description: 'e.g., "in the corner of the room"' },
  } satisfies Record<keyof InitialInventoryItem, AIJsonProperty>,
  required: ['name'] satisfies (keyof InitialInventoryItem)[],
  additionalProperties: false
};

export const INITIAL_PLACE_PROPERTIES: Record<keyof NewPlace, AIJsonProperty> = {
  name: { type: 'string', description: 'Place name as it appears in the narrative' },
  type: { type: 'string', enum: [...placeTypes], description: 'Type of place for categorization and behavior patterns' },
  context: { type: 'string', description: 'Short human-readable description for immediate recall' },
  familiarity: { type: 'number', description: 'A measure of how familiar the character is with the place (0-1)' }, // 0-1, important for reuse priority
  locationHint: { type: 'string', description: 'Spatial relationship to other places' },
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Meaningful events that occurred at this place (e.g., "MC discovered the place", "first meeting with Character A")' },
  keyObjects: {
    type: 'array',
    description: 'Important story related objects (e.g., wooden chair, cupboard, large mirror, etc)',
    items: PLACE_KEY_OBJECT_SCHEMA
  },
  knownCharacters: { type: 'object', description: 'A map of characters known to be at this place' },
  // sensoryDetails: include only senses present and relevant to the scene.
  traits: { type: 'object', description: 'Any details for narrative consistency (e.g., facing, feeling, sensory details, etc)' },
};

export const { keyEvents: placeEvents, ...placeProperties } = INITIAL_PLACE_PROPERTIES;

export const INITIAL_PLACE_KEYS: (keyof NewPlace)[] = ['name', 'type', 'context', 'familiarity'];

export const INITIAL_PLACE_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_PLACE_PROPERTIES,
  required: INITIAL_PLACE_KEYS,
  additionalProperties: false
};

export const FUTURE_NOTE_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    isMajor: { type: 'boolean', description: 'Whether the note contains a major event that significantly impacts story trajectory. Major events include: death, betrayal, major secrets revealed, critical evidence discovered, key relationship changes, significant story direction pivots.' },
    tag: { type: 'string', description: 'Category for organizing the note', enum: [...Object.keys(factTypes)] },
    targetPhase: { type: 'string', description: 'When this note should become relevant', enum: [...Object.keys(storyPhases)] },
    targetPageRange: { type: 'string', description: 'When this note should become relevant (optional): "<min>-<max>"' },
  } satisfies Record<keyof FutureNoteGeneration, AIJsonProperty>,
  required: ['note'] satisfies (keyof FutureNoteGeneration)[],
  additionalProperties: false
};

export const PLOT_FLAGS_SCHEMA: AIJsonProperty = {
  type: 'array',
  description: 'Significant facts that become established canon — future pages must remember (0-2 per page).',
  items: {
    type: 'object',
    properties: {
      fact: { type: 'string' },
      type: { type: 'string', enum: [...plotFlagTypes] satisfies PlotFlagType[] },
      isMajorEvent: { type: 'boolean' },
    } satisfies Record<keyof InitialPlotFlag, AIJsonProperty>,
    required: ['fact', 'type'] satisfies (keyof InitialPlotFlag)[],
    additionalProperties: false
  }
};

export const UPDATE_PLACE_SCHEMA: AIJsonProperty = {
  ...INITIAL_PLACE_SCHEMA,
  properties: {
    ...placeProperties,
    addKeyEvents: placeEvents,
    keyObjects: {
      type: 'array',
      description: 'Important story related objects (e.g., wooden chair, cupboard, large mirror, etc). Empty array if no changes.',
      items: {
        ...PLACE_KEY_OBJECT_SCHEMA,
        properties: {
          ...PLACE_KEY_OBJECT_SCHEMA.properties,
          amount: { type: 'integer', description: 'Set amount to 0 to remove object.' },
        }
      }
    },
    visitCount: { type: 'integer', description: 'Number of times the place has been visited. One for first visit.' },
    lastVisitedAtPage: { type: 'integer', description: 'The page number when the place was last visited. Current page for first visit.' },
  } satisfies Record<keyof PlaceUpdate, AIJsonProperty>,
  // required: [...INITIAL_PLACE_KEYS, 'addKeyEvents', 'visitCount', 'lastVisitedAtPage'] satisfies (keyof PlaceUpdate)[],
  // required: [...Object.keys(placeProperties), 'addKeyEvents', 'visitCount', 'lastVisitedAtPage'] satisfies (keyof PlaceUpdate)[],
  required: ['name', 'type', 'context', 'familiarity', 'addKeyEvents', 'visitCount', 'lastVisitedAtPage'] satisfies (keyof PlaceUpdate)[],
};

export const INITIAL_CHARACTER_SCHEMA: AIJsonProperty = {
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
    injuries: { type: 'array', items: INITIAL_INJURY_SCHEMA },
    pastInteractions: { type: 'array', items: { type: 'string' }, description: 'Interactions happened in this page' },
  } satisfies Record<keyof NewCharacter, AIJsonProperty>,
  required: ['name', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription', 'secrets'] satisfies (keyof NewCharacter)[],
  additionalProperties: false
};

export const RELATIONSHIP_UPDATE_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Relationship between side characters',
  properties: {
    source: { type: 'string', description: 'Character name initiating the relationship change. Only side characters. No need to describe feeling from MC (POV).' },
    target: { type: 'string', description: 'Target character name. Only side characters. Use `relationshipToMC` if targetting MC.' },
    type: { type: 'string', enum: [...relationshipTypes] },
    status: { type: 'string', enum: [...relationshipStatuses] },
  } satisfies Record<keyof RelationshipUpdate, AIJsonProperty>,
  required: ['source', 'target', 'status'] satisfies (keyof RelationshipUpdate)[],
  additionalProperties: false
};

function getTagUpdatesSchema<T extends TagItem>(params: {description?: string, items?: AIJsonProperty}): AIJsonProperty {
  const { description, items } = params;
  return {
    type: 'object',
    description,
    properties: {
      add:    { type: 'array', items: items ?? { type: 'string' } },
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
  weather: { type: 'string', enum: [...placeWeathers], description: 'Current weather conditions' },
  timeOfDay: { type: 'string', description: `Current time mark, e.g. time range, 'night', 'HH:mm', 'unknown'` },
  charactersPresent: { type: 'array', items: { type: 'string' }, description: 'Names of characters present in this page besides MC' },
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Key events that occurred in this page' },
  importantObjects: { type: 'array', items: { type: 'string' }, description: 'Important objects in this page' },
  actions: STORY_ACTION_SCHEMA
};

export const STORY_STATE_GENERATION_SCHEMA: Record<keyof StateDeltaGeneration, AIJsonProperty> = {
  traumaTagUpdates: getTagUpdatesSchema<string>({
    description: `Max ${MAX_TRAUMA_TAGS} items — representing haunting experiences that can be referenced by the story and affect MC's psychological profile.`
  }),
  futureNoteUpdates: getTagUpdatesSchema<FutureNote>({
    description: `Max ${MAX_FUTURE_NOTES} items — important notes for future AI turns representing narrative obligations towards the viableEnding (future incidents, characters, place, etc).`,
    items: FUTURE_NOTE_SCHEMA
  }),
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
      newPlaces: { type: 'array', items: INITIAL_PLACE_SCHEMA, description: 'New places visited if any.' },
      updatedPlaces: { type: 'array', items: UPDATE_PLACE_SCHEMA, description: 'Places which details have been updated if any.' },
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
        items: INITIAL_CHARACTER_SCHEMA
      },
      updatedCharacters: {
        type: 'array',
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
    items: RELATIONSHIP_UPDATE_SCHEMA,
  },

  threadUpdates: {
    type: 'object',
    description: 'Updates to narrative threads. Omit if no update.',
    properties: {
      newThreads: { type: 'array', description: 'New important core mysteries if any.', items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          question: { type: 'string' },
          priority: { type: 'string', enum: [...threadPriorities] },
          truth: { type: 'string', enum: [...threadTruths] },
          importance: { type: 'number' },
        } satisfies Record<keyof NewThread, AIJsonProperty>,
        required: ['title', 'question', 'priority', 'truth', 'importance'] satisfies (keyof NewThread)[],
        additionalProperties: false
      } },
      updateThreads: { type: 'array', description: 'Updates to existing threads if any.', items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: [...threadStatuses] },
          priority: { type: 'string', enum: [...threadPriorities] },
          truth: { type: 'string', enum: [...threadTruths] },
          importance: { type: 'number' },
          urgency: { type: 'number', description: 'Increase as thread approaches resolution' },
          resolution: { type: 'string' },
        } satisfies Record<keyof UpdateThread, AIJsonProperty>,
        required: ['title'] satisfies (keyof UpdateThread)[],
        additionalProperties: false
      } },
      addClues: { type: 'array', description: 'Clues to be added to existing threads if any.', items: {
        type: 'object',
        properties: {
          thread: { type: 'string' },
          clue: { type: 'string' },
          isFalse: { type: 'boolean' },
        } satisfies Record<keyof ThreadClue, AIJsonProperty>,
        required: ['thread', 'clue', 'isFalse'] satisfies (keyof ThreadClue)[],
        additionalProperties: false
      } },
      closeThreads: { type: 'array', description: 'Thread titles to be closed if any.', items: { type: 'string' } },
    } satisfies Record<keyof ThreadUpdates, AIJsonProperty>,
    // Note: no any required fields, but Cohere requires at least one field in `required` array
    required: ['newThreads'] satisfies (keyof ThreadUpdates)[],
    additionalProperties: false
  },

  flagUpdates: {
    type: 'array',
    description: 'Updates to psychological flags (trust, fear, guilt, curiosity) if any.',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...psychologicalFlagsTypes] },
        level: { type: 'string', enum: [...flagLevels] },
      } satisfies Record<keyof FlagUpdate, AIJsonProperty>,
      required: ['type', 'level'] satisfies (keyof FlagUpdate)[],
      additionalProperties: false
    },
  },

  addPlotFlags: PLOT_FLAGS_SCHEMA,

  // Optional objects, can omit or empty if no updates
  viableEnding: { type: 'object', description: 'Twisted ending plan for the story. Omit if no update.' },

  // Provide full to overwrite current. Can omit or empty if no changes.
  contextHistory: { type: 'string', description: `Summary of important story context from page 1 up to this point. Focus on key facts, relationships, and developments for story continuity. Max ${MAX_WORDS_SUMMARIZED_CONTEXT} words.` },
  inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA, description: `Items in MC's possession. Empty array if no changes.` },
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
  output: { type: 'string', description: "Concise review about the divergence (max 250 chars)" }
} satisfies Record<keyof CandidatePagesGeneration, AIJsonProperty>;

export const CANDIDATE_GENERATION_REQUIRED_FIELDS = ['generatedPages'] satisfies Array<keyof CandidatePagesGeneration>;

export function buildEvaluationSchemaDefinition<T extends Record<string, unknown>>(options: AIPromptOptions): Record<keyof AIJsonEvaluation<T>, AIJsonProperty> {
  const { outputJsonStructure, outputJsonRequired } = options;
  const scoringBreakdownSchema: AIJsonProperty = {
    type: "array",
    description: 'Detailed breakdown of scores by dimension',
    items: {
      type: 'object',
      properties: {
        dimension: { type: 'string' },
        score: { type: 'number' }
      } satisfies Record<keyof AIJsonScoreBreakdown, AIJsonProperty>,
      required: ["dimension", "score"] satisfies (keyof AIJsonScoreBreakdown)[],
      additionalProperties: false
    }
  };

  return {
    output: {
      type: 'object',
      properties: outputJsonStructure,
      required: outputJsonRequired,
      additionalProperties: outputJsonStructure ? false : undefined
    },
    scoreBefore: {
      type: 'object',
      description: 'Scoring evaluation of the original content before any corrections',
      properties: {
        total: { type: 'number', description: 'Total score across all dimensions (0-100)' },
        breakdown: scoringBreakdownSchema,
        passed: { type: 'boolean', description: 'Whether the content passed minimum quality thresholds' },
        issues: { type: 'array', description: 'List of identified issues with suggested improvements', items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', description: 'Which scoring dimension this issue affects' },
            issue: { type: 'string', description: 'Description of the specific problem identified' },
            suggestion: { type: 'string', description: 'Suggested fix or improvement approach' },
          } satisfies Record<keyof AIJsonEvaluationIssue, AIJsonProperty>,
          required: ['dimension', 'issue', 'suggestion'] satisfies (keyof AIJsonEvaluationIssue)[],
          additionalProperties: false
        } },
      } satisfies Record<keyof AIJsonScoreBefore, AIJsonProperty>,
      required: ['total', 'breakdown', 'passed', 'issues'] satisfies (keyof AIJsonScoreBefore)[],
      additionalProperties: false
    },
    scoreAfter: {
      type: 'object',
      description: 'Scoring evaluation of the content after corrections were applied',
      properties: {
        total: { type: 'number', description: 'Total score across all dimensions (0-100)' },
        breakdown: scoringBreakdownSchema,
        passed: { type: 'boolean', description: 'Whether the corrected content passed minimum quality thresholds' },
        fixes: { type: 'array', description: 'List of actual changes made during correction', items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', description: 'Which scoring dimension this fix affected' },
            change: { type: 'string', description: 'Description of the specific change made' },
          } satisfies Record<keyof AIJsonEvaluationFix, AIJsonProperty>,
          required: ['dimension', 'change'] satisfies (keyof AIJsonEvaluationFix)[],
          additionalProperties: false
        } },
      } satisfies Record<keyof AIJsonScoreAfter, AIJsonProperty>,
      required: ['total', 'breakdown', 'passed', 'fixes'] satisfies (keyof AIJsonScoreAfter)[],
      additionalProperties: false
    },
    actionFlags: {
      type: 'array',
      description: 'Quality flags for action choices (not scored, but flagged for issues)',
      items: {
        type: 'object',
        properties: {
          actionIndex: { type: 'number', description: 'Index of the action in the actions array (0-based)' },
          issue: { type: 'string', description: 'Description of the issue with this action choice' },
        } satisfies Record<keyof AIJsonActionFlag, AIJsonProperty>,
        required: ['actionIndex', 'issue'] satisfies (keyof AIJsonActionFlag)[],
        additionalProperties: false
      }
    },
    integrityFlags: {
      type: 'array',
      description: 'Integrity flags for JSON structure and data validation',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Which field or property has the integrity issue' },
          issue: { type: 'string', description: 'Description of the specific integrity problem' },
        } satisfies Record<keyof AIJsonIntegrityFlag, AIJsonProperty>,
        required: ['field', 'issue'] satisfies (keyof AIJsonIntegrityFlag)[],
        additionalProperties: false
      }
    },
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