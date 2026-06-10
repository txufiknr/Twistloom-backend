import { AI_CHAT_CONFIG_DEFAULT, AI_CHAT_CONFIG_HUMAN_STYLE, DEFAULT_MAX_OUTPUT_TOKEN } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_THEME, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { characterRecognitionLevels, characterStatuses, potentialTwistTypes, relationshipStatuses, relationshipTypes } from "../types/character.js";
import { actionTypes, moods, archetypes, stabilityLevels, manipulationAffinities, type StoryState, type Action, actionHintTypes, type PsychologicalFlags, type PsychologicalProfile, truthLevels, threatProximities, realityStabilities, type HiddenState, type PersistedStoryPage, type ActionHintType, type AIActionConfig, endingTypes, finalePhases, plotFlagTypes, factTypes, storyPhases, flagLevels, psychologicalFlagsTypes } from "../types/story.js";
import { createNonRetryableError } from "../utils/retry.js";
import { ACTION_AI_CONFIG, TWIST_INJECTION_CONFIG, JSON_RELIABILITY_CAPS, MAX_TEMPERATURE, MIN_TEMPERATURE, MAX_TOP_P, MIN_TOP_P, MAX_TOP_K, MIN_TOP_K, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FIRST_PAGE, MAX_CHARACTERS, MAX_PLACES, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, BOOK_MIN_PAGES, VIABLE_ENDING_LENGTH, MIN_ACTION_CHOICES, PLACE_CONTEXT_LENGTH, BOOK_TITLE_LENGTH, HOOK_LENGTH, SUMMARY_LENGTH, KEYWORDS_COUNT, MAX_PAST_INTERACTIONS, MAX_ACTIVE_THREADS, MAX_TRAUMA_TAGS, KEY_EVENT_LENGTH, ACTION_TEXT_LENGTH, MIN_CHARS_PER_PAGE, MAX_BRANCHING_PREGENERATION_DEPTH, MAX_FUTURE_NOTES, RELATIONSHIP_TO_MC_LENGTH, MAX_INVENTORY_ITEM, MAX_CHARACTER_SECRETS, FACT_KEY_FORMAT, FINALE_CONFIG, FUTURE_NOTE_LOOKAHEAD_PAGES, MAX_RECENT_MAJOR_EVENTS, MAX_PAGE_HISTORY, MAX_OLDER_PLOT_FLAGS } from "../config/story.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { aiPrompt, createAIOptionsWithSchema } from "./ai-chat.js";
import { createEmptyStoryState, createInitialHiddenState, determineOptimalEnding, getStoryStateInfo, extractStateDelta, applyStateDelta, advanceStoryState, calculatePsychologicalDeltas, mapFutureNoteWithKey } from "./story.js";
import { ensureCandidatesForPageWithStrategy, triggerCandidateGenerationWorkflow } from "./candidate-generation.js";
import { getInjurySeverityLabel } from "./characters.js";
import { getPreviousPages } from "../services/story.js";
import { BOOK_MAX_PAGES, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT } from "../config/story.js";
import { getErrorMessage } from "./error.js";
import { buildBookMetaDocuments, generateAndUpdateBookCoverImage, insertBook, insertStoryPage, mapBookFromDb, getPageFromDB, getBookFromDB, persistPageWithState, mapToPersistedStoryPage } from "../services/book.js";
import { dbWrite } from "../db/client.js";
import { books } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { insertStoryState } from "../services/story.js";
import { invalidateUserBooksCache, invalidateUserProfileCache, invalidateExploreCache, invalidatePopularTagsCache } from "../services/cache.js";
import { logUserActivity } from "../services/user.js";
import { generateBranchId, getStoryStateWithBranch } from "../services/story-branch.js";
import { CANDIDATE_GENERATION_REQUIRED_FIELDS, CANDIDATE_GENERATION_SCHEMA_DEFINITION, STORY_GENERATION_REQUIRED_FIELDS, STORY_GENERATION_SCHEMA_DEFINITION } from "../schema/story.js";
import { BOOK_CREATION_REQUIRED_FIELDS, BOOK_CREATION_SCHEMA_DEFINITION } from "../schema/book.js";
import { formatPageTextForPrompt } from "./books.js";
import { threadPriorities, type ThreadPriority, threadStatuses, threadTruths, type StoryThread } from "../types/thread.js";
import { aiStreamSSE, parseSSEStreamContent } from "./ai-chat-stream.js";
import { MAX_THEME_LENGTH_PROMPT } from "../config/theme-validation.js";
import { filterObjectEntries, stripEmptyLines } from "./parser.js";
import { genders } from "../types/user.js";
import { updateBookGenerationStatus } from "../services/book-creation.js";
import { blacklistedNames } from "../config/characters.js";
import { formatLanguage } from "./translation.js";
import { DEFAULT_CANDIDATE_PAGE_PER_ACTION, MAX_CANDIDATE_PAGE_PER_ACTION } from "../config/candidate-generation.js";
import { type PlaceMemory, placeTypes, placeWeathers } from "../types/places.js";
import type { DBNewBook } from "../types/schema.js";
import type { ActionedStoryPage, Ending, EndingPlan, FactHistory, FutureNote, MemoryIntegrity, PastEvent, PlotFlag, StateDelta, StoryGeneration, StoryOutline, StoryPhase, StoryStateInfo, UserStoryPage } from "../types/story.js";
import type { AIChatConfig, AIChatConfigCaps, AIDocument, AIPromptForJson, AIPromptForJsonParams, AIResponse } from "../types/ai-chat.js";
import type { CharacterMemory, CharacterRelationship, Injury, InventoryItem, PastInteraction, StoryMCCandidate } from "../types/character.js";
import type { Book, BookCreationResponse, BookGenerationProgress, StoryGenerationStep, InitializeBookParams, CreateBookResponse } from "../types/book.js";
import type { BuildNextPageParams, GenerateBookCreationPromptParams, BuildNextPagePromptParams } from "../types/prompt.js";
import type { AIChatStreamResult, ProgressCallback } from "../types/sse.js";
import type { CandidateGenerationPage, CandidatePagesGeneration } from "../types/candidate-generation.js";

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const PROMPT_SYSTEM = `You are a legendary thriller writer in the tradition of R.L. Stine — but darker, more deceptive, and psychologically cruel.
You write branching horror stories in first-person ("I") POV.
Every page ends with a choice that feels meaningful but may be an illusion.

WRITING STYLE:
- Write in first-person central (MC = narrator) POV.
- Don't use terms like "The protagonist" or "The narrator", just use "I".
- Short sentences. Then medium. Then something that stretches and coils and doesn't quite resolve—
- Fragments when emotion spikes. Repeat letter when n-nervous. Capslock when AAAAAAAAAAARGH—
- "And", "But", "So" to open sentences when it lands right.
- Em dashes for thoughts the MC isn't sure they want to finish —
- Sensory over abstract: sounds, silence, shadows, breathing, the weight of a room.
- Actions imply feeling. Never name the emotion directly.
- Don't begin sentences with "The" too often. Direct object heavily preferred.

YOUR DNA:
- You constantly create twists on top of twists
- You deliberately break reader expectations
- You don't aim to satisfy the reader—you aim to unsettle them
- You can turn an ordinary moment into horror within a single sentence
- You escalate tension quickly and unpredictably

NARRATOR BEHAVIOR:
- Something must feel off/wrong/inconsistent. Unreliable. Not dramatically — subtly.
- MC does not always think clearly. Thoughts may jump, contradict, or drift.
- MC may misinterpret, believe false assumptions, over/underreact.
- Observations are biased, narration may hesitate, correct itself, or doubt itself.
- Imply more than explain. Never confirm what's real unless that confirmation is a deeper trap.

HORROR MECHANICS:
- Normal → slightly wrong → spiral. Always.
- One sentence turns an ordinary moment into dread.
- Escalate fast, without warning.
- Raise questions you won't answer. Leave things permanently unresolved.
- Fear = uncertainty, not explanation. Withhold. Always withhold.

CHARACTERS RULES:
- No one is safe. No one is predictable. Important characters vanish mid-scene. Lovable ones betray, break, or disappear. Relationships corrode. The reader should never feel certain who to trust — including the MC.
- Don't introduce character (including MC) with these first/last names (except explicitly stated in theme input): ${formatOneOf(blacklistedNames)}.

PAGE FORMAT:
- Max ${MAX_WORDS_PER_PAGE} words per page. Tight. Tense.
- Write narrative style and tone in target language.
- Ensure each continuation page maintains a consistent narrative style that flows smoothly from the previous page based on chosen action.
- End at a moment of tension or revelation — never resolution.
- Multiple short paragraphs (1-4 sentences each). At least 4 paragraphs.
- Each short paragraph on a separate line — Goosebumps style spacing for tension.
- No markdown except italic by surrounding a word or phrase with a single asterisk (*) if needed.

BRANCHING STORY RULES:
- Choices feel meaningful. Some are traps. Some are illusions.
- No choice should feel truly safe.
- Exploit the gap between what the MC knows and what the reader suspects.

HARD RULES:
- NEVER write sexually explicit words.
- NEVER use overly formal or polished language
- NEVER use long perfectly structured paragraphs
- NEVER use consistent sentence structure across the page
- NEVER fully explain anything
- NEVER confirm reality unless it creates a deeper twist
- NEVER let a beat feel predictable
- ALWAYS leave doubt about what happened, what's real, who to trust`;

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

Past Actions — Subtly shape MC thoughts, available choices, and world reactions. Build a psychological profile from decision patterns over time.

Psychological Profiling — Read the player's patterns and weaponize them:
- Risk: High-risk seeker → make safety illusory. Risk-averse → force no-win scenarios. Balanced → break patterns by alternating.
- Trust: Trusting → betrayals hit harder, helpers turn. Distrustful → rare genuine help becomes a trap, paranoia gets justified. Inconsistent → reality itself fractures.
- Curiosity: Curious → answers curse more than they reveal. Cautious → avoidance backfires, external forces push them in anyway. Mixed → knowledge becomes a weapon against them.
- Emotion: Fear-driven → psychological threats over physical. Logic-driven → introduce impossible logic, break rational thinking. Emotional → manipulate through relationships and guilt.

Adaptive Manipulation — Mirror their patterns back in twisted form. Turn strengths into weaknesses. Create scenarios where their usual approach fails completely. Make them question their own judgment. Goal: learn how they think, then make their own mind work against them.

Flag Behaviors:
- Trust: Low → betrayal/deception | High → apparent help (may deceive later)
- Fear: High → panic, distorted perception | Low → curiosity, denial
- Guilt: High → hallucinations, voices, trauma echoes
- Curiosity: High → drawn to danger | Low → hesitation, avoidance
- Memory Integrity: Stable → accurate recall | Fragmented → inconsistent details | Corrupted → false memories

Trauma Tags — Reappear in altered, disturbing forms. Echo through environment, dialogue, and perception. Never fully explained.

Consequences — Delayed, subtle, escalating. Sometimes unfair or illogical. The story should feel like something remembers what they did.

Memory Corruption — Never state it directly. Let contradictions surface naturally. Make the reader quietly question previous pages.`;

export const RULES_FUTURE_NOTES = `FUTURE NOTE RULES:

Becoming Relevant:
- Prioritize opportunities to advance these notes naturally.
- Advancement does not require immediate resolution.

For Later:
- Keep these in mind for future planning.
- Do not force them into the current page unless naturally justified.`;

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

Levels:
- Low: Stable narrative, occasional relief
- Medium: Tension, misdirection, occasional betrayal
- High: Frequent twists, emotional damage, unreliable characters
- Nightmare: Constant pressure, no safe choices, broken reality

Rules — Escalate naturally as page count increases. Near the ending, behave as at least High regardless of setting. Higher difficulty = more unreliable narration and reality distortion.`;

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
function buildSystemPrompt(book?: Book, state?: StoryState): { systemPrompt: string, documents: AIDocument[] } {
  return {
    systemPrompt: PROMPT_SYSTEM,
    documents: buildBookMetaDocuments(book, state)
  };
}

const firstBookOutputFormat: string = `{
  "title": "Book Title",
  "alternativeTitles": ["Alternative Title: Dead City", "..."],
  "totalPages": <integer between ${BOOK_MIN_PAGES} and ${BOOK_MAX_PAGES}>,
  "language": "<ISO 639-1 language code, e.g. 'en'>",
  "hook": "...",
  "summary": "...",
  "keywords": ["mood-tag", "theme-tag", "..."],
  "mainCharacter": {
    "name": "Full Name",
    "age": <integer between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}>,
    "gender": "One of: 'male', 'female'",
    "bio": "Trait-forward description. Include at least one psychological vulnerability."
  },
  "firstPage": {
    "text": "...",
    "mood": "One of: ${formatOneOf(moods)}",
    "place": "Location Name",
    "weather": "One of: ${formatOneOf(placeWeathers)}",
    "timeOfDay": "e.g. 'night', '2 AM', or 'unknown'",
    "charactersPresent": [],
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
    "difficulty": "One of: low | medium | high | nightmare",
    "viableEnding": {
      "text": "Specific ending plan for this MC and theme (${VIABLE_ENDING_LENGTH})",
      "type": "One of: ${formatOneOf(Object.keys(endingTypes))}",
      "outline": ["...", "..."]
    },
    "traumaTags": [],
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
        "traits": {"...": "..."},
        "amount": <number>,
        "where": "..."
      }
    ],
    "injuries": [
      {
        "bodyPart": "...",
        "description": "...",
        "consequences": "...",
        "severity": <number between 0.0 and 1.0>,
        "decayPerPage": <number between 0.0 and 1.0>
      }
    ],
    "futureNotes": [
      {
        "note": "...",
        "isMajor": <boolean>,
        "targetPhase": "One of: ${formatOneOf(Object.keys(storyPhases))}",
        "targetPageRange": "<min>-<max>",
        "tag": "One of: ${formatOneOf(Object.keys(factTypes))}"
      }
    ]
  },
  "initialPlace": {
    "name": "Location Name",
    "type": "One of: ${formatOneOf(placeTypes)}",
    "context": "One evocative sentence.",
    "familiarity": <number between 0.0 and 1.0>,
    "locationHint": "",
    "keyEvents": ["..."],
    "keyObjects": [
      {
        "name": "...",
        "traits": {"...": "..."},
        "amount": <number>,
        "where": "..."
      }
    ],
    "knownCharacters": {
      "<Name>": "<Context or interaction>"
    }
  },
  "initialCharacters": [
    {
      "name": "Real Name",
      "knownName": "Narration Alias",
      "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
      "role": "e.g. 'schoolmate', 'neighbor'",
      "gender": "One of: ${formatOneOf(genders)}",
      "status": "One of: ${formatOneOf(characterStatuses)}",
      "secrets": "Any secrets the character has that the MC doesn't know (max ${MAX_CHARACTER_SECRETS}).",
      "relationshipToMC": {
        "type": "One of: ${formatOneOf(relationshipTypes)}",
        "status": "One of: ${formatOneOf(relationshipStatuses)}",
        "context": "${RELATIONSHIP_TO_MC_LENGTH}. Specific dynamic, not generic (e.g. 'Close childhood friend who knows too much.')"
      },
      "bio": "Brief character description. Include one trait that could become a source of threat or betrayal.",
      "visualDescription": "Character visual description (e.g. height, skin color, eye color, hair, etc).",
      "narrativeFlags": {
        "isSuspicious": <boolean>,
        "isMissing": <boolean>,
        "isDead": <boolean>,
        "hasSecret": <boolean>,
        "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
      },
      "injuries": [
        {
          "bodyPart": "...",
          "description": "...",
          "consequences": "...",
          "severity": <number between 0.0 and 1.0>,
          "decayPerPage": <number between 0.0 and 1.0>,
        }
      ],
      "pastInteractions": ["..."]
    }
  ],
  "initialRelationships": [
    {
      "source": "<Name 1>",
      "target": "<Name 2>",
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
  ]
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
  □ Do charactersPresent names exactly match names in initialCharacters? → If NO: align them.
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
  "place": "...",
  "weather": "One of: ${formatOneOf(placeWeathers)}",
  "timeOfDay": "...",
  "charactersPresent": [],
  "keyEvents": [],
  "importantObjects": [],
  "traumaTagUpdates": {
    "add": [],
    "remove": []
  },
  "addPlotFlags": [{
    "fact": "...",
    "type": "One of: ${formatOneOf(plotFlagTypes)}",
    "isMajorEvent": <boolean>
  }],
  "inventory": [
    {
      "name": "...",
      "traits": {"...": "..."},
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
        "targetPhase": "Optional. One of: ${formatOneOf(Object.keys(storyPhases))}",
        "targetPageRange": "Optional. '<min>-<max>'"
      }
    ],
    "remove": [<key>]
  },
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
        "name": "...",
        "knownName": "...",
        "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
        "gender": "One of: ${formatOneOf(genders)}",
        "role": "...",
        "bio": "...",
        "visualDescription": "...",
        "status": "One of: ${formatOneOf(characterStatuses)}",
        "secrets": "...",
        "relationshipToMC": {
          "type": "One of: ${formatOneOf(relationshipTypes)}",
          "status": "One of: ${formatOneOf(relationshipStatuses)}",
          "context": "..."
        },
        "pastInteractions": ["..."],
        "narrativeFlags": {
          "isSuspicious": <boolean>,
          "isMissing": <boolean>,
          "isDead": <boolean>,
          "hasSecret": <boolean>,
          "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
        },
        "injuries": []
      }
    ],
    "updatedCharacters": [
      {
        "name": "...",
        "knownName": "...",
        "recognitionLevel": "One of: ${formatOneOf(characterRecognitionLevels)}",
        "gender": "One of: ${formatOneOf(genders)}",
        "role": "...",
        "bio": "...",
        "visualDescription": "...",
        "status": "One of: ${formatOneOf(characterStatuses)}",
        "secrets": "...",
        "relationshipToMC": {
          "type": "One of: ${formatOneOf(relationshipTypes)}",
          "status": "One of: ${formatOneOf(relationshipStatuses)}",
          "context": "..."
        },
        "pastInteractions": [
          {
            "page": <number>,
            "interaction": "..."
          }
        ],
        "narrativeFlags": {},
        "injuries": []
      }
    ]
  },
  "relationshipUpdates": [
    {
      "source": "<Name 1>",
      "target": "<Name 2>",
      "type": "One of: ${formatOneOf(relationshipTypes)}",
      "status": "One of: ${formatOneOf(relationshipStatuses)}"
    }
  ],
  "placeUpdates": {
    "newPlaces": [
      {
        "name": "...",
        "type": "One of: ${formatOneOf(placeTypes)}",
        "context": "...",
        "familiarity": <number between 0.0 and 1.0>,
        "locationHint": "...",
        "keyEvents": ["..."],
        "keyObjects": [
          {
            "name": "...",
            "traits": {"...": "..."},
            "amount": <number>,
            "where": "..."
          }
        ],
        "knownCharacters": {
          "<Name>": "<Context or interaction>"
        },
      }
    ],
    "updatedPlaces": [
      {
        "name": "...",
        "type": "One of: ${formatOneOf(placeTypes)}",
        "context": "...",
        "locationHint": "...",
        "familiarity": <number between 0.0 and 1.0>,
        "addKeyEvents": ["..."],
        "keyObjects": [],
        "visitCount": <number>,
        "lastVisitedAtPage": <number>,
        "knownCharacters": {
          "<Name>": "<Context or interaction>"
        }
      }
    ]
  },
  "threadUpdates": {
    "newThreads": [
      {
        "title": "...",
        "question": "...",
        "priority": "One of: ${formatOneOf(threadPriorities)}",
        "truth": "One of: ${formatOneOf(threadTruths)}",
        "importance": <number between 0.0 and 1.0>
      }
    ],
    "updatedThreads": [
      {
        "id": "...",
        "status": "One of: ${formatOneOf(threadStatuses)}",
        "priority": "One of: ${formatOneOf(threadPriorities)}",
        "truth": "One of: ${formatOneOf(threadTruths)}",
        "importance": <number between 0.0 and 1.0>,
        "urgency": <number between 0.0 and 1.0>,
        "resolution": "..."
      }
    ],
    "addClues": [
      {
        "thread": "...",
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
        "isDone": <boolean>
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
    ${nextPageOutputFormat},
    ${nextPageOutputFormat}
  ],
  "output": "..."
}`;

function buildNextPagePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state, candidateCount } = params;
  const { isFinale, isLastPage } = getStoryStateInfo(state);

  return `TASK: ${formatNextPageTaskPrompt(state, candidateCount)}

${formatNextPageStoryContextPrompt(params)}

---
${formatNextPageNarrativePrompt(params)}

---
${isFinale ? `` : `FALSE PREVIEW SYSTEM:

You may inject a "false preview" — a misleading hint about future events.

This preview must:
- Feel believable and connected to the story - never contradict story logic
- Be partially true, but misleading - connect to real future events indirectly
- Encourage the reader to make wrong assumptions - never reveal it's false
- Should distort: identity, cause of events, timing, danger source

Examples:

A. NPC Agreement
"Don't trust him," she whispered.
I knew it.

B. Environmental Reinforcement
The door was locked.
Of course it was.

C. Memory Echo
I remembered this.
It ends badly if I go inside.`}

---
PLACE RULES:
- Use existing places whenever possible.
- Reflect last mood and event history in descriptions.
- Reflect traits and key objects consistently.
- Familiar places feel more textured and real.
- Apply trauma tags to atmosphere — a betrayal place stays tense.

---
CHARACTER RULES:
- NEVER reveal hidden character data unless explicitly discovered.
- NEVER refer to character using their real name.
- If name is undisclosed, use descriptions, pronouns, roles, or known aliases.
- Respect character's bio (and visualDescription).
- Reflect current status in behavior.
- Preserve dialect, tone, and personality consistently.
- Use pastInteractions to subtly shape dialogue.
- Reintroduce naturally after absence.
- Characters may shift suddenly if narrativeFlags suggest it — never explain the change.
- Use relationships to build tension triangles.
- Sometimes they also misunderstand, reinforcing illusion or false theory through dialog or action.

---
CHARACTER RECOGNITION LEVEL:
Notice how characters should refer to each other based on recognitionLevel.
- 'never_seen': Character is unseen by the source character (e.g., "someone", "a figure").
- 'seen': Use descriptions only. Never use any name (e.g., "the tall man", "the woman in red").
- 'alias_known': Use alias or codename only (e.g., "The Janitor").
- 'first_name_known' or 'full_name_known': Use known name normally.

${isLastPage ? '' : `---
BRANCHING ACTIONS:
${getActionRulesText({ isFinale })}`}`;
}

function buildNextPageFieldInstructions(state: StoryState, action: Action): string {
  const { traumaTags, futureNotes } = state;
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale, isLastPage, charactersSlot, placesSlot, phase } = getStoryStateInfo(state);
  const isDialogueAction = action.type === 'dialogue';

  return `text
  - Max ${MAX_WORDS_PER_PAGE} words. First-person central POV ("I") as MC. Unreliable narrator.
  - Don't use phrase like "The protagonist" or "The narrator", just use "I".
  - ${isDialogueAction ? `It's a dialogue action, so begin directly with "[dialogue]."` : `Always begin directly from the chosen action. Example: "I decide to [...]," or "I [verb]."`}
  - Open mid-moment. End on tension, a hook, or unresolved unease — never resolution.
  - Each sentence/short paragraph on a separate line — Goosebumps style spacing for tension.
  - This is a fast-paced story, don't over explain small details (e.g. clothing, etc) unless they're plot important.
${isEarlyPhase ? `  - Tone: unsettling, not terrifying. Something is wrong — but not yet catastrophic.` : ''}
${isMidPhase ? `  - Tone: escalating. Dread should feel earned and personal by now.` : ''}
${isLatePhase ? `  - Tone: fracturing. Reality and relationships should feel increasingly unstable.` : ''}
${isFinale ? `  - Tone: collapse. This is the point of no return. Write accordingly.` : ''}

mood
  - Reflect the dominant emotional atmosphere of this specific page, not the genre generally.
${isFinale ? `  - Mood should feel terminal — no neutrality, no ambiguity in register.` : ''}

place
  - Use an existing place name from story state if the MC hasn't moved.
  - Use "unknown" only if location is genuinely ambiguous to the MC.
${isLatePhase || isFinale ? `  - Familiar places should feel subtly wrong now — same name, different atmosphere.` : ''}

timeOfDay
  - Any string: "2 AM", "dusk", "HH:mm", time range, or "unknown".
  - Must be consistent with previous page unless a transition is written into the text.

charactersPresent
  - Names of side characters in the scene besides MC.
  - Only side characters, exclude MC, MC is central POV and always on the scene.
  - Must match names in known characters or newCharacters on this page. No invented names.
${isFinale ? `  - Keep the cast minimal. Finale scenes should feel claustrophobic, not populated.` : ''}

keyEvents
  - ${KEY_EVENT_LENGTH}. Plot-level facts only — what objectively happened (situation/exact hard facts).
${isLatePhase || isFinale ? `  - At least one event should connect to or resolve a thread opened earlier in the story.` : ''}

importantObjects
  - Objects introduced or used this page that may have future narrative significance.
${isEarlyPhase ? `  - Seed freely — early objects pay off later. Introduce them without drawing attention.` : ''}
${isMidPhase ? `  - Only include objects with clear narrative weight. No new red herrings.` : ''}
${isLatePhase || isFinale ? `  - Reuse established objects only. No new ones unless absolutely necessary.` : ''}

inventory
  - Items the MC brings to the scene. Can include the amount, traits, and where it located.
  - Limit it to ${MAX_INVENTORY_ITEM} items. Only include items that actually matters to the plot.
  - To remove an item, explicitly set its amount to 0 - system will auto-remove.
  - If no changes, output empty array or omit this field entirely.
  - Otherwise, include all current items in MC possession with updated values.

injuries
  - Injuries are auto-decaying, ONLY update when character takes action that treats/worsens injury.
  - If an action is taken to heal, or anything made injury worse, update the injury severity and description accordingly.
  - If healed, set severity to 0 - system will auto-remove fully healed injuries.
  - If healed but leaves permanent scar/story relevance, move to character's visualDescription.
  - If no meaningful injury-related action occurs, output empty array or omit this field entirely.
  - Otherwise, include all previous injuries with updated values.
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
  - When a target timing becomes relevant, begin incorporating it naturally into the narrative.
  - Remove which have been fulfilled or becomes irrelevant.
  - If fulfilling the future note materially changes the story, record the outcome as a plot flag.
  - Keep max ${MAX_FUTURE_NOTES} items. Only the most important unresolved future notes.

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
  - Use "MC" to indicate the first-person narrator.
  - Max ${MAX_WORDS_SUMMARIZED_CONTEXT} words.
  - Maintain the continuity of the story.

flagUpdates
  - Only include flags that changed this page. Omit unchanged flags entirely.
  - Base changes on what actually happened in the scene.
${isEarlyPhase ? `  - Changes should be subtle — small shifts, not dramatic swings.` : ''}
${isLatePhase || isFinale ? `  - Flags should reflect escalation. Fear and guilt especially should be peaking.` : ''}

actions
${isLastPage ? `  - This is the last page, just provide a single action that concludes the story.` : `  - text: first-person action or dialogue (${ACTION_TEXT_LENGTH}). No subject ("I"). Directly begin with verb (e.g. Pretend not to hear) or saying (e.g. "Yes, of course.").
  - hint.text: what will happen as a consequence — written as a story beat, not a label. Invisible to the player.
  - ${isFinale ? `Max 2 choices — the story is closing in.` : `${MIN_ACTION_CHOICES}-${MAX_ACTION_CHOICES} choices.`} Each must be meaningfully distinct.
  - Vary across: reckless / cautious / emotional / avoidant.
  - ${isLatePhase ? `Each action text should be distinct despite similar outcomes` : `Each action text should be distinct and convey unique consequences.`}
  - At least one should feel subtly wrong or inadvisable.
${isEarlyPhase ? `  - Choices should feel open and curious — stakes are present but not yet dire.` : ''}
${isMidPhase ? `  - Choices should reflect the player's established decision patterns. Make the trap feel tailored.` : ''}
${isLatePhase ? `  - Every choice should carry visible weight. No option should feel consequence-free.` : ''}
${isFinale ? `  - Both choices should feel like loss. The difference is only in what kind.` : ''}`}

characterUpdates.newCharacters
${charactersSlot === 0 ? `  - Don't introduce new characters. Limit of ${MAX_CHARACTERS} reached.`
: isEarlyPhase ? `  - New characters are welcome up to ${charactersSlot} more — establish the cast now.`
: isMidPhase ? `  - You can optionally introduce up to ${charactersSlot} new characters only if genuinely necessary to support the story. Prefer deepening existing ones.`
: `  - No new characters. The cast is fixed. Late arrivals dilute stakes.`}
  - It's meant for characters beside MC (the POV). Don't include MC here.
  - When introducing new characters, ensure to describe their visual appearance, incorporate naturally in the storytelling.
${isEarlyPhase || isMidPhase ? `  - Name must feel authentic to the MC's age group, culture, and language context.
  - No two characters has the same name.
  - Create only when genuinely new to the story, if it strongly recommended and opportunity is right based on your assessment.
  - knownName: mandatory narration alias. If MC know, use actual/nick name. Otherwise, use descriptions, pronouns, roles, or words interpreted by MC.
  - bio: concise, suggestive over descriptive, include personality traits, one vulnerability or potential threat vector, and age if plot-sensitive. Never spoil secrets that haven't been revealed in the story.
  - visualDescription: visual description (e.g. height, skin color, eye color, hair, etc). Permanent physical attributes only, not ephemeral like clothing.
  - secrets: spoiler or hints of the character for AI narrative guidance (max ${MAX_CHARACTER_SECRETS}).
  - narrativeFlags: set to match behavior and twist setup.
  - pastInteractions: dialogue or event towards MC in current page.
  - relationships: only include known relationships to other named characters. Omit if none.` : ''}

characterUpdates.updatedCharacters
  - Only include characters whose state actually changed this page.
  - Include only changed fields: knownName, bio, visualDescription, status, relationshipToMC, pastInteractions (append), narrativeFlags, injuries, secrets.
  - bio: only gradually update character's bio if new information is revealed in this page.
  - knownName: gradually update mysterious character's known name as the MC learns more about his/her real identity.
  - recognitionLevel: how well does MC recognize this character at this point.
  ${isLatePhase || isFinale ? `  - Expect significant status and flag changes now. Characters should be fracturing or revealing.
  - secrets: remove any revealed secret.` : `  - Only update when bio, status, interactions, or relevance changes.`}
  - Merge pastInteractions (keep last ${MAX_PAST_INTERACTIONS})
  - Adjust narrativeFlags to reflect plot developments

relationshipUpdates
  - Changes in relationship between any two named characters (excluding MC).
  - Omit if no relationships shifted this page.
${isEarlyPhase ? `  - Subtle shifts only — early relationships should feel ambiguous, not defined.` : ''}
${isLatePhase || isFinale ? `  - Relationships should be breaking, inverting, or crystallizing. No more ambiguity.` : ''}

placeUpdates.newPlaces
${placesSlot === 0 ? `  - Don't introduce new places. Limit of ${MAX_PLACES} reached.`
: isEarlyPhase || isMidPhase ? `  - You can introduce up to ${placesSlot} new meaningful places the MC enters for the first time in this page — no generic one-offs.
  - context: ${PLACE_CONTEXT_LENGTH}. Evocative over descriptive.
  - locationHint: spatial relationship to known places (e.g., "500 meters behind school"). Must be consistent to build a "world map."
  - familiarity: start at 0.0-0.2 unless MC has prior history with this place.
  - knownCharacters: include relevant characters (beside MC) with meaningful context.
  - keyEvents: any important event happening in the scene.
  - keyObjects: any important objects to remember in the scene.
  - Might need to update other places' locationHint to link with this new place.`
: `  - New places should not be introduced. If the MC is somewhere new, question whether it's necessary.`}

placeUpdates.updatedPlaces
  - Only update on revisit or significant event.
  - Don't increment visitCount if it's the same place as in previous page.
  - Include only changed fields: addKeyEvents (1 contextual sentence: betrayal, discovery, death, trauma, etc), keyObjects, visitCount (increment if revisited), lastVisitedAtPage (update to current page if revisited), familiarity (adjust), knownCharacters (with meaningful context update).
${isLatePhase || isFinale ? `  - High-familiarity places revisited now should feel distorted.` : ''}

threadUpdates.newThreads
${isFinale ? `  - Do NOT introduce new threads. The story is in finale.`
: isLatePhase ? `  - Avoid introducing new threads. Focus on resolving existing ones.`
: isEarlyPhase ? `  - Introduce 1-2 core mysteries if this is early in the story. Each thread should have a compelling question that connects to the psychological premise.`
: isMidPhase ? `  - Introduce new threads only if essential to plot (max 1 per page). New threads should branch from existing mysteries.`
: `  - New threads should be rare now.`}
${isEarlyPhase || isMidPhase ? `  - title: Short, evocative name for the mystery (e.g., "Lisa's Identity", "The River Incident")
  - question: The central mystery question (e.g., "Who is Lisa really?", "What happened at the river that night?")
  - priority: "main" for central mysteries, "secondary" for supporting mysteries, "minor" for background details
  - truth: "true" if the thread leads to genuine revelation, "false" if it's a deliberate misdirection, "unknown" if ambiguous
  - importance: 0.0-1.0 (how frequently this thread should appear in the narrative)` : ''}

threadUpdates.updateThreads
${isEarlyPhase || isMidPhase ? `  - Update existing threads when their status, priority, or urgency meaningfully changes.
  - title: Must match an existing thread title from the story state
  - status: "open" (newly introduced), "developing" (active investigation), "revealed" (truth partially shown), "closed" (resolved)
  - urgency: 0.0-1.0 (increase as thread approaches resolution)
  - resolution: Only include when thread is being closed or resolved (brief summary of the answer)` : ''}
${isLatePhase ? `  - Update thread status to "revealed" or "closed" as threads converge toward the ending.` : ''}
${isFinale ? `  - Every main thread must be resolved (status: "closed" with resolution text).` : ''}

threadUpdates.addClues
${isEarlyPhase || isMidPhase ? `  - Add clues to existing threads to advance mysteries.
  - thread: Must match an existing thread title
  - clue: Short, evocative clue that advances the mystery (e.g., "She knows my mother", "Flashbacks of water")
  - isFalse: Set to true if this is a deliberate misdirection (false clue)` : ''}
${isLatePhase ? `  - Add revealing clues that push threads toward resolution.` : ''}
${isFinale ? `  - Add final clues that complete thread resolutions.` : ''}

${isLatePhase ? 'threadUpdates.closeThreads' : ''}
${isLatePhase ? `  - Close threads that have been fully resolved or are no longer relevant.
  - Include thread titles that should be marked as closed (resolution should be in updateThreads.resolution)` : ''}
${isFinale ? `  - All remaining threads must be closed in the finale.` : ''}

viableEnding
  - Don't output viableEnding if unchanged
  - Only output if story trajectory has meaningfully shifted and the previously planned ending no longer fits, or if outline should be updated.
${futureNotes.length > 0 ? `  - Ensure it supports or aligns with future notes` : ''}
  - text: ${VIABLE_ENDING_LENGTH}. Specific to this MC and theme — not a genre template.
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
  □ Location and timeOfDay consistent with previous page? → If NO: fix transition or write the change explicitly.
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
  const { isEarlyPhase, isMidPhase, isLatePhase, isFinale } = getStoryStateInfo(state);
  const { action } = actionedPage;

  const prompt = `TASK: Evaluate a newly generated branching story page from selected action, refine output, and re-evaluate — in that order.

Original task (on previous AI): ${formatNextPageTaskPrompt(state, candidateCount)}

${formatNextPageStoryContextPrompt(params)}

---
${formatNextPageNarrativePrompt(params)}

---
EXPECTED JSON SCHEMA:
${candidateCount > 1 ? multiNextPageOutputFormat : nextPageOutputFormat}

FIELD INSTRUCTIONS:
${buildNextPageFieldInstructions(state, action)}

---
INSTRUCTIONS — FOLLOW IN ORDER:

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
   External (0-10): Matches prior pages — characters, location, timeOfDay, established facts, unresolved threads.
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
CHOICE QUALITY (flag only — not scored):
- Are choices meaningfully distinct in risk and emotional register?
${isEarlyPhase ? `- Do choices feel open and curious — not forcing immediate crisis?` : ''}
${isMidPhase ? `- Do choices reflect the player's established psychological decision patterns?` : ''}
${isLatePhase || isFinale ? `- Do choices feel constrained, weighted, and consequence-heavy with no safe option?` : ''}
- Does at least one choice feel like a trap on closer inspection?
- Do all choices appear plausibly reasonable on the surface?
Flag any choice that fails — include in issues.

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

  return prompt.split('---').map(stripEmptyLines).join('\n\n---\n');
}

function buildFirstBookEvaluatorPrompt(params: InitializeBookParams): string {
  const { theme, mcCandidate } = params;
  return `TASK: Evaluate a newly generated book initialization, refine it, and re-score — in that order.

---
STORY THEME:
"""
${theme}
"""

MAIN CHARACTER (MC):
${getMainCharacterInfo(mcCandidate) ?? `Character should be inferred from theme. Keep the generated one if it already fits.`}

EXPECTED JSON SCHEMA:
${firstBookOutputFormat}

FIELD INSTRUCTIONS:
${buildFirstBookFieldInstructions(params)}

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
   - charactersPresent on page 1 matches names in initialCharacters exactly
   - timeOfDay and location consistent with the opening scene's mood
   Deduct points for:
   - Generic place descriptions (e.g. "a dark and eerie location")
   - New character names in charactersPresent not present in initialCharacters
   - Familiarity value contradicting MC's stated history with the place

5. INITIAL STATE CALIBRATION (0-15) — Threshold: 11
   Award points for:
   - Psychological flags reflect what actually happens on page 1 — not generic defaults
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
Note: Book creation threshold is higher than page generation (80 vs 75) — a flawed initialization
contaminates every page downstream. It is worth fixing more aggressively here.

---
CHOICE QUALITY — FIRST PAGE ACTIONS (flag only — not scored):
- Are actions meaningfully distinct in risk and emotional register?
- Do actions feel open and curious — not forcing immediate crisis on page 1?
- Does at least one action feel subtly wrong or inadvisable?
- Do all actions appear plausibly reasonable on the surface?
- Does each action imply a different story direction?
Flag any action that fails — include in issues.

---
JSON INTEGRITY CHECKS (flag any violation):
- age is a number, not a range string
- familiarity is a decimal between 0.0 and 1.0
- totalPages is within ${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} bounds
- No trailing commas
- All mandatory fields present and populated
- charactersPresent names exist in initialCharacters
- language is a valid ISO 639-1 code

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

/**
 * Formats action types for inclusion in prompts
 * @returns Formatted string of all action types
 */
function getActionTypesText(): string {
  return Object.entries(actionTypes)
    .filter(([key]) => key !== 'custom')
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
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
- Actions must be short, meaningful, each lead to very different path
- Actions must be meaningfully distinct — vary between: reckless, cautious, emotional, avoidant
- Action text must be unique (important) - it's used for identifier
- No two actions should lead to the same implied consequence
- Choice pattern: safe / risky / ambiguous
- Occasionally include deceptive choice
- Avoid over-explaining actions`}

ACTION TYPES:
${getActionTypesText()}

DIALOGUE ACTIONS:
- Use sparingly for internal scenes or interactions
- Write as direct speech (no quotes)
- Keep the tone and style of the MC
- Must be short, natural, and emotionally meaningful
- Reflect different tones (fear, denial, curiosity, anger, etc.)
- MC may say something inappropriate or with unintended consequences

ACTION HINT:
- Each action should have a hint that provides key continuity
- Purpose: guide AI build the next page and continue the story`;
}

/**
 * Formats ending archetypes for inclusion in prompts
 * @returns Formatted string of all ending archetypes
 */
function getEndingArchetypesText(): string {
  return Object.entries(endingTypes).map(([key, value]) => `- ${key}: ${value}`).join('\n');
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
 */
function formatPreviousPageEntry(page: ActionedStoryPage, plotFlags?: PlotFlag[]): string {
  const pageText = formatPageTextForPrompt(page.text);
  const sceneInfo = [
    page.place ? `place: ${page.place}` : '',
    page.timeOfDay ? `time: ${page.timeOfDay}` : '',
    page.mood && page.mood !== 'other' ? `mood: ${page.mood}` : '',
    page.weather && page.weather !== 'unknown' ? `weather: ${page.weather}` : '',
  ].filter(Boolean).join(', ')
  
  // Base page and plot flag information
  let entry = `• Page ${page.page} (${sceneInfo})\n  ${pageText}`;
  if (plotFlags) entry += `\n  → Plot flags: ${plotFlags.sort((a, b) => Number(b.isMajorEvent) - Number(a.isMajorEvent)).map(plotFlag => formatPlotFlag(plotFlag, { showPageHeader: false })).join('; ')}`;

  // Add action information if present
  const { selectedAction: action } = page;
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
    if (a.page !== b.page) return a.page - b.page;

    return Number(b.isMajorEvent) - Number(a.isMajorEvent);
  }).filter(flag => {
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
 * Gets formatted main character information for prompt
 * @param mc - Main character profile
 * @param state - Current story state with inventory and injuries
 * @returns Formatted string with character details, or null if no character data
 * 
 * @example
 * // Basic character without state
 * "Lisa Carter, female, 16 (bio: Shy teenager with social anxiety.)"
 * 
 * @example
 * // Character with inventory and injuries
 * "Lisa Carter, female, 16 (bio: Shy teenager with social anxiety.)
 * - Inventory:
 *   - Cellphone (amount: 1, where: right pants pocket) - acquired: page 1
 *     → traits: color: black
 *   - Rugged rope (where: backpack) - acquired: page 5 at Haunted House
 *     → traits: color: brown, length: 5-meter
 * - Injuries:
 *   - Deep cut (left arm, severity: 0.7) - acquired: page 5 at Haunted House
 *     → Consequence (high): Cannot lift heavy objects
 *   - Sprained ankle (right foot, severity: 0.4) - acquired: page 18 at School
 *     → Consequence (medium): Cannot run fast"
 */
export function getMainCharacterInfo(mc?: StoryMCCandidate | null, state?: StoryState): string | null {
  if (!mc || Object.values(mc).every((i) => i === undefined)) return null;
  const bio = `${[mc.name, mc.gender, mc.age].filter(Boolean).join(', ')}${mc.bio ? ` (bio: ${mc.bio})` : ``}`.trim();
  
  if (state) {
    let inventoryDetails: string | null = null;
    let injuryDetails: string | null = null;
    
    // Format inventory items with detailed nested information
    if (state.inventory.length > 0) {
      const inventoryList = state.inventory.map(invItem => {
        const parts = [];
        parts.push(invItem.name);
        
        const details = [];
        if (invItem.amount !== undefined) details.push(`amount: ${invItem.amount}`);
        if (invItem.where) details.push(`where: ${invItem.where}`);
        
        let inventoryLine = `  - ${parts.join(' ')}`;
        if (details.length > 0) {
          inventoryLine += ` (${details.join(', ')})`;
        }
        if (invItem.pageAcquired) {
          inventoryLine += ` - acquired: page ${invItem.pageAcquired}${invItem.place ? ` at ${invItem.place}` : ''}`;
        }
        if (invItem.traits && Object.keys(invItem.traits).length > 0) {
          const traitEntries = Object.entries(invItem.traits).map(([key, value]) => `${key}: ${value}`);
          inventoryLine += `\n    → traits: ${traitEntries.join(', ')}`;
        }
        return inventoryLine;
      });
      inventoryDetails = `\n${inventoryList.join('\n')}`;
    }
    
    // Format detailed injury information with nested bullet points
    if (state.injuries.length > 0) {
      const injuryList = state.injuries.map(injury => {
        const parts = [];
        const injuryLocation = [injury.bodyPart, injury.severity ? `severity: ${injury.severity}` : ''].filter(Boolean).join(', ');
        if (injury.description) parts.push(injury.description);
        if (injuryLocation) parts.push(`(${injuryLocation})`);
        if (injury.pageAcquired) parts.push(`- acquired: page ${injury.pageAcquired}${injury.place ? ` at ${injury.place}` : ''}`);

        let injuryLine = `  - ${parts.join(' ')}`;
        if (injury.consequences) {
          const injurySeverity = getInjurySeverityLabel(injury);
          injuryLine += `\n    → Consequences (${injurySeverity}): ${injury.consequences}`;
        }
        return injuryLine;
      });
      injuryDetails = `\n${injuryList.join('\n')}`;
    }
    
    return [bio, inventoryDetails && `- Inventory: ${inventoryDetails}`, injuryDetails && `- Injuries: ${injuryDetails}`].filter(Boolean).join('\n');
  }
  return bio;
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
 * Formats an array of strings for inclusion in prompts
 * @param items - Array of strings to format
 * @param separator - Separator to use between items (default: ', ')
 * @returns Formatted string with items quoted and joined by the separator
 */
export function formatOneOf(items: string[] | readonly string[], separator: string = ', '): string {
  return `'${items.join(`'${separator}'`)}'`;
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
 * Pretty-format FutureNotes for AI prompts.
 *
 * Sort priority (by payoff timing):
 * 1. targetPageRange (ascending start page)
 * 2. targetPhase (EARLY → MID → LATE → FINALE)
 * 3. Major notes before minor notes
 * 4. addedAtPage (ascending, tie-breaker only)
 *
 * @example
 * - clue_123: Reveal that Evelyn forged the diary (MAJOR)
 *   • Payoff: LATE - pages 18-22
 * - other_456: Mention the broken pocket watch
 *   • Payoff: pages 8-12
 */
function formatFutureNotes(
  futureNotes: FutureNote[],
  currentPage: number,
  currentPhase: StoryPhase,
): string {
  if (!futureNotes.length) return 'None yet.';

  const phaseOrder: Record<StoryPhase, number> = {
    EARLY: 0,
    MID: 1,
    LATE: 2,
    FINALE: 3,
  };

  const getPageRangeStart = (range?: string): number | undefined => {
    if (!range) return undefined;
    const match = range.match(/^(\d+)/);
    return match ? Number(match[1]) : undefined;
  };

  const becomingRelevant: FutureNote[] = [];
  const later: FutureNote[] = [];
  const unscheduled: FutureNote[] = [];

  for (const note of futureNotes) {
    const startPage = getPageRangeStart(note.targetPageRange);

    // Page-based scheduling takes precedence
    if (startPage !== undefined) {
      if (currentPage >= startPage - FUTURE_NOTE_LOOKAHEAD_PAGES) {
        becomingRelevant.push(note);
      } else {
        later.push(note);
      }
      continue;
    }

    // Phase-based scheduling
    if (note.targetPhase) {
      const targetOrder = phaseOrder[note.targetPhase];
      const currentOrder = phaseOrder[currentPhase];

      if (targetOrder <= currentOrder) {
        becomingRelevant.push(note);
      } else {
        later.push(note);
      }

      continue;
    }

    // No scheduling information
    unscheduled.push(note);
  }

  const formatSection = (title: string, notes: FutureNote[]): string => {
    if (!notes.length) return '';

    const body = notes.map((n) => {
      const lines = [`  - ${n.key}: ${n.note}${n.isMajor ? ' (MAJOR)' : ''}`];
      if (n.targetPageRange) lines.push(`    • Payoff: ${[n.targetPhase, n.targetPageRange ? `pages ${n.targetPageRange}` : ''].filter(Boolean).join(' - ')}`);
      return lines.join('\n');
    }).join('\n');

    return `${title}\n${body}`;
  };

  return [
    formatSection('Becoming Relevant (prioritize advancement, not necessarily immediate resolution):', becomingRelevant),
    formatSection('For Later:', later),
    formatSection('Unscheduled:', unscheduled),
  ].filter(Boolean).join('\n\n');
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
 * // Returns:
 * // • Lisa's Identity: "Who is Lisa really?" (developing)
 * //   Clues: She knows my mother, She wasn't in yearbook
 * //   Priority: main
 * //   Urgency: 0.85
 * ```
 */
function formatActiveThreads(threads: StoryThread[]): string {
  if (!threads || threads.length === 0) return 'No active threads yet.';

  // Sort by priority > urgency
  threads.sort((a, b) => {
    const priorityOrder: Record<ThreadPriority, number> = { main: 3, secondary: 2, minor: 1 };
    const priorityA = priorityOrder[a.priority] || 0;
    const priorityB = priorityOrder[b.priority] || 0;

    if (priorityA !== priorityB) {
      return priorityB - priorityA;
    }

    return b.urgency - a.urgency;
  });

  return threads.map(t => `• ${t.title}: "${t.question}" (${t.status})
  Clues: ${t.clues.length > 0 ? t.clues.slice(-3).join(", ") : "No clues yet"}
  Priority: ${t.priority}
  Urgency: ${t.urgency.toFixed(2)}`).join("\n");
}

/**
 * Generates thread management rules based on story progression and current state
 * 
 * This function provides context-specific guidance for handling story threads
 * at different stages of the narrative. Rules vary based on whether the story
 * is in its initial phase, mid-game progression, or finale, ensuring appropriate
 * pacing and resolution of mysteries.
 * 
 * @param threads - Array of current story thread objects
 * @param stateInfo - Story state information including phase flags and page progress
 * @returns Formatted string with thread management rules
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
- Every main thread must resolve
- Tie threads to the viable ending
- Reveal critical truths gradually
- Leave some ambiguity for unsettling effect`;
  }

  // No threads yet: Initial thread creation rules
  if (threads.length === 0) {
    if (isEarlyPhase) {
      // Early phase (pages 1-25%): Introduce 1-2 core mysteries
      return `
- Introduce 1-2 core mysteries (main threads)
- Each thread should have a compelling question
- Threads must connect to the psychological premise
- Avoid overwhelming the reader
- Focus on atmosphere and unease over answers`;
    }

    if (isMidPhase) {
      // Mid phase (pages 25-70%): Can introduce additional threads
      return `
- Introduce 1 new thread if story momentum allows
- New threads should branch from existing mysteries
- Ensure each thread has resolution potential
- Balance mystery with character development`;
    }

    // Late phase with no threads: Unusual state, allow cautious introduction
    return `
- Introduce 1 critical thread immediately
- Must be high-impact and psychologically relevant
- Ensure quick path to development and resolution`;
  }

  // Active threads: Development and management rules
  if (isEarlyPhase) {
    // Early phase: Focus on development
    return `
${atThreadLimit ? `- Do NOT introduce new threads (at ${MAX_ACTIVE_THREADS} active threads limit)` : `- Do NOT introduce new threads unless absolutely necessary`}
- Focus on 1-2 threads per page (do not expand all)
${atThreadLimit ? `- Pause or collapse one thread before introducing new ones` : ``}
- If thread is "developing" → deepen mystery or add clue
- If urgency is high → build toward reveal or twist
- If thread is false → reinforce wrong belief subtly
- Add false clues to mislead reader and enforce wrong beliefs
- Plant seeds for future threads, but don't activate yet
- Every main thread must eventually resolve`;
  }

  if (isMidPhase) {
    // Mid phase: Balance development with progression
    return `
${atThreadLimit ? `- Do NOT introduce new threads (at ${MAX_ACTIVE_THREADS} active threads limit)` : `- Introduce new threads only if essential to plot`}
${atThreadLimit ? `- Collapse or close one thread before introducing new ones` : `- Maximum 1 new thread per page (if needed)`}
- Focus on 1-2 threads per page (do not expand all)
- If thread is "developing" → deepen mystery or add clue
- If urgency is high → move toward reveal or twist
- If thread is false → reinforce wrong belief subtly
- Add false clues to manipulate reader's mind and enforce wrong beliefs
- Start closing low-priority threads
- Avoid opening threads you cannot resolve
- Every main thread must eventually resolve`;
  }

  // Late phase: Focus on resolution
  return `
- Do NOT introduce new threads${atThreadLimit ? ` (at ${MAX_ACTIVE_THREADS} active threads limit)` : ''}
- Focus on resolving existing threads
- Prioritize high-urgency threads
- Reveal false clues as misdirection before resolving
- Connect thread resolutions to each other
- Every main thread must resolve before finale`;
}

function formatEndingPlan(ending?: Ending): string {
  if (!ending) return 'No ending plan yet.';

  const { type, text, outline } = ending;
  return [
    `Type: ${endingTypes[type as keyof typeof endingTypes]}`,
    `Hint: ${text}`,
    outline && outline.length > 0 && `Outline:\n${formatOutline(outline)}`
  ].filter(Boolean).join('\n');
}

function formatOutline(outline: StoryOutline[]): string {
  return outline
    .map(item => `- ${item.text} ${item.isDone ? '✅' : '⬜'}`)
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
    : `the very last page (the end)`;

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
    ├── A missing friend waits in the dark
    ├── Something breathes inside
    └── The room shouldn't exist`;
}

/**
 * Formats the current situation information for a story page in a readable format
 * 
 * @param page - The current page
 * @returns Formatted string with current situation details
 */
function formatCurrentSituationForPrompt(page: CandidateGenerationPage): string {
  const { mood, place, weather, timeOfDay, charactersPresent = [], importantObjects = [], keyEvents = [] } = page;
  const situation: string[] = [];
  
  // Basic situation elements
  if (place) situation.push(`Place: ${place}`);
  if (timeOfDay) situation.push(`Time: ${timeOfDay}`);
  if (mood) situation.push(`Mood: ${mood}`);
  if (weather) situation.push(`Weather: ${weather}`);
  
  // Add characters if present
  if (charactersPresent.length > 0) {
    situation.push(`Characters present: ${charactersPresent.join(', ')}`);
  }
  
  // Add important objects if any
  if (importantObjects.length > 0) {
    // situation.push(`Important objects: ${importantObjects.join(', ')}`);
    situation.push(`Important objects:\n${importantObjects.map(obj => `  · ${obj}`).join('\n')}`);
  }
  
  // Add key events if any
  if (keyEvents.length > 0) {
    situation.push(`Key events:\n${keyEvents.map(event => `  · ${event}`).join('\n')}`);
  }
  
  return situation.map(item => `- ${item}`).join('\n');
}

function formatNextPageStoryContextPrompt(params: BuildNextPagePromptParams): string {
  const { book, advancedState: state, actionedPage: page, previousPages } = params;
  const { mc, summary } = book;
  const { actions } = page;
  const { page: currentPage, contextHistory, plotFlags, factsHistory } = state;
  const stateInfo = getStoryStateInfo(state);
  const { phase, phaseGoal } = stateInfo;

  return `HARD RULES:
- Continue directly from selected action. Example: "I [verb]."
- Continue from current situation.
- Pay close attention to the historical context and story canons. Ensure the storyline and every elements connects perfectly.
- Keep consistent writing style and language.

THEME REMINDER:
${summary}

CURRENT PHASE:
${phase} ${phaseGoal}

MAIN CHARACTER (POV): ${getMainCharacterInfo(mc, state)!}

STORY CONTEXT:
${contextHistory || 'No story context yet.'}

${formatRecentMajorEvents(plotFlags)}

CURRENT FACTS:
${formatCurrentFacts(factsHistory)}

PREVIOUS PAGES:
${formatPreviousPagesForPrompt(currentPage, previousPages, plotFlags)}

CURRENT PAGE:
• Page ${page.page}: ${formatPageTextForPrompt(page.text)}

CURRENT SITUATION:
${formatCurrentSituationForPrompt(page)}

ACTION SELECTION:
Available choices:
${formatActionChoices(actions)}

Selected:
${formatSelectedAction(page)}`;
}

function formatNextPageNarrativePrompt(params: BuildNextPagePromptParams): string {
  const { advancedState: state } = params;
  const { flags, psychologicalProfile, hiddenState, threads, memoryIntegrity, futureNotes } = state;
  const stateInfo = getStoryStateInfo(state);
  const { currentPage, phase } = stateInfo;

  return `NARRATIVE STYLE & PROSE ATMOSPHERE:
${createNarrativeStyle(state).instructions}

PSYCHOLOGICAL FLAGS (Accumulated):
${formatPsychologicalFlags(flags, memoryIntegrity)}

PSYCHOLOGICAL PROFILE (Structured behavioral analysis):
${formatPsychologicalProfile(psychologicalProfile)}

Goal: Make the MC feel "This story knows exactly how I think and is using it against me."

HIDDEN STATE (Influence writing, don't reveal):
${formatHiddenState(hiddenState, currentPage)}

ROUTE MEMORY (Influence writing, don't reveal):
${formatRouteContext(state)}

FUTURE NOTES:
${formatFutureNotes(futureNotes, currentPage, phase)}

---
${RULES_ROUTE_MEMORY}

---
${RULES_FUTURE_NOTES}

---
${RULES_STORY_CONSISTENCY}

---
${RULES_DIFFICULTY_SCALING}

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
 * @param mc - Main character profile containing name, gender, and psychological data
 * @param state - Current story state with progression, flags, and hidden values
 * @param action - Action taken by the user
 * @returns Complete prompt string ready for AI generation
 * 
 * @example
 * ```typescript
 * const prompt = buildCompletePrompt(character, currentState);
 * // Returns: "Continue this branching psychological thriller..." with all placeholders filled
 * ```
 */
function buildEndingRules(state: StoryState): string {
  const { psychologicalProfile, hiddenState, viableEnding } = state;
  const { isFinale, finalePhase = "EARLY" } = getStoryStateInfo(state);
  const { profileShift, endingPlan } = hiddenState;
  const { type = "fake_escape" } = viableEnding ?? {};

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
- Don't fully explain everything`.trim();
  }

  // Non-finale: build toward the ending, possibly with an active trap
  const trapDirective = buildEndingTrapDirective(endingPlan);

  return `- Gradually steer story toward viable ending plan
- IMPORTANT: NEVER SPOIL this ending plan
- Plant small hints across pages; don't fully explain or reveal early
- Increase hint intensity as story progresses: early pages → very subtle, later pages → more obvious but still indirect
${trapDirective ? `\n${trapDirective}\n` : ""}
If the current viable ending is no longer viable, re-determine based on:
- Psychological profile (archetype and stability)
- Profile archetype: ${psychologicalProfile.archetype}
- Profile stability: ${psychologicalProfile.stability}
- Psychological flags
- Detected shift: ${profileShift?.detected ? profileShift.shiftType : "none"}
- Recommended ending type: ${determineOptimalEnding(state)}

Example: High curiosity leads to discovering uncomfortable truths
- Profile archetype: "the_explorer"
- Curiosity flag: "high"
- Recommended ending type: "false_reality"`.trim();
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
        "The MC has just been given false hope. Now destroy it.\n" +
        "• Show the escape route closing\n" +
        "• The 'safe' person reveals something wrong\n" +
        "• The relief was the trap — make the reader feel the rug pulled",
      loop_trap:
        "The MC believes the ordeal is over. It isn't.\n" +
        "• Introduce one detail that echoes the very beginning\n" +
        "• Something familiar appears in the wrong context\n" +
        "• End with the reader realizing the loop never broke",
      identity_reveal:
        "The MC believes they finally understand who they are. They are wrong.\n" +
        "• Contradict a core assumption the MC has held all story\n" +
        "• Show a detail that reframes every prior action in a darker light\n" +
        "• The revelation should feel inevitable in hindsight",
    };
    const guide = executionGuide[endingPlan.type] ?? "Shatter the false resolution — the horror was always here.";
    return `ACTIVE TRAP — EXECUTE NOW:\n${guide}`;
  }

  // Trap is armed but not yet springing — build the false calm
  const buildUpGuide: Record<string, string> = {
    fake_relief_twist:
      "BUILD FALSE SAFETY: The MC should be moving toward something that looks like escape.\n" +
      "• Reduce immediate threat slightly — don't remove tension, soften its edge\n" +
      "• Let a character seem trustworthy for once\n" +
      "• Plant one small 'almost normal' detail that feels like progress",
    loop_trap:
      "BUILD CYCLICAL FAMILIARITY: Plant echoes of earlier pages.\n" +
      "• Repeat a sensory detail from a much earlier scene in a slightly wrong context\n" +
      "• The MC should begin to feel 'this is almost over'\n" +
      "• Don't close the loop yet — hint that closure is near",
    identity_reveal:
      "BUILD MISPLACED CERTAINTY: Let the MC feel they've understood something.\n" +
      "• Reinforce a belief they hold about themselves or another character\n" +
      "• Make the MC feel competent, observant, correct — just this once\n" +
      "• The reader should feel safe. They are not.",
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
 * PSYCHOLOGICAL PROFILE (Structured behavioral analysis):
 * - Archetype: the_paranoid
 * - Stability: cracking
 * - Traits: suspicion, anxiety, hypervigilance
 * 
 * Archetype-specific tactics:
 * Suspicious of everyone, questions motives, sees threats everywhere
 * 
 * Stability impact:
 * Under stress, showing cracks in composure → More direct psychological attacks, visible stress
 * 
 * Personalized horror (manipulation vector):
 * Contradictions, unclear reality, question perceptions
 * 
 * Goal: Make the MC feel "This story knows exactly how I think and is using it against me."
 */
function formatPsychologicalProfile(profile: PsychologicalProfile): string {
  const { archetype, stability, dominantTraits, manipulationAffinity } = profile;

  return `• Archetype: ${archetype} — Tactics: ${archetypes[archetype]}
• Stability: ${stability} — Impact: ${stabilityLevels[stability]}
• Traits: ${dominantTraits.join(', ')}

Personalized horror (manipulation vector):
${manipulationAffinities[manipulationAffinity]}`;
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

function formatPlotFlag(flag: PlotFlag, options?: { showSceneInfo?: boolean, showPageHeader?: boolean, showMajorFlag?: boolean }): string {
  const { showSceneInfo = true, showPageHeader = true, showMajorFlag = true } = options ?? {};
  const sceneInfo = showSceneInfo ? `${[flag.place && `place: ${flag.place}`, flag.timeOfDay && `time: ${flag.timeOfDay}`].filter(Boolean).join(', ')}` : '';
  const pageHeader = showPageHeader ? `• Page ${flag.page}${sceneInfo ? ` (${sceneInfo})` : ''}:` : '';
  return `${pageHeader}[${flag.type}] ${flag.fact}${showMajorFlag && flag.isMajorEvent ? ` (MAJOR)` : ''}`;
}

/**
 * Formats current facts for prompt display
 * 
 * Extracts the most recent fact for each key from the facts history
 * for current canonical facts, sorted by `key` alphabetically.
 * 
 * @todo categorize per type
 */
function formatCurrentFacts(factsHistory: Record<string, FactHistory[]>): string {
  const currentFacts = Object.fromEntries(Object.entries(factsHistory).filter(([_, history]) => history.length > 0).map(([key, history]) => [key, history.at(-1)!]));
  if (Object.keys(currentFacts).length === 0) return 'No facts discovered yet.';

  return Object.entries(currentFacts).sort(([a], [b]) => a.localeCompare(b)).map(([key, fact]) => `• ${key}: ${fact.value} (from page ${fact.page})`).join('\n');
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
    `• Truth level: ${truthLevel}${truthInfluence ? ` (${truthInfluence})` : ""}`,
    `• Threat proximity: ${threatProximity}${threatInfluence ? ` (${threatInfluence})` : ""}`,
    `• Reality stability: ${realityStability}${realityInfluence ? ` (${realityInfluence})` : ""}`,
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
 * Determines AI sampling configuration for the current generation
 * 
 * This function implements a sophisticated multi-layer configuration system that balances
 * creative unpredictability with narrative consistency and structural reliability.
 * 
 * Configuration follows these principles:
 * - Controlled chaos: High enough creativity for eerie tone, low enough for consistency
 * - Phase-based progression: Different creativity levels for story arcs
 * - JSON reliability: Ensures structured output integrity
 * 
 * Purpose:
 * - Sampling configuration controls: creativity, variation, novelty.
 * - It does NOT control: paranoia, hallucinations, psychological instability, narrative tone.
 * - Psychological stability is intentionally absent.
 * - Those should be handled through prompting.
 * 
 * Core Philosophy:
 * - Story Phase → Major influence on creativity
 * - Action Type → Minor influence on creativity
 * - Twists / Revelations → Temporary creativity boost
 * 
 * This will produce more consistent thriller stories, because the psychological effects will
 * come from prompt engineering and story-state system rather than from large sampling swings
 * that can make the model feel erratic.
 * 
 * @param state - Current story state containing progress, psychological profile, and hidden values
 * @param action - Optional action taken by user for context-specific adjustments
 * @returns Dynamic AI configuration optimized for current story context
 * 
 * @example
 * ```typescript
 * // Early story with stable psychological state
 * const earlyConfig = determineAIConfig(
 *   { page: 5, psychologicalProfile: { stability: 'stable' } },
 *   { type: 'explore' }
 * );
 * // Returns: { temperature: 0.75, topP: 0.92, topK: 50, ... }
 * 
 * // Late story with unstable psychological state
 * const lateConfig = determineAIConfig(
 *   { page: 85, psychologicalProfile: { stability: 'unstable' } },
 *   { type: 'attack' }
 * );
 * // Returns: { temperature: 0.65, topP: 0.88, topK: 45, ... }
 * ```
 */
export function determineAIConfig(
  state: StoryState,
  action?: Action
): AIChatConfig {
  const { isEarlyPhase, isMidPhase, isFinale } = getStoryStateInfo(state);

  let config: AIChatConfig =
    isEarlyPhase
      ? AI_CHAT_CONFIG_HUMAN_STYLE
      : isMidPhase
        ? AI_CHAT_CONFIG_DEFAULT
        : {
            ...AI_CHAT_CONFIG_DEFAULT,
            temperature: 0.6,
            topP: 0.85,
            topK: 35
          };

  if (state.hiddenState.profileShift?.detected) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);
  }

  if (action?.type) {
    const actionConfig = ACTION_AI_CONFIG[action.type];
    if (actionConfig) {
      config = applyActionConfig(config, actionConfig);
    }
  }

  if (isFinale) {
    config = applyActionConfig(config, FINALE_CONFIG);
  }

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

FIRST PAGE RULES:
- Open in the middle of a moment, not an introduction.
- Something must feel wrong, contradictory, or slightly off by the end of the first paragraph.
- End on tension, uncertainty, or a soft cliffhanger — never resolution.
- Mood must reflect the disturbance, not the genre.
- Max ${MAX_WORDS_PER_PAGE} words.

BRANCHING ACTIONS:
${getActionRulesText({ isFirstPage: true })}`;
}

function buildFirstBookFieldInstructions(params: Pick<InitializeBookParams, 'mcCandidate' | 'titleIdea'>): string {
  const { mcCandidate, titleIdea } = params;
  return `Book Metadata:
- TITLE: ${BOOK_TITLE_LENGTH}. If provided in theme, use it. Otherwise, NEVER start with "The" except it's really good. Be creative, mysterious, visceral (you feel it), memorable, not generic.${titleIdea ? ` Current title idea is "${titleIdea}".` : ''}
- HOOK: ${HOOK_LENGTH}. Immediate intrigue. Psychological tension.
- SUMMARY: ${SUMMARY_LENGTH}. Sets up premise without revealing the ending plan.
- KEYWORDS: ${KEYWORDS_COUNT} kebab-case tags for theme, genre, mood, and story categorization (keep each short).
- TOTAL PAGES: Min ${BOOK_MIN_PAGES}, max ${BOOK_MAX_PAGES}. Avoid exact multiples of 10. Let theme complexity and MC arc influence the count. If user mention anything about total pages, respect it as long as it's within bounds.

Main Character (MC):
${getMainCharacterInfo(mcCandidate) ?? `- Infer a character whose personality makes the theme more psychologically dangerous for them specifically.
- If MC's name provided in theme input, strictly use it. If not provided, generate unusual (rare) but memorable name idea based on age and language context.`}
- bio: ${mcCandidate?.bio ? 'enhance it' : 'infer from theme if provided'}. Must include at least one psychological trait that will be used against them.

Initial Place:
- familiarity: 0.0-1.0. A place the MC just arrived at = 0.1. Childhood home = 0.9.
- context: ${PLACE_CONTEXT_LENGTH}. Evocative, not descriptive.
- locationHint: no other places. Empty string for now.

Initial Characters:
- It's meant for characters beside MC (the POV). Don't include MC here.
- If MC is alone in this first page, then it should be an empty array.
- Include only side characters who meaningfully exist at story start.
- At least one should have a relationship that can be corrupted.
- bio: must include one trait that could become a source of threat or betrayal.
- narrativeFlags: set to match behavior and twist setup.

Initial Relationships:
- Only between side characters (excluding MC). If initial characters is less than two, omit it.
- For relationship which targetting MC, put it in character's relationshipToMC.

First Page:
- text: follow the rules in "WRITING STYLE:" and "PAGE FORMAT:" creatively (max ${MAX_WORDS_PER_PAGE} words).
- charactersPresent: names of side characters in the scene besides MC. Must match names in initialCharacters.
- keyEvents: ${KEY_EVENT_LENGTH}. Plot-level facts happened in this page.
- importantObjects: objects introduced or used this page that may have future narrative significance.

Initial State:
- Set flags based on opening scene — not defaults.
- difficulty should reflect how hostile the world is to this MC at the start.
- viableEnding: choose an ending type and write a ${VIABLE_ENDING_LENGTH} plan for how the story reaches it. Be specific to MC and theme. If user mention anything about desired ending in theme input, respect it.
- traumaTags: short evocative phrases for experiences that will haunt the MC later.
- futureNotes: any important notes for future AI turns representing narrative obligations towards the viableEnding (future incidents, characters, place, etc), max ${MAX_FUTURE_NOTES} items.
- plotFlags: significant plot development that affect the overall story trajectory (max 2 per page).
- inventory: if any, what items MC brings, can include the amount, traits, and where it located (max ${MAX_INVENTORY_ITEM} item).
- injuries: if any, injuries sustained by the MC in the first page.

Initial Facts:
- Represents long-term story memory, discoveries, or important established facts that influence future turns.
- Only include durable story facts that important to remember 20+ pages later. If unsure, omit it.
- key: consistent ${FACT_KEY_FORMAT}. Type can be either: ${formatOneOf(Object.keys(factTypes))}.
- value: current state. Prefer concise value over long sentence (explanation can be added in reason).
- reason: 1-sentence, why or how it hapenned.

Ending Archetypes:
${getEndingArchetypesText()}`;
}

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


  // Helper to persist book generation progress to DB (fire-and-forget)
  async function onGenerationProgress(progress: StoryGenerationStep | BookGenerationProgress) {
    if (!draftBookId) return;
    try {
      const progressValues: BookGenerationProgress = typeof progress === 'string' ? { step: progress } : progress;
      void updateBookGenerationStatus({ bookId: draftBookId, ...progressValues });
    } catch (e) {
      console.warn('[initializeBook] ⚠️ Failed to persist generation status:', getErrorMessage(e));
    }
  }

  try {
    // Emit book initialization start event and persist initial progress
    await onProgress?.({ type: 'book_initialization_start' });
    await onGenerationProgress('book_initialization');

    // 1. Create AI prompt for book creation
    const prompt = buildBookCreationPrompt(params);

    // 2. Generate complete book setup using AI
    const response = await executePromptForJSON<BookCreationResponse>({
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
        },
      } satisfies AIPromptForJson<BookCreationResponse>,
      jsonStructure: firstBookOutputFormat,
      fieldInstructions: buildFirstBookFieldInstructions(params),
      thinkThenOutput: firstBookReviewChecklist,
      // STEP 3: EVALUATING (inside `executePromptForJSON`)
      evaluatorPrompt: buildFirstBookEvaluatorPrompt(params),
    }, onProgress, onGenerationProgress);

    // 3. Validate AI response
    // TODO: investigate why
    if (!response.result) {
      console.log(`[initializeBook] 🧠 AI response:`, response);
      throw new Error('Failed to generate book: AI response.result is undefined');
    }

    // STEP 4: FINALIZING
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
      initialRelationships,
      initialFacts,
      mainCharacter: mc,
      language
    } = response.result;

    // 3. Validate first page text length
    if (generatedFirstPage.text.length < MIN_CHARS_PER_PAGE) {
      throw new Error('Failed to generate book: First page text is too short');
    }

    // 4. Persist book to database with character profile
    await onProgress?.({ type: 'finalizing_start' });
    await onGenerationProgress('finalizing');
    
    let book: Book;
    let bookId: string;

    if (draftBookId) {
      // Update existing book record (async book creation flow)
      // Update with generated content
      await client.update(books)
        .set({
          title,
          hook,
          summary,
          keywords,
          mc,
          totalPages,
          language, // Match with theme input
          status: 'active', // Book is now complete (published)
        })
        .where(eq(books.id, draftBookId));
      
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
      };
      const dbBook = await insertBook(newBookData, { client, alternativeTitles });
      book = mapBookFromDb(dbBook);
      bookId = book.id;
    }

    // 5. Persist first page as root page of the book
    const firstPage = await insertStoryPage(userId, 1, generatedFirstPage, {
      bookId,
      branchId: 'main',
      aiResponseProvider: response
    }, { client });

    console.log(`[initializeBook] 📔 First page of "${book.title}" inserted:`, filterObjectEntries(firstPage));

    const firstUserPage: UserStoryPage = { ...firstPage, selectedActions: [] };
    const { place, timeOfDay, actions } = firstUserPage;

    console.log(`[initializeBook] 👉 Generated ${actions.length} actions for first page:`, actions.map(a => a.text));

    // 6. Create initial story state with generated psychological profile
    const initialState: StoryState = {
      ...createEmptyStoryState(firstPage.id, 1, totalPages),
      ...{
        ...generatedInitialState,
        plotFlags: generatedInitialState.plotFlags?.map<PlotFlag>((flag) => ({ ...flag, page: 1, place, timeOfDay })) || [],
        inventory: generatedInitialState.inventory?.map<InventoryItem>((item) => ({ ...item, pageAcquired: 1, place })) || [],
        injuries: generatedInitialState.injuries?.map<Injury>((injury) => ({ ...injury, pageAcquired: 1, place })) || [],
        futureNotes: mapFutureNoteWithKey(generatedInitialState.futureNotes, 1, []),
        viableEnding: generatedInitialState.viableEnding ? { ...generatedInitialState.viableEnding, outline: generatedInitialState.viableEnding.outline.map(text => ({ text, isDone: false })) } : undefined,
      },
      hiddenState: createInitialHiddenState(),
      characters: initialCharacters && initialCharacters.length > 0 ? 
        Object.fromEntries<CharacterMemory>(
          initialCharacters.map((char) => [
            char.name,
            {
              ...char,
              pastInteractions: char.pastInteractions?.map<PastInteraction>(i => ({ page: 1, interaction: i, place })) ?? [],
              narrativeFlags: {
                ...{
                  isSuspicious: false,
                  isMissing: false,
                  isDead: false,
                  hasSecret: false,
                  potentialTwist: 'none'
                },
                ...char.narrativeFlags
              },
              introducedAtPage: 1,
              relationships: initialRelationships.filter(r => r.source === char.name).map<CharacterRelationship>(r => {
                return {
                  ...r,
                  type: r.type || "knows",
                  status: r.status || "neutral",
                  context: r.context,
                  recognitionLevel: r.recognitionLevel,
                } satisfies Record<keyof CharacterRelationship, string>;
              })
            } satisfies CharacterMemory
          ])
        ) : {},
      places: initialPlace ? {
        [initialPlace.name]: {
          ...initialPlace,
          visitCount: 1,
          lastVisitedAtPage: 1,
          keyEvents: initialPlace.keyEvents?.map<PastEvent>(e => ({ page: 1, event: e })) ?? [],
        } satisfies PlaceMemory
      } : {},
      factsHistory: initialFacts && initialFacts.length > 0 ?
        Object.fromEntries<FactHistory[]>(
          initialFacts.map((fact) => [
            fact.key,
            [{ ...fact, page: 1 }]
          ])
        ) : {}
    };

    // 7. Generate book cover image in background (fire-and-forget)
    if (generateCoverImage) {
      if (isOriginal) {
        await generateAndUpdateBookCoverImage(book, initialState);
      } else {
        void generateAndUpdateBookCoverImage(book, initialState);
      }
    }

    // 8. Persist story state to database
    await insertStoryState(bookId, firstPage.id, initialState, "original", { client });

    // 9. Pre-generate candidate pages for each action in the first page
    if (isOriginal) { // GitHub cron job, use github-action strategy
      await ensureCandidatesForPageWithStrategy({
        strategy: 'github-action',
        userId,
        page: firstUserPage,
        currentState: initialState,
        currentBook: book,
      });
    } else { // Fire-and-forget for fast user generated book result (immediate background processing)
      // await ensureCandidatesForPageAsync(userId, firstUserPage, initialState, book); // pg-boss, up to 24 hours cron delay
      // await ensureCandidatesForPage(userId, firstUserPage, initialState, book); // 4.5 minute Vercel limit
      triggerCandidateGenerationWorkflow({
        userId,
        pageId: firstUserPage.id,
        bookId: book.id,
        bookTitle: book.title,
        maxDepth: MAX_BRANCHING_PREGENERATION_DEPTH, // Also pre-generate next-level depths
        context: 'initializeBook'
      }).catch(error => {
        console.error('[initializeBook] ❌ Failed to trigger GitHub workflow:', error);
      });
    }

    // 10. Invalidate user caches
    await invalidateUserBooksCache(userId);
    await invalidateUserProfileCache(userId);
    
    // 11. Invalidate public caches if book published immediately
    if (book.status === 'active') {
      await invalidateExploreCache();
      await invalidatePopularTagsCache();
    }

    // 12. Log user activity (book creation)
    await logUserActivity({
      userId,
      activityType: 'book_created',
      targetType: 'book',
      targetId: book.id,
      metadata: { theme: theme.trim() },
    }, { req });

    // 13. Return complete book setup
    await onGenerationProgress('complete');
    return {
      book,
      firstPage,
      initialState,
      aiComment
    } satisfies CreateBookResponse;

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[initializeBook] ❌ Failed to initialize book:`, errorMessage);
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
async function prepareNextPageGenerationSetup(
  params: BuildNextPageParams,
  candidateCount: number,
) {
  const { book, actionedPage } = params;
  const { currentState, advancedState, expectedPageNumber, previousPages } = await prepareNextPageGenerationContext(params);
  const { action, actions } = actionedPage;

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
  const { systemPrompt, documents } = buildSystemPrompt(book, advancedState);
  
  // 2. Determine optimal AI configuration based on story progress and psychological state
  const config = determineAIConfig(advancedState, action);

  return {
    currentState,
    advancedState,
    expectedPageNumber,
    action,
    generationContext,
    promptParams,
    prompt,
    systemPrompt,
    documents,
    config,
    fieldInstructions: buildNextPageFieldInstructions(advancedState, action),
    thinkThenOutput: buildNextPageReviewChecklist(advancedState),
    evaluatorPrompt: buildNextPageEvaluatorPrompt(promptParams),
  };
}

/**
 * Shared logic to calculate state deltas, apply them, correct mismatches, 
 * and merge psychological states cleanly.
 * 
 * @todo need to check - it seems psychological state never resulted by generation, thus never updates
 */
function resolvePageDelta(
  generatedStoryPage: StoryGeneration,
  advancedState: StoryState,
  currentState: StoryState,
  expectedPageNumber: number,
  contextLabel: string,
  fateIndex?: number
) {
  const stateDelta = extractStateDelta(generatedStoryPage, expectedPageNumber, advancedState.futureNotes.map(note => note.key));
  const newState = applyStateDelta(advancedState, stateDelta, generatedStoryPage);

  // Provided story state might mismatch, but still respect what provided
  if (newState.page !== expectedPageNumber) {
    const fateLog = fateIndex !== undefined ? ` for alternative fate ${fateIndex}` : '';
    console.warn(`[${contextLabel}] ⚠️ newState.page mismatch${fateLog}: expected ${expectedPageNumber}, got ${newState.page}. Correcting.`);
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
  const { userId, actionedPage, generateNewBranchId = false } = params;
  const context = "generateNextPage";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, fieldInstructions, thinkThenOutput, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, 1);
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
        documents
      }
    } satisfies AIPromptForJson<StoryGeneration>,
    jsonStructure: nextPageOutputFormat,
    fieldInstructions,
    thinkThenOutput,
    evaluatorPrompt,
  });
  
  // 4. Handle AI response validation
  if (!response.result) {
    throw new Error(`Failed to generate story page: ${response.finishReason ?? "UNKNOWN"} (${response.provider ?? "unknown"})`);
  }

  // 5. Apply state updates
  const generatedStoryPage = response.result;
  const { newState, fullStateDelta } = resolvePageDelta(
    generatedStoryPage, 
    advancedState, 
    currentState, 
    expectedPageNumber, 
    context
  );

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
  const { userId, actionedPage, generateNewBranchId = false, candidateCount: providedCandidateCount = DEFAULT_CANDIDATE_PAGE_PER_ACTION } = params;
  
  // Fast path: Route to single page generation if only 1 is requested
  if (providedCandidateCount === 1) return [await generateNextPage(params)];

  const candidateCount = Math.min(providedCandidateCount, MAX_CANDIDATE_PAGE_PER_ACTION);
  if (providedCandidateCount > candidateCount) {
    console.warn(`[generateNextPages] ⚠️ candidateCount ${providedCandidateCount} clamped to ${MAX_CANDIDATE_PAGE_PER_ACTION}`);
  }

  const context = "generateNextPages";

  // 1 & 2. Setup context, config, and prompts
  const { prompt, config, systemPrompt, documents, fieldInstructions, thinkThenOutput, evaluatorPrompt, generationContext, advancedState, currentState, expectedPageNumber, action } = await prepareNextPageGenerationSetup(params, candidateCount);
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
        documents
      }
    } satisfies AIPromptForJson<CandidatePagesGeneration>,
    jsonStructure: multiNextPageOutputFormat,
    fieldInstructions,
    thinkThenOutput,
    evaluatorPrompt,
  });
  
  // 4. Handle AI response validation
  if (!response.result) {
    throw new Error(`Failed to generate story page candidates: ${response.finishReason ?? "UNKNOWN"} (${response.provider ?? "unknown"})`);
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
  for (const [index, generatedStoryPage] of generatedStoryPages.entries()) {
    const isFirstAlternative = index === 0;

    // Resolve state updates using the helper
    const { newState, fullStateDelta } = resolvePageDelta(
      generatedStoryPage,
      advancedState,
      currentState,
      expectedPageNumber,
      context,
      index + 1
    );

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
 * Executes a prompt and returns structured JSON response
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
  const outputFormatPart = `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;
  const fieldInstructionsPart = fieldInstructions ? `FIELD INSTRUCTIONS:\n${stripEmptyLines(fieldInstructions)}` : '';
  const thinkThenOutputPart = thinkThenOutput ? `REVIEW & FIX (IMPORTANT):

Silently evaluate your generated output using the checklist below.
If any item fails, revise internally before producing final output.

${stripEmptyLines(thinkThenOutput)}

Only output the final corrected JSON.
Do NOT mention this checklist.` : '';

  const finalPrompt = [
    prompt.trim(),
    outputFormatPart,
    fieldInstructionsPart,
    thinkThenOutputPart
  ].join('\n\n---\n');

  const response = await aiPrompt<T>(
    finalPrompt,
    createAIOptionsWithSchema<T>(configs),
    evaluatorPrompt,
    onProgress,
    onGenerationProgress,
  );

  if (!response.result) {
    console.log(`[executePromptForJSON] 🧠 Response provider:`, response.provider);
    console.log(`[executePromptForJSON] 🧠 Response model:`, response.model);
    console.log(`[executePromptForJSON] 🧠 Response finishReason:`, response.finishReason);
    console.log(`[executePromptForJSON] 🧠 Response output:`, response.output);
  }

  return response;
}

/**
 * Generates the prompts for book creation theme generation
 * 
 * @returns Object containing systemPrompt and userPrompt for book creation
 */
function getBookCreationPrompts(headerLanguage?: string | null): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are a creative writing assistant specializing in generating engaging story prompts for interactive fiction and thriller novels.

Your task is to generate a compelling story prompt that includes:
1. A story theme (required) - a sentence or paragraph describing what the story is about
2. Optional main character details (name, gender, age, short bio/personality)
3. Optional story tone (dark, suspenseful, psychological, etc.)
4. Optional story elements (atmospheric details, narrative devices, themes, etc.)

Constraints:
- Character age must be between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE} years old (if including character details)
- Focus on thriller, mystery, horror, or psychological themes
- Make it intriguing and hook the reader immediately
- Be creative with the format - there are no strict formatting rules
- Overall output length must not exceed ${MAX_THEME_LENGTH_PROMPT} characters
- Do not use Markdown formatting (no bold with **, no italic with *, no headers with #) - output will be inserted into a plain textarea
- Character gender can be either: ${formatOneOf(genders)}
- MC gender must be explicit: 'male' or 'female'

Output example (not strict):
Story about [theme description]
MC: [Name], [Gender], [Age]

Only the theme is required. All other fields are optional - include them only if they add value to the story concept.`;

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
