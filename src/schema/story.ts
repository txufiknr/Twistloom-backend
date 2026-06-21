import { FACT_KEY_FORMAT, MAX_CHARACTER_SECRETS, MAX_FUTURE_NOTES, MAX_TRAUMA_TAGS, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT, RELATIONSHIP_TO_MC_LENGTH } from "../config/story.js";
import { characterRecognitionLevels, characterStatuses, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import type { NarrativeFlags, CharacterUpdates, RelationshipUpdate, InitialInventoryItem, InitialInjury, InventoryItem, Injury, NewCharacter, CharacterRelationshipContext, CharacterUpdate } from "../types/character.js";
import { type NewPlace, placeTypes, type PlaceUpdate, placeWeathers, type PlaceUpdates, type PlaceConnectionUpdate, placeAccessibilities } from "../types/places.js";
import { actionHintTypes, characterSceneRoles, factTypes, flagLevels, moods, plotFlagTypes, psychologicalFlagsTypes, sceneTypes, storyPhases } from "../types/story.js";
import type { AIJsonActionFlag, AIJsonEvaluation, AIJsonEvaluationFix, AIJsonEvaluationIssue, AIJsonIntegrityFlag, AIJsonProperty, AIJsonScoreAfter, AIJsonScoreBefore, AIJsonScoreBreakdown, AIPromptOptions } from "../types/ai-chat.js";
import type { ActionHint, Archetype, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, TagUpdates, ThreatProximity, TruthLevel, MemoryIntegrity, Difficulty, TrustLevel, FearLevel, GuiltLevel, CuriosityLevel, StoryPageGeneration, TagItem, FutureNote, FactUpdate, StateDeltaGeneration, ActionGeneration, FutureNoteGeneration, FlagUpdate, PlotFlagType, InitialPlotFlag, TraitItem, SceneCharacter } from "../types/story.js";
import { threadPriorities, threadStatuses, threadTruths, type UpdateThread, type NewThread, type ThreadUpdates, type AddThreadClue, type InitialThreadClue } from "../types/story-thread.js";
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
        text: { type: 'string', description: 'What will happen as a consequence. 1-2 sentence.' },
        type: { type: 'string', description: 'Type of the hint', enum: [...actionHintTypes] },
      } satisfies Record<keyof ActionHint, AIJsonProperty>,
      required: ['text', 'type'] satisfies (keyof ActionHint)[],
      additionalProperties: false
    },
  } satisfies Record<keyof ActionGeneration, AIJsonProperty>,
  required: ['text', 'type', 'hint'] satisfies (keyof ActionGeneration)[],
  additionalProperties: false
} };

export const INITIAL_INVENTORY_ITEM_PROPERTIES: Record<keyof InitialInventoryItem, AIJsonProperty> = {
  name: { type: 'string', description: 'Name of the inventory item' },
  traits: {
    type: 'array',
    description: 'Traits or properties of the item',
    items: buildTraitItemSchema({
      keyDescription: 'e.g., color, size, material, condition',
    })
  },
  amount: { type: 'integer', description: 'Quantity of the item' },
  where: { type: 'string', description: 'Where is it located now. 1-6 words (e.g., "left pocket").' },
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
  } satisfies Record<keyof Omit<InventoryItem, 'placeId'>, AIJsonProperty>,
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
  } satisfies Record<keyof Omit<Injury, 'placeId'>, AIJsonProperty>,
  required: [...INITIAL_INJURY_KEYS, 'pageAcquired'] satisfies (keyof Injury)[],
};

export const CHARACTER_NARRATIVE_FLAGS_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Future-facing plot planning and mechanical twists',
  properties: {
    potentialTwist: { type: 'string', enum: [...potentialTwistTypes] }
  } satisfies Record<keyof NarrativeFlags, AIJsonProperty>,
  required: ['potentialTwist'] satisfies (keyof NarrativeFlags)[],
  additionalProperties: false
};

export const PLACE_KEY_OBJECT_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    traits: {
      type: 'array',
      description: 'Any relevant details for the object',
      items: buildTraitItemSchema({
        keyDescription: 'e.g., color, size, material',
      })
    },
    amount: { type: 'integer' },
    where: { type: 'string', description: 'e.g., "in the corner of the room"' },
  } satisfies Record<keyof InitialInventoryItem, AIJsonProperty>,
  required: ['name'] satisfies (keyof InitialInventoryItem)[],
  additionalProperties: false
};

const placeTraitsExample = 'e.g., smell, sound, visual, feeling, dimension, wall color';

export function buildTraitItemSchema(params?: {
  keyDescription?: string,
  valueDescription?: string
  keyEnum?: string[],
  valueEnum?: string[]
}): AIJsonProperty {
  const { keyDescription, valueDescription, keyEnum, valueEnum } = params ?? {};
  return {
    type: 'object',
    properties: {
      key: { type: 'string', description: keyDescription, enum: keyEnum },
      value: { type: 'string', description: valueDescription, enum: valueEnum },
    } satisfies Record<keyof TraitItem, AIJsonProperty>,
    required: ['key', 'value'] satisfies (keyof TraitItem)[],
    additionalProperties: false
  };
}

export const INITIAL_PLACE_PROPERTIES: Record<keyof NewPlace, AIJsonProperty> = {
  placeId: { type: 'string', description: 'Lowercase slug identifier (e.g., "abandoned_hotel")' },
  parentPlaceId: { type: 'string', description: `If it's a sub-place (e.g., 'canteen' in a 'school')` },
  knownName: { type: 'string', description: `Place name as it appears in the narrative (preferred name)` },
  realName: { type: 'string', description: 'Original name unrevealed (e.g., institution name)' },
  type: { type: 'string', enum: [...placeTypes], description: 'Type of place for categorization and behavior patterns' },
  context: { type: 'string', description: 'Short human-readable description for immediate recall' },
  familiarity: { type: 'number', description: 'A measure of how familiar the character is with the place (0-1)' }, // 0-1, important for reuse priority
  isRealNameKnown: { type: 'boolean', description: `Whether the place's real name known to MC`},
  hints: { type: 'array', items: { type: 'string' }, description: 'Known clues, obstacles, spatial relationship to other places' },
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Meaningful events that occurred at this place' },
  keyObjects: {
    type: 'array',
    description: 'Objects associated to this place (e.g., wooden chair, large mirror)',
    items: PLACE_KEY_OBJECT_SCHEMA
  },
  knownCharacters: {
    type: 'array',
    description: 'Characters associated with this place if any',
    items: buildTraitItemSchema({
      keyDescription: 'character_id',
      valueDescription: 'Context to this place'
    })
  },
  traits: {
    type: 'array',
    description: 'Any relevant details for narrative consistency (key-value pairs)',
    items: buildTraitItemSchema({
      keyDescription: placeTraitsExample,
    })
  },
};

export const { keyEvents: placeEvents, familiarity: _f, realName: _n, ...placeUpdateProperties } = INITIAL_PLACE_PROPERTIES;

export const INITIAL_PLACE_KEYS: (keyof NewPlace)[] = ['placeId', 'knownName', 'realName', 'type', 'context', 'familiarity'];

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
    // all fields below are optional (can omit)
    isMajor: { type: 'boolean', description: 'Whether the note contains a major event that significantly impacts story trajectory. Major events include: death, betrayal, major secrets revealed, critical evidence discovered, key relationship changes, significant story direction pivots.' },
    tag: { type: 'string', description: 'Category for organizing the note', enum: [...Object.keys(factTypes)] },
    targetPhase: { type: 'string', description: 'When this note should become relevant (optional)', enum: [...Object.keys(storyPhases)] },
    targetPageRange: { type: 'string', description: 'When this note should become relevant (optional): "<min>-<max>"' },
    targetDate: { type: 'string', description: 'When this note should become relevant (optional): "<yyyy-MM-dd>"' },
    targetDay: { type: 'integer', description: 'When this note should become relevant (optional)' },
    relatedThreadId: { type: 'string', description: 'Related thread ID if any. Omit or "none" if none.' }
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

export const THREADS_SCHEMA: AIJsonProperty = { type: 'array', description: 'New important core mysteries if any.', items: {
  type: 'object',
  properties: {
    threadId: { type: 'string', description: 'Lowercase slug identifier (use "t_" prefix)' },
    title: { type: 'string' },
    question: { type: 'string' },
    priority: { type: 'string', enum: [...threadPriorities] },
    summary: { type: 'string' },
    truth: { type: 'string', enum: [...threadTruths] },
    importance: { type: 'number' },
    clues: {
      type: 'array',
      description: 'Initial clues if any',
      items: {
        type: 'object',
        properties: {
          clue: { type: 'string' },
          isFalse: { type: 'boolean', description: 'Whether the clue is true or misleading' },
        } satisfies Record<keyof InitialThreadClue, AIJsonProperty>,
        required: ['clue', 'isFalse'] satisfies (keyof InitialThreadClue)[],
        additionalProperties: false
      },
    },
  } satisfies Record<keyof NewThread, AIJsonProperty>,
  required: ['threadId', 'title', 'question', 'priority', 'truth', 'importance', 'clues'] satisfies (keyof NewThread)[],
  additionalProperties: false
} };

export const UPDATE_PLACE_SCHEMA: AIJsonProperty = {
  ...INITIAL_PLACE_SCHEMA,
  properties: {
    ...placeUpdateProperties,
    addKeyEvents: placeEvents,
    keyObjects: {
      type: 'array',
      description: 'Objects associated to this place (e.g., wooden chair, cupboard, large mirror). Empty array if no changes.',
      items: {
        ...PLACE_KEY_OBJECT_SCHEMA,
        properties: {
          ...PLACE_KEY_OBJECT_SCHEMA.properties,
          amount: { type: 'integer', description: 'Set amount to 0 to remove object.' },
        }
      }
    },
    updateTraits: {
      type: 'array',
      description: 'Update details about this place (key-value pairs)',
      items: buildTraitItemSchema({
        keyDescription: placeTraitsExample,
      })
    },
    removeTraits: { type: 'array', items: { type: 'string' } },
    familiarityCorrection: { type: 'number', description: 'Always 0 except on major condition. Use small conservative values (between -0.5 to 0.5).' },
    addHints: { type: 'array', items: { type: 'string' }, description: 'Known clues, obstacles, spatial relationship to other places' },
    removeHints: { type: 'array', items: { type: 'string' } },
  } satisfies Record<keyof PlaceUpdate, AIJsonProperty>,
  required: ['placeId', 'type', 'context', 'addKeyEvents'] satisfies (keyof PlaceUpdate)[],
};

export const INITIAL_CHARACTER_PROPERTIES: Record<keyof NewCharacter, AIJsonProperty> = {
  characterId: { type: 'string', description: 'Lowercase slug identifier (e.g., "Lisa Park" → "lisa_p")' },
  knownName: { type: 'string', description: `Preferred alias, known as, nick, or reference based on recognitionLevel. If really unknown, use descriptions, pronouns, roles, or words interpreted by MC.` },
  realName: { type: 'string', description: 'Real full name, even if undisclosed yet.' },
  recognitionLevel: { type: 'string', enum: [...characterRecognitionLevels], description: `How well does MC know this character.` },
  role: { type: 'string', description: 'Role or occupation known to the MC.' },
  gender: { type: "string", enum: [...genders] },
  status: { type: 'string', enum: [...characterStatuses] },
  relationshipToMC: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...relationshipTypes] },
      status: { type: 'string', enum: [...relationshipStatuses] },
      context: { type: 'string', description: `Specific dynamic, not generic (${RELATIONSHIP_TO_MC_LENGTH}).` },
      recognitionLevel: { type: 'string', enum: [...characterRecognitionLevels], description: 'How well does this character know MC.' },
    } satisfies Record<keyof CharacterRelationshipContext, AIJsonProperty>,
    required: ['type', 'status', 'context', 'recognitionLevel'] satisfies (keyof CharacterRelationshipContext)[],
    additionalProperties: false
  },
  bio: { type: 'string', description: "Brief character description. Include one trait that could become a source of threat or betrayal." },
  visualDescription: { type: 'string', description: "Character visual description (e.g., height, skin color, eye color, hair)." },
  secrets: { type: 'array', items: { type: 'string' }, description: `Any secrets the character has unknown to MC (max ${MAX_CHARACTER_SECRETS}).` },
  narrativeFlags: CHARACTER_NARRATIVE_FLAGS_SCHEMA,
  injuries: { type: 'array', items: INITIAL_INJURY_SCHEMA },
  pastInteractions: { type: 'array', items: { type: 'string' }, description: 'Interactions happened in this page' },
};

export const { realName: _cn, pastInteractions: _pi, ...updateCharacterProperties } = INITIAL_CHARACTER_PROPERTIES;

export const INITIAL_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_CHARACTER_PROPERTIES,
  required: ['characterId', 'knownName', 'realName', 'recognitionLevel', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription', 'injuries', 'secrets', 'narrativeFlags', 'pastInteractions'] satisfies (keyof NewCharacter)[],
  additionalProperties: false
};

export const UPDATE_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    ...updateCharacterProperties,
    newInteractions: { type: 'array', items: { type: 'string' }, description: 'New interactions happened in this page' },
  } satisfies Record<keyof CharacterUpdate, AIJsonProperty>,
  required: ['characterId', 'knownName', 'recognitionLevel', 'role', 'gender', 'status', 'relationshipToMC', 'bio', 'visualDescription', 'injuries', 'secrets', 'narrativeFlags', 'newInteractions'] satisfies (keyof CharacterUpdate)[],
  additionalProperties: false
};

export const RELATIONSHIP_UPDATE_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Relationship between side characters',
  properties: {
    sourceId: { type: 'string', description: "Character ID initiating the relationship change. Only side characters. No need to describe feeling from MC (POV)." },
    targetId: { type: 'string', description: "Target character ID. Only side characters. Use `relationshipToMC` if targetting MC." },
    type: { type: 'string', enum: [...relationshipTypes] },
    status: { type: 'string', enum: [...relationshipStatuses] },
    context: { type: 'string', description: 'Define relationship context' },
    recognitionLevel: { type: 'string', enum: [...characterRecognitionLevels], description: 'How well does source know target' },
  } satisfies Record<keyof RelationshipUpdate, AIJsonProperty>,
  required: ['sourceId', 'targetId', 'context'] satisfies (keyof RelationshipUpdate)[],
  additionalProperties: false
};

export const PLACE_CONNECTION_UPDATE_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Connection between places. Add on first connection; update only for significant route changes.',
  properties: {
    sourceId: { type: 'string', description: 'Place ID (from).' },
    targetId: { type: 'string', description: 'Target place ID (to).' },
    travelTime: { type: 'string', description: 'Narrative travel duration (e.g., "5 minutes walk", "20 minutes drive").' },
    routeType: { type: 'string', description: 'Main route used between places (e.g., "alley")' },
    accessibility: { type: 'string', enum: [...placeAccessibilities] },
    // obstacles: { type: 'string', description: 'Relevant barriers, hazards, or restrictions (e.g., "police checkpoint", "flooded alley")' },
    updateObstacles: getTagUpdatesSchema<string>({ description: 'Relevant barriers, hazards, or restrictions (e.g., "police checkpoint", "flooded alley")' }),
    bidirectional: { type: 'boolean', description: `false if we can't go back to source place` },
    notes: { type: 'string', description: 'Optional route-specific details.' },
  } satisfies Record<keyof PlaceConnectionUpdate, AIJsonProperty>,
  required: ['sourceId', 'targetId', 'travelTime'] satisfies (keyof PlaceConnectionUpdate)[],
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
  text: { type: 'string', description: `Main story page content (max ${MAX_WORDS_PER_PAGE} words). First-person central ("I") POV as MC.` },
  mood: { type: 'string', description: 'Current emotional atmosphere', enum: [...moods] },
  placeId: { type: 'string', description: 'Current place ID or "unknown"' },
  weather: { type: 'string', enum: [...placeWeathers], description: 'Current weather conditions' },
  calendarDate: { type: 'string', description: `Current in-world date in 'yyyy-MM-dd' format` },
  timeOfDay: { type: 'string', description: `Current time mark (e.g., 'night', 'HH:mm', '2 AM', 'unknown', time range)` },
  sceneType: { type: 'string', enum: [...Object.keys(sceneTypes)] },
  charactersPresent: {
    type: 'array',
    description: 'Characters physically present in this page (besides MC)',
    items: {
      type: 'object',
      properties: {
        characterId: { type: 'string' },
        sceneRole: { type: 'string', enum: [...characterSceneRoles] },
        sceneFocus: { type: 'number', description: 'Relative narrative importance in current scene (0-1).' },
      } satisfies Record<keyof SceneCharacter, AIJsonProperty>,
      required: ['characterId', 'sceneRole', 'sceneFocus'] satisfies (keyof SceneCharacter)[],
      additionalProperties: false
    },
  },
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Key events that occurred in this page' },
  importantObjects: { type: 'array', items: { type: 'string' }, description: 'Important objects in this page' },
  actions: STORY_ACTION_SCHEMA
};

export const STORY_STATE_GENERATION_SCHEMA: Record<keyof StateDeltaGeneration, AIJsonProperty> = {
  traumaTagUpdates: getTagUpdatesSchema<string>({
    description: `Max ${MAX_TRAUMA_TAGS}. Haunting experiences referenced by story (and affect MC's psychological profile).`
  }),
  futureNoteUpdates: getTagUpdatesSchema<FutureNote>({
    description: `Max ${MAX_FUTURE_NOTES}. Narrative obligations towards viableEnding (plans, foreshadowing, future reveals, scenes, twists, etc).`,
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
      newCharacters: { type: 'array', items: INITIAL_CHARACTER_SCHEMA, description: 'New characters introduced if any.' },
      updatedCharacters: { type: 'array', items: UPDATE_CHARACTER_SCHEMA, description: 'Characters whose details have been updated if any.' },
    } satisfies Record<keyof CharacterUpdates, AIJsonProperty>,
    required: ['newCharacters', 'updatedCharacters'] satisfies (keyof CharacterUpdates)[],
    additionalProperties: false
  },

  relationshipUpdates: { type: 'array', items: RELATIONSHIP_UPDATE_SCHEMA, description: 'Updates to relationships between side characters if any.' },
  placeConnectionUpdates: { type: 'array', items: RELATIONSHIP_UPDATE_SCHEMA, description: 'Updates to connections between places if any.' },

  threadUpdates: {
    type: 'object',
    description: 'Updates to narrative threads. Omit if no update.',
    properties: {
      newThreads: THREADS_SCHEMA,
      updateThreads: { type: 'array', description: 'Updates to existing threads if any.', items: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Existing thread ID' },
          status: { type: 'string', enum: [...threadStatuses] },
          priority: { type: 'string', enum: [...threadPriorities] },
          truth: { type: 'string', enum: [...threadTruths] },
          importance: { type: 'number' },
          urgencyCorrection: { type: 'number', description: 'Only for exceptional shifts in narrative momentum (between -0.5 to 0.5). Not for normal development.' },
          summary: { type: 'string' },
          resolution: { type: 'string' },
        } satisfies Record<keyof UpdateThread, AIJsonProperty>,
        required: ['threadId'] satisfies (keyof UpdateThread)[],
        additionalProperties: false
      } },
      addClues: { type: 'array', description: 'Clues to be added to existing threads if any.', items: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Existing thread ID' },
          clue: { type: 'string' },
          isFalse: { type: 'boolean', description: 'Whether the clue is true or misleading' },
        } satisfies Record<keyof AddThreadClue, AIJsonProperty>,
        required: ['threadId', 'clue', 'isFalse'] satisfies (keyof AddThreadClue)[],
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
  // TODO: need schema?
  viableEnding: { type: 'object', description: 'Twisted ending plan for the story. Omit if no update.' },

  // Provide full to overwrite current. Can omit or empty if no changes.
  contextHistory: { type: 'string', description: `Story summary from page 1 up to this point. Focus on key facts and developments for continuity. Max ${MAX_WORDS_SUMMARIZED_CONTEXT} words.` },
  inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA, description: `Items in MC's possession. Omit or empty if no changes.` },
  injuries: {
    type: 'array',
    items: INJURY_SCHEMA,
    description: 'All injuries sustained on this page. Omit or empty if no changes. Note: Injuries severity are automatically decaying.'
  },
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

export const STORY_GENERATION_REQUIRED_FIELDS = ['text', 'actions', 'calendarDate'] satisfies Array<keyof StoryGeneration>;

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