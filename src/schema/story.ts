import { FACT_KEY_FORMAT, HOOK_LENGTH, SUMMARY_LENGTH, MAX_CHARACTER_SECRETS, MAX_FUTURE_NOTES, MAX_TRAUMA_TAGS, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT, RELATIONSHIP_TO_MC_LENGTH, BOOK_MAX_PAGES, BOOK_MIN_PAGES, BOOK_TITLE_LENGTH, MAX_CHARACTER_AGE, MIN_CHARACTER_AGE, VIABLE_ENDING_LENGTH, KEYWORDS_COUNT } from "../config/story.js";
import { characterImportances, characterRecognitionLevels, characterStatuses, healthConditions, injuryCategories, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import type { RelationshipUpdate, InitialInventoryItem, InitialInjury, InventoryItem, Injury, NewCharacter, CharacterRelationshipContext, CharacterUpdate, CharacterSchedule, StoryMCGeneration } from "../types/character.js";
import { canonicalPlaceTypes, type NewPlace, type PlaceUpdate, placeWeathers, type PlaceConnectionUpdate, placeAccessibilities } from "../types/places.js";
import { actionHintTypes, actionTypes, characterSceneRoles, factTypes, flagLevels, moods, plotFlagTypes, psychologicalFlagsTypes, sceneTypes, difficulties, endingTypes, storyMomentums, stabilityLevels, storyPhaseKeys, futureNoteTriggerTypes, memoryIntegrities } from "../types/story.js";
import type { AIJsonActionFlag, AIJsonEvaluation, AIJsonEvaluationFix, AIJsonEvaluationIssue, AIJsonIntegrityFlag, AIJsonProperty, AIJsonScoreAfter, AIJsonScoreBefore, AIJsonScoreBreakdown, AIPromptOptions } from "../types/ai-chat.js";
import type { ActionHint, Archetype, HiddenState, ManipulationAffinity, PsychologicalProfile, RealityStability, StabilityLevel, StoryGeneration, StoryState, ThreatProximity, TruthLevel, MemoryIntegrity, Difficulty, TrustLevel, FearLevel, GuiltLevel, CuriosityLevel, StoryPageGeneration, FactUpdate, StateDeltaGeneration, StateDeltaGenerationWithBranch, ActionGeneration, FutureNoteGeneration, FlagUpdate, PlotFlagType, InitialPlotFlag, SceneCharacter, SanityState } from "../types/story.js";
import { threadPriorities, threadStatuses, threadTruths, type UpdateThread, type NewThread, type AddThreadClue, type InitialThreadClue } from "../types/story-thread.js";
import type { CandidatePagesGeneration } from "../types/candidate-generation.js";
import { genders } from "../types/user.js";
import type { BookCreationResponse, BookTranslation, BookTranslationBulk, BookTranslationWithID, PageTranslation, PageTranslationBulk, PageTranslationWithID } from "../types/book.js";
import type { CharacterMemoryTranslation, CharacterPlan, InjuryTranslation, InventoryItemTranslation, StoryMCTranslation } from "../types/character.js";
import type { ActionTranslation, PsychologicalFlags, InitialStoryState, StoryOutline, InitialFact, InitialEnding, Ending, InitialStoryPageGeneration } from "../types/story.js";
import type { AIDetectedItem, AIDetectedItemType, AIValidationResult, ThemeValidationCategory } from "../types/theme-validation.js";
import type { KnownGender } from "../types/user.js";
import type { PlaceMemoryTranslation } from "../types/places.js";
import type { StoryThreadTranslation, ThreadClueTranslation } from "../types/story-thread.js";
import { MAX_FINAL_COMMENT_LENGTH } from "../config/book-creation.js";

export const STORY_ACTION_SCHEMA: AIJsonProperty = { type: 'array', items: {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text of the action as presented to the player' },
    type: { type: 'string', description: 'Type of the action', enum: Object.keys(actionTypes) },
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
  bodyPart:      { type: 'string', description: 'Body part affected' },
  description:   { type: 'string', description: 'Injury description' },
  consequences:  { type: 'string', description: 'Functional consequences that can affect the storyline' },
  category:      { type: 'string', description: 'Broad injury classification', enum: [...injuryCategories] },
  severity:      { type: 'number', description: 'Severity level (0-1)' },
  decayPerPage:  { type: 'number', description: 'Severity reduction applied per page' },
};

export const INITIAL_INJURY_KEYS: (keyof InitialInjury)[] = ['bodyPart', 'description', 'category', 'severity', 'decayPerPage'];
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

// TODO: remove params
export function buildTraitItemSchema(_params?: {
  keyDescription?: string,
  valueDescription?: string
  keyEnum?: string[],
  valueEnum?: string[]
}): AIJsonProperty {
  // TraitItem flattened from {key, value} object to "key: value" string to reduce
  // schema depth for Gemini constrained-decoder compatibility. The params are kept
  // for call-site documentation but ignored — the AI just outputs a string[].
  return { type: 'string', description: 'Key-value pair formatted as "key: value"' };
}

export const INITIAL_PLACE_PROPERTIES: Record<keyof NewPlace, AIJsonProperty> = {
  placeId: { type: 'string', description: 'Lowercase slug identifier (e.g., "abandoned_hotel")' },
  parentPlaceId: { type: 'string', description: `If it's a sub-place (e.g., 'canteen' in a 'school')` },
  knownName: { type: 'string', description: `Place name as it appears in the narrative (preferred name). Should fit the in-world cultural setting.` },
  realName: { type: 'string', description: 'Original name unrevealed (e.g., institution name)' },
  type: { type: 'string', description: 'Type of place for categorization and behavior patterns (e.g., "building", "forest")' },
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
      valueDescription: 'Context or role in the place'
    })
  },
  traits: {
    type: 'array',
    description: 'Any relevant details for narrative consistency (key-value pairs)',
    items: buildTraitItemSchema({
      keyDescription: placeTraitsExample,
    })
  },
  category: { type: 'string', enum: [...canonicalPlaceTypes], description: 'Canonical place type for BGM mapping' },
};

const { keyEvents: placeEvents, familiarity: _f, realName: _n, ...placeUpdateProperties } = INITIAL_PLACE_PROPERTIES;

export const INITIAL_PLACE_KEYS: (keyof NewPlace)[] = ['placeId', 'knownName', 'realName', 'type', 'context', 'familiarity'];

export const INITIAL_PLACE_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_PLACE_PROPERTIES,
  required: INITIAL_PLACE_KEYS,
  additionalProperties: false
};

/**
 * JSON schema for a single `FutureNoteSchedule` item within `FutureNote.schedule[]`.
 *
 * `schedule` is an array — each item is one independent time-based trigger.
 * The note becomes relevant once ANY item fires (OR logic). Include multiple
 * items to express "whichever of these beats arrives first".
 *
 * Uses a flat single-object schema (universally compatible across all AI providers)
 * rather than `oneOf`. The `type` discriminant field is required and enumerated;
 * all variant-specific fields are declared as optional properties with descriptions
 * that specify when each is expected.
 *
 * The AI picks a `type`, then fills only that variant's fields and omits the rest:
 *
 * ┌───────┬──────────────────────────────────────────────────────────────────┐
 * │ type  │ fill these fields                                                │
 * ├───────┼──────────────────────────────────────────────────────────────────┤
 * │ phase │ phase: EARLY | MID | LATE | FINALE                              │
 * │ page  │ range: <min>-<max>                                              │
 * │ day   │ day: exact in-story day integer (1-based)                       │
 * │ date  │ date: ISO calendar date "YYYY-MM-DD"                            │
 * └───────┴──────────────────────────────────────────────────────────────────┘
 *
 * Lookahead semantics:
 * - phase → fires once currentPhase reaches or passes the target phase
 * - page  → fires FUTURE_NOTE_LOOKAHEAD_PAGES pages before `start`
 * - day   → fires FUTURE_NOTE_LOOKAHEAD_DAYS in-story days before `day`
 * - date  → fires FUTURE_NOTE_LOOKAHEAD_DAYS calendar days before `date`
 */
export const FUTURE_NOTE_SCHEDULE_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'One time-based trigger item within the schedule array.',
  properties: {
    type: { type: 'string', enum: ['phase', 'page', 'day', 'date'], description: 'Discriminant. Determines which other fields to populate.' },
    phase: { type: 'string', enum: storyPhaseKeys, description: 'For "phase" type. Fires once currentPhase reaches or passes this value.' },
    range: { type: 'string', description: 'For "page" type. <min>-<max>.' },
    day: { type: 'number', description: 'For "day" type. Exact in-story day number (1-based integer).' },
    date: { type: 'string', description: 'For "date" type. "YYYY-MM-DD".' },
  },
  required: ['type'],
  additionalProperties: false,
};

/**
 * JSON schema for `FutureNoteStateTrigger` — the MC-state-based activation
 * condition on a future note.
 *
 * Uses a flat single-object schema for universal provider compatibility.
 * The `type` discriminant is required and enumerated; variant-specific
 * fields are optional with descriptions specifying when each applies.
 *
 * The AI picks a `type`, then fills only that variant's fields and omits the rest:
 *
 * ┌────────────────┬──────────────────────────────────────────────────────────┐
 * │ type           │ fill these fields                                        │
 * ├────────────────┼──────────────────────────────────────────────────────────┤
 * │ stability      │ level: stable | cracking | unstable                      │
 * │ condition      │ condition: healthy | injured | critical | incapacitated   │
 * │ healthPercent  │ threshold: integer 0–100 (fires when stat <= threshold)  │
 * │ mobilityPercent│ threshold: integer 0–100 (fires when stat <= threshold)  │
 * │ actionPercent  │ threshold: integer 0–100 (fires when stat <= threshold)  │
 * │ mentalPercent  │ threshold: integer 0–100 (fires when stat <= threshold)  │
 * └────────────────┴──────────────────────────────────────────────────────────┘
 *
 * Stat variants always use `<=` semantics — this story's future notes are
 * exclusively about deterioration. No operator field is needed.
 *
 * Authoring guidance: use `stateTrigger` only when the note genuinely depends
 * on the MC reaching a specific deteriorated state. Never manufacture the
 * triggering state just to resolve the note early.
 *
 * Omit the entire `stateTrigger` field for notes with no state-based activation.
 */
export const FUTURE_NOTE_STATE_TRIGGER_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'State-based activation for this note (optional).',
  properties: {
    type: { type: 'string', enum: [...futureNoteTriggerTypes], description: 'Discriminant. Determines which other field to populate.' },
    level: { type: 'string', enum: [...Object.keys(stabilityLevels)], description: 'For "stability" type. Fires when MC psychological stability matches this level exactly.' },
    condition: { type: 'string', enum: [...healthConditions], description: 'For "condition" type. Fires when MC overall health condition matches this value exactly.' },
    threshold: { type: 'number', description: 'For *Percent types. Integer 0-100. Fires when stat ≤ threshold.' },
  },
  required: ['type'],
  additionalProperties: false,
};

/**
 * JSON schema for `FutureNoteGeneration` — the shape the AI outputs when
 * adding or updating future notes.
 *
 * Key design principles:
 * - `schedule` and `stateTrigger` are both optional. Use `schedule` for time-anchored
 *   beats, `stateTrigger` for state-threshold beats, both when either should activate
 *   the note (OR semantics), and neither for open-ended obligations.
 * - `key` and `addedAtPage` are server-assigned — never generated by the AI.
 * - `note` is the only required field; all others may be omitted.
 */
export const FUTURE_NOTE_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'Narrative description of what should happen later in the story.' },
    // All fields below are optional — the AI may omit any of them.
    isMajor: { type: 'boolean', description: 'True when the note represents a major, irreversible story event: death, betrayal, critical secret revealed, decisive relationship pivot, or structural narrative turn. Major notes surface first within the same time slot.' },
    tag: { type: 'string', enum: [...Object.keys(factTypes)], description: 'Categorisation tag for grouping related notes. Helps organise notes by domain.' },
    schedule: { type: 'array', description: 'OR-logic time-based anchors (optional). The note becomes relevant once ANY entry fires its lookahead window.', items: FUTURE_NOTE_SCHEDULE_SCHEMA },
    stateTrigger: { type: 'array', description: 'OR-logic state-based anchors (optional). The note becomes relevant once ANY entry falls below threshold.', items: FUTURE_NOTE_STATE_TRIGGER_SCHEMA },
    relatedThreadId: { type: 'string', description: 'ID of a related active story thread. Omit or use "none" if unrelated to any thread.' },
  } satisfies Record<keyof FutureNoteGeneration, AIJsonProperty>,
  required: ['note'] satisfies (keyof FutureNoteGeneration)[],
  additionalProperties: false,
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
  // PlaceUpdate is Partial — only placeId is required; omit unaltered fields
  required: ['placeId'] satisfies (keyof PlaceUpdate)[],
};

export const CHARACTER_PLAN_PROPERTIES: Record<keyof CharacterPlan, AIJsonProperty> = {
  characterId: { type: 'string', description: 'Lowercase slug identifier (e.g., "Lisa Park" → "lisa_p")' },
  knownName: { type: 'string', description: `Preferred alias, known as, nick, or reference based on recognitionLevel. If really unknown, use descriptions, pronouns, roles, or words interpreted by MC.` },
  realName: { type: 'string', description: 'Real full name, even if undisclosed yet.' },
  role: { type: 'string', description: 'Role or occupation known to the MC (e.g. "schoolmate", "librarian").' },
  gender: { type: 'string', enum: [...genders] },
  bio: { type: 'string', description: "Brief character description in detected language. Include one trait that could become a source of threat or betrayal." },
  appearance: { type: 'string', description: "Visual appearance (e.g., height, skin color, eye color, hair)." },
  storyPurpose: { type: 'string', description: 'Explain why this character exists in the story' },
  plannedIntro: { type: 'string', description: 'Explain how this character planned to be introduced' },
  importance: { type: 'string', enum: [...characterImportances] },
};

export const CHARACTER_PLAN_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: CHARACTER_PLAN_PROPERTIES,
  required: ['characterId', 'knownName', 'realName', 'gender', 'role', 'bio', 'appearance', 'importance'] satisfies (keyof CharacterPlan)[],
  additionalProperties: false,
};

const { storyPurpose: _sp, plannedIntro: _pli, ...initialCharacterProperties} = CHARACTER_PLAN_PROPERTIES;

export const CHARACTER_SCHEDULE_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    placeId: { type: 'string', description: 'Place ID they are usually found at during their window.' },
    availabilityWindow: { type: 'string', description: 'When in the day this character is typically present (e.g., time range, "night", "day", "24h", "random").' },
    missedConsequence: { type: 'string', description: 'What happens if MC misses them (e.g., "Can\'t buy tickets").' },
  } satisfies Record<keyof CharacterSchedule, AIJsonProperty>,
  required: ['placeId', 'availabilityWindow'] satisfies (keyof CharacterSchedule)[],
  additionalProperties: false
};

export const INITIAL_CHARACTER_PROPERTIES: Record<keyof NewCharacter, AIJsonProperty> = {
  ...initialCharacterProperties,
  recognitionLevel: { type: 'string', enum: [...characterRecognitionLevels], description: `How well does MC know this character.` },
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
  secrets: { type: 'array', items: { type: 'string' }, description: `Any secrets the character has unknown to MC (max ${MAX_CHARACTER_SECRETS}).` },
  potentialTwist: { type: 'string', enum: [...potentialTwistTypes], description: 'Future-facing plot planning and mechanical twists' },
  injuries: { type: 'array', items: INITIAL_INJURY_SCHEMA },
  schedules: { type: 'array', description: 'When/where this character can be found. Multiple entries for different availability windows per place.', items: CHARACTER_SCHEDULE_SCHEMA },
  pastInteractions: { type: 'array', items: { type: 'string' }, description: 'Interactions happened in this page' },
  traits: {
    type: 'array',
    description: 'Only story-relevant (e.g., skills, hobbies).',
    items: buildTraitItemSchema({
      keyDescription: placeTraitsExample,
    })
  },
};

const { realName: _cn, pastInteractions: _pin, schedules: _schedules, ...updateCharacterProperties } = INITIAL_CHARACTER_PROPERTIES;

export const INITIAL_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: INITIAL_CHARACTER_PROPERTIES,
  required: ['characterId', 'knownName', 'realName', 'recognitionLevel', 'role', 'gender', 'status', 'importance', 'relationshipToMC', 'bio', 'appearance', 'injuries', 'secrets', 'potentialTwist'] satisfies (keyof NewCharacter)[],
  additionalProperties: false
};

export const UPDATE_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  properties: {
    ...updateCharacterProperties,
    newInteractions: { type: 'array', items: { type: 'string' }, description: 'New interactions happened in this page' },
    updateTraits: {
      type: 'array',
      description: 'Update details about this place (key-value pairs)',
      items: buildTraitItemSchema({
        keyDescription: placeTraitsExample,
      })
    },
    removeTraits: { type: 'array', items: { type: 'string' } },
    updateSchedules: { type: 'array', items: CHARACTER_SCHEDULE_SCHEMA },
    removeSchedules: { type: 'array', items: { type: 'string', description: 'Place ID of the schedule to remove' } },
  } satisfies Record<keyof CharacterUpdate, AIJsonProperty>,
  // CharacterUpdate is Partial — only characterId is required; omit unaltered fields
  required: ['characterId'] satisfies (keyof CharacterUpdate)[],
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
  required: ['sourceId', 'targetId', 'context', 'recognitionLevel'] satisfies (keyof RelationshipUpdate)[],
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
    addObstacles: { type: 'array', items: { type: 'string' }, description: 'Relevant barriers, hazards, or restrictions to add (e.g., "police checkpoint", "flooded alley")' },
    removeObstacles: { type: 'array', items: { type: 'string' }, description: 'Obstacle keys to remove' },
    bidirectional: { type: 'boolean', description: `false if we can't go back to source place` },
    notes: { type: 'string', description: 'Optional route-specific details.' },
  } satisfies Record<keyof PlaceConnectionUpdate, AIJsonProperty>,
  required: ['sourceId', 'targetId', 'travelTime'] satisfies (keyof PlaceConnectionUpdate)[],
  additionalProperties: false
};

export const STORY_PAGE_GENERATION_SCHEMA: Record<keyof StoryPageGeneration, AIJsonProperty> = {
  text: { type: 'string', description: `Story page text written in specified language (max ${MAX_WORDS_PER_PAGE} words). First-person central ("I") POV as MC.` },
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
  keyEvents: { type: 'array', items: { type: 'string' }, description: 'Key events that occurred in this page in detected language' },
  keyObjects: { type: 'array', items: { type: 'string' }, description: 'Important objects in this page in detected language' },
  actions: STORY_ACTION_SCHEMA
};

export const INITIAL_VIABLE_ENDING_PROPERTIES: Record<keyof InitialEnding, AIJsonProperty> = {
  text: { type: 'string', description: `Write the story ending plan in ${VIABLE_ENDING_LENGTH}. Be specific to MC and theme.` },
  type: { type: 'string', enum: Object.keys(endingTypes) as EndingType[] },
  outline: {
    type: 'array',
    description: 'A roadmap to reach the ending. 1-2 sentence per item.',
    items: { type: 'string' }
  }
};

export const INITIAL_VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'A viable doom ending plan based on current story trajectory and theme.',
  properties: INITIAL_VIABLE_ENDING_PROPERTIES,
  required: ['text', 'type'] satisfies (keyof InitialEnding)[],
  additionalProperties: false
};

export const VIABLE_ENDING_SCHEMA: AIJsonProperty = {
  ...INITIAL_VIABLE_ENDING_SCHEMA,
  properties: {
    ...INITIAL_VIABLE_ENDING_PROPERTIES,
    outline: {
      type: 'array',
      description: 'A roadmap to reach the ending. 1-2 sentence per item. Align done count with current phase.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          isDone: { type: 'boolean' },
          doneAtPage: { type: 'integer', description: 'Omit or zero if not yet done.' },
        },
        required: ['text', 'isDone'] satisfies (keyof StoryOutline)[],
        additionalProperties: false
      }
    },
    changeReason: { type: 'string', description: 'Terse 1-2 sentence note about ending plan shift or changes.' },
    changeViabilityBefore: { type: 'number', description: 'Previous viability score before this change (0-1, lower)' },
    changeViabilityAfter: { type: 'number', description: 'New viability score after this change (0-1, higher)' }
  } satisfies Record<keyof Ending, AIJsonProperty>
}

export const STORY_STATE_GENERATION_SCHEMA: Record<keyof StateDeltaGeneration, AIJsonProperty> = {
  // CHARACTERS
  newCharacters: { type: 'array', items: INITIAL_CHARACTER_SCHEMA, description: 'New characters introduced if any. Empty array if none.' },
  updatedCharacters: { type: 'array', items: UPDATE_CHARACTER_SCHEMA, description: 'Characters whose details have been updated if any. Empty array if none.' },
  addPlannedCharacters: {
    type: 'array',
    description: 'New planned character candidates for future introduction (only when slots available and phase is EARLY/MID).',
    items: CHARACTER_PLAN_SCHEMA,
  },
  relationshipUpdates: { type: 'array', items: RELATIONSHIP_UPDATE_SCHEMA, description: 'Updates to relationships between side characters if any.' },

  // PLACES
  newPlaces: { type: 'array', items: INITIAL_PLACE_SCHEMA, description: 'New places visited if any.' },
  updatedPlaces: { type: 'array', items: UPDATE_PLACE_SCHEMA, description: 'Places which details have been updated if any.' },
  placeConnections: { type: 'array', items: PLACE_CONNECTION_UPDATE_SCHEMA, description: 'Updates to connections between places if any.' },

  // STORY
  contextHistory: { type: 'string', description: `Story summary from page 1 up to this point. Focus on key facts and developments for continuity. Max ${MAX_WORDS_SUMMARIZED_CONTEXT} words.` },
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
  futureNoteAdd: {
    type: 'array',
    description: `Future notes to add. Max ${MAX_FUTURE_NOTES}. Narrative obligations towards viableEnding (plans, foreshadowing, future reveals, scenes, twists, etc).`,
    items: FUTURE_NOTE_SCHEMA
  },
  futureNoteRemove: {
    type: 'array',
    items: { type: 'string' },
    description: 'Future note keys to remove.'
  },
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
      required: ['key', 'value'] satisfies (keyof FactUpdate)[],
      additionalProperties: false
    }
  },

  // PSYCHOLOGY
  traumaTagAdd: {
    type: 'array',
    items: { type: 'string' },
    description: `Trauma tags to add. Max ${MAX_TRAUMA_TAGS}. Haunting experiences referenced by story.`
  },
  traumaTagRemove: {
    type: 'array',
    items: { type: 'string' },
    description: 'Trauma tag keys to remove.'
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

  // PLOT
  addPlotFlags: PLOT_FLAGS_SCHEMA,
  viableEnding: VIABLE_ENDING_SCHEMA,
  minutesPassed: { type: 'number', description: 'Realistic minutes elapsed during this page. Omit if uncertain — system will estimate from scene type.' },

  // POV STATE
  inventory: { type: 'array', items: INVENTORY_ITEM_SCHEMA, description: `Items in MC's possession. Omit or empty if no changes.` },
  injuries: {
    type: 'array',
    items: INJURY_SCHEMA,
    description: 'All injuries sustained on this page. Omit or empty if no changes. Note: Injuries severity are automatically decaying.'
  },
}

// ============================================================================
// MULTI-TURN (STAGE-SPLIT) SCHEMA EXPORTS
// ============================================================================
// See MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 2.1. Additive, non-breaking:
// these two definitions are the SAME objects STORY_GENERATION_SCHEMA_DEFINITION
// below composes from (not copies), so Turn A / Turn B can never drift from
// the merge-validation target the way the old duplicated-JSON-shape bug
// class did (see prompt.ts's NEW_CHARACTER_SHAPE-style constants for the
// prior fix of that same class of bug). When USE_MULTI_TURN_GENERATION is on,
// each turn sends only its own definition — a provably smaller/shallower
// schema than STORY_GENERATION_SCHEMA_DEFINITION — to the AI's constrained
// decoder, directly addressing isSchemaTooComplex (ai-chat.ts) depth/prop
// thresholds and per-provider prompt-length caps (AI_MAX_PROMPT_LENGTH).

/** Turn A (StoryPage) schema — sent to the AI instead of STORY_GENERATION_SCHEMA_DEFINITION when USE_MULTI_TURN_GENERATION is on. Identical fields to STORY_PAGE_GENERATION_SCHEMA above; exported under the turn-oriented name for call sites in prompt.ts's stage runner. */
export const STORY_PAGE_SCHEMA_DEFINITION: Record<keyof StoryPageGeneration, AIJsonProperty> = STORY_PAGE_GENERATION_SCHEMA;
export const STORY_PAGE_REQUIRED_FIELDS = ['text', 'actions', 'calendarDate'] satisfies (keyof StoryPageGeneration)[];

/** Turn B (StateDelta) schema, WITHOUT branchNames — sent to the AI instead of STORY_GENERATION_SCHEMA_DEFINITION when USE_MULTI_TURN_GENERATION is on. No required fields: every delta field is optional (a page with zero state changes — e.g. a purely reflective beat — is a valid StateDelta). Prefer STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION below at actual call sites; this bare form exists for callers that place branchNames elsewhere (see Part 5 decision log). */
export const STATE_DELTA_SCHEMA_DEFINITION: Record<keyof StateDeltaGeneration, AIJsonProperty> = STORY_STATE_GENERATION_SCHEMA;
export const STATE_DELTA_REQUIRED_FIELDS: (keyof StateDeltaGeneration)[] = [];

/**
 * Turn B schema + `branchNames` (see {@link StateDeltaGenerationWithBranch}
 * in types/story.ts). This — not the bare STATE_DELTA_SCHEMA_DEFINITION
 * above — is what prompt.ts's state-delta stage actually sends: branchNames
 * moved to Turn B because the alternative-timeline names describe the whole
 * divergence, which is only knowable once the delta (the actual consequence)
 * is authored (roadmap §2.1 decision).
 *
 * Serves BOTH generateNextPage's single delta turn and generateNextPages'
 * per-alternative delta turns — in the parallel multi-turn design each
 * alternative's delta is its own independent request (Part 2.5), not an
 * array element inside one combined batch response, so no separate
 * array-wrapped "candidate" schema is needed the way
 * CANDIDATE_GENERATION_SCHEMA_DEFINITION wraps the legacy single-shot path.
 */
export const STATE_DELTA_WITH_BRANCH_SCHEMA_DEFINITION = {
  ...STATE_DELTA_SCHEMA_DEFINITION,
  branchNames: {
    type: 'array',
    items: { type: 'string' },
    description: 'Suggest 3 creative, distinct names for this timeline. Evocative, spoiler-free.',
  },
} satisfies Record<keyof StateDeltaGenerationWithBranch, AIJsonProperty>;
export const STATE_DELTA_WITH_BRANCH_REQUIRED_FIELDS: (keyof StateDeltaGenerationWithBranch)[] = [];

/**
 * Common schema definition for StoryGeneration type
 * 
 * This is the single source of truth for StoryGeneration schema.
 * All helper functions reference this to avoid duplication.
 * 
 * Composed from STORY_PAGE_SCHEMA_DEFINITION + STATE_DELTA_SCHEMA_DEFINITION
 * (the multi-turn exports above) rather than the legacy
 * STORY_PAGE_GENERATION_SCHEMA/STORY_STATE_GENERATION_SCHEMA names directly —
 * same two objects either way (the multi-turn exports are aliases, not
 * copies), but this keeps a single textual reference point so the legacy
 * single-shot schema and the two split schemas structurally cannot diverge.
 * 
 * @todo ApiError: {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}
 */
export const STORY_GENERATION_SCHEMA_DEFINITION = {
  ...STORY_PAGE_SCHEMA_DEFINITION, // Page
  ...STATE_DELTA_SCHEMA_DEFINITION, // State Delta
  branchNames: {
    type: 'array',
    items: { type: 'string' },
    description: 'Suggest 3 creative, distinct names for this timeline. Evocative, spoiler-free.',
  },
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
  const { useStringEvaluatorOutput = true, outputJsonStructure, outputJsonRequired } = options;
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
    output: useStringEvaluatorOutput
      ? {
          type: 'string',
          description: 'Full corrected JSON output as a string. See the expected JSON structure in prompt — output the corrected JSON as a valid JSON string here.'
        }
      : {
          type: 'object',
          properties: outputJsonStructure,
          required: outputJsonRequired,
          additionalProperties: outputJsonStructure ? false : undefined,
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
  worldClock: undefined,
}

export const SANITY_STATE_DEFAULTS: SanityState = {
  composure: 100,
  maxComposure: 100,
  decayRate: 5,
  hasCrashed: false,
  // crashedAtPage omitted until first crash
};

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
  plannedCharacters: [],
  sanityState: SANITY_STATE_DEFAULTS,
};

/**
 * Schema definition for AI validation response
 * 
 * Matches the flat object pattern used in the codebase (see schema/story.ts)
 * instead of nested JSON Schema format.
 */
export const MAIN_CHARACTER_SCHEMA: AIJsonProperty = {
  type: 'object',
  description: 'Inferred main character who perfectly fit with the story theme',
  properties: {
    name: { type: 'string', description: 'A rare name, yet consistent with the detected language.' },
    age: { type: 'integer', description: `Between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}` },
    gender: { type: 'string', enum: ['male', 'female'] satisfies KnownGender[] },
    bio: { type: 'string', description: 'Trait-forward description in detected language. Include at least one psychological vulnerability. Can include birth date (month and day) if relevant to story.' },
    knownName: { type: 'string', description: 'Preferred alias or nick referred by other characters.' },
  } satisfies Record<keyof StoryMCGeneration, AIJsonProperty>,
  required: ['name', 'age', 'gender', 'bio', 'knownName'] satisfies (keyof StoryMCGeneration)[],
  additionalProperties: false
};

export const THEME_VALIDATION_CATEGORIES: ThemeValidationCategory[] = ['INAPPROPRIATE_CONTENT', 'SUSPICIOUS_PATTERN', 'INVALID_THEME', 'POLICY_VIOLATION', 'OTHER', 'NONE'];
export const THEME_VALIDATION_DETECTED_ITEM_TYPES: AIDetectedItemType[] = ['word', 'pattern', 'pov_instruction', 'invalid_format', 'other'];

export const THEME_VALIDATION_SCHEMA: Record<keyof Omit<AIValidationResult, 'aiProvider' | 'aiModel'>, AIJsonProperty> = {
  language: { type: 'string', description: 'Detected language code (ISO 639-1)' },
  isViolating: { type: 'boolean', description: 'If theme is valid and safe, output false' },
  category: { type: 'string', enum: THEME_VALIDATION_CATEGORIES, description: 'If theme is valid and safe, output "NONE"' },
  confidence: { type: 'number' },
  detectedItems: {
    type: 'array',
    description: 'If theme is valid and safe, output empty array',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: THEME_VALIDATION_DETECTED_ITEM_TYPES },
        value: { type: 'string' },
        context: { type: 'string' },
        reason: { type: 'string' },
      } satisfies Record<keyof AIDetectedItem, AIJsonProperty>,
      required: ['type', 'value', 'context', 'reason'] satisfies (keyof AIDetectedItem)[],
      additionalProperties: false
    }
  },
  suggestion: { type: 'string', description: '1-sentence suggestion in detected language on how to fix the issue. Omit if theme is valid.' },
  comment: { type: 'string', description: 'Your complimentary comment in detected language (follow comment structure & example). Omit if theme is invalid.' },
  titleIdea: { type: 'string', description: `${BOOK_TITLE_LENGTH} in detected language. Omit if theme is invalid.` },
  hook: { type: 'string', description: `Immediate intrigue — ${HOOK_LENGTH} in detected language. Omit if theme is invalid.` },
  summary: { type: 'string', description: `Sets up premise — ${SUMMARY_LENGTH} in detected language. No spoilers. Omit if theme is invalid.` },
  mcCandidate: {
    ...MAIN_CHARACTER_SCHEMA,
    description: `${MAIN_CHARACTER_SCHEMA.description}. Omit if theme is invalid.`
  }
};

const { placeId: _pi, ...initialStoryPageGeneration} = STORY_PAGE_GENERATION_SCHEMA;

export const INITIAL_STORY_PAGE_GENERATION_SCHEMA: Record<keyof InitialStoryPageGeneration, AIJsonProperty> = {
  ...initialStoryPageGeneration,
  momentum: { type: 'string', enum: [...Object.keys(storyMomentums)], description: 'Narrative pressure or urgency level in the first page.' },
  charactersPresent: {
    ...initialStoryPageGeneration.charactersPresent,
    description: 'Characters physically present in this page (besides MC). Must match characters in initialCharacters exactly.',
  }
};

/**
 * Common schema definition for BookCreationResponse type
 * 
 * This is the single source of truth for BookCreationResponse schema.
 * All helper functions reference this to avoid duplication.
 */
export const BOOK_CREATION_SCHEMA_DEFINITION: Record<keyof BookCreationResponse, AIJsonProperty> = {
  title: { type: 'string' },
  alternativeTitles: { type: 'array', items: { type: 'string' } },
  totalPages: { type: 'integer', description: `Between ${BOOK_MIN_PAGES} and ${BOOK_MAX_PAGES}` },
  language: { type: 'string', description: 'ISO 639-1 code' },
  hook: { type: 'string', description: `${HOOK_LENGTH}. Immediate intrigue. Psychological tension.` },
  summary: { type: 'string', description: `${SUMMARY_LENGTH}. Sets up premise without revealing the ending plan.` },
  keywords: { type: 'array', items: { type: 'string' }, description: `${KEYWORDS_COUNT} kebab-case tags for theme, genre, mood, and story categorization (keep each short).` },
  firstPage: {
    type: 'object',
    properties: INITIAL_STORY_PAGE_GENERATION_SCHEMA,
    required: STORY_GENERATION_REQUIRED_FIELDS,
    additionalProperties: false
  },
  initialState: {
    type: 'object',
    properties: {
      flags: {
        type: 'object',
        properties: {
          trust: { type: 'string', enum: [...flagLevels] satisfies TrustLevel[] },
          fear: { type: 'string', enum: [...flagLevels] satisfies FearLevel[] },
          guilt: { type: 'string', enum: [...flagLevels] satisfies GuiltLevel[] },
          curiosity: { type: 'string', enum: [...flagLevels] satisfies CuriosityLevel[] },
        } satisfies Record<keyof PsychologicalFlags, AIJsonProperty>,
        required: ['trust', 'fear', 'guilt', 'curiosity'] satisfies (keyof PsychologicalFlags)[],
        additionalProperties: false
      },
      difficulty: { type: 'string', enum: [...difficulties] },
      traumaTags: { type: 'array', items: { type: 'string' } },
      plotFlags: PLOT_FLAGS_SCHEMA,
      inventory: { type: 'array', items: INITIAL_INVENTORY_ITEM_SCHEMA },
      injuries: { type: 'array', items: INITIAL_INJURY_SCHEMA },
      memoryIntegrity: { type: 'string', enum: [...memoryIntegrities] },
    } satisfies Record<keyof InitialStoryState, AIJsonProperty>,
    required: ['flags', 'difficulty', 'traumaTags', 'plotFlags'] satisfies (keyof InitialStoryState)[],
    additionalProperties: false
  },
  viableEnding: INITIAL_VIABLE_ENDING_SCHEMA,
  futureNotes: {
    type: 'array',
    description: `Forward-looking narrative obligations for future AI turns (max ${MAX_FUTURE_NOTES}).`,
    items: FUTURE_NOTE_SCHEMA
  },
  initialThreads: THREADS_SCHEMA,
  initialFacts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: FACT_KEY_FORMAT },
        value: { type: 'string' },
        type: { type: 'string', enum: [...Object.keys(factTypes)] },
        reason: { type: 'string', description: 'Explain why in 1 sentence' },
      } satisfies Record<keyof InitialFact, AIJsonProperty>,
      required: ['key', 'value'] satisfies (keyof InitialFact)[],
      additionalProperties: false
    }
  },
  initialPlace: INITIAL_PLACE_SCHEMA,
  initialCharacters: { type: 'array', items: INITIAL_CHARACTER_SCHEMA },
  plannedCharacters: { type: 'array', description: 'Any unintroduced characters inferred from theme.', items: {
    type: 'object',
    properties: CHARACTER_PLAN_PROPERTIES,
    required: ['characterId', 'knownName', 'realName', 'gender', 'role', 'bio', 'appearance', 'storyPurpose', 'plannedIntro', 'importance'] satisfies (keyof CharacterPlan)[],
    additionalProperties: false
  } },
  initialRelationships: { type: 'array', items: RELATIONSHIP_UPDATE_SCHEMA },
  mainCharacter: MAIN_CHARACTER_SCHEMA,
  aiFinalComment: { type: 'string', description: `Thriller-themed congratulatory message in specified language (max ${MAX_FINAL_COMMENT_LENGTH} chars).` }
};

export const BOOK_CREATION_REQUIRED_FIELDS = [
  'title',
  'totalPages',
  'language',
  'hook',
  'summary',
  'keywords',
  'firstPage',
  'initialState',
  'initialPlace',
  'initialCharacters',
  'plannedCharacters',
  'initialRelationships',
  'initialThreads',
  'initialFacts',
  'mainCharacter',
  'viableEnding',
  'futureNotes',
] satisfies Array<keyof BookCreationResponse>;

/**
 * Schema definition for BookTranslation type
 */
export const BOOK_TRANSLATION_SCHEMA_DEFINITION = {
  title: { type: 'string' },
  hook: { type: 'string' },
  summary: { type: 'string' },
  keywords: { type: 'array', items: { type: 'string' } },
  mc: {
    type: 'object',
    properties: {
      bio: { type: 'string' },
    } satisfies Record<keyof StoryMCTranslation, AIJsonProperty>,
    required: ['bio'] satisfies (keyof StoryMCTranslation)[],
    additionalProperties: false
  }
} satisfies Record<keyof BookTranslation, AIJsonProperty>;

export const BOOK_TRANSLATION_REQUIRED_FIELDS = ['title', 'hook', 'summary', 'keywords', 'mc'] satisfies Array<keyof BookTranslation>;

/**
 * Schema definition for bulk book translation
 */
export const BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION = {
  translations: { type: 'array', items: {
    type: 'object',
    properties: { bookId: { type: 'string' }, ...BOOK_TRANSLATION_SCHEMA_DEFINITION } satisfies Record<keyof BookTranslationWithID, AIJsonProperty>,
    required: ['bookId', 'title', 'hook', 'summary', 'keywords', 'mc'] satisfies (keyof BookTranslationWithID)[],
    additionalProperties: false
  } }
} satisfies Record<keyof BookTranslationBulk, AIJsonProperty>;

export const BULK_BOOK_TRANSLATION_REQUIRED_FIELDS = ['translations'] satisfies Array<keyof { translations: BookTranslation[] }>;

/**
 * Schema definition for PageTranslation type
 */
export const PAGE_TRANSLATION_SCHEMA_DEFINITION = {
  text: { type: 'string' },
  timeOfDay: { type: 'string' },
  mood: { type: 'string' },
  weather: { type: 'string' },
  keyEvents: { type: 'array', items: { type: 'string' } },
  keyObjects: { type: 'array', items: { type: 'string' } },
  actions: { type: 'array', items: {
    type: 'object',
    properties: {
      originalText: { type: 'string', description: 'Before translation' },
      text: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['originalText', 'text', 'hint'] satisfies (keyof ActionTranslation)[],
    additionalProperties: false
  } },
  actionsHistory: { type: 'array', items: {
    type: 'object',
    properties: {
      originalText: { type: 'string', description: 'Before translation' },
      text: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['originalText', 'text', 'hint'] satisfies (keyof ActionTranslation)[],
    additionalProperties: false
  } },
  contextHistory: { type: 'string' },
  places: { type: 'array', items: {
    type: 'object',
    properties: {
      placeId: { type: 'string' },
      knownName: { type: 'string' },
      realName: { type: 'string' },
      context: { type: 'string' },
      type: { type: 'string' },
      traits: {
        type: 'array',
        description: 'Any relevant details for narrative consistency (key-value pairs)',
        items: buildTraitItemSchema({
          keyDescription: placeTraitsExample,
        })
      },
    } satisfies Record<keyof PlaceMemoryTranslation, AIJsonProperty>,
    required: ['placeId', 'knownName', 'realName', 'type'] satisfies (keyof PlaceMemoryTranslation)[],
    additionalProperties: false
  } },
  characters: { type: 'array', items: {
    type: 'object',
    properties: {
      characterId: { type: 'string' },
      role: { type: 'string' },
      bio: { type: 'string' },
      traits: {
        type: 'array',
        description: 'Story-relevant character details (key-value pairs)',
        items: buildTraitItemSchema()
      },
    } satisfies Record<keyof CharacterMemoryTranslation, AIJsonProperty>,
    required: ['characterId', 'role', 'bio'] satisfies (keyof CharacterMemoryTranslation)[],
    additionalProperties: false
  } },
  inventory: { type: 'array', items: {
    type: 'object',
    properties: {
      originalName: { type: 'string', description: 'Before translation' },
      name: { type: 'string' },
      traits: {
        type: 'array',
        description: 'Traits or properties of the item',
        items: buildTraitItemSchema()
      },
      where: { type: 'string' },
    } satisfies Record<keyof InventoryItemTranslation, AIJsonProperty>,
    required: ['originalName', 'name', 'traits', 'where'] satisfies (keyof InventoryItemTranslation)[],
    additionalProperties: false
  } },
  injuries: { type: 'array', items: {
    type: 'object',
    properties: {
      bodyPart: { type: 'string' },
      description: { type: 'string' },
      consequences: { type: 'string' },
    } satisfies Record<keyof InjuryTranslation, AIJsonProperty>,
    required: ['bodyPart', 'description', 'consequences'] satisfies (keyof InjuryTranslation)[],
    additionalProperties: false
  } },
  threads: { type: 'array', items: {
    type: 'object',
    properties: {
      threadId: { type: 'string' },
      title: { type: 'string' },
      question: { type: 'string' },
      summary: { type: 'string' },
      clues: { type: 'array', items: {
        type: 'object',
        properties: {
          originalClue: { type: 'string', description: 'Before translation' },
          clue: { type: 'string' },
        } satisfies Record<keyof ThreadClueTranslation, AIJsonProperty>,
        required: ['originalClue', 'clue'] satisfies (keyof ThreadClueTranslation)[],
        additionalProperties: false
      } },
    } satisfies Record<keyof StoryThreadTranslation, AIJsonProperty>,
    required: ['threadId', 'title', 'question', 'summary', 'clues'] satisfies (keyof StoryThreadTranslation)[],
    additionalProperties: false
  } },
} satisfies Record<keyof PageTranslation, AIJsonProperty>;

export const PAGE_TRANSLATION_REQUIRED_FIELDS = ['text', 'actions'] satisfies Array<keyof PageTranslation>;

/**
 * Schema definition for bulk page translation
 */
export const BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION = {
  translations: { type: 'array', items: {
    type: 'object',
    properties: { pageId: { type: 'string' }, ...PAGE_TRANSLATION_SCHEMA_DEFINITION } satisfies Record<keyof PageTranslationWithID, AIJsonProperty>,
    required: ['pageId', 'text', 'keyEvents', 'keyObjects', 'actions', 'actionsHistory'] satisfies (keyof PageTranslationWithID)[],
    additionalProperties: false
  } }
} satisfies Record<keyof PageTranslationBulk, AIJsonProperty>;

export const BULK_PAGE_TRANSLATION_REQUIRED_FIELDS = ['translations'] satisfies Array<keyof { translations: PageTranslation[] }>;