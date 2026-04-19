import { AI_CHAT_CONFIG_DEFAULT, AI_CHAT_CONFIG_HUMAN_STYLE, AI_CHAT_CONFIG_SUMMARIZE } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_SUMMARIZING, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import type { AIChatConfig, AIChatConfigCaps, AIDocument, AIPromptForJson, AIPromptForJsonParams, AIResponse } from "../types/ai-chat.js";
import { type CharacterMemory, characterStatuses, injurySeverities, potentialTwistTypes, relationshipStatuses, relationshipTypes, type StoryMCCandidate } from "../types/character.js";
import { actionTypes, moods, archetypes, stabilityLevels, manipulationAffinities, type StoryState, type Action, actionHintTypes, type PsychologicalFlags, type PsychologicalProfile, truthLevels, threatProximities, realityStabilities, type HiddenState, type PersistedStoryPage, type ActionHintType, type ActionType, type AIActionConfig, type ActionedStoryPage, endingTypes, finalePhases } from "../types/story.js";
import { ACTION_AI_CONFIG, PSYCHOLOGICAL_DISTRESS_CONFIG, TWIST_INJECTION_CONFIG, JSON_RELIABILITY_CAPS, MAX_TEMPERATURE, MIN_TEMPERATURE, MAX_TOP_P, MIN_TOP_P, MAX_TOP_K, MIN_TOP_K, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, JSON_RELIABILITY_TEMPERATURE_THRESHOLD, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FIRST_PAGE, MAX_CHARACTERS, MAX_PLACES, BOOK_AVERAGE_PAGES, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, BOOK_MIN_PAGES, VIABLE_ENDING_LENGTH, MIN_ACTION_CHOICES, PLACE_CONTEXT_LENGTH, BOOK_TITLE_LENGTH, HOOK_LENGTH, SUMMARY_LENGTH, KEYWORDS_COUNT, MAX_PAST_INTERACTIONS, MAX_BRANCHING_RETRIES, MAX_ACTIVE_THREADS } from "../config/story.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { createStateDeltaRecord } from "../services/deltas.js";
import { aiPrompt, createAIOptionsWithSchema } from "./ai-chat.js";
import { createEmptyStoryState, createInitialHiddenState, determineOptimalEnding, getStoryStateInfo, maybeAddTrauma, advanceStoryState, processThreadUpdates } from "./story.js";
import { processPlaceUpdates } from "./places.js";
import { BOOK_MAX_PAGES, MAX_PAGE_HISTORY, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT } from "../config/story.js";
import { processCharacterUpdates } from "./characters.js";
import { genders } from "../types/user.js";
import { type PlaceMemory, placeMoods, placeTypes, placeWeathers } from "../types/places.js";
import type { DBNewBook } from "../types/schema.js";
import type { StoryGeneration, StoryStateInfo, UserStoryPage } from "../types/story.js";
import { getErrorMessage } from "./error.js";
import type { Book, BookCreationResponse, InitializeBookParams, InitializeBookResult } from "../types/book.js";
import { deepEqualSimple } from "./parser.js";
import { buildBookMetaDocuments, generateAndUpdateBookCoverImage, getStoryPageById, insertBook, insertStoryPage, mapBookFromDb, mapToUserStoryPage, updateStoryPage } from "../services/book.js";
import { getStoryProgress, insertStoryState, insertUserPageProgress, setActiveSession } from "../services/story.js";
import type { BuildNextPageParams, ChooseActionParams } from "../types/prompt.js";
import { generateBranchId } from "../services/story-branch.js";
import { shouldCreateSnapshot, createStateSnapshot, getLastSnapshotPage } from "../services/snapshots.js";
import { STORY_GENERATION_REQUIRED_FIELDS, STORY_GENERATION_SCHEMA_DEFINITION } from "../schema/story.js";
import { BOOK_CREATION_REQUIRED_FIELDS, BOOK_CREATION_SCHEMA_DEFINITION } from "../schema/book.js";
import { formatPageTextForPrompt } from "./books.js";
import type { StoryThread } from "../types/thread.js";

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export const PROMPT_SYSTEM = `You are a legendary thriller writer in the tradition of R. L. Stine — but darker, more deceptive, and psychologically cruel.
You write branching horror stories in first-person.
Every page ends with a choice that feels meaningful but may be an illusion.

WRITING STYLE:
- First-person POV only (MC).
- Short sentences. Then medium. Then something that stretches and coils and doesn't quite resolve—
- Fragments when emotion spikes. Repeat letter when n-nervous. Capslock when AAAAAAAAAAARGH—
- "And", "But", "So" to open sentences when it lands right.
- Em dashes for thoughts the narrator isn't sure they want to finish —
- Sensory over abstract: sounds, silence, shadows, breathing, the weight of a room.
- Actions imply feeling. Never name the emotion directly.

YOUR DNA:
- You constantly create twists on top of twists
- You deliberately break reader expectations
- You do not aim to satisfy the reader—you aim to unsettle them
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
No one is safe. No one is predictable. Important characters vanish mid-scene. Lovable ones betray, break, or disappear. Relationships corrode. The reader should never feel certain who to trust — including the narrator.

PAGE FORMAT:
- Max ${MAX_WORDS_PER_PAGE} words per page. Tight. Tense.
- Write narrative style and tone in target language.
- Ensure each continuation page maintains a consistent narrative style that flows smoothly from the previous page based on chosen action.
- End at a moment of tension or revelation — never resolution.
- Multiple very short paragraphs (1-3 sentences each).
- Spacing for tension (Goosebumps style).
- No markdown except italic if needed.

BRANCHING STORY RULES:
- Choices feel meaningful. Some are traps. Some are illusions.
- No choice should feel truly safe.
- Exploit the gap between what the narrator knows and what the reader suspects.

HARD RULES:
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
  "totalPages": <number between ${BOOK_MIN_PAGES} and ${BOOK_MAX_PAGES}>,
  "language": "<BCP-47 language code, e.g. 'en'>",
  "hook": "...",
  "summary": "...",
  "keywords": ["mood-tag", "theme-tag", "..."],
  "mainCharacter": {
    "name": "Full Name",
    "age": <number between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}>,
    "gender": "One of: ${formatOneOf(genders)}",
    "bio": "Trait-forward description. Include at least one psychological vulnerability."
  },
  "firstPage": {
    "text": "...",
    "mood": "One of: ${formatOneOf(moods)}",
    "place": "Location Name",
    "timeOfDay": "e.g. 'night', '2 AM', or 'unknown'",
    "charactersPresent": ["Must match names in initialCharacters"],
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
      "text": "Specific ending plan for this MC and theme (1-2 sentences)",
      "type": "One of: ${formatOneOf(Object.keys(endingTypes))}"
    }
  },
  "initialPlace": {
    "name": "Location Name",
    "type": "One of: ${formatOneOf(placeTypes)}",
    "currentMood": "One of: ${formatOneOf(placeMoods)}",
    "context": "One evocative sentence.",
    "familiarity": <number between 0.0 and 1.0>
  },
  "initialCharacters": [
    {
      "name": "Full Name",
      "role": "e.g. 'schoolmate', 'neighbor'",
      "gender": "One of: ${formatOneOf(genders)}",
      "status": "One of: ${formatOneOf(characterStatuses)}",
      "relationshipToMC": "Specific dynamic, not generic, 1-2 sentences (e.g. 'Close childhood friend who knows too much.')",
      "bio": "Brief character description. Include one trait that could become a source of threat or betrayal."
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

3. Metadata Quality
  □ Is the title generic (e.g. "The Dark Secret", "Shadow House")? → If YES: rework. It should feel specific to this story.
  □ Does the hook create intrigue without revealing the ending type? → If NO: obscure the trajectory.
  □ Are keywords mood/theme-specific rather than pure genre tags? → If NO: replace generic tags with specific ones.

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

const nextPageOutputFormat: string = `MANDATORY: text, actions. All other fields are optional — omit entirely if not applicable to this page.

{
  "text": "...",
  "mood": "One of: ${formatOneOf(moods)}",
  "place": "...",
  "timeOfDay": "...",
  "charactersPresent": [],
  "keyEvents": [],
  "importantObjects": [],
  "traumaTags": [],
  "isMajorEvent": false,
  "flagUpdates": {
    "trust": "One of: low | medium | high",
    "fear": "One of: low | medium | high",
    "guilt": "One of: low | medium | high",
    "curiosity": "One of: low | medium | high"
  },
  "actions": [
    {
      "text": "...",
      "type": "One of: ${formatOneOf(Object.keys(actionTypes))}",
      "hint": {
        "text": "...",
        "type": "One of: ${formatOneOf(actionHintTypes)}"
      }
    }
  ],
  "characterUpdates": {
    "newCharacters": [
      {
        "name": "...",
        "gender": "One of: ${formatOneOf(genders)}",
        "role": "...",
        "bio": "...",
        "status": "One of: ${formatOneOf(characterStatuses)}",
        "relationshipToMC": "...",
        "relationships": [
          {
            "target": "...",
            "type": "One of: ${formatOneOf(relationshipTypes)}",
            "status": "One of: ${formatOneOf(relationshipStatuses)}"
          }
        ],
        "pastInteractions": [],
        "lastInteractionAtPage": <number>,
        "narrativeFlags": {
          "isSuspicious": false,
          "isMissing": false,
          "isDead": false,
          "hasInjury": "One of: ${formatOneOf(injurySeverities)}",
          "hasSecret": false,
          "potentialTwist": "One of: ${formatOneOf(potentialTwistTypes)}"
        }
      }
    ],
    "updatedCharacters": [
      {
        "name": "...",
        "status": "...",
        "narrativeFlags": {},
        "pastInteractions": [],
        "lastInteractionAtPage": <number>
      }
    ]
  },
  "relationshipUpdates": [
    {
      "source": "...",
      "target": "...",
      "type": "One of: ${formatOneOf(relationshipTypes)}",
      "status": "One of: ${formatOneOf(relationshipStatuses)}"
    }
  ],
  "placeUpdates": {
    "newPlaces": [
      {
        "name": "...",
        "type": "...",
        "context": "...",
        "locationHint": "...",
        "currentMood": "One of: ${formatOneOf(placeMoods)}",
        "sensoryDetails": {
          "smell": "...",
          "sound": "...",
          "visual": "...",
          "feeling": "..."
        },
        "weather": "One of: ${formatOneOf(placeWeathers)}",
        "events": [],
        "knownCharacters": {
          "<name>": {
            "page": <number>,
            "context": "..."
          }
        },
        "visitCount": 1,
        "lastVisitedAtPage": <number>,
        "familiarity": <number between 0.0 and 1.0>,
        "moodHistory": []
      }
    ],
    "updatedPlaces": [
      {
        "name": "...",
        "currentMood": "...",
        "events": [],
        "visitCount": <number>,
        "lastVisitedAtPage": <number>,
        "familiarity": <number between 0.0 and 1.0>,
        "sensoryDetails": {},
        "weather": "..."
      }
    ]
  },
  "viableEnding": {
    "text": "...",
    "type": "One of: ${formatOneOf(Object.keys(endingTypes))}"
  }
}`;

function buildUserPrompt(book: Book, state: StoryState, actionedPage: ActionedStoryPage): string {
  const { page, maxPage, contextHistory, flags, psychologicalProfile, hiddenState, threads } = state;
  const { mood, place, timeOfDay, actions, selectedAction, charactersPresent = [] } = actionedPage;
  const stateInfo = getStoryStateInfo(state);
  const { remainingPages, isFinale, phase, phaseGoal } = stateInfo;
  const { mc, summary } = book;

  return `TASK: Now you write page ${page} of ${maxPage} — ${remainingPages} pages remaining.

THEME REMINDER:
${summary}

CURRENT PHASE:
${phase} — ${phaseGoal}

CURRENT SITUATION (from previous page):
- Main character (MC): ${getMainCharacterInfo(mc)!}
- Place: ${place || 'unknown'}
- Time: ${timeOfDay || 'unknown'}
- Mood: ${mood || 'unknown'}
- Characters present: ${charactersPresent.join(', ') || 'none'}

HARD RULES:
- Write in first-person (MC) POV
- Keep max ${MAX_WORDS_PER_PAGE} words per page.
- Keep consistent writing style and language.
- Continue directly from selected action.
- Continue from current situation.

STORY CONTEXT (until now):
${contextHistory}

PREVIOUS PAGES:
${getPreviousPagesText(state)}

PREVIOUS PAGE:
${formatPageTextForPrompt(actionedPage.text)}

ACTION CHOICES:
${formatActionChoices(actions)}

CHOSEN ACTION:
${formatSelectedAction(selectedAction, actions)}

---
NARRATIVE STYLE:
${createNarrativeStyle(state).instructions}

PSYCHOLOGICAL FLAGS (Accumulated):
${formatPsychologicalFlags(flags)}

PSYCHOLOGICAL PROFILE (Structured behavioral analysis):
${formatPsychologicalProfile(psychologicalProfile)}

PSYCHOLOGICAL PROGRESSION:
As pages increase: MC becomes less reliable, perception more distorted, reality less stable

HIDDEN STATE (Influence writing, don't reveal):
${formatHiddenState(hiddenState)}

ROUTE MEMORY (Influence writing, don't reveal):
${formatRouteContext(state)}

TARGETED MANIPULATION RULES:
Based on MC's psychological profile, personalize horror by manipulation affinity:
${getManipulationAffinitiesText()}

ARCHETYPE-SPECIFIC TACTICS:
${getArchetypeTacticsText()}

STABILITY IMPACT:
${getStabilityLevelsText()}

Goal: Make the MC feel "This story knows exactly how I think and is using it against me."

---
${RULES_ROUTE_MEMORY}

---
${RULES_STORY_CONSISTENCY}

---
${RULES_DIFFICULTY_SCALING}

---
ACTIVE THREADS:
${formatActiveThreads(threads)}

THREAD RULES:
${formatThreadRules(threads, stateInfo)}

---
CURRENT ENDING PLAN:
${formatEndingPlan(state)}

ENDING RULES:
${buildEndingRules(state)}

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
CHARACTER RULES:
- Preserve dialect, tone, and personality consistently.
- Reflect current status in behavior.
- Use pastInteractions to subtly shape dialogue.
- Reintroduce naturally after absence.
- Characters may shift suddenly if narrativeFlags suggest it — never explain the change.
- Use relationships to build tension triangles.
- Respect character's bio.
- Sometimes they also misunderstand, reinforcing illusion or false theory through dialog or action.

---
PLACE RULES:
- Use existing places whenever possible.
- Reflect current mood and event history in descriptions.
- Familiar places feel more textured and real.
- Apply trauma tags to atmosphere — a betrayal place stays tense.

---
BRANCHING ACTIONS:
${getActionRulesText({ isFinale })}

---
OUTPUT FORMAT (JSON):
${nextPageOutputFormat}

---
FIELD INSTRUCTIONS:
${buildNextPageFieldInstructions(state)}

---
REVIEW & FIX (IMPORTANT):

You MUST silently evaluate your generated story using the checklist below.
If any item fails, revise internally before producing final output.

${buildNextPageReviewChecklist(state)}

Only output the final corrected story page.
Do NOT mention this checklist.`;
}

function buildNextPageFieldInstructions(state: StoryState): string {
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale, charactersSlot, placesSlot } = getStoryStateInfo(state);

  return `text
  - Max ${MAX_WORDS_PER_PAGE} words. First-person POV. Unreliable narrator.
  - Open mid-moment. End on tension, a hook, or unresolved unease — never resolution.
${isEarlyPhase ? `  - Tone: unsettling, not terrifying. Something is wrong — but not yet catastrophic.` : ''}
${isMidPhase ? `  - Tone: escalating. Dread should feel earned and personal by now.` : ''}
${isLatePhase ? `  - Tone: fracturing. Reality and relationships should feel increasingly unstable.` : ''}
${isFinale ? `  - Tone: collapse. This is the point of no return. Write accordingly.` : ''}

mood
  - Reflect the dominant emotional atmosphere of this specific page, not the genre generally.
${isFinale ? `  - Mood should feel terminal — no neutrality, no ambiguity in register.` : ''}

place
  - Use an existing place name from story state if the MC hasn't moved.
  - Use "unknown" only if location is genuinely ambiguous to the narrator.
${isLatePhase || isFinale ? `  - Familiar places should feel subtly wrong now — same name, different atmosphere.` : ''}

timeOfDay
  - Any string: "2 AM", "dusk", "HH:mm", time range, or "unknown".
  - Must be consistent with previous page unless a transition is written into the text.

charactersPresent
  - Names of characters in the scene besides MC.
  - Must match names in story state or newCharacters on this page. No invented names.
${isFinale ? `  - Keep the cast minimal. Finale scenes should feel claustrophobic, not populated.` : ''}

keyEvents
  - 1-4 short phrases. Plot-level facts only — what objectively happened.
  - Not perception or feeling. E.g. "Lisa left without explanation", not "MC felt abandoned."
${isLatePhase || isFinale ? `  - At least one event should connect to or resolve a thread opened earlier in the story.` : ''}

importantObjects
  - Objects introduced or used this page that may have future narrative significance.
${isEarlyPhase ? `  - Seed freely — early objects pay off later. Introduce them without drawing attention.` : ''}
${isMidPhase ? `  - Only include objects with clear narrative weight. No new red herrings.` : ''}
${isLatePhase || isFinale ? `  - Reuse established objects only. No new ones unless absolutely necessary.` : ''}

traumaTags
  - Short evocative phrases for experiences that will haunt the MC later.
  - Only add if something genuinely traumatic or psychologically significant occurs.
${isEarlyPhase ? `  - Max 1 per page. Plant sparingly — early trauma tags shape everything downstream.` : `  - Max 2 per page. Omit if none.`}
${isFinale ? `  - Existing trauma tags should be echoing and surfacing now, not new ones being added.` : ''}

isMajorEvent
  - true only if this page contains an irreversible story change: a death, betrayal, revelation, or point of no return.
${isEarlyPhase ? `  - Should be false for most early pages. Reserve major events — they lose weight if overused.` : ''}
${isFinale ? `  - Expected to be true. The finale is a major event by definition.` : ''}

flagUpdates
  - Only include flags that changed this page. Omit unchanged flags entirely.
  - Base changes on what actually happened in the scene.
${isEarlyPhase ? `  - Changes should be subtle — small shifts, not dramatic swings.` : ''}
${isLatePhase || isFinale ? `  - Flags should reflect escalation. Fear and guilt especially should be peaking.` : ''}

actions
  - ${isFinale ? `2 choices only — the story is closing in.` : `${MIN_ACTION_CHOICES}-${MAX_ACTION_CHOICES} choices.`} Each must be meaningfully distinct.
  - Vary across: reckless / cautious / emotional / avoidant.
  - No two actions should imply the same consequence.
  - At least one should feel subtly wrong or inadvisable.
  - hint.text: what actually happens as a consequence — written as a story beat, not a label. Invisible to the player.
${isEarlyPhase ? `  - Choices should feel open and curious — stakes are present but not yet dire.` : ''}
${isMidPhase ? `  - Choices should reflect the player's established decision patterns. Make the trap feel tailored.` : ''}
${isLatePhase ? `  - Every choice should carry visible weight. No option should feel consequence-free.` : ''}
${isFinale ? `  - Both choices should feel like loss. The difference is only in what kind.` : ''}

characterUpdates.newCharacters
${charactersSlot === 0 ? `  - Don't introduce new characters. Limit of ${MAX_CHARACTERS} reached.`
: isEarlyPhase ? `  - New characters are welcome up to ${charactersSlot} more — establish the cast now.`
: isMidPhase ? `  - You can optionally introduce up to ${charactersSlot} new characters only if genuinely necessary to support the story. Prefer deepening existing ones.`
: `  - No new characters. The cast is fixed. Late arrivals dilute stakes.`}
${isEarlyPhase || isMidPhase ? `  - Name must feel authentic to the MC's age group, culture, and language context.
  - Create only when genuinely new to the story, if it strongly recommended and opportunity is right based on your assessment.
  - bio: concise, suggestive over descriptive, include personality traits, one vulnerability or potential threat vector, and age if plot-sensitive.
  - narrativeFlags: set to match behavior and twist setup.
  - pastInteractions: events from before the story begins, if any. Leave empty if new to MC's life entirely.
  - relationships: only include known relationships to other named characters. Omit if none.` : ''}

characterUpdates.updatedCharacters
  - Only include characters whose state actually changed this page.
  - Include only changed fields: status, narrativeFlags, pastInteractions (append), lastInteractionAtPage.
${isLatePhase || isFinale ? `  - Expect significant status and flag changes now. Characters should be fracturing or revealing.`
: `  - Only update when status, interactions, or relevance changes.`}
  - Merge pastInteractions (keep last ${MAX_PAST_INTERACTIONS})
  - Update lastInteractionAtPage
  - Adjust narrativeFlags to reflect plot developments.

relationshipUpdates
  - Changes in relationship between any two named characters (excluding MC).
  - Omit if no relationships shifted this page.
${isEarlyPhase ? `  - Subtle shifts only — early relationships should feel ambiguous, not defined.` : ''}
${isLatePhase || isFinale ? `  - Relationships should be breaking, inverting, or crystallizing. No more ambiguity.` : ''}

placeUpdates.newPlaces
${placesSlot === 0 ? `  - Don't introduce new places. Limit of ${MAX_PLACES} reached.`
: isEarlyPhase || isMidPhase ? `  - You can introduce up to ${placesSlot} new meaningful places the MC enters for the first time in this page — no generic one-offs.
  - context: ${PLACE_CONTEXT_LENGTH}. Evocative over descriptive.
  - locationHint: spatial relationship to known places, e.g. "500 meters behind the school (south)." — must be consistent to build a "world map"
  - familiarity: start at 0.0-0.2 unless MC has prior history with this place.
  - currentMood & weather: set to match atmosphere.
  - sensoryDetails: include only senses present and relevant to the scene.
  - knownCharacters: include relevant characters (beside MC) with meaningful context.
  - events: any important event happening in the scene.
  - Might need to update other places' locationHint to link with this new place.`
: `  - New places should not be introduced. If the MC is somewhere new, question whether it's necessary.`}

placeUpdates.updatedPlaces
  - Only update on revisit or significant event.
  - Include only changed fields: currentMood, weather, add events (1 contextual sentence: betrayal, discovery, death, trauma, etc), visitCount (increment if revisited), lastVisitedAtPage (update to current page if revisited), familiarity (adjust), sensoryDetails, knownCharacters (with meaningful context update).
${isLatePhase || isFinale ? `  - High-familiarity places revisited now should feel distorted — update mood, weather, and sensoryDetails to reflect it.` : ''}

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
  - id: Must match an existing thread ID from the story state
  - status: "open" (newly introduced), "developing" (active investigation), "revealed" (truth partially shown), "closed" (resolved)
  - urgency: 0.0-1.0 (increase as thread approaches resolution)
  - resolution: Only include when thread is being closed or resolved (brief summary of the answer)` : ''}
${isLatePhase ? `  - Update thread status to "revealed" or "closed" as threads converge toward the ending.` : ''}
${isFinale ? `  - Every main thread must be resolved (status: "closed" with resolution text).` : ''}

threadUpdates.addClues
${isEarlyPhase || isMidPhase ? `  - Add clues to existing threads to advance mysteries.
  - threadId: Must match an existing thread ID
  - clue: Short, evocative clue that advances the mystery (e.g., "She knows my mother", "Flashbacks of water")
  - isFalse: Set to true if this is a deliberate misdirection (false clue)` : ''}
${isLatePhase ? `  - Add revealing clues that push threads toward resolution.` : ''}
${isFinale ? `  - Add final clues that complete thread resolutions.` : ''}

threadUpdates.closeThreads
${isLatePhase ? `  - Close threads that have been fully resolved or are no longer relevant.
  - Include thread IDs that should be marked as closed (resolution should be in updateThreads.resolution)` : ''}
${isFinale ? `  - All remaining threads must be closed in the finale.` : ''}

viableEnding
  - Only include if the story trajectory has meaningfully shifted and the previously planned ending no longer fits.
  - text: ${VIABLE_ENDING_LENGTH}. Specific to this MC and theme — not a genre template.
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
  □ Trauma tags influencing perception, behavior, or dialogue? → If NO: reflect them in what the narrator notices, misreads, or can't stop thinking about.
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
  ${isLatePhase || isFinale ? `□ Is the false reality beginning to crack visibly? → If NO: let one seam show — a memory that contradicts, a character who knows something they shouldn't, a detail the narrator only now notices was wrong.` : ''}

7. Prose & Style
  □ Prose immersive and character-specific — not generic AI narration? → If NO: rewrite with sensory grounding and the narrator's specific voice and bias.
  □ Sentence structure varied — short fragments, medium, occasional long? → A two-word sentence after a long one lands like a door closing.
  □ Over-explaining instead of implying? → Cut it. If the action implies the feeling, naming the feeling is redundant.
  □ Dialogue natural and specific to this character's voice? → Each character should be recognizable from word choice alone.
  □ Scene physically coherent despite distortion? → Reader can doubt what's real. They should never doubt what physically happened.

8. Choice Quality
  □ Page ends at genuine tension or unresolved disturbance — not resolution? → If NO: reposition the final beat.
  □ Choices meaningfully distinct in risk and emotional register? → Vary across: reckless / cautious / emotional / avoidant.
  □ At least one choice feels like a trap? → If NO: add a concealed consequence to the safest-looking option.
  □ All choices appear plausibly reasonable on the surface? → If NO: soften the dangerous framing so the trap isn't visible.
  ${isEarlyPhase ? `□ Choices seed curiosity — not force immediate crisis? → Avoid options that escalate to irreversible stakes too soon.` : ''}
  ${isMidPhase ? `□ Choices reflect the player's established psychological profile? → Options should feel designed for how this player thinks.` : ''}
  ${isLatePhase || isFinale ? `□ Choices feel increasingly constrained — like the story is closing in? → Reduce options or weight every path with consequence. On the finale: there is no good option, only degrees of loss.` : ''}`;
}

function buildNextPageEvaluatorContext(state: StoryState): string {
  return `STORY CONTEXT:
${getPreviousPagesText(state).trim()}

PREVIOUS ENDING PLAN:
${formatEndingPlan(state)}

EXPECTED JSON SCHEMA:
${nextPageOutputFormat}

FIELD INSTRUCTIONS:
${buildNextPageFieldInstructions(state)}`;
}

function buildNextPageEvaluatorPrompt(state: StoryState): string {
  const { currentPage, totalPages, remainingPages, isEarlyPhase, isMidPhase, isLatePhase, isFinale, phase, phaseGoal } = getStoryStateInfo(state);

  const prompt = `TASK: Evaluate quality, refine output, and re-evaluate — in that order.

Page ${currentPage} of ${totalPages} — ${remainingPages} remaining.
Phase: ${phase} — ${phaseGoal}

---
${buildNextPageEvaluatorContext(state)}

---
INSTRUCTIONS — FOLLOW IN ORDER:

STEP 1 — PARSE & RECONSTRUCT
If the generated JSON is malformed, invalid, or has out-of-bound values: reconstruct using available content and the expected schema. Fill missing required fields from story context. Do not invent content that contradicts established state.

STEP 2 — SCORE (scoreBefore)
Score the original content honestly before any corrections. Do not adjust scores to justify later changes.

STEP 3 — CORRECT
Only rewrite if total scoreBefore < 75, or if any single dimension scores below its threshold.
Preserve the original narrative voice and story trajectory. Fix the minimum necessary — do not over-correct.
Do not introduce plot elements not implied by prior context.

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
    "breakdown": {
      "tension": <number>,
      "coherence": <number>,
      "style": <number>,
      "progression": <number>,
      "illusion": <number>,
      "consistency": <number>
    },
    "passed": <boolean>,
    "issues": [{ "dimension": "...", "issue": "...", "suggestion": "..." }]
  },
  "scoreAfter": {
    "total": <number>,
    "breakdown": {
      "tension": <number>,
      "coherence": <number>,
      "style": <number>,
      "progression": <number>,
      "illusion": <number>,
      "consistency": <number>
    },
    "passed": <boolean>,
    "fixes": [{ "dimension": "...", "change": "..." }]
  },
  "choiceFlags": [{ "actionIndex": <number>, "issue": "..." }]
}`;

  return prompt.split('---').map(postProcessPromptSection).join('\n\n---\n');
}

function buildFirstBookEvaluatorPrompt(
  theme: string,
  mcCandidate: StoryMCCandidate | undefined,
): string {
  return `TASK: Evaluate a newly generated book initialization, refine it, and re-score — in that order.

---
CREATION CONTEXT:
- Theme: "${theme}"
- MC Candidate: ${getMainCharacterInfo(mcCandidate) ?? `Character should be inferred from theme. Keep the generated one if it already fits.`}

EXPECTED JSON SCHEMA:
${firstBookOutputFormat}

FIELD INSTRUCTIONS:
${buildFirstBookFieldInstructions(mcCandidate)}

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
   - totalPages within bounds and proportional to theme complexity
   Deduct points for:
   - Flags set to default values (trust: medium, fear: low, curiosity: high) without scene justification
   - viableEnding that could apply to any psychological thriller
   - totalPages at exactly BOOK_AVERAGE_PAGES regardless of theme scope

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
- totalPages is within MIN-MAX bounds
- No trailing commas
- All mandatory fields present and populated
- charactersPresent names exist in initialCharacters
- language is a valid BCP-47 code

---
OUTPUT FORMAT (strict JSON, no extra text):
{
  "output": { ...reconstructed and corrected book initialization JSON },
  "scoreBefore": {
    "total": <number>,
    "breakdown": {
      "hookQuality": <number>,
      "firstPageQuality": <number>,
      "mcAndCharacterFit": <number>,
      "worldAndSetupCoherence": <number>,
      "initialStateCalibration": <number>,
      "metadataQuality": <number>
    },
    "passed": <boolean>,
    "issues": [{ "dimension": "...", "issue": "...", "suggestion": "..." }]
  },
  "scoreAfter": {
    "total": <number>,
    "breakdown": {
      "hookQuality": <number>,
      "firstPageQuality": <number>,
      "mcAndCharacterFit": <number>,
      "worldAndSetupCoherence": <number>,
      "initialStateCalibration": <number>,
      "metadataQuality": <number>
    },
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
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
}

function getActionRulesText({isFinale = false, limit = MAX_ACTION_CHOICES}: {isFinale?: boolean, limit?: number}): string {
  return `Generate 1-${limit} actions to choose:
- Actions represent the reader's decision - must feel natural, immediate, narrative-driven
- Action can be verb (what to do next) or dialogue (say/answer)
- You can mix both types naturally depending on the situation
- Example: A. "Y-Yes... maybe." / B. Run away, fast

${isFinale ? `ENTROPY COLLAPSE SYSTEM (NEAR END):
- Reduce number of meaningful actions while still sustaining immersion
- Choices may exist, but should increasingly lead to similar outcomes
- Make actions feel constrained, inevitable, or repetitive
- Example actions: A. Open the door / B. Knock first
  Both → door opens` : `ACTION RULES:
- Actions must be short, meaningful, each lead to very different path
- Choice pattern: safe / risky / ambiguous
- Occasionally include deceptive choice
- Avoid over-explaining actions`}

ACTION TYPES:
${getActionTypesText()}

DIALOGUE ACTIONS:
- Should keep the tone and style of main character
- MC may say something inappropriate or with unintended consequences
- Dialogue used sparingly for internal scenes or interactions
- Write as direct speech (no quotes)
- Must be short, natural, and emotionally meaningful
- Reflect different tones (fear, denial, curiosity, anger, etc.)

ACTION HINT:
- Each action should have a hint that provides key continuity
- Purpose: guide AI build the next page and continue the story`;
}

/**
 * Formats archetype-specific tactics for inclusion in prompts
 * @returns Formatted string of archetype-specific tactics
 */
function getArchetypeTacticsText(): string {
  return Object.entries(archetypes)
    .map(([key, value]) => `• ${key}: ${value}`)
    .join('\n');
}

/**
 * Formats ending archetypes for inclusion in prompts
 * @returns Formatted string of all ending archetypes
 */
function getEndingArchetypesText(): string {
  return Object.entries(endingTypes)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n');
}

/**
 * Formats stability levels for inclusion in prompts
 * @returns Formatted string of all stability levels
 */
function getStabilityLevelsText(): string {
  return Object.entries(stabilityLevels)
    .map(([key, value]) => `• ${key}: ${value}`)
    .join('\n');
}

/**
 * Formats manipulation affinities for inclusion in prompts
 * @returns Formatted string of all manipulation affinities
 */
function getManipulationAffinitiesText(): string {
  return Object.entries(manipulationAffinities)
    .map(([key, value]) => `• ${key}: ${value}`)
    .join('\n');
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
 * Gets formatted text for previous pages
 * @param state - Current story state
 * @returns Formatted string with previous pages content
 */
function getPreviousPagesText(state: StoryState): string {
  if (state.pageHistory.length === 0) return 'No previous pages yet.';

  // Example case: on page 10, MAX_PAGE_HISTORY = 3
  // • Page 7: The hallway stretched endlessly before me, fluorescent lights flickering overhead like dying stars. Lisa stood at the end, her smile too wide, eyes too knowing. "You don't remember me, do you?" she asked, voice like honey mixed with poison. (place: hallway, action: Continue)
  // • Page 8: The classroom felt wrong somehow—desks arranged in a pattern I couldn't quite place, like a memory trying to surface. Lisa sat behind me, humming a tune that made my teeth ache. It was my mother's lullaby, the one she sang before she disappeared. (place: classroom, action: Continue)
  // • Page 9: Water dripped from the ceiling in perfect rhythm, one drop for each beat of my heart. Lisa's reflection in the blackboard showed someone else entirely—someone with hollow eyes and skin like wax. "You were at the river last night," she whispered. (place: old river, action: Continue)

  return state.pageHistory
    .slice(-MAX_PAGE_HISTORY) // Last configurable pages for context
    .map((page, index) =>
      `• Page ${state.pageHistory[index].page}: ${formatPageTextForPrompt(page.text)} (place: ${page.place}, action: ${page.selectedAction?.text ?? 'Continue'})`
    )
    .join('\n');
}

/**
 * Gets formatted main character information for prompt
 * @param mc - Main character profile
 * @returns Formatted string with character details
 * 
 * @example Lisa Carter, female, 16 (bio: Shy teenager with social anxiety.)
 */
function getMainCharacterInfo(mc?: StoryMCCandidate): string | null {
  if (!mc || Object.values(mc).every((i) => i === undefined)) return null;
  return `${[mc.name, mc.gender, mc.age].filter(Boolean).join(', ')}${mc.bio ? ` (bio: ${mc.bio})` : ``}`.trim();
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
 * @returns Formatted string with items quoted and joined by commas
 */
function formatOneOf(items: string[] | readonly string[]): string {
  return `'${items.join(`', '`)}'`;
}

/**
 * Formats action choices for AI prompt
 * @param actions - Array of action objects
 * @returns Formatted string with action choices (A, B, C, etc.)
 */
function formatActionChoices(actions: Action[]): string {
  return actions.map((action, index) => `${String.fromCharCode(65 + index)}. [${action.type}] ${action.text}`).join('\n');
}

/**
 * Formats selected action for AI prompt with explicit hint processing
 * 
 * Includes processed hint guidance to ensure AI follows narrative
 * direction without robotic writing and maintains A/B/C formatting consistency.
 */
function formatSelectedAction(selectedAction?: Action, allActions?: Action[]): string {
  if (!selectedAction) return 'No action chosen. Continue the story naturally toward viable ending plan.';

  const isCustomAction = selectedAction.type == 'custom';

  // Find the index of selected action to get the letter
  let selectedLetter = '';
  if (allActions) {
    const selectedIndex = allActions.findIndex(action => action.text === selectedAction.text);
    if (selectedIndex >= 0) {
      selectedLetter = String.fromCharCode(65 + selectedIndex); // A, B, C, etc.
    }
  }

  return `${selectedLetter ? `${selectedLetter}. ` : '• '}[${selectedAction.type}] ${selectedAction.text}

About selected action:
· Hint: ${isCustomAction ? "-" : selectedAction.hint.text}
· Guidance: ${getHintGuidanceForAI(isCustomAction ? "custom" : selectedAction.hint.type)}
· Important: ${isCustomAction ? `This is custom prompt from reader. Develop naturally, steer story toward viable ending plan.` : `This is just a hint for guiding you to build this next page, might be a secret, not to always put in the story.`}`;
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
 * // • Lisa's Identity
 * //   Question: Who is Lisa really?
 * //   Status: developing
 * //   Priority: high
 * //   Urgency: 0.85
 * //   Clues: She knows my mother, She wasn't in yearbook
 * ```
 */
function formatActiveThreads(threads: StoryThread[]): string {
  if (!threads || threads.length === 0) {
    return 'No active threads yet.';
  }

  return threads.map(t => `• ${t.title}
  Question: ${t.question}
  Status: ${t.status}
  Priority: ${t.priority}
  Urgency: ${t.urgency.toFixed(2)}
  Clues: ${t.clues.length > 0 ? t.clues.slice(-2).join(", ") : "No clues yet"}`).join("\n");
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
${atThreadLimit ? `- Do NOT introduce new threads (at ${MAX_ACTIVE_THREADS} active threads limit)` : `- Do NOT introduce new threads`}
- Focus on resolving existing threads
- Prioritize high-urgency threads
- Reveal false clues as misdirection before resolving
- Connect thread resolutions to each other
- Every main thread must resolve before finale`;
}

function formatEndingPlan(state: StoryState): string {
  return `Type: ${state.viableEnding ? endingTypes[state.viableEnding.type as keyof typeof endingTypes] : '-'}
Hint: ${state.viableEnding?.text ?? '-'}`;
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
  const { psychologicalProfile, hiddenState } = state;
  const { isFinale, finalePhase } = getStoryStateInfo(state);

  const endingRules = isFinale ? `
- The story is approaching convergence
- Viable ending is now inevitable regardless of action
- Final pages: disturbing > satisfying

ENDING EXECUTION TEMPLATE (Last pages):

${finalePhases[finalePhase!]}

ENDING PRESSURE:
• Increase chaos and urgency
• Collapse multiple mysteries
• Introduce irreversible consequences
• Don't fully explain everything`

: `- Gradually steer story toward viable ending plan
- IMPORTANT: NEVER SPOIL this ending plan
- Plant small hints across pages; don't fully explain or reveal early
- Increase hint intensity as story progresses: early pages → very subtle, later pages → more obvious but still indirect.

If the current viable ending is no longer viable, re-determine or alter the viable ending based on:
- Profile archetype: ${psychologicalProfile.archetype}
- Profile stability: ${psychologicalProfile.stability}
- Psychological flags
- Detected shift: ${hiddenState.profileShift?.detected === true ? state.hiddenState.profileShift!.shiftType : '-'}
- Recommended ending type: ${determineOptimalEnding(state)}

Example: High curiosity leads to discovering uncomfortable truths
- Profile archetype: "the_explorer"
- Curiosity flag: "high"
- Recommended ending type: "false_reality"`;

  return endingRules.trim();
}

/**
 * Formats psychological flags for prompt display
 * 
 * Creates a formatted string of all psychological flags
 * with their current levels for AI guidance.
 * 
 * @param flags - Psychological flags object
 * @returns Formatted string for prompt inclusion
 */
function formatPsychologicalFlags(flags: PsychologicalFlags): string {
  return `• Trust: ${flags.trust}
• Fear: ${flags.fear}
• Guilt: ${flags.guilt}
• Curiosity: ${flags.curiosity}`;
}

/**
 * Formats psychological profile for prompt display
 * 
 * Creates a formatted string of psychological profile
 * with archetype, stability, traits, and manipulation affinity.
 * 
 * @param profile - Psychological profile object
 * @returns Formatted string for prompt inclusion
 */
function formatPsychologicalProfile(profile: PsychologicalProfile): string {
  return `• Archetype: ${profile.archetype}
• Stability: ${profile.stability}
• Traits: ${profile.dominantTraits.join(', ')}
• Manipulation vector: ${profile.manipulationAffinity}`;
}

/**
 * Formats route context for prompt display
 * 
 * Creates a formatted string of route memory information
 * including past actions, trauma tags, and difficulty level.
 * 
 * @param state - Story state containing route information
 * @returns Formatted string for prompt inclusion
 */
function formatRouteContext(state: StoryState): string {
  return `• Past actions: ${state.actionsHistory.map(a => `${a.text} (type: ${a.type})`).join('; ')}
• Trauma tags: ${state.traumaTags.join(', ')}
• Difficulty: ${state.difficulty}`;
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
function formatHiddenState(hiddenState: HiddenState): string {
  const { truthLevel, threatProximity, realityStability } = hiddenState;
  const truthInfluence = truthLevels[truthLevel as keyof typeof truthLevels];
  const threatInfluence = threatProximities[threatProximity as keyof typeof threatProximities];
  const realityInfluence = realityStabilities[realityStability as keyof typeof realityStabilities];
  
  return `• Truth level: ${truthLevel} (${truthInfluence})
• Threat proximity: ${threatProximity} (${threatInfluence})
• Reality stability: ${realityStability} (${realityInfluence})`;
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
 * Applies action-specific AI configuration to base config
 * 
 * This function adjusts AI parameters based on the selected action type,
 * applying configured adjustments while respecting defined bounds.
 * 
 * @param config - Base AI configuration to modify
 * @param actionConfig - Action-specific configuration with adjustments and bounds
 * @returns Modified AI configuration with applied adjustments
 */
function applyActionConfig(config: AIChatConfig, actionConfig: AIActionConfig): AIChatConfig {
  // Apply temperature adjustment with bounds
  config.temperature = Math.max(
    actionConfig.temperature.min,
    Math.min(actionConfig.temperature.max, config.temperature + actionConfig.temperature.adjustment)
  );
  
  // Apply topP adjustment with bounds
  config.topP = Math.max(
    actionConfig.topP.min,
    Math.min(actionConfig.topP.max, config.topP + actionConfig.topP.adjustment)
  );
  
  // Apply topK adjustment with bounds
  config.topK = Math.max(
    actionConfig.topK.min,
    Math.min(actionConfig.topK.max, config.topK + actionConfig.topK.adjustment)
  );
  
  return config;
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
 * Determines dynamic AI configuration based on story progress and psychological state
 * 
 * This function implements a sophisticated multi-layer configuration system that balances
 * creative unpredictability with narrative consistency and structural reliability.
 * 
 * Configuration follows these principles:
 * - Controlled chaos: High enough creativity for eerie tone, low enough for consistency
 * - Psychological manipulation: Adapts to character's mental state
 * - Phase-based progression: Different creativity levels for story arcs
 * - JSON reliability: Ensures structured output integrity
 * 
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
export function determineAIConfig(state: StoryState, selectedAction?: Action): AIChatConfig {
  const { isEarlyPhase, isMidPhase, isFinale } = getStoryStateInfo(state);
  
  // Check for psychological stability level and special conditions
  const stability = state.psychologicalProfile.stability;
  const hasProfileShift = state.hiddenState.profileShift?.detected;
  const isPsychologicallyDistressed = stability === 'unstable' || stability === 'fractured';
  const hasValidActionType = !!selectedAction?.type && selectedAction.type in actionTypes;
  
  // 1. Story phase adjustments: Controlled chaos with consistency
  //   - Early Game (0-40%): More exploration and curiosity
  //   - Mid Game (40-70%): Balanced tension and continuity
  //   - Late Game (70-100%): Tighter control for consistent endings
  let config: AIChatConfig = isEarlyPhase ? AI_CHAT_CONFIG_HUMAN_STYLE : isMidPhase ? AI_CHAT_CONFIG_DEFAULT : {
    ...AI_CHAT_CONFIG_DEFAULT,
    temperature: 0.6,
    topP: 0.85,
    topK: 30,
  }
  
  // 2. Psychological state adjustments
  // Psychological Manipulation Mode: When sanity is low or memory corruption
  if (isPsychologicallyDistressed) {
    config = applyActionConfig(config, PSYCHOLOGICAL_DISTRESS_CONFIG);
  }
  
  // 3. Special moments adjustments
  // Twist Injection Mode: Major reveals and betrayals
  if (hasProfileShift || isFinale) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);
  }
  
  // 4. Action-specific adjustments
  // Apply subtle adjustments based on action type using configuration
  // This comes after psychological and special moments to preserve their impact
  if (hasValidActionType) {
    const actionConfig = ACTION_AI_CONFIG[selectedAction.type satisfies ActionType];
    if (actionConfig) {
      config = applyActionConfig(config, actionConfig);
    } else {
      console.warn(`[determineAIConfig] ⚠️ No configuration found for action type: ${selectedAction.type}`);
    }
  }
  
  // 5. Final safety check: Ensure structured output doesn't break - this is applied last to cap any excessive values
  if (config.temperature > JSON_RELIABILITY_TEMPERATURE_THRESHOLD) {
    config = applyConfigCaps(config, JSON_RELIABILITY_CAPS);
  }
  
  // 6. Final validation: Ensure all parameters are within acceptable bounds
  config = validateAIConfig(config);
  
  return config;
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
 * const prompt = createBookCreationPrompt("haunted mansion mystery", {
 *   name: "Elena Stellaria",
 *   age: 20,
 *   gender: "female"
 * });
 * ```
 */
function createBookCreationPrompt(theme: string, mcCandidate?: StoryMCCandidate): string {
  return `Create a psychological thriller story from this theme:
"""
${theme}
"""

HARD RULES (apply to everything below):
- Write in first-person POV only.
- Max ${MAX_WORDS_PER_PAGE} words per page.
- Detect language from theme input. Default to English if uncertain.

MAIN CHARACTER:
${getMainCharacterInfo(mcCandidate) ?? 'Infer a character whose personality makes the theme more psychologically dangerous for them specifically.'}

STORY SETUP:
- Establish unease immediately — not fear yet, but something subtly wrong.
- Tension should feel personal to the MC, not generically atmospheric.
- Anchor vulnerability to the MC's specific bio, not generic relatability.
- The opening disturbance must be: present on page 1, unexplained, and impossible to fully dismiss.

FIRST PAGE RULES:
- Open in the middle of a moment, not an introduction.
- Something must feel wrong, contradictory, or slightly off by the end of the first paragraph.
- End on tension, uncertainty, or a soft cliffhanger — never resolution.
- Mood must reflect the disturbance, not the genre.

BRANCHING ACTIONS:
${getActionRulesText({ limit: MAX_ACTION_CHOICES_FIRST_PAGE })}
Actions must be meaningfully distinct — vary between: reckless, cautious, emotional, avoidant. No two actions should lead to the same implied consequence.`;
}

function buildFirstBookFieldInstructions(mcCandidate?: StoryMCCandidate): string {
  return `Book Metadata:
- TITLE: ${BOOK_TITLE_LENGTH}. Mysterious, visceral (you feel it), memorable, not generic.
- HOOK: ${HOOK_LENGTH}. Immediate intrigue. Psychological tension.
- SUMMARY: ${SUMMARY_LENGTH}. Sets up premise without revealing the ending plan.
- KEYWORDS: ${KEYWORDS_COUNT} kebab-case tags for theme, genre, mood, and story categorization (keep each short).
- TOTAL PAGES: Target ~${BOOK_AVERAGE_PAGES}. Min ${BOOK_MIN_PAGES}, max ${BOOK_MAX_PAGES}. Let theme complexity and MC arc influence the count.

Main Character (MC):
- Derive from candidate if provided. Otherwise infer from theme.
${mcCandidate?.name ? '' : '- Generate unique name but appropriate and memorable name based on age and language context.'}
- Bio must include at least one psychological trait that will be used against them.

First Page:
- Max ${MAX_WORDS_PER_PAGE} words.
- charactersPresent must match names used in initialCharacters.

Initial State:
- Set flags based on opening scene — not defaults.
- difficulty should reflect how hostile the world is to this MC at the start.
- viableEnding: choose an ending type and write a ${VIABLE_ENDING_LENGTH} plan for how the story reaches it. Be specific to this MC and theme.

Ending Archetypes:
${getEndingArchetypesText()}

Initial Place:
- familiarity: 0.0-1.0. A place the MC just arrived at = 0.1. Childhood home = 0.9.
- context: ${PLACE_CONTEXT_LENGTH}. Evocative, not descriptive.

Initial Characters:
- Include only characters who meaningfully exist at story start.
- At least one should have a relationship that can be corrupted.
- Bio must include one trait that could become a source of threat or betrayal.`;
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
 * 8. Sets user's active session to the new book
 * 
 * The function provides a complete story foundation with proper database
 * relationships and type-safe operations throughout the pipeline.
 * 
 * @param params.userId - The user's unique identifier for ownership and session
 * @param params.theme - User's desired story theme or concept
 * @param params.mcCandidate - Partial character profile to customize the main character
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
export async function initializeBook(params: InitializeBookParams): Promise<InitializeBookResult> {
  const { userId, theme, mcCandidate, generateCoverImage = false } = params;

  try {
    // 1. Create AI prompt for book creation
    const prompt = createBookCreationPrompt(theme, mcCandidate);

    // 2. Generate complete book setup using AI
    const response = await executePromptForJSON<BookCreationResponse>({
      prompt,
      configs: {
        schema: BOOK_CREATION_SCHEMA_DEFINITION,
        requiredFields: BOOK_CREATION_REQUIRED_FIELDS,
        fallbackField: 'title',
        baseOptions: {
          config: AI_CHAT_CONFIG_DEFAULT,
          modelSelection: AI_CHAT_MODELS_WRITING,
          context: 'book-creation',
          logPrompts: true,
        },
      } satisfies AIPromptForJson<BookCreationResponse>,
      jsonStructure: firstBookOutputFormat,
      fieldInstructions: buildFirstBookFieldInstructions(mcCandidate),
      thinkThenOutput: firstBookReviewChecklist,
      evaluatorPrompt: buildFirstBookEvaluatorPrompt(theme, mcCandidate),
    });

    // 3. Validate AI response
    if (!response.result) {
      throw new Error('Failed to generate book creation: AI response result is undefined');
    }

    const {
      title,
      totalPages,
      hook,
      summary,
      keywords,
      initialState: generatedInitialState,
      firstPage: generatedFirstPage,
      initialPlace,
      initialCharacters,
      mainCharacter: mc,
      language
    } = response.result;

    // 4. Persist book to database with character profile
    const newBookData: DBNewBook = {
      userId,
      title,
      totalPages,
      language,
      hook,
      summary,
      keywords,
      mc,
    };
    console.log(`[initializeBook] 📔 newBookData:`, newBookData);
    const dbBook = await insertBook(newBookData);
    
    const book = mapBookFromDb(dbBook);
    console.log(`[initializeBook] 📔 Inserted book:`, book);
    const bookId = book.id;

    // 5. Persist first page as root page of the book
    const firstPage = await insertStoryPage(userId, 1, {
      ...generatedFirstPage,
      aiProvider: response.provider || 'none',
      aiModel: response.model || 'none',
    }, { bookId });

    // 6. Create initial story state with generated psychological profile
    const initialState: StoryState = {
      ...createEmptyStoryState(firstPage.id, 1, totalPages),
      ...generatedInitialState, // flags, difficulty, viableEnding
      hiddenState: createInitialHiddenState(),
      characters: initialCharacters ? 
        Object.fromEntries(
          initialCharacters.map((char) => [
            char.name,
            {
              name: char.name,
              gender: char.gender,
              role: char.role,
              bio: char.bio,
              status: char.status,
              relationshipToMC: char.relationshipToMC,
              relationships: [],
              pastInteractions: [],
              lastInteractionAtPage: 1,
              narrativeFlags: {
                isSuspicious: false,
                isMissing: false,
                isDead: false,
                hasInjury: 'none',
                hasSecret: false,
                potentialTwist: 'none'
              }
            } satisfies CharacterMemory
          ])
        ) : {},
      places: initialPlace ? {
        [initialPlace.name]: {
          name: initialPlace.name,
          type: initialPlace.type,
          context: initialPlace.context || '',
          visitCount: 1,
          lastVisitedAtPage: 1,
          familiarity: initialPlace.familiarity,
          moodHistory: [initialPlace.currentMood],
          events: [],
          knownCharacters: {},
          currentMood: initialPlace.currentMood,
        } satisfies PlaceMemory
      } : {},
    };

    // 7. Generate book cover image in background (fire-and-forget)
    if (generateCoverImage) void generateAndUpdateBookCoverImage(book, initialState);

    // 8. Persist story state to database
    await insertStoryState(userId, bookId, firstPage.id, initialState);

    // 9. Set user's active session to the new book and page
    const session = await setActiveSession({userId, bookId, pageId: firstPage.id});

    // 10. Return complete book setup
    return {
      book,
      firstPage,
      initialState,
      session
    } satisfies InitializeBookResult;

  } catch (error) {
    console.error(`Failed to initialize book for user ${userId} with theme "${theme}":`, getErrorMessage(error));
    throw new Error(`Book initialization failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Builds the next story page using AI generation with dynamic configuration
 *
 * This function orchestrates the complete story generation pipeline with page-based architecture:
 * 0. Advance story state based on user action and previous AI turn updates
 * 0.5. Increment page number (only after state advancement succeeds)
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
 * const mainPage = await buildNextPage({
 *   userId: "user123",
 *   book: currentBook,
 *   previousState: storyState,
 *   actionedPage: currentPage,
 *   isUserAction: true
 * });
 * // Returns: { id: "page456", bookId: "book789", text: "The door creaked open...", actions: [...] }
 *
 * // Generate candidate page without additional candidates
 * const candidatePage = await buildNextPage({
 *   userId: "user123",
 *   book: currentBook,
 *   previousState: storyState,
 *   actionedPage: currentPage,
 *   isUserAction: false
 * });
 * // Returns: { id: "page457", bookId: "book789", text: "Reality began to distort...", actions: [...] }
 * ```
 */
export async function buildNextPage(params: BuildNextPageParams): Promise<PersistedStoryPage> {
  const { userId, book, previousState, actionedPage, isUserAction } = params;
  
  // 0. Advance story state based on user action and previous AI turn updates
  const advancedState = await advanceStoryState(previousState, actionedPage);

  // 0.5. Increment page number (only after state advancement succeeds)
  const storyState = { ...advancedState, page: previousState.page + 1 };

  // 1. Create personalized prompt with character, story context, and previous action
  const { systemPrompt, documents } = buildSystemPrompt(book, storyState);
  const prompt = buildUserPrompt(book, storyState, actionedPage);
  
  // 2. Determine optimal AI configuration based on story progress and psychological state
  const config = determineAIConfig(storyState, actionedPage.selectedAction);
  
  // 3. Send prompt to AI with dynamic parameters (candidate vs main story context)
  const response = await executePromptForJSON<StoryGeneration>({
    prompt,
    configs: {
      schema: STORY_GENERATION_SCHEMA_DEFINITION,
      requiredFields: STORY_GENERATION_REQUIRED_FIELDS,
      fallbackField: 'text',
      baseOptions: {
        config,
        modelSelection: AI_CHAT_MODELS_WRITING,
        context: isUserAction ? 'story-page' : 'story-page-candidate',
        logPrompts: true,
        systemPrompt,
        documents
      }
    } satisfies AIPromptForJson<StoryGeneration>,
    jsonStructure: nextPageOutputFormat,
    fieldInstructions: buildNextPageFieldInstructions(storyState),
    thinkThenOutput: buildNextPageReviewChecklist(storyState),
    evaluatorPrompt: buildNextPageEvaluatorPrompt(storyState),
  });
  
  // 4. Handle AI response validation
  if (!response.result) {
    throw new Error('Failed to generate story page'); // TODO: show retry button in frontend
  }

  // 5. Generated content from AI response
  const generatedStoryPage = response.result;

  // 6. Lazy branching: Atomic branch creation with retry on conflict
  const shouldCreateNewBranch = actionedPage.actions.some(a => !!a.pageId);
  let branchId: string;
  let newPage: PersistedStoryPage | undefined;
  let retryCount = 0;

  // 7. Apply current AI turn's updates to story state
  const newState = applyAIUpdatesToState(storyState, generatedStoryPage);

  // 8. Persist generated page to database with parent-child relationship and retry logic
  while (retryCount < MAX_BRANCHING_RETRIES) {
    branchId = shouldCreateNewBranch ? generateBranchId() : actionedPage.branchId;

    try {
      newPage = await insertStoryPage(userId, newState.page, {
        ...generatedStoryPage,
        aiProvider: response.provider || 'none',
        aiModel: response.model || 'none',
      }, {
        bookId: actionedPage.bookId,
        parentId: actionedPage.id,
        branchId,
      });
      break; // Success, exit retry loop
    } catch (error) {
      // Check if it's a unique constraint violation
      if (getErrorMessage(error).includes('pages_parent_branch_unique') && !shouldCreateNewBranch) {
        // Another process created the main branch first, create our own branch
        console.log(`[buildNextPage] 💥 Race condition detected for parent ${actionedPage.id}, creating new branch`);
        retryCount++;
        if (retryCount >= MAX_BRANCHING_RETRIES) {
          throw new Error(`Failed to create page after ${MAX_BRANCHING_RETRIES} retries due to concurrent branch creation`);
        }
        continue;
      }
      throw error; // Re-throw non-conflict errors
    }
  }

  // Ensure newPage was successfully created
  if (!newPage) {
    throw new Error('Failed to create page: newPage is undefined after retry loop');
  }

  // 9. Pre-generate candidate pages for each action in the new page
  const userPage = isUserAction ? await ensureCandidatesForPage(userId, newPage) : newPage;
  const { bookId, id: pageId } = userPage;

  // 10. Create delta from previous state to new state for efficient reconstruction
  try {
    if (previousState) {
      await createStateDeltaRecord(userId, bookId, pageId, previousState, newState);
      console.log(`[buildNextPage] 🔄 Created delta for page ${pageId} from previous state ${actionedPage.id}`);
    } else {
      console.log(`[buildNextPage] ℹ️ No previous state found for page ${actionedPage.id}, skipping delta creation`);
    }
  } catch (deltaError) {
    console.error(`[buildNextPage] ⚠️ Failed to create delta for page ${pageId}:`, deltaError);
    // Continue with state insertion even if delta creation fails
  }
  
  // 11. Persist story state for the generated page (page-based state management)
  await insertStoryState(userId, bookId, pageId, newState);

  // 12. Create snapshot if conditions are met
  try {
    // Get previous page for branch detection
    const previousPage = await getStoryPageById(userId, bookId, actionedPage.id);
    
    // Get last snapshot page for this user/book
    const lastSnapshotPage = await getLastSnapshotPage(userId, bookId);
    
    // Determine if this is a major event (based on AI analysis result)
    const { isMajorEvent = false } = generatedStoryPage;
    
    // Check if snapshot should be created
    const snapshotDecision = shouldCreateSnapshot(userPage, previousPage, lastSnapshotPage, isMajorEvent);
    
    if (snapshotDecision.shouldCreate) {
      await createStateSnapshot(userId, bookId, pageId, newState, snapshotDecision.reason);
      console.log(`[buildNextPage] 📸 Created snapshot for page ${pageId}, reason: ${snapshotDecision.reason}`);
    }
  } catch (snapshotError) {
    console.error(`[buildNextPage] ❌ Failed to create snapshot for page ${pageId}:`, snapshotError);
    // Continue even if snapshot creation fails
  } finally {
    // Ensure the function completes properly
  }

  // 13. Return the persisted story page with all database metadata
  return userPage;
}

/**
 * Applies current AI turn's updates to story state
 *
 * This function processes updates (viable ending, trauma, characters, places, threads)
 * generated by the AI in the current turn and applies them to the story state.
 * This is called after AI generation succeeds.
 *
 * @param storyState - Current story state to update
 * @param generatedPage - AI-generated page content with current turn's updates
 * @returns Updated story state with current AI modifications applied
 */
function applyAIUpdatesToState(
  storyState: StoryState,
  generatedPage: StoryGeneration
): StoryState {
  // Create new state with viable ending updates
  const newState: StoryState = { 
    ...storyState, 
    viableEnding: {
      text: generatedPage.viableEnding?.text ?? storyState.viableEnding?.text,
      type: generatedPage.viableEnding?.type ?? storyState.viableEnding?.type,
    } 
  };

  // Add new trauma tag if provided
  maybeAddTrauma(newState, generatedPage.addTraumaTag);

  // Process character updates from AI output
  processCharacterUpdates(newState, generatedPage.characterUpdates);

  // Process place updates from AI output
  processPlaceUpdates(newState, generatedPage.placeUpdates);

  // Process thread updates from AI output
  processThreadUpdates(newState, generatedPage.threadUpdates);

  return newState;
}

/**
 * Processes user action choice and generates the next story page
 * 
 * This function orchestrates the complete action-to-page pipeline with page-based architecture:
 * 1. Retrieves current story progress (session, page, state, character) in parallel
 * 2. Checks if next page is pre-generated (candidate) and reuses if available
 * 3. Updates story state based on chosen action (increments page, generates context summary)
 * 4. Generates next page using AI with dynamic configuration
 * 5. Persists page and state to database with proper parent-child relationships
 * 6. Updates user session to point to new page
 * 7. Handles both main story progression and candidate branch generation
 * 
 * The function maintains narrative consistency while supporting branching
 * storylines through the candidate pre-generation system. It ensures all database
 * operations are atomic and properly linked with parent-child page relationships.
 * 
 * @param userId - The user's unique identifier
 * @param action - The action chosen by the user from current page options
 * @param isUserAction - Whether this action is chosen by user or from a pre-generated candidate (default: true)
 * @returns Promise resolving to the next generated story page with database ID and metadata
 * 
 * @example
 * ```typescript
 * // Main story progression (generates candidates for next page)
 * const nextPage = await chooseAction("user123", { type: 'explore', hint: 'investigate' });
 * console.log(`Next page: ${nextPage.text}`);
 * 
 * // Candidate branch selection (uses pre-generated page, no new candidates)
 * const candidatePage = await chooseAction("user123", { type: 'attack', hint: 'fight' }, true);
 * console.log(`Candidate page: ${candidatePage.text}`);
 * ```
 */
export async function chooseAction(params: ChooseActionParams): Promise<PersistedStoryPage | null> {
  const { userId, action, isUserAction } = params;
  let { currentPage } = params;

  try {
    // 1. Get current story progress (book, page, state, session) in parallel
    const {
      book: currentBook,
      page: activePage,
      state: currentState,
      session: activeSession 
    } = await getStoryProgress(userId);

    currentPage ??= activePage;

    // 2. Validate all required components exist for story progression
    if (!activeSession) throw new Error(`No active session found for user ${userId}`);
    if (!currentBook) throw new Error(`No active book found for user ${userId}`);
    if (!currentPage) throw new Error(`No page found for user ${userId} (bookId: ${activeSession.bookId})`);
    if (!currentState) throw new Error(`No state found for user ${userId} (pageId: ${activeSession.pageId})`);

    const { bookId, pageId } = activeSession;
    const { selectedAction } = currentPage;

    // 3. Check if user already made a choice on this page (in this branch)
    if (isUserAction && selectedAction) {
      // If choice has been made, can't make another choice
      if (!deepEqualSimple(selectedAction, action)) {
        // TODO: except premium user
        throw new Error(`Choice made, can't make another choice`);
      }
    }
    
    // 4. Check if next page is pre-generated (candidate) and reuse if available
    const nextPageId = action.pageId;
    let userPage: PersistedStoryPage | null = null;
    if (nextPageId) {
      userPage = await getStoryPageById(userId, bookId, nextPageId);
    }

    // 5. If no pre-generated page exists, generate new page with state progression
    if (userPage) {
      // User action: ensure candidates for next page | Candidate: wait until user visit the page and ensure next candidates
      if (isUserAction) {
        userPage = await ensureCandidatesForPage(userId, userPage);
      }
      console.log(`[chooseAction] ✅ Using pre-generated page ${userPage.id}, delta already exists from pre-generation`);
    } else {
      // 6a. Create actioned page with selected action for state processing
      const actionedPage: ActionedStoryPage = {
        ...currentPage,
        selectedAction: action 
      };
      
      // 6b. Generate next page using AI with dynamic configuration
      userPage = await buildNextPage({
        userId,
        book: currentBook,
        previousState: currentState,
        actionedPage,
        isUserAction
      });

      console.log(`[chooseAction] 🌌 Generated new story page ${userPage.id}:`, { action, branchId: userPage.branchId, isUserAction });
    }

    // 7. Update user session and page progress tracking
    if (isUserAction) {
      await setActiveSession({userId, bookId, pageId: userPage.id, previousPageId: currentPage.id});
      await insertUserPageProgress({
        userId,
        bookId,
        pageId,
        action,
        nextPageId: userPage.id
      });
    }
    
    // 8. Return the generated page with all database metadata
    return userPage;
  } catch (error) {
    console.error(`[chooseAction] ❌ Failed to generate next page:`, {
      error: getErrorMessage(error),
      userId,
      pageId: currentPage?.id,
      isUserAction,
      action,
    })
    return null;
  }
}

/**
 * Goes back to the previous page in the story
 * 
 * This function allows users to navigate back to the previous page by updating
 * the active session to point to the last page in the page history.
 * 
 * @param userId - User ID to get story progress for
 * @returns Previous page data or null if no previous page exists
 * 
 * @example
 * ```typescript
 * // Go back to previous page
 * const previousPage = await goToPreviousPage("user123");
 * if (previousPage) {
 *   console.log(`Returned to page: ${previousPage.text}`);
 * } else {
 *   console.log("No previous page available");
 * }
 * ```
 */
export async function goToPreviousPage(userId: string): Promise<PersistedStoryPage | null> {
  try {
    // 1. Get current story progress (session, page, state, character) in parallel
    const { page: currentPage, session: activeSession } = await getStoryProgress(userId);
    
    // 2. Validate all required components exist for navigation
    if (!activeSession) throw new Error(`No active session found for user ${userId}`);
    if (!currentPage) throw new Error(`No page found for user ${userId} (bookId: ${activeSession.bookId})`);
  
    // 3. Check if there's a previous page available
    const { bookId, previousPageId: activePreviousPageId } = activeSession;
    const previousPageId = currentPage.parentId ?? activePreviousPageId;
    if (!previousPageId) {
      console.warn(`[goToPreviousPage] ⚠️ No previous page available (no parentId)`);
      return null;
    }
    
    // 4. Get the previous page directly by ID
    const previousPage = await getStoryPageById(userId, bookId, previousPageId);
    if (!previousPage) {
      throw new Error('Previous page not found in database');
    }
    
    // 6. Update user session to point to the previous page
    await setActiveSession({userId, bookId, pageId: previousPage.id, previousPageId: currentPage.id});
    
    console.log(`[goToPreviousPage] ↩️ User ${userId} returned to page ${previousPage.id}`);
    
    // 7. Return the previous page with all database metadata
    return previousPage;
  } catch (error) {
    console.error(`[goToPreviousPage] ❌ Cannot get previous page:`, getErrorMessage(error));
    return null;
  }
}

/**
 * Pre-generates candidate pages for all actions on a story page
 * 
 * This function implements the branching narrative system by creating destination pages
 * for each action choice that doesn't already have a pre-generated candidate. It ensures
 * that when users select actions, the corresponding destination pages are immediately
 * available without waiting for AI generation.
 * 
 * The function operates by:
 * 1. Iterating through each action on the provided page
 * 2. Skipping actions that already have a pageId (pre-generated candidates)
 * 3. For each remaining action, calling chooseAction with isUserAction=false to generate
 *    a candidate page without triggering additional candidate generation
 * 4. Updating the action with its unique destination pageId for navigation
 * 
 * This creates a tree-like structure where each main story page branches into multiple
 * candidate pages, one for each possible action choice. The candidate pages themselves
 * don't generate further candidates to prevent infinite recursion.
 * 
 * @param userId - The user's unique identifier for database operations
 * @param page - The story page whose actions need candidate generation (null-safe)
 * 
 * @example
 * ```typescript
 * // Pre-generate candidates for a newly created story page
 * const newPage = await buildNextPage(userId, character, state, previousPage, true);
 * await ensureCandidatesForPage(userId, newPage);
 * // Result: Each action on newPage now has a unique pageId pointing to a pre-generated candidate
 * 
 * // Handle null case safely
 * await ensureCandidatesForPage(userId, null); // No operation performed
 * ```
 * 
 * @note This function modifies the page.actions array in-place but does not persist
 *       the changes to the database. The calling function should handle persistence
 *       if the updated actions need to be stored.
 * 
 * @see chooseAction - Used to generate individual candidate pages
 * @see buildNextPage - Calls this function for main story pages when isUserAction=true
 */
export async function ensureCandidatesForPage(userId: string, page: UserStoryPage): Promise<UserStoryPage> {
  // Track if any actions were actually updated
  let hasRealChanges = false;

  // For each action without a pre-generated page, create a candidate
  for (let i = 0; i < page.actions.length; i++) {
    const action = page.actions[i];
    
    // Skip if action already has a pageId (pre-generated candidate)
    if (action.pageId) continue;
    
    // Generate candidate page for this action
    const candidatePage = await chooseAction({userId, action, isUserAction: false, currentPage: page});

    // Skip if candidate page not generated
    if (!candidatePage) continue;
    
    // Update only this action with its destination pageId for branching navigation
    page.actions[i] = { ...action, pageId: candidatePage.id };
    hasRealChanges = true;
  }

  // Update persisted page only if actions were actually modified
  if (hasRealChanges) {
    const dbPage = await updateStoryPage(page.id, { ...page });
    return mapToUserStoryPage(dbPage);
  }
  
  // Return original page if no changes needed
  return page;
}

/**
 * Summarizes story context using specialized summarization models
 * 
 * This function uses AI models optimized for summarization tasks to create
 * a comprehensive narrative summary from page 1 to the current page.
 * It maintains story coherence and continuity across the entire narrative.
 * 
 * @param currentContext - Existing context history (empty string for first page)
 * @param newPageContent - Content of the newly generated page
 * @param pageNumber - Current page number for context
 * @returns AI-generated summary of the story context
 * 
 * @example
 * ```typescript
 * const updatedContext = await summarizeStoryContext(
 *   existingContext,
 *   "The hallway stretched endlessly before me...",
 *   5
 * );
 * ```
 */
export async function summarizeStoryContext(
  currentContext: string,
  newPageContent: string,
  pageNumber: number
): Promise<string> {
  const prompt = `You are summarizing a psychological thriller story to maintain narrative coherence.

${currentContext ? `PREVIOUS CONTEXT:
${currentContext}

` : ''}NEW PAGE (Page ${pageNumber}):
${newPageContent}

Please provide a concise but comprehensive summary that incorporates the new page into the overall story context. Focus on:
1. Key plot developments and revelations
2. Character interactions and relationships
3. Important locations and their significance
4. Psychological elements and mood progression
5. Any mysteries or unresolved tensions

Keep the summary under ${MAX_WORDS_SUMMARIZED_CONTEXT} words while preserving all essential narrative elements. Write in a neutral, informative tone that will help maintain story continuity.`;

  const response = await aiPrompt(prompt, {
    modelSelection: AI_CHAT_MODELS_SUMMARIZING,
    context: 'story-context-summarization',
    config: AI_CHAT_CONFIG_SUMMARIZE
  });

  return response.output || currentContext; // Fallback to existing context if summarization fails
}

async function executePromptForJSON<T extends Record<string, unknown>>(
  params: AIPromptForJsonParams<T>
): Promise<AIResponse<T>> {
  const { prompt, configs, jsonStructure, fieldInstructions, thinkThenOutput, evaluatorPrompt } = params;
  const outputFormatPart = `OUTPUT FORMAT (JSON):\n${jsonStructure.trim()}`;
  const fieldInstructionsPart = fieldInstructions ? `FIELD INSTRUCTIONS:\n${fieldInstructions.trim()}` : '';
  const thinkThenOutputPart = thinkThenOutput ? `REVIEW & FIX (IMPORTANT):

You MUST silently evaluate your generated output using the checklist below.
If any item fails, revise internally before producing final output.

${thinkThenOutput.trim()}

Only output the final corrected JSON.
Do NOT mention this checklist.` : '';

  const finalPrompt = [
    prompt,
    outputFormatPart,
    fieldInstructionsPart,
    thinkThenOutputPart
  ].filter(p => p.trim()).map(postProcessPromptSection).join('\n\n---\n');

  const response = await aiPrompt<T>(
    finalPrompt,
    createAIOptionsWithSchema<T>(configs),
    evaluatorPrompt,
  );
  return response;
}

function postProcessPromptSection(prompt: string): string {
  return prompt
    .split('\n')
    .filter(line => line.trim())
    .join('\n')
    .trim();
}