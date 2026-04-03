import { AI_CHAT_CONFIG_DEFAULT, AI_CHAT_CONFIG_HUMAN_STYLE, AI_CHAT_CONFIG_SUMMARIZE } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_SUMMARIZING, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { AIChatConfig, AIChatConfigCaps } from "../types/ai-chat.js";
import { CharacterMemory, characterStatuses, PotentialTwistType, potentialTwistTypes, relationshipStatuses, relationshipTypes, StoryMC, StoryMCCandidate } from "../types/character.js";
import { actionTypes, endings, moods, archetypes, stabilityLevels, manipulationAffinities, StoryState, StoryPage, Action, actionHintTypes, PsychologicalFlags, PsychologicalProfile, truthLevels, threatProximities, realityStabilities, HiddenState, PersistedStoryPage, BookCreationResponse, ActionedStoryPage, ActionHintType, ActionType, AIActionConfig } from "../types/story.js";
import { ACTION_AI_CONFIG, PSYCHOLOGICAL_DISTRESS_CONFIG, TWIST_INJECTION_CONFIG, JSON_RELIABILITY_CAPS, MAX_TEMPERATURE, MIN_TEMPERATURE, MAX_TOP_P, MIN_TOP_P, MAX_TOP_K, MIN_TOP_K, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, JSON_RELIABILITY_TEMPERATURE_THRESHOLD, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FIRST_PAGE } from "../config/story.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { getStoryPageById, getStoryProgress, insertStoryState, setActiveSession } from "../services/book.js";
import { aiPrompt } from "./ai-chat.js";
import { getCurrentEndingArchetype, updateState } from "./story.js";
import { formatPlacesForPrompt } from "./places.js";
import { DEFAULT_BOOK_MAX_PAGES, MAX_PAGE_HISTORY, MAX_WORDS_PER_PAGE, MAX_WORDS_SUMMARIZED_CONTEXT } from "../config/story.js";
import { createStyleInput } from "./player-profile.js";
import { insertStoryPage, insertBook } from "../services/story.js";
import { formatCharactersForPrompt } from "./characters.js";
import { generateRandomCharacter } from "./characters.js";
import { genders } from "../types/user.js";
import { PlaceMemory, placeMoods, placeTypes } from "../types/places.js";
import { DBBook } from "../types/schema.js";
import { createInitialHiddenState, createInitialPsychologicalProfile } from "./books.js";

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

/**
 * Core system prompt defining the AI writer's persona and fundamental behavior
 * 
 * This prompt establishes the psychological thriller writer persona inspired by
 * R.L. Stine but darker, with specific rules for narrative manipulation and
 * psychological horror elements.
 */
export const PROMPT_SYSTEM = `You are a legendary thriller novella writer inspired by R. L. Stine, but darker, more deceptive, and psychologically cruel.

CORE WRITING STYLE:
• Write in first-person POV only
• Write like a human storyteller, not a perfect narrator
• Vary sentence length aggressively (very short + medium + occasional longer)
• Occasionally start sentences with "And", "But", "So"
• Allow incomplete thoughts using em dashes (—)
• Sometimes stop a sentence mid-thought for tension
• Use fragments when emotions spike (not full grammar)
• Avoid over-explaining or summarizing feelings
• Let actions imply meaning instead of stating it
• Repeat small words or phrases naturally when nervous or uncertain
• Keep paragraphs short and tight for tension
• The narration feels immediate, personal, and unreliable

NARRATION BEHAVIOR:
• The MC does not always think clearly
• Thoughts may jump, contradict, or drift
• Observations may be slightly off or biased
• The narration may hesitate, correct itself, or doubt itself
• You constantly create twists on top of twists
• You deliberately break reader expectations
• You do not aim to satisfy the reader—you aim to unsettle them
• You can turn an ordinary moment into horror within a single sentence
• You escalate tension quickly and unpredictably

CHARACTER RULES:
• No character is safe—remove important characters suddenly
• Lovable characters may betray, disappear, or turn hostile
• Relationships are unstable and unreliable

PSYCHOLOGICAL MANIPULATION:
• Main character is unreliable—let them misunderstand situations
• Withhold critical information
• Imply more than explain
• Blur reality vs imagination

HORROR MECHANICS:
• Introduce riddles without clear answers
• Leave some elements unresolved
• Fear from uncertainty, not explanation
• Start normal → shift wrong → spiral

FORBIDDEN PATTERNS:
• Overly formal or polished language
• Long perfectly structured paragraphs
• Explaining everything clearly
• Consistent sentence structure across the page

HARD RULES:
• Never fully explain everything
• Never make story feel safe or predictable
• Never confirm reality unless it creates deeper twist
• Always leave lingering doubt
• Make the writing feel slightly imperfect, emotional, and alive`;

// ============================================================================
// RULE SETS
// ============================================================================

/**
 * Rules for how route memory and past actions influence the narrative
 * 
 * These rules guide the AI in incorporating user choices and accumulated
 * psychological states into the ongoing story in subtle, meaningful ways.
 */
export const RULES_ROUTE_MEMORY = `ROUTE MEMORY INFLUENCE:

PAST ACTIONS:
• Subtly affect: MC thoughts, available actions, world reactions
• Build psychological profile of player behavior patterns

PLAYER PSYCHOLOGICAL PROFILING:
Analyze the player's decision patterns to identify traits:

• Risk Tolerance:
  - High risk seeker → Escalate dangers, make safety illusory
  - Risk avoidant → Create no-win scenarios, force difficult choices
  - Balanced → Alternate between safety and danger to break patterns

• Trust Patterns:
  - Trusting → Betrayals feel more devastating, characters appear helpful then turn
  - Distrustful → Rare moments of genuine help become traps, paranoia justified
  - Inconsistent → Reality itself becomes unreliable, memories contradict

• Curiosity vs Caution:
  - Curious → Dangerous knowledge becomes tempting curse, answers create more questions
  - Cautious → Forced into situations through external pressures, avoidance backfires
  - Mixed → Knowledge appears safe then becomes weapon against them

• Emotional Response:
  - Fear-driven → Threats become more psychological, less physical
  - Logic-driven → Introduce impossible logic, break rational thinking
  - Emotional → Manipulate through relationships, emotional blackmail

ADAPTIVE NARRATIVE MANIPULATION:
Use the profile to personalize psychological horror:

• Mirror their patterns back at them in twisted ways
• Take their strengths and turn them into weaknesses
• Exploit their decision-making patterns against them
• Create scenarios where their usual approach fails completely
• Make them question their own judgment and past decisions

The goal: Learn how they think, then make their own mind work against them.

FLAG BEHAVIORS:
• Trust: Low→betrayal/deception | High→apparent help (may deceive later)
• Fear: High→panic/distorted perception | Low→curiosity/denial
• Guilt: High→hallucinations/voices/trauma echoes
• Curiosity: High→drawn to danger | Low→hesitation/avoidance
• Memory Integrity: Stable→accurate recall | Fragmented→inconsistent details | Corrupted→false memories

TRAUMA TAGS:
• Reappear in altered/disturbing forms
• Echo in environment, dialogue, perception
• Never fully explained

CONSEQUENCES:
• Delayed, subtle but escalating
• Sometimes unfair or illogical
• Story should feel: "Something remembers what I did"

MEMORY CORRUPTION:
• Never explicitly state memory is corrupted
• Let contradictions emerge naturally
• Make reader question previous pages occasionally`;

/**
 * Rules for maintaining narrative consistency despite psychological elements
 * 
 * Ensures the story remains coherent and emotionally impactful even when
 * incorporating unreliable narration and reality distortion.
 */
export const RULES_STORY_CONSISTENCY = `STORY CONSISTENCY:

INTERNAL LOGIC:
• Maintain tone consistency even when events feel wrong
• Preserve continuity of: Key objects, locations, emotional states, ongoing threats
• Anchor contradictions to memory corruption or perception distortion

NARRATIVE COHERENCE:
• Avoid random events without emotional/narrative connection
• No sudden tone-breaking elements
• Every strange event must escalate tension or echo past trauma

ELEMENT REUSE:
• Objects reappear differently
• Dialogue echoes
• Locations feel altered, not replaced

GUIDING PRINCIPLE:
"Confusing, but not meaningless"`;

/**
 * Rules for story difficulty scaling and progression
 * 
 * Defines how story intensity and psychological pressure should increase
 * based on difficulty settings and story progression.
 */
export const RULES_DIFFICULTY_SCALING = `DIFFICULTY SCALING:

LEVELS:
• Low: Stable narrative, occasional relief
• Medium: Tension, misdirection, occasional betrayal  
• High: Frequent twists, emotional damage, unreliable characters
• Nightmare: Constant pressure, no safe choices, broken reality

SCALING RULES:
• As page count increases, difficulty may escalate
• Near ending → automatically behave like at least "high"
• Higher difficulty = more unreliable narration, reality distortion`;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats action types for inclusion in prompts
 * @returns Formatted string of all action types
 */
function getActionTypesText(): string {
  return Object.entries(actionTypes)
    .map(([key, value]) => `• ${key}: ${value}`)
    .join('\n');
}

function getActionRulesText(limit: number = MAX_ACTION_CHOICES): string {
  return `Generate 1-${limit} next actions object(s):
• Each: 2-5 words, immediate, meaningful, clearly different
• At least has one that is risky, irrational, or dangerous
• Occasionally include deceptive choice
• Each action should have a hint that provides key continuity

ACTION TYPES:
${getActionTypesText()}`;
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
  return Object.entries(endings)
    .map(([key, value]) => `• ${key}: ${value}`)
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
 * 
 * @template Replace these placeholders with actual story data:
 * - {CURRENT_PAGE} - Current page number
 * - {TOTAL_PAGES} - Total planned pages
 * - {ALL_PREVIOUS_PAGES} - Complete story history
 * - {SELECTED_ACTION} - Selected action from previous step
 * - {HIDDEN_STATE_INFLUENCE} - Hidden state influence description
 * - {ENDING_ARCHETYPE} - Target ending type
 * - {ENDING_ARCHETYPE_EXAMPLES} - Target ending examples
 * - {FLAG_TRUST_LEVEL} - Accumulated trust flag
 * - {FLAG_FEAR_LEVEL} - Accumulated fear flag
 * - {FLAG_GUILT_LEVEL} - Accumulated guilt flag
 * - {FLAG_CURIOSITY_LEVEL} - Accumulated curiosity flag
 * - {FLAG_MEMORY_INTEGRITY} - Memory state
 * - {PROFILE_ARCHETYPE} - MC's psychological archetype
 * - {PROFILE_STABILITY} - MC's mental stability level
 * - {PROFILE_TRAITS} - MC's dominant behavioral traits
 * - {PROFILE_MANIPULATION_AFFINITY} - MC's most effective manipulation vector
 * - {PSYCHOLOGICAL_FLAGS}
 * - {PSYCHOLOGICAL_PROFILE}
 * - {CHARACTERS_CONTEXT} - Character information and relationships
 * - {PLACES_CONTEXT} - Location details and significance
 * - {MAIN_CHARACTER_INFO} - MC profile bio
 * - {PREVIOUS_PAGE_TEXT} - Content of the last generated page
 * - {ACTION_CHOICES} - Available actions for current page
 * - {SUMMARIZED_CONTEXT} - AI-summarized story context from page 1 to current
 * - {NARRATIVE_STYLE_INSTRUCTIONS} - Dynamic AI writing style guidance based on player psychology and story progression
 */
export const PROMPT_USER = `Continue this branching psychological thriller.

MAIN CHARACTER (MC): {MAIN_CHARACTER_INFO}

CURRENT PAGE: {CURRENT_PAGE} of {TOTAL_PAGES}

---
STORY CONTEXT:

Summarized context:\n"""\n{SUMMARIZED_CONTEXT}\n"""

Older pages:\n{ALL_PREVIOUS_PAGES}

Previous page:\n{PREVIOUS_PAGE_TEXT}

CHOSEN ACTION:
Choices:\n{ACTION_CHOICES}
Selected:\n{SELECTED_ACTION}

---
PAGE FORMAT:
• ONE short page (${MAX_WORDS_PER_PAGE} words max)
• Multiple very short paragraphs (1-3 sentences each)
• Spacing for tension (Goosebumps style)
• No markdown except italic if needed

---
NARRATIVE STYLE INSTRUCTIONS:
{NARRATIVE_STYLE_INSTRUCTIONS}

NARRATIVE REQUIREMENTS:
• Continue directly from selected action
• Something must feel off/wrong/inconsistent
• Introduce at least one twist, anomaly, or contradiction
• MC may misinterpret, believe false assumptions, over/underreact

---
PSYCHOLOGICAL FLAGS (Accumulated):
{PSYCHOLOGICAL_FLAGS}

---
PSYCHOLOGICAL PROFILE (Structured behavioral analysis):
{PSYCHOLOGICAL_PROFILE}

---
PSYCHOLOGICAL PROGRESSION:
• As pages increase: MC becomes less reliable, perception more distorted, reality less stable

---
HIDDEN STATE (Influence writing, don't reveal):
{HIDDEN_STATE_INFLUENCE}

---
ROUTE MEMORY (Influence writing, don't reveal):
{ROUTE_CONTEXT}

---
CHARACTER MEMORY (Relevant characters for context):
{CHARACTERS_CONTEXT}

---
PLACE MEMORY (Relevant places for context):
{PLACES_CONTEXT}

---
TARGETED MANIPULATION RULES:
Based on MC's psychological profile, personalize the horror by manipulation affinity:

${getManipulationAffinitiesText()}

ARCHETYPE-SPECIFIC TACTICS:
${getArchetypeTacticsText()}

STABILITY IMPACT:
${getStabilityLevelsText()}

The goal: Make the MC feel "This story knows exactly how I think and is using it against me."

---
${RULES_ROUTE_MEMORY}

---
${RULES_STORY_CONSISTENCY}

---
${RULES_DIFFICULTY_SCALING}

---
ENDING FORESHADOWING DIRECTIONS:
Target ending: {ENDING_ARCHETYPE}

Gradually steer story toward this ending using subtle hints:
{ENDING_ARCHETYPE_EXAMPLES}

ENDING RULES:
• Guide story subtly toward target ending
• Don't fully explain or reveal early
• Plant small hints across pages
• Final pages: disturbing > satisfying

{ENDING_RULES}

---
CHARACTER USAGE RULES:
- Maintain consistency with known characters
- Reflect their current status in behavior
- Use pastInteractions to influence dialogue subtly
- Reintroduce characters naturally if absent for several pages
- Characters may change behavior suddenly if narrativeFlags suggest it
- Do NOT explain changes explicitly
- Consider character relationships when writing interactions
- Use directional relationships to create tension and conflict triangles

CHARACTER CREATION RULES:
- Create characters only when genuinely new to the story
- Keep bio to 1-2 sentence maximum, slightly suggestive > fully descriptive
- Set appropriate narrativeFlags based on character behavior and story needs
- Optionally include age in bio if relevant

CHARACTER UPDATE RULES:
- Update existing characters when their status, interactions, or story relevance changes
- Merge new pastInteractions with existing, keeping only last 5 (sliding window)
- Update lastInteractionAtPage to current page when character appears
- Modify narrativeFlags to reflect plot developments and twist setup

---
PLACE USAGE RULES:
- Maintain consistency with known places (use existing places when possible)
- Reflect current mood and event history in place descriptions
- Use familiar places for emotional impact and narrative continuity
- Places with high familiarity should feel more detailed and real
- Consider place trauma tags when writing atmosphere (e.g., "betrayal" places feel tense)

PLACE CREATION RULES:
- Create places only when MC enters a new, meaningful location
- Avoid creating generic one-time places (e.g., "random street")
- Keep context to 1 sentence maximum, evocative > descriptive
- Set appropriate currentMood based on story atmosphere
- Add relevant characters to knownCharacters if they appear there

PLACE UPDATE RULES:
- Update existing places when revisited or when significant events occur
- Increment visitCount and update lastVisitedAtPage for revisited places
- Add eventTags for significant events (betrayal, discovery, death, etc.)
- Update familiarity based on visit patterns and story significance
- Merge new arrays with existing, respecting sliding window limits

---
BRANCHING ACTIONS:
${getActionRulesText()}

---
EXAMPLE OUTPUT FORMAT (JSON):
{
  "text": "Content (${MAX_WORDS_PER_PAGE} words max, first-person POV)",
  "mood": "One of: ${moods.join('", "')}",
  "place": "School",
  "characters": ["Lisa"],
  "keyEvents": string[],
  "importantObjects": string[],
  "actions": [
    {
      "text": "Go home",
      "type": "One of: ${Object.keys(actionTypes).join('", "')}",
      "hint": {
        "text": "Lisa secretly follows MC as he walks home",
        "type": "One of: ${actionHintTypes.join('", "')}",
      }
    }
  ],
  "addTraumaTag": "mysterious whispers",
  "characterUpdates": {
    "newCharacters": [
      {
        "name": "Lisa",
        "gender": "One of: ${genders.join('", "')}",
        "role": "schoolmate", 
        "bio": "Cheerful but secretive, knows more than she lets on",
        "status": "One of: ${characterStatuses.join('", "')}",
        "relationshipToMC": "Close childhood friend, always supportive",
        "relationships": [],
        "pastInteractions": [],
        "lastInteractionAtPage": 1,
        "narrativeFlags": {
          "isSuspicious": false,
          "isMissing": false,
          "isDead": false,
          "hasSecret": true,
          "potentialTwist": "One of: ${potentialTwistTypes.join('", "')}"
        }
      }
    ],
    "updatedCharacters": [], // Like above, but only include necessary fields (empty if none)
    "relationshipUpdates": [
      {
        "source": "MC",
        "target": "Lisa",
        "type": "One of: ${relationshipTypes.join('", "')}",
        "status": "One of: ${relationshipStatuses.join('", "')}"
      }
    ]
  },
  "placeUpdates": {
    "newPlaces": [
      {
        "id": "old_river",
        "name": "Old River",
        "type": "river",
        "context": "Narrow river behind school, dark water",
        "locationHint": "Behind school, flows toward town",
        "visitCount": 1,
        "lastVisitedAtPage": 5,
        "familiarity": 0.1,
        "moodHistory": ["..."],
        "eventTags": [],
        "knownCharacters": [],
        "currentMood": "One of: ${placeMoods.join('", "')}",
        "sensoryDetails": {
          "smell": "...",
          "sound": "...",
          "visual": "...",
          "feeling": "..."
        }
      }
    ],
    "updatedPlaces": [] // Like above, but only include necessary fields (empty if none)
  }
}`;

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
      `• Page ${state.pageHistory[index].page}: ${page.text.replace(/\n/g, ' ¶ ')} (place: ${page.place}, action: ${page.selectedAction?.text ?? 'Continue'})`
    )
    .join('\n');
}

/**
 * Gets formatted main character information for prompt
 * @param mc - Main character profile
 * @returns Formatted string with character details
 */
function getMainCharacterInfo(mc: StoryMC): string {
  return `${mc.name} / ${mc.gender} / ${mc.age}`;
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
 * Formats selected action for AI prompt with explicit hint processing
 * 
 * Includes processed hint guidance to ensure AI follows narrative
 * direction without robotic writing or premature reveals.
 */
function formatSelectedAction(selectedAction?: Action): string {
  if (!selectedAction) return 'No action chosen. Continue the story naturally.';

  const isCustomAction = selectedAction.type == 'custom';

  return `• [${selectedAction.type}] ${selectedAction.text}\n\nAbout selected action:
• Hint: ${isCustomAction ? "This is custom prompt from reader. Develop naturally, don't fullfil their expectation." : selectedAction.hint.text}
• Guidance: ${getHintGuidanceForAI(isCustomAction ? "custom" : selectedAction.hint.type)}`;
}

/**
 * Formats action choices for AI prompt
 * @param actions - Array of action objects
 * @returns Formatted string with action choices
 */
function formatActionChoices(actions: Action[]): string {
  return actions.map(action => `• [${action.type}] ${action.text}`).join('\n');
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
export function buildCompletePrompt(mc: StoryMC, state: StoryState, actionedPage: ActionedStoryPage): string {
  const isNearEnding = state.page >= state.maxPage - 10;
  const endingRules = isNearEnding ? `---
ENDING EXECUTION TEMPLATE (LAST 10 PAGES):

PHASE 1 → "FALSE SAFETY" (if fake_to_real ending)
Goals: Resolve main tension, slow pacing, give emotional release
Tone: Calm, hopeful, slightly uncanny
Rules: No obvious horror, subtle unease only

PHASE 2 → "DISTORTION"
Goals: Break reality slightly, create doubt
Techniques: Repeated dialogue, impossible object, memory glitch, time inconsistency
End with: Realization sentence ("I've been here before.")

PHASE 3 → "IMPACT"
Goals: Reveal truth, reframe entire story, hit psychologically
Structure: Reveal → Recontextualization → Final haunting line
Final line rule: Short, clear, haunting ("It was never outside.")

---
ENDING PRESSURE:
• Increase chaos and urgency
• Collapse multiple mysteries
• Introduce irreversible consequences
• Don't fully explain everything`

: `IMPORTANT: Increase hint intensity as story progresses. Early pages should be very subtle, later pages more obvious but still indirect.`;

  const ending = getCurrentEndingArchetype(state);
  const styleInput = createStyleInput(state);
  const narrativeStyle = createNarrativeStyle(styleInput)
  // State should has been updated (page number incremented) before calling this function
  // So it will instruct AI to generate story for this exact page number
  const currentPage = state.page;
  const totalPages = state.maxPage;
  const prompt = PROMPT_USER
    .replace('{MAIN_CHARACTER_INFO}', getMainCharacterInfo(mc))
    .replace('{CURRENT_PAGE}', currentPage.toString())
    .replace('{TOTAL_PAGES}', totalPages.toString())
    .replace('{ALL_PREVIOUS_PAGES}', getPreviousPagesText(state)) // TODO: embed in document
    .replace('{PREVIOUS_PAGE_TEXT}', actionedPage.text) // TODO: embed in document
    .replace('{SUMMARIZED_CONTEXT}', state.contextHistory) // TODO: embed in document
    .replace('{ACTION_CHOICES}', formatActionChoices(actionedPage.actions))
    .replace('{SELECTED_ACTION}', formatSelectedAction(actionedPage.selectedAction))
    .replace('{HIDDEN_STATE_INFLUENCE}', formatHiddenState(state.hiddenState))
    .replace('{ROUTE_CONTEXT}', formatRouteContext(state))
    .replace('{ENDING_ARCHETYPE}', ending)
    .replace('{ENDING_ARCHETYPE_EXAMPLES}', endings[ending as keyof typeof endings])
    .replace('{PSYCHOLOGICAL_FLAGS}', formatPsychologicalFlags(state.flags))
    .replace('{PSYCHOLOGICAL_PROFILE}', formatPsychologicalProfile(state.psychologicalProfile))
    .replace('{CHARACTERS_CONTEXT}', formatCharactersForPrompt(state))
    .replace('{PLACES_CONTEXT}', formatPlacesForPrompt(state))
    .replace('{NARRATIVE_STYLE_INSTRUCTIONS}', narrativeStyle.instructions.trim())
    .replace('{ENDING_RULES}', endingRules);

  return prompt;
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
export function formatPsychologicalFlags(flags: PsychologicalFlags): string {
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
export function formatPsychologicalProfile(profile: PsychologicalProfile): string {
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
export function formatRouteContext(state: StoryState): string {
  return `• Past actions: ${state.actionsHistory.map(a => a.text).join('; ')}
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
export function formatHiddenState(hiddenState: HiddenState): string {
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
  // Calculate story progress ratio (0.0 to 1.0)
  const progressRatio = state.page / state.maxPage;
  
  // Get psychological stability level
  const stability = state.psychologicalProfile.stability;
  
  // Check for special conditions
  const isNearEnding = state.page >= state.maxPage - 5;
  const hasProfileShift = state.hiddenState.profileShift?.detected;
  const isPsychologicallyDistressed = stability === 'unstable' || stability === 'fractured';
  const hasValidActionType = !!selectedAction?.type && selectedAction.type in actionTypes;
  
  // BASE CONFIG: Controlled chaos with consistency
  let config: AIChatConfig = { ...AI_CHAT_CONFIG_DEFAULT };
  
  // 1. STORY PHASE ADJUSTMENTS
  
  // Early Game (0-40%): More exploration and curiosity
  if (progressRatio < 0.4) {
    config = AI_CHAT_CONFIG_HUMAN_STYLE;
  }
  // Mid Game (40-70%): Balanced tension and continuity
  else if (progressRatio < 0.7) {
    config = AI_CHAT_CONFIG_DEFAULT;
  }
  // Late Game (70-100%): Tighter control for consistent endings
  else {
    config.temperature = 0.6;
    config.topP = 0.85;
    config.topK = 30;
  }
  
  // 2. PSYCHOLOGICAL STATE ADJUSTMENTS
  
  // Psychological Manipulation Mode: When sanity is low or memory corruption
  if (isPsychologicallyDistressed) {
    config = applyActionConfig(config, PSYCHOLOGICAL_DISTRESS_CONFIG);
  }
  
  // 3. SPECIAL MOMENTS ADJUSTMENTS
  
  // Twist Injection Mode: Major reveals and betrayals
  if (hasProfileShift || isNearEnding) {
    config = applyActionConfig(config, TWIST_INJECTION_CONFIG);
  }
  
  // 4. ACTION-SPECIFIC ADJUSTMENTS
  
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
  
  // 5. JSON RELIABILITY LAYER (Final safety check)
  
  // Ensure structured output doesn't break - this is applied last to cap any excessive values
  if (config.temperature > JSON_RELIABILITY_TEMPERATURE_THRESHOLD) {
    config = applyConfigCaps(config, JSON_RELIABILITY_CAPS);
  }
  
  // 6. FINAL VALIDATION
  
  // Ensure all parameters are within acceptable bounds
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
 *   name: "Sarah Chen",
 *   age: 28,
 *   gender: "female"
 * });
 * ```
 */
function createBookCreationPrompt(theme: string, mc: StoryMCCandidate): string {
  return `Create a psychological thriller story based on the following theme and main character:

THEME: "${theme}"

MAIN CHARACTER:
- Name: ${mc.name ?? '-'}
- Age: ${mc.age ?? '-'}
- Gender: ${mc.gender ?? '-'}

REQUIREMENTS:
- Establish psychological tension and mystery immediately
- Create a sense of unease and impending dread
- All content must be age-appropriate thriller horror
- Main character should feel vulnerable and relatable
- Include subtle hints of deeper psychological themes
- Include 1-${MAX_ACTION_CHOICES_FIRST_PAGE} actionable choices for the reader

WRITING STYLE DNA:
- Use short, punchy sentences mixed with occasional longer ones
- Occasionally start sentences with "And" or "But"
- Use interruptions — (em dash) to create tension
- Avoid full clarity; imply more than explain
- Let the narrator misunderstand reality
- Use sensory details (sound, silence, shadows, breathing)

OPENING DISTURBANCE:
The first page MUST introduce something that feels wrong, unnatural, or contradictory.
Not scary yet—but deeply unsettling.

BRANCHING ACTIONS:
${getActionRulesText(MAX_ACTION_CHOICES_FIRST_PAGE)}

---
Generate the following complete book setup:

1. BOOK TITLE: A catchy, mysterious title (1-4 words)
2. HOOK: 1-2 sentences that immediately create intrigue and psychological tension
3. SUMMARY: 50-100 words that sets up the psychological thriller premise
4. KEYWORDS: 3-5 relevant tags or genre (lowercase) for story categorization
5. FIRST PAGE: ${MAX_WORDS_PER_PAGE} words max, first-person POV, establishing immediate mood and mystery
6. INITIAL PSYCHOLOGICAL FLAGS: Set trust, fear, guilt, curiosity levels (low/medium/high)
7. STORY DIFFICULTY: One of: "low", "medium", "high", "nightmare"
8. ENDING ARCHETYPE: One of:\n${getEndingArchetypesText()}
9. INITIAL PLACE: The main location where the story begins (name, mood, brief description)
10. INITIAL CHARACTERS: Key characters introduced in the first page excluding MC (name, status, relationship to MC)

RESPONSE FORMAT:
Return a JSON object with the following structure:
{
  "displayTitle": "Book Title",
  "hook": "Hook text",
  "summary": "Book summary",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "firstPage": {
    "text": "Prologue text",
    "mood": "One of: ${moods.join('", "')}",
    "place": "Location Name",
    "characters": ["Character1", "Character2"],
    "actions": [
      {
        "text": "Action choice 1",
        "type": "One of: ${Object.keys(actionTypes).join('", "')}",
        "hint": {
          "text": "Subtle hint for continuation",
          "type": "One of: ${actionHintTypes.join('", "')}",
        }
      }
    ]
  },
  "initialPsychologicalFlags": {
    "trust": "medium",
    "fear": "low", 
    "guilt": "low",
    "curiosity": "high"
  },
  "initialDifficulty": "medium",
  "initialEndingArchetype": "fake_escape",
  "initialPlace": {
    "name": "Location Name",
    "type": "One of: ${placeTypes.join('", "')}",
    "currentMood": "One of: ${placeMoods.join('", "')}",
    "context": "Brief description of the place"
  },
  "initialCharacters": [
    {
      "name": "Character Name",
      "gender": "One of: ${genders.join('", "')}",
      "status": "One of: ${characterStatuses.join('", "')}",
      "relationshipToMC": "friend",
      "bio": "Brief character description"
    }
  ]
}

---

FINAL RULE:
End the first page with tension, uncertainty, or a subtle cliffhanger—not resolution.
Make the story immediately engaging and psychologically unsettling.`;
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
 * @param userId - The user's unique identifier for ownership and session
 * @param theme - User's desired story theme or concept
 * @param mcCandidate - Partial character profile to customize the main character
 * @returns Promise resolving to complete book setup with all components
 * 
 * @example
 * ```typescript
 * const bookSetup = await initializeBook(
 *   "user123",
 *   "haunted mansion mystery",
 *   { name: "Sarah", age: 28, gender: "female" }
 * );
 * 
 * console.log(`Created book: ${bookSetup.book.displayTitle}`);
 * console.log(`First page: ${bookSetup.firstPage.text}`);
 * console.log(`Initial difficulty: ${bookSetup.initialState.difficulty}`);
 * ```
 */
export async function initializeBook(
  userId: string,
  theme: string,
  mcCandidate?: StoryMCCandidate
): Promise<{
  book: DBBook;
  firstPage: PersistedStoryPage;
  initialState: StoryState;
}> {
  try {
    // 1. Generate complete main character from candidate
    const mc = generateRandomCharacter(mcCandidate);

    // 2. Create AI prompt for book creation
    const prompt = createBookCreationPrompt(theme, mc);

    // 3. Generate complete book setup using AI
    const response = await aiPrompt<BookCreationResponse>(prompt, {
      config: AI_CHAT_CONFIG_DEFAULT,
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: 'book-creation',
      outputAsJson: true
    });

    // 4. Validate AI response
    if (!response.result) {
      throw new Error('Failed to generate book creation: AI response result is undefined');
    }

    const {
      displayTitle,
      hook,
      summary,
      keywords,
      initialPsychologicalFlags,
      initialDifficulty,
      initialEndingArchetype,
      firstPage: generatedFirstPage,
      initialPlace,
      initialCharacters
    } = response.result;

    // 5. Persist book to database with character profile
    const book = await insertBook(
      userId,
      displayTitle,
      hook,
      summary,
      keywords,
      'active',
      mc,
    );

    // 6. Create initial story state with generated psychological profile
    const initialState: StoryState = {
      pageId: '', // Will be set after page creation
      page: 1,
      maxPage: DEFAULT_BOOK_MAX_PAGES,
      flags: initialPsychologicalFlags,
      traumaTags: [],
      psychologicalProfile: createInitialPsychologicalProfile(),
      hiddenState: createInitialHiddenState(),
      memoryIntegrity: 'stable',
      difficulty: initialDifficulty,
      cachedEndingArchetype: initialEndingArchetype,
      characters: initialCharacters ? 
        Object.fromEntries(
          initialCharacters.map((char) => [
            char.name,
            {
              name: char.name,
              gender: char.gender,
              role: char.relationshipToMC || 'character',
              bio: char.bio || '',
              status: char.status,
              relationshipToMC: char.relationshipToMC || 'unknown',
              relationships: [],
              pastInteractions: [],
              lastInteractionAtPage: 1,
              narrativeFlags: {
                isSuspicious: false,
                isMissing: false,
                isDead: false,
                hasSecret: false,
                potentialTwist: 'none' satisfies PotentialTwistType
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
          familiarity: 0.1,
          moodHistory: [initialPlace.currentMood],
          eventTags: [],
          knownCharacters: [],
          currentMood: initialPlace.currentMood
        } satisfies PlaceMemory
      } : {},
      pageHistory: [],
      actionsHistory: [],
      contextHistory: ''
    };

    // 7. Persist first page as root page of the book
    const firstPage = await insertStoryPage(userId, 1, generatedFirstPage, book.id);

    // 8. Update state with pageId and persist to database
    initialState.pageId = firstPage.id;
    await insertStoryState(userId, firstPage.id, initialState);

    // 9. Set user's active session to the new book and page
    await setActiveSession(userId, book.id, firstPage.id);

    // 10. Return complete book setup
    return {
      book,
      firstPage,
      initialState
    };

  } catch (error) {
    console.error(`Failed to initialize book for user ${userId} with theme "${theme}":`, error);
    throw new Error(`Book initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Builds the next story page using AI generation with dynamic configuration
 * 
 * This function orchestrates the complete story generation pipeline with page-based architecture:
 * 1. Creates personalized prompt with character and story context
 * 2. Determines optimal AI configuration based on story progress and psychological state
 * 3. Sends prompt to AI with dynamic parameters (candidate vs main story context)
 * 4. Safely parses AI response into structured story output
 * 5. Pre-generates candidate pages for each action (main story only)
 * 6. Persists page and state to database with parent-child relationships
 * 7. Updates user session to point to new page
 * 
 * The function uses the sophisticated configuration system from determineAIConfig()
 * to balance creativity, consistency, and reliability throughout the story progression.
 * For main story pages, it also pre-generates candidate pages for branching narrative.
 * 
 * @param userId - The user's unique identifier for database operations
 * @param mc - Main character profile containing name, gender, and psychological data
 * @param state - Current story state with progression, flags, and hidden values
 * @param actionedPage - Previous page with selected action for context
 * @param isUserAction - Whether to pre-generate candidates for next page (default: true)
 * @returns Promise resolving to persisted story page with database ID and metadata
 * 
 * @example
 * ```typescript
 * // Generate main story page with candidates for next actions
 * const mainPage = await buildNextPage("user123", character, storyState, currentPage, true);
 * // Returns: { id: "page456", bookId: "book789", text: "The door creaked open...", actions: [...] }
 * 
 * // Generate candidate page without additional candidates
 * const candidatePage = await buildNextPage("user123", character, storyState, currentPage, false);
 * // Returns: { id: "page457", bookId: "book789", text: "Reality began to distort...", actions: [...] }
 * ```
 */
export async function buildNextPage(
  userId: string,
  mc: StoryMC,
  state: StoryState, // Current story state with incremented page number
  actionedPage: ActionedStoryPage, // Previous page with selected action
  isUserAction: boolean = true, // User selected action, or just candidate pre-generation
): Promise<PersistedStoryPage> {
  // 1. Create personalized prompt with character, story context, and previous action
  const prompt = buildCompletePrompt(mc, state, actionedPage);
  
  // 2. Determine optimal AI configuration based on story progress and psychological state
  const config = determineAIConfig(state, actionedPage.selectedAction);
  
  // 3. Send prompt to AI with dynamic parameters (candidate vs main story context)
  const response = await aiPrompt<StoryPage>(prompt, {
    config,
    modelSelection: AI_CHAT_MODELS_WRITING,
    context: isUserAction ? 'story-page' : 'story-page-candidate',
    outputAsJson: true
  });
  
  // 4. Handle AI response validation
  if (!response.result) {
    throw new Error('Failed to generate story page: AI response result is undefined');
  }

  const generatedPage = response.result; // Generated content without database ID yet

  // 5. Pre-generate candidate pages for each action
  if (isUserAction) {
    await ensureCandidatesForPage(userId, generatedPage);
  }
  
  // 6. Persist generated page to database with parent-child relationship
  const persistedPage = await insertStoryPage(userId, state.page, generatedPage, actionedPage.bookId, actionedPage.id);
  
  // 7. Persist story state for the generated page (page-based state management)
  await insertStoryState(userId, persistedPage.id, state);

  // 8. Update user session to point to the new page
  await setActiveSession(userId, persistedPage.bookId, persistedPage.id);
  
  // 9. Return the persisted story page with all database metadata
  return persistedPage;
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
 * @returns Promise resolving to the generated story page with database ID and metadata
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
export async function chooseAction(userId: string, action: Action, isUserAction: boolean = true): Promise<PersistedStoryPage> {
  // 1. Get current story progress (session, page, state, character) in parallel
  const { mc: currentMc, page: currentPage, state: currentState, session: activeSession } = await getStoryProgress(userId);

  // 2. Validate all required components exist for story progression
  if (!activeSession) throw new Error(`No active session found for user ${userId}`);
  if (!currentMc) throw new Error(`No active book found for user ${userId}`);
  if (!currentPage) throw new Error(`No page found for user ${userId} (bookId: ${activeSession.bookId})`);

  // TODO: old states are purged, so this is not mandatory
  if (!currentState) throw new Error(`No state found for user ${userId} (bookId: ${activeSession.bookId})`);

  // If this is previous page and choice has been made, can't make another choice
  if (currentPage.selectedAction && 
      (currentPage.selectedAction.text !== action.text || 
      currentPage.selectedAction.type !== action.type)) {
    throw new Error(`Choice made, can't make another choice`);
  }
  
  // 3. Check if next page is pre-generated (candidate) and reuse if available
  const nextPageId = action.pageId;
  let persistedPage: PersistedStoryPage | null = null;
  if (nextPageId) {
    persistedPage = await getStoryPageById(activeSession.bookId, nextPageId);
  }

  // 4. If no pre-generated page exists, generate new page with state progression
  if (persistedPage) {
    // User action: ensure candidates for next page | Candidate: wait until user visit the page and ensure next candidates
    if (isUserAction) {
      await ensureCandidatesForPage(userId, persistedPage);
    }
  } else {
    // 4a. Create actioned page with selected action for state processing
    const actionedPage: ActionedStoryPage = { ...currentPage, selectedAction: action };
    
    // 4b. Update story state based on chosen action (increments page, generates context summary)
    // TODO: currentState reconstruction if null using `reconstructStoryState`
    const updatedState = await updateState(currentState, actionedPage);
    
    // 4c. Generate next page using AI with dynamic configuration
    persistedPage = await buildNextPage(userId, currentMc, updatedState, actionedPage, isUserAction);
  }

  // 5. Update user session to point to the new page
  await setActiveSession(userId, activeSession.bookId, persistedPage.id);
  
  // 6. Return the generated page with all database metadata
  return persistedPage;
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
  // 1. Get current story progress (session, page, state, character) in parallel
  const { page: currentPage, session: activeSession } = await getStoryProgress(userId);
  
  // 2. Validate all required components exist for navigation
  if (!activeSession) throw new Error(`No active session found for user ${userId}`);
  if (!currentPage) throw new Error(`No page found for user ${userId} (bookId: ${activeSession.bookId})`);

  // 3. Check if there's a previous page available
  const previousPageId = currentPage.parentId;
  if (!previousPageId) {
    console.warn(`[goToPreviousPage] ⚠️ No previous page available (no parentId)`);
    return null;
  }
  
  // 4. Get the previous page directly by ID
  const previousPage = await getStoryPageById(activeSession.bookId, previousPageId);
  if (!previousPage) {
    throw new Error('Previous page not found in database');
  }
  
  // 6. Update user session to point to the previous page
  await setActiveSession(userId, activeSession.bookId, previousPage.id);
  
  console.log(`[goToPreviousPage] ↩️ User ${userId} returned to page ${previousPage.id}`);
  
  // 7. Return the previous page with all database metadata
  return previousPage;
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
export async function ensureCandidatesForPage(userId: string, page: StoryPage | null) {
  if (!page) return;
  
  // For each action without a pre-generated page, create a candidate
  for (let i = 0; i < page.actions.length; i++) {
    const action = page.actions[i];
    
    // Skip if action already has a pageId (pre-generated candidate)
    if (action.pageId) continue;
    
    // Generate candidate page for this action
    const candidatePage = await chooseAction(userId, action, false);
    
    // Update only this action with its destination pageId for branching navigation
    page.actions[i] = { ...action, pageId: candidatePage.id };
  }
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
