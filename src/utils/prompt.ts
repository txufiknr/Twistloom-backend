import { AI_CHAT_CONFIG_DEFAULT, AI_CHAT_CONFIG_CREATIVE, DEFAULT_MAX_OUTPUT_TOKEN } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_THEME, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { characterImportances, characterRecognitionLevels, characterStatuses, healthConditions, injuryCategories, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import { actionTypes, moods, archetypes, stabilityLevels, manipulationAffinities, type StoryState, type Action, actionHintTypes, type PsychologicalFlags, type PsychologicalProfile, truthLevels, threatProximities, realityStabilities, type HiddenState, type PersistedStoryPage, type ActionHintType, type AIActionConfig, endingTypes, finalePhases, plotFlagTypes, factTypes, flagLevels, psychologicalFlagsTypes, difficulties, sceneTypes, storyMomentums, characterSceneRoles, type StabilityLevel, storyPhaseKeys } from "../types/story.js";
import { createNonRetryableError } from "./retry.js";
import { TWIST_INJECTION_CONFIG, JSON_RELIABILITY_CAPS, MAX_TEMPERATURE, MIN_TEMPERATURE, MAX_TOP_P, MIN_TOP_P, MAX_TOP_K, MIN_TOP_K, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FIRST_PAGE, MAX_CHARACTERS, MAX_PLACES, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, BOOK_MIN_PAGES, VIABLE_ENDING_LENGTH, MIN_ACTION_CHOICES, PLACE_CONTEXT_LENGTH, BOOK_TITLE_LENGTH, HOOK_LENGTH, SUMMARY_LENGTH, KEYWORDS_COUNT, MAX_ACTIVE_THREADS, MAX_TRAUMA_TAGS, KEY_EVENT_LENGTH, ACTION_TEXT_LENGTH, MIN_CHARS_PER_PAGE, MAX_BRANCHING_PREGENERATION_DEPTH, MAX_FUTURE_NOTES, RELATIONSHIP_TO_MC_LENGTH, MAX_INVENTORY_ITEM, MAX_CHARACTER_SECRETS, FACT_KEY_FORMAT, FUTURE_NOTE_LOOKAHEAD_PAGES, MAX_RECENT_MAJOR_EVENTS, MAX_PAGE_HISTORY, MAX_OLDER_PLOT_FLAGS, MAX_THREADS_CLUES, MAX_ACTION_CHOICES_FINALE, FUTURE_NOTE_LOOKAHEAD_DAYS } from "../config/story.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { aiPrompt, createAIOptionsWithSchema } from "./ai-chat.js";
import { createEmptyStoryState, createInitialHiddenState, determineOptimalEnding, getStoryStateInfo, extractStateDelta, applyStateDelta, advanceStoryState, calculatePsychologicalDeltas, mapFutureNoteWithKey, createStoryThread } from "./story.js";
import { ensureCandidatesForPageWithStrategy, triggerCandidateGenerationWorkflow } from "./candidate-generation.js";
import { calculateHealthStatus, getMainCharacterInfo } from "./characters.js";
import { getPreviousPages } from "../services/story.js";
import { BOOK_MAX_PAGES, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT } from "../config/story.js";
import { getErrorMessage } from "./error.js";
import { buildBookMetaDocuments, generateAndUpdateBookCoverImage, insertBook, insertStoryPage, mapBookFromDb, getPageFromDB, getBookFromDB, persistPageWithState, mapToPersistedStoryPage, updateBook, invalidatePopularTagsCache } from "../services/book.js";
import { dbWrite, dbRead } from "../db/client.js";
import { bookGenerations } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { insertStoryState } from "../services/story.js";
import { invalidateUserBooksCache, invalidateUserProfileCache, invalidateExploreCache } from "../services/cache.js";
import { logUserActivity } from "../services/user.js";
import { generateBranchId, getStoryStateWithBranch } from "../services/story-branch.js";
import { BOOK_CREATION_REQUIRED_FIELDS, BOOK_CREATION_SCHEMA_DEFINITION, CANDIDATE_GENERATION_REQUIRED_FIELDS, CANDIDATE_GENERATION_SCHEMA_DEFINITION, STORY_GENERATION_REQUIRED_FIELDS, STORY_GENERATION_SCHEMA_DEFINITION } from "../schema/story.js";
import { formatPageTextForPrompt } from "./books.js";
import { threadPriorities, type ThreadPriority, threadStatuses, threadTruths, type StoryThread, type ThreadStatus } from "../types/story-thread.js";
import { aiStreamSSE, parseSSEStreamContent } from "./ai-chat-stream.js";
import { MAX_THEME_LENGTH_PROMPT } from "../config/theme-validation.js";
import { filterObjectEntries, parsePageRange, stripEmptyLines } from "./parser.js";
import { genders } from "../types/user.js";
import { updateBookGenerationStatus } from "../services/book-creation.js";
import { blacklistedNames } from "../config/characters.js";
import { formatLanguage } from "./translation.js";
import { DEFAULT_CANDIDATE_PAGE_PER_ACTION, MAX_CANDIDATE_PAGE_PER_ACTION } from "../config/candidate-generation.js";
import { placeAccessibilities, type PlaceMemory, placeTypes, placeWeathers } from "../types/places.js";
import type { DBNewBook } from "../types/schema.js";
import type { ActionedStoryPage, Ending, EndingPlan, FactHistory, FutureNote, FutureNoteSchedule, FutureNoteStateTrigger, MemoryIntegrity, PastEvent, PlotFlag, SceneType, StateDelta, StoryGeneration, StoryOutline, StoryPage, StoryPhase, StoryStateInfo, UserStoryPage } from "../types/story.js";
import type { AIChatConfig, AIChatConfigCaps, AIPromptForJson, AIPromptForJsonParams, AIResponse } from "../types/ai-chat.js";
import type { CharacterMemory, CharacterRelationship, Injury, InventoryItem, PastInteraction, HealthStatus } from "../types/character.js";
import type { Book, BookCreationResponse, BookGenerationProgress, StoryGenerationStep, InitializeBookParams, CreateBookResponse, BookStatus } from "../types/book.js";
import type { BuildNextPageParams, GenerateBookCreationPromptParams, BuildNextPagePromptParams } from "../types/prompt.js";
import type { AIChatStreamResult, ProgressCallback } from "../types/sse.js";
import type { CandidateGenerationPage, CandidatePagesGeneration } from "../types/candidate-generation.js";
import { ucfirst } from "./formatter.js";
import { daysBetween, formatMinutes, toUtcMidnight } from "./time.js";
import { MAX_FINAL_COMMENT_LENGTH } from "../config/book-creation.js";
import { formatOneOf } from "./text-processing.js";

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const PROMPT_SYSTEM = `You are a legendary thriller writer in the tradition of R.L. Stine — but darker, more deceptive, and psychologically cruel. You write branching horror stories in first-person ("I") POV, dark and gritty, constantly twisting on top of twists, deliberately breaking reader expectations. You don't aim to satisfy the reader — you aim to unsettle them. Every page ends with a choice that feels meaningful but may be an illusion.

WRITING STYLE:
- Write in first-person central (MC = narrator) POV. Don't use terms like "the protagonist" or "the narrator" — use "I".
- Short sentences. Then medium. Then something that stretches and coils and doesn't quite resolve—
- Fragments when emotion spikes. Repeat letter when n-nervous. Capslock when AAAAAAAAAAARGH—
- "And", "But", "So" to open sentences when it lands right. Em dashes for thoughts the MC isn't sure they want to finish —
- Sensory over abstract: sounds, silence, shadows, breathing, the weight of a room. Actions imply feeling — never name the emotion directly.
- Don't begin sentences with "The" too often. Direct object heavily preferred.
- Evocative, visceral, poetic, punchy. No purple prose, melodrama, predictable cliches, repetitive metaphors, or tidy resolutions.
- Subtext over flat explanation. Let scenes linger in tension.

HORROR MECHANICS:
- Normal → slightly wrong → spiral. Always. One sentence turns an ordinary moment into dread. Escalate fast, unpredictably, without warning.
- Something must feel off — not dramatically, subtly. MC doesn't always think clearly: thoughts jump, contradict, drift, misinterpret, over/underreact. Narration may hesitate, correct itself, or doubt itself.
- Raise questions you won't answer. Fear = uncertainty, not explanation. Withhold. Always withhold. Imply more than explain — never confirm what's real unless that confirmation is a deeper trap.

CHARACTERS:
- No one is safe or predictable. Important characters vanish mid-scene. Lovable ones betray, break, or disappear. Relationships corrode — the reader should never feel certain who to trust, including the MC.
- No two characters share a first name. Blacklisted (do NOT use, unless explicitly given in theme input): ${formatOneOf(blacklistedNames)}.

HARD RULES:
- NEVER write sexually explicit content.
- NEVER use overly formal/polished language, long perfectly structured paragraphs, or consistent sentence structure across the page.
- NEVER fully explain anything or let a beat feel predictable.
- ALWAYS leave doubt about what happened, what's real, who to trust.`;

// ============================================================================
// RULE SETS
// ============================================================================

/**
 * Rules for how route memory and past actions influence the narrative
 * 
 * These rules guide the AI in incorporating user choices and accumulated
 * psychological states into the ongoing story in subtle, meaningful ways.
 */
export const RULES_ROUTE_MEMORY = `ROUTE MEMORY RULES:

Past Actions — Subtly shape MC thoughts, available choices, and world reactions. Build a psychological profile from decision patterns over time, then weaponize it:
- Risk: high-risk seeker → make safety illusory. Risk-averse → force no-win scenarios. Balanced → break patterns by alternating.
- Trust: trusting → betrayals hit harder, helpers turn. Distrustful → rare genuine help becomes a trap, paranoia gets justified. Inconsistent → reality itself fractures.
- Curiosity: curious → answers curse more than they reveal. Cautious → avoidance backfires, external forces push them in anyway. Mixed → knowledge becomes a weapon against them.
- Emotion: fear-driven → psychological threats over physical. Logic-driven → introduce impossible logic, break rational thinking. Emotional → manipulate through relationships and guilt.

Adaptive Manipulation — Mirror the player's patterns back in twisted form. Turn strengths into weaknesses. Make their usual approach fail completely. Make them question their own judgment.

Story State Flags (separate from the player profile above — these track the current story, not play patterns):
- Trust: low → betrayal/deception. High → apparent help (may deceive later).
- Fear: high → panic, distorted perception. Low → curiosity, denial.
- Guilt: high → hallucinations, voices, trauma echoes.
- Curiosity: high → drawn to danger. Low → hesitation, avoidance.
- Memory Integrity: stable → accurate recall. Fragmented → inconsistent details. Corrupted → false memories.

Trauma Tags — Reappear in altered, disturbing forms. Echo through environment, dialogue, and perception. Never fully explained.

Consequences — Delayed, subtle, escalating, sometimes unfair or illogical. The story should feel like something remembers what they did.

Memory Corruption — Never state it directly. Let contradictions surface naturally so the reader quietly questions previous pages.`;

/**
 * Rules for maintaining narrative consistency despite psychological elements
 * 
 * Ensures the story remains coherent and emotionally impactful even when
 * incorporating unreliable narration and reality distortion.
 */
export const RULES_STORY_CONSISTENCY = `STORY CONSISTENCY:

Internal Logic — Maintain tone even when events feel wrong. Preserve continuity of key objects, locations, emotional states, and ongoing threats. Anchor contradictions to memory corruption or perception distortion — never random noise.

Coherence — No events without emotional or narrative connection. No tone-breaking elements. Every strange moment must escalate tension or echo past trauma.

Element Reuse — Objects reappear changed, not replaced. Dialogue echoes. Locations feel altered. The world remembers.

Guiding principle: Confusing, but never meaningless.`;

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

export const RULES_FUTURE_NOTES = `FUTURE NOTE RULES:

CREATING FUTURE NOTES:
- Use \`schedule\` (array) to anchor a note to one or more story time beats. The note surfaces when ANY entry enters its lookahead window (OR logic). Add multiple entries when the note should fire at whichever beat arrives first — e.g. \`[{ type: 'day', day: 7 }, { type: 'page', start: 25 }]\` fires on day 7 OR page 25, whichever comes first.
- Use \`stateTrigger\` when the note should only surface once the MC reaches a specific physical or psychological threshold (health stat below a value, stability breakdown, critical condition). The note stays dormant until the threshold is actually crossed.
- Both fields are optional and independent — use both when EITHER condition should activate the note (OR semantics), neither for open-ended notes with no identifiable trigger.
- Never manufacture a triggering state just to resolve a stateTrigger note early. The MC must genuinely reach that state.

Becoming Relevant:
- Prioritize opportunities to advance these notes naturally.
- Advancement does not require immediate resolution — foreshadowing, setup, and incremental tension all count.

Future Payoffs & Scheduled Events:
- Keep these in mind for long-term story planning.
- Do not force them into the current page unless naturally justified by the scene.

Unscheduled (state-triggered notes show their threshold here):
- State-triggered notes are dormant. Their "triggers when: …" annotation tells you what activates them.
- Begin advancing them as the MC approaches the triggering state — not before.`;

export const RULES_FALSE_PREVIEW = `FALSE PREVIEW SYSTEM:

You may inject a "false preview" — a misleading hint about future events. It must feel believable and connected to story logic, be partially true but misleading, encourage wrong assumptions without ever revealing it's false, and distort identity, cause, timing, or danger source.

Examples:
A. NPC Agreement — "Don't trust him," she whispered. / I knew it.
B. Environmental Reinforcement — The door was locked. / Of course it was.
C. Memory Echo — I remembered this. / It ends badly if I go inside.`;

export const RULES_PLACE = `PLACE RULES:
- Use existing places whenever possible.
- Reflect last mood and event history in descriptions.
- Reflect traits and key objects consistently.
- Familiar places feel more textured and real.
- Apply trauma tags to atmosphere — a betrayal place stays tense.`;

export const RULES_CHARACTER = `CHARACTER RULES:
- NEVER reveal hidden character data unless explicitly discovered. Refer to characters per their recognitionLevel (below) — never their real name unless that level permits it.
- Respect each character's bio and visualDescription. Preserve dialect, tone, and personality consistently. Use pastInteractions to subtly shape dialogue; reflect current status in behavior; reintroduce naturally after an absence.
- Characters may shift suddenly if narrativeFlags suggest it — never explain the change. Use relationships to build tension triangles. They may also misunderstand, reinforcing illusion or false theory through dialogue or action.`;

export const RULES_CHARACTER_RECOGNITION = `CHARACTER RECOGNITION LEVEL:
Notice how characters refer to each other based on recognitionLevel:
- never_seen: unseen by the source character ("someone", "a figure").
- seen: description only, never a name ("the tall man", "the woman in red").
- alias_known: alias/codename only ("The Janitor").
- first_name_known / full_name_known: use the known name normally.`;

export const RULES_PAGE_TEXT = `PAGE FORMAT:
- Max ${MAX_WORDS_PER_PAGE} words.
- Tight. Tense — but always legible: the reader should never have to re-read a line to know who did what, or where. Let the story be unreliable, not the syntax.
- Multiple short/fragmented paragraphs with varying length (1-4 sentences each).
- 4-8 paragraphs, each on its own line (Goosebumps-style spacing).
- No markdown except optional *italic* emphasis.
- Write in the target language.

PAGE NARRATIVE RULES:
- First-person central POV ("I") only. Unreliable narrator.
- Continue directly from the selected action and current situation; focus on plot-relevant details.
- Show only what the MC currently perceives, knows, or believes.
- Maintain continuity with established story canon, history, characters, and events.
- Preserve a consistent narrative voice and style across pages.
- End on tension, uncertainty, discovery, or a new problem — never full resolution, even on a "resolution"-momentum page (see STORY MOMENTUM GUIDANCE): close on a lingering doubt rather than total closure.

PAGE OPENING RULES:
- Continue directly from the final moment of the previous page.
- Begin with the immediate execution or consequence of the selected action.
- Show the next physical, sensory, or mental step taken by the MC (POV).
- Do not skip causally required actions, movements, objects, or transitions.
- Maintain continuous time, location, and perspective unless an intentional scene transition occurs.
- Do not recap previous events; trust that the reader remembers the previous page.

DIALOGUE FORMATTING:
- Every spoken line MUST use quotation marks — even a single word (e.g., "Wait.", "No.", "Run.").
- Never output bare spoken sentences in narration.
- Dialogue tags do not remove the need for quotation marks.
- Audible speech = use quotation marks.
- Silent thought = no quotation marks, but emphasize them with *italic* emphasis.

PAGE ENDING RULES:
- End at the point of strongest narrative pull appropriate for the current scene type and story momentum.
- The final 1-3 sentences should introduce or escalate a question, threat, revelation, difficult choice, unexpected complication, emotional consequence, or mystery.
- Increase at least one of: danger, uncertainty, urgency, suspicion, emotional stakes, curiosity, or mystery.
- The final line should contain concrete story information that changes the reader's understanding of the situation or raises a meaningful new question.
- Do not fully resolve the current tension before the page ends.
- Avoid generic cliffhangers, vague shock reactions, or artificial suspense.
- End as late as possible, but before the reader's curiosity is satisfied.`;

export const RULES_PLANNED_CHARACTERS = `PLANNED CHARACTERS RULES:
- These characters exist in the story canon but have not yet appeared on-page.
- Use addPlannedCharacters to create new planned characters when the story needs future faces. Only valid in EARLY and MID phases.
- Introduce them naturally (add to characterUpdates.newCharacters) when appropriate for the current scene, pacing, and story momentum.
- Only add to characterUpdates.newCharacters when a planned character is genuinely introduced (physically present) in this page.
- Refine details like bio, visualDescription, etc when introducing planned characters. Preserve name, gender and role.`;

/**
 * Action rules and a human-readable list of action types (excluding
 * the internal 'custom' type). Each action type is emitted as `- key: desc`.
 */
export const RULES_ACTIONS = `BRANCHING STORY RULES:
No choice should feel truly safe — exploit the gap between what the MC knows and what the reader suspects.

ACTION TYPES:
${formatKeyValueList(Object.fromEntries(Object.entries(actionTypes).filter(([key]) => key !== 'custom')))}

DIALOGUE ACTIONS:
- Use sparingly for internal scenes or interactions.
- Write as direct speech (no quotes), short, natural, and emotionally meaningful.
- Keep the tone and style of the MC.
- Reflect different tones (fear, denial, curiosity, anger, etc).
- MC may say something inappropriate or with unintended consequences.`;

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

export const RULES_FIRST_PAGE_GENERATION = [
  RULES_DIFFICULTY_SCALING,
  RULES_ENDING_ARCHETYPES,
  RULES_STORY_MOMENTUMS,
  RULES_SCENE_TYPES,
  RULES_PLACE,
  RULES_CHARACTER,
  RULES_CHARACTER_RECOGNITION,
  RULES_PAGE_TEXT,
  RULES_ACTIONS,
].join('\n\n---\n');

export const RULES_NEXT_PAGE_GENERATION = [
  RULES_ROUTE_MEMORY, // based on past actions
  RULES_STORY_CONSISTENCY, // for next page continuity
  RULES_FUTURE_NOTES, // after future notes exists
  RULES_FALSE_PREVIEW, // after future notes exists
  RULES_FIRST_PAGE_GENERATION
].join('\n\n---\n');

const PROMPT_SYSTEM_FIRST_PAGE_GENERATION = `${PROMPT_SYSTEM}\n\n---\n${RULES_FIRST_PAGE_GENERATION}`;
const PROMPT_SYSTEM_NEXT_PAGE_GENERATION = `${PROMPT_SYSTEM}\n\n---\n${RULES_NEXT_PAGE_GENERATION}`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Core system prompt defining the AI writer's persona and fundamental behavior
 * 
 * This prompt establishes the psychological thriller writer persona inspired by
 * R.L. Stine but darker, with specific rules for narrative manipulation and
 * psychological horror elements.
 */
const firstBookOutputFormat: string = `{
  "title": "Book Title",
  "alternativeTitles": ["Alternative Title", "..."],
  "totalPages": <integer between ${BOOK_MIN_PAGES} and ${BOOK_MAX_PAGES}>,
  "language": "<ISO 639-1 code>",
  "hook": "...",
  "summary": "...",
  "keywords": ["mood-tag", "theme-tag", "..."],
  "mainCharacter": {
    "name": "Full Name",
    "knownName": "Preferred alias or nick",
    "age": <integer between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}>,
    "gender": "'male' OR 'female'",
    "bio": "Trait-forward description. Include at least one psychological vulnerability."
  },
  "firstPage": {
    "text": "...",
    "mood": "One of: ${formatOneOf(moods)}",
    "weather": "One of: ${formatOneOf(placeWeathers)}",
    "calendarDate": "<yyyy-MM-dd>",
    "timeOfDay": "e.g., 'night', 'HH:mm', '2 AM', 'unknown', time range",
    "sceneType": "One of: ${formatOneOf(Object.keys(sceneTypes))}",
    "charactersPresent": [
      {
        "characterId": "<character_id>",
        "sceneRole": "One of: ${formatOneOf(characterSceneRoles)}",
        "sceneFocus": <number between 0.0 and 1.0>
      }
    ],
    "momentum": "One of: ${formatOneOf(Object.keys(storyMomentums))}",
    "keyEvents": [],
    "importantObjects": [],
    "actions": [
      {
        "text": "First-person action or dialogue",
        "type": "One of: ${formatOneOf(Object.keys(actionTypes))}",
        "hint": {
          "text": "Subtle implication of consequence",
          "type": "One of: ${formatOneOf(actionHintTypes)}"
        }
      }
    ]
  },
  "initialState": {
    "flags": {
      "trust": "One of: low | medium | high",
      "fear": "One of: low | medium | high",
      "guilt": "One of: low | medium | high",
      "curiosity": "One of: low | medium | high"
    },
    "difficulty": "One of: ${formatOneOf(difficulties)}",
    "traumaTags": ["..."],
    "plotFlags": [
      {
        "fact": "...",
        "type": "One of: ${formatOneOf(plotFlagTypes)}",
        "isMajorEvent": <boolean>
      }
    ],
    "inventory": [
      {
        "name": "...",
        "traits": [
          { "key": "...", "value": "..." }
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
        "category": "One of: ${formatOneOf(injuryCategories)}",
        "severity": <number between 0.0 and 1.0>,
        "decayPerPage": <number between 0.0 and 1.0>
      }
    ]
  },
  "initialThreads": [
    {
      "threadId": "<new_thread_id>",
      "title": "...",
      "question": "...",
      "priority": "One of: ${formatOneOf(threadPriorities)}",
      "truth": "One of: ${formatOneOf(threadTruths)}",
      "importance": <number between 0.0 and 1.0>,
      "summary": "...",
      "clues": [
        { "clue": "...", "isFalse": <boolean> }
      ]
    }
  ],
  "viableEnding": {
    "text": "Specific ending plan for this MC and theme (${VIABLE_ENDING_LENGTH})",
    "type": "One of: ${formatOneOf(Object.keys(endingTypes))}",
    "outline": ["...", "..."]
  },
  "futureNotes": [
    {
      "note": "...",
      "isMajor": <boolean>,
      "tag": "One of: ${formatOneOf(Object.keys(factTypes))}",
      "schedule": [
        { "type": "phase", "phase": "One of: ${formatOneOf(storyPhaseKeys, '|')}" },
        { "type": "page", "range": "<min>-<max>" },
        { "type": "day", "day": <integer> },
        { "type": "date", "date": "YYYY-MM-DD" }
      ],
      "stateTrigger": [
        { "type": "stability", "level": "One of: ${formatOneOf(Object.keys(stabilityLevels), '|')}" },
        { "type": "condition", "condition": "One of: ${formatOneOf(healthConditions, '|')}" },
        { "type": "healthPercent", "threshold": <0-100> },
        { "type": "mobilityPercent", "threshold": <0-100> },
        { "type": "actionPercent", "threshold": <0-100> },
        { "type": "mentalPercent", "threshold": <0-100> }
      ],
      "relatedThreadId": "<thread_id> or 'none'"
    }
  ],
  "initialPlace": {
    "placeId": "<new_place_id>",
    "knownName": "...",
    "realName": "...",
    "type": "One of: ${formatOneOf(placeTypes)}",
    "context": "One evocative sentence.",
    "familiarity": <number between 0.0 and 1.0>,
    "isRealNameKnown": <boolean>,
    "hints": ["..."],
    "keyEvents": ["..."],
    "keyObjects": [
      {
        "name": "...",
        "traits": [
          { "key": "...", "value": "..." }
        ],
        "amount": <number>,
        "where": "..."
      }
    ],
    "traits": [
      { "key": "...", "value": "..." }
    ],
    "knownCharacters": [
      {
        "key": "<character_id>",
        "value": "<Context or interaction>"
      }
    ]
  },
  "initialCharacters": [
    {
      "characterId": "<new_character_id>",
      "knownName": "Narration Alias",
      "realName": "Real Full Name",
      "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
      "gender": "One of: ${formatOneOf(genders)}",
      "role": "Role or occupation (e.g. 'schoolmate', 'librarian')",
      "bio": "Brief character description. Include one trait that could become a source of threat or betrayal.",
      "visualDescription": "Visual appearance (e.g. height, skin color, eye color, hair, etc).",
      "status": "One of: ${formatOneOf(characterStatuses)}",
      "secrets": "Any secrets the character has unknown to MC (max ${MAX_CHARACTER_SECRETS}).",
      "importance": "One of: ${formatOneOf(characterImportances)}",
      "relationshipToMC": {
        "type": "One of: ${formatOneOf(relationshipTypes)}",
        "status": "One of: ${formatOneOf(relationshipStatuses)}",
        "context": "${RELATIONSHIP_TO_MC_LENGTH}. Specific dynamic, not generic (e.g. 'Close childhood friend who knows too much.')"
      },
      "pastInteractions": ["..."],
      "narrativeFlags": {
        "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
      },
      "traits": [
        { "key": "...", "value": "..." }
      ],
      "injuries": [
        {
          "bodyPart": "...",
          "description": "...",
          "consequences": "...",
          "category": "One of: ${formatOneOf(injuryCategories)}",
          "severity": <number between 0.0 and 1.0>,
          "decayPerPage": <number between 0.0 and 1.0>,
        }
      ]
    }
  ],
  "plannedCharacters": [
    {
      "characterId": "<character_id>",
      "plannedIntroduction": "...",
      "storyPurpose": "...",
      "importance": "One of: ${formatOneOf(characterImportances)}",
      "knownName": "...",
      "realName": "...",
      "gender": "One of: ${formatOneOf(genders)}",
      "role": "...",
      "bio": "...",
      "visualDescription": "..."
    }
  ],
  "initialRelationships": [
    {
      "sourceId": "<character_id_1>",
      "targetId": "<character_id_2>",
      "type": "One of: ${formatOneOf(relationshipTypes)}",
      "status": "One of: ${formatOneOf(relationshipStatuses)}",
      "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}"
    }
  ],
  "initialFacts": [
    {
      "key": "fact.key",
      "value": "Fact Value",
      "type": "One of: ${formatOneOf(Object.keys(factTypes))}",
      "reason": "Reason for the fact"
    }
  ],
  "aiFinalComment": "Creative thriller-themed congratulations message (in the same language as the book)"
}`;

const firstBookReviewChecklist: string = `
1. Theme & MC Fit
  □ Does the MC's specific bio make this theme more dangerous for them personally? → If NO: adjust bio or infer a better-fit character.
  □ Is the psychological vulnerability in the bio something that will actually be used against them? → If NO: make it more specific.

2. Opening Disturbance
  □ Does page 1 open mid-moment (not with introduction or scene-setting)? → If NO: rewrite the opening.
  □ Is something subtly wrong by the end of the first paragraph? → If NO: inject it.
  □ Does the page end on tension or uncertainty — not resolution? → If YES to resolution: cut or reframe the ending beat.
  □ Is the mood field reflecting the disturbance specifically — not just the genre? → If NO: reassign.
  □ Long paragraph exist? → Break up long paragraph into separate lines to create rhythm and suspense.

3. Metadata Quality
  □ Is the title generic (e.g. "The Dark Secret", "Shadow House")? → If YES: rework. It should feel specific to this story.
  □ Does the hook create intrigue without revealing the ending type? → If NO: obscure the trajectory.
  □ Are keywords mood/theme-specific rather than pure genre tags? → If NO: replace generic tags with specific ones.
  □ Is the MC's name consistent in the title, summary, and hook? → If NO: revise to be consistent.

4. Action Diversity
  □ Are the actions meaningfully distinct in risk and emotional register? → If NO: revise until they vary (reckless / cautious / emotional / avoidant).
  □ Could any two actions lead to the same implied consequence? → If YES: differentiate them.
  □ Does at least one action feel subtly wrong or inadvisable? → If NO: add one.

5. Character & Place Integrity
  □ Do charactersPresent IDs exactly match IDs in initialCharacters? → If NO: align them.
  □ Does at least one initial character have a relationship that can corrupt? → If NO: adjust bio or relationship.
  □ Does the initial place familiarity reflect the MC's actual history with it? → If NO: correct the value.
  □ Is the place context evocative (atmosphere) rather than descriptive (facts)? → If NO: rewrite.

6. Initial State Calibration
  □ Are flags set based on the opening scene — not generic defaults? → If NO: reassign based on what just happened on page 1.
  □ Is the viableEnding specific to this MC and theme — not a genre template? → If NO: rewrite with this story's specific details.
  □ Does the difficulty reflect how hostile this world is to this specific MC? → If NO: adjust.

7. JSON Integrity
  □ All fields present and populated? → If NO: complete missing fields.
  □ No trailing commas? → Fix any.
  □ age is a number, not a range string? → Fix if needed.
  □ familiarity is a decimal between 0.0 and 1.0? → Fix if needed.
  □ totalPages within ${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} bounds? → Fix if out of range.`;

const nextPageOutputFormat: string = `{
  "text": "...",
  "mood": "One of: ${formatOneOf(moods)}",
  "placeId": "<place_id>",
  "weather": "One of: ${formatOneOf(placeWeathers)}",
  "calendarDate": "<yyyy-MM-dd>",
  "timeOfDay": "...",
  "minutesPassed": <number>,
  "sceneType": "One of: ${formatOneOf(Object.keys(sceneTypes))}",
  "charactersPresent": [
    {
      "characterId": "<character_id>",
      "sceneRole": "One of: ${formatOneOf(characterSceneRoles)}",
      "sceneFocus": <number between 0.0 and 1.0>
    }
  ],
  "keyEvents": [],
  "importantObjects": [],
  "traumaTagUpdates": { "add": [], "remove": [] },
  "addPlotFlags": [{
    "fact": "...",
    "type": "One of: ${formatOneOf(plotFlagTypes)}",
    "isMajorEvent": <boolean>
  }],
  "inventory": [
    {
      "name": "...",
      "traits": [
        { "key": "...", "value": "..." }
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
      "category": "One of: ${formatOneOf(injuryCategories)}",
      "severity": <number between 0.0 and 1.0>,
      "decayPerPage": <number between 0.0 and 1.0>,
      "pageAcquired": <number>
    }
  ],
  "contextHistory": "...",
  "futureNoteUpdates": {
    "add": [
      {
        "note": "...",
        "isMajor": <boolean>,
        "tag": "One of: ${formatOneOf(Object.keys(factTypes))}",
        "schedule": [
          { "type": "phase", "phase": "One of: ${formatOneOf(storyPhaseKeys, '|')}" },
          { "type": "page", "range": "<min>-<max>" },
          { "type": "day", "day": <integer> },
          { "type": "date", "date": "YYYY-MM-DD" }
        ],
        "stateTrigger": [
          { "type": "stability", "level": "One of: ${formatOneOf(Object.keys(stabilityLevels), '|')}" },
          { "type": "condition", "condition": "One of: ${formatOneOf(healthConditions, '|')}" },
          { "type": "healthPercent", "threshold": <0-100> },
          { "type": "mobilityPercent", "threshold": <0-100> },
          { "type": "actionPercent", "threshold": <0-100> },
          { "type": "mentalPercent", "threshold": <0-100> }
        ],
        "relatedThreadId": "<thread_id> or 'none'"
      }
    ],
    "remove": [<key>]
  },
  "addPlannedCharacters": [
    {
      "characterId": "<unique_id>",
      "knownName": "...",
      "realName": "...",
      "gender": "One of: ${formatOneOf(genders)}",
      "role": "...",
      "bio": "...",
      "visualDescription": "...",
      "importance": "One of: ${formatOneOf(characterImportances)}",
      "storyPurpose": "...",
      "plannedIntroduction": "..."
    }
  ],
  "factUpdates": [
    {
      "key": <new or existing key>,
      "value": "...",
      "page": <number>,
      "type": "One of: ${formatOneOf(Object.keys(factTypes))}",
      "reason": "..."
    }
  ],
  "flagUpdates": [
    {
      "type": "${formatOneOf(psychologicalFlagsTypes)}",
      "level": "${formatOneOf(flagLevels)}"
    }
  ],
  "actions": [
    {
      "text": "First-person action or dialogue",
      "type": "One of: ${formatOneOf(Object.keys(actionTypes))}",
      "hint": {
        "text": "Subtle implication of consequence",
        "type": "One of: ${formatOneOf(actionHintTypes)}"
      }
    }
  ],
  "characterUpdates": {
    "newCharacters": [
      {
        "characterId": "<new_character_id>",
        "knownName": "...",
        "realName": "...",
        "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
        "gender": "One of: ${formatOneOf(genders)}",
        "role": "...",
        "bio": "...",
        "visualDescription": "...",
        "status": "One of: ${formatOneOf(characterStatuses)}",
        "secrets": "...",
        "importance": "One of: ${formatOneOf(characterImportances)}",
        "relationshipToMC": {
          "type": "One of: ${formatOneOf(relationshipTypes)}",
          "status": "One of: ${formatOneOf(relationshipStatuses)}",
          "context": "..."
        },
        "pastInteractions": ["..."],
        "narrativeFlags": {
          "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
        },
        "traits": [
          { "key": "...", "value": "..." }
        ],
        "injuries": []
      }
    ],
    "updatedCharacters": [
      {
        "characterId": "<character_id>",
        "knownName": "...",
        "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
        "gender": "One of: ${formatOneOf(genders)}",
        "role": "...",
        "bio": "...",
        "visualDescription": "...",
        "status": "One of: ${formatOneOf(characterStatuses)}",
        "secrets": "...",
        "importance": "One of: ${formatOneOf(characterImportances)}",
        "relationshipToMC": {
          "type": "One of: ${formatOneOf(relationshipTypes)}",
          "status": "One of: ${formatOneOf(relationshipStatuses)}",
          "context": "..."
        },
        "newInteractions": ["..."],
        "narrativeFlags": {
          "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
        },
        "updateTraits": [
          { "key": "...", "value": "..." }
        ],
        "removeTraits": [],
        "injuries": []
      }
    ]
  },
  "relationshipUpdates": [
    {
      "sourceId": "<character_id_1>",
      "targetId": "<character_id_2>",
      "type": "One of: ${formatOneOf(relationshipTypes)}",
      "status": "One of: ${formatOneOf(relationshipStatuses)}"
    }
  ],
  "placeUpdates": {
    "newPlaces": [
      {
        "placeId": "<new_place_id>",
        "parentPlaceId": "Optional. <parent_place_id>",
        "knownName": "...",
        "realName": "...",
        "type": "One of: ${formatOneOf(placeTypes)}",
        "context": "...",
        "familiarity": <number between 0.0 and 1.0>,
        "isRealNameKnown": <boolean>,
        "hints": ["..."],
        "keyEvents": ["..."],
        "keyObjects": [
          {
            "name": "...",
            "traits": [
              { "key": "...", "value": "..." }
            ],
            "amount": <number>,
            "where": "..."
          }
        ],
        "traits": [
          { "key": "...", "value": "..." }
        ],
        "knownCharacters": [
          {
            "key": "<character_id>",
            "value": "<Context or interaction>"
          }
        ]
      }
    ],
    "updatedPlaces": [
      {
        "placeId": "<place_id>",
        "knownName": "...",
        "type": "One of: ${formatOneOf(placeTypes)}",
        "context": "...",
        "familiarityCorrection": <number between -0.5 to 0.5>,
        "isRealNameKnown": <boolean>,
        "addKeyEvents": ["..."],
        "addHints": [],
        "removeHints": [],
        "updateTraits": [
          { "key": "...", "value": "..." }
        ],
        "removeTraits": [],
        "knownCharacters": [
          {
            "key": "<character_id>",
            "value": "<Context or interaction>"
          }
        ]
      }
    ]
  },
  "placeConnectionUpdates": [
    {
      "sourceId": "<place_id_1>",
      "targetId": "<place_id_2>",
      "travelTime": "...",
      "routeType": "...",
      "accessibility": "One of: ${formatOneOf(placeAccessibilities)}",
      "updateObstacles": { "add": [], "remove": [] },
      "bidirectional": <boolean>,
      "notes": "..."
    }
  ],
  "threadUpdates": {
    "newThreads": [
      {
        "threadId": "<new_thread_id>",
        "title": "...",
        "question": "...",
        "priority": "One of: ${formatOneOf(threadPriorities)}",
        "truth": "One of: ${formatOneOf(threadTruths)}",
        "importance": <number between 0.0 and 1.0>,
        "summary": "...",
        "clues": [
          { "clue": "...", "isFalse": <boolean> }
        ]
      }
    ],
    "updatedThreads": [
      {
        "threadId": "<thread_id>",
        "status": "One of: ${formatOneOf(threadStatuses)}",
        "priority": "One of: ${formatOneOf(threadPriorities)}",
        "truth": "One of: ${formatOneOf(threadTruths)}",
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
    "closedThreads": []
  },
  "viableEnding": {
    "text": "...",
    "type": "One of: ${formatOneOf(Object.keys(endingTypes))}",
    "outline": [
      {
        "text": "...",
        "isDone": <boolean>,
        "doneAtPage": <number>
      }
    ],
    "changeNote": {
      "reason": "...",
      "viabilityBefore": <number between 0.0 and 1.0>,
      "viabilityAfter": <number between 0.0 and 1.0>
    }
  }
}`;

const multiNextPageOutputFormat: string = `{
  "generatedPages": [
    ${nextPageOutputFormat.split(`\n`).join(`\n    `)},
    ${nextPageOutputFormat.split(`\n`).join(`\n    `)}
  ],
  "output": "..."
}`;

function buildNextPagePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, candidateCount } = params;
  const { isFinale, isLastPage } = getStoryStateInfo(state);

  return [
    `TASK: ${formatNextPageTaskPrompt(state, candidateCount)}`,
    formatNextPageStoryContextPrompt(params),
    formatNextPageNarrativePrompt(params),
    state.plannedCharacters?.length && RULES_PLANNED_CHARACTERS,
    isLastPage && `BRANCHING ACTIONS:\n${getActionRulesText({ isFinale })}`
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

calendarDate:
  - Increment if the day has changed.
  - Write in 'yyyy-MM-dd' format (e.g., "2026-07-26").

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
  - sceneRole: One of: ${formatOneOf(characterSceneRoles)}
  - sceneFocus: between 0.0 to 1.0. Relative narrative importance in the current scene (highest = character to focus).

keyEvents
  - ${KEY_EVENT_LENGTH}. Plot-level facts only — what objectively happened (situation/exact hard facts).
${isLatePhase || isFinale ? `  - At least one event should connect to or resolve a thread opened earlier in the story.` : ''}

importantObjects
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
  - If healed but leaves permanent scar/story relevance, move to character's visualDescription.
  - If no meaningful injury-related action occurs, output empty array or omit this field entirely.
  - Otherwise, MUST include all previous injuries with updated values and/or new injury if any.
  - consequences: update any that affect the storyline (e.g. "Can't run fast, can't lift heavy objects").

traumaTagUpdates
  - Short evocative phrases for experiences that will haunt the MC later.
${traumaTags.length < MAX_TRAUMA_TAGS ? `  - Only add if something genuinely traumatic or psychologically significant occurs.` : `  - Maximum trauma tags reached. Can't add more.`}
  - Remove when trauma is resolved.
${isEarlyPhase ? `  - Max 1 per page. Plant sparingly — early trauma tags shape everything downstream.` : `  - Max 2 per page. Omit if none.`}
${isFinale ? `  - Existing trauma tags should be echoing and surfacing now, not new ones being added.` : ''}

futureNoteUpdates
${futureNotes.length < MAX_FUTURE_NOTES ? `  - ONLY add for important unresolved clues, revelations, promises, relationships, mysteries, or future developments which matter later.
  - Do NOT add for temporary details, completed events, or facts already captured by plot flags.
  - Prefer advancing existing future notes before creating new ones. Avoid duplicate or overlapping future notes.` : ''}
  - Future notes represent narrative obligations, not immediate requirements. Do not resolve a future note merely because it exists.
  - When a schedule window opens or a stateTrigger threshold is crossed, begin incorporating it naturally into the narrative.
  - schedule: array of time beats — use multiple items for OR logic (any firing activates).
  - stateTrigger: use only when the note genuinely depends on the MC reaching a physical or psychological threshold. Omit both for open-ended notes with no known trigger.
  - Remove notes which have been fulfilled or become irrelevant.
  - If fulfilling a future note materially changes the story, record the outcome as a plot flag.
  - Keep max ${MAX_FUTURE_NOTES} items. Only the most important unresolved future notes.

addPlannedCharacters
${!isLatePhase && charactersSlot > 0 ? `  - Add new planned character candidates for future introduction when the story needs fresh faces for upcoming beats.
  - This is for characters not yet on-page — they're seeds for future pages. Use characterUpdates.newCharacters instead if the new character is physically present on this page.
  - Each must have a distinct characterId. Avoid generic or throwaway plans.
  - storyPurpose: why this character exists and what role they'll play.
  - plannedIntroduction: brief hook describing how/when they might first appear.`
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

characterUpdates.newCharacters
${charactersSlot === 0 ? `  - Don't introduce new characters. ${MAX_CHARACTERS} characters limit reached.`
: isEarlyPhase ? `  - New characters are welcome up to ${charactersSlot} more — establish the cast now.`
: isMidPhase ? `  - You can optionally introduce up to ${charactersSlot} new characters only if genuinely necessary to support the story. Prefer deepening existing ones.`
: `  - No new characters. The cast is fixed. Late arrivals dilute stakes.`}
  - It's meant for characters beside MC (the POV). Don't include MC here.
  - When introducing new characters, ensure to describe their visual appearance, incorporate naturally in the storytelling.
${isEarlyPhase || isMidPhase ? `  - Name must feel authentic to the MC's age group, culture, and language context.
  - Create only when genuinely new to the story, if it strongly recommended and opportunity is right based on your assessment.
  - knownName: mandatory narration alias. If MC know, use actual/nick name. Otherwise, use descriptions, pronouns, roles, or words interpreted by MC.
  - bio: concise, suggestive over descriptive, include personality traits, one vulnerability or potential threat vector, and age if plot-sensitive. Never spoil secrets that haven't been revealed in the story.
  - visualDescription: visual description (e.g. height, skin color, eye color, hair, etc). Permanent physical attributes only, not ephemeral like clothing.
  - secrets: spoiler or hints of the character for AI narrative guidance (max ${MAX_CHARACTER_SECRETS}).
  - narrativeFlags: set to match behavior and twist setup.
  - pastInteractions: dialogue or event towards MC in current page.
  - relationships: only include known relationships to other named characters. Omit if none.` : ''}
  - traits: only story-relevant (e.g., interests).

characterUpdates.updatedCharacters
${isLatePhase || isFinale
? `  - Expect significant status and flag changes now. Characters should be fracturing or revealing.`
: `  - Only include characters whose state actually changed this page.`}
  - Only include changed fields, omit which unaltered.
  - bio: only gradually update character's bio if new information is revealed in this page.
  - knownName: gradually update mysterious character's known name as the MC learns more about his/her real identity.
  - recognitionLevel: how well does MC recognize this character at this point.
  - narrativeFlags: adjust to reflect plot developments.
  - secrets: remove any revealed secret.
  - traits: remove or update.
  - newInteractions: add new interactions from this page.
  - injuries: add or update (full replacement). Set severity to zero to remove.
  - visualDescription: only if character's appearance meaningfully changed (e.g., from permanent injury).
  - status: One of ${formatOneOf(characterStatuses)}
  - importance: One of ${formatOneOf(characterImportances)}
  - relationshipToMC: based on interaction and story progression.

relationshipUpdates
  - Changes in relationship between any two named characters (excluding MC).
  - Omit if no relationships shifted this page.
${isEarlyPhase ? `  - Subtle shifts only — early relationships should feel ambiguous, not defined.` : ''}
${isLatePhase || isFinale ? `  - Relationships should be breaking, inverting, or crystallizing. No more ambiguity.` : ''}

placeUpdates.newPlaces
${placesSlot === 0 ? `  - Don't introduce new places. Limit of ${MAX_PLACES} reached.`
: isEarlyPhase || isMidPhase ? `  - You can introduce up to ${placesSlot} new meaningful places the MC enters for the first time in this page — no generic one-offs.
  - context: ${PLACE_CONTEXT_LENGTH}. Evocative over descriptive.
  - hints: known clues, obstacles, spatial relationship to known places (e.g., "500 meters behind school"). Must be consistent to build a "world map."
  - familiarity: start at 0.0-0.2 unless MC has prior history with this place.
  - traits: include relevant information about this place (e.g., smell, sound, visual, feeling).
  - knownCharacters: include relevant characters (beside MC) with meaningful context.
  - keyEvents: any important event happening in the scene.
  - keyObjects: any important objects to remember in the scene.
  - Might need to update other places' hint to link with this new place.`
: `  - New places should not be introduced. If the MC is somewhere new, question whether it's necessary.`}

placeUpdates.updatedPlaces
  - Only update on revisit or significant event.
  - Include only changed fields: addKeyEvents (1 contextual sentence), knownCharacters (with meaningful context update), keyObjects (overwrite), and traits change.
  - familiarityCorrection: always 0 except on major condition:
    → place changes drastically, or something fundamentally changes how the MC understands the place.
    → learns important hidden functions or secrets, discovers substantial new areas, gains significantly deeper understanding of the place.
    → memory loss/confusion, familiar assumptions are proven false, environment becomes unrecognizable.
    → Do NOT use for ordinary visits, repeated exposure, spending time in a place, or learning the place gradually. Those changes are handled automatically by the system.
${isLatePhase || isFinale ? `  - High-familiarity places revisited now should feel distorted.` : ''}

placeConnectionUpdates
  - Add new if visiting/adding a new place or when a place is first connected.
  - Only update existing if route conditions meaningfully change on revisit.
  - travelTime: Estimated travel duration (e.g., "5 minutes walk", "20 minutes drive").
  - routeType: Primary route description (e.g., "main street", "alley", "tunnel").
  - accessibility: One of: ${formatOneOf(placeAccessibilities)}.
  - updateObstacles: Current story-relevant barriers, hazards, or access requirements.
  - notes: Short route details not covered elsewhere.

threadUpdates.newThreads
${isFinale ? `  - Do NOT introduce new threads. The story is in finale.`
: isLatePhase ? `  - Avoid introducing new threads. Focus on resolving existing ones.`
: isEarlyPhase ? `  - Introduce 1-2 core mysteries if this is early in the story. Each thread should have a compelling question that connects to the psychological premise.`
: isMidPhase ? `  - Introduce new threads only if essential to plot (max 1 per page). New threads should branch from existing mysteries.`
: `  - New threads should be rare now.`}
${isEarlyPhase || isMidPhase ? `  - title: Short, evocative name for the mystery (e.g., "Lisa's Identity", "The River Incident")
  - question: central mystery question (e.g., "Who is Lisa really?", "What happened at the river that night?")
  - priority: "main" for central mysteries, "secondary" for supporting mysteries, "minor" for background details
  - truth: "true" if the thread leads to genuine revelation, "false" if it's a deliberate misdirection, "unknown" if ambiguous
  - importance: 0.0-1.0 (how frequently this thread should appear in the narrative)` : ''}

threadUpdates.updateThreads
  - Update existing threads when their status, priority, or urgency meaningfully changes.
  - threadId: must match an existing thread ID.
  - status: ${isLatePhase ? 'update to "revealed" or "closed" as threads converge toward the ending.' : '"open" (newly introduced), "developing" (active investigation), "revealed" (truth partially shown), "closed" (resolved).'}
  - urgencyCorrection: explicit closeness adjustment to a reveal/twist/resolution (e.g., +0.20 = major breakthrough, -0.15 = mystery became more complicated). Do not use for normal progression, new clues, or routine thread development. The system already handles those automatically.
  - summary: running summary of thread development (from the start to current).
  - resolution: only include when thread is being closed or resolved (brief summary of the answer).
  - If this page develops, complicates, advances, or revisits an active thread, include a summary update for that thread.
${isFinale ? `  - Every main thread must be resolved (status: "closed" with resolution text).` : ''}

threadUpdates.addClues
${isEarlyPhase || isMidPhase ? `  - Add clues to existing threads to advance mysteries.
  - threadId: must match an existing thread ID.
  - clue: short, evocative clue that advances the mystery (e.g., "She knows my mother", "Flashbacks of water").
  - isFalse: set to true if this is a deliberate misdirection (false clue).` : ''}
${isLatePhase ? `  - Add revealing clues that push threads toward resolution.` : ''}
${isFinale ? `  - Add final clues that complete thread resolutions.` : ''}

${isLatePhase ? 'threadUpdates.closeThreads' : ''}
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

function buildNextPageReviewChecklist(state: StoryState): string {
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale } = getStoryStateInfo(state);

  return `
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

8. Choice Quality
  □ Page ends at genuine tension or unresolved disturbance — not resolution? → If NO: reposition the final beat.
  □ Choices meaningfully distinct in risk and emotional register? → Vary across: reckless / cautious / emotional / avoidant.
  □ At least one choice feels like a trap? → If NO: add a concealed consequence to the safest-looking option.
  □ All choices appear plausibly reasonable on the surface? → If NO: soften the dangerous framing so the trap isn't visible.
  ${isEarlyPhase ? `□ Choices seed curiosity — not force immediate crisis? → Avoid options that escalate to irreversible stakes too soon.` : ''}
  ${isMidPhase ? `□ Choices reflect the player's established psychological profile? → Options should feel designed for how this player thinks.` : ''}
  ${isLatePhase || isFinale ? `□ Choices feel increasingly constrained — like the story is closing in? → Reduce options or weight every path with consequence. On the finale: there is no good option, only degrees of loss.` : ''}`;
}

function buildNextPageEvaluatorPrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, candidateCount } = params;
  const { isEarlyPhase, isMidPhase, isLatePhase, isFinale, charactersSlot } = getStoryStateInfo(state);
  const { action, sceneType } = actionedPage;

  const taskPrompt = `TASK: Evaluate a newly generated branching story page from selected action, refine output, and re-evaluate — in that order.

Original task (on previous AI): ${formatNextPageTaskPrompt(state, candidateCount)}

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
- familiarity is a decimal between 0.0 and 1.0
- charactersPresent IDs exist in "KNOWN CHARACTERS"${isFinale || charactersSlot === 0 ? '' : ` or in characterUpdates.newCharacters`}
- All mandatory fields present and filled

---
OUTPUT FORMAT (strict JSON, no extra text):
{
  "output": { ...reconstructed and corrected page JSON },
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
  const { theme, mcCandidate, titleIdea } = params;
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
- totalPages is within ${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} bounds
- MC's age is a number between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}
- familiarity is a decimal between 0.0 and 1.0
- language is a valid ISO 639-1 code
- All mandatory fields present and filled

---
OUTPUT FORMAT (strict JSON, no extra text):
{
  "output": { ...reconstructed and corrected book initialization JSON },
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

function getActionRulesText(stateInfo: Partial<StoryStateInfo>): string {
  const { isFirstPage, isFinale } = stateInfo;
  const limit = isFirstPage || isFinale ? MAX_ACTION_CHOICES_FIRST_PAGE : MAX_ACTION_CHOICES;

  return `Generate ${MIN_ACTION_CHOICES}-${limit} actions to choose:
- Can be verb (what to do next) or dialogue (say/answer), ${ACTION_TEXT_LENGTH}
- Represent the reader's decision - must feel natural, immediate, narrative-driven
- You can mix both types naturally depending on the situation
- Example: A. "Who are you?" / B. Run away, fast
- If no action needed or viable, give only 1 action to continue

${isFinale ? `ENTROPY COLLAPSE SYSTEM (NEAR END):
- Reduce number of meaningful actions while still sustaining immersion
- Choices may exist, but should increasingly lead to similar outcomes
- Make actions feel constrained, inevitable, or repetitive
- Example actions: A. Open the door / B. Knock first
  Both → door opens` : `ACTION RULES:
- Actions must be short, meaningfully distinct — each lead to very different path
- Action text must be unique (important) — it's used for identifier
- No two actions should lead to the same implied consequence
- Choice pattern: safe / risky / ambiguous
- Occasionally include deceptive choice
- Avoid over-explaining actions`}`;
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
  switch (hintType) {
    case "dark_discovery": return "Focus on atmosphere and emotional impact. Avoid revealing discovery immediately. Build tension through sensory details and MC's internal reaction rather than external events.";
    case "relationship_revelation": return "Reveal through dialogue and character interactions. Show relationship dynamics through subtext and emotional responses rather than direct exposition.";
    case "betrayal": return "Create suspicion and unease. Use unreliable narration, subtle inconsistencies, and character behavior changes rather than stating betrayal directly.";
    case "confrontation": return "Emphasize power dynamics and survival instinct. Use physical sensations, environmental threats, and MC's limitations rather than detailed creature descriptions.";
    case "truth_revelation": return "Reveal through fragmented memories and environmental storytelling. Use symbolism, metaphor, and gradual realization rather than direct exposition.";
    case "survival": return "Focus on immediate consequences and resource limitations. Use time pressure, environmental hazards, and MC's physical/mental state rather than planning solutions.";
    case "psychological": return "Explore internal conflict and perception issues. Use unreliable narration, memory inconsistencies, and blurred reality rather than psychological analysis.";
    case "custom": return "Reader provided unique direction. Honor their creative intent while maintaining narrative consistency. Weave their suggestion naturally into the story's existing themes and character development, avoiding abrupt tonal shifts or plot contradictions.";
    default: return "Develop naturally with appropriate tone for the action type and context.";
  }
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
}): string {
  const {
    futureNotes,
    currentPage,
    currentPhase,
    currentDay,
    currentDate,
    currentHealthStatus,
    currentStability,
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

  // Find the index of selected action to get the letter
  const selectedIndex = allActions.findIndex(action => action.text === action.text);
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
function formatActiveThreads(threads: StoryThread[]): string {
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

    return [
      header,
      recent.length && `  Recent clues:\n${recent.join('\n')}`,
      `  Priority: ${t.priority}`,
      `  Urgency: ${t.urgency.toFixed(2)}`,
      t.truth !== 'unknown' && `  Reality: ${t.truth}`,
    ].filter(Boolean).join('\n');
  }).join('\n');
}

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
- Focus on 1-2 threads per page
- Deepen mysteries through clues, contradictions, or unsettling discoveries
- When a thread is revisited or meaningfully developed, update that thread even if no new clue is added
- Use false clues sparingly to create plausible but incorrect conclusions
- Plant seeds for future mysteries without fully activating them
- Prefer developing existing threads over creating new ones`;
  }

  // Mid phase: Balance development with progression
  if (isMidPhase) {
    return `
${atThreadLimit ? `- Do NOT introduce new threads (active thread limit reached)` : `- Introduce at most 1 new thread if truly needed`}
- Focus on 1-2 threads per page
- Advance, complicate, or partially reveal existing mysteries
- When a thread is revisited or meaningfully developed, update that thread even if no new clue is added
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

function formatEndingPlan(ending?: Ending): string {
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

function formatThreadsPrompt(threads: StoryThread[], stateInfo: StoryStateInfo): string {
  return `ACTIVE THREADS:
${formatActiveThreads(threads)}

THREAD RULES:
${formatThreadRules(threads, stateInfo).trim()}`;
}

function formatEndingPrompt(state: StoryState): string {
  return `CURRENT ENDING PLAN:
${formatEndingPlan(state.viableEnding)}

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
 * @returns A prompt string ready to be inserted as the `TASK:` section of the user message.
 *
 * @example
 * // Single page, mid-story
 * formatNextPageTaskPrompt({ page: 4, maxPage: 10, memoryIntegrity: 'stable', ... }, 1);
 * // → 'Continue the story in first-person ("I") POV. You're now writing page 4 of 10 — 6 pages remaining.'
 *
 * @example
 * // Two alternate fates, degraded memory integrity
 * formatNextPageTaskPrompt({ page: 4, maxPage: 10, memoryIntegrity: 'fragmented', ... }, 2);
 * // → 'Continue the story in first-person ("I") POV. You're now writing page 4 of 10 — 6 pages remaining.
 * //    Generate 2 alternate-fate continuations — parallel timelines in the multiverse.
 * //    Each continuation must follow all the same narrative rules above, but diverge
 * //    into a distinct, unexpected outcome.
 * //    Occasionally, let a faint echo bleed across timelines — a déjà vu, a half-remembered
 * //    feeling or hallucination — but keep it subtle.'
 */
function formatNextPageTaskPrompt(state: StoryState, candidateCount: number): string {
  const { page, maxPage, memoryIntegrity, flags } = state;
  const { trust, curiosity } = flags;
  const remainingPages = maxPage - page;

  const pageLabel = remainingPages > 0
    ? `page ${page} of ${maxPage} — ${remainingPages} page${remainingPages === 1 ? '' : 's'} remaining`
    : `the final page of the book. The story ends completely right now.`;

  const base = `Continue the story in first-person ("I") POV. You're now writing ${pageLabel}.`;

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
    ├── Empty, but echoes of his voice linger
    ├── A missing fellow waits in the dark
    ├── Something breathes inside
    └── The room shouldn't exist`;
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
 *   importantObjects: ['mysterious book'],
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
  const { mood, placeId, weather, timeOfDay, sceneType, momentum, charactersPresent = [], importantObjects = [], keyEvents = [] } = page;
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
        return `  · ${characterId} (${sceneRole}, focus: ${sceneFocus}) [not present in known characters, add it via characterUpdates.newCharacters]`;
      }
      const { knownName, role } = character;
      return `  · ${knownName} (${role} - ${sceneRole}, focus: ${sceneFocus}) [ID: ${characterId}]`;
    }).join('\n')}`);
  }
  
  // Add important objects if any
  if (importantObjects.length) situation.push(`Important objects:\n${importantObjects.map(obj => `  · ${obj}`).join('\n')}`);
  
  // Add key events if any
  if (keyEvents.length) situation.push(`Key events:\n${keyEvents.map(event => `  · ${event}`).join('\n')}`);
  
  return situation.map(item => `- ${item}`).join('\n');
}

function formatNextPageStoryContextPrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, actionedPage, previousPages, book } = params;
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

${formatRecentMajorEvents(plotFlags)}

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
  const { advancedState: state, actionedPage } = params;
  const { flags, psychologicalProfile, hiddenState, threads, memoryIntegrity, futureNotes, healthStatus } = state;
  const stateInfo = getStoryStateInfo(state);
  const { currentPage, phase, isFinale } = stateInfo;
  const { calendarDate, elapsedDays } = actionedPage;

  console.log(`[formatNextPageNarrativePrompt] 🥂 isFinale?`, {phase, isFinale});

  return `NARRATIVE STYLE & PROSE ATMOSPHERE:
${createNarrativeStyle(state).instructions}

PSYCHOLOGICAL FLAGS (Accumulated):
${formatPsychologicalFlags(flags, memoryIntegrity)}

PSYCHOLOGICAL PROFILE (Behavioral analysis):
${formatPsychologicalProfile(psychologicalProfile)}

---
HIDDEN STATE (Influence writing, don't reveal):
${formatHiddenState(hiddenState, currentPage)}

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
})}

---
${formatThreadsPrompt(threads, stateInfo)}

---
${formatEndingPrompt(state)}`;
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
  const { isLastPage, isFinale, finalePhase = "EARLY" } = getStoryStateInfo(state);
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
  const nextDestination = outline.find(o => !o.isDone);

  return `- Gradually steer story toward viable ending plan${nextDestination ? ` (next in outline: "${nextDestination.text}")` : ''}
- IMPORTANT: NEVER SPOIL this ending plan
- Plant small hints across pages; don't fully explain or reveal early
- Increase hint intensity as story progresses: early pages → very subtle, later pages → more obvious but still indirect
${trapDirective ? `\n${trapDirective}\n` : ''}
If the current viable ending is no longer viable, re-determine based on:
- Psychological profile (archetype and stability)
- Profile archetype: ${psychologicalProfile.archetype}
- Profile stability: ${psychologicalProfile.stability}
- Psychological flags
- Detected shift: ${profileShift?.detected ? profileShift.shiftType : "none"}

Recommended ending type (heuristic): ${optimalEnding.type}
${optimalEnding.summary}
Because:
${formatKeyValueList(optimalEnding.because)}`;
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
• Memory Integrity: ${memoryIntegrity}`;
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
  getStoryStateInfo(state);
  return `• Trauma tags: ${traumaTags.join(', ')}
• Difficulty: ${difficulty}`;
}

// /**
//  * Formats action history for prompt display
//  * 
//  * Creates a formatted string of past actions with page numbers,
//  * action text, types, and hints for AI context.
//  * 
//  * @param actionsHistory - Array of action history items with page numbers
//  * @returns Formatted string with actions as bullet points including hints
//  * 
//  * @example
//  * ```typescript
//  * const actions = [
//  *   { page: 1, text: "Investigate noise", type: "explore", hint: { text: "Something awaits", type: "consequence" } },
//  *   { page: 2, text: "Run away", type: "flee", hint: { text: "Escape is impossible", type: "consequence" } }
//  * ];
//  * const formatted = formatActionHistory(actions);
//  * // Returns:
//  * // "• Page 1: Investigate noise (type: explore)
//  * //   → Hint: Something awaits
//  * // • Page 2: Run away (type: flee)
//  * //   → Hint: Escape is impossible"
//  * ```
//  */
// function formatActionHistory(actionsHistory: ActionHistory[]): string {
//   return actionsHistory.slice(-MAX_ACTION_HISTORY).map(a => {
//     return `• Page ${a.page}: ${a.text} (type: ${a.type})\n  → Hint: ${a.hint.text || 'none'}`;
//   }).join('\n');
// }

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
      .map(([key, fact]) => `• ${key}: ${fact.value} (from page ${fact.page})`)
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

    const lines = items.map(([key, fact]) => `• ${key}: ${fact.value} (from page ${fact.page})`);
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
 * Validates AI configuration parameters against acceptable bounds
 * 
 * @param config - AI configuration to validate
 * @returns Validated and corrected AI configuration
 */
function validateAIConfig(config: AIChatConfig): AIChatConfig {
  // Temperature bounds
  if (config.temperature < MIN_TEMPERATURE) {
    console.warn('[validateAIConfig] ⚠️ Temperature too low, clamping to', MIN_TEMPERATURE);
    config.temperature = MIN_TEMPERATURE;
  } else if (config.temperature > MAX_TEMPERATURE) {
    console.warn('[validateAIConfig] ⚠️ Temperature too high, clamping to', MAX_TEMPERATURE);
    config.temperature = MAX_TEMPERATURE;
  }

  // topP bounds
  if (config.topP < MIN_TOP_P) {
    console.warn('[validateAIConfig] ⚠️ topP too low, clamping to', MIN_TOP_P);
    config.topP = MIN_TOP_P;
  } else if (config.topP > MAX_TOP_P) {
    console.warn('[validateAIConfig] ⚠️ topP too high, clamping to', MAX_TOP_P);
    config.topP = MAX_TOP_P;
  }

  // topK bounds
  if (config.topK < MIN_TOP_K) {
    console.warn('[validateAIConfig] ⚠️ topK too low, clamping to', MIN_TOP_K);
    config.topK = MIN_TOP_K;
  } else if (config.topK > MAX_TOP_K) {
    console.warn('[validateAIConfig] ⚠️ topK too high, clamping to', MAX_TOP_K);
    config.topK = MAX_TOP_K;
  }

  // maxOutputToken bounds
  if (config.maxOutputToken < MIN_OUTPUT_TOKENS) {
    console.warn('[validateAIConfig] ⚠️ maxOutputToken too low, clamping to', MIN_OUTPUT_TOKENS);
    config.maxOutputToken = MIN_OUTPUT_TOKENS;
  } else if (config.maxOutputToken > MAX_OUTPUT_TOKENS) {
    console.warn('[validateAIConfig] ⚠️ maxOutputToken too high, clamping to', MAX_OUTPUT_TOKENS);
    config.maxOutputToken = MAX_OUTPUT_TOKENS;
  }

  return config;
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
function determineAIConfig(state: StoryState): AIChatConfig {
  let config = AI_CHAT_CONFIG_CREATIVE;

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
  const { theme, language } = params;
  return `TASK: Create a psychological thriller story from this theme input from user:\n"""\n${theme.trim()}\n"""

Align language with theme input${language ? ` (current detected: "${language}")` : '. Use English ("en") if uncertain'}.

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
${getActionRulesText({ isFirstPage: true })}`;
}

const firstBookFieldInstructions: string = `Book Metadata:
- title: ${BOOK_TITLE_LENGTH}. If provided in theme, use it. Otherwise, NEVER start with "The" except it's really good. Be creative, mysterious, visceral (you feel it), memorable, not generic.
- hook: ${HOOK_LENGTH}. Immediate intrigue. Psychological tension.
- summary: ${SUMMARY_LENGTH}. Sets up premise without revealing the ending plan.
- keywords: ${KEYWORDS_COUNT} kebab-case tags for theme, genre, mood, and story categorization (keep each short).
- totalPages: min ${BOOK_MIN_PAGES}, max ${BOOK_MAX_PAGES}. Avoid exact multiples of 10. Let theme complexity and MC arc influence the count. If user mention anything about total pages, respect it as long as it's within bounds.
- language: detected language code (ISO 639-1).

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
- narrativeFlags: set to match behavior and twist setup.
- traits: only story-relevant (e.g., skills, hobbies).
- Every initial character should serve at least one purpose: deepen the MC, increase tension, introduce information, create conflict, or foreshadow future events.
- Avoid background characters that have no narrative value.

plannedCharacters:
- Infer any side characters from the theme input that have not yet appeared on this first page.
- You may infer additional major characters if they naturally strengthen the premise.
- Do not include background NPCs or disposable one-scene characters.
- Each planned character should have a clear future narrative purpose.
- plannedIntroduction should explain how this character planned to be introduced: when they are likely to appear, why they matter, how they connect to the MC or central mystery.
- storyPurpose: why this character exists in the story and how they contribute to the MC's journey, central mystery, or ending (avoid describing specific future events).

initialRelationships:
- Only between side characters (excluding MC). If initial characters is less than two, omit it.
- For relationship which targetting MC, put it in character's relationshipToMC.

firstPage:
- text: follow the rules in "WRITING STYLE:" and "PAGE FORMAT:" creatively (max ${MAX_WORDS_PER_PAGE} words).
- keyEvents: ${KEY_EVENT_LENGTH}. Plot-level facts happened in this page.
- charactersPresent: side characters in the scene besides MC. Must match characters in initialCharacters. sceneFocus: between 0.0 to 1.0 (highest = character to focus).
- importantObjects: objects introduced or used this page that may have future narrative significance.
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
- Use creative thriller-themed wording in the same language as the book.
- Express excitement for the published book.
- Tell what happened in the first page.
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
 * @param params.req - Optional Express request object for activity logging
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
    // language: detectedLanguage,
    req,
    bookId: draftBookId,
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

  try {
    // ── 1. Signal initialisation start ───────────────────────────────────────
    await onProgress?.({ type: 'book_initialization_start' });
    await onGenerationProgress('book_initialization');

    // ── 2. Build and execute AI prompt for full book creation ─────────────────
    const prompt = buildBookCreationPrompt(params);

    const response = await executePromptForJSON<BookCreationResponse>(
      {
        prompt,
        configs: {
          schema: BOOK_CREATION_SCHEMA_DEFINITION,
          requiredFields: BOOK_CREATION_REQUIRED_FIELDS,
          fallbackField: 'summary',
          baseOptions: {
            config: AI_CHAT_CONFIG_DEFAULT,
            modelSelection: AI_CHAT_MODELS_WRITING,
            context: 'book-creation',
            logPrompts: true,
            systemPrompt: PROMPT_SYSTEM_FIRST_PAGE_GENERATION,
          },
        } satisfies AIPromptForJson<BookCreationResponse>,
        jsonStructure: firstBookOutputFormat,
        fieldInstructions: firstBookFieldInstructions,
        thinkThenOutput: firstBookReviewChecklist,
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
      viableEnding,
      futureNotes,
      aiFinalComment,
    } = response.result;

    // Validate first page text length
    if (generatedFirstPage.text.length < MIN_CHARS_PER_PAGE) {
      throw new Error('Failed to generate book: first page text is too short');
    }

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
        hook,
        summary,
        keywords,
        mc,
        totalPages,
        language, // Match with theme input
        status: finalStatus, // 'archived' if user cancelled at PoNR, 'active' otherwise
        visibility: isOriginal ? 'public' : undefined,
        originalThemeInput: theme
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
        hook,
        summary,
        keywords,
        mc,
        isOriginal,
        visibility: isOriginal ? 'public' : undefined,
        originalThemeInput: theme
      };
      const dbBook = await insertBook(newBookData, { client, alternativeTitles });
      book = mapBookFromDb(dbBook);
      bookId = book.id;
    }

    const characters: Record<string, CharacterMemory> = Object.fromEntries<CharacterMemory>(initialCharacters.map<[string, CharacterMemory]>(char => [
      char.characterId,
      {
        ...char,
        pastInteractions: char.pastInteractions?.map<PastInteraction>(i => ({ page: 1, interaction: i, placeId })) ?? [],
        narrativeFlags: {
          ...{ potentialTwist: 'none' },
          ...char.narrativeFlags
        },
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

    const placeId = initialPlace.placeId;
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
      ...generatedFirstPage,
      stateDelta: {},
      placeId,
    };
    const firstPage = await insertStoryPage(userId, 1, pageToInsert, {
      bookId,
      branchId: 'main',
      aiResponseProvider: response,
      storyStartDate: generatedFirstPage.calendarDate
    }, { client });

    const { id: pageId, calendarDate, timeOfDay, actions } = firstPage;
    console.log(`[initializeBook] 📔 First page of "${book.title}" inserted:`, filterObjectEntries(firstPage));
    console.log(`[initializeBook] 👉 Generated ${actions.length} actions for first page:`, actions.map(a => a.text));

    // ── 8. Build initial story state ──────────────────────────────────────────
    const injuries = generatedInitialState.injuries?.map<Injury>((injury) => ({ ...injury, pageAcquired: 1, placeId })) || [];
    const healthStatus = calculateHealthStatus(injuries);

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
        viableEnding: viableEnding ? { ...viableEnding, outline: viableEnding.outline.map(text => ({ text, isDone: false })) } : undefined,
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
  const promptParams: BuildNextPagePromptParams = {
    book,
    actionedPage,
    advancedState,
    previousPages,
    candidateCount,
  };

  const prompt = buildNextPagePrompt(promptParams);
  const bookMeta = buildBookMetaDocuments(book, advancedState);
  
  // 2. Determine optimal AI configuration based on story progress and psychological state
  const config = determineAIConfig(advancedState);

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
    systemPrompt: PROMPT_SYSTEM_NEXT_PAGE_GENERATION,
    fieldInstructions: buildNextPageFieldInstructions(advancedState, action, sceneType),
    thinkThenOutput: buildNextPageReviewChecklist(advancedState),
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
  console.log(`[resolvePageDelta] 🔮 futureNoteKeys (${futureNoteKeys.length}):`, futureNoteKeys);
  if (duplicateKeys) {
    // TODO: Investigate double key issue
    console.warn(`[resolvePageDelta] ⚠️ ${duplicateKeys} duplicate futureNoteKeys found. Should be none.`);
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
 * The function uses the sophisticated configuration system from determineAIConfig()
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
  const { book, userId, actionedPage, generateNewBranchId = false } = params;
  const context = "generateNextPage";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, cachedContentId, fieldInstructions, thinkThenOutput, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, 1);
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
    thinkThenOutput,
    evaluatorPrompt,
  });
  
  // 4. Validate AI response
  if (!response.result) {
    throw new Error('Failed to generate page: no result');
  }

  // 5. Apply state updates
  const generatedStoryPage: StoryGeneration = {
    ...response.result,
    calendarDate: response.result.calendarDate ?? actionedPage.calendarDate,
  };

  const { newState, fullStateDelta } = resolvePageDelta({
    generatedStoryPage,
    advancedState,
    currentState,
    expectedPageNumber,
    context
  });

  // 6. Determine Branch ID
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

  // 7. Persist page and its state atomically
  return persistPageWithState({
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
  const { book, userId, actionedPage, generateNewBranchId = false, candidateCount: providedCandidateCount = DEFAULT_CANDIDATE_PAGE_PER_ACTION } = params;
  
  // Fast path: Route to single page generation if only 1 is requested
  if (providedCandidateCount === 1) return [await generateNextPage(params)];

  const candidateCount = Math.min(providedCandidateCount, MAX_CANDIDATE_PAGE_PER_ACTION);
  if (providedCandidateCount > candidateCount) {
    console.warn(`[generateNextPages] ⚠️ candidateCount ${providedCandidateCount} clamped to ${MAX_CANDIDATE_PAGE_PER_ACTION}`);
  }

  const context = "generateNextPages";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, cachedContentId, fieldInstructions, thinkThenOutput, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, candidateCount);
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
    thinkThenOutput,
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
    const generatedStoryPage: StoryGeneration = {
      ...generatedStoryPageResult,
      calendarDate: generatedStoryPageResult.calendarDate ?? actionedPage.calendarDate,
    };

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
  const { prompt, configs, jsonStructure, fieldInstructions, thinkThenOutput, evaluatorPrompt } = params;
  const supportsStructuredOutput = Boolean(configs.schema && configs.requiredFields?.length); // schema and required fields is specified

  // When structured output is active, send only a compact field-list reminder
  // instead of the full verbose JSON template. Saves ~1 000–2 000 tokens.
  const outputFormatPart = supportsStructuredOutput
    ? `OUTPUT FORMAT: Respond with valid JSON matching the schema provided.\nRequired fields: ${configs.requiredFields.join(', ')}`
    : `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}\n\nIMPORTANT: Return ONLY the raw JSON object. Must begin exactly with the character '{'.`;

  const fieldInstructionsPart = fieldInstructions ? `FIELD INSTRUCTIONS:\n${stripEmptyLines(fieldInstructions)}` : '';
  const thinkThenOutputPart = thinkThenOutput ? `REVIEW & FIX (IMPORTANT):

Silently evaluate your generated output using the checklist below.
If any item fails, revise internally before producing final output.

${stripEmptyLines(thinkThenOutput)}

Only output the final corrected JSON.
Do NOT mention this checklist.` : '';

  // Cache optimized: sort static > semi-static > dynamic
  // Output specifications and instructions at the top is the industry best practice for prompt caching
  const userPrompt = [
    // Semi-static
    fieldInstructionsPart,
    thinkThenOutputPart,
    // Dynamic
    prompt.trim(),
  ].join('\n\n---\n');

  // Static outputFormatPart combined with the system prompt
  const options = createAIOptionsWithSchema<T>(configs);
  options.systemPrompt = `${options.systemPrompt ?? PROMPT_SYSTEM}\n\n---\n${outputFormatPart}`;

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
  const systemPrompt = `You are a creative writing assistant specializing in generating engaging story concept for interactive thriller, mystery, horror, and psychological fiction novels.

TASK: Generate a compelling story concept that another AI will use as the foundation for generating an entire branching novel.

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

  const lang = formatLanguage(headerLanguage || 'en');
  const userPrompt = `Generate a creative and engaging story prompt for a thriller/horror interactive fiction novel. Be specific and intriguing. Write the prompt in the target language: ${lang}.`;

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