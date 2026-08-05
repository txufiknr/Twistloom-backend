import { AI_CHAT_CONFIG_DEFAULT, AI_CHAT_CONFIG_CREATIVE, DEFAULT_MAX_OUTPUT_TOKEN } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_THEME, AI_CHAT_MODELS_WRITING, AI_CHAT_MODELS_EVALUATION } from "../config/ai-clients.js";
import { characterImportances, characterStatuses } from "../config/enums.js";
import { actionTypes, archetypes, stabilityLevels, manipulationAffinities, truthLevels, threatProximities, realityStabilities, endingTypes, finalePhases, factTypes, sceneTypes, storyMomentums } from "../config/enums.js";
import type { StoryState, Action, PsychologicalFlags, PsychologicalProfile, HiddenState, PersistedStoryPage, ActionHintType, AIActionConfig, StabilityLevel } from "../types/story.js";
import { moodValues, weatherValues, sceneTypeValues, sceneRoleValues, momentumValues, actionTypeValues, hintTypeValues, memoryIntegrityValues, difficultyValues, plotFlagTypeValues, injuryCategoryValues, threadPriorityValues, threadTruthValues, threadStatusValues, endingTypeValues, factTypeValues, phaseValues, stabilityLevelValues, healthConditionValues, canonicalPlaceTypeValues, accessibilityValues, recognitionLevelValues, genderValues, characterStatusValues, characterImportanceValues, relationshipTypeValues, relationshipStatusValues, twistTypeValues, psychologicalFlagTypeValues, flagLevelValues } from "../config/enums.js";
import { createNonRetryableError } from "./retry.js";
import { TWIST_INJECTION_CONFIG, JSON_RELIABILITY_CAPS, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FIRST_PAGE, MAX_CHARACTERS, MAX_PLACES, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, BOOK_MIN_PAGES, VIABLE_ENDING_LENGTH, MIN_ACTION_CHOICES, PLACE_CONTEXT_LENGTH, BOOK_TITLE_LENGTH, HOOK_LENGTH, SUMMARY_LENGTH, KEYWORDS_COUNT, MAX_ACTIVE_THREADS, MAX_TRAUMA_TAGS, KEY_EVENT_LENGTH, ACTION_TEXT_LENGTH, MAX_BRANCHING_PREGENERATION_DEPTH, MAX_FUTURE_NOTES, RELATIONSHIP_TO_MC_LENGTH, MAX_INVENTORY_ITEM, MAX_CHARACTER_SECRETS, FACT_KEY_FORMAT, FUTURE_NOTE_LOOKAHEAD_PAGES, MAX_RECENT_MAJOR_EVENTS, MAX_PAGE_HISTORY, MAX_OLDER_PLOT_FLAGS, MAX_THREADS_CLUES, MAX_ACTION_CHOICES_FINALE, FUTURE_NOTE_LOOKAHEAD_DAYS } from "../config/story.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { aiPrompt, createAIOptionsWithSchema, resolveUseStringEvaluator } from "./ai-chat.js";
import { createEmptyStoryState, createInitialHiddenState, determineOptimalEnding, getStoryStateInfo, extractStateDelta, applyStateDelta, advanceStoryState, calculatePsychologicalDeltas, mapFutureNoteWithKey, createStoryThread } from "./story.js";
import { ensureCandidatesForPageWithStrategy, triggerCandidateGenerationWorkflow } from "./candidate-generation.js";
import { calculateHealthStatus, generateRandomCharacter, getMainCharacterInfo } from "./characters.js";
import { getPreviousPages } from "../services/story.js";
import { BOOK_MAX_PAGES, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT } from "../config/story.js";
import { getErrorMessage } from "./error.js";
import { validatePageActionsForMode } from "./book-mode.js";
import { validateGeneratedPage, checkGeneratedPage } from "./page-validation.js";
import { buildBookMetaDocuments, generateAndUpdateBookCoverImage, insertBook, insertStoryPage, mapBookFromDb, getPageFromDB, getBookFromDB, persistPageWithState, mapToPersistedStoryPage, updateBook, invalidatePopularTagsCache } from "../services/book.js";
import { runCanonValidationPass, insertCanonValidationAudit } from "../services/canon-validation.js";
import { dbWrite, dbRead } from "../db/client.js";
import { bookGenerations } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { insertStoryState } from "../services/story.js";
import { invalidateUserBooksCache, invalidateUserProfileCache, invalidateExploreCache } from "../services/cache.js";
import { logUserActivity } from "../services/user.js";
import { notifyForumOfBookChange } from "../services/forum-queue.js";
import { generateBranchId, getStoryStateWithBranch } from "../services/story-branch.js";
import { BOOK_CREATION_REQUIRED_FIELDS, BOOK_CREATION_SCHEMA_DEFINITION, CANDIDATE_GENERATION_REQUIRED_FIELDS, CANDIDATE_GENERATION_SCHEMA_DEFINITION, SANITY_STATE_DEFAULTS, STORY_GENERATION_REQUIRED_FIELDS, STORY_GENERATION_SCHEMA_DEFINITION } from "../schema/story.js";
import { formatPageTextForPrompt } from "./books.js";
import type { ThreadPriority, StoryThread, ThreadStatus } from "../types/story-thread.js";
import { aiStreamSSE, parseSSEStreamContent } from "./ai-chat-stream.js";
import { MAX_THEME_LENGTH_PROMPT } from "../config/theme-validation.js";
import { filterObjectEntries, parsePageRange, stripEmptyLines } from "./parser.js";
import { genders } from "../config/enums.js";
import { updateBookGenerationStatus } from "../services/book-creation.js";
import { formatLanguage } from "./translation.js";
import { DEFAULT_CANDIDATE_PAGE_PER_ACTION, MAX_CANDIDATE_PAGE_PER_ACTION } from "../config/candidate-generation.js";
import { canonicalPlaceTypes } from "../config/enums.js";
import type { PlaceMemory } from "../types/places.js";
import type { DBNewBook } from "../types/schema.js";
import type { ActionedStoryPage, Ending, EndingPlan, FactHistory, FutureNote, FutureNoteSchedule, FutureNoteStateTrigger, MemoryIntegrity, PastEvent, PlotFlag, SanityState, SceneType, StateDelta, StoryGeneration, StoryOutline, StoryPage, StoryPhase, StoryStateInfo, UserStoryPage } from "../types/story.js";
import type { AIChatConfig, AIChatConfigCaps, AIPromptForJson, AIPromptForJsonParams, AIResponse } from "../types/ai-chat.js";
import type { CharacterMemory, CharacterRelationship, Injury, InventoryItem, PastInteraction, HealthStatus, StoryMCCandidate } from "../types/character.js";
import type { Book, BookCreationResponse, BookGenerationProgress, StoryGenerationStep, InitializeBookParams, CreateBookResponse, BookStatus, BookMode } from "../types/book.js";
import type { BuildNextPageParams, GenerateBookCreationPromptParams, BuildNextPagePromptParams } from "../types/prompt.js";
import type { AIChatStreamResult, ProgressCallback } from "../types/sse.js";
import type { CandidateGenerationPage, CandidatePagesGeneration } from "../types/candidate-generation.js";
import { ucfirst } from "./formatter.js";
import { daysBetween, formatMinutes, toUtcMidnight } from "./time.js";
import { HINT_GUIDANCE_MAP, MAX_FINAL_COMMENT_LENGTH, PROMPT_SYSTEM_WRITING_STYLE, RULES_PAGE_TEXT_BY_PRESET } from "../config/book-creation.js";
import type { WritingPreset } from "../types/book-creation.js";
import { formatOneOf } from "./text-processing.js";
import { sanitizePromptAppend } from "./prompt-security.js";
import { applyAdvancedOptions, validateAIConfig } from "./ai-sampling.js";
import { embedPersistedPage, embedStateDeltaEntities, retrieveSimilarPages, retrieveCharacterInteractions, retrievePlaceEvents, retrieveRelevantFutureNotes, retrieveClues } from "../services/vector-memory.js";
import { MAX_VECTOR_RESULTS_HIGH_VALUE } from "../config/embedding.js";

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

/**
 * Core system prompt defining the AI writer's persona and fundamental behavior
 * 
 * This prompt establishes the psychological thriller writer persona inspired by
 * R.L. Stine but darker, with specific rules for narrative manipulation and
 * psychological horror elements.
 */
export const PROMPT_SYSTEM = PROMPT_SYSTEM_WRITING_STYLE.default;

// ============================================================================
// RULE SETS
// ============================================================================

/**
 * Matters most for the weaker/free-tier models further down the provider waterfall;
 * they're the most likely to default back to English mid-story.
 */
export const RULES_LANGUAGE_LOCALIZATION = `STRICT LANGUAGE & LOCALIZATION:
- The requested language is an ABSOLUTE MANDATE, overriding all stylistic preferences. Generate every user-facing field (any value shown to readers or authors without further AI processing) exclusively in it — never default to English, never mix languages, unless explicitly requested.
- Use everyday expressions, slang, and terminology that feel native to that locale, not translated-sounding.
- Preserve proper nouns and provided names as-is. Otherwise choose names, places, institutions, and terminology fitting the requested language's cultural context.
- Defaulting back to English (or any unrequested language) is treated as an incorrect response.`;

/**
 * Rules for how route memory and past actions influence the narrative
 * 
 * These rules guide the AI in incorporating user choices and accumulated
 * psychological states into the ongoing story in subtle, meaningful ways.
 */
export const RULES_ROUTE_MEMORY = `ROUTE MEMORY RULES:

Past Actions — build a psychological profile from decision patterns over time, then weaponize it: mirror the player's patterns back in twisted form, turn strengths into weaknesses, make their usual approach fail, make them doubt their own judgment.
- Risk: seeker → make safety illusory. Averse → force no-win scenarios. Balanced → break the pattern by alternating.
- Trust: trusting → betrayals land harder, helpers turn. Distrustful → rare genuine help becomes a trap, paranoia gets justified. Inconsistent → reality itself fractures.
- Curiosity: curious → answers curse more than they reveal. Cautious → avoidance backfires, outside forces push them in anyway. Mixed → knowledge becomes a weapon against them.
- Emotion: fear-driven → psychological threats over physical. Logic-driven → impossible logic that breaks rational thinking. Emotional → manipulate through relationships and guilt.

Story State Flags (the current story, not play patterns — separate from the profile above):
- Trust: low → betrayal/deception. High → apparent help (may still turn).
- Fear: high → panic, distorted perception. Low → curiosity, denial.
- Guilt: high → hallucinations, voices, trauma echoes.
- Curiosity: high → drawn to danger. Low → hesitation, avoidance.
- Memory Integrity: stable → accurate recall. Fragmented → inconsistent details. Corrupted → false memories.
- Composure (distinct from Memory Integrity — a reader-facing pressure meter, not recall reliability): high → still functions, brief lucidity even in danger. Low → panic, tunnel vision, crushing pressure. Crashed → crisis: reality and identity fracture, no safe choices.

Trauma Tags — reappear altered and disturbing, echoed through environment, dialogue, and perception. Never fully explained.

Consequences — delayed, subtle, escalating, sometimes unfair. The story should feel like it remembers what the player did.

Memory Corruption — never state it directly; let contradictions surface naturally so the reader quietly starts questioning earlier pages.`;

/**
 * Rules for maintaining narrative consistency despite psychological elements
 * 
 * Ensures the story remains coherent and emotionally impactful even when
 * incorporating unreliable narration and reality distortion.
 */
export const RULES_STORY_CONSISTENCY = `STORY CONSISTENCY:

Internal Logic — maintain tone even when events feel wrong; preserve continuity of key objects, locations, emotional states, and threats. Anchor contradictions to memory corruption or perception distortion, never random noise.

Coherence — no events without emotional or narrative connection, no tone breaks. Every strange moment escalates tension or echoes past trauma.

Element Reuse — objects reappear changed, not replaced. Dialogue echoes. Locations feel altered. The world remembers.

Guiding principle: confusing, never meaningless.`;

/**
 * Rules for story difficulty scaling and progression
 * 
 * Defines how story intensity and psychological pressure should increase
 * based on difficulty settings and story progression.
 */
export const RULES_DIFFICULTY_SCALING = `DIFFICULTY SCALING:
Higher difficulty = more unreliable narration and reality distortion.
Levels:
- 'low': Stable narrative, occasional relief
- 'medium': Tension, misdirection, occasional betrayal
- 'high': Frequent twists, emotional damage, unreliable characters
- 'nightmare': Constant pressure, no safe choices, broken reality`;

/**
 * Teaches the model the vocabulary of the three future-note "buckets" it
 * will see notes grouped under later in the same prompt, rendered by
 * formatFutureNotes() ("Becoming Relevant", "Future Payoffs & Scheduled
 * Events", "Unscheduled"). Keep these header names in sync with that
 * function — the model is matched against the literal text, not just
 * the concept.
 */
export const RULES_FUTURE_NOTES = `FUTURE NOTE SCHEDULING:
- schedule (array): anchors a note to one or more time beats (phase/page/day/date). Multiple entries = OR logic — the note activates as soon as ANY entry enters its lookahead window.
- stateTrigger (array): use only when the note genuinely depends on the MC reaching a specific physical or psychological threshold. Multiple entries = OR logic — dormant until ANY threshold is crossed. Never manufacture a triggering state just to resolve one early; the MC must genuinely reach it.
- Both fields are optional and independent — use both when EITHER should activate the note, neither for open-ended notes with no identifiable trigger.

Existing notes are shown to you bucketed under three headers — advance each according to its bucket:
- Becoming Relevant: schedule window is open, or stateTrigger is met. Advance naturally — foreshadowing, setup, and incremental tension all count; immediate resolution isn't required.
- Future Payoffs & Scheduled Events: schedule hasn't opened yet. Long-term awareness only — don't force these into the current page.
- Unscheduled: no schedule, or a stateTrigger not yet met. Its "triggers when: …" annotation shows what activates it — begin advancing only as the MC approaches that state, not before.`;

/**
 * Optional misdirection technique: lets the model plant a hint that reads
 * as true in the moment but resolves as misleading later, without ever
 * tipping its hand. A craft technique, not a content-safety rule.
 */
export const RULES_FALSE_PREVIEW = `FALSE PREVIEW SYSTEM:

You may inject a "false preview" — a misleading hint about future events. It must feel believable and logically connected, partially true but misleading, and distort identity, cause, timing, or danger source — never revealing itself as false.

Examples:
A. NPC Agreement — "Don't trust him," she whispered. / I knew it.
B. Environmental Reinforcement — The door was locked. / Of course it was.
C. Memory Echo — I remembered this. / It ends badly if I go inside.`;

/**
 * Keeps location descriptions consistent with a place's accumulated state
 * (mood history, traits, trauma) instead of regenerating flavor text from
 * scratch each time the MC returns somewhere.
 */
export const RULES_PLACE = `PLACE RULES:
- Use existing places whenever possible.
- Reflect last mood and event history in descriptions.
- Reflect traits and key objects consistently.
- Familiar places feel more textured and real.
- Apply trauma tags to atmosphere — a betrayal place stays tense.`;

/**
 * Gates what the model may reveal about a character against that character's
 * recognitionLevel (see RULES_CHARACTER_RECOGNITION below), so hidden
 * identity/secret fields never leak into prose ahead of an intended reveal.
 */
export const RULES_CHARACTER = `CHARACTER RULES:
- NEVER reveal hidden character data unless explicitly discovered. Refer to characters per their recognitionLevel (below) — never their real name unless that level permits it.
- Respect each character's bio and appearance — preserve dialect, tone, and personality; use pastInteractions to shape dialogue, reflect current status in behavior, and reintroduce naturally after an absence.
- Characters may shift suddenly if their potentialTwist suggests it — never explain the change. Use relationships to build tension triangles; characters may also misunderstand, reinforcing illusion or false theory through dialogue or action.`;

/**
 * Defines the naming vocabulary ("the tall man", "The Janitor", etc.) tied
 * to each character's recognitionLevel, so in-story references stay
 * consistent with what the MC has actually learned.
 */
export const RULES_CHARACTER_RECOGNITION = `CHARACTER RECOGNITION LEVEL:
Notice how characters refer to each other based on recognitionLevel:
- never_seen: unseen by the source character ("someone", "a figure").
- seen: description only, never a name ("the tall man", "the woman in red").
- alias_known: alias/codename only ("The Janitor").
- first_name_known / full_name_known: use the known name normally.`;

/**
 * Governs addPlannedCharacters / newCharacters — lets the
 * model seed characters into story canon before they physically appear,
 * then introduce them later without contradicting earlier-planned bio
 * details. Only spliced into the prompt when state.plannedCharacters is
 * non-empty (see buildNextPagePrompt), so it costs nothing on pages with
 * no planned characters waiting in the wings.
 */
export const RULES_PLANNED_CHARACTERS = `PLANNED CHARACTERS RULES:
- These characters exist in the story canon but have not yet appeared on-page.
- Use addPlannedCharacters to create new planned characters when the story needs future faces. Only valid in EARLY and MID phases.
- Introduce them naturally (add to newCharacters) when appropriate for the current scene, pacing, and story momentum.
- Only add to newCharacters when a planned character is genuinely introduced (physically present) in this page.
- Refine details like bio, appearance, etc when introducing planned characters. Preserve name, gender and role.`;

/**
 * Action rules and a human-readable list of action types (excluding
 * the internal 'custom' type). Each action type is emitted as `- key: desc`.
 */
export const RULES_ACTIONS = `BRANCHING STORY RULES:
No choice should feel truly safe — exploit the gap between what the MC knows and what the reader suspects.

ACTION TYPES:
${formatKeyValueList(Object.fromEntries(Object.entries(actionTypes).filter(([key]) => key !== 'custom')))}

DIALOGUE ACTIONS:
- Use sparingly, for internal scenes or interactions. Write as direct speech (no quotes) — short, natural, emotionally meaningful, in the MC's tone and style.
- Reflect varied tones (fear, denial, curiosity, anger, etc). The MC may say something inappropriate or with unintended consequences.`;

/**
 * Human-readable list of ending archetypes used by the prompt system.
 * Each line is formatted as `- key: description` for inclusion in the
 * generated instructions given to the AI.
 */
export const RULES_ENDING_ARCHETYPES = `ENDING ARCHETYPES:
${formatKeyValueList(endingTypes)}`;

/**
 * Human-readable list of story momentum descriptions.
 * Used to inform pacing and escalation behavior in the prompt.
 */
export const RULES_STORY_MOMENTUMS = `STORY MOMENTUM GUIDANCE:
- Story momentum indicates recent narrative pressure or urgency level. Use it as continuation context rather than a requirement.
- Allow momentum to evolve naturally from story events. It may increase, decrease, remain stable, or begin resolving when justified.

Momentums:
${formatKeyValueList(storyMomentums)}`;

/**
 * Human-readable list of scene types available to the story generator.
 */
export const RULES_SCENE_TYPES = `SCENE TYPES (sorted by most important):
${formatKeyValueList(sceneTypes)}`;

// ============================================================================
// WRITING PRESET PROMPT BUILDERS
// ============================================================================

/**
 * Builds the first-page rule set (without the writing-style header) for a given
 * writing preset, injecting the preset-specific page-text rules.
 */
function buildFirstPageRuleSet(preset: WritingPreset = 'default'): string {
  const pageTextRules = RULES_PAGE_TEXT_BY_PRESET[preset] ?? RULES_PAGE_TEXT_BY_PRESET.default;
  return [
    RULES_DIFFICULTY_SCALING,
    RULES_ENDING_ARCHETYPES,
    RULES_STORY_MOMENTUMS,
    RULES_SCENE_TYPES,
    RULES_PLACE,
    RULES_CHARACTER,
    RULES_CHARACTER_RECOGNITION,
    pageTextRules,
    RULES_ACTIONS,
  ].join('\n\n---\n');
}

/**
 * Builds the complete system prompt (writing style + rules) for a given writing
 * preset and generation phase (first page or subsequent page).
 */
function buildPresetSystemPrompt(type: 'first' | 'next', preset: WritingPreset = 'default'): string {
  const writingStyle = PROMPT_SYSTEM_WRITING_STYLE[preset] ?? PROMPT_SYSTEM_WRITING_STYLE.default;
  const firstPageRules = buildFirstPageRuleSet(preset);

  const rules = type === 'first' ? firstPageRules : [
    RULES_ROUTE_MEMORY,
    RULES_STORY_CONSISTENCY,
    RULES_FUTURE_NOTES,
    RULES_FALSE_PREVIEW,
    firstPageRules,
  ].join('\n\n---\n');

  // Language enforcement is preset-independent (applies identically to first-page
  // and next-page generation), so it's spliced in once here rather than duplicated
  // into all 8 PROMPT_SYSTEM_WRITING_STYLE strings.
  return `${writingStyle}\n\n---\n${RULES_LANGUAGE_LOCALIZATION}\n\n---\n${rules}`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Shared JSON-shape fragments for the AI-facing example templates below.
 *
 * firstBookOutputFormat (book creation) and nextPageOutputFormat (ongoing
 * generation) each need to show the AI what a *newly created* character,
 * place, thread, future note, and planned character look like -- and until
 * now those were five separate hand-maintained copies, one per template.
 * That's how the newPlaces.knownCharacters bug happened: the two copies
 * drifted, and only one got fixed. Defining each shape once here and
 * interpolating it into both templates makes that class of bug structurally
 * impossible -- there's only one place left to get it wrong.
 *
 * Where the two original copies differed only in placeholder verbosity
 * (e.g. "Real Full Name" vs "..."), the terser form was kept -- the fuller
 * labels were restating what RULES_CHARACTER_RECOGNITION already establishes
 * in the system prompt by the time either template is filled in. Where a
 * difference was a genuine constraint (the secrets count cap, the
 * relationshipToMC context length limit) or the *only* place in the whole
 * schema demonstrating a shape (the injury object's fields), the fuller
 * version was kept and now appears in both templates instead of just one.
 */
function indentLines(text: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return text.split('\n').join('\n' + indent);
}

const NEW_CHARACTER_SHAPE = `{\n${indentLines(`\
  "characterId": "<new_character_id>",
  "knownName": "...",
  "realName": "...",
  "recognitionLevel": "${recognitionLevelValues}",
  "gender": "${genderValues}",
  "role": "...",
  "bio": "Brief character description. Include one trait that could become a source of threat or betrayal.",
  "appearance": "...",
  "status": "${characterStatusValues}",
  "secrets": ["Any secrets unknown to MC (max ${MAX_CHARACTER_SECRETS})."],
  "importance": "${characterImportanceValues}",
  "relationshipToMC": {
    "type": "${relationshipTypeValues}",
    "status": "${relationshipStatusValues}",
    "context": "${RELATIONSHIP_TO_MC_LENGTH}. Specific dynamic, not generic (e.g. 'Close childhood friend who knows too much.')",
    "recognitionLevel": "${recognitionLevelValues}"
  },
  "pastInteractions": ["..."],
  "potentialTwist": "${twistTypeValues}",
  "traits": [
    "...: ..."
  ],
  "schedules": [
    {
      "placeId": "<place_id>",
      "availabilityWindow": "...",
      "missedConsequence": "..."
    }
  ],
  "injuries": [
    {
      "bodyPart": "...",
      "description": "...",
      "consequences": "...",
      "category": "${injuryCategoryValues}",
      "severity": <number between 0.0 and 1.0>,
      "decayPerPage": <number between 0.0 and 1.0>
    }
  ]
}`, 4)}`;

const NEW_PLACE_SHAPE = `{\n${indentLines(`\
  "placeId": "<new_place_id>",
  "parentPlaceId": "Optional. <parent_place_id>",
  "knownName": "...",
  "realName": "...",
  "type": "...",
  "category": "${canonicalPlaceTypeValues}",
  "context": "...",
  "familiarity": <number between 0.0 and 1.0>,
  "isRealNameKnown": <boolean>,
  "hints": ["..."],
  "keyEvents": ["..."],
  "keyObjects": [
    {
      "name": "...",
      "traits": [
        "...: ..."
      ],
      "amount": <number>,
      "where": "..."
    }
  ],
  "traits": [
    "...: ..."
  ],
  "knownCharacters": [
    "<character_id>: <Context or interaction>"
  ]
}`, 4)}`;

const NEW_THREAD_SHAPE = `{\n${indentLines(`\
  "threadId": "<new_thread_id>",
  "title": "...",
  "question": "...",
  "priority": "${threadPriorityValues}",
  "truth": "${threadTruthValues}",
  "importance": <number between 0.0 and 1.0>,
  "summary": "...",
  "clues": [
    { "clue": "...", "isFalse": <boolean> }
  ]
}`, 4)}`;

const NEW_FUTURE_NOTE_SHAPE = `{\n${indentLines(`\
  "note": "...",
  "isMajor": <boolean>,
  "tag": "${factTypeValues}",
  "schedule": [
    { "type": "phase", "phase": "${phaseValues}" },
    { "type": "page", "range": "<min>-<max>" },
    { "type": "day", "day": <integer> },
    { "type": "date", "date": "YYYY-MM-DD" }
  ],
  "stateTrigger": [
    { "type": "stability", "level": "${stabilityLevelValues}" },
    { "type": "condition", "condition": "${healthConditionValues}" },
    { "type": "healthPercent", "threshold": <0-100> },
    { "type": "mobilityPercent", "threshold": <0-100> },
    { "type": "actionPercent", "threshold": <0-100> },
    { "type": "mentalPercent", "threshold": <0-100> }
  ],
  "relatedThreadId": "<thread_id> or 'none'"
}`, 4)}`;

const NEW_PLANNED_CHARACTER_SHAPE = `{\n${indentLines(`\
  "characterId": "<unique_id>",
  "knownName": "...",
  "realName": "...",
  "gender": "${genderValues}",
  "role": "...",
  "bio": "...",
  "appearance": "...",
  "importance": "${characterImportanceValues}",
  "storyPurpose": "...",
  "plannedIntro": "..."
}`, 4)}`;

const firstBookOutputFormat: string = `{
  "title": "Book Title",
  "alternativeTitles": ["Alternative Title", "..."],
  "totalPages": <integer between ${BOOK_MIN_PAGES} and ${BOOK_MAX_PAGES}>,
  "language": "<ISO 639-1 code>",
  "hook": "...",
  "summary": "...",
  "keywords": ["mood-tag", "theme-tag", "..."],
  "mainCharacter": {
    "name": "Full Name. A rare name, yet consistent with the detected language.",
    "knownName": "Preferred alias or nick",
    "age": <integer between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}>,
    "gender": "'male' OR 'female'",
    "bio": "Trait-forward description in detected language. Include at least one psychological vulnerability."
  },
  "firstPage": {
    "text": "...",
    "mood": "${moodValues}",
    "weather": "${weatherValues}",
    "calendarDate": "<yyyy-MM-dd>",
    "timeOfDay": "e.g., 'night', 'HH:mm', '2 AM', 'unknown', time range",
    "sceneType": "${sceneTypeValues}",
    "charactersPresent": [
      {
        "characterId": "<character_id>",
        "sceneRole": "${sceneRoleValues}",
        "sceneFocus": <number between 0.0 and 1.0>
      }
    ],
    "momentum": "${momentumValues}",
    "keyEvents": ["..."],
    "keyObjects": ["..."],
    "actions": [
      {
        "text": "First-person action or dialogue",
        "type": "${actionTypeValues}",
        "hint": {
          "text": "Subtle implication of consequence",
          "type": "${hintTypeValues}"
        }
      }
    ]
  },
  "initialState": {
    "flags": {
      "trust": "${flagLevelValues}",
      "fear": "${flagLevelValues}",
      "guilt": "${flagLevelValues}",
      "curiosity": "${flagLevelValues}"
    },
    "memoryIntegrity": "${memoryIntegrityValues}",
    "difficulty": "${difficultyValues}",
    "traumaTags": ["..."],
    "plotFlags": [
      {
        "fact": "...",
        "type": "${plotFlagTypeValues}",
        "isMajorEvent": <boolean>
      }
    ],
    "inventory": [
      {
        "name": "...",
        "traits": [
          "...: ..."
        ],
        "amount": <number>,
        "where": "..."
      }
    ],
    "injuries": [
      {
        "bodyPart": "...",
        "description": "...",
        "consequences": "...",
        "category": "${injuryCategoryValues}",
        "severity": <number between 0.0 and 1.0>,
        "decayPerPage": <number between 0.0 and 1.0>
      }
    ]
  },
  "initialThreads": [
    ${NEW_THREAD_SHAPE}
  ],
  "viableEnding": {
    "text": "Specific ending plan for this MC and theme (${VIABLE_ENDING_LENGTH})",
    "type": "${endingTypeValues}",
    "outline": ["...", "..."]
  },
  "futureNotes": [
    ${NEW_FUTURE_NOTE_SHAPE}
  ],
  "initialPlace": ${NEW_PLACE_SHAPE},
  "initialCharacters": [
    ${NEW_CHARACTER_SHAPE}
  ],
  "plannedCharacters": [
    ${NEW_PLANNED_CHARACTER_SHAPE}
  ],
  "initialRelationships": [
    {
      "sourceId": "<character_id_1>",
      "targetId": "<character_id_2>",
      "type": "${relationshipTypeValues}",
      "status": "${relationshipStatusValues}",
      "context": "Define relationship context",
      "recognitionLevel": "${recognitionLevelValues}"
    }
  ],
  "initialFacts": [
    {
      "key": "fact.key",
      "value": "Fact Value",
      "type": "${factTypeValues}",
      "reason": "Reason for the fact"
    }
  ],
  "aiFinalComment": "..."
}`;

const buildFirstBookReviewChecklist = (language: string): string => {
  const formattedLanguage = formatLanguage(language);
  const isNonEnglish = !!language && language !== 'en';

  return `${isNonEnglish ? `0. Language & Localization Lock (CRITICAL)
  □ COMMITMENT: "I will generate all user-facing story text, metadata, and choices exclusively in ${formattedLanguage} language."
  □ Are my thoughts, evaluations, and subsequent outputs shifting to match the native grammar, idioms, and cultural context of ${formattedLanguage}? → If NO: Pivot immediately. Do not use English syntax.` : ''}

1. Theme & MC Fit
  □ Does the MC's specific bio make this theme more dangerous for them personally? → If NO: Adjust bio or infer a better-fit character.
  □ Is the psychological vulnerability in the bio something that will actually be used against them in this scene? → If NO: Make it more specific and weaponize it.

2. Opening Disturbance
  □ Does page 1 open mid-moment (bypassing introduction or slow scene-setting)? → If NO: Rewrite the opening to drop the reader directly into the action.
  □ Is something subtly wrong by the end of the first paragraph? → If NO: Inject a subtle, unsettling detail immediately.
  □ Does the page end on tension or uncertainty — not resolution? → If YES to resolution: Cut the resolution. Always withhold safety.
  □ Is the mood field reflecting the disturbance specifically — not just the genre? → If NO: Reassign a sharper mood.
  □ Are there long, blocky paragraphs? → If YES: Break them up. Use short sentences and fragments to create rhythm and suspense.

3. Metadata Quality
  □ Is the title generic (e.g., "The Dark Secret", "Shadow House")? → If YES: Rework. It must feel highly specific and ominous to this exact story.
  □ Does the hook create intrigue without spoiling the ending type? → If NO: Obscure the trajectory. Raise questions, don't provide answers.
  □ Are keywords mood/theme-specific rather than pure genre tags? → If NO: Replace generic tags with granular, visceral ones.
  □ Is the MC's name consistent across the title, summary, and hook? → If NO: Revise to ensure absolute consistency.

4. Action Diversity (The Illusion of Choice)
  □ Are the actions meaningfully distinct in risk and emotional register? → If NO: Revise until they vary drastically (e.g., reckless / cautious / emotional / avoidant).
  □ Could any two actions lead to the same implied consequence? → If YES: Differentiate them. Never give the reader overlapping choices.
  □ Does at least one action feel subtly wrong, dangerous, or inadvisable? → If NO: Add a "trap" choice that tempts the reader into danger.

5. Character & Place Integrity
  □ Do the characters present in this scene EXACTLY match the provided character data? → If NO: Align them. Do not hallucinate new characters.
  □ Does at least one character have a relationship status that can corrode or betray the MC? → If NO: Adjust their bio to introduce a hidden psychological betrayal vector.
  □ Is the place context evocative (sensory atmosphere) rather than purely descriptive (flat facts)? → If NO: Rewrite to focus on the weight, smell, and dread of the room.

6. Initial State Calibration
  □ Are the psychological flags set based strictly on the events of THIS page — not generic defaults? → If NO: Reassign them to reflect the immediate trauma.
  □ Is the viableEnding hyper-specific to this MC's vulnerabilities and theme? → If YES to a generic genre template: Rewrite it to be deeply personal and inescapable.
  □ Does the difficulty strictly reflect how hostile this world is to this specific MC right now? → If NO: Adjust it based on the current momentum.

7. JSON Integrity
  □ All fields present and populated? → If NO: Complete missing fields.
  □ Every opened bracket '{' or '[' is closed correctly? → If NO: Fix or complete.
  □ No trailing commas? → Fix any.
  □ age is a number, not a range string? → Fix if needed.
  □ familiarity is a decimal between 0.0 and 1.0? → Fix if needed.
  □ totalPages within ${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} bounds? → Fix if out of range.`.trim();
}

const nextPageOutputFormat: string = `{
  "text": "...",
  "mood": "${moodValues}",
  "placeId": "<place_id>",
  "weather": "${weatherValues}",
  "calendarDate": "<yyyy-MM-dd>",
  "timeOfDay": "...",
  "minutesPassed": <number>,
  "sceneType": "${sceneTypeValues}",
  "charactersPresent": [
    {
      "characterId": "<character_id>",
      "sceneRole": "${sceneRoleValues}",
      "sceneFocus": <number between 0.0 and 1.0>
    }
  ],
  "keyEvents": [],
  "keyObjects": [],
  "traumaTagAdd": [],
  "traumaTagRemove": [],
  "addPlotFlags": [{
    "fact": "...",
    "type": "${plotFlagTypeValues}",
    "isMajorEvent": <boolean>
  }],
  "inventory": [
    {
      "name": "...",
      "traits": [
        "...: ..."
      ],
      "amount": <number>,
      "where": "...",
      "pageAcquired": <number>
    }
  ],
  "injuries": [
    {
      "bodyPart": "...",
      "description": "...",
      "consequences": "...",
      "category": "${injuryCategoryValues}",
      "severity": <number between 0.0 and 1.0>,
      "decayPerPage": <number between 0.0 and 1.0>,
      "pageAcquired": <number>
    }
  ],
  "contextHistory": "...",
  "futureNoteAdd": [
    ${NEW_FUTURE_NOTE_SHAPE}
  ],
  "futureNoteRemove": [<key>],
  "addPlannedCharacters": [
    ${NEW_PLANNED_CHARACTER_SHAPE}
  ],
  "factUpdates": [
    {
      "key": <new or existing key>,
      "value": "...",
      "page": <number>,
      "type": "${factTypeValues}",
      "reason": "..."
    }
  ],
  "flagUpdates": [
    {
      "type": "${psychologicalFlagTypeValues}",
      "level": "${flagLevelValues}"
    }
  ],
  "actions": [
    {
      "text": "First-person action or dialogue",
      "type": "${actionTypeValues}",
      "hint": {
        "text": "Subtle implication of consequence",
        "type": "${hintTypeValues}"
      }
    }
  ],
  "newCharacters": [
    ${NEW_CHARACTER_SHAPE}
  ],
  "updatedCharacters": [
    {
      "characterId": "<character_id>",
      "knownName": "...",
      "recognitionLevel": "${recognitionLevelValues}",
      "gender": "${genderValues}",
      "role": "...",
      "bio": "...",
      "appearance": "...",
      "status": "${characterStatusValues}",
      "secrets": ["..."],
      "importance": "${characterImportanceValues}",
      "relationshipToMC": {
        "type": "${relationshipTypeValues}",
        "status": "${relationshipStatusValues}",
        "context": "...",
        "recognitionLevel": "${recognitionLevelValues}"
      },
      "newInteractions": ["..."],
      "potentialTwist": "${twistTypeValues}",
      "updateSchedules": [
        {
          "placeId": "<place_id>",
          "availabilityWindow": "...",
          "missedConsequence": "..."
        }
      ],
      "removeSchedules": ["<place_id>"],
      "updateTraits": [
        "...: ..."
      ],
      "removeTraits": [],
      "injuries": []
    }
  ],
  "relationshipUpdates": [
    {
      "sourceId": "<character_id_1>",
      "targetId": "<character_id_2>",
      "type": "${relationshipTypeValues}",
      "status": "${relationshipStatusValues}",
      "context": "Define relationship context",
      "recognitionLevel": "${recognitionLevelValues}"
    }
  ],
  "newPlaces": [
    ${NEW_PLACE_SHAPE}
  ],
  "updatedPlaces": [
    {
      "placeId": "<place_id>",
      "knownName": "...",
      "type": "...",
      "category": "${canonicalPlaceTypeValues}",
      "context": "...",
      "familiarityCorrection": <number between -0.5 to 0.5>,
      "isRealNameKnown": <boolean>,
      "addKeyEvents": ["..."],
      "addHints": [],
      "removeHints": [],
      "updateTraits": [
        "...: ..."
      ],
      "removeTraits": [],
      "knownCharacters": [
        "<character_id>: <Context or interaction>"
      ]
    }
  ],
  "placeConnections": [
    {
      "sourceId": "<place_id_1>",
      "targetId": "<place_id_2>",
      "travelTime": "...",
      "routeType": "...",
      "accessibility": "${accessibilityValues}",
      "addObstacles": [],
      "removeObstacles": [],
      "bidirectional": <boolean>,
      "notes": "..."
    }
  ],
  "newThreads": [
    ${NEW_THREAD_SHAPE}
  ],
  "updateThreads": [
    {
      "threadId": "<thread_id>",
      "status": "${threadStatusValues}",
      "priority": "${threadPriorityValues}",
      "truth": "${threadTruthValues}",
      "importance": <number between 0.0 and 1.0>,
      "urgencyCorrection": <number between -0.5 and 0.5>,
      "summary": "...",
      "resolution": "..."
    }
  ],
  "addClues": [
    {
      "threadId": "<thread_id>",
      "clue": "...",
      "isFalse": <boolean>
    }
  ],
  "closeThreads": [],
  "viableEnding": {
    "text": "...",
    "type": "${endingTypeValues}",
    "outline": [
      {
        "text": "...",
        "isDone": <boolean>,
        "doneAtPage": <number>
      }
    ],
    "changeReason": "...",
    "changeViabilityBefore": <number between 0.0 and 1.0>,
    "changeViabilityAfter": <number between 0.0 and 1.0>
  },
  "branchNames": ["...", "...", "..."]
}`;

const multiNextPageOutputFormat: string = `{
  "generatedPages": [
    ${indentLines(nextPageOutputFormat, 4)},
    ${indentLines(nextPageOutputFormat, 4)}
  ],
  "output": "..."
}`;

function buildNextPagePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, candidateCount, book } = params;
  const { isFinale, isLastPage } = getStoryStateInfo(state);
  const { language } = book;

  return [
    `TASK: ${formatNextPageTaskPrompt(state, candidateCount, language, book.mode)}`,
    formatNextPageStoryContextPrompt(params),
    formatNextPageNarrativePrompt(params),
    state.plannedCharacters?.length && RULES_PLANNED_CHARACTERS,
    isLastPage && `BRANCHING ACTIONS:\n${getActionRulesText({ isFinale, mode: book.mode })}`
  ].filter(Boolean).join(`\n\n---\n`);
}

function buildNextPageFieldInstructions(state: StoryState, action: Action, sceneType: SceneType = 'transition'): string {
  const { traumaTags, futureNotes } = state;
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale, isLastPage, charactersSlot, placesSlot, phase } = getStoryStateInfo(state);
  const isDialogueAction = action.type === 'dialogue';

  return `text
  - Use "I". Never refer to the MC as "the protagonist" or "the narrator".
  - Continue seamlessly from the previous page.${sceneType === 'transition' ? '' : ` No time skip. No location jump. No off-screen actions.`}
  - ${isDialogueAction ? `It's a dialogue action, so begin directly with "[dialogue]."` : `Begin immediately with the chosen action. Example: "I [verb]." or any necessary causal steps.`}
  - Open mid-moment, but maintain causal continuity. Avoid recap or unnecessary setup.
  - This is a fast-paced story, don't over explain small details (e.g. clothing, accessories) unless they're plot important.
${isEarlyPhase ? `  - Tone: unsettling, not terrifying. Something is wrong — but not yet catastrophic.` : ''}
${isMidPhase ? `  - Tone: escalating. Dread should feel earned and personal by now.` : ''}
${isLatePhase ? `  - Tone: fracturing. Reality and relationships should feel increasingly unstable.` : ''}
${isFinale ? `  - Tone: collapse. This is the point of no return. Write accordingly.` : ''}

mood
  - Reflect the dominant emotional atmosphere of this specific page, not the genre generally.
${isFinale ? `  - Mood should feel terminal — no neutrality, no ambiguity in register.` : ''}

placeId
  - Use same place ID if the MC hasn't moved.
  - Use "unknown" only if location is genuinely ambiguous to the MC.
${isLatePhase || isFinale ? `  - Familiar places should feel subtly wrong now — same name, different atmosphere.` : ''}

weather
  - Keep consistent with recent pages unless enough time has passed or the scene has moved somewhere conditions would plausibly differ.
  - Omit if not narratively relevant to this page.
${isLatePhase || isFinale ? `  - A sudden shift can heighten dread — but don't reuse it as a cheap scare every page.` : ''}

calendarDate:
  - Increment if the day has changed.
  - Use 'yyyy-MM-dd' format (e.g., "2026-07-26").

timeOfDay
  - Any string: "2 AM", "dusk", "HH:mm", time range, or "unknown".
  - Must be consistent with previous page unless a transition is written into the text.

minutesPassed
  - Realistic in-world minutes that pass during this page's events.
  - Omit if the exact duration is ambiguous or unimportant (system will estimate from scene type).
  - Use precise values when time is narratively significant (e.g., a 3-minute countdown, 45-minute interrogation).
  - Values under 1 can indicate seconds (0.5 ≈ 30 seconds). Values over 120 imply multiple hours.

sceneType
  - Select the single dominant narrative function of the page.
  - Analyze user's selected action to either maintain previous scene type or transition to a new, logical scene type.
  - Choose the scene type that best represents the page's primary narrative purpose, not merely its setting, mood, or individual actions.
  - If multiple scene types apply, choose the most important narrative function.
  - Use "transition" only when no stronger narrative function dominates the page.

charactersPresent
  - Side characters physically present in the scene besides MC.
  - Only side characters, exclude MC. MC is central POV and always on the scene.
  - Do not include characters who are only mentioned, remembered, referenced, contacted remotely, or discussed.
  - Every ID must match an existing known character${isFinale ? `.
  - Keep the cast minimal. Finale scenes should feel claustrophobic, not populated.`
: ` or a character introduced in newCharacters on this page.`}
  - sceneRole: ${sceneRoleValues}
  - sceneFocus: between 0.0 to 1.0. Relative narrative importance in the current scene (highest = character to focus).

keyEvents
  - ${KEY_EVENT_LENGTH}. Plot-level facts only — what objectively happened (situation/exact hard facts).
${isLatePhase || isFinale ? `  - At least one event should connect to or resolve a thread opened earlier in the story.` : ''}

keyObjects
  - Objects introduced or used this page that may have future narrative significance.
${isEarlyPhase ? `  - Seed freely — early objects pay off later. Introduce them without drawing attention.` : ''}
${isMidPhase ? `  - Only include objects with clear narrative weight. No new red herrings.` : ''}
${isLatePhase || isFinale ? `  - Reuse established objects only. No new ones unless absolutely necessary.` : ''}

inventory
  - Items currently in MC's possession. Can include the amount, traits, and where it currently located.
  - Max ${MAX_INVENTORY_ITEM} different items. Only include that actually matters to the plot.
  - To remove an item, explicitly set its amount to 0 (system will auto-remove).
  - If no changes, output empty array or omit this field entirely.
  - Otherwise, MUST include all current items with updated values and/or new item if any.

injuries
  - Injuries are auto-decaying, ONLY update when character takes action that treats/worsens injury.
  - If an action is taken to heal, or anything made injury worse, update the injury severity and description accordingly.
  - If healed, set severity to 0 (system will auto-remove fully healed injuries).
  - If healed but leaves permanent scar/story relevance, move to character's appearance.
  - If no meaningful injury-related action occurs, output empty array or omit this field entirely.
  - Otherwise, MUST include all previous injuries with updated values and/or new injury if any.
  - consequences: update any that affect the storyline (e.g. "Can't run fast, can't lift heavy objects").

traumaTagAdd / traumaTagRemove
  - Short evocative phrases for experiences that will haunt the MC later.
${traumaTags.length < MAX_TRAUMA_TAGS ? `  - Only add if something genuinely traumatic or psychologically significant occurs.` : `  - Maximum trauma tags reached. Can't add more.`}
  - Remove when trauma is resolved.
${isEarlyPhase ? `  - Max 1 per page. Plant sparingly — early trauma tags shape everything downstream.` : `  - Max 2 per page. Omit if none.`}
${isFinale ? `  - Existing trauma tags should be echoing and surfacing now, not new ones being added.` : ''}

futureNoteAdd / futureNoteRemove
${futureNotes.length < MAX_FUTURE_NOTES ? `  - ONLY add for important unresolved clues, revelations, promises, relationships, mysteries, or future developments which matter later.
  - Do NOT add for temporary details, completed events, or facts already captured by plot flags.
  - Prefer advancing existing future notes before creating new ones. Avoid duplicate or overlapping future notes.` : ''}
  - Future notes represent narrative obligations, not immediate requirements. Do not resolve a future note merely because it exists.
  - Remove notes which have been fulfilled or become irrelevant.
  - If fulfilling a future note materially changes the story, record the outcome as a plot flag.
  - Keep max ${MAX_FUTURE_NOTES} items. Only the most important unresolved future notes.

addPlannedCharacters
${!isLatePhase && charactersSlot > 0 ? `  - Add new planned character candidates for future introduction when the story needs fresh faces for upcoming beats.
  - This is for characters not yet on-page — they're seeds for future pages. Use newCharacters instead if the new character is physically present on this page.
  - Each must have a distinct characterId. Avoid generic or throwaway plans.
  - storyPurpose: why this character exists and what role they'll play.
  - plannedIntro: brief hook describing how/when they might first appear.`
: `  - Do not add new planned characters. ${isLatePhase ? 'Phase is too late for meaningful future introductions.' : `${MAX_CHARACTERS} characters limit reached.`}`}

factUpdates
  - Represents long-term story memory, discoveries, or important established facts that influence future turns.
  - key: consistent ${FACT_KEY_FORMAT}. Type can be either: ${formatOneOf(Object.keys(factTypes))}.
  - value: latest known state. Prefer concise value over long sentence (explanation can be added in reason).
  - reason: 1-sentence, why or how it hapenned or changed.
  - Facts should be objectively true within the story after this page ends.
  - Do NOT record every event that happened on the page.
  - Don't duplicate: reuse existing keys whenever updating the same fact (only meaningful change).
  - ONLY include facts that meet at least one of these criteria (if unsure, omit it):
    → Permanently change the story world.
    → Reveal important information to remember 20+ pages later.
    → Change a character's status, goal, relationship, possession, or knowledge.
    → Establish a mystery clue, suspect, or revelation.

addPlotFlags
  - Add ONLY for crucial story developments that impact narrative trajectory and become established canon (max 2 per page).
  - Do NOT add for temporary actions, routine events, minor clues, short-lived details, or if no lasting story state changed.
  - Use for major revelations, death, betrayal, irreversible decisions, or major shifts in story direction.
  - fact: describe the newly established story fact clearly and specifically (subject + verb + object).
  - isMajorEvent: true only for irreversible events or major turning points with lasting consequences.
  - Major-event pacing:
    → Review recent major events before introducing a new major event.
    → If multiple major events occurred recently, prefer fallout, consequences, investigation, tension, or character reactions before introducing another major event.
    → Do NOT create major events solely to escalate the plot.
  - Expected distribution:
    → Most pages: 0-1 plot flags.
    → Major turning points: up to 2 plot flags.

contextHistory
  - Running summary from page 1 until now — key plot developments, hard facts, major events.
  - Incorporate the overall story context while keeping all essential narrative elements.
  - Single paragraph or bullet points (max ${MAX_WORDS_SUMMARIZED_CONTEXT} words).
  - Write in 3rd person POV.
  - Maintain the continuity of the story.

flagUpdates
  - Only include flags that changed this page. Omit unchanged flags entirely.
  - Base changes on what actually happened in the scene.
${isEarlyPhase ? `  - Changes should be subtle — small shifts, not dramatic swings.` : ''}
${isLatePhase || isFinale ? `  - Flags should reflect escalation. Fear and guilt especially should be peaking.` : ''}

actions
${isLastPage ? `  - This is the last page, just provide a single action that concludes the story.` : `  - text: first-person action or dialogue (${ACTION_TEXT_LENGTH}). No subject ("I"). Directly begin with verb (e.g. Pretend not to hear) or saying (e.g. "Yes, of course.").
  - hint.text: what will happen as a consequence — written as a story beat, not a label. Invisible to the player.
  - ${isFinale ? `Max ${MAX_ACTION_CHOICES_FINALE} choices — the story is closing in.` : `${MIN_ACTION_CHOICES}-${MAX_ACTION_CHOICES} choices.`} Each must be meaningfully distinct.
  - Vary across: reckless / cautious / emotional / avoidant.
  - ${isLatePhase ? `Each action text should be distinct despite similar outcomes` : `Each action text should be distinct and convey unique consequences.`}
  - At least one should feel subtly wrong or inadvisable.
${isEarlyPhase ? `  - Choices should feel open and curious — stakes are present but not yet dire.` : ''}
${isMidPhase ? `  - Choices should reflect the player's established decision patterns. Make the trap feel tailored.` : ''}
${isLatePhase ? `  - Every choice should carry visible weight. No option should feel consequence-free.` : ''}
${isFinale ? `  - Both choices should feel like loss. The difference is only in what kind.` : ''}`}

branchNames
  - Suggest 3 creative, distinct names for this page as a timeline/branch — evocative, spoiler-free (e.g., "The Locked Door", "Trust No One").
  - Always suggest regardless of whether this page's actions actually fork the story — the system decides whether a name is used.

newCharacters/updatedCharacters
${charactersSlot === 0 ? `  - Can't introduce new characters (${MAX_CHARACTERS} limit). Update existing ones only.`
: isEarlyPhase ? `  - New characters welcome up to ${charactersSlot} more — establish the cast now.`
: isMidPhase ? `  - Optionally introduce up to ${charactersSlot} new characters only if genuinely necessary. Prefer deepening existing ones.`
: `  - No new characters. Cast is fixed. Late arrivals dilute stakes.`}
${isLatePhase || isFinale
? `  - Expect significant status/flag changes now. Characters should be fracturing or revealing.`
: `  - Only update characters whose state actually changed this page.`}
  - For new characters: incorporate appearance naturally in storytelling.
  - For updates: only include changed fields, omit unaltered ones.
  - knownName: mandatory narration alias. Gradually update as MC learns real identity.
  - bio: concise, suggestive. Gradually update when new info revealed.
  - appearance: visual description. Only update if meaningfully changed (e.g., permanent injury).
  - recognitionLevel: how well MC recognizes this character.
  - status: ${formatOneOf(characterStatuses)}
  - importance: ${formatOneOf(characterImportances)}
  - relationshipToMC: based on interaction and story progression.
  - potentialTwist: adjust to reflect plot developments.
  - secrets: spoiler/hints (new) or remove revealed ones (update).
  - traits: only story-relevant. Remove or update.
  - injuries: add or update. Set severity to zero to remove.
  - pastInteractions (new): dialogue or event towards MC in current page.
  - newInteractions (update): interactions since last page.
  - relationships (new only): include known relationships to other named characters. Omit if none.

relationshipUpdates
  - Changes in relationship between any two named characters (excluding MC).
  - Omit if no relationships shifted this page.
${isEarlyPhase ? `  - Subtle shifts only — early relationships should feel ambiguous, not defined.` : ''}
${isLatePhase || isFinale ? `  - Relationships should be breaking, inverting, or crystallizing. No more ambiguity.` : ''}

newPlaces/updatedPlaces
${placesSlot === 0 ? `  - Can't introduce new places (${MAX_PLACES} limit). Update existing ones only.`
: isEarlyPhase || isMidPhase ? `  - You can introduce up to ${placesSlot} new meaningful places the MC enters for the first time — no generic one-offs.
  - knownName: should fit in-world cultural setting.
  - context: ${PLACE_CONTEXT_LENGTH}. Evocative over descriptive.
  - hints: known clues, obstacles, spatial relationships. Must be consistent to build a "world map."
  - category: Choose the closest match: ${formatOneOf(canonicalPlaceTypes)}.
  - familiarity: start at 0.0-0.2 unless MC has prior history.
  - traits: include relevant info (e.g., smell, sound, visual, feeling).
  - knownCharacters: include relevant characters (beside MC) with meaningful context.
  - keyEvents: any important event happening in the scene.
  - keyObjects: any important objects to remember.
  - Might need to update other places' hints to link with this new place.`
: `  - No new places. If MC is somewhere new, question whether it's necessary.`}
  - For updates: only on revisit or significant event. Include only changed fields.
  - familiarityCorrection: always 0 except on major condition:
    → place changes drastically, or fundamentally changes how MC understands it.
    → learns hidden functions/secrets, discovers new areas, gains deeper understanding.
    → memory loss/confusion, familiar assumptions proven false, environment unrecognizable.
    → Do NOT use for ordinary visits, repeated exposure, or gradual learning (handled automatically).
${isLatePhase || isFinale ? `  - High-familiarity places revisited now should feel distorted.` : ''}

placeConnections
  - Add new if visiting/adding a new place or when a place is first connected.
  - Only update existing if route conditions meaningfully change on revisit.
  - travelTime: travel duration (e.g., "5 minutes walk", "20 minutes drive").
  - routeType: route description (e.g., "main street", "alley", "tunnel").
  - accessibility: ${accessibilityValues}.
  - addObstacles/removeObstacles: story-relevant barriers, hazards, or access requirements.
  - notes: short route details not covered elsewhere.

${!isFinale ? `newThreads (see ACTIVE THREADS for whether a new thread is warranted this page)
  - title: Short, evocative name for the mystery (e.g., "Lisa's Identity", "The River Incident")
  - question: central mystery question (e.g., "Who is Lisa really?", "What happened at the river that night?")
  - priority: "main" for central mysteries, "secondary" for supporting mysteries, "minor" for background details
  - truth: "true" if the thread leads to genuine revelation, "false" if it's a deliberate misdirection, "unknown" if ambiguous
  - importance: 0.0-1.0 (how frequently this thread should appear in the narrative)` : ''}

updateThreads
  - Update existing threads when their status, priority, or urgency meaningfully changes.
  - threadId: must match an existing thread ID.
  - status: ${isLatePhase ? 'update to "revealed" or "closed" as threads converge toward the ending.' : '"open" (newly introduced), "developing" (active investigation), "revealed" (truth partially shown), "closed" (resolved).'}
  - urgencyCorrection: explicit closeness adjustment to a reveal/twist/resolution (e.g., +0.20 = major breakthrough, -0.15 = mystery became more complicated). Do not use for normal progression, new clues, or routine thread development. The system already handles those automatically.
  - summary: running summary of thread development (from the start to current).
  - resolution: only include when thread is being closed or resolved (brief summary of the answer).
  - If this page develops, complicates, advances, or revisits an active thread, include a summary update for that thread.
${isFinale ? `  - Every main thread must be resolved (status: "closed" with resolution text).` : ''}

addClues
${isEarlyPhase || isMidPhase ? `  - Add clues to existing threads to advance mysteries.
  - threadId: must match an existing thread ID.
  - clue: short, evocative clue that advances the mystery (e.g., "She knows my mother", "Flashbacks of water").
  - isFalse: set to true if this is a deliberate misdirection (false clue).` : ''}
${isLatePhase ? `  - Add revealing clues that push threads toward resolution.` : ''}
${isFinale ? `  - Add final clues that complete thread resolutions.` : ''}

${isLatePhase ? 'closeThreads' : ''}
${isLatePhase ? `  - Close threads that have been fully resolved or are no longer relevant.
  - Include thread IDs that should be marked as closed (resolution should be in updateThreads.resolution)` : ''}
${isFinale ? `  - All remaining threads must be closed in the finale.` : ''}

viableEnding
  - Don't output viableEnding if unchanged
  - Only output if story trajectory has meaningfully shifted and the previously planned ending no longer fits, or if outline should be updated.
${futureNotes.length ? `  - Ensure it supports or aligns with future notes` : ''}
  - text: Summary of the desired doom (${VIABLE_ENDING_LENGTH}). Specific to this MC and theme — not a genre template.
  - outline: A roadmap to reach the ending. 1-2 sentence per item. Align done count with current ${phase} phase. Don't change what have been done, only adjust what haven't done.
${isEarlyPhase ? `  - Rarely needed this early. Only revise if the theme has fundamentally diverged from the original plan.` : ''}
${isMidPhase ? `  - Revise if a major twist has made the original ending implausible or redundant.` : ''}
${isLatePhase ? `  - Should be stable now. Revise only if a late revelation makes the ending genuinely unreachable.` : ''}
${isFinale ? `  - Do not revise. The ending is now in motion — execute it.` : ''}`;
}

function buildNextPageReviewChecklist(state: StoryState, language: string): string {
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale } = getStoryStateInfo(state);
  const formattedLanguage = formatLanguage(language);
  const isNonEnglish = !!language && language !== 'en';

  return `${isNonEnglish ? `0. Language & Localization Lock (CRITICAL)
  □ COMMITMENT: "I will generate all user-facing story text, metadata, and choices exclusively in ${formattedLanguage} language."
  □ Are my thoughts, evaluations, and subsequent outputs shifting to match the native grammar, idioms, and cultural context of ${formattedLanguage}? → If NO: Pivot immediately. Do not use English syntax.` : ''}

1. Spoiler & Mystery Control
  □ Revealing the core truth or viable ending too early? → Obscure first. Misdirect second. Fragment only as last resort.
  □ Major mystery resolved too cleanly? → Inject doubt, contradiction, or reframe the resolution as a new question.
  ${isEarlyPhase || isMidPhase ? `□ Opening new mysteries faster than existing ones develop? → Pause new threads. Deepen one existing thread first.` : ''}
  ${isMidPhase ? `□ Open threads accumulating without movement? → Collapse or meaningfully advance at least one this page.` : ''}
  ${isLatePhase || isFinale ? `□ New mystery introduced this page? → Remove it. Late pages seed nothing new.` : ''}
  ${isLatePhase || isFinale ? `□ Page progressing toward the viable ending? → If NO: steer events, character decisions, or tone toward it now.` : ''}

2. Tension & Pacing
  □ Tone and events reflect current psychological flags? → If NO: adjust intensity (fear high → distorted perception, guilt high → intrusive echoes).
  □ Emotional contrast with the previous page? → If NO: shift register (panic → silence, chaos → routine, dread → warmth that feels wrong).
  □ Page overloaded with events? → Simplify to one clear movement.
  □ Page too empty — nothing changed? → Add one meaningful change: in perception, relationship, or environment.
  □ Does this page make the reader want to continue? → If NO: add a hook, unanswered question, or atmospheric wrongness they can't name.
  ${isEarlyPhase ? `□ Escalating too fast? → Dial back. Plant unease, not dread. Let the wrongness stay subtle.` : ''}
  ${isMidPhase ? `□ Last 2-3 pages all increased tension linearly? → Introduce relief, false safety, or routine. Pattern: build → release → false safety → escalation.` : ''}
  ${isMidPhase ? `□ Tension flat for too long? → Introduce a disturbance: a behavior shift, a missing object, an unexplained sound.` : ''}
  ${isLatePhase || isFinale ? `□ Any moment of relief or genuine safety this page? → Remove it or immediately corrupt it. Late pages do not offer real rest.` : ''}

3. Continuity & State Integrity
  □ Characters present consistent with story state? → If NO: remove or justify.
  □ Character behaviors consistent with traits, trauma tags, and current flags? → If NO: adjust dialogue or action.
  □ Location, calendarDate, and timeOfDay consistent with previous page? → If NO: fix transition or write the change explicitly.
  □ Referencing objects, places, or events not yet established? → Remove or align with known state.
  □ Important unresolved element from previous page missing? → Reintroduce it${isEarlyPhase ? ' subtly' : ' — more directly now'}.
  □ Movement between locations spatially coherent? → If NO: fix the transition.
  □ Reusing the same environmental descriptions as recent pages? → Vary the sensory angle.

4. Character & Relationship Integrity
  □ Character changed personality without cause? → Justify via stress, fear, or hidden motive — or make the shift feel deliberately uncanny.
  □ Trauma tags influencing perception, behavior, or dialogue? → If NO: reflect them in what the MC notices, misreads, or can't stop thinking about.
  ${isEarlyPhase || isMidPhase ? `□ Relationships evolving — trust shifting, suspicion forming? → If NO: introduce a micro-shift. A hesitation, a withheld word, a look that doesn't match the dialogue.` : ''}
  ${isLatePhase || isFinale ? `□ Character arcs resolving, fracturing, or deliberately left open? → Confirm which — then make it intentional, not accidental.` : ''}

5. Thread & Event Management
  □ This page contributes to a known thread (main or side)? → If NO: connect it to one, or cut the loose content.
  ${isEarlyPhase || isMidPhase ? `□ Too many active threads simultaneously? → Pause or collapse one. Reader tracks ${MAX_ACTIVE_THREADS} comfortably; more creates noise, not tension.` : ''}
  ${isEarlyPhase || isMidPhase ? `□ At least one subtle hint of future consequence? → If NO: add light foreshadowing — symbolic, indirect, deniable.` : ''}
  ${isEarlyPhase || isMidPhase ? `□ Hints too obvious or on-the-nose? → Make them symbolic or indirect. The reader should feel it before they understand it.` : ''}
  ${isLatePhase ? `□ Active threads still open that should be converging? → Begin closing or collapsing them toward the viable ending.` : ''}
  ${isFinale ? `□ Any thread still unresolved with no deliberate ambiguity or resolution text? → Resolve it, shatter it, or make its irresolution feel like the answer.` : ''}
  ${isFinale ? `□ New threads introduced in finale? → Remove all newThreads. Finale must close, not open.` : ''}
  ${isLatePhase ? `□ New threads introduced in late phase? → Only add if absolutely essential to resolve existing threads.` : ''}
  ${isEarlyPhase || isMidPhase ? `□ New thread has compelling question connected to psychological premise? → If NO: strengthen the question or remove the thread.` : ''}

6. Illusion & Reality Distortion
  □ At least one detail subtly misleads or contradicts expectations? → If NO: add one — in behavior, environment, or a word choice that doesn't quite fit.
  □ Narrator perception possibly biased, incomplete, or wrong? → If NO: introduce a misread — of a person, a sound, a silence.
  □ Something feels wrong in a way the reader can't name? → If NO: inject atmospheric unease — a texture, a timing, a behavior off by one degree.
  ${isEarlyPhase || isMidPhase ? `□ Can the reader form a believable but ultimately wrong theory? → If NO: add focused misleading anchors. Too many competing theories → narrow to one convincing false trail.` : ''}
  ${isLatePhase || isFinale ? `□ Is the false reality beginning to crack visibly? → If NO: let one seam show — a memory that contradicts, a character who knows something they shouldn't, a detail the MC only now notices was wrong.` : ''}

7. Prose & Style
  □ Prose immersive and character-specific — not generic AI narration? → If NO: rewrite with sensory grounding and the MC's specific voice and bias.
  □ Sentence structure varied — short fragments, medium, occasional long? → A two-word sentence after a long one lands like a door closing.
  □ Over-explaining instead of implying? → Cut it. If the action implies the feeling, naming the feeling is redundant.
  □ Dialogue natural and specific to this character's voice? → Each character should be recognizable from word choice alone.
  □ Scene physically coherent despite distortion? → Reader can doubt what's real. They should never doubt what physically happened.
  □ Long paragraph exist? → Break up long paragraph into separate lines to create rhythm and suspense.
  □ Does every generated text field uses the specified target language? → If any user-facing field is English while specified language is not, rewrite it.

8. Choice Quality
  □ Page ends at genuine tension or unresolved disturbance — not resolution? → If NO: reposition the final beat.
  □ Choices meaningfully distinct in risk and emotional register? → Vary across: reckless / cautious / emotional / avoidant.
  □ At least one choice feels like a trap? → If NO: add a concealed consequence to the safest-looking option.
  □ All choices appear plausibly reasonable on the surface? → If NO: soften the dangerous framing so the trap isn't visible.
  ${isEarlyPhase ? `□ Choices seed curiosity — not force immediate crisis? → Avoid options that escalate to irreversible stakes too soon.` : ''}
  ${isMidPhase ? `□ Choices reflect the player's established psychological profile? → Options should feel designed for how this player thinks.` : ''}
  ${isLatePhase || isFinale ? `□ Choices feel increasingly constrained — like the story is closing in? → Reduce options or weight every path with consequence. On the finale: there is no good option, only degrees of loss.` : ''}

9. JSON Integrity
  □ All fields present and populated? → If NO: Complete missing fields.
  □ Every opened bracket '{' or '[' is closed correctly? → If NO: Fix or complete.
  □ No trailing commas? → Fix any.`.trim();
}

function buildEvaluatorOuputFormatBlurb(useStringEvaluatorOutput: boolean): string {
  return useStringEvaluatorOutput
    ? 'CRITICAL — the "output" field must be the FULL corrected JSON serialized as a VALID JSON STRING (see "EXPECTED JSON SCHEMA"). Begin with "{" and end exactly with "}" (raw JSON text, properly escaped inside the string).'
    : '';
}

function buildNextPageEvaluatorPrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, candidateCount, book } = params;
  const { isEarlyPhase, isMidPhase, isLatePhase, isFinale, charactersSlot } = getStoryStateInfo(state);
  const { action, sceneType } = actionedPage;
  const { language } = book;
  const formattedLanguage = formatLanguage(language);
  const useStringEvaluatorOutput = params.useStringEvaluatorOutput ?? resolveUseStringEvaluator({ modelSelection: AI_CHAT_MODELS_EVALUATION });

  const outputFormatBlurb = buildEvaluatorOuputFormatBlurb(useStringEvaluatorOutput);

  const outputLine = useStringEvaluatorOutput
    ? '"output": "...", // full corrected JSON as a JSON string: begins with "{", ends with "}"'
    : '"output": { ...reconstructed and corrected JSON ... }';

  const taskPrompt = `TASK: Evaluate a newly generated branching story page from selected action, refine output, and re-evaluate — in that order.

Original task (on previous AI): ${formatNextPageTaskPrompt(state, candidateCount, language, book.mode)}

${formatNextPageStoryContextPrompt(params)}

---
${formatNextPageNarrativePrompt(params)}

---
EXPECTED JSON SCHEMA:
${candidateCount > 1 ? multiNextPageOutputFormat : nextPageOutputFormat}

---
FIELD INSTRUCTIONS:
${buildNextPageFieldInstructions(state, action, sceneType)}`;

  const instructionsPrompt = `INSTRUCTIONS — FOLLOW IN ORDER:

STEP 1 — PARSE & RECONSTRUCT
If the generated JSON is malformed, invalid, or has out-of-bound values: reconstruct using available content and the expected schema. Fill missing required fields from story context. Do not invent content that contradicts established state.

STEP 2 — SCORE (scoreBefore)
Score the original content honestly before any corrections. Do not adjust scores to justify later changes.

STEP 3 — CORRECT
Only rewrite if total scoreBefore < 75, or if any single dimension scores below its threshold.
Follow writing style in "WRITING STYLE:" and "PAGE FORMAT:" rules creatively.
Preserve the original narrative voice and story trajectory. Fix the minimum necessary — do not over-correct.
Do not introduce plot elements not implied by prior context. Do not change characters' names.

STEP 4 — RE-SCORE (scoreAfter)
Score the corrected content. If no corrections were made, scoreAfter = scoreBefore.

---
SCORING RUBRIC:

1. TENSION (0-25) — Threshold: ${isFinale ? 22 : isLatePhase ? 20 : 18}
   Award points for:
   - Escalation that varies direction (build → release → false safety → escalation)
${isEarlyPhase ? `   - Unease that feels ambient and unexplained, not overtly threatening` : ''}
${isMidPhase ? `   - At least one moment of false calm or relief before tension returns` : ''}
${isLatePhase || isFinale ? `   - Relentless pressure with no genuine relief — false safety immediately undercut` : ''}
   - Dread from implication, not direct statement
   Deduct points for:
   - Explicit statements of fear instead of implied unease
   - Tension that deflates without payoff
${isEarlyPhase ? `   - Escalating to catastrophe too soon — early pages should disturb, not devastate` : ''}
${isMidPhase ? `   - Unrelenting escalation with no variation (monotone dread)` : ''}
${isLatePhase || isFinale ? `   - Any moment of genuine comfort or safety that isn't immediately corrupted` : ''}

2. COHERENCE (0-20) — Threshold: 15
   Internal (0-10): Page makes logical sense on its own. No contradictory actions or unwritten scene breaks.
   External (0-10): Matches prior pages — characters, location, calendarDate, timeOfDay, established facts, unresolved threads.
${isLatePhase || isFinale ? `   Note: Reality distortion is intentional — penalize only contradictions not grounded in narrator unreliability.` : ''}

3. STYLE (0-15) — Threshold: 11
   Award points for:
   - Varied sentence length (short fragments + medium + occasional longer)
   - Sensory grounding (sound, silence, shadow, physical sensation)
   - Implication over explanation — actions carry emotional weight
   Deduct points for:
   - Consistent sentence rhythm across the whole page
   - Naming emotions directly (e.g. "she felt terrified")
   - Polished, generic AI narration with no roughness or hesitation
   - Over-exposition or summarizing what just happened
${isFinale ? `   Award bonus if prose feels genuinely destabilized — fragmented, looping, or breaking its own rules.` : ''}

4. PROGRESSION (0-20) — Threshold: 14
   Award points for:
${isEarlyPhase ? `   - A new question raised, a character seeded, or an object introduced with implied significance` : ''}
${isMidPhase ? `   - Plot movement, character shift, or psychological escalation tied to an existing thread` : ''}
${isLatePhase ? `   - At least one open thread visibly converging toward the viable ending` : ''}
${isFinale ? `   - Clear movement toward ending delivery — irreversible change, not setup` : ''}
   - Ending beat creates forward momentum (tension, hook, or unresolved disturbance)
   Deduct points for:
   - Page ends where it began — no change in state, perception, or knowledge
${isLatePhase || isFinale ? `   - New threads opened that have no time to resolve` : ''}

5. ILLUSION & UNRELIABILITY (0-10) — Threshold: ${isLatePhase || isFinale ? 8 : 7}
   Award points for:
   - At least one detail the reader could misread or misinterpret
   - Narrator perception that may be biased, wrong, or incomplete
   - Something that feels off but isn't explained
${isLatePhase || isFinale ? `   - A seam showing in the false reality — a memory that contradicts, a character who knows too much` : ''}
   Deduct points for:
   - Fully reliable narration with no ambiguity
   - Every event confirmed and explained
${isEarlyPhase ? `   - Ambiguity so heavy it's disorienting — early pages need one coherent false trail, not chaos` : ''}

6. CONSISTENCY (0-10) — Threshold: 7
   Award points for:
   - Character behavior matching bio, trauma tags, and current flags
   - No characters present who shouldn't be
   - Relationships evolving consistently with prior interactions
   Deduct points for:
   - Personality shifts without cause or uncanny framing
   - Contradictions with established place or character state
${isFinale ? `   - New characters introduced (automatic deduction — cast is fixed at finale)` : ''}

TOTAL: 100 — Minimum passing score: 75
${isFinale ? `Finale adjustment: scoreBefore < 85 triggers correction. Standards are higher — this is the last impression.` : ''}

---
ACTIONS QUALITY (flag only — not scored):
- Are choices meaningfully distinct in risk and emotional register?
${isEarlyPhase ? `- Do choices feel open and curious — not forcing immediate crisis?` : ''}
${isMidPhase ? `- Do choices reflect the player's established psychological decision patterns?` : ''}
${isLatePhase || isFinale ? `- Do choices feel constrained, weighted, and consequence-heavy with no safe option?` : ''}
- Does at least one choice feel like a trap on closer inspection?
- Do all choices appear plausibly reasonable on the surface?
Flag any choice that fails — include in issues.

---
JSON INTEGRITY CHECKS (flag any violation):
- All user-facing field values using ${formattedLanguage} language consistently
- familiarity is a decimal between 0.0 and 1.0
- charactersPresent IDs exist in "KNOWN CHARACTERS"${isFinale || charactersSlot === 0 ? '' : ` or in newCharacters`}
- All mandatory fields present and filled

---
OUTPUT FORMAT (strict JSON, no extra text):
${outputFormatBlurb}
{
  ${outputLine},
  "scoreBefore": {
    "total": <number>,
    "breakdown": [
      { "dimension": "tension", "score": <number> },
      { "dimension": "coherence", "score": <number> },
      { "dimension": "style", "score": <number> },
      { "dimension": "progression", "score": <number> },
      { "dimension": "illusion", "score": <number> },
      { "dimension": "consistency", "score": <number> }
    ],
    "passed": <boolean>,
    "issues": [{ "dimension": "...", "issue": "...", "suggestion": "..." }]
  },
  "scoreAfter": {
    "total": <number>,
    "breakdown": [
      { "dimension": "tension", "score": <number> },
      { "dimension": "coherence", "score": <number> },
      { "dimension": "style", "score": <number> },
      { "dimension": "progression", "score": <number> },
      { "dimension": "illusion", "score": <number> },
      { "dimension": "consistency", "score": <number> }
    ],
    "passed": <boolean>,
    "fixes": [{ "dimension": "...", "change": "..." }]
  },
  "actionFlags": [{ "actionIndex": <number>, "issue": "..." }],
  "integrityFlags": [{ "field": "...", "issue": "..." }]
}`;

  return [taskPrompt, ...instructionsPrompt.split('---').map(stripEmptyLines)].join('\n\n---\n');
}

/**
 * Note: Book creation threshold is higher than page generation (80 vs 75)
 * a flawed initialization contaminates every page downstream.
 * It is worth fixing more aggressively here.
 */
function buildFirstBookEvaluatorPrompt(params: InitializeBookParams): string {
  const { theme, language, mcCandidate, titleIdea } = params;
  const formattedLanguage = formatLanguage(language);
  const useStringEvaluatorOutput = resolveUseStringEvaluator({ modelSelection: AI_CHAT_MODELS_EVALUATION });

  const outputFormatBlurb = buildEvaluatorOuputFormatBlurb(useStringEvaluatorOutput);

  const outputLine = useStringEvaluatorOutput
    ? '"output": "...", // full corrected JSON as a JSON string: begins with "{", ends with "}"'
    : '"output": { ...reconstructed and corrected JSON }';

  return `TASK: Evaluate a newly generated book initialization, refine it, and re-score — in that order.

---
STORY THEME:
"""
${theme}
"""

TITLE IDEA:
${titleIdea ? `"${titleIdea}"` : 'None'}. If generated title is better, keep it.

MAIN CHARACTER (MC):
${getMainCharacterInfo({mc: mcCandidate}) ?? `Character should be inferred from theme. Keep the generated one if it already fits.`}

EXPECTED JSON SCHEMA:
${firstBookOutputFormat}

FIELD INSTRUCTIONS:
${firstBookFieldInstructions}

LANGUAGE REQUIREMENT:
- MUST output all field values in SAME LANGUAGE as STORY THEME exclusively (detected: ${formatLanguage(language)}).
- Do NOT mix languages.

---
INSTRUCTIONS — FOLLOW IN ORDER:

STEP 1 — PARSE & RECONSTRUCT
If the generated JSON is malformed, invalid, or has out-of-bound values: reconstruct using available content and the expected schema. Fill missing required fields from theme and MC candidate context. Do not invent content that contradicts the theme or candidate.

STEP 2 — SCORE (scoreBefore)
Score the original content honestly before any corrections. Do not adjust scores to justify later changes.

STEP 3 — CORRECT
Only rewrite if total scoreBefore < 80, or if any single dimension scores below its threshold.
Preserve the original creative direction. Fix the minimum necessary — do not over-correct.
Do not introduce plot elements that contradict the theme or MC candidate.

STEP 4 — RE-SCORE (scoreAfter)
Score the corrected content. If no corrections were made, scoreAfter = scoreBefore.

---
SCORING RUBRIC:

1. HOOK QUALITY (0-20) — Threshold: 15
   Award points for:
   - Immediate psychological intrigue — reader wants to know what happens next
   - Tone specific to this theme and MC, not generic thriller voice
   - Something feels wrong or unresolved within the first sentence
   Deduct points for:
   - Generic opener that could apply to any thriller (e.g. "Nothing was ever the same after that night")
   - Summarizing the premise instead of creating intrigue
   - Resolving tension before it builds

2. FIRST PAGE QUALITY (0-25) — Threshold: 19
   Award points for:
   - Opens mid-moment — no scene-setting preamble or character introduction
   - Something subtly wrong is present by the end of the first paragraph
   - Ends on tension, uncertainty, or a soft cliffhanger — not resolution
   - Narrator voice feels personal, slightly unreliable, emotionally immediate
   - Sensory grounding — at least one specific physical detail that anchors the scene
   Deduct points for:
   - Introducing the MC by name and description in the opening lines
   - Explicit statement of the horror or threat too soon
   - Generic AI narration — polished, even, emotionally flat
   - Ending the page on a resolved or comfortable beat

3. MC & CHARACTER FIT (0-15) — Threshold: 11
   Award points for:
   - MC bio contains at least one psychological vulnerability specific to the theme
   - Vulnerability is something that will plausibly be weaponized by the story
   - MC candidate constraints (name, age, gender) respected if provided
   - Initial characters each have one trait that could become a threat or betrayal vector
   - At least one initial character has a relationship to MC that can corrupt
   Deduct points for:
   - Generic bio with no specific vulnerability (e.g. "shy and introverted")
   - MC candidate fields ignored or overridden without cause
   - Characters whose bios are purely descriptive with no implied tension

4. WORLD & SETUP COHERENCE (0-15) — Threshold: 11
   Award points for:
   - Initial place context evocative and specific to the theme — not generic
   - Place familiarity appropriate to MC's established history with it
   - charactersPresent matches characters in initialCharacters exactly
   - timeOfDay and location consistent with the opening scene's mood
   Deduct points for:
   - Generic place descriptions (e.g. "a dark and eerie location")
   - Character IDs in charactersPresent not present in initialCharacters
   - Familiarity value contradicting MC's stated history with the place

5. INITIAL STATE CALIBRATION (0-15) — Threshold: 11
   Award points for:
   - Psychological flags reflect what actually happens — not generic defaults
   - Difficulty appropriate to how hostile the world is to this specific MC
   - viableEnding specific to this MC and theme — not a genre archetype template
   - totalPages within bounds, not multiples of 10, and proportional to theme complexity
   Deduct points for:
   - Flags set to default values (trust: medium, fear: low, curiosity: high) without scene justification
   - viableEnding that could apply to any psychological thriller
   - totalPages are multiples of 10 regardless of theme complexity

6. METADATA QUALITY (0-10) — Threshold: 7
   Award points for:
   - Title feels specific to this story — not a generic thriller title
   - Keywords are mood/theme-specific, not pure genre tags (e.g. "false-memory" not "horror")
   - Summary sets up the premise without revealing the ending type
   - Language code correctly detected from theme input
   Deduct points for:
   - Title that could apply to any thriller (e.g. "The Dark Secret", "Into the Shadow")
   - Keywords that are all genre-level (e.g. ["horror", "thriller", "mystery"])
   - Summary that reveals the viable ending or core twist

TOTAL: 100 — Minimum passing score: 80

---
ACTIONS QUALITY — FIRST PAGE ACTIONS (flag only — not scored):
- Are actions meaningfully distinct in risk and emotional register?
- Do actions feel open and curious — not forcing immediate crisis on page 1?
- Does at least one action feel subtly wrong or inadvisable?
- Do all actions appear plausibly reasonable on the surface?
- Does each action imply a different story direction?
Flag any action that fails — include in issues.

---
JSON INTEGRITY CHECKS (flag any violation):
- All user-facing field values using ${formattedLanguage} language consistently
- totalPages is within ${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} bounds
- MC's age is a number between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}
- familiarity is a decimal between 0.0 and 1.0
- language is a valid ISO 639-1 code
- All mandatory fields present and filled

---
OUTPUT FORMAT (strict JSON, no extra text):
${outputFormatBlurb}
{
  ${outputLine},
  "scoreBefore": {
    "total": <number>,
    "breakdown": [
      { "dimension": "hookQuality", "score": <number> },
      { "dimension": "firstPageQuality", "score": <number> },
      { "dimension": "mcAndCharacterFit", "score": <number> },
      { "dimension": "worldAndSetupCoherence", "score": <number> },
      { "dimension": "initialStateCalibration", "score": <number> },
      { "dimension": "metadataQuality", "score": <number> }
    ],
    "passed": <boolean>,
    "issues": [{ "dimension": "...", "issue": "...", "suggestion": "..." }]
  },
  "scoreAfter": {
    "total": <number>,
    "breakdown": [
      { "dimension": "hookQuality", "score": <number> },
      { "dimension": "firstPageQuality", "score": <number> },
      { "dimension": "mcAndCharacterFit", "score": <number> },
      { "dimension": "worldAndSetupCoherence", "score": <number> },
      { "dimension": "initialStateCalibration", "score": <number> },
      { "dimension": "metadataQuality", "score": <number> }
    ],
    "passed": <boolean>,
    "fixes": [{ "dimension": "...", "change": "..." }]
  },
  "actionFlags": [{ "actionIndex": <number>, "issue": "..." }],
  "integrityFlags": [{ "field": "...", "issue": "..." }]
}`;
}

/**
 * Constructs the AI prompt constraints for generating reader actions (choices).
 * 
 * Dynamically shifts the generation rules based on story progression. During standard 
 * gameplay, it enforces strict narrative branching and distinct consequences. During 
 * the finale, it triggers an "Entropy Collapse," forcing the AI to create an illusion 
 * of choice where all paths inevitably funnel toward the climax.
 * 
 * @param stateInfo - Partial state containing progression flags like `isFirstPage` and `isFinale`.
 * @returns A highly optimized, capitalized-anchored prompt string for action generation.
 */
function getActionRulesText(stateInfo: Partial<StoryStateInfo> & { mode?: BookMode }): string {
  const { isFirstPage, isFinale, mode } = stateInfo;
  const limit = isFirstPage || isFinale ? MAX_ACTION_CHOICES_FIRST_PAGE : MAX_ACTION_CHOICES;

  const base = mode === 'novel' ? `Generate exactly 1 definitive action:
- text: ${ACTION_TEXT_LENGTH}.
- Make actions feel immediate, natural, and narrative-driven. Avoid over-explaining.
- Can be physical verb (what to do) or dialogue (what to say).
- Example: "Who are you?" / Run away, fast.` :

`Generate ${MIN_ACTION_CHOICES}-${limit} actions to choose:
- text: ${ACTION_TEXT_LENGTH}. MUST be 100% unique (used as identifier).
- Make actions feel immediate, natural, and narrative-driven. Avoid over-explaining.
- Naturally mix physical verbs (what to do) and dialogue (what to say).
- Example: A. "Who are you?" / B. Run away, fast.
- If no action is viable or needed, generate exactly 1 choice.`;

  return `${base}\n\n${isFinale ? `ENTROPY COLLAPSE SYSTEM (Finale mechanic):
- Reduce the number of meaningful actions while sustaining immersion.
- Make actions feel constrained, inevitable, or repetitive. Completely different choices MUST funnel into the exact same terrifying consequence.
- Example: A. Open the door / B. Knock first -> (Both lead to the door opening).`
: `BRANCHING DIVERGENCE RULES:
- Actions must be meaningfully distinct. No two actions should lead to the same implied consequence.
- Provide a mix of safe, risky, and ambiguous choices.
- Occasionally include a deceptive choice.`}`;
}

// ============================================================================
// USER PROMPTS
// ============================================================================

/**
 * Template for generating the next story page with all necessary context
 * 
 * This prompt combines system rules, current story state, and user decisions
 * to guide the AI in creating the next page of the psychological thriller.
 */

/**
 * Formats a single previous page entry with proper indentation and structure
 * 
 * @param page - The page data
 * @param action - The action taken on this page if any
 * @returns Formatted string for this page entry
 * 
 * @example
 * • Page 3 (place: classroom, time: morning)
 *   I walked into the empty classroom, the chalkboards still covered in
 *   yesterday's equations. Sarah was already there.
 *   → Scene type: transition (momentum: building)
 *   → Selected action: Ask about the book (type: dialogue)
 *   → Hint for page 4: Sarah will reveal the book contains ancient symbols (type: mystery)
 * • Page 4 (place: classroom, time: morning)
 *   The symbols glowed faintly as Sarah traced them with her finger.
 *   → Scene type: investigation (momentum: rising)
 *   → Plot flag: [artifact_revealed] The symbols form a map (MAJOR)
 *   → Selected action: Examine the map closely (type: investigate)
 *   → Hint for page 5: The map shows a hidden passage beneath the school (type: discovery)
 */
function formatPreviousPageEntry(page: ActionedStoryPage | CandidateGenerationPage, plotFlags?: PlotFlag[]): string {
  const pageText = formatPageTextForPrompt(page.text);
  const sceneInfo = [
    page.placeId ? `place: ${page.placeId}` : '',
    page.timeOfDay ? `time: ${page.timeOfDay}` : '',
    page.mood && page.mood !== 'other' ? `mood: ${page.mood}` : '',
    page.weather && page.weather !== 'unknown' ? `weather: ${page.weather}` : '',
  ].filter(Boolean).join(', ')
  
  // Base page, momentum, and plot flag information
  let entry = `• Page ${page.page} (${sceneInfo})\n  ${pageText}`;
  if (page.sceneType) entry += `\n  → Scene type: ${page.sceneType}${page.momentum ? ` (momentum: ${page.momentum})` : ''}`;
  if (plotFlags?.length) entry += `\n  → Plot flags: ${plotFlags.sort((a, b) => Number(b.isMajorEvent) - Number(a.isMajorEvent)).map(plotFlag => formatPlotFlag(plotFlag, { showPageHeader: false })).join('; ')}`;

  // Add action information if present
  const action = 'action' in page ? page.action : page.selectedAction;
  if (action) {
    if (action.text) {
      const actionText = `"${action.text}"`;
      entry += `\n  → Selected action: ${actionText} (type: ${action.type})`;
    }
    if (action.hint.text) {
      const hintText = `"${action.hint.text}"`;
      entry += `\n  → Hint for page ${page.page + 1}: ${hintText} (type: ${action.hint.type})`;
    }
  }
  
  return entry;
}

/**
 * Formats previous story pages and plot flags into a compact narrative context
 * for AI generation.
 *
 * Context is split into two sections:
 *
 * 1. Earlier Plot Events
 *    - Compressed historical memory.
 *    - Contains plot flags from pages no longer included in recent page history.
 *    - Major plot flags are retained longer than minor ones.
 *    - Duplicate plot flags are removed.
 *
 * 2. Recent Narrative Context
 *    - Full page text for the most recent pages.
 *    - Includes scene metadata, selected actions, hints, and page plot flags.
 *
 * This strategy preserves important long-term story developments while
 * prioritizing recent narrative continuity for the AI model.
 *
 * @param currentPage - Current page being generated
 * @param previousPages - Previous pages ordered arbitrarily
 * @param plotFlags - Story plot flags accumulated so far
 * @param maxDisplayed - Maximum number of recent pages to include
 *
 * @returns Formatted prompt context string
 *
 * @example
 * • Page 1 [mystery_started] Ethan's friend is missing (MAJOR)
 * • Page 2 [clue_found] Ethan found a dead body (MAJOR)
 * • Page 3 (place: classroom, time: morning)
 *   I walked into the empty classroom, the chalkboards still covered in
 *   yesterday's equations. Sarah was already there.
 *   → Selected action: Ask about the book (type: dialogue)
 *   → Hint for page 4: Sarah will reveal the book contains ancient symbols (type: mystery)
 * • Page 4 (place: classroom, time: morning)
 *   The symbols glowed faintly as Sarah traced them with her finger.
 *   → Plot flag: [artifact_revealed] The symbols form a map (MAJOR)
 *   → Selected action: Examine the map closely (type: investigate)
 *   → Hint for page 5: The map shows a hidden passage beneath the school (type: discovery)
 */
function formatPreviousPagesForPrompt(
  currentPage: number,
  previousPages: ActionedStoryPage[],
  plotFlags: PlotFlag[],
  maxDisplayed: number = MAX_PAGE_HISTORY,
): string {
  if (previousPages.length === 0) return 'No previous pages yet.';

  const recentPages = previousPages.slice(-maxDisplayed).sort((a, b) => a.page - b.page);
  const displayedPages = new Set(recentPages.map(page => page.page));
  const extendedFlagCutoff = currentPage - (maxDisplayed * 2); // For skipping minor events on older pages
  const seenPlotFlags = new Set<string>();

  const olderPlotFlags = [...plotFlags].sort((a, b) => {
    if (a.page === b.page) return Number(b.isMajorEvent) - Number(a.isMajorEvent); // Major events first
    return a.page - b.page; // Page number ascending
  }).filter(flag => {
    // Exclude plot flags from current page
    if (currentPage === flag.page) return false;

    // Already represented by recent page context
    if (displayedPages.has(flag.page)) return false;

    // Remove very old minor events
    if (flag.page < extendedFlagCutoff && !flag.isMajorEvent) return false;

    // Deduplicate
    const key = `${flag.page}|${flag.type}|${flag.fact}`;
    if (seenPlotFlags.has(key)) {
      console.warn(`[formatPreviousPagesForPrompt] 👀 Duplicate plot flag removed:`, flag);
      return false;
    }

    seenPlotFlags.add(key);
    return true;
  });

  const plotFlagsByPage = new Map<number, PlotFlag[]>();
  for (const flag of plotFlags) {
    const existing = plotFlagsByPage.get(flag.page);

    if (existing) {
      existing.push(flag);
    } else {
      plotFlagsByPage.set(flag.page, [flag]);
    }
  }

  const formattedOlderFlags = olderPlotFlags.slice(-MAX_OLDER_PLOT_FLAGS).map(flag => formatPlotFlag(flag));
  const formattedRecentPages = recentPages.map(page => formatPreviousPageEntry(page, plotFlagsByPage.get(page.page) ?? []));

  return [
    ...formattedOlderFlags,
    ...formattedRecentPages,
  ].join('\n');
}

/**
 * Processes action hints for AI narrative guidance
 * 
 * This function extracts narrative direction from hints while preventing
 * robotic writing and maintaining suspense. Hints are processed
 * through thematic categorization rather than literal interpretation.
 * 
 * @param hint - Raw hint text from action
 * @returns Processed hint with narrative guidance and constraints
 */
function getHintGuidanceForAI(hintType: ActionHintType): string {
  return HINT_GUIDANCE_MAP[hintType] ?? "Develop naturally with appropriate tone for the action type and context.";
}

/**
 * Format a key/value collection into a bullet list.
 *
 * Accepts either an object map (e.g. `{ a: 'x', b: 'y' }`) or an array of
 * entries (e.g. `[['a','x'], ['b','y']]`). Each entry is formatted as
 * `- key: value` and joined by newlines. Values are coerced to string.
 *
 * @param items - Object or entry-array to format into `- key: value` lines
 * @returns A newline-separated string suitable for inclusion in prompts
 */
export function formatKeyValueList(items: Record<string, unknown> | [string, unknown][]): string {
  const entries: [string, unknown][] = Array.isArray(items) ? items : Object.entries(items);
  return entries.map(([k, v]) => `- ${k}: ${String(v)}`).join('\n');
}

/**
 * Formats action choices for AI prompt with enhanced readability
 * 
 * Creates clean, professional presentation of available actions
 * with consistent formatting and clear action type indicators.
 * 
 * @param actions - Array of action objects
 * @returns Formatted string with action choices (A, B, C, etc.)
 */
function formatActionChoices(actions: Action[]): string {
  return actions
    .map((action, index) => {
      const letter = String.fromCharCode(65 + index);
      const actionText = action.text.trim();
      return `${letter}. ${actionText} (type: ${action.type})`;
    })
    .join('\n');
}

/**
 * Formats FutureNotes into a structured prompt section for story generation.
 *
 * Notes are bucketed into three sections that signal urgency to the AI:
 *
 * 1. **Becoming Relevant** — `schedule` is within the lookahead window, OR
 *    `stateTrigger` is currently satisfied. The AI should begin naturally
 *    foreshadowing and advancing these without forcing immediate resolution.
 *
 * 2. **Future Payoffs & Scheduled Events** — has a `schedule` that has not yet
 *    entered its lookahead window. Shown for long-term awareness only; the AI
 *    must not force these into the current page.
 *
 * 3. **Unscheduled** — has no `schedule`, or only a `stateTrigger` whose
 *    threshold is not yet met. State-triggered notes render a "triggers when: …"
 *    annotation so the AI knows exactly what activates them.
 *
 * Activation semantics:
 * ┌──────────────┬─────────────────────────────────────────────────────────────┐
 * │ schedule     │ lookahead window (pages / days / date); phase at-or-past    │
 * │ stateTrigger │ fires immediately when threshold is crossed (no window)      │
 * │ both         │ becomes Relevant when EITHER fires (true OR semantics)       │
 * │ neither      │ always Unscheduled — open-ended obligation, no known trigger │
 * └──────────────┴─────────────────────────────────────────────────────────────┘
 *
 * Schedule label display priority: day > date > page > phase.
 * The stateTrigger label ("triggers when: …") always follows the schedule label
 * so the AI knows the secondary activation path on mixed notes.
 *
 * Example output:
 *
 * Becoming Relevant (advance naturally, do not force immediate resolution):
 * - entity_cycle: Strange electrical disturbances intensify across town.
 *   (MAJOR, Day 52 — 3 days away, thread: disappearance_cycle)
 * - spiral_down: MC starts acting recklessly and dissociating.
 *   (triggers when: stability is unstable)
 *
 * Future Payoffs & Scheduled Events:
 * - Day 65 (16 days away): The next disappearance in the cycle occurs. (MAJOR) [ID: entity_cycle]
 * - Pages 52–60: Reveal the contents of the hidden journal. [ID: diary_owner]
 * - FINALE phase: Expose the architect behind the simulation. (MAJOR) [ID: conspiracy]
 *
 * Unscheduled:
 * - relationship_1: Tension between Maya and Ethan continues to grow.
 * - dark_spiral: MC reaches breaking point. (triggers when: mentalPercent < 25)
 *
 * @param futureNotes         Notes accumulated throughout the story.
 * @param currentPage         Current story page number.
 * @param currentPhase        Current story phase key.
 * @param currentDay          In-story day number since story start (1-based).
 * @param currentDate         In-story calendar date in YYYY-MM-DD format.
 * @param currentHealthStatus Live MC health data for stat/condition trigger evaluation.
 *                            When absent, all health-based triggers evaluate to false.
 * @param currentStability    Live MC stability level for stability trigger evaluation.
 *                            When absent, stability triggers evaluate to false.
 * @returns Prompt-ready string for injection into story generation context.
 */
function formatFutureNotes(params: {
  futureNotes: FutureNote[];
  currentPage: number;
  currentPhase: StoryPhase;
  currentDay?: number;
  currentDate?: string;
  /**
   * Live MC health data, required to evaluate `stateTrigger` conditions of
   * types 'condition' and 'stat'. When absent, those triggers evaluate to false
   * and the note stays Unscheduled until health data becomes available.
   */
  currentHealthStatus?: HealthStatus;
  /**
   * Live MC psychological stability level (stable | cracking | unstable).
   * Required to evaluate `stateTrigger` conditions of type 'stability'.
   * When absent, stability triggers evaluate to false.
   */
  currentStability?: StabilityLevel;
  /**
   * pgvector semantic memory (Use Case 3) — ranked note keys for the
   * unscheduled bucket, ordered by semantic similarity to the current
   * scene query. When provided, the unscheduled bucket is displayed in
   * this order instead of the default chronological sort.
   */
  sortedUnscheduledKeys?: string[];
}): string {
  const {
    futureNotes,
    currentPage,
    currentPhase,
    currentDay,
    currentDate,
    currentHealthStatus,
    currentStability,
    sortedUnscheduledKeys,
  } = params;

  if (!futureNotes.length) return 'None yet.';

  // ── Phase ordering ─────────────────────────────────────────────────────────

  /** Numeric rank for each story phase, used for ordered comparison. */
  const phaseOrder: Record<StoryPhase, number> = { EARLY: 0, MID: 1, LATE: 2, FINALE: 3 };

  // ── Distance helpers ───────────────────────────────────────────────────────

  /**
   * Returns signed in-story day distance to `targetDay`:
   * positive = target is ahead, negative = already passed.
   * Returns undefined when `currentDay` is not available.
   */
  const getDayDistance = (targetDay: number): number | undefined =>
    currentDay !== undefined ? targetDay - currentDay : undefined;

  /**
   * Returns signed calendar day distance to `targetDate`:
   * positive = target is ahead, negative = already passed.
   * Returns undefined when `currentDate` is not available.
   */
  const getDateDistance = (targetDate: string): number | undefined =>
    currentDate ? daysBetween(currentDate, targetDate) : undefined;

  // ── Schedule activation ────────────────────────────────────────────────────

  /**
   * Returns true when the note's schedule is within its lookahead window, or
   * when the phase threshold has been reached or passed.
   *
   * Notes on distance sign:
   * - Negative day/date distance → target already passed. Still treated as active
   *   (the note is overdue, not stale — the AI should still advance it).
   * - Undefined distance → no day/date context available → not yet active.
   */
  const isScheduleActive = (s: FutureNoteSchedule): boolean => {
    switch (s.type) {
      case 'phase':
        // Fires once currentPhase reaches OR passes the target phase.
        return phaseOrder[s.phase] <= phaseOrder[currentPhase];
      case 'page': {
        const { start } = parsePageRange(s.range) ?? {};
        return start !== undefined && currentPage >= start - FUTURE_NOTE_LOOKAHEAD_PAGES;
      }
      case 'day': {
        const dist = getDayDistance(s.day);
        return dist !== undefined && dist <= FUTURE_NOTE_LOOKAHEAD_DAYS;
      }
      case 'date': {
        const dist = getDateDistance(s.date);
        return dist !== undefined && dist <= FUTURE_NOTE_LOOKAHEAD_DAYS;
      }
    }
  };

  // ── State trigger activation ───────────────────────────────────────────────

  /**
   * Returns true when the note's stateTrigger condition is currently satisfied.
   *
   * State triggers have no lookahead — they fire the moment the MC's state
   * crosses the threshold. When the required health/stability data is absent,
   * the trigger evaluates to false so the note remains Unscheduled.
   *
   * All stat variants use `<=` semantics: fires when the stat falls to or below
   * the threshold. There is intentionally no operator field — in a doom-directed
   * thriller, state-based notes are exclusively about deterioration.
   */
  const isStateTriggerActive = (t: FutureNoteStateTrigger): boolean => {
    switch (t.type) {
      case 'stability':
        return currentStability === t.level;
      case 'condition':
        return currentHealthStatus?.condition === t.condition;
      case 'healthPercent':
      case 'mobilityPercent':
      case 'actionPercent':
      case 'mentalPercent': {
        const current = currentHealthStatus?.[t.type];
        return current !== undefined && current <= t.threshold;
      }
    }
  };

  // ── Label helpers ──────────────────────────────────────────────────────────

  /**
   * Builds a human-readable label for a single `FutureNoteSchedule` item.
   * Used internally by `getScheduleLabel` to render each item in the array.
   */
  const getSingleScheduleLabel = (s: FutureNoteSchedule): string => {
    const fmtDays = (distance: number | undefined, base: string): string => {
      if (distance === undefined) return base;
      if (distance > 0) {
        const n = distance;
        return `${base} (${n} day${n === 1 ? '' : 's'} away)`;
      }
      if (distance === 0) return `${base} (today)`;
      const n = Math.abs(distance);
      return `${base} (${n} day${n === 1 ? '' : 's'} past)`;
    };

    switch (s.type) {
      case 'day':   return fmtDays(getDayDistance(s.day), `Day ${s.day}`);
      case 'date':  return fmtDays(getDateDistance(s.date), s.date);
      case 'phase': return `${s.phase} phase`;
      case 'page':  {
        const { start, end } = parsePageRange(s.range) ?? {};
        return Number.isFinite(end) ? `Pages ${start}\u2013${end}` : `Page ${start}`;
      }
    }
  };

  /**
   * Builds a combined schedule label for a note, joining all schedule items
   * with " OR " so the AI can see every possible activation beat at a glance.
   *
   * Example with a single item:   "Day 7 (3 days away)"
   * Example with two items:       "Day 7 (3 days away) OR Pages 25–30"
   *
   * Returns undefined when the note has no schedule entries.
   */
  const getScheduleLabel = (note: FutureNote): string | undefined => {
    if (!note.schedule?.length) return undefined;
    return note.schedule.map(getSingleScheduleLabel).join(' OR ');
  };

  /**
   * Builds a "triggers when: …" annotation for the note's stateTrigger.
   *
   * Surfaced on Unscheduled notes so the AI knows the exact threshold that
   * activates the note — preventing premature forcing or silent ignoring.
   * Stat variants render with `≤` since that is the hardcoded comparison.
   */
  const getStateTriggerLabel = (note: FutureNote): string | undefined => {
    const triggers = note.stateTrigger;
    if (!triggers?.length) return undefined;
    return triggers.map(t => {
      switch (t.type) {
        case 'stability': return `stability is '${t.level}'`;
        case 'condition': return `condition is '${t.condition}'`;
        case 'healthPercent':
        case 'mobilityPercent':
        case 'actionPercent':
        case 'mentalPercent':
          return `${t.type} \u2264 ${t.threshold}`;
      }
    }).join(' OR ');
  };

  // ── Bucketing ──────────────────────────────────────────────────────────────

  const becomingRelevant: FutureNote[] = [];
  const upcomingScheduledEvents: FutureNote[] = [];
  const unscheduled: FutureNote[] = [];

  for (const note of futureNotes) {
    // OR across all schedule items — any single item firing promotes the note.
    const scheduleActive = note.schedule?.some(isScheduleActive) ?? false;
    const triggerActive  = note.stateTrigger?.some(isStateTriggerActive) ?? false;
    const hasSchedule    = !!note.schedule?.length;

    if (scheduleActive || triggerActive) {
      // At least one schedule window opened, OR the MC's state crossed the threshold.
      becomingRelevant.push(note);
    } else if (hasSchedule) {
      // Has future schedule entries, but none are within the lookahead window yet.
      upcomingScheduledEvents.push(note);
    } else {
      // No schedule — state-trigger-only (dormant) or entirely open-ended.
      unscheduled.push(note);
    }
  }

  // ── Sorting ────────────────────────────────────────────────────────────────

  /**
   * Computes the sort key [typeRank, numericValue] for a single schedule item.
   * Used by `getSortValue` to pick the earliest across all items in the array.
   */
  const getSingleSortValue = (s: FutureNoteSchedule): [number, number] => {
    switch (s.type) {
      case 'day':   return [0, s.day];
      case 'date':  return [1, toUtcMidnight(s.date)];
      case 'phase': return [3, phaseOrder[s.phase] ?? Number.MAX_SAFE_INTEGER];
      case 'page':  {
        const { start = Number.MAX_SAFE_INTEGER } = parsePageRange(s.range) ?? {};
        return [2, start];
      }
    }
  };

  /**
   * Computes a [typeRank, numericValue] sort key for a note.
   *
   * For notes with multiple schedule entries, picks the earliest-firing entry
   * (minimum sort value) so the note sorts by its soonest possible activation.
   *
   * Rank table (lower = earlier in the narrative timeline):
   *   0 = day     (absolute in-story day number)
   *   1 = date    (UTC epoch ms for consistent cross-month ordering)
   *   2 = page    (start page of the window)
   *   3 = phase   (phase index 0–3)
   *   4 = stateTrigger-only (no time dimension; after all scheduled notes)
   *   5 = no trigger at all (fully open-ended; always last)
   */
  const getSortValue = (note: FutureNote): [number, number] => {
    if (!note.schedule?.length) {
      return note.stateTrigger ? [4, Number.MAX_SAFE_INTEGER] : [5, Number.MAX_SAFE_INTEGER];
    }
    // Pick the earliest-firing schedule entry across the array.
    return note.schedule
      .map(getSingleSortValue)
      .reduce((earliest, current) =>
        current[0] < earliest[0] || (current[0] === earliest[0] && current[1] < earliest[1])
          ? current
          : earliest,
      );
  };

  const sortNotes = (notes: FutureNote[]): void => {
    notes.sort((a, b) => {
      const [aType, aVal] = getSortValue(a);
      const [bType, bVal] = getSortValue(b);
      // Primary: narrative timeline position.
      if (aType !== bType) return aType - bType;
      if (aVal  !== bVal)  return aVal  - bVal;
      // Secondary: major notes surface first within the same time slot.
      if (a.isMajor !== b.isMajor) return a.isMajor ? -1 : 1;
      // Final tiebreak: insertion order (older notes first).
      return (a.addedAtPage ?? Infinity) - (b.addedAtPage ?? Infinity);
    });
  };

  sortNotes(becomingRelevant);
  sortNotes(upcomingScheduledEvents);
  sortNotes(unscheduled);

  // pgvector semantic memory (Use Case 3): reorder the unscheduled bucket by
  // semantic-similarity rank when available. Notes closest to the current scene
  // query surface first, helping the AI prioritize the most contextually
  // relevant loose ends. Notes without a rank (e.g. not yet embedded or below
  // threshold) fall through to the end in their original chronological order.
  if (sortedUnscheduledKeys?.length) {
    const keyOrder = new Map(sortedUnscheduledKeys.map((k, i) => [k, i]));
    unscheduled.sort((a, b) => {
      const rankA = keyOrder.get(a.key);
      const rankB = keyOrder.get(b.key);
      if (rankA === undefined && rankB === undefined) return 0; // neither ranked — preserve existing order
      if (rankA === undefined) return 1;  // unranked notes sort after ranked ones
      if (rankB === undefined) return -1;
      return rankA - rankB;
    });
  }

  // ── Formatters ─────────────────────────────────────────────────────────────

  /**
   * Formats a note for the "Becoming Relevant" and "Unscheduled" sections.
   * Meta order: MAJOR · schedule label · stateTrigger annotation · thread ID.
   */
  const formatRelevantNote = (note: FutureNote): string => {
    const meta: string[] = [];

    if (note.isMajor) meta.push('MAJOR');

    const schedule = getScheduleLabel(note);
    if (schedule) meta.push(schedule);

    // Always surface the state trigger annotation so the AI understands what
    // threshold activates this note — critical for Unscheduled dormant notes.
    const triggers = getStateTriggerLabel(note);
    if (triggers) meta.push(`trigger when: ${triggers}`);

    if (note.relatedThreadId && note.relatedThreadId !== 'none') {
      meta.push(`thread: ${note.relatedThreadId}`);
    }

    return `- ${note.key}: ${note.note}${meta.length ? ` (${meta.join(', ')})` : ''}`;
  };

  /**
   * Formats a note for the "Future Payoffs & Scheduled Events" section.
   * Leads with the schedule label for at-a-glance timeline scanning.
   * The stateTrigger label is intentionally omitted — schedule is the
   * primary signal in this section.
   */
  const formatScheduledEvent = (note: FutureNote): string => {
    const schedule = getScheduleLabel(note);
    const prefix   = schedule ? `${schedule}: ` : '';
    const major    = note.isMajor ? ' (MAJOR)' : '';
    return `- ${prefix}${note.note}${major} [ID: ${note.key}]`;
  };

  // ── Assembly ───────────────────────────────────────────────────────────────

  const sections: string[] = [];

  if (becomingRelevant.length) {
    sections.push([
      'Becoming Relevant (advance naturally, do not force immediate resolution):',
      ...becomingRelevant.map(formatRelevantNote),
    ].join('\n'));
  }

  if (upcomingScheduledEvents.length) {
    sections.push([
      'Future Payoffs & Scheduled Events:',
      ...upcomingScheduledEvents.map(formatScheduledEvent),
    ].join('\n'));
  }

  if (unscheduled.length) {
    sections.push([
      'Unscheduled:',
      ...unscheduled.map(formatRelevantNote),
    ].join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Formats selected action for AI prompt with enhanced formatting
 * 
 * Provides clean, professional presentation of selected action with
 * proper hint processing and guidance for AI narrative direction.
 */
function formatSelectedAction(page: Pick<CandidateGenerationPage, 'action' | 'actions'>): string {
  const { action, actions: allActions } = page;
  if (!action) return 'No action chosen. Continue story naturally toward viable ending plan.';

  const isCustomAction = action.type === 'custom';

  // Find the index of selected action to get the letter. `a` must NOT be
  // named `action` here -- shadowing the outer `action` made this compare
  // each candidate's text against itself, so findIndex always matched
  // index 0 regardless of which action was actually picked (every
  // "Selected:" line rendered "A." even when a later choice was chosen).
  const selectedIndex = allActions.findIndex(a => a.text === action.text);
  const selectedLetter = String.fromCharCode(65 + selectedIndex); // A, B, C, etc.

  return `${selectedLetter ? `${selectedLetter}.` : '•'} ${action.text} (type: ${action.type})

CONTINUATION GUIDANCE (for selected action):
· Hint: ${isCustomAction ? "-" : action.hint.text}
· Guidance: ${getHintGuidanceForAI(isCustomAction ? "custom" : action.hint.type)}
· Important: ${isCustomAction ? `This is custom prompt from reader. Develop naturally, steer story toward viable ending plan.` : `This hint guides you in narrative direction, might be a secret, not to always put in the story.`}`;
}

export function getThreadState(
  status: ThreadStatus,
  urgency: number
): string {
  switch (status) {
    case "open": return urgency >= 0.5 ? "Gaining momentum" : "Recently introduced";
    case "developing": return urgency >= 0.75 ? "Major answers approaching" : "Actively developing";
    case "revealed": return "Key truths emerging";
    case "twisted": return "Recent twist changing assumptions";
    case "closed": return "Resolved";
  }
}

/**
 * Formats active story threads for AI prompt with structured display
 * 
 * Creates a formatted string showing all active threads with their key metadata
 * including question, status, priority, urgency, and recent clues. This helps the AI
 * understand which mysteries are active and how they should be developed.
 * 
 * @param threads - Array of active story thread objects
 * @returns Formatted string with thread information in bullet-point format
 * 
 * @example
 * ```typescript
 * const threads = [
 *   { title: "Lisa's Identity", question: "Who is Lisa really?", status: "developing", priority: "high", urgency: 0.85, clues: ["She knows my mother", "She wasn't in yearbook"] }
 * ];
 * const formatted = formatActiveThreads(threads);
 * ```
 * 
 * Returns:
 * • Lisa's Identity: "Who is Lisa really?" (Major answers approaching) [ID: lisa_identity]
 *   Recent clues:
 *   → page 1: She knows my mother [FALSE]
 *   → page 2: She wasn't in yearbook
 *   Priority: main
 *   Urgency: 0.85
 *   Reality: true
 */
function formatActiveThreads(threads: StoryThread[], clueRecallBlocks?: Record<string, string>): string {
  if (!threads || threads.length === 0) return 'No active threads yet.';

  // Sort by priority > urgency
  threads.sort((a, b) => {
    const priorityOrder: Record<ThreadPriority, number> = { main: 3, secondary: 2, minor: 1 };
    const priorityA = priorityOrder[a.priority] || 0;
    const priorityB = priorityOrder[b.priority] || 0;

    if (priorityA !== priorityB) return priorityB - priorityA;
    return b.urgency - a.urgency;
  });

  // Display thread ID and pretty-format clues (discoveredAtPage + isFalse flag)
  return threads.map(t => {
    const header = `• ${t.title}: "${t.question}" (${getThreadState(t.status, t.urgency)}) [ID: ${t.threadId}]`;
    const recent = t.clues?.length ? t.clues
      .slice(-MAX_THREADS_CLUES)
      .sort((a, b) => a.discoveredAtPage - b.discoveredAtPage)
      .map(c => `  → page ${c.discoveredAtPage}: ${c.clue}${c.isFalse ? ' [FALSE]' : ''}`) : [];

    // pgvector semantic memory (Use Case 4): clues that have scrolled out of
    // the "Recent clues" window above, surfaced only when semantically
    // relevant to the current scene. Never duplicates what's already shown.
    const recalledClue = clueRecallBlocks?.[t.threadId];

    return [
      header,
      recent.length && `  Recent clues:\n${recent.join('\n')}`,
      recalledClue && `  Earlier clues (recalled):\n    → ${recalledClue}`,
      `  Priority: ${t.priority}`,
      `  Urgency: ${t.urgency.toFixed(2)}`,
      t.truth !== 'unknown' && `  Reality: ${t.truth}`,
    ].filter(Boolean).join('\n');
  }).join('\n');
}

// Duplicated verbatim across the early-phase and mid-phase branches of
// formatThreadRules below -- named once so the two branches can't drift
// out of sync on lines that are meant to say the exact same thing.
const THREAD_FOCUS_LIMIT_LINE = '- Focus on 1-2 threads per page';
const THREAD_UPDATE_ON_REVISIT_LINE = '- When a thread is revisited or meaningfully developed, update that thread even if no new clue is added';

/**
 * Generates thread-management guidance for AI story generation.
 *
 * This function provides context-specific guidance for handling story threads
 * at different stages of the narrative. Rules vary based on whether the story
 * is in its initial phase, mid-game progression, or finale, ensuring appropriate
 * pacing and resolution of mysteries.
 * 
 * Story threads represent active mysteries, questions, and narrative
 * tensions that drive the thriller forward.
 *
 * Goals:
 * - Introduce mysteries gradually
 * - Avoid thread sprawl
 * - Focus attention on a small number of threads per page
 * - Encourage convergence of mysteries
 * - Ensure major threads resolve by the finale
 *
 * @param threads - Current story threads
 * @param stateInfo - Current story progression information
 * @returns Prompt-ready thread management rules
 * 
 * @example
 * ```typescript
 * // Early game (no threads)
 * formatThreadRules([], { isEarlyPhase: true, isMidPhase: false, isLatePhase: false, isFinale: false, pageProgress: 0.10 })
 * // Returns: Rules for introducing initial threads
 * 
 * // Mid game with active threads
 * formatThreadRules(threads, { isEarlyPhase: false, isMidPhase: true, isLatePhase: false, isFinale: false, pageProgress: 0.50 })
 * // Returns: Rules for developing and managing existing threads
 * 
 * // Finale
 * formatThreadRules(threads, { isEarlyPhase: false, isMidPhase: false, isLatePhase: true, isFinale: true, pageProgress: 0.95 })
 * // Returns: Rules for resolving all threads
 * ```
 */
function formatThreadRules(threads: StoryThread[], stateInfo: StoryStateInfo): string {
  const { isEarlyPhase, isMidPhase, isFinale } = stateInfo;

  // Count active (non-closed) threads
  const activeThreads = threads.filter(t => t.status !== 'closed');
  const atThreadLimit = activeThreads.length >= MAX_ACTIVE_THREADS;

  // Finale: Focus on resolution
  if (isFinale) {
    return `
- Do NOT introduce new threads
- Focus on resolving remaining mysteries
- Prioritize threads closest to resolution
- Reveal the truth behind major false clues before resolution
- Connect thread resolutions where possible
- Every main thread must resolve
- Leave limited ambiguity only for lingering unease or interpretation`;
  }

  // No active mysteries: Initial thread creation rules
  if (activeThreads.length === 0) {
    if (isEarlyPhase) {
      // Early phase (pages 1-25%): Introduce 1-2 core mysteries
      return `
- Introduce 1-2 compelling mysteries
- Each thread should pose a clear unanswered question
- Prioritize mysteries connected to the core premise
- Avoid introducing too many unanswered questions at once
- Keep initial mysteries open-ended and difficult to explain`;
    }

    if (isMidPhase) {
      // Mid phase (pages 25-70%): Can introduce additional threads
      return `
- Introduce 1 important mystery
- Prefer mysteries that emerge naturally from existing events
- Ensure the new thread can influence future story progression
- Avoid creating mysteries with no clear development path`;
    }

    // Late phase with no threads: Unusual state, allow cautious introduction
    return `
- Introduce 1 high-impact mystery only if needed
- Ensure it can develop and resolve quickly
- Avoid opening threads that cannot be resolved before the ending`;
  }

  // Early phase: Development and management rules
  if (isEarlyPhase) {
    return `
${atThreadLimit ? `- Do NOT introduce new threads (active thread limit reached)` : `- Avoid introducing new threads unless necessary`}
${THREAD_FOCUS_LIMIT_LINE}
- Deepen mysteries through clues, contradictions, or unsettling discoveries
${THREAD_UPDATE_ON_REVISIT_LINE}
- Use false clues sparingly to create plausible but incorrect conclusions
- Plant seeds for future mysteries without fully activating them
- Prefer developing existing threads over creating new ones`;
  }

  // Mid phase: Balance development with progression
  if (isMidPhase) {
    return `
${atThreadLimit ? `- Do NOT introduce new threads (active thread limit reached)` : `- Introduce at most 1 new thread if truly needed`}
${THREAD_FOCUS_LIMIT_LINE}
- Advance, complicate, or partially reveal existing mysteries
${THREAD_UPDATE_ON_REVISIT_LINE}
- Threads nearing resolution should move closer to answers, revelations, or major reversals
- Use false clues sparingly to create believable misdirection
- Start resolving minor threads
- Prefer connecting mysteries together over creating unrelated new threads
- Avoid opening threads that have no clear path to resolution`;
  }

  // Late phase: Focus on resolution
  return `
- Do NOT introduce new threads
- Focus on advancing existing mysteries toward resolution
- Prioritize threads closest to resolution
- Reveal the truth behind false clues and misdirection
- Connect separate mysteries where possible
- Resolve minor threads before major ones
- Ensure every remaining main thread is moving toward a conclusion`;
}

function formatEndingPlan(viableEnding?: Ending, bookEnding?: Ending): string {
  // If is'a an initial viable ending (no `changeReason`), use from `book.ending` instead
  const ending = viableEnding?.changeReason ? viableEnding : (bookEnding ?? viableEnding);
  if (!ending) return 'No ending plan yet.';

  const { type, text, outline } = ending;
  return [
    `Type: ${endingTypes[type as keyof typeof endingTypes]}`,
    `Hint: ${text}`,
    outline?.length && `Outline:\n${formatOutline(outline)}`
  ].filter(Boolean).join('\n');
}

function formatOutline(outline: StoryOutline[]): string {
  return outline
    .map(item => `${item.isDone ? '✅' : '⬜'} ${item.text}${item.isDone && item.doneAtPage ? ` (page ${item.doneAtPage})` : ''}`)
    .join('\n');
}

function formatThreadsPrompt(threads: StoryThread[], stateInfo: StoryStateInfo, clueRecallBlocks?: Record<string, string>): string {
  return `ACTIVE THREADS:
${formatActiveThreads(threads, clueRecallBlocks)}

THREAD RULES:
${formatThreadRules(threads, stateInfo).trim()}`;
}

function formatEndingPrompt(state: StoryState, book: Book): string {
  return `CURRENT ENDING PLAN:
${formatEndingPlan(state.viableEnding, book.ending)}

ENDING RULES:
${buildEndingRules(state)}`;
}

/**
 * Builds the task instruction line for the "write next page" user prompt.
 *
 * This is the first thing the AI reads — it establishes what kind of output
 * is expected before any narrative context is provided.
 *
 * Single candidate (`candidateCount === 1`):
 * Returns a compact directive: continue in first-person POV and write the
 * specified page. No extra framing.
 *
 * Multiple candidates (`candidateCount > 1`):
 * Returns a richer instruction that:
 * - Establishes the "alternate fate / parallel timeline" framing
 * - Emphasises that narrative rules are shared across all continuations
 * - Requires each continuation to diverge into a distinct, unexpected outcome
 * - Optionally allows subtle cross-timeline narrative bleed when
 *   `memoryIntegrity` is not `'stable'` (e.g. déjà vu, echoes, hallucinations)
 *
 * @param state - Current story state. Uses `page`, `maxPage`, and `memoryIntegrity` (bleed instruction is only injected when integrity is not `'stable'`).
 * @param candidateCount - Number of alternative continuations to generate. Pass `1` for the standard single-page path.
 * @param language - Target language code (ISO 639-1) for localization lock.
 * @param mode - Book creation mode. Controls the branching instruction:
 *   - `novel`: no branching at all; `pages.actions` is always an empty array.
 *   - `interactive`: each action has exactly one `destinationPageIds` (a single chosen path).
 *   - `multiverse` (default when unset): like current behaviour — multiple alternate-fate continuations.
 * @returns A prompt string ready to be inserted as the `TASK:` section of the user message.
 *
 * @example
 * // Single page, mid-story
 * formatNextPageTaskPrompt({ page: 4, maxPage: 10, memoryIntegrity: 'stable', ... }, 1);
 * // → 'Continue the story in first-person ("I") POV. You're now writing page 4 of 10 — 6 pages remaining.'
 *
 * @example
 * // Two alternate fates, degraded memory integrity (multiverse)
 * formatNextPageTaskPrompt({ page: 4, maxPage: 10, memoryIntegrity: 'fragmented', ... }, 2, 'en', 'multiverse');
 * // → 'Continue the story in first-person ("I") POV. You're now writing page 4 of 10 — 6 pages remaining.
 * //    Generate 2 alternate-fate continuations — parallel timelines in the multiverse.
 * //    Each continuation must follow all the same narrative rules above, but diverge
 * //    into a distinct, unexpected outcome.
 * //    Occasionally, let a faint echo bleed across timelines — a déjà vu, a half-remembered
 * //    feeling or hallucination — but keep it subtle.'
 */
function formatNextPageTaskPrompt(state: StoryState, candidateCount: number, language: string, mode?: BookMode): string {
  const { page, maxPage, memoryIntegrity, flags } = state;
  const { trust, curiosity } = flags;
  const remainingPages = maxPage - page;
  const isNonEnglish = !!language && language !== 'en';
  const languageFormatted = formatLanguage(language);

  const pageLabel = remainingPages > 0
    ? `page ${page} of ${maxPage} — ${remainingPages} page${remainingPages === 1 ? '' : 's'} remaining`
    : `the final page of the book. The story ends completely right now.`;

  const base = `Continue the story in first-person ("I") POV${isNonEnglish ? ` in ${languageFormatted}` : ''}. You're now writing ${pageLabel}.`;

  // ── NOVEL: strictly linear. Never offer branching choices. ──────────────
  if (mode === 'novel') {
    return `${base}
This is a NOVEL — a strictly LINEAR story with a single path and a single ending. Generate exactly 1 definitive action (no branching, just 1 choice to continue). The page must read as one continuous, inevitable progression of the narrative.`;
  }

  // ── INTERACTIVE: single chosen path per action. ───────────────────────
  if (mode === 'interactive') {
    if (candidateCount === 1) return `${base}
This is an INTERACTIVE story — the reader's choices shape ONE path through the book. Write a small set of 2-3 distinct branching actions as usual, but each action leads to exactly ONE outcome. Do NOT pre-generate alternate fates; every action resolves to a single destination page.`;
    return `${base}
This is an INTERACTIVE story — the reader's choices shape ONE path through the book. Generate ${candidateCount} distinct alternate branches the reader could choose between, but each branch is a single, self-contained path (exactly one destination per action). Do NOT create parallel timelines that echo across each other.`;
  }

  // ── MULTIVERSE (default): current behaviour. ──────────────────────────
  if (candidateCount === 1) return base;

  // Only inject the cross-timeline bleed instruction when memory is degraded.
  // Stable memory → clean parallel timelines, no narrative leakage.
  const bleedInstruction = (memoryIntegrity !== 'stable' || trust === 'low' || curiosity === 'high') && Math.random() > 0.5
    ? `\nOccasionally, let a faint echo bleed across timelines — a déjà vu, a half-remembered feeling or hallucination — but keep it subtle.`
    : '';

  return `${base}
Generate ${candidateCount} alternate-fate continuations — parallel timelines in the multiverse.
Each continuation must follow all the same narrative rules, but diverge into a distinct, unexpected outcome.${bleedInstruction}

Multiple possible futures example:
Open the door
  - Empty, but echoes of his voice linger
  - A missing fellow waits in the dark
  - Something breathes inside
  - The room shouldn't exist`;
}

/**
 * Formats the current situation information for a story page in a readable format.
 *
 * @param page - The current page
 * @param state - The current story state, used to resolve character details
 * @returns Formatted string with current situation details
 *
 * @example
 * const page = {
 *   mood: 'tense',
 *   placeId: 'Old Library',
 *   weather: 'stormy',
 *   calendarDate: '2026-07-26',
 *   timeOfDay: 'midnight',
 *   sceneType: 'investigation',
 *   momentum: 'building tension',
 *   charactersPresent: [
 *     { characterId: 'enemy', sceneRole: 'opposition', sceneFocus: 1 },
 *     { characterId: 'ally', sceneRole: 'supporting', sceneFocus: 0.5 }
 *   ],
 *   keyObjects: ['mysterious book'],
 *   keyEvents: ['heard a distant scream']
 * };
 * const state = {
 *   characters: {
 *     enemy: { knownName: 'Ari', role: 'investigator' },
 *     ally: { knownName: 'Juno', role: 'friend' }
 *   }
 * };
 *
 * Returns:
 * - Story momentum: rising
 * - Scene type: investigation
 * - Place: Old Library
 * - Date: 2026-07-26
 * - Time: midnight
 * - Mood: tense
 * - Weather: stormy
 * - Characters present:
 *   · Ari (investigator - opposition, focus: 1) [ID: enemy]
 *   · Juno (friend - supporting, focus: 0.5) [ID: ally]
 * - Important objects:
 *   · mysterious book
 * - Key events:
 *   · heard a distant scream
 */
function formatCurrentSituationForPrompt(page: CandidateGenerationPage, state: StoryState): string {
  const { mood, placeId, weather, timeOfDay, sceneType, momentum, charactersPresent = [], keyObjects = [], keyEvents = [] } = page;
  const situation: string[] = [];
  
  // Basic situation elements
  if (momentum) situation.push(`Story momentum: ${momentum}`);
  if (sceneType) situation.push(`Scene type: ${sceneType}`);
  if (placeId) situation.push(`Place: ${placeId}`);
  if (timeOfDay) situation.push(`Time: ${timeOfDay}`);
  if (mood) situation.push(`Mood: ${mood}`);
  if (weather) situation.push(`Weather: ${weather}`);
  
  // Add characters if present
  if (charactersPresent.length) {
    // Order characters by sceneFocus (desc)
    const ordered = [...charactersPresent].sort((a, b) => (b.sceneFocus ?? 0) - (a.sceneFocus ?? 0));
    situation.push(`Characters present:\n${ordered.map(sceneCharacter => {
      const { characterId, sceneRole, sceneFocus } = sceneCharacter;
      const character = state.characters[characterId];
      if (!character) {
        console.log(`[charactersPresent] ⚠️ Character ID "${characterId}" does not exist`)
        return `  · ${characterId} (${sceneRole}, focus: ${sceneFocus}) [not present in known characters, add it via newCharacters]`;
      }
      const { knownName, role } = character;
      return `  · ${knownName} (${role} - ${sceneRole}, focus: ${sceneFocus}) [ID: ${characterId}]`;
    }).join('\n')}`);
  }
  
  // Add important objects if any
  if (keyObjects.length) situation.push(`Important objects:\n${keyObjects.map(obj => `  · ${obj}`).join('\n')}`);
  
  // Add key events if any
  if (keyEvents.length) situation.push(`Key events:\n${keyEvents.map(event => `  · ${event}`).join('\n')}`);
  
  return situation.map(item => `- ${item}`).join('\n');
}

/**
 * Shared semantic-retrieval query for all of Use Cases 1/2/5 — the current
 * scene plus the just-selected action, the best available proxy for "what's
 * about to happen" before the new page exists to embed anything from.
 * Reused across buildRelevantPastEventsBlock/buildCharacterRecallBlocks/
 * buildPlaceRecallBlocks specifically so the query TEXT is byte-identical
 * across all three — embedText()'s cache key is `${model}:${task}:${text}`,
 * so identical text means only the first call actually hits Jina; every
 * subsequent retrieval this page generation reuses the cached query
 * embedding instead of re-computing it.
 */
function buildCurrentSceneQuery(actionedPage: CandidateGenerationPage): string {
  return `${actionedPage.text}\n\nPlayer chose: ${actionedPage.action?.text ?? ''}`;
}

/**
 * Builds the "RELEVANT PAST EVENTS" prompt block via pgvector semantic
 * retrieval — computed once per page generation (not once per prompt
 * function), since buildNextPagePrompt and buildNextPageEvaluatorPrompt
 * both read it and firing a second Jina call for the identical query would
 * be wasteful. Called from prepareNextPageGenerationSetup, before
 * promptParams is built, and set as the relevantPastEventsBlock field on
 * BuildNextPagePromptParams (types/prompt.ts) — every format/build function
 * below stays fully synchronous except this one.
 *
 * Never throws — a failed or empty retrieval just means no block gets
 * injected. Page generation must never depend on Jina being reachable.
 * 
 * Use Case 1 (regular pages), Use Case 8 (finale, via isFinale/isLastPage —
 * getStoryStateInfo, same computation buildNextPagePrompt already does),
 * and custom actions (action.type === 'custom' — a reader spending credits
 * on a deliberate, specific moment is a good reason to widen the net for
 * that one page, regardless of what the action text says).
 *
 * Finale pages get MAX_VECTOR_RESULTS_HIGH_VALUE (15, vs. the usual 5) AND
 * prioritizeMajorEvents: true, which boosts pages the AI itself flagged
 * isMajorEvent during generation (StateDelta.isMajorEvent, already stored
 * on pages.stateDelta — no schema change needed for this) to the front of
 * the ranking, without excluding other relevant pages if a book didn't rack
 * up many major-event pages.
 *
 * Custom actions get the same MAX_VECTOR_RESULTS_HIGH_VALUE budget, but NOT the
 * major-event boost — that's specifically a finale/climax heuristic, not a
 * general "this moment matters" one. Note MAX_VECTOR_RESULTS_HIGH_VALUE is
 * genuinely shared between both cases now, not finale-exclusive despite the
 * name — kept the existing constant rather than adding a new one, since
 * "wider retrieval budget for a high-value moment" is exactly what both
 * cases need and a rename would ripple through every file that already
 * references it for no real gain.
 *
 * No detection of WHICH character/place a custom action names is needed
 * here — retrieveSimilarPages already does cosine similarity against the
 * full query text (buildCurrentSceneQuery), so a name mentioned in a custom
 * action naturally pulls in pages that mention it, the same way it would
 * for a preset action. This just widens how many results come back.
 */
async function buildRelevantPastEventsBlock(actionedPage: CandidateGenerationPage, book: Book, state: StoryState): Promise<string> {
  try {
    const { isFinale, isLastPage } = getStoryStateInfo(state);
    const isFinalePage = isFinale || isLastPage;
    const isCustomAction = actionedPage.action?.type === 'custom';
    const isHighValueMoment = isFinalePage || isCustomAction;

    const query = buildCurrentSceneQuery(actionedPage);
    const branchId = actionedPage.branchId ?? 'main';
    const results = await retrieveSimilarPages(
      query,
      book.id,
      branchId,
      actionedPage.page,
      isHighValueMoment ? MAX_VECTOR_RESULTS_HIGH_VALUE : undefined,
      isFinalePage ? { prioritizeMajorEvents: true } : undefined // major-event boost stays finale-only
    );

    if (!results.length) return '';

    const header = isFinalePage
      ? 'RELEVANT PAST EVENTS & EMOTIONAL CALLBACKS (semantic retrieval):'
      : isCustomAction
        ? 'RELEVANT PAST EVENTS (semantic retrieval, expanded for custom action):'
        : 'RELEVANT PAST EVENTS (semantic retrieval):';

    return [
      header,
      ...results.map(r => `- Page ${r.page} (similarity: ${r.similarity.toFixed(2)}): ${r.sourceText}`),
    ].join('\n');
  } catch (error) {
    console.error(`[buildRelevantPastEventsBlock] ⚠️ Retrieval failed, continuing without it:`, getErrorMessage(error));
    return '';
  }
}

/**
 * Use Case 2 — one "Earlier interactions (recalled)" block per character,
 * for interactions that have scrolled out of the live MAX_PAST_INTERACTIONS
 * (5) sliding window formatCharactersForPrompt() already shows in full.
 * oldestVisiblePage per character = the lowest page among their current
 * pastInteractions — retrieval only looks further back than that, so it
 * never duplicates what's already displayed. Falls back to actionedPage.page
 * (i.e. "everything before now") when a character has no pastInteractions
 * yet.
 *
 * Promise.allSettled — one character's retrieval failing must never block
 * or drop the others. Never throws; a character simply gets no recalled
 * block if its retrieval fails.
 *
 * Custom actions (action.type === 'custom') get MAX_VECTOR_RESULTS_HIGH_VALUE
 * instead of the default per-character limit — same "reader spent credits
 * on a deliberate moment" reasoning as buildRelevantPastEventsBlock, applied
 * consistently here even though it matters less: this function already runs
 * for every tracked character regardless of what the action says, so the
 * only thing custom-action mode changes is how many recalled interactions
 * come back per character, not whether the character gets checked at all.
 */
async function buildCharacterRecallBlocks(
  characters: Record<string, CharacterMemory> | undefined,
  actionedPage: CandidateGenerationPage,
  book: Book
): Promise<Record<string, string>> {
  if (!characters || !Object.keys(characters).length) return {};

  const query = buildCurrentSceneQuery(actionedPage);
  const branchId = actionedPage.branchId ?? 'main';
  const limit = actionedPage.action?.type === 'custom' ? MAX_VECTOR_RESULTS_HIGH_VALUE : undefined;
  const blocks: Record<string, string> = {};

  await Promise.allSettled(Object.entries(characters).map(async ([characterId, character]) => {
    try {
      const pastPages = (character.pastInteractions ?? []).map((i: PastInteraction) => i.page);
      const oldestVisiblePage = pastPages.length ? Math.min(...pastPages) : actionedPage.page;
      const results = await retrieveCharacterInteractions(query, book.id, branchId, characterId, oldestVisiblePage, limit);
      if (results.length) {
        blocks[characterId] = results.map(r => `(page ${r.page}) ${r.sourceText}`).join(' ');
      }
    } catch (error) {
      console.error(`[buildCharacterRecallBlocks] ⚠️ Retrieval failed for ${characterId}:`, getErrorMessage(error));
    }
  }));

  return blocks;
}

/**
 * Use Case 5 — same pattern as buildCharacterRecallBlocks, for place key
 * events that have scrolled out of the live MAX_PLACE_EVENTS (8) sliding
 * window formatPlacesForPrompt() already shows in full. Does NOT touch
 * calculatePlaceFamiliarity() — that stays deterministic and synchronous,
 * untouched.
 *
 * Same custom-action widening as buildCharacterRecallBlocks — see its
 * doc comment for the reasoning.
 */
async function buildPlaceRecallBlocks(
  places: Record<string, PlaceMemory> | undefined,
  actionedPage: CandidateGenerationPage,
  book: Book
): Promise<Record<string, string>> {
  if (!places || !Object.keys(places).length) return {};

  const query = buildCurrentSceneQuery(actionedPage);
  const branchId = actionedPage.branchId ?? 'main';
  const limit = actionedPage.action?.type === 'custom' ? MAX_VECTOR_RESULTS_HIGH_VALUE : undefined;
  const blocks: Record<string, string> = {};

  await Promise.allSettled(Object.entries(places).map(async ([placeId, place]) => {
    try {
      const pastPages = (place.keyEvents ?? []).map(e => e.page);
      const oldestVisiblePage = pastPages.length ? Math.min(...pastPages) : actionedPage.page;
      const results = await retrievePlaceEvents(query, book.id, branchId, placeId, oldestVisiblePage, limit);
      if (results.length) {
        blocks[placeId] = results.map(r => `(page ${r.page}) ${r.sourceText}`).join(' ');
      }
    } catch (error) {
      console.error(`[buildPlaceRecallBlocks] ⚠️ Retrieval failed for ${placeId}:`, getErrorMessage(error));
    }
  }));

  return blocks;
}

/**
 * Use Case 4 — one "Earlier clues (recalled)" block per thread, for clues
 * that have scrolled out of formatActiveThreads()'s live MAX_THREADS_CLUES
 * display window. Unlike character interactions/place events,
 * StoryThread.clues is never trimmed at STORAGE time (processThreadUpdates
 * just .push()es) — only at display time — but the recall problem is the
 * same: anything beyond the displayed window is invisible to the AI unless
 * surfaced here. oldestVisiblePage per thread = the lowest discoveredAtPage
 * among the clues currently displayed for it; falls back to actionedPage.page
 * when a thread has no clues yet.
 *
 * Same custom-action widening as buildCharacterRecallBlocks/
 * buildPlaceRecallBlocks — see buildCharacterRecallBlocks' doc comment for
 * the reasoning.
 */
async function buildClueRecallBlocks(
  threads: StoryThread[] | undefined,
  actionedPage: CandidateGenerationPage,
  book: Book
): Promise<Record<string, string>> {
  if (!threads?.length) return {};

  const query = buildCurrentSceneQuery(actionedPage);
  const branchId = actionedPage.branchId ?? 'main';
  const limit = actionedPage.action?.type === 'custom' ? MAX_VECTOR_RESULTS_HIGH_VALUE : undefined;
  const blocks: Record<string, string> = {};

  await Promise.allSettled(threads.map(async (thread) => {
    try {
      const pastPages = (thread.clues ?? []).map(c => c.discoveredAtPage);
      const oldestVisiblePage = pastPages.length ? Math.min(...pastPages) : actionedPage.page;
      const results = await retrieveClues(query, book.id, branchId, thread.threadId, oldestVisiblePage, limit);
      if (results.length) {
        blocks[thread.threadId] = results.map(r => `(page ${r.page}) ${r.sourceText}`).join(' ');
      }
    } catch (error) {
      console.error(`[buildClueRecallBlocks] ⚠️ Retrieval failed for thread ${thread.threadId}:`, getErrorMessage(error));
    }
  }));

  return blocks;
}

function formatNextPageStoryContextPrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, previousPages, book, relevantPastEventsBlock } = params;
  const { actions, page: currentPage, calendarDate, elapsedDays } = actionedPage;
  const { mc, storyStartDate } = book;
  const { contextHistory, plotFlags, factsHistory, inventory, injuries, hiddenState } = state;
  const { phase, phaseGoal } = getStoryStateInfo(state);

  // MC current state: inventory + injuries change every few pages,
  // so they live here in the dynamic prompt rather than in the cached documents.
  const mcCurrentState = getMainCharacterInfo({mc, state: { inventory, injuries }});

  // Story summary up until now with temporal context
  // To consider: should we consolidate temporal context into "current situation"?
  const storySummary = contextHistory || 'No story summary yet.';
  const storyContext = ((): string => {
    const { elapsedMinutes } = hiddenState?.worldClock ?? {};
    const temporalContext = [
      storyStartDate ? `Story started on: ${storyStartDate}` : '',
      calendarDate ? `Current date: ${calendarDate}` : '',
      elapsedDays ? `Day: ${elapsedDays + 1}` : '',
      elapsedMinutes ? `Time elapsed since last action: ~${formatMinutes(elapsedMinutes)}` : '',
    ].filter(Boolean);

    if (temporalContext.length) return [
      `- Summary: ${storySummary}`,
      ...temporalContext
    ].join('\n- ');

    return storySummary;
  })();

  return `CURRENT PHASE:
${phase} ${phaseGoal}

MAIN CHARACTER (POV):
${mcCurrentState}

STORY CONTEXT:
${storyContext}

${relevantPastEventsBlock ? `${relevantPastEventsBlock}\n\n` : ''}${formatRecentMajorEvents(plotFlags)}

CURRENT FACTS:
${formatCurrentFacts(factsHistory)}

PREVIOUS PAGES:
${formatPreviousPagesForPrompt(currentPage, previousPages, plotFlags)}

CURRENT PAGE:
${formatPreviousPageEntry(actionedPage, plotFlags.filter(f => f.page === currentPage))}

The next page opening must directly continue from that last sentence while carrying out selected action.

CURRENT SITUATION (What just happened):
${formatCurrentSituationForPrompt(actionedPage, state)}

ACTION SELECTION:
Available choices:
${formatActionChoices(actions)}

Selected:
${formatSelectedAction(actionedPage)}

The next page opening should answer: "What happened immediately after MC ("I") chose this action?"
Write that moment before advancing the scene.`;
}

function formatNextPageNarrativePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, relevantFutureNoteKeys, book, clueRecallBlocks } = params;
  const { flags, psychologicalProfile, hiddenState, threads, memoryIntegrity, futureNotes, healthStatus, sanityState } = state;
  const stateInfo = getStoryStateInfo(state);
  const { currentPage, phase } = stateInfo;
  const { calendarDate, elapsedDays } = actionedPage;

  return `NARRATIVE STYLE & PROSE ATMOSPHERE:
${createNarrativeStyle(state).instructions}

PSYCHOLOGICAL FLAGS (Accumulated):
${formatPsychologicalFlags(flags, memoryIntegrity)}

PSYCHOLOGICAL PROFILE (Behavioral analysis):
${formatPsychologicalProfile(psychologicalProfile)}

---
HIDDEN STATE (Influence writing, don't reveal):
${formatHiddenState(hiddenState, currentPage)}

COMPOSURE (Reader resource — not memory integrity):
${formatSanityState(sanityState)}

ROUTE MEMORY (Influence writing, don't reveal):
${formatRouteContext(state)}

FUTURE NOTES (What should happen later?):
${formatFutureNotes({
  futureNotes,
  currentPage,
  currentPhase: phase,
  currentDay: elapsedDays ? (elapsedDays + 1) : undefined,
  currentDate: calendarDate,
  currentHealthStatus: healthStatus,
  currentStability: psychologicalProfile.stability,
  sortedUnscheduledKeys: relevantFutureNoteKeys,
})}

---
${formatThreadsPrompt(threads, stateInfo, clueRecallBlocks)}

---
${formatEndingPrompt(state, book)}`;
}

/**
 * Builds a complete prompt with all placeholders replaced by actual values
 * 
 * This function takes the main character profile and current story state,
 * then replaces all template placeholders in the user prompt with real data.
 * This enables personalized narrative generation based on character psychology
 * and story progression.
 * 
 * @param state - Current story state with progression, flags, and hidden values
 * @returns Complete prompt string ready for AI generation
 */
function buildEndingRules(state: StoryState): string {
  const { psychologicalProfile, hiddenState, viableEnding } = state;
  const { isLastPage, isFinale, finalePhase = "EARLY", pageProgress } = getStoryStateInfo(state);
  const { profileShift, endingPlan } = hiddenState;
  const { type = "fake_escape", outline = [] } = viableEnding ?? {};

  // ==========================================
  // 1. THE LAST PAGE (Absolute Finality)
  // ==========================================
  if (isLastPage) {
    return `- CRITICAL DIRECTIVE: This is the final page of the book. The story ends completely right now.
- DO NOT introduce new threats, new questions, or cliffhangers that imply a continuation.
- DO NOT offer the protagonist a way out. 
- DO NOT write a moralizing, hopeful, or neatly wrapped conclusion.

ENDING EXECUTION:
You must execute the following narrative ending with brutal, chilling finality:
${endingTypes[type]}

TONE & PACING:
- The protagonist must realize the horrifying truth of their situation.
- The final sentence should be a punch to the gut—a bleak, ironic, or terrifying realization that leaves the reader staring at the screen.
- Drop the curtain immediately after the realization.`;
  } 
  
  // ==========================================
  // 2. THE FINALE PHASE (The Climax)
  // ==========================================
  if (isFinale) {
    return `- The story is approaching convergence
- Viable ending is now inevitable regardless of action
- Final pages: disturbing > satisfying

ENDING EXECUTION TEMPLATE (${finalePhase} finale):
${finalePhases[finalePhase].replaceAll("{endingDescription}", endingTypes[type])}

ENDING PRESSURE:
- Increase chaos and urgency
- Collapse multiple mysteries
- Introduce irreversible consequences
- Don't fully explain everything`;
  }

  // ==========================================
  // 3. THE BUILD-UP (Non-Finale)
  // ==========================================
  const trapDirective = buildEndingTrapDirective(endingPlan);
  const optimalEnding = determineOptimalEnding(state);
  // `optimalEnding` is the engine's heuristic OUTPUT — it never mutates the
  // carried `viableEnding`. Only surface the "re-determine" + "Recommended
  // ending type" block when the engine genuinely recommends a CHANGE
  // (`recommendChange: true`, i.e. an armed EndingPlan or a detected profile
  // shift). Otherwise we just steer toward the AI-authored viable ending and
  // must NOT inject a contradictory base-archetype guess (that was BUG-02).
  const nextDestination = outline.find(o => !o.isDone);

  // Three-way ending guidance:
  //  1. recommendChange === true  → engine has a concrete override (armed
  //     EndingPlan or detected profile shift): show the explicit re-determine
  //     block with the heuristic recommendation.
  //  2. recommendChange === false BUT story is past its midpoint → the carried
  //     viableEnding may have silently drifted out of sync (e.g. the MC's
  //     profile intensified without tripping a discrete shift pattern). Rather
  //     than impose a wrong engine guess (BUG-02), give the AI a NEUTRAL
  //     permission to deviate if the narrative clearly outgrew the plan. This
  //     closes that blind spot without ever prescribing a contradictory ending.
  //  3. recommendChange === false and early → say nothing; the plan is fresh.
  const recommendBlock = optimalEnding.recommendChange
    ? `If the current viable ending is no longer viable, re-determine based on:
- Psychological profile (archetype and stability)
- Profile archetype: ${psychologicalProfile.archetype}
- Profile stability: ${psychologicalProfile.stability}
- Psychological flags
- Detected shift: ${profileShift?.detected ? profileShift.shiftType : "none"}

Recommended ending type (heuristic): ${optimalEnding.type}
${optimalEnding.summary}
Because:
${formatKeyValueList(optimalEnding.because)}`
    : pageProgress > 0.5
      ? `The planned ending is currently "${type}". You MAY deviate from it if the story has clearly outgrown this plan — but ONLY if strongly justified by the established narrative, and NEVER telegraph the change. Do not invent a replacement ending spec; let the deviation emerge naturally from the scene.`
      : '';

  return `- Gradually steer story toward viable ending plan${nextDestination ? ` (next in outline: "${nextDestination.text}")` : ''}
- IMPORTANT: NEVER SPOIL this ending plan
- Plant small hints across pages; don't fully explain or reveal early
- Increase hint intensity as story progresses: early pages → very subtle, later pages → more obvious but still indirect
${trapDirective ? `\n${trapDirective}\n` : ''}
${recommendBlock}`;
}

/**
 * Translates an armed EndingPlan into concrete narrative direction for the AI.
 * Returns null if no active plan, so the caller can cleanly omit it.
 */
function buildEndingTrapDirective(endingPlan?: EndingPlan): string | null {
  if (!endingPlan?.armed) return null;

  if (endingPlan.fakeToReal) {
    // Trap is springing — tell the AI exactly what to execute
    const executionGuide: Record<string, string> = {
      fake_relief_twist:
        "MC has just been given false hope. Now destroy it.\n" +
        "• Show the escape route closing\n" +
        "• The 'safe' person reveals something wrong\n" +
        "• The relief was the trap — make the reader feel the rug pulled",
      loop_trap:
        "MC believes the ordeal is over. It isn't.\n" +
        "• Introduce one detail that echoes the very beginning\n" +
        "• Something familiar appears in the wrong context\n" +
        "• End with the reader realizing the loop never broke",
      identity_reveal:
        "MC believes they finally understand who they are. They are wrong.\n" +
        "• Contradict a core assumption the MC has held all story\n" +
        "• Show a detail that reframes every prior action in a darker light\n" +
        "• Revelation should feel inevitable in hindsight",
    };
    const guide = executionGuide[endingPlan.type] ?? "Shatter the false resolution — horror was always here.";
    return `ACTIVE TRAP — EXECUTE NOW:\n${guide}`;
  }

  // Trap is armed but not yet springing — build the false calm
  const buildUpGuide: Record<string, string> = {
    fake_relief_twist:
      "BUILD FALSE SAFETY: MC should be moving toward something that looks like escape.\n" +
      "• Reduce immediate threat slightly — don't remove tension, soften its edge\n" +
      "• Let a character seem trustworthy for once\n" +
      "• Plant one small 'almost normal' detail that feels like progress",
    loop_trap:
      "BUILD CYCLICAL FAMILIARITY: Plant echoes of earlier pages.\n" +
      "• Repeat a sensory detail from a much earlier scene in a slightly wrong context\n" +
      "• MC should begin to feel 'this is almost over'\n" +
      "• Don't close the loop yet — hint that closure is near",
    identity_reveal:
      "BUILD MISPLACED CERTAINTY: Let MC feel they've understood something.\n" +
      "• Reinforce a belief they hold about themselves or another character\n" +
      "• Make MC feel competent, observant, correct — just this once\n" +
      "• Reader should feel safe. They are not.",
  };
  const buildUp = buildUpGuide[endingPlan.type] ?? "Steer toward false resolution — safety is the trap.";
  return `ENDING TRAP ARMED — PREP PHASE:\n${buildUp}`;
}

/**
 * Formats psychological flags for prompt display
 * Answers: "What emotional resources currently dominate the player?"
 * 
 * Creates a formatted string of all psychological flags
 * with their current levels for AI guidance.
 * 
 * @param flags - Psychological flags object
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * PSYCHOLOGICAL FLAGS (Accumulated):
 * • Trust: low
 * • Fear: medium
 * • Guilt: medium
 * • Curiosity: high
 * • Memory Integrity: fragmented
 */
function formatPsychologicalFlags(flags: PsychologicalFlags, memoryIntegrity: MemoryIntegrity): string {
  return `• Trust: ${flags.trust}
• Fear: ${flags.fear}
• Guilt: ${flags.guilt}
• Curiosity: ${flags.curiosity}
• Memory Integrity: ${memoryIntegrity} (recall reliability — how accurately past events are remembered; distinct from Composure below)`;
}

/**
 * Formats the reader-facing composure resource for the AI prompt.
 *
 * Composure is a game HUD meter (0–100). It is NOT:
 * - memoryIntegrity (recall reliability)
 * - psychologicalProfile.stability (behavioral lens)
 * - hiddenState.realityStability (world rules)
 *
 * The AI should pressure the MC when composure is low, and enter crisis
 * mode when crashed — without ever naming the meter to the reader.
 * @see SANITY_STATE_ARCHITECTURE.md.
 */
function formatSanityState(sanityState: SanityState | undefined): string {
  const { composure, maxComposure, hasCrashed, crashedAtPage } = sanityState ?? SANITY_STATE_DEFAULTS;
  const ratio = maxComposure > 0 ? composure / maxComposure : 0;

  // hasCrashed is the sole source of truth once composure hits 0 — updateSanity
  // and spendComposureToResistReality both set composure=0 and hasCrashed=true
  // atomically, so there's no page where one is true without the other.
  const pressure = hasCrashed
    ? 'CRISIS — force psychological collapse: no safe choices, reality fractures, identity slips'
    : ratio <= 0.25 ? 'CRITICAL — barely holding on. Tunnel vision, panic, poor judgment. World pressure feels crushing'
    : ratio <= 0.5  ? 'STRAINED — stress shows in body and thought. Brief lucidity still possible between blows'
    : ratio <= 0.75 ? 'WEARING — tension accumulates. Occasional cracks; not yet broken'
    : 'HOLDING — MC can still function under pressure. Allow clear thought when the scene permits';

  const crashNote = hasCrashed && crashedAtPage
    ? `\n• Crashed at page: ${crashedAtPage} (sticky crisis — do not restore safety)`
    : '';

  return `• Composure: ${composure}/${maxComposure}${hasCrashed ? ' [CRASHED]' : ''}
• Pressure: ${pressure}${crashNote}
• Never name "composure" or a sanity meter to the reader — pressure the prose, not the label.`;
}

/**
 * Formats psychological profile for prompt display
 * Answers: "Given the state accumulated over time, what kind of person is emerging?"
 * 
 * Creates a formatted string of psychological profile
 * with archetype, stability, traits, manipulation affinity,
 * and specific tactics for horror personalization.
 * 
 * @param profile - Psychological profile object
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * PSYCHOLOGICAL PROFILE (Behavioral analysis):
 * • Archetype: the_paranoid — Tactics: Validate their worst fears. Scatter subtle, unreliable clues that make every shadow and ally seem like a lethal threat.
 * • Stability: cracking — Impact: Under psychological stress. Experiencing paranoia, doubt, intrusive thoughts, or growing instability. → Interpret ambiguous events with growing suspicion.
 * • Traits: suspicion, anxiety, hypervigilance
 * 
 * PERSONALIZED HORROR (Manipulation Vector):
 * Target reasoning patterns, distorted reality, question perceptions
 */
function formatPsychologicalProfile(profile: PsychologicalProfile): string {
  const { archetype, stability, dominantTraits, manipulationAffinity } = profile;

  return `• Archetype: ${archetype} — Tactics: ${archetypes[archetype]}
• Stability: ${stability} — Impact: ${stabilityLevels[stability]}
• Dominant traits: ${dominantTraits.length ? dominantTraits.join(', ') : 'none established'}

PERSONALIZED HORROR (Manipulation Vector):
${manipulationAffinities[manipulationAffinity]}

Goal: Make the MC feel "This story knows exactly how I think and is actively using it against me."`;
}

/**
 * Formats route context for prompt display
 * 
 * Creates a formatted string of route memory information
 * including past actions with hints, trauma tags, and difficulty level.
 * 
 * @param state - Story state containing route information
 * @returns Formatted string for prompt inclusion
 */
function formatRouteContext(state: StoryState): string {
  const { traumaTags, difficulty } = state;
  return `• Trauma tags: ${traumaTags.join(', ')}
• Difficulty: ${difficulty}`;
}


/**
 * Formats plot flags and recent major events for anti-repetition guidance.
 *
 * Shows plot flags and the most recent major events so the AI can avoid
 * generating similar major beats in close succession.
 * 
 * @example
 * • Page 18 (place: Sarah's house): [discovery] Ethan finds the basement key
 * • Page 21: [revelation] Sarah learns her father is alive
 * • Page 24: [betrayal] Marcus secretly contacted the cult (MAJOR)
 *
 * @param plotFlags Story plot flags
 * @param limit Maximum number of recent major events to include
 * @returns Formatted major events section
 */
function formatRecentMajorEvents(plotFlags: PlotFlag[]): string {
  const recentMajorEvents = plotFlags
    .filter(flag => flag.isMajorEvent)
    .sort((a, b) => a.page - b.page)
    .slice(-MAX_RECENT_MAJOR_EVENTS);

  if (!recentMajorEvents.length) return 'No recent major events.';
  const majorEventsFormatted = recentMajorEvents.map(f => {
    return formatPlotFlag(f, { showSceneInfo: false, showMajorFlag: false });
  }).join('\n');
  return `Recent Major Events (avoid repeating similar major beats too soon):\n${majorEventsFormatted}`;
}

function formatPlotFlag(flag: PlotFlag, options?: { showSceneInfo?: boolean, showPageHeader?: boolean, showMajorFlag?: boolean, showDateTime?: boolean }): string {
  const { showSceneInfo = true, showPageHeader = true, showMajorFlag = true, showDateTime = true } = options ?? {};
  const sceneInfo = showSceneInfo ? `${[flag.placeId && `place: ${flag.placeId}`, ...(showDateTime ? [flag.calendarDate && `date: ${flag.calendarDate}`, flag.timeOfDay && `time: ${flag.timeOfDay}`] : [])].filter(Boolean).join(', ')}` : '';
  const pageHeader = showPageHeader ? `• Page ${flag.page}${sceneInfo ? ` (${sceneInfo})` : ''}: ` : '';
  return `${pageHeader}[${flag.type}] ${flag.fact}${showMajorFlag && flag.isMajorEvent ? ` (MAJOR)` : ''}`;
}

/**
 * Formats current facts for prompt display
 * 
 * Extracts the most recent fact for each key from the facts history
 * for current canonical facts, sorted by `key` alphabetically.
 * 
 * Categorized per type, example:
 * Character:
 * • character.harlow.favorite_food: pizza (from page 2)
 * • character.clara.favorite_color: red (from page 4)
 * World:
 * • world.monster.appearance: every 1 AM (from page 9)
 */
function formatCurrentFacts(factsHistory: Record<string, FactHistory[]>, groupByCategory: boolean = false): string {
  const entries: [string, FactHistory][] = [];

  // 1. Single-pass extraction (Faster than flatMap/filter combinations)
  for (const [key, history] of Object.entries(factsHistory)) {
    const lastFact = history.at(-1);
    if (lastFact) entries.push([key, lastFact]);
  }

  if (entries.length === 0) return 'No facts discovered yet.';

  // 2. Sort EVERYTHING alphabetically upfront (Highly optimal)
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  // 3. Early return for the flat list
  if (!groupByCategory) {
    return entries
      .map(([key, fact]) => `• ${key}: ${fact.value} (from page ${fact.page ?? '?'})`)
      .join('\n');
  }

  // 4. Group by type (Preserves the sorted order inherently)
  const groups: Record<string, typeof entries> = {};
  const knownTypes = Object.keys(factTypes);

  for (const entry of entries) {
    const [key, fact] = entry;
    
    // Restored inference logic for strict parity with Version 1
    const inferredType = knownTypes.find(t => key.startsWith(`${t}.`));
    const type = fact.type ?? inferredType ?? 'other';
    
    (groups[type] ??= []).push(entry);
  }

  // 5. Build final string based on knownTypes order
  const parts: string[] = [];
  for (const type of knownTypes) {
    const items = groups[type];
    if (!items || items.length === 0) continue;

    const lines = items.map(([key, fact]) => `• ${key}: ${fact.value} (from page ${fact.page ?? '?'})`);
    parts.push(`${ucfirst(type)}:\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Formats hidden state with influence descriptions
 * 
 * Creates a formatted string combining hidden state levels
 * with their detailed influence descriptions for AI guidance.
 * 
 * @param hiddenState - Hidden state object
 * @returns Formatted string for prompt inclusion
 */
function formatHiddenState(hiddenState: HiddenState, currentPage: number): string {
  const { truthLevel, threatProximity, realityStability, endingPlan, profileShift } = hiddenState;
  const truthInfluence = truthLevels[truthLevel as keyof typeof truthLevels];
  const threatInfluence = threatProximities[threatProximity as keyof typeof threatProximities];
  const realityInfluence = realityStabilities[realityStability as keyof typeof realityStabilities];

  const lines: string[] = [
    `• Truth level: ${truthInfluence ?? truthLevel}`,
    `• Threat proximity: ${threatInfluence ?? threatProximity}`,
    `• Reality stability: ${realityInfluence ?? realityStability}`,
  ];

  if (endingPlan?.armed) {
    if (endingPlan.fakeToReal) {
      lines.push(
        `• Ending trap: SPRINGING — false resolution has been set up; now shatter it. The horror lives behind the relief.`
      );
    } else {
      const phasesRemaining = Math.max(0, endingPlan.triggerPage - currentPage);
      const executionHint = {
        fake_relief_twist: "manufacture false safety — let the MC feel escape is within reach",
        loop_trap:         "create a sense of completion that subtly circles back to the start",
        identity_reveal:   "let the MC believe they finally understand themselves — they are profoundly wrong",
      }[endingPlan.type as string] ?? "steer toward a false sense of resolution";
      lines.push(
        `• Ending trap: ARMED (${phasesRemaining} page${phasesRemaining !== 1 ? "s" : ""} until trigger) — ${executionHint}`
      );
    }
  }

  if (profileShift?.detected) {
    lines.push(
      `• Behavioral shift: "${profileShift.shiftType}" detected at page ${profileShift.detectedAt} — horror should now exploit this new vulnerability`
    );
  }

  return lines.join("\n");
}

/**
 * Applies AI bounded sampling adjustments to base config.
 * 
 * This function adjusts AI parameters based on the selected action type,
 * applying configured adjustments while respecting defined bounds.
 * 
 * @param config - Base AI configuration to modify
 * @param actionConfig - Action-specific configuration with adjustments and bounds
 * @returns New configuration object without mutating the original
 */
function applyActionConfig(
  config: AIChatConfig,
  adjustment: AIActionConfig
): AIChatConfig {
  return {
    ...config,
    temperature: Math.max(
      adjustment.temperature.min,
      Math.min(
        adjustment.temperature.max,
        config.temperature + adjustment.temperature.adjustment
      )
    ),
    topP: Math.max(
      adjustment.topP.min,
      Math.min(
        adjustment.topP.max,
        config.topP + adjustment.topP.adjustment
      )
    ),
    topK: Math.max(
      adjustment.topK.min,
      Math.min(
        adjustment.topK.max,
        config.topK + adjustment.topK.adjustment
      )
    )
  };
}

/**
 * Applies capping limits to AI configuration
 * 
 * This function caps AI parameters at specified maximum values,
 * used for JSON reliability and other constraint scenarios.
 * 
 * @param config - Base AI configuration to modify
 * @param capConfig - Configuration with maximum limits for parameters
 * @returns Modified AI configuration with applied caps
 */
function applyConfigCaps(config: AIChatConfig, capConfig: AIChatConfigCaps): AIChatConfig {
  if (capConfig.maxTemperature !== undefined) {
    config.temperature = Math.min(config.temperature, capConfig.maxTemperature);
  }
  
  if (capConfig.maxTopP !== undefined) {
    config.topP = Math.min(config.topP, capConfig.maxTopP);
  }
  
  if (capConfig.maxTopK !== undefined) {
    config.topK = Math.min(config.topK, capConfig.maxTopK);
  }
  
  return config;
}

/**
 * Determines AI sampling parameters for story generation.
 *
 * This function configures the model's token sampling behavior, controlling
 * how much variation and novelty are allowed during text generation.
 *
 * Important:
 * - Sampling affects wording, phrasing diversity, and lexical creativity.
 * - Sampling does NOT control plot quality, character consistency,
 *   psychological realism, pacing, mystery structure, or narrative logic.
 * - Those aspects are primarily driven by prompts, story state, memory,
 *   and narrative tracking systems.
 *
 * Design Philosophy:
 * - Maintain a stable writing voice throughout the story.
 * - Avoid large sampling swings that can make the prose feel as if it was
 *   written by different authors across pages.
 * - Use prompt instructions and story-state data to control narrative
 *   progression rather than relying on temperature changes.
 * - Apply only small sampling adjustments for special situations where
 *   additional novelty is beneficial (such as twists, revelations,
 *   unexpected discoveries, or major perspective shifts).
 *
 * Reliability:
 * - JSON generation and structured outputs may require stricter sampling.
 * - Provider-specific caps can be applied to improve schema adherence.
 * - Final values are validated and clamped to supported bounds.
 *
 * Rationale:
 * Stable sampling generally produces more consistent prose quality,
 * narrative voice, and emotional tone than phase-based temperature
 * adjustments. Story progression should emerge from narrative context,
 * not from increasingly restrictive sampling parameters.
 *
 * @param state Current story state and hidden narrative information.
 * @param action Optional player action that may influence generation behavior.
 * @returns AI configuration optimized for story writing and output reliability.
 */
function determineAIConfig(state: StoryState, baseConfig: AIChatConfig = AI_CHAT_CONFIG_CREATIVE): AIChatConfig {
  let config = { ...baseConfig };

  // Apply temporary twist or revelation boost
  if (state.hiddenState.profileShift?.detected) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);
  }

  // Apply capping limits to AI configuration
  config = applyConfigCaps(config, JSON_RELIABILITY_CAPS);

  return validateAIConfig(config);
}

/**
 * Creates AI prompt for book initialization with theme and character
 * 
 * This function generates a comprehensive prompt for AI to create a complete
 * psychological thriller book setup including metadata, first page, and initial
 * story state based on user theme and character preferences.
 * 
 * @param theme - User's desired story theme or concept
 * @param mc - Complete main character profile
 * @returns Formatted prompt string for AI book creation
 * 
 * Example:
 * ```typescript
 * const prompt = buildBookCreationPrompt("haunted mansion mystery", {
 *   name: "Elena Stellaria",
 *   age: 20,
 *   gender: "female"
 * });
 * ```
 */
function buildBookCreationPrompt(params: InitializeBookParams): string {
  const { theme, language, titleIdea, summary, hook, aiComment, mcCandidate } = params;
  const isNonEnglish = !!language && language !== 'en';
  const languageFormatted = formatLanguage(language);

  return `TASK: Create a psychological thriller story from the provided STORY THEME input from user${isNonEnglish ? ` in ${languageFormatted}` : ''}.

LANGUAGE REQUIREMENT:
- Target language: ${languageFormatted}
- Every user-facing text (story content, metadata, narrative, etc) MUST ALWAYS use the specified natural language consistently.
${isNonEnglish ? `- Do not translate the STORY THEME, character names, and existing proper nouns.
- Do not default to English.
- Do not mix languages.` : ''}

STORY THEME:\n"""\n${theme.trim()}\n"""

TITLE IDEA:\n${titleIdea || '-'}

HOOK IDEA:\n${hook || '-'}

SUMMARY IDEA:\n${summary || '-'}

MAIN CHARACTER IDEA:\n- Name: ${mcCandidate?.name || '-'}\n- Age: ${mcCandidate?.age || '-'}\n- Gender: ${mcCandidate?.gender || '-'}\n- Bio: ${mcCandidate?.bio || '-'}

AI COMMENTARY:\n${aiComment || '-'}

STORY SETUP:
- Establish unease immediately — not fear yet, but something subtly wrong.
- Tension should feel personal to the MC, not generically atmospheric.
- Anchor vulnerability to the MC's specific bio, not generic relatability.
- The opening disturbance must be present, unexplained, and impossible to fully dismiss.

STORY PLANNING CONSISTENCY:
- All planning outputs must support one coherent narrative.
- The viableEnding should be achievable using the planned characters and futureNotes.
- Planned characters should contribute to the mystery, conflict, or ending.
- FutureNotes should naturally lead toward the viableEnding.
- Initial characters should establish relationships that later evolve.
- Avoid introducing characters, places, or mysteries that never become relevant.
- Think of this initialization as creating the story bible for an entire novel.
- Plan enough long-term structure that future AI generations can maintain consistent characters, relationships, mysteries, locations, and emotional arcs across dozens of pages.

FIRST PAGE RULES:
- Open in the middle of a moment, not an introduction.
- Something must feel wrong, contradictory, or slightly off by the end of the first paragraph.
- End on tension, uncertainty, or a soft cliffhanger — never resolution.
- Mood must reflect the disturbance, not the genre.
- Max ${MAX_WORDS_PER_PAGE} words.

BRANCHING ACTIONS:
${getActionRulesText({ isFirstPage: true, mode: params.mode })}`;
}

const firstBookFieldInstructions: string = `Book Metadata:
- title: ${BOOK_TITLE_LENGTH}. If provided in theme, use it. Otherwise, NEVER start with "The" except it's really good. Be creative, mysterious, visceral (you feel it), memorable, not generic.
- hook: ${HOOK_LENGTH}. Immediate intrigue. Psychological tension.
- summary: ${SUMMARY_LENGTH}. Sets up premise without revealing the ending plan.
- keywords: ${KEYWORDS_COUNT} kebab-case tags for theme, genre, mood, and story categorization (keep each short).
- totalPages: min ${BOOK_MIN_PAGES}, max ${BOOK_MAX_PAGES}. Avoid exact multiples of 10. Let theme complexity and MC arc influence the count. If user mention anything about total pages, respect it as long as it's within bounds.
- language: language code (ISO 639-1).

mainCharacter:
- Infer a character whose personality makes the theme more psychologically dangerous for them specifically.
- name: if provided, strictly use it. If not provided, generate unusual (rare) but memorable name idea based on age and language context.
- knownName: preferred alias or nick referred by other characters.
- bio: if provided, enhance it. If not provided, infer from theme. Must include at least one psychological trait that will be used against them.
- The MC should have a clear personal goal, fear, wound, or unresolved need that naturally supports the viableEnding.
- Avoid making the MC merely an observer of the mystery.

initialPlace:
- familiarity: 0.0-1.0. A place the MC just arrived at = 0.1. Childhood home = 0.9.
- context: ${PLACE_CONTEXT_LENGTH}. Evocative, not descriptive.
- hints: any known clue about the place.

initialCharacters:
- It's meant for characters beside MC who are physically present in the scene. Don't include MC (the POV) here.
- If MC is alone in this first page, then it should be an empty array.
- Include only side characters who meaningfully exist at story start.
- At least one should have a relationship that can be corrupted.
- bio: must include one trait that could become a source of threat or betrayal.
- potentialTwist: set to match behavior and twist setup.
- traits: only story-relevant (e.g., skills, hobbies).
- Every initial character should serve at least one purpose: deepen the MC, increase tension, introduce information, create conflict, or foreshadow future events.
- Avoid background characters that have no narrative value.

plannedCharacters:
- Infer any side characters from the theme that have not yet appeared on this first page.
- You may infer additional major characters if they naturally strengthen the premise.
- Do not include background NPCs or disposable one-scene characters.
- Each planned character should have a clear future narrative purpose.
- plannedIntro: explain how this character planned to be introduced (when they are likely to appear, why they matter, how they connect to the MC or central mystery).
- storyPurpose: why this character exists in the story and how they contribute to the MC's journey, central mystery, or ending (avoid describing specific future events).

initialRelationships:
- Only between side characters (excluding MC). If initial characters is less than two, omit it.
- For relationship which targetting MC, put it in character's relationshipToMC.

firstPage:
- text: follow the rules in "WRITING STYLE:" and "PAGE FORMAT:" creatively (max ${MAX_WORDS_PER_PAGE} words).
- keyEvents: ${KEY_EVENT_LENGTH}. Plot-level facts happened in this page.
- charactersPresent: side characters in the scene besides MC. Must match characters in initialCharacters. sceneFocus: between 0.0 to 1.0 (highest = character to focus).
- keyObjects: objects introduced or used this page that may have future narrative significance.
- momentum: narrative pressure or urgency level in the first page. Thriller openings often start at "rising" or sometimes "critial", just saying.

initialState:
- flags: set based on opening scene — not defaults.
- difficulty: should reflect how hostile the world is to this MC at the start.
- traumaTags: short evocative phrases for experiences that will haunt the MC later.
- futureNotes: any important notes for future AI turns representing narrative obligations towards the viableEnding (future incidents, characters, place, etc), max ${MAX_FUTURE_NOTES} items.
- plotFlags: significant plot development that affect the overall story trajectory (max 2 per page).
- inventory: if any, what items MC brings, can include the amount, traits, and where is it located now (max ${MAX_INVENTORY_ITEM} item).
- injuries: if any, injuries sustained by the MC in the first page.

viableEnding:
- Choose a thriller ending type and write a ${VIABLE_ENDING_LENGTH} plan describing the story's chilling destination.
- Define the MC's ultimate fate and the final, inescapable state of the central conflict.
- Major threads MUST reach a psychologically disturbing culmination. Do NOT write neat, moralizing, or hopeful resolutions.
- Execute this climax through shocking revelation, tragic sacrifice, inescapable loops, or chilling ambiguity.
- Preserve mystery specifically where it maximizes dread, tension, and horror impact.
- If the user specifies a desired ending in the theme input, adapt it to fit the thriller genre and respect it whenever possible.

initialThreads:
- Represents major unanswered questions, mysteries, goals, or narrative conflicts that keep the reader engaged across multiple pages.
- Every major mystery or long-term conflict introduced in the premise should become a thread.
- Every thread should have a clear question the reader wants answered.
- Prefer a few meaningful threads over many shallow ones.
- Threads may represent mysteries, relationships, investigations, survival goals, conspiracies, or emotional conflicts.
- question: should be something the reader naturally wonders after reading the opening.

futureNotes:
- Represents narrative reminders for future page generation about things that have not happened yet.
- May describe future events, delayed consequences, planned introductions, environmental changes, pacing beats, recurring motifs, or other story obligations.
- Notes may be major or minor depending on their narrative importance.
- Include only information that future AI is unlikely to infer reliably from the current story state.
- Avoid immediate next-page actions, redundant summaries, or information already represented elsewhere.
- Max ${MAX_FUTURE_NOTES} items.

initialFacts:
- Represents long-term story memory, discoveries, or important established facts that influence future turns.
- Only include durable story facts that important to remember 20+ pages later. If unsure, omit it.
- key: consistent ${FACT_KEY_FORMAT}. Type can be either: ${formatOneOf(Object.keys(factTypes))}.
- value: current state. Prefer concise value over long sentence (explanation can be added in reason).
- reason: 1-sentence, why or how it hapenned.

aiFinalComment:
- Use creative thriller-themed wording in specified language.
- Continue and conclude the previous AI commentary.
- Express excitement for the generated book.
- Briefly tease what happens on the first page without spoilers.
- Max ${MAX_FINAL_COMMENT_LENGTH} chars.`;

/**
 * Initializes a complete book with AI-generated content and database persistence
 * 
 * This function orchestrates the complete book creation pipeline:
 * 1. Generates complete main character from candidate
 * 2. Creates AI prompt for book creation based on theme and character
 * 3. Calls AI to generate book metadata and first page
 * 4. Persists book to database with character profile
 * 5. Creates initial story state with psychological profile
 * 6. Persists first page as root page of the book
 * 7. Links story state to first page
 * 8. Pre-generates candidate pages for each action in the first page (fire-and-forget)
 * 9. Invalidates caches and logs user activity
 * 
 * The function provides a complete story foundation with proper database
 * relationships and type-safe operations throughout the pipeline.
 * 
 * @param params.userId - The user's unique identifier for ownership and session
 * @param params.theme - User's desired story theme or concept
 * @param params.mcCandidate - Partial character profile to customize the main character
 * @param params.req - Optional Hono context for activity-log metadata
 * @returns Promise resolving to complete book setup with all components
 * 
 * @example
 * ```typescript
 * const bookSetup = await initializeBook({
 *   userId: "user123",
 *   theme: "haunted mansion mystery",
 *   mcCandidate: { name: "Sarah", age: 28, gender: "female" }
 * });
 * 
 * console.log(`Created book: ${bookSetup.book.displayTitle}`);
 * console.log(`First page: ${bookSetup.firstPage.text}`);
 * console.log(`Initial difficulty: ${bookSetup.initialState.difficulty}`);
 * ```
 * 
 * Initialises a complete book with AI-generated content and persists all
 * components to the database in the correct dependency order.
 *
 * **Two modes of operation:**
 *
 * *Insert mode* (`bookId` param absent):
 * - Used by `POST /api/books` (sync) and `POST /api/books/stream` (SSE)
 * - Creates a brand-new `books` row with the AI-generated content
 * - Runs inside the transaction provided by `executeWithCredits` when called
 *   from `createBookCore`
 *
 * *Update mode* (`bookId` param present):
 * - Used by the GitHub Actions cron runner (`on-demand-book-creation.ts`)
 * - Updates the pre-existing draft row that `POST /api/books/async` created
 * - Does NOT run inside a transaction with credit consumption (the credits were
 *   consumed atomically when the draft was created; this step only fills content)
 *
 * **`tx` / `client` forwarding:**
 * All DB operations (insertBook, insertStoryPage, insertStoryState, updateBook)
 * receive the same `client` reference. When a transaction is provided the whole
 * book creation is atomic with the credit deduction.
 *
 * **Progress reporting:**
 * Two parallel progress streams are maintained:
 * - `onProgress` — SSE events for the frontend (sync/SSE flow only)
 * - `onGenerationProgress` — fire-and-forget DB writes for the polling endpoint
 *   (async/cron flow; no-op when `bookId` / `draftBookId` is absent)
 *
 * @param params     - Full initialisation parameters (see `InitializeBookParams`)
 * @param onProgress - Optional SSE progress callback
 * @returns `{ book, firstPage, initialState, aiComment }`
 *
 * @example
 * // Sync flow (no pre-existing book)
 * const result = await initializeBook({ userId, theme, mcCandidate });
 *
 * // Async/cron flow (updating a draft)
 * const result = await initializeBook({ userId, theme, mcCandidate, bookId });
 */
export async function initializeBook(
  params: InitializeBookParams,
  onProgress?: ProgressCallback
): Promise<CreateBookResponse> {
  const client = params.tx ?? dbWrite;
  const {
    userId,
    theme,
    generateCoverImage = false,
    isOriginal = false,
    aiComment,
    // Future note: if detectedLanguage === `en`, maybe we can consider to pre-define MC name idea via `generateRandomCharacter`
    language: detectedLanguage,
    req,
    bookId: draftBookId,
      advancedOptions,
      mode = 'interactive',
    } = params;

  // ── Internal progress helper ─────────────────────────────────────────────
  //
  // Persists generation progress to `bookGenerations` for the polling endpoint.
  // Fire-and-forget: never blocks the main generation pipeline.
  async function onGenerationProgress(progress: StoryGenerationStep | BookGenerationProgress): Promise<void> {
    if (!draftBookId) return; // No-op for sync/SSE flows without a pre-existing draft

    const progressValues: BookGenerationProgress = typeof progress === 'string' ? { step: progress } : progress;

    // Fire-and-forget with proper rejection handling
    updateBookGenerationStatus({ bookId: draftBookId, ...progressValues }).catch((e) => {
      // Non-fatal: a missed DB write just means the polling endpoint shows a
      // slightly stale step. The generation itself is not affected.
      console.warn('[initializeBook] ⚠️ Failed to persist generation status:', getErrorMessage(e));
    });
  }

  // Resolve writing preset (default to 'default' if not provided)
  const { writingPreset = 'default', developer: developerConfig } = advancedOptions ?? {};

  try {
    // ── 1. Signal initialisation start ───────────────────────────────────────
    await onProgress?.({ type: 'book_initialization_start' });
    await onGenerationProgress('book_initialization'); // TODO: redundant book_initialization (processBookGeneration)

    // ── 2. Build and execute AI prompt for full book creation ─────────────────
    let prompt = buildBookCreationPrompt(params);

    // Append developer promptAppend if present
    if (developerConfig?.promptAppend) {
      const sanitizedAppend = sanitizePromptAppend(developerConfig.promptAppend);
      if (sanitizedAppend) {
        prompt = `${prompt}\n\n---\n${sanitizedAppend}`;
      }
    }

    const baseConfig = applyAdvancedOptions(AI_CHAT_CONFIG_DEFAULT, advancedOptions);

    const response = await executePromptForJSON<BookCreationResponse>(
      {
        prompt,
        configs: {
          schema: BOOK_CREATION_SCHEMA_DEFINITION,
          requiredFields: BOOK_CREATION_REQUIRED_FIELDS,
          fallbackField: 'summary',
          baseOptions: {
            config: baseConfig,
            modelSelection: AI_CHAT_MODELS_WRITING,
            context: 'book-creation',
            logPrompts: true,
            systemPrompt: buildPresetSystemPrompt('first', writingPreset),
          },
        } satisfies AIPromptForJson<BookCreationResponse>,
        jsonStructure: firstBookOutputFormat,
        fieldInstructions: firstBookFieldInstructions,
        reviewChecklist: buildFirstBookReviewChecklist(detectedLanguage),
        // Step 3 (ai_evaluation) happens inside executePromptForJSON
        evaluatorPrompt: buildFirstBookEvaluatorPrompt(params),
      },
      onProgress,
      onGenerationProgress
    );

    // ── 3. Validate AI response ───────────────────────────────────────────────
    if (!response.result) {
      throw new Error('Failed to generate book: no result from AI');
    }

    // ── 4. Destructure AI result ──────────────────────────────────────────────
    const {
      title,
      alternativeTitles,
      totalPages,
      hook,
      summary,
      keywords,
      initialState: generatedInitialState,
      firstPage: generatedFirstPage,
      initialPlace,
      initialCharacters,
      plannedCharacters,
      initialRelationships,
      initialThreads,
      initialFacts,
      mainCharacter: mc,
      language,
      viableEnding: initialEnding,
      futureNotes,
      aiFinalComment,
    } = response.result;

    // Validate first page (text length, JSON leaks, actions)
    validateGeneratedPage(generatedFirstPage, mode, 'initializeBook:firstPage');

    // ── Novel-mode first-page contract ───────────────────────────────────────
    // Novel mode is a single linear path: the opening page must present exactly
    // one action. If the AI produced multiple, randomly keep a single one so the
    // story still opens with a meaningful (non-deterministic) choice.
    let firstPageForBook = generatedFirstPage;
    if (mode === 'novel' && generatedFirstPage.actions.length > 1) {
      const [picked] = generatedFirstPage.actions
        .slice()
        .sort(() => Math.random() - 0.5)
        .slice(0, 1);
      firstPageForBook = { ...generatedFirstPage, actions: [picked] };
    }

    // Normalize viable ending object
    const viableEnding: Ending | undefined = initialEnding ? { ...initialEnding, outline: initialEnding.outline.map(text => ({ text, isDone: false })) } : undefined;

    // ── 4b. Fallback to theme validation metadata if AI output is broken/empty ──
    const fallbackHook = hook?.trim() ? hook : (params.hook || hook);
    const fallbackSummary = summary?.trim() ? summary : (params.summary || summary);

    const isValidMC = mc?.name?.trim() && mc?.age > 0 && mc?.bio?.trim() && mc?.gender;
    const fallbackMC = (() => {
      if (!isValidMC && params.mcCandidate) {
        const candidate: StoryMCCandidate = {
          name: mc.name?.trim() || params.mcCandidate.name,
          age: mc.age > 0 ? mc.age : params.mcCandidate.age,
          gender: mc.gender || params.mcCandidate.gender,
          bio: mc.bio?.trim() || params.mcCandidate.bio,
          knownName: mc.knownName?.trim() || params.mcCandidate.knownName,
        };
        return generateRandomCharacter(candidate);
      }
      return mc;
    })();

    // ── 5. Persist book record ────────────────────────────────────────────────
    await onProgress?.({ type: 'finalizing_start' });
    await onGenerationProgress('finalizing');

    let book: Book;
    let bookId: string;

    if (draftBookId) {
      // Check if the user requested cancellation at the point of no return.
      // If so, archive the book instead of publishing it.
      const [genRow] = await dbRead
        .select({ cancellationRequestedAt: bookGenerations.cancellationRequestedAt })
        .from(bookGenerations)
        .where(eq(bookGenerations.bookId, draftBookId))
        .limit(1);

      const finalStatus: BookStatus = genRow?.cancellationRequestedAt ? 'archived' : 'active';

      // Update existing book record with generated content (async book creation flow)
      await updateBook(draftBookId, {
        title,
        hook: fallbackHook,
        summary: fallbackSummary,
        keywords,
        mc: fallbackMC,
        totalPages,
        language, // Match with theme input
        status: finalStatus, // 'archived' if user cancelled at PoNR, 'active' otherwise
        visibility: isOriginal ? 'public' : undefined,
        originalThemeInput: theme,
        ending: viableEnding,
        advancedOptions // Persist for ongoing page generation
      }, { client });
      
      // Fetch the updated book
      const dbBook = await getBookFromDB(draftBookId, { client });
      if (!dbBook) {
        throw new Error(`Book not found: ${draftBookId}`);
      }

      book = mapBookFromDb(dbBook);
      bookId = draftBookId;
    } else {
      // Insert new book record (sync/SSE flows)
      const newBookData: DBNewBook = {
        userId,
        title,
        totalPages,
        language,
        hook: fallbackHook,
        summary: fallbackSummary,
        keywords,
        mc: fallbackMC,
        isOriginal,
        visibility: isOriginal ? 'public' : undefined,
        originalThemeInput: theme,
        mode, // Book creation mode (story format)
        ending: viableEnding,
        advancedOptions // Persist for ongoing page generation
      };
      const dbBook = await insertBook(newBookData, { client, alternativeTitles });
      book = mapBookFromDb(dbBook);
      bookId = book.id;
    }

    // Define placeId first to be used as scene context
    const placeId = initialPlace.placeId;

    const characters: Record<string, CharacterMemory> = Object.fromEntries<CharacterMemory>(initialCharacters.map<[string, CharacterMemory]>(char => [
      char.characterId,
      {
        ...char,
        pastInteractions: char.pastInteractions?.map<PastInteraction>(i => ({ page: 1, interaction: i, placeId })) ?? [],
        potentialTwist: char.potentialTwist ?? 'none',
        introducedAtPage: 1,
        relationships: initialRelationships.filter(r => r.sourceId === char.characterId).map<CharacterRelationship>(r => {
          return {
            ...r,
            type: r.type || "knows",
            status: r.status || "neutral",
            context: r.context,
            recognitionLevel: r.recognitionLevel,
          } satisfies Record<keyof CharacterRelationship, string>;
        }),
        injuries: char.injuries ?? []
      } satisfies CharacterMemory
    ]));

    const places: Record<string, PlaceMemory> = {
      [placeId]: {
        ...initialPlace,
        visitCount: 1,
        lastVisitedAtPage: 1,
        keyEvents: initialPlace.keyEvents?.map<PastEvent>(e => ({ page: 1, event: e })) ?? [],
        knownConnections: []
      } satisfies PlaceMemory
    };

    // ── 7. Persist first page ─────────────────────────────────────────────────
    const pageToInsert: StoryPage = {
      ...firstPageForBook,
      stateDelta: {},
      placeId,
    };

    // ── MODE BRANCHING CONTRACT (first-page gate) ────────────────────────────
    // The first page is inserted via insertStoryPage (not persistPageWithState),
    // so enforce the mode's action-count rule here as well. For novel mode this
    // guarantees the story opens with exactly one action (a single linear path);
    // interactive/multiverse permit multiple opening choices.
    validatePageActionsForMode(mode, pageToInsert.actions);

    const firstPage = await insertStoryPage(userId, 1, pageToInsert, {
      bookId,
      branchId: 'main',
      aiResponseProvider: response,
      storyStartDate: firstPageForBook.calendarDate
    }, { client });

    const { id: pageId, calendarDate, timeOfDay, actions } = firstPage;
    console.log(`[initializeBook] 📔 First page of "${book.title}" inserted:`, JSON.stringify(filterObjectEntries(firstPage), null, 2));
    console.log(`[initializeBook] 👉 Generated ${actions.length} actions for first page:`, actions.map(a => a.text));

    // ── 8. Build initial story state ──────────────────────────────────────────
    const injuries = generatedInitialState.injuries?.map<Injury>((injury) => ({ ...injury, pageAcquired: 1, placeId })) || [];
    const healthStatus = calculateHealthStatus(injuries, {
      traumaTagCount:  generatedInitialState.traumaTags?.length ?? 0,
      memoryIntegrity: generatedInitialState.memoryIntegrity ?? 'stable',
      fearLevel:       generatedInitialState.flags?.fear ?? 'low',
    });

    // Create initial story state with generated psychological profile
    const initialState: StoryState = {
      ...createEmptyStoryState(pageId, 1, totalPages),
      ...{
        ...generatedInitialState,
        plotFlags: generatedInitialState.plotFlags?.map<PlotFlag>((flag) => ({ ...flag, page: 1, placeId, calendarDate, timeOfDay })) || [],
        threads: initialThreads?.map<StoryThread>((thread) => createStoryThread(thread, 1)) || [],
        inventory: generatedInitialState.inventory?.map<InventoryItem>((item) => ({ ...item, pageAcquired: 1, placeId })) || [],
        injuries,
        healthStatus,
        futureNotes: mapFutureNoteWithKey(futureNotes, 1, []),
        viableEnding,
      },
      hiddenState: createInitialHiddenState(),
      characters,
      plannedCharacters,
      places,
      factsHistory: initialFacts?.length ? Object.fromEntries<FactHistory[]>(
        initialFacts.map<[string, FactHistory[]]>(fact => [
          fact.key,
          [{ ...fact, page: 1 } satisfies FactHistory]
        ])
      ) : {}
    };

    // ── 9. Generate cover image (fire-and-forget for user flows) ─────────────
    if (generateCoverImage) {
      if (isOriginal) {
        // Cron jobs await image generation so the image is ready before the
        // book is marked complete
        await generateAndUpdateBookCoverImage(book, initialState);
      } else {
        // User flows don't block on image generation
        void generateAndUpdateBookCoverImage(book, initialState);
      }
    }

    // ── 10. Persist initial story state ──────────────────────────────────────
    await insertStoryState(bookId, pageId, initialState, 'original', { client });

    // ── 11. Pre-generate candidate pages for first-page actions ──────────────
    if (isOriginal) {
      // Cron job originals: use github-action strategy inline (sequential,
      // await for clean debug logging — not time-sensitive within GitHub Actions).
      const firstUserPage: UserStoryPage = { ...firstPage, selectedActions: [] };
      await ensureCandidatesForPageWithStrategy({
        strategy: 'github-action',
        userId,
        page: firstUserPage,
        currentState: initialState,
        currentBook: book,
      });
    } else {
      // Every other flow (on-demand async, sync/SSE): dispatch a separate
      // GitHub workflow for separation of concerns & isolated run logs.
      // Fire-and-forget — the book response is returned immediately;
      // candidate pages populate in the background.
      triggerCandidateGenerationWorkflow({
        userId,
        pageId: pageId,
        bookId: book.id,
        bookTitle: book.title,
        maxDepth: MAX_BRANCHING_PREGENERATION_DEPTH, // Also pre-generate next-level depths
        context: 'initializeBook'
      }).catch(error => {
        console.error('[initializeBook] ❌ Failed to trigger GitHub workflow:', error);
      });
    }

    // ── 12. Invalidate caches ─────────────────────────────────────────────────
    await invalidateUserBooksCache(userId);
    await invalidateUserProfileCache(userId);

    if (book.status === 'active') {
      await invalidateExploreCache();
      invalidatePopularTagsCache();
    }

    // Portal forum: auto-thread when book is already public+active (soft-fail)
    notifyForumOfBookChange({
      before: { status: 'draft', visibility: 'private' },
      after: {
        id: book.id,
        slug: book.slug,
        title: book.title,
        summary: book.summary,
        hook: book.hook,
        userId: book.userId,
        status: book.status,
        visibility: book.visibility,
        mode: book.mode,
        language: book.language,
        imageUrl: book.imageUrl,
      },
    });

    // ── 13. Log user activity ─────────────────────────────────────────────────
    await logUserActivity({
      userId,
      activityType: 'book_created',
      targetType: 'book',
      targetId: book.id,
      metadata: { theme: theme.trim() },
    }, { req });

    // ── 14. Signal completion ─────────────────────────────────────────────────
    await onGenerationProgress('complete');

    return {
      book,
      firstPage,
      initialState,
      aiComment,
      aiFinalComment
    } satisfies CreateBookResponse;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error('[initializeBook] ❌ Failed to initialize book:', errorMessage);
    // Signal failure to the polling endpoint (fire-and-forget, same as progress updates)
    await onGenerationProgress({ status: 'failed', error: errorMessage });
    throw error;
  }
}

/**
 * Shared setup for both {@link generateNextPage} and {@link generateNextPages}.
 *
 * Validates and clones the story state, advances it based on the selected
 * action, and fetches the previous-page context needed for prompt building.
 * Extracting this eliminates the ~40-line duplication that existed between
 * the two public functions.
 */
async function prepareNextPageGenerationContext(params: BuildNextPageParams): Promise<{
  currentState: StoryState;
  advancedState: StoryState;
  expectedPageNumber: number;
  previousPages: ActionedStoryPage[];
}> {
  const { actionedPage, currentState: providedState } = params;

  if (!providedState) {
    console.warn(`[prepareNextPageGenerationContext] ⚠️ Base state not provided, will be reconstructed from current page`);
  }

  // Clone so mutations inside advanceStoryState never bleed back to the caller.
  const currentState: StoryState | null = providedState
    ? structuredClone(providedState)
    : await getStoryStateWithBranch(actionedPage.bookId, actionedPage.id);

  if (!currentState) {
    throw new Error(`Failed to get story state for page ${actionedPage.id}`);
  }

  const expectedPageNumber = actionedPage.page + 1;
  const advancedState = await advanceStoryState(currentState, actionedPage);

  if (advancedState.page !== expectedPageNumber) {
    console.warn(`[prepareNextPageGenerationContext] ⚠️ State page mismatch: expected ${expectedPageNumber}, got ${advancedState.page}. Correcting.`);
    advancedState.page = expectedPageNumber;
  }

  const expectedPreviousPagesCount = Math.min(MAX_PAGE_HISTORY, actionedPage.page - 1);

  const previousDBPages = await getPreviousPages(actionedPage);
  const previousPages: ActionedStoryPage[] = previousDBPages.map<ActionedStoryPage>(p => {
    const selectedAction = currentState.actionsHistory.find(a => a.pageId === p.id)!;
    const page = mapToPersistedStoryPage(p);
    return { ...page, selectedAction };
  });

  if (previousPages.length !== expectedPreviousPagesCount) {
    console.log(`[prepareNextPageGenerationContext] ⚠️ Previous page count mismatch: expected ${expectedPreviousPagesCount}, got ${previousPages.length}`);
  }

  return { currentState, advancedState, expectedPageNumber, previousPages };
}

/**
 * Determines the branchId for a new candidate page.
 *
 * Across all candidate pages produced by a single parent page, exactly ONE may
 * share the parent's branchId — the first alternative page of the first pending
 * action, provided no sibling action has already been assigned a destination.
 * Every other alternative MUST receive a freshly-generated branchId.
 *
 * Visual Example (page 2, 3 actions × 2 alternatives):
 *   Action A, alt 0  → parentBranchId   ← the ONE allowed inheritance
 *   Action A, alt 1  → new branchId
 *   Action B, alt 0  → new branchId     (generateNewBranchId = true for B/C)
 *   Action B, alt 1  → new branchId
 *   Action C, alt 0  → new branchId
 *   Action C, alt 1  → new branchId
 *
 * Collision Guard:
 * usedBranchIds tracks branchIds already used within the current generateNextPages
 * call. In the (unlikely) event generateBranchId() returns a collision within the
 * same call, we spin until we get a unique one.
 *
 * @param generateNewBranchId  Caller-set flag; true for action indices > 0
 * @param isFirstAlternative   True only for loop index === 0 inside generateNextPages
 * @param parentBranchId       branchId of the actioned/parent page
 * @param usedBranchIds        Accumulator of branchIds assigned in this call (collision guard)
 * @param actionedPage         Parent page (read fresh from dbWrite for idempotency)
 * @param selectedAction       The action whose destination we are generating
 */
async function determineBranchIdForPage(params: {
  generateNewBranchId: boolean;
  isFirstAlternative: boolean;
  parentBranchId: string;
  usedBranchIds: Set<string>;
  actionedPage: CandidateGenerationPage;
  action: Action;
}): Promise<string> {
  const {
    generateNewBranchId,
    isFirstAlternative,
    parentBranchId,
    usedBranchIds,
    actionedPage,
    action,
  } = params;

  // Every non-first alternative must diverge — skip the DB read entirely.
  if (generateNewBranchId || !isFirstAlternative) {
    let branchId = generateBranchId();
    // Guard against within-call collisions (generateBranchId is UUID-based, so
    // this loop is a safeguard rather than an expectation).
    while (usedBranchIds.has(branchId)) {
      branchId = generateBranchId();
    }
    return branchId;
  }

  // First alternative: read fresh parent to enforce idempotency and decide branching.
  // Reading from dbWrite ensures we see commits from concurrent workers.
  const freshActionedPage = await getPageFromDB(actionedPage.id, { client: dbWrite });
  if (!freshActionedPage) {
    throw createNonRetryableError(
      `Actioned page ${actionedPage.id} was deleted during generation`,
      "PAGE_DELETED"
    );
  }

  // Idempotency guard: if a concurrent worker already generated destination pages
  // for this exact action, bail out so the caller can reuse the existing pages
  // rather than creating duplicates.
  const currentAction = freshActionedPage.actions.find((a) => a.text === action.text);
  if ((currentAction?.destinationPageIds?.length ?? 0) >= MAX_CANDIDATE_PAGE_PER_ACTION) {
    throw createNonRetryableError(
      `Action "${action.text}" already has ${MAX_CANDIDATE_PAGE_PER_ACTION} destination pages (at limit)`,
      "ACTION_ALREADY_HAS_DESTINATION"
    );
  }

  // Inherit parent branchId only when no sibling action has a destination yet.
  // The moment any sibling gains a destination (another action's page was written
  // first), this branch must diverge so we don't stomp the existing timeline.
  const siblingHasDestination = freshActionedPage.actions.some((a) => a.destinationPageIds?.length);
  return siblingHasDestination ? generateBranchId() : parentBranchId;
}

/**
 * Shared setup logic for page generation contexts, AI configurations, and prompts.
 * Extracts the heavy boilerplate out of the main generator functions.
 */
async function prepareNextPageGenerationSetup(params: BuildNextPageParams, candidateCount: number) {
  const { book, actionedPage } = params;
  const { currentState, advancedState, expectedPageNumber, previousPages } = await prepareNextPageGenerationContext(params);
  const { action, actions, sceneType } = actionedPage;

  const letter = String.fromCharCode(65 + actions.findIndex(a => a.text === action.text));
  const generationContext = `"${book.title}" page ${expectedPageNumber} of ${book.totalPages} after selecting ${letter}. ${action.text} (type: ${action.type})`;

  // 1. Build next page generation prompt
  // pgvector semantic memory (Use Case 1): computed once here, before
  // promptParams exists, since buildNextPagePrompt and
  // buildNextPageEvaluatorPrompt both read it off the same params object —
  // a second Jina call for the identical query would be wasteful. Never
  // throws — see buildRelevantPastEventsBlock's own graceful-degradation
  // handling.
  const relevantPastEventsBlock = await buildRelevantPastEventsBlock(actionedPage, book, advancedState);

  // pgvector semantic memory (Use Case 3): rank the unscheduled future-notes
  // bucket by semantic similarity to the current scene query — the highest-
  // similarity notes surface first so the AI treats the most contextually
  // relevant loose ends as most urgent. Only notes without a schedule entry
  // are candidates (notes with schedule entries already have a deterministic
  // timeline order). Never throws — a failed retrieval simply leaves the
  // bucket in its default chronological sort.
  let relevantFutureNoteKeys: string[] | undefined;
  // Candidates: notes with neither a schedule NOR a state trigger at all.
  // (Slightly conservative vs. the real "unscheduled" bucket in
  // formatFutureNotes, which also allows a DORMANT — currently inactive —
  // stateTrigger. Those dormant-trigger notes just won't get semantic
  // ranking; they keep their default chronological order if/when they land
  // in the unscheduled bucket. Fully replicating the bucket's exact
  // condition would mean hoisting isStateTriggerActive out of
  // formatFutureNotes' closure to evaluate it here too — not worth it for
  // what was already a harmless edge case: any extraneous candidate key
  // that doesn't match an actual unscheduled note simply never matches
  // anything in formatFutureNotes' keyOrder lookup and is silently ignored.)
  const unscheduledNoteKeys = advancedState.futureNotes
    .filter(n => !n.schedule?.length && !n.stateTrigger?.length)
    .map(n => n.key);
  if (unscheduledNoteKeys.length) {
    try {
      const query = buildCurrentSceneQuery(actionedPage);
      // Custom action: rank the full unscheduled set instead of leaving
      // some to fall back to chronological order — same reasoning as the
      // other three recall builders, applied here too for consistency.
      const limit = actionedPage.action?.type === 'custom' ? MAX_VECTOR_RESULTS_HIGH_VALUE : undefined;
      const results = await retrieveRelevantFutureNotes(query, book.id, actionedPage.branchId ?? 'main', unscheduledNoteKeys, limit);
      relevantFutureNoteKeys = results.map(r => r.noteKey);
    } catch (error) {
      console.error('[prepareNextPageGenerationSetup] ⚠️ Future note retrieval failed, continuing without semantic ranking:', getErrorMessage(error));
    }
  }

  // pgvector semantic memory (Use Case 4): computed here — before
  // promptParams, not alongside characterRecallBlocks/placeRecallBlocks below
  // — because it needs to be readable via params.clueRecallBlocks inside
  // buildNextPagePrompt's synchronous call at line 4338, which happens
  // before those two are computed. Reuses the same cached query embedding
  // as everything else this page generation.
  const clueRecallBlocks = await buildClueRecallBlocks(advancedState.threads, actionedPage, book);

  const promptParams: BuildNextPagePromptParams = {
    book,
    actionedPage,
    advancedState,
    previousPages,
    candidateCount,
    relevantPastEventsBlock,
    relevantFutureNoteKeys,
    clueRecallBlocks,
    // Evaluator string mode is the default whenever Gemini is in the evaluator
    // chain (matches resolveUseStringEvaluator's auto resolution). Threaded so
    // buildNextPageEvaluatorPrompt's OUTPUT FORMAT example matches the schema.
    useStringEvaluatorOutput: resolveUseStringEvaluator({
      modelSelection: AI_CHAT_MODELS_EVALUATION,
    }),
  };

  let prompt = buildNextPagePrompt(promptParams);

  // pgvector semantic memory (Use Cases 2 & 5): computed once here, in
  // parallel with each other since they're independent retrievals against
  // different tables. Both reuse buildRelevantPastEventsBlock's exact query
  // text above, so this doesn't trigger extra Jina calls for the query
  // embedding itself — only the per-character/per-place DB lookups are new.
  const [characterRecallBlocks, placeRecallBlocks] = await Promise.all([
    buildCharacterRecallBlocks(advancedState.characters, actionedPage, book),
    buildPlaceRecallBlocks(advancedState.places, actionedPage, book),
  ]);
  const bookMeta = await buildBookMetaDocuments(book, advancedState, {
    characters: characterRecallBlocks,
    places: placeRecallBlocks,
  });

  // Append developer promptAppend if present
  if (book.advancedOptions?.developer?.promptAppend) {
    const sanitizedAppend = sanitizePromptAppend(book.advancedOptions.developer.promptAppend);
    if (sanitizedAppend) {
      prompt = `${prompt}\n\n---\n${sanitizedAppend}`;
    }
  }
  
  // 2. Determine optimal AI configuration based on story progress and psychological state
  const baseConfig = applyAdvancedOptions(AI_CHAT_CONFIG_CREATIVE, book.advancedOptions);
  const config = determineAIConfig(advancedState, baseConfig);

  // 3. Resolve writing preset from the book's advancedOptions (persisted during initializeBook)
  const nextPreset: WritingPreset = book.advancedOptions?.writingPreset || 'default';

  return {
    currentState,
    advancedState,
    expectedPageNumber,
    action,
    generationContext,
    promptParams,
    prompt,
    config,
    ...bookMeta,
    systemPrompt: buildPresetSystemPrompt('next', nextPreset),
    fieldInstructions: buildNextPageFieldInstructions(advancedState, action, sceneType),
    reviewChecklist: buildNextPageReviewChecklist(advancedState, book.language),
    evaluatorPrompt: buildNextPageEvaluatorPrompt(promptParams),
  };
}

/**
 * Shared logic to calculate state deltas, apply them, correct mismatches, 
 * and merge psychological states cleanly.
 */
function resolvePageDelta(params: {
  generatedStoryPage: StoryGeneration,
  advancedState: StoryState,
  currentState: StoryState,
  expectedPageNumber: number,
  context: string,
  fateIndex?: number
}) {
  const { generatedStoryPage, advancedState, currentState, expectedPageNumber, context, fateIndex } = params;
  const futureNoteKeys = advancedState.futureNotes.map(note => note.key);
  const futureNoteKeysSet = new Set(futureNoteKeys);
  const duplicateKeys = futureNoteKeys.length - futureNoteKeysSet.size;
  if (duplicateKeys) {
    console.warn(`[resolvePageDelta] ⚠️ ${duplicateKeys} duplicate futureNoteKeys found among ${futureNoteKeys.length} keys:`, futureNoteKeys);
  }

  const stateDelta = extractStateDelta({ generatedStoryPage, expectedPageNumber, futureNoteKeys });
  const newState = applyStateDelta(advancedState, stateDelta, generatedStoryPage);

  // Provided story state might mismatch, but still respect what provided
  if (newState.page !== expectedPageNumber) {
    const fateLog = fateIndex !== undefined ? ` for alternative fate ${fateIndex}` : '';
    console.warn(`[${context}] ⚠️ newState.page mismatch${fateLog}: expected ${expectedPageNumber}, got ${newState.page}. Correcting.`);
    newState.page = expectedPageNumber;
  }
  
  // Calculate psychological deltas and merge into the state delta
  const psychologicalDeltas = calculatePsychologicalDeltas(currentState, newState);
  const fullStateDelta: StateDelta = { ...stateDelta, ...psychologicalDeltas };

  return { newState, fullStateDelta };
}

/**
 * Generates a SINGLE next story page (single-candidate path) using AI generation
 * with dynamic configuration
 *
 * Kept for callers that need exactly one output page. Internally uses the
 * same helpers as generateNextPages so both functions stay in sync.
 * 
 * Use {@link generateNextPages} for the branching-narrative multiverse flow.
 *
 * This function orchestrates the complete story generation pipeline with page-based architecture:
 * 0. Advance story state based on user action and previous AI turn updates via {@link prepareNextPageGenerationContext}
 * 1. Create personalized prompt with character, story context, and previous action
 * 2. Determine optimal AI configuration based on story progress and psychological state
 * 3. Send prompt to AI with dynamic parameters (candidate vs main story context)
 * 4. Handle AI response validation
 * 5. Extract generated content from AI response
 * 6. Lazy branching: Atomic branch creation with retry on conflict
 * 7. Apply current AI turn's updates to story state
 * 8. Persist generated page to database with parent-child relationship and retry logic
 * 9. Pre-generate candidate pages for each action in the new page
 * 10. Create delta from previous state to new state for efficient reconstruction
 * 11. Persist story state for the generated page (page-based state management)
 * 12. Create snapshot if conditions are met
 * 13. Return the persisted story page with all database metadata
 *
 * The function uses the sophisticated configuration system from {@link determineAIConfig}
 * to balance creativity, consistency, and reliability throughout the story progression.
 * For main story pages, it also pre-generates candidate pages for branching narrative.
 *
 * @param params.userId - The user's unique identifier for database operations
 * @param params.book - Book metadata for context
 * @param params.previousState - Current story state with progression, flags, and hidden values
 * @param params.actionedPage - Previous page with selected action for context
 * @param params.isUserAction - Whether to pre-generate candidates for next page (default: true)
 * @returns Promise resolving to persisted story page with database ID and metadata
 *
 * @example
 * ```typescript
 * // Generate main story page with candidates for next actions
 * const mainPage = await generateNextPage({
 *   userId: "user123",
 *   book: currentBook,
 *   previousState: storyState,
 *   actionedPage: currentPage,
 *   isUserAction: true
 * });
 * // Returns: { id: "page456", bookId: "book789", text: "The door creaked open...", actions: [...] }
 *
 * // Generate candidate page without additional candidates
 * const candidatePage = await generateNextPage({
 *   userId: "user123",
 *   book: currentBook,
 *   currentState: storyState,
 *   actionedPage: currentPage,
 *   isUserAction: false
 * });
 * // Returns: { id: "page457", bookId: "book789", text: "Reality began to distort...", actions: [...] }
 * ```
 */
export async function generateNextPage(params: BuildNextPageParams): Promise<PersistedStoryPage> {
  const { book, userId, actionedPage, generateNewBranchId = false, enableCanonValidation } = params;
  const context = "generateNextPage";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, cachedContentId, fieldInstructions, reviewChecklist, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, 1);
  console.log(`[${context}] 💭 Conceptualizing continuation for ${generationContext}...`);
  
  // 3. Send prompt to AI with dynamic parameters (single story context)
  const response = await executePromptForJSON<StoryGeneration>({
    prompt,
    configs: {
      schema: STORY_GENERATION_SCHEMA_DEFINITION,
      requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
      fallbackField: 'text',
      baseOptions: {
        config,
        modelSelection: AI_CHAT_MODELS_WRITING,
        context: 'story-page-candidate',
        logPrompts: true,
        systemPrompt,
        documents,
        cachedContentId,
        meta: {
          bookId: book.id
        }
      }
    } satisfies AIPromptForJson<StoryGeneration>,
    jsonStructure: nextPageOutputFormat,
    fieldInstructions,
    reviewChecklist,
    evaluatorPrompt,
  });
  
  // 4. Validate AI response
  if (!response.result) {
    throw new Error('Failed to generate page: no result');
  }

  validateGeneratedPage(response.result, book.mode, 'generateNextPage');

  // 5. Canon/consistency validation (roadmap 1.1) — after eval, before delta/persist
  let generatedStoryPage: StoryGeneration = {
    ...response.result,
    calendarDate: response.result.calendarDate ?? actionedPage.calendarDate,
  };

  const canonPass = await runCanonValidationPass({
    state: advancedState,
    generatedPage: generatedStoryPage,
    bookId: book.id,
    logContext: context,
    enabled: enableCanonValidation,
  });
  generatedStoryPage = canonPass.page;

  // 6. Apply state updates
  const { newState, fullStateDelta } = resolvePageDelta({
    generatedStoryPage,
    advancedState,
    currentState,
    expectedPageNumber,
    context
  });

  // 7. Determine Branch ID
  const parentBranchId = actionedPage.branchId ?? "main";
  const usedBranchIds = new Set<string>();

  const branchId = await determineBranchIdForPage({
    generateNewBranchId,
    isFirstAlternative: true, // Single-page call → always "first alternative"
    parentBranchId,
    usedBranchIds,
    actionedPage,
    action,
  });

  console.log(`[${context}] 🌳 branchId: ${branchId} (${branchId === parentBranchId ? "inherited from parent" : "new branch"})`);
  usedBranchIds.add(branchId);

  // 8. Persist page and its state atomically
  const newPage = await persistPageWithState({
    userId,
    expectedPageNumber,
    generatedStoryPage,
    fullStateDelta,
    newState,
    aiResponseProvider: response,
    actionedPage,
    action,
    branchId,
    usedBranchIds,
    context,
    book,
  });

  // Fire-and-forget canon audit (needs pageId)
  if (canonPass.audit) {
    void insertCanonValidationAudit({
      bookId: book.id,
      pageId: newPage.id,
      audit: canonPass.audit,
    });
  }

  // 9. Fire-and-forget pgvector semantic memory embedding. Deliberately NOT
  // awaited — page text is already safely persisted above, and a failed or
  // slow embed should never delay the response or fail the request. Reads
  // newPage.stateDelta internally (same object just persisted), so nothing
  // extra needs threading through. Never call these from inside
  // applyStateDelta/processCharacterUpdates/processPlaceUpdates — those also
  // run during delta-chain replay, and would silently re-embed the same
  // history on every reconstruction. See PGVECTOR_SEMANTIC_MEMORY_ROADMAP.md
  // §12 / Appendix D.3.
  embedPersistedPage(newPage);
  embedStateDeltaEntities(newPage);

  return newPage;
}

/**
 * Generates multiple ALTERNATIVE next story pages for a single action.
 *
 * Produces up to MAX_CANDIDATE_PAGE_PER_ACTION "fate" continuations for the
 * same action so that readers who pick the same choice may experience different
 * outcomes. This is the multiverse branching core.
 *
 * Partial Success:
 * Individual alternative failures are logged and skipped; the loop continues.
 * An error is surfaced only when ALL alternatives failed to persist.
 *
 * Idempotency:
 * determineBranchIdForPage reads the fresh parent page on the first alternative.
 * If a concurrent worker already committed destinations for this action, it
 * throws ACTION_ALREADY_HAS_DESTINATION, aborting the call cleanly so the
 * caller can reuse the existing pages.
 */
export async function generateNextPages(params: BuildNextPageParams): Promise<PersistedStoryPage[]> {
  const { book, userId, actionedPage, generateNewBranchId = false, candidateCount: providedCandidateCount = DEFAULT_CANDIDATE_PAGE_PER_ACTION, enableCanonValidation } = params;
  
  // Fast path: Route to single page generation if only 1 is requested
  // (forwards enableCanonValidation via full params)
  if (providedCandidateCount === 1) return [await generateNextPage(params)];

  const candidateCount = Math.min(providedCandidateCount, MAX_CANDIDATE_PAGE_PER_ACTION);
  if (providedCandidateCount > candidateCount) {
    console.warn(`[generateNextPages] ⚠️ candidateCount ${providedCandidateCount} clamped to ${MAX_CANDIDATE_PAGE_PER_ACTION}`);
  }

  const context = "generateNextPages";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, cachedContentId, fieldInstructions, reviewChecklist, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, candidateCount);
  console.log(`[${context}] 💭 Conceptualizing ${candidateCount} alternative fates for ${generationContext}...`);
  
  // 3. Send prompt to AI with dynamic parameters (multi-page batch schema)
  const response = await executePromptForJSON<CandidatePagesGeneration>({
    prompt,
    configs: {
      schema: CANDIDATE_GENERATION_SCHEMA_DEFINITION,
      requiredFields: CANDIDATE_GENERATION_REQUIRED_FIELDS,
      fallbackField: 'output',
      baseOptions: {
        config: { ...config, maxOutputToken: DEFAULT_MAX_OUTPUT_TOKEN * candidateCount },
        modelSelection: AI_CHAT_MODELS_WRITING,
        context: 'story-page-candidates',
        logPrompts: true,
        systemPrompt,
        documents,
        cachedContentId,
        meta: {
          bookId: book.id
        }
      }
    } satisfies AIPromptForJson<CandidatePagesGeneration>,
    jsonStructure: multiNextPageOutputFormat,
    fieldInstructions,
    reviewChecklist,
    evaluatorPrompt,
  });
  
  // 4. Validate AI response
  if (!response.result) {
    throw new Error('Failed to generate page candidates: no result');
  }
  
  // Generated content from AI response
  const generatedStoryPages = response.result.generatedPages;
  const newPages: PersistedStoryPage[] = [];
  const parentBranchId = actionedPage.branchId ?? "main";

  // usedBranchIds prevents within-call branchId collisions across alternatives.
  // Each iteration adds its chosen branchId before moving on.
  const usedBranchIds = new Set<string>();

  let lastError: unknown = null;

  // 5. Per-page state processing and persistence
  for (const [index, generatedStoryPageResult] of generatedStoryPages.entries()) {
    const isFirstAlternative = index === 0;
    const fateLogContext = `${context}:fate-${index + 1}`;

    // Skip invalid alternatives; outer retry covers full-batch failure when none remain
    if (!checkGeneratedPage(generatedStoryPageResult, undefined, fateLogContext)) {
      lastError = new Error(`Alternative fate ${index + 1} failed validation`);
      continue;
    }

    let generatedStoryPage: StoryGeneration = {
      ...generatedStoryPageResult,
      calendarDate: generatedStoryPageResult.calendarDate ?? actionedPage.calendarDate,
    };

    // Canon/consistency validation per multiverse candidate (roadmap 1.1)
    const canonPass = await runCanonValidationPass({
      state: advancedState,
      generatedPage: generatedStoryPage,
      bookId: book.id,
      logContext: fateLogContext,
      enabled: enableCanonValidation,
    });
    generatedStoryPage = canonPass.page;

    // Resolve state updates using the helper
    const { newState, fullStateDelta } = resolvePageDelta({
      generatedStoryPage,
      advancedState,
      currentState,
      expectedPageNumber,
      context,
      fateIndex: index + 1
    });

    // Determine branchId
    let branchId: string;
    try {
      branchId = await determineBranchIdForPage({
        generateNewBranchId,
        isFirstAlternative,
        parentBranchId,
        usedBranchIds,
        actionedPage,
        action,
      });
    } catch (error) {
      // Non-retryable signals abort the entire loop
      console.error(`[${context}] ❌ Cannot determine branchId for alternative fate ${index + 1}/${generatedStoryPages.length}:`, getErrorMessage(error));
      throw error; 
    }
    
    console.log(`[${context}] 🌳 Alternative fate ${index + 1}/${generatedStoryPages.length} — branchId: ${branchId} (${branchId === parentBranchId ? "inherited from parent" : "new branch"})`);
    usedBranchIds.add(branchId);

    // Persist page and its state atomically
    try {
      const newPage = await persistPageWithState({
        userId,
        expectedPageNumber,
        generatedStoryPage,
        fullStateDelta,
        newState,
        aiResponseProvider: response,
        actionedPage,
        action,
        branchId,
        usedBranchIds,
        context,
        book,
      });

      newPages.push(newPage);
      console.log(`[${context}] 🌌 Persisted alternative fate ${index + 1}/${generatedStoryPages.length} — page ${newPage.id}`);

      if (canonPass.audit) {
        void insertCanonValidationAudit({
          bookId: book.id,
          pageId: newPage.id,
          audit: canonPass.audit,
        });
      }

      // Fire-and-forget pgvector semantic memory embedding — same rationale
      // as the single-page path in generateNextPage above. Per-candidate,
      // since each alternative fate is its own branch with its own history.
      embedPersistedPage(newPage);
      embedStateDeltaEntities(newPage);
    } catch (error) {
      // One alternative failing should not abort the others
      lastError = error;
      console.error(`[${context}] ❌ Failed to persist alternative fate ${index + 1}/${generatedStoryPages.length} (branchId: ${branchId}):`, getErrorMessage(error));
    }
  }

  // 6. Surface error state based on success rate
  if (newPages.length === 0) {
    throw (lastError ?? new Error(`All ${generatedStoryPages.length} alternatives failed to persist for ${generationContext}`));
  }

  if (newPages.length < generatedStoryPages.length) {
    console.warn(`[${context}] ⚠️ Partial success: persisted ${newPages.length}/${generatedStoryPages.length} alternatives for ${generationContext}`);
  } else {
    console.log(`[${context}] ✅ Persisted all ${newPages.length} alternative fates for ${generationContext}`);
  }
  
  return newPages;
}

/**
 * Executes a prompt via AI multi-provider abstraction and returns structured JSON response.
 * 
 * This function is used for generating JSON data in a specific format.
 * 
 * @param params - Parameters for the prompt
 * @param onProgress - Optional progress callback for SSE events
 * @param onGenerationProgress - Optional callback to update generation progress in DB
 * @returns AI response with JSON output
 */
export async function executePromptForJSON<T extends Record<string, unknown>>(
  params: AIPromptForJsonParams<T>,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>> {
  const { prompt, configs, jsonStructure, fieldInstructions, reviewChecklist, evaluatorPrompt } = params;
  const outputFormatPart = jsonStructure.trim();
  const fieldInstructionsPart = fieldInstructions ? `FIELD INSTRUCTIONS:\n${stripEmptyLines(fieldInstructions)}` : '';

  /**
   * Standard models approach (default).
   * Not needed for reasoning-capable models, but acceptable for multi-provider fallback architecture.
   * 
   * | Model Type | Model Stack | Best Approach |
   * | --- | --- | --- |
   * | **Native Reasoning Models** | OpenAI o-series, Gemini Thinking, DeepSeek R1 | **Option 1 (Hidden Reasoning).** Do not use a scratchpad. Let the model think natively and output clean JSON. |
   * | **Standard/Fast Models** | Llama 3 (Groq/Cerebras), Mistral (Cloudflare) | **Option 2 (Lightweight Plan).** A concise, structured scratchpad is mandatory to force adherence before generating prose. |
   */
  const reviewChecklistPart = reviewChecklist ? `REVIEW & FIX (IMPORTANT):

Before producing the final JSON, silently verify your draft against every requirement below.
Treat every requirement below as mandatory:
- If any requirement is not fully satisfied, revise the draft internally until every item passes.
- If any two requirements conflict, prioritize preserving JSON validity, schema correctness, and user-visible language consistency.

Requirements:
${stripEmptyLines(reviewChecklist)}

Output only the final corrected JSON.
Do not explain, summarize, or mention this review process.` : '';

  /**
   * Cache optimized: sort static > semi-static > dynamic.
   * Output specifications and instructions at the top is the industry best practice for prompt caching.
   */
  const userPrompt = [
    // Semi-static
    fieldInstructionsPart,
    reviewChecklistPart,
    // Dynamic
    prompt.trim(),
  ].join('\n\n---\n');

  const options = createAIOptionsWithSchema<T>(configs);
  options.outputFormat = outputFormatPart;
  const response = await aiPrompt<T>(
    userPrompt,
    options,
    evaluatorPrompt,
    onProgress,
    onGenerationProgress,
  );

  if (!response.result) {
    console.warn(`[executePromptForJSON] ❓ AI response has no result:`, response);
  }

  return response;
}

/**
 * Generates the prompts for book creation theme generation
 * 
 * @returns Object containing systemPrompt and userPrompt for book creation
 */
function getBookCreationPrompts(headerLanguage?: string | null): { systemPrompt: string; userPrompt: string } {
  const lang = formatLanguage(headerLanguage || 'en');
  const systemPrompt = `You are a creative writing assistant specializing in generating engaging story concept for interactive thriller, mystery, horror, and psychological fiction novels.

TASK: Generate a compelling story concept that another AI will use as the foundation for generating an entire branching novel (max ${MAX_THEME_LENGTH_PROMPT} characters).

LANGUAGE:
- The entire output MUST be written in the target language: ${lang}.
- All story content, character details, and labels must be in ${lang}.

The story concept should naturally provide enough information to infer:
- The core premise and central conflict (required)
And optionally:
- Main character details (name, gender, age, occupation, personality, background)
- Supporting characters or important relationships
- Story tone and atmosphere
- Setting, time period, or world details
- Mysteries, secrets, antagonists, or major story goals

GUIDELINES:
- Create an intriguing premise that immediately sparks curiosity.
- Feel free to include an initial cast of characters if they strengthen the concept.
- Supporting characters should have clear narrative purpose rather than existing only as names.
- Leave room for discoveries, branching choices, and unexpected twists throughout the story.
- Do not over-explain every mystery; preserve intrigue.
- Vary the format naturally. A short synopsis, narrative pitch, or concise concept with optional labeled sections are all acceptable.

CHARACTER CONSTRAINTS:
- Main character age must be between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}.
- Character gender must be one of: ${formatOneOf(genders)}.
- If specifying the main character, explicitly state whether they are "male" or "female".

Examples of useful information (all optional except the premise):
- Character names
- Relationships
- Occupations
- Motivations
- Initial secrets
- Rivalries
- Supernatural rules
- Organizations
- Important locations
- Initial objectives

OUTPUT FORMAT:
- Only output the story concept.
- Do not include introductions, explanations, or meta-commentary.
- Output plain text only. Do not use Markdown formatting.
- The overall output must not exceed ${MAX_THEME_LENGTH_PROMPT} characters.`;

  const userPrompt = `Generate a creative and engaging story prompt for a thriller/horror interactive fiction novel. Be specific and intriguing. Write the entire prompt in the target language: ${lang}.`;

  return { systemPrompt, userPrompt };
}

/**
 * Generates a creative book creation prompt using AI streaming
 * 
 * This function generates engaging story prompts that users can use as inspiration
 * for creating new books. The output includes story theme, optional main character details,
 * and story elements. Character ages are constrained to MIN_CHARACTER_AGE and MAX_CHARACTER_AGE.
 * 
 * @param signal - Optional AbortSignal for cancellation
 * @returns ReadableStream that yields SSE-formatted chunks of the generated prompt
 * 
 * @example
 * ```typescript
 * const stream = await generateBookCreationPromptStream();
 * res.setHeader('Content-Type', 'text/event-stream');
 * for await (const chunk of stream) {
 *   res.write(chunk);
 * }
 * ```
 * 
 * Example output format:
 * ```
 * A psychological thriller about a disgraced investigative journalist who returns to her childhood hometown to uncover the truth behind a series of mysterious disappearances at an abandoned asylum, only to discover that the facility's dark experiments never truly ended and someone is watching her every move from the shadows.
 * MC: Elena Rodriguez, Female, 31, Former award-winning journalist with a sharp wit and haunted past, driven by redemption and an obsessive need for truth
 * Tone: Dark, suspenseful, psychological horror with elements of conspiracy and paranoia
 * Elements: Atmospheric dread, unreliable narrators, hidden agendas, psychological manipulation, isolation, and the blurring line between reality and delusion
 * ```
 */
export async function generateBookCreationPromptStream(params: GenerateBookCreationPromptParams = {}): Promise<AIChatStreamResult> {
  const { logPrompts = false, signal, language = 'en' } = params;
  const { systemPrompt, userPrompt } = getBookCreationPrompts(language);

  return aiStreamSSE(userPrompt, {
    modelSelection: AI_CHAT_MODELS_THEME,
    systemPrompt,
    context: 'book-creation-prompt',
    logPrompts: logPrompts,
    config: {...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 1500}
  }, signal);
}

/**
 * Generates a creative book creation prompt using AI (non-streaming)
 * 
 * This is a non-streaming version of generateBookCreationPromptStream() for use in
 * background jobs like cron tasks where streaming is not needed. Uses aiPrompt() directly.
 * 
 * @param params - Optional parameters for the prompt generation
 * @returns Promise resolving to the generated prompt text
 * 
 * @example
 * ```typescript
 * const theme = await generateBookCreationPrompt();
 * console.log(theme);
 * ```
 */
export async function generateBookCreationPrompt(params: GenerateBookCreationPromptParams = {}): Promise<AIResponse<string>> {
  const { logPrompts = false, language = 'en' } = params;
  const { systemPrompt, userPrompt } = getBookCreationPrompts(language);

  const response = await aiPrompt(userPrompt, {
    modelSelection: AI_CHAT_MODELS_THEME,
    systemPrompt,
    context: 'book-creation-prompt',
    logPrompts,
    config: {...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 1500}
  });

  return response;
}

/**
 * Generates a creative book creation prompt using AI (non-streaming)
 * 
 * This is a non-streaming version of generateBookCreationPromptStream() for use in
 * background jobs like cron tasks where streaming is not needed. Parses SSE stream internally.
 * 
 * @param params - Optional parameters for the prompt generation
 * @returns Promise resolving to the generated prompt text
 * 
 * @example
 * ```typescript
 * const theme = await generateBookCreationPromptText();
 * console.log(theme);
 * ```
 */
export async function generateBookCreationPromptText(params: GenerateBookCreationPromptParams = {}): Promise<string> {
  const { stream } = await generateBookCreationPromptStream(params);
  return parseSSEStreamContent(stream);
}