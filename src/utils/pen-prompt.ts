/**
 * Pen (AI co-writing) prompt builders — Phase 1.b `/continue`.
 *
 * The roadmap's single-request contract (§1.b, §6.7): the continuation request
 * is ALSO the verification request. The model is shown the canonical
 * facts/lore block and told not to contradict it, then returns structured
 * `{ text, issues: [...] }` where `issues` lists any contradiction it could
 * not avoid. This is one generation call — `issues` is a self-report, not a
 * separate judge pass.
 *
 * Genre & POV alignment (§1.1 #4/#5, §10 Decision E): the Pen is genre-agnostic
 * (no hardcoded "psychological thriller" framing) and POV-flexible — storyteller
 * continues in the author's POV (`authoringPov`), text adventure is always
 * second-person. The engine's first-person thriller `PROMPT_SYSTEM` is
 * intentionally NOT reused here; it would violate both requirements.
 *
 * Prompt caching: the system prompt is a STATIC per-mode string const
 * (`PEN_STORYTELLER_SYSTEM` / `PEN_TEXT_ADVENTURE_SYSTEM`) so it forms a stable,
 * globally-shared prefix that provider-side prompt caches hit across every book
 * and session. ALL volatile fields (POV, persona, lore, narrative style,
 * language, canonical state, prose, fragment/command) are deferred into the
 * user prompt, which the system prompt instructs the model to read as mandatory
 * sections. Within the user prompt, stable-per-book sections (POV, persona,
 * lore, language) are emitted FIRST so the user-prompt prefix is also cacheable
 * across a session's successive turns.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §1.b, §1.f, §6.3, §6.7, §10 E
 */

import type { StoryState } from "../types/story.js";
import { moods } from "../types/story.js";
import { placeWeathers } from "../types/places.js";
import type { AuthoringMode, AuthoringPov, CoWritingPersona, LoreEntry, PenDraftSceneEssentials } from "../types/pen.js";
import type { AIJsonProperty } from "../types/ai-chat.js";
import { getStoryStateInfo } from "./story.js";
import { RULES_STORY_CONSISTENCY, RULES_LANGUAGE_LOCALIZATION } from "./prompt.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { formatLanguage } from "./translation.js";
import { PEN_CONTINUE_WORDS } from "../config/story.js";
import type { PenContinueLength } from "../config/story.js";
import { injuryCategories } from "../types/character.js";

/** Number of prior pages of context included in a `/continue` prompt. */
const PEN_CONTEXT_PAGES = 2;

/**
 * POV directive for the Pen system prompt (§1.1 #4, §10 E).
 *
 * Text adventure is always second-person ("You...") — it matches the
 * custom-actions output style. Storyteller uses the author's POV when provided
 * (`authoringPov`), else instructs the model to follow the draft rather than
 * forcing first-person.
 */
function povDirective(authoringMode: AuthoringMode, authoringPov?: AuthoringPov): string {
  if (authoringMode === "text_adventure") {
    return 'Write in SECOND PERSON ("You...") — the narrator addresses the protagonist directly.';
  }
  switch (authoringPov) {
    case "first":
      return 'Write in FIRST PERSON ("I") — the protagonist narrates.';
    case "second":
      return 'Write in SECOND PERSON ("You") — the narrator addresses the protagonist.';
    case "third":
      return 'Write in THIRD PERSON (he/she/they, character names) — an external narrator.';
    default:
      return "Match the author's POV from the draft (first, second, or third person) — do not force first-person.";
  }
}

/**
 * Author's persona overlay (Phase 6). Rendered as a user-prompt section when
 * the book has a `coWritingPersona`.
 */
function personaOverlay(persona?: CoWritingPersona): string {
  if (!persona) return "";
  return `AUTHOR'S PERSONA: "${persona.description}"\nVoice: ${persona.voice}\nAdditional directives: ${persona.styleDirectives}`;
}

/**
 * Canonical lore block (Phase 5). Author-curated bible entries are rendered as
 * the authoritative "do not contradict" user-prompt section — they win over
 * engine semantic memory on conflict (§6.3).
 */
function loreBlock(lore?: LoreEntry[]): string {
  if (!lore?.length) return "";
  return `CANONICAL LORE (author-curated, authoritative — do not contradict):\n${lore
    .map((e) => `- [${e.entryType}] ${e.name}: ${e.description}`)
    .join("\n")}`;
}

/**
 * Static, cache-friendly system prompt for Storyteller mode (§1.f).
 *
 * Deliberately NOT the engine's `PROMPT_SYSTEM` (first-person psychological-
 * thriller persona) — the Pen must let an author write any genre and any POV
 * (§1.1 #4/#5). It is a pure string const: no interpolation at request time, so
 * the exact same system prompt ships on every Storyteller `/continue` call and
 * stays a stable prefix for provider-side prompt caching.
 *
 * All volatile content (POV, persona, lore, narrative style, language, canon,
 * prose, fragment) lives in the user prompt; this prompt tells the model those
 * sections are mandatory reading.
 */
export const PEN_STORYTELLER_SYSTEM = `You are a literary co-writer. (Genre-agnostic — follow the story's established genre and tone; do not force horror or thriller framing.)
Continue the author's prose seamlessly — preserve their voice, tense, pacing, and characterization. Advance the scene naturally.

MANDATORY: the USER message contains labeled sections you MUST read and obey before generating: AUTHOR'S POV, AUTHOR'S PERSONA, STORY SUMMARY, CANONICAL LORE, NARRATIVE STYLE, WRITE IN LANGUAGE, CANONICAL STATE (do not contradict), RECENT STORY, and AUTHOR'S FRAGMENT. The CANONICAL STATE and CANONICAL LORE are authoritative — do not contradict them.

WRITE ONLY IN THE LANGUAGE SPECIFIED IN THE WRITE IN LANGUAGE SECTION — the code there is the language of record for every user-facing word you output. Never switch to any other language, English included, unless English is the code specified.

${RULES_STORY_CONSISTENCY}

${RULES_LANGUAGE_LOCALIZATION}`;

/**
 * Static, cache-friendly system prompt for Text Adventure mode (§1.f).
 *
 * Same caching contract as `PEN_STORYTELLER_SYSTEM`: pure string const, all
 * volatile content deferred to the user prompt. Text Adventure is always
 * second-person; the command arrives in the user prompt.
 */
export const PEN_TEXT_ADVENTURE_SYSTEM = `You are the game master / story simulator for the author's story. (Genre-agnostic — follow the story's established genre and tone; do not force horror or thriller framing.)
Interpret the author's request as a player action and resolve it into the story. Simulate consequences, advance the scene, stay in-character as the narrator.

MANDATORY: the USER message contains labeled sections you MUST read and obey before generating: AUTHOR'S POV, AUTHOR'S PERSONA, STORY SUMMARY, CANONICAL LORE, NARRATIVE STYLE, WRITE IN LANGUAGE, CANONICAL STATE (do not contradict), RECENT STORY, and PLAYER COMMAND. The CANONICAL STATE and CANONICAL LORE are authoritative — do not contradict them.

WRITE ONLY IN THE LANGUAGE SPECIFIED IN THE WRITE IN LANGUAGE SECTION — the code there is the language of the story for every user-facing text you output. Never switch to any other language, including English, unless the code supplied there is English.

${RULES_STORY_CONSISTENCY}

${RULES_LANGUAGE_LOCALIZATION}`;

/**
 * Renders a compact canonical block from story state: established facts,
 * main character overview, memory integrity, and the current page number.
 * This is the "do not contradict" canon the generation must respect.
 */
function buildCanonicalBlock(state: StoryState | null, mcName: string, canon?: {
  storyStartDate?: string | null;
  momentum?: string | null;
  sceneType?: string | null;
  essentials?: PenDraftSceneEssentials | null;
}): string {
  const lines: string[] = [];

  if (state) {
    const info = getStoryStateInfo(state);
    lines.push(
      `CURRENT PAGE: ${info.currentPage} of ${info.totalPages} — ${info.phase} PHASE, ${info.remainingPages} page(s) remaining`,
    );
  }
  if (canon?.storyStartDate) lines.push(`STORY DATE: ${canon.storyStartDate}`);
  if (canon?.momentum) lines.push(`MOMENTUM: ${canon.momentum}`);
  if (canon?.sceneType) lines.push(`SCENE TYPE: ${canon.sceneType}`);

  const ess = canon?.essentials;
  if (ess) {
    // TODO: should we pretty format scene info using dash list?
    const sceneParts: string[] = [];
    if (ess.placeId) sceneParts.push(`place: ${ess.placeId}`);
    if (ess.weather) sceneParts.push(`weather: ${ess.weather}`);
    if (ess.timeOfDay) sceneParts.push(`time: ${ess.timeOfDay}`);
    if (ess.calendarDate) sceneParts.push(`date: ${ess.calendarDate}`);
    if (sceneParts.length > 0) lines.push(`SCENE: ${sceneParts.join(", ")}`);
    if (ess.mood) lines.push(`SCENE MOOD: ${ess.mood}`);
    if (ess.keyEvents?.length) lines.push(`KEY EVENTS THIS PAGE: ${ess.keyEvents.join(" | ")}`);
    if (ess.keyObjects?.length) lines.push(`KEY OBJECTS THIS PAGE: ${ess.keyObjects.join(" | ")}`);
  }

  if (state?.memoryIntegrity) {
    lines.push(`MEMORY INTEGRITY: ${String(state.memoryIntegrity)} (unreliable narration level)`);
  }

  if (mcName) lines.push(`MAIN CHARACTER: ${mcName}`);

  if (state?.characters && Object.keys(state.characters).length > 0) {
    const characterLines = Object.values(state.characters).map((c) => {
      const parts = [c.knownName || c.realName || "unknown"];
      if (c.gender) parts.push(`gender:${c.gender}`);
      if (c.role) parts.push(`role:${c.role}`);
      if (c.bio) parts.push(c.bio);
      if (c.appearance) parts.push(`appearance:${c.appearance}`);
      if (c.status) parts.push(`status:${c.status}`);
      return parts.join(" — ");
    });
    lines.push(`KNOWN CHARACTERS:\n${characterLines.join("\n")}`);
  }

  if (state?.factsHistory && Object.keys(state.factsHistory).length > 0) {
    const factLines: string[] = [];
    for (const [key, entries] of Object.entries(state.factsHistory)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const suffix = entry.reason ? ` (${entry.reason})` : "";
        factLines.push(entry.value ? `${key}: ${entry.value}${suffix}` : `${key}${suffix}`);
      }
    }
    if (factLines.length > 0) lines.push(`ESTABLISHED FACTS:\n${factLines.join("\n")}`);
  }

  if (state?.plotFlags && state.plotFlags.length > 0) {
    // PlotFlag is an object { type, fact, page, ... }; render type + fact so the
    // canonical block never leaks "[object Object]".
    const flags = state.plotFlags.map((f) => `${f.type}: ${f.fact}`);
    lines.push(`PLOT FLAGS: ${flags.join(" | ")}`);
  }

  return lines.join("\n");
}

/**
 * Renders the recent prose context (last N page texts) so the continuation is
 * stylistically and narratively continuous. Page texts are trimmed to avoid
 * blowing the context budget.
 */
function buildProseContext(texts: string[]): string {
  const usable = texts.slice(-PEN_CONTEXT_PAGES).filter(Boolean);
  if (usable.length === 0) return "(This is the first page — open the scene.)";
  return usable.map((t) => t.trim()).join("\n\n");
}

/** Result of building a `/continue` prompt: separate system + user prompts. */
export type PenContinuePrompt = {
  systemPrompt: string;
  userPrompt: string;
};

/**
 * Builds the `/continue` prompts for a given authoring mode (§1.f).
 *
 * The system prompt is a STATIC per-mode const (`PEN_STORYTELLER_SYSTEM` /
 * `PEN_TEXT_ADVENTURE_SYSTEM`) so it is a stable, globally-shared cache prefix.
 * All volatile content — POV, persona, lore, narrative style, language,
 * canonical state, recent prose, and the fragment/command — is deferred into the
 * user prompt, ordered stable-per-session first (POV, persona, lore, style,
 * language) so the user-prompt prefix is cacheable across a session's turns,
 * then the per-page canon/prose, then the per-turn fragment/command last.
 *
 * @param state - Current story state (already advanced past the last page).
 * @param params - Shared context: last page texts, prose/command, mc name, language,
 *   optional POV override, persona, and lore entries.
 * @returns `{ systemPrompt, userPrompt }` implementing the single-request
 *   validate-and-generate contract.
 */
export function buildPenContinuePrompt(
  params: {
    state?: StoryState | null;
    authoringMode: AuthoringMode;
    authoringPov?: AuthoringPov;
    persona?: CoWritingPersona;
    lore?: LoreEntry[];
    pageTexts: string[];
    mcName: string;
    language: string;
    bookSummary?: string | null;
    storyStartDate?: string | null;
    momentum?: string | null;
    sceneType?: string | null;
    essentials?: PenDraftSceneEssentials | null;
    /** Continuation-length tier — added as a tail directive (§8 short/medium/long). */
    length?: PenContinueLength;
  } & (
    | { prose: string; directionHint?: string }
    | { command: string }
  )
): PenContinuePrompt {
  const { state, authoringMode, authoringPov, persona, lore, pageTexts, mcName, language, bookSummary, length } = params;

  const canon = buildCanonicalBlock(state ?? null, mcName, {
    storyStartDate: "storyStartDate" in params ? params.storyStartDate : undefined,
    momentum: "momentum" in params ? params.momentum : undefined,
    sceneType: "sceneType" in params ? params.sceneType : undefined,
    essentials: "essentials" in params ? params.essentials : undefined,
  });
  const prose = buildProseContext(pageTexts);
  const narrativeStyleInstructions = state ? createNarrativeStyle(state).instructions : undefined;

  // Static per-mode system prompt — a stable, globally-shared cache prefix.
  const systemPrompt =
    authoringMode === "text_adventure" ? PEN_TEXT_ADVENTURE_SYSTEM : PEN_STORYTELLER_SYSTEM;

  // Stable-per-session/book sections first (POV, persona, summary, lore,
  // narrative style, language) so the user-prompt PREFIX is also cacheable across
  // a session's successive turns; canonical state + recent story (grow per page)
  // and the fragment/command (changes per turn) come last.
  const stableSections = [
    `AUTHOR'S POV: ${povDirective(authoringMode, authoringPov)}`,
    personaOverlay(persona),
    bookSummary ? `STORY SUMMARY: ${bookSummary}` : "",
    loreBlock(lore),
    narrativeStyleInstructions ? `NARRATIVE STYLE:\n${narrativeStyleInstructions}` : "",
    `WRITE IN LANGUAGE: ${formatLanguage(language)}`,
  ].filter(Boolean);

  const contextSections = [
    `CANONICAL STATE (do not contradict):\n${canon}`,
    `RECENT STORY:\n${prose}`,
  ];

  if (authoringMode === "text_adventure") {
    const command = "command" in params ? params.command : "";
    return {
      systemPrompt,
      userPrompt: [
        ...stableSections,
        ...contextSections,
        `PLAYER COMMAND:\n> ${command}`,
        length ? `APPROXIMATE LENGTH: append about ${PEN_CONTINUE_WORDS[length]} words (${length.toUpperCase()}).` : "",
        'Resolve the command into the story. Write ONLY the continuation text (no ">", no out-of-character notes).',
      ].join("\n\n"),
    };
  }

  const proseParam = "prose" in params ? params.prose : "";
  const hint = "directionHint" in params && params.directionHint ? `\nAUTHOR DIRECTION: ${params.directionHint}` : "";

  return {
    systemPrompt,
    userPrompt: [
      ...stableSections,
      ...contextSections,
      `AUTHOR'S FRAGMENT:\n${proseParam}${hint}`,
      length ? `APPROXIMATE LENGTH: append about ${PEN_CONTINUE_WORDS[length]} words (${length.toUpperCase()}).` : "",
      "Continue the story. Write ONLY the continuation text — do not repeat the author's fragment.",
    ].join("\n\n"),
  };
}

/** A self-reported canon contradiction (single-request validate-and-generate, §1.b). */
export type PenContinueIssue = {
  /** Source of the contradiction — aligns with FinalizeViolation.source (§6.7). */
  type: "lore" | "fact" | "character_memory" | "place_memory" | "other";
  /** What the canonical state requires. */
  expected: string;
  /** What the draft says. */
  found: string;
};

/** Structured output shape: text plus a self-reported canon-issue list. */
export type PenContinueResult = {
  text: string;
  issues?: PenContinueIssue[];
};

/** Structured-output schema for the `/continue` self-report contract. */
export const PEN_CONTINUE_SCHEMA: Record<keyof PenContinueResult, AIJsonProperty> = {
  text: { type: "string", description: "The generated continuation text." },
  issues: {
    type: "array",
    description: "Any canon contradiction the model could not avoid, or an empty array.",
    items: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["lore", "fact", "character_memory", "place_memory", "other"],
          description: "Source of the contradiction.",
        },
        expected: { type: "string", description: "What the canonical state requires." },
        found: { type: "string", description: "What the draft says." },
      },
      required: ["expected", "found"],
    },
  },
};

/** Required fields for the `/continue` structured output. */
export const PEN_CONTINUE_REQUIRED_FIELDS: (keyof PenContinueResult)[] = ["text"];

/**
 * Static, cache-friendly system prompt for Page Essentials auto-fill (§2.i /
 * §10 Decision M).
 *
 * Same caching discipline as the `/continue` system prompts: a pure string
 * const with every volatile field deferred to the user prompt. This call is a
 * constrained classification task over fixed enum/option sets (mood, weather,
 * bible places), so the output is a small JSON form rather than prose — the
 * response is capped by `PEN_ESSENTIALS_MAX_TOKENS`.
 */
export const PEN_ESSENTIALS_SYSTEM = `You are a literary scene-designer for a story author. Your job is to propose the scene essentials (setting pin) for the author's NEXT page: mood, weather, in-world date, time of day, the place it happens, and the key events/objects that occur.

MANDATORY: the USER message contains labeled sections you MUST read and obey before generating: AUTHOR'S PERSONA, STORY SUMMARY, CANONICAL LORE, NARRATIVE STYLE, WRITE IN LANGUAGE, CANONICAL STATE (do not contradict), RECENT STORY, CURRENT DRAFT, CURRENT SCENE ESSENTIALS, and PLACE OPTIONS. The CANONICAL STATE and CANONICAL LORE are authoritative — do not contradict them.

CRITICAL RULES:
- Only propose values for fields the author has LEFT BLANK. If an essential is already filled, return nothing for it (do not repeat or second-guess it).
- MOOD must be exactly one of the MOOD OPTIONS values and nothing else. WEATHER must be exactly one of the WEATHER OPTIONS values and nothing else.
- PLACE must be exactly the NAME of one of the PLACE OPTIONS, or empty string when no option fits. Never invent a place that is not in PLACE OPTIONS.
- KEY EVENTS and KEY OBJECTS are short, concrete phrases derived from the draft. Return empty arrays when you cannot confidently find any.
- CALENDAR DATE is the in-world date (e.g. 2026-07-26); TIME OF DAY is a coarse mark such as night / dusk / 14:00.
- Keep every field concise. When in doubt, leave a field empty rather than guessing.

Return ONLY the JSON form matching the schema.

${RULES_STORY_CONSISTENCY}

${RULES_LANGUAGE_LOCALIZATION}`;

/**
 * Static, cache-friendly system prompt for REVIEW-MODE Page Essentials
 * auto-fill (§2.i / §10 Decision M). Same caching discipline as
 * {@link PEN_ESSENTIALS_SYSTEM} — a pure string const with volatile fields in
 * the user prompt — but instead of only filling blanks, the model proposes the
 * most fitting value for EVERY field and may revise already-filled ones when
 * the draft/canon clearly supports a better fit.
 */
export const PEN_ESSENTIALS_REVIEW_SYSTEM = `You are a literary scene-designer for a story author. Your job is to review and, when warranted, correct the scene essentials (setting pin) for the author's NEXT page: mood, weather, in-world date, time of day, the place it happens, and the key events/objects that occur.

MANDATORY: the USER message contains labeled sections you MUST read and obey before generating: AUTHOR'S PERSONA, STORY SUMMARY, CANONICAL LORE, NARRATIVE STYLE, WRITE IN LANGUAGE, CANONICAL STATE (do not contradict), RECENT STORY, CURRENT DRAFT, CURRENT SCENE ESSENTIALS, and PLACE OPTIONS. The CANONICAL STATE and CANONICAL LORE are authoritative — do not contradict them.

CRITICAL RULES:
- Propose a value for EVERY field. For fields the author already filled, propose the same value when it still fits, or a clearly better one when the draft/canon supports it. Never change a filled value without a reason grounded in the draft or canon.
- MOOD must be exactly one of the MOOD OPTIONS values and nothing else. WEATHER must be exactly one of the WEATHER OPTIONS values and nothing else.
- PLACE must be exactly the NAME of one of the PLACE OPTIONS, or empty string when no option fits. Never invent a place that is not in PLACE OPTIONS.
- KEY EVENTS and KEY OBJECTS are short, concrete phrases derived from the draft. Return the author's current items when they still fit, extend or prune them only when the draft warrants it. Return empty arrays when you cannot confidently find any.
- CALENDAR DATE is the in-world date (e.g. 2026-07-26); TIME OF DAY is a coarse mark such as night / dusk / 14:00.
- Keep every field concise. When in doubt, keep the author's current value rather than guessing.

Return ONLY the JSON form matching the schema.

${RULES_STORY_CONSISTENCY}

${RULES_LANGUAGE_LOCALIZATION}`;

/** Raw structured output shape of the auto-fill call (before server-side coercion). */
export type PenEssentialsAutofillResult = {
  /** One of the canonical `moods` keys, or undefined when the author already set it. */
  mood?: string;
  /** One of the canonical `placeWeathers` keys, or undefined when the author already set it. */
  weather?: string;
  /** Free-text in-world date, or undefined when the author already set it. */
  calendarDate?: string;
  /** Free-text coarse time mark, or undefined when the author already set it. */
  timeOfDay?: string;
  /** The NAME of one of the PLACE OPTIONS, or empty when none fits (resolved to a placeId server-side). */
  placeName?: string;
  /** Key events for the page — empty array when none. */
  keyEvents: string[];
  /** Key objects for the page — empty array when none. */
  keyObjects: string[];
};

/** Structured-output schema for the auto-fill call — mood/weather are enum-constrained. */
export const PEN_ESSENTIALS_SCHEMA: Record<keyof PenEssentialsAutofillResult, AIJsonProperty> = {
  mood: {
    type: "string",
    enum: [...moods],
    description: "One canonical mood key for the page, or omit when the author already set it.",
  },
  weather: {
    type: "string",
    enum: [...placeWeathers],
    description: "One canonical weather key for the page, or omit when the author already set it.",
  },
  calendarDate: { type: "string", description: "In-world date for the page (e.g. 2026-07-26), or omit when already set." },
  timeOfDay: { type: "string", description: "Coarse time mark (e.g. night, dusk, 14:00), or omit when already set." },
  placeName: { type: "string", description: "Exact name of one of the PLACE OPTIONS, or empty when none fits." },
  keyEvents: {
    type: "array",
    description: "Short, concrete key events that occur in the page.",
    items: { type: "string" },
  },
  keyObjects: {
    type: "array",
    description: "Short, concrete key objects present in the page.",
    items: { type: "string" },
  },
};

/**
 * Structured-output schema for REVIEW-MODE auto-fill. Mirrors
 * {@link PEN_ESSENTIALS_SCHEMA} but drops every "or omit when the author already
 * set it" qualifier so the model proposes a value for EVERY field, matching
 * {@link PEN_ESSENTIALS_REVIEW_SYSTEM}. Without this the structured-output
 * provider would honor the schema description over the system prompt and
 * silently skip revising already-filled enum fields.
 */
export const PEN_ESSENTIALS_REVIEW_SCHEMA: Record<keyof PenEssentialsAutofillResult, AIJsonProperty> = {
  mood: {
    type: "string",
    enum: [...moods],
    description: "One canonical mood key for the page — always propose the most fitting value.",
  },
  weather: {
    type: "string",
    enum: [...placeWeathers],
    description: "One canonical weather key for the page — always propose the most fitting value.",
  },
  calendarDate: { type: "string", description: "In-world date for the page (e.g. 2026-07-26) — always propose the most fitting value." },
  timeOfDay: { type: "string", description: "Coarse time mark (e.g. night, dusk, 14:00) — always propose the most fitting value." },
  placeName: { type: "string", description: "Exact name of one of the PLACE OPTIONS, or empty when none fits." },
  keyEvents: {
    type: "array",
    description: "Short, concrete key events that occur in the page.",
    items: { type: "string" },
  },
  keyObjects: {
    type: "array",
    description: "Short, concrete key objects present in the page.",
    items: { type: "string" },
  },
};

/** Required fields for the auto-fill structured output. */
export const PEN_ESSENTIALS_REQUIRED_FIELDS: (keyof PenEssentialsAutofillResult)[] = ["keyEvents", "keyObjects"];

/** Result of building an auto-fill prompt: separate system + user prompts. */
export type PenEssentialsAutofillPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

/**
 * Builds the Page Essentials auto-fill prompt (§2.i / §10 Decision M).
 *
 * Same caching contract as {@link buildPenContinuePrompt}: a STATIC system
 * prompt const (`PEN_ESSENTIALS_SYSTEM`) plus a user prompt with the stable-
 * per-session sections first (persona, summary, lore, style, language) so the
 * user-prompt prefix stays cacheable, then the per-page canon/prose and the
 * current essentials + option lists last.
 *
 * @param params - Shared context plus the author's currently-filled essentials,
 *   the current in-progress draft text, and the known bible place options.
 * @returns `{ systemPrompt, userPrompt }`.
 */
export function buildPenEssentialsAutofillPrompt(params: {
  state?: StoryState | null;
  persona?: CoWritingPersona;
  lore?: LoreEntry[];
  pageTexts: string[];
  mcName: string;
  language: string;
  bookSummary?: string | null;
  storyStartDate?: string | null;
  momentum?: string | null;
  sceneType?: string | null;
  /** The author's currently-filled essentials — the model fills only the blanks. */
  essentials: PenDraftSceneEssentials | null;
  /** Current in-progress draft prose (plain text) — the freshest story signal. */
  draftText: string;
  /** Known bible places as `{ value: placeId, name }` — constrains the place proposal. */
  placeOptions: Array<{ value: string; name: string }>;
  /** `fill_empty` (default) only fills blanks; `review_all` may revise filled values. */
  mode?: "fill_empty" | "review_all";
}): PenEssentialsAutofillPrompt {
  const {
    state,
    persona,
    lore,
    pageTexts,
    mcName,
    language,
    bookSummary,
    storyStartDate,
    momentum,
    sceneType,
    essentials,
    draftText,
    placeOptions,
    mode = "fill_empty",
  } = params;

  const canon = buildCanonicalBlock(state ?? null, mcName, {
    storyStartDate,
    momentum,
    sceneType,
    essentials,
  });
  const prose = buildProseContext(pageTexts);
  const narrativeStyleInstructions = state ? createNarrativeStyle(state).instructions : undefined;

  const stableSections = [
    personaOverlay(persona),
    bookSummary ? `STORY SUMMARY: ${bookSummary}` : "",
    loreBlock(lore),
    narrativeStyleInstructions ? `NARRATIVE STYLE:\n${narrativeStyleInstructions}` : "",
    `WRITE IN LANGUAGE: ${formatLanguage(language)}`,
  ].filter(Boolean);

  const placeIdToName = new Map(placeOptions.map((p) => [p.value, p.name]));

  const currentEssentials = essentials
    ? [
        essentials.placeId ? `place: ${placeIdToName.get(essentials.placeId) ?? essentials.placeId}` : "",
        essentials.mood ? `mood: ${essentials.mood}` : "",
        essentials.weather ? `weather: ${essentials.weather}` : "",
        essentials.calendarDate ? `date: ${essentials.calendarDate}` : "",
        essentials.timeOfDay ? `time: ${essentials.timeOfDay}` : "",
        essentials.keyEvents?.length ? `key events: ${essentials.keyEvents.join(" | ")}` : "",
        essentials.keyObjects?.length ? `key objects: ${essentials.keyObjects.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const placeNames = placeOptions.length > 0 ? placeOptions.map((p) => p.name).join(", ") : "(no places defined yet)";

  const isReview = mode === "review_all";
  const currentEssentialsLabel = isReview
    ? "CURRENT SCENE ESSENTIALS (set by the author — keep or propose a clearly better value):"
    : "CURRENT SCENE ESSENTIALS (already set by the author — leave these alone):";
  const closingLine = isReview
    ? "Propose the most fitting value for EVERY field, revising filled ones only when clearly warranted. Output the JSON form described in the system prompt."
    : "Propose values ONLY for the blank fields. Output the JSON form described in the system prompt.";

  return {
    systemPrompt: isReview ? PEN_ESSENTIALS_REVIEW_SYSTEM : PEN_ESSENTIALS_SYSTEM,
    userPrompt: [
      ...stableSections,
      `CANONICAL STATE (do not contradict):\n${canon}`,
      `RECENT STORY:\n${prose}`,
      draftText ? `CURRENT DRAFT:\n${draftText}` : "(No draft yet — this is the first page; open the scene.)",
      currentEssentials ? `${currentEssentialsLabel}\n${currentEssentials}` : "(No scene essentials are set yet — propose the most fitting values.)",
      `MOOD OPTIONS: ${moods.join(", ")}`,
      `WEATHER OPTIONS: ${placeWeathers.join(", ")}`,
      `PLACE OPTIONS: ${placeNames}`,
      closingLine,
    ].join("\n\n"),
  };
}

/**
 * Static, cache-friendly system prompt for the finalize state proposal (§2.i /
 * §10). Same caching discipline as the other Pen system prompts: a pure string
 * const with every volatile field deferred to the user prompt.
 *
 * The model proposes the NEXT page's inventory and injuries as an "adopt as
 * canon" state update. Output is the FULL resulting state (replacement
 * semantics, mirroring how `applyStateDelta` consumes inventory/injuries): the
 * model must carry forward every item/injury that should persist and drop any
 * that should be removed. This is a constrained structured-output task, capped
 * by `PEN_FINALIZE_PROPOSE_MAX_TOKENS`.
 */
export const PEN_STATE_PROPOSAL_SYSTEM = `You are a story-state accountant for an author. Given the author's CURRENT DRAFT for the NEXT page, compute what the story state should become once that page is published: the page's scene pin (mood, weather, in-world date, time of day), the character's full inventory, any injuries they carry, and the page's key events and key objects.

MANDATORY: the USER message contains labeled sections you MUST read and obey before generating: AUTHOR'S PERSONA, STORY SUMMARY, CANONICAL LORE, NARRATIVE STYLE, WRITE IN LANGUAGE, CANONICAL STATE (do not contradict), RECENT STORY, CURRENT DRAFT, CURRENT SCENE, and CURRENT INVENTORY & INJURIES. The CANONICAL STATE and CANONICAL LORE are authoritative — do not contradict them.

CRITICAL RULES:
- Return the FULL resulting inventory and injuries, not just the changes.
- SCENE FIELDS (mood, weather, calendarDate, timeOfDay) are the FULL resulting values the page should carry — carry forward the CURRENT SCENE values unless the draft clearly changes them. MOOD must be exactly one of the MOOD OPTIONS values and nothing else; WEATHER must be exactly one of the WEATHER OPTIONS values and nothing else. CALENDAR DATE continues the story's in-world timeline: advance from the CURRENT SCENE date by the time that passes in the draft (e.g. the next day), and keep it when the draft does not clearly advance time. TIME OF DAY is a coarse mark (e.g. night, dusk, 14:00).
- INVENTORY is a complete replacement list: keep every item the character should still hold (same name, same amount unless the draft shows use/loss), add items the draft shows them acquiring, drop items the draft shows them losing, and set amount to 0 only when an item is fully consumed (it will be removed server-side).
- INJURIES is a complete replacement list: keep every active injury (adjust severity only when the draft shows healing or aggravation), add injuries the draft shows the character sustaining, and drop injuries that have fully healed.
- Only derive changes the draft supports. Do not invent loot, wounds, or losses out of nowhere; when nothing changes, echo the current state.
- For each inventory item include the traits that matter (e.g. material, state, rules) as strings in the engine's 'key: value' format (e.g. 'material: iron'); omit traits when the item has none.
- INJURY SEVERITY is 0–1 (0.1 minor, 0.3 moderate, 0.6 severe, 0.9 critical). INJURY CATEGORY must be one of the CATEGORY OPTIONS.
- KEY EVENTS and KEY OBJECTS are editorial scene metadata: infer the meaningful events that happen on this page and the important objects present or used, as concise phrases in the story's language. Empty the list when there is nothing notable.

Return ONLY the JSON form matching the schema.

${RULES_STORY_CONSISTENCY}

${RULES_LANGUAGE_LOCALIZATION}`;

/** One inventory item in a state proposal (server-side coercion stamps acquisition metadata). */
export type PenStateProposalInventoryItem = {
  name: string;
  amount?: number;
  where?: string;
  /** Trait strings (engine format: `"material: iron"`, `"state: broken"`). */
  traits?: string[];
};

/** One injury in a state proposal. */
export type PenStateProposalInjury = {
  bodyPart: string;
  description: string;
  severity?: number;
  category?: string;
  consequences?: string;
};

/** Raw structured output shape of the finalize state-proposal call. */
export type PenStateProposalResult = {
  /** FULL resulting inventory (replacement semantics). */
  inventory: PenStateProposalInventoryItem[];
  /** FULL resulting injuries (replacement semantics). */
  injuries: PenStateProposalInjury[];
  /** FULL resulting page mood (one of the `moods` keys). */
  mood?: string;
  /** FULL resulting page weather (one of the `placeWeathers` keys). */
  weather?: string;
  /** FULL resulting in-world date (advances the CURRENT SCENE date per the draft). */
  calendarDate?: string;
  /** FULL resulting coarse time mark. */
  timeOfDay?: string;
  /** Key events this page, inferred from the draft + canon (editorial scene metadata). */
  keyEvents: string[];
  /** Key objects this page, inferred from the draft + canon (editorial scene metadata). */
  keyObjects: string[];
};

/** Structured-output schema for the finalize state proposal. */
export const PEN_STATE_PROPOSAL_SCHEMA: Record<keyof PenStateProposalResult, AIJsonProperty> = {
  mood: {
    type: "string",
    enum: [...moods],
    description: "Full resulting page mood — one of the MOOD OPTIONS.",
  },
  weather: {
    type: "string",
    enum: [...placeWeathers],
    description: "Full resulting page weather — one of the WEATHER OPTIONS.",
  },
  calendarDate: { type: "string", description: "In-world date for the page (e.g. 2026-07-26), continuing the timeline from the CURRENT SCENE date." },
  timeOfDay: { type: "string", description: "Coarse time mark (e.g. night, dusk, 14:00)." },
  inventory: {
    type: "array",
    description: "The FULL resulting inventory — every item the character should hold after this page.",
    items: {
      type: "object",
      properties: {
        name: { type: "string", description: "Item name." },
        amount: { type: "integer", description: "Quantity; 0 when the item is fully consumed." },
        where: { type: "string", description: "Where the item is kept (e.g. 'in backpack')." },
        traits: {
          type: "array",
          description: "Notable traits for the item, each as a 'key: value' string (e.g. 'material: iron').",
          items: { type: "string" },
        },
      },
      required: ["name"],
    },
  },
  injuries: {
    type: "array",
    description: "The FULL resulting injuries — every active injury the character carries after this page.",
    items: {
      type: "object",
      properties: {
        bodyPart: { type: "string", description: "Body part affected." },
        description: { type: "string", description: "Human-readable injury description." },
        severity: { type: "number", description: "0–1 severity (0.1 minor, 0.3 moderate, 0.6 severe, 0.9 critical)." },
        category: {
          type: "string",
          enum: [...injuryCategories],
          description: "Broad injury classification.",
        },
        consequences: { type: "string", description: "Functional consequences (e.g. 'Cannot run fast')." },
      },
      required: ["bodyPart", "description"],
    },
  },
  keyEvents: {
    type: "array",
    description: "Meaningful events that occurred on this page, inferred from the draft.",
    items: { type: "string" },
  },
  keyObjects: {
    type: "array",
    description: "Important objects present or used on this page, inferred from the draft.",
    items: { type: "string" },
  },
};

/** Required fields for the state-proposal structured output. */
export const PEN_STATE_PROPOSAL_REQUIRED_FIELDS: (keyof PenStateProposalResult)[] = ["inventory", "injuries"];

/** Result of building a state-proposal prompt: separate system + user prompts. */
export type PenStateProposalPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

/** Renders the current scene (essentials) as a compact prompt section. */
function renderCurrentScene(essentials: PenDraftSceneEssentials | null): string {
  if (!essentials) return "(no scene is set — infer the most fitting values from the draft)";
  const parts: string[] = [];
  if (essentials.placeId) parts.push(`place: ${essentials.placeId}`);
  if (essentials.mood) parts.push(`mood: ${essentials.mood}`);
  if (essentials.weather) parts.push(`weather: ${essentials.weather}`);
  if (essentials.calendarDate) parts.push(`date: ${essentials.calendarDate}`);
  if (essentials.timeOfDay) parts.push(`time: ${essentials.timeOfDay}`);
  return parts.length > 0 ? parts.join("\n") : "(no scene is set — infer the most fitting values from the draft)";
}

/** Renders the current inventory as a compact prompt section. */
function renderCurrentInventory(state: StoryState | null): string {
  const inventory = state?.inventory;
  if (!inventory || inventory.length === 0) return "(the character currently holds nothing)";
  return inventory
    .map((item) => {
      const traits = item.traits?.length ? ` [${item.traits.join(", ")}]` : "";
      const amount = item.amount !== undefined ? ` ×${item.amount}` : "";
      const where = item.where ? ` (${item.where})` : "";
      return `- ${item.name}${traits}${amount}${where}`;
    })
    .join("\n");
}

/** Renders the current injuries as a compact prompt section. */
function renderCurrentInjuries(state: StoryState | null): string {
  const injuries = state?.injuries;
  if (!injuries || injuries.length === 0) return "(the character carries no active injuries)";
  return injuries
    .map((injury) => {
      const severity = injury.severity !== undefined ? ` severity ${injury.severity}` : "";
      const category = injury.category ? ` [${injury.category}]` : "";
      const consequences = injury.consequences ? ` — ${injury.consequences}` : "";
      return `- ${injury.bodyPart}: ${injury.description}${severity}${category}${consequences}`;
    })
    .join("\n");
}

/**
 * Builds the finalize state-proposal prompt (§2.i / §10).
 *
 * Same caching contract as {@link buildPenContinuePrompt} and
 * {@link buildPenEssentialsAutofillPrompt}: a STATIC system prompt const
 * (`PEN_STATE_PROPOSAL_SYSTEM`) plus a user prompt with the stable-per-session
 * sections first, then the per-page canon/prose and the current
 * inventory/injuries last.
 */
export function buildPenStateProposalPrompt(params: {
  state?: StoryState | null;
  persona?: CoWritingPersona;
  lore?: LoreEntry[];
  pageTexts: string[];
  mcName: string;
  language: string;
  bookSummary?: string | null;
  storyStartDate?: string | null;
  momentum?: string | null;
  sceneType?: string | null;
  /** The scene the current draft sits in (place + inherited scene fields) — the model carries it forward. */
  essentials?: PenDraftSceneEssentials | null;
  draftText: string;
}): PenStateProposalPrompt {
  const {
    state,
    persona,
    lore,
    pageTexts,
    mcName,
    language,
    bookSummary,
    storyStartDate,
    momentum,
    sceneType,
    essentials,
    draftText,
  } = params;

  const canon = buildCanonicalBlock(state ?? null, mcName, {
    storyStartDate,
    momentum,
    sceneType,
    essentials,
  });
  const prose = buildProseContext(pageTexts);
  const narrativeStyleInstructions = state ? createNarrativeStyle(state).instructions : undefined;

  const stableSections = [
    personaOverlay(persona),
    bookSummary ? `STORY SUMMARY: ${bookSummary}` : "",
    loreBlock(lore),
    narrativeStyleInstructions ? `NARRATIVE STYLE:\n${narrativeStyleInstructions}` : "",
    `WRITE IN LANGUAGE: ${formatLanguage(language)}`,
  ].filter(Boolean);

  return {
    systemPrompt: PEN_STATE_PROPOSAL_SYSTEM,
    userPrompt: [
      ...stableSections,
      `CANONICAL STATE (do not contradict):\n${canon}`,
      `RECENT STORY:\n${prose}`,
      `CURRENT DRAFT:\n${draftText}`,
      `CURRENT SCENE (the scene before this page publishes — carry forward what the draft does not change):\n${renderCurrentScene(essentials ?? null)}`,
      `CURRENT INVENTORY & INJURIES (the state before this page publishes — carry forward what persists, change only what the draft supports):\nINVENTORY:\n${renderCurrentInventory(state ?? null)}\nINJURIES:\n${renderCurrentInjuries(state ?? null)}`,
      `CATEGORY OPTIONS: ${injuryCategories.join(", ")}`,
      `MOOD OPTIONS: ${moods.join(", ")}`,
      `WEATHER OPTIONS: ${placeWeathers.join(", ")}`,
      "Compute the FULL resulting scene, inventory, injuries, key events, and key objects for the page being published.",
    ].join("\n\n"),
  };
}
