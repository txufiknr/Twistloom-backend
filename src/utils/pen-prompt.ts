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
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §1.b, §6.3, §6.7
 */

import type { StoryState } from "../types/story.js";
import type { AuthoringMode } from "../types/pen.js";
import type { AIJsonProperty } from "../types/ai-chat.js";
import { getStoryStateInfo } from "./story.js";
import { PROMPT_SYSTEM, RULES_STORY_CONSISTENCY } from "./prompt.js";

/** Number of prior pages of context included in a `/continue` prompt. */
const PEN_CONTEXT_PAGES = 2;

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
      const parts = [c.knownName || c.realName || 'unknown'];
      if (c.gender) parts.push(`gender:${c.gender}`);
      if (c.role) parts.push(`role:${c.role}`);
      if (c.bio) parts.push(c.bio);
      if (c.appearance) parts.push(`appearance:${c.appearance}`);
      if (c.status) parts.push(`status:${c.status}`);
      return parts.join(' — ');
    });
    lines.push(`KNOWN CHARACTERS:\n${characterLines.join('\n')}`);
  }

  if (state?.factsHistory && Object.keys(state.factsHistory).length > 0) {
    const factLines: string[] = [];
    for (const [key, entries] of Object.entries(state.factsHistory)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const suffix = entry.reason ? ` (${entry.reason})` : '';
        factLines.push(entry.value ? `${key}: ${entry.value}${suffix}` : `${key}${suffix}`);
      }
    }
    if (factLines.length > 0) lines.push(`ESTABLISHED FACTS:\n${factLines.join('\n')}`);
  }

  if (state?.plotFlags && Object.keys(state.plotFlags).length > 0) {
    const flags = state.plotFlags.map((f) => (typeof f === 'string' ? f : String(f)));
    lines.push(`PLOT FLAGS: ${flags.join(', ')}`);
  }

  if (language) lines.push(`WRITE IN LANGUAGE: ${language}`);

  return lines.join('\n');
}

/**
 * Renders the recent prose context (last N page texts) so the continuation is
 * stylistically and narratively continuous. Page texts are trimmed to avoid
 * blowing the context budget.
 */
function buildProseContext(texts: string[]): string {
  const usable = texts.slice(-PEN_CONTEXT_PAGES).filter(Boolean);
  if (usable.length === 0) return '(This is the first page — open the scene.)';
  return usable.map((t) => t.trim()).join('\n\n');
}

export type PenPromptBuilders = {
  /** Storyteller: continue the prose. */
  storyteller: (params: {
    prose: string;
    directionHint?: string;
    draftText?: string;
  }) => string;
  /** Text adventure: resolve a player command. */
  text_adventure: (params: { command: string; draftText?: string }) => string;
};

/**
 * Builds the `/continue` user prompt for a given authoring mode.
 *
 * @param state - Current story state (already advanced past the last page).
 * @param params - Shared context: last page texts, prose/command, mc name, language.
 * @returns A full user prompt implementing the single-request validate-and-generate contract.
 */
export function buildPenContinuePrompt(
  params: {
    state?: StoryState | null;
    authoringMode: AuthoringMode;
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
): string {
  const { state, authoringMode, pageTexts, mcName, language } = params;

  const canon = buildCanonicalBlock(state ?? null, mcName, language, {
    storyStartDate: 'storyStartDate' in params ? params.storyStartDate : undefined,
    momentum: 'momentum' in params ? params.momentum : undefined,
    sceneType: 'sceneType' in params ? params.sceneType : undefined,
  });
  const prose = buildProseContext(pageTexts);

  if (authoringMode === 'text_adventure') {
    const command = 'command' in params ? params.command : '';
    return `You are the game master / world simulator for a psychological thriller.
The player wrote a short command. Resolve it INTO the story — keep it in the same voice, tense, and POV as the recent prose. Describe consequences. Stay in-character as the narrator.

${RULES_STORY_CONSISTENCY}

CANONICAL STATE (do not contradict):
${canon}

RECENT STORY:
${prose}

PLAYER COMMAND:
> ${command}

Continue the story text in response to the command. Write ONLY the continuation text (no ">", no out-of-character notes).`;
  }

  const proseParam = 'prose' in params ? params.prose : '';
  const hint = 'directionHint' in params && params.directionHint ? `\nAUTHOR DIRECTION: ${params.directionHint}` : '';

  return `You are a co-writer continuing a psychological thriller. The author wrote the fragment below; continue it seamlessly in the same voice, tense, and POV, advancing the scene.

${RULES_STORY_CONSISTENCY}

CANONICAL STATE (do not contradict):
${canon}

RECENT STORY:
${prose}

AUTHOR'S FRAGMENT:
${proseParam}${hint}

Continue the story. Write ONLY the continuation text — do not repeat the author's fragment.`;
}

/**
 * The system prompt (writing style + base rules) used for all Pen continuations.
 * Reuses the engine's shared `PROMPT_SYSTEM` for stylistic consistency with
 * normally-generated pages.
 */
export const PEN_SYSTEM_PROMPT = PROMPT_SYSTEM;

/** Structured-output schema for the `/continue` self-report contract. */
export const PEN_CONTINUE_SCHEMA: Record<keyof PenContinueResult, AIJsonProperty> = {
  text: { type: 'string', description: 'The generated continuation text.' },
  issues: {
    type: 'array',
    description: 'Any canon contradiction the model could not avoid, or an empty array.',
    items: {
      type: 'object',
      properties: {
        seen: { type: 'string', description: 'What the draft says.' },
        expected: { type: 'string', description: 'What the canonical state requires.' },
      },
      required: ['seen', 'expected'],
    },
  },
};

/** Required fields for the `/continue` structured output. */
export const PEN_CONTINUE_REQUIRED_FIELDS: (keyof PenContinueResult)[] = ['text'];

/** Structured output shape: text plus a self-reported canon-issue list. */
export type PenContinueResult = {
  text: string;
  issues?: { seen: string; expected: string }[];
};