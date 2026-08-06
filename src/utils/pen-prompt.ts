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
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §1.b, §1.f, §6.3, §6.7, §10 E
 */

import type { StoryState } from "../types/story.js";
import type { AuthoringMode, AuthoringPov, CoWritingPersona, LoreEntry } from "../types/pen.js";
import type { AIJsonProperty } from "../types/ai-chat.js";
import { getStoryStateInfo } from "./story.js";
import { RULES_STORY_CONSISTENCY, RULES_LANGUAGE_LOCALIZATION } from "./prompt.js";
import { createNarrativeStyle } from "./narrative-style.js";

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
 * Author's persona overlay (Phase 6). Appended to the system prompt when the
 * book has a `coWritingPersona`.
 */
function personaOverlay(persona?: CoWritingPersona): string {
  if (!persona) return "";
  return `\nAUTHOR'S PERSONA: "${persona.description}"\nVoice: ${persona.voice}\nAdditional directives: ${persona.styleDirectives}`;
}

/**
 * Canonical lore block (Phase 5). Author-curated bible entries are injected as
 * the authoritative "do not contradict" source — they win over engine semantic
 * memory on conflict (§6.3).
 */
function loreBlock(lore?: LoreEntry[]): string {
  if (!lore?.length) return "";
  return `\nCANONICAL LORE (author-curated, authoritative — do not contradict):\n${lore
    .map((e) => `- [${e.entryType}] ${e.name}: ${e.description}`)
    .join("\n")}`;
}

/**
 * Builds the genre-agnostic, POV-aware Pen system prompt.
 *
 * Deliberately does NOT reuse the engine's `PROMPT_SYSTEM` (first-person
 * psychological-thriller persona) — the Pen must let an author write any genre
 * and any POV (§1.1 #4/#5). Narrative-style instructions (from the state engine)
 * are optional: they adapt tone to the current psychological state, but the
 * Pen is not required to force the engine's thriller house style.
 *
 * @param params - Mode, POV, persona/lore overlays, narrative-style instructions
 * @returns The system prompt string
 */
export function buildPenSystemPrompt(params: {
  authoringMode: AuthoringMode;
  authoringPov?: AuthoringPov;
  persona?: CoWritingPersona;
  lore?: LoreEntry[];
  narrativeStyleInstructions?: string;
  language?: string;
}): string {
  const { authoringMode, authoringPov, persona, lore, narrativeStyleInstructions, language } = params;
  const isTextAdventure = authoringMode === "text_adventure";

  const role = isTextAdventure
    ? `You are the game master / world simulator for the author's story. (Genre-agnostic — follow the story's established genre and tone; do not force horror or thriller framing.)
Interpret the author's short command as a player action and resolve it INTO the story. Simulate consequences, advance the scene, stay in-character as the narrator.`
    : `You are a literary co-writer. (Genre-agnostic — follow the story's established genre and tone; do not force horror or thriller framing.)
Continue the author's prose seamlessly — preserve their voice, tense, pacing, and characterization. Advance the scene naturally.`;

  const parts = [
    role,
    `POV: ${povDirective(authoringMode, authoringPov)}`,
    personaOverlay(persona),
    loreBlock(lore),
    narrativeStyleInstructions ? `NARRATIVE STYLE:\n${narrativeStyleInstructions}` : "",
    language ? RULES_LANGUAGE_LOCALIZATION : "",
    RULES_STORY_CONSISTENCY,
  ].filter(Boolean);

  return parts.join("\n\n");
}

/**
 * Renders a compact canonical block from story state: established facts,
 * main character overview, memory integrity, and the current page number.
 * This is the "do not contradict" canon the generation must respect.
 */
function buildCanonicalBlock(state: StoryState | null, mcName: string, language: string, canon?: {
  storyStartDate?: string | null;
  momentum?: string | null;
  sceneType?: string | null;
}): string {
  const lines: string[] = [];

  if (state) {
    const info = getStoryStateInfo(state);
    lines.push(`CURRENT PAGE: ${info.currentPage} of ${info.totalPages}`);
  }
  if (canon?.storyStartDate) lines.push(`STORY DATE: ${canon.storyStartDate}`);
  if (canon?.momentum) lines.push(`MOMENTUM: ${canon.momentum}`);
  if (canon?.sceneType) lines.push(`SCENE TYPE: ${canon.sceneType}`);

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

  if (language) lines.push(`WRITE IN LANGUAGE: ${language}`);

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
 * Returns both `systemPrompt` and `userPrompt` so persona, lore, narrative
 * style, POV, and genre framing can vary per book — the roadmap's §1.f shape.
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
    storyStartDate?: string | null;
    momentum?: string | null;
    sceneType?: string | null;
  } & (
    | { prose: string; directionHint?: string }
    | { command: string }
  )
): PenContinuePrompt {
  const { state, authoringMode, authoringPov, persona, lore, pageTexts, mcName, language } = params;

  const canon = buildCanonicalBlock(state ?? null, mcName, language, {
    storyStartDate: "storyStartDate" in params ? params.storyStartDate : undefined,
    momentum: "momentum" in params ? params.momentum : undefined,
    sceneType: "sceneType" in params ? params.sceneType : undefined,
  });
  const prose = buildProseContext(pageTexts);
  const narrativeStyleInstructions = state ? createNarrativeStyle(state).instructions : undefined;

  const systemPrompt = buildPenSystemPrompt({
    authoringMode,
    authoringPov,
    persona,
    lore,
    narrativeStyleInstructions,
    language,
  });

  if (authoringMode === "text_adventure") {
    const command = "command" in params ? params.command : "";
    return {
      systemPrompt,
      userPrompt: `CANONICAL STATE (do not contradict):
${canon}

RECENT STORY:
${prose}

PLAYER COMMAND:
> ${command}

Resolve the command into the story. Write ONLY the continuation text (no ">", no out-of-character notes).`,
    };
  }

  const proseParam = "prose" in params ? params.prose : "";
  const hint = "directionHint" in params && params.directionHint ? `\nAUTHOR DIRECTION: ${params.directionHint}` : "";

  return {
    systemPrompt,
    userPrompt: `CANONICAL STATE (do not contradict):
${canon}

RECENT STORY:
${prose}

AUTHOR'S FRAGMENT:
${proseParam}${hint}

Continue the story. Write ONLY the continuation text — do not repeat the author's fragment.`,
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
