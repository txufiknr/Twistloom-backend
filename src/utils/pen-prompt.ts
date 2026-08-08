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
import type { AuthoringMode, AuthoringPov, CoWritingPersona, LoreEntry, PenDraftSceneEssentials } from "../types/pen.js";
import type { AIJsonProperty } from "../types/ai-chat.js";
import { getStoryStateInfo } from "./story.js";
import { RULES_STORY_CONSISTENCY, RULES_LANGUAGE_LOCALIZATION } from "./prompt.js";
import { createNarrativeStyle } from "./narrative-style.js";
import { formatLanguage } from "./translation.js";

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
  } & (
    | { prose: string; directionHint?: string }
    | { command: string }
  )
): PenContinuePrompt {
  const { state, authoringMode, authoringPov, persona, lore, pageTexts, mcName, language, bookSummary } = params;

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
