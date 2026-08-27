/**
 * Companion (reader AI Q&A) prompt builders.
 *
 * Provides the system prompt and user-prompt builder for the reader companion
 * panel's "Ask" mode — a grounded Q&A call that answers reader questions about
 * the story using only the current page's context (characters, places, threads,
 * plotFlags, actionsHistory, contextHistory).
 *
 * Prompt caching: the system prompt is a STATIC const so it forms a stable,
 * globally-shared prefix that provider-side prompt caches hit across every book.
 * ALL volatile fields (page context, user question) are deferred into the user
 * prompt.
 *
 * Spoiler safety: the prompt explicitly instructs the model to never reveal
 * unrevealed canon secrets. It can give educated guesses and possibilities but
 * must never state future events as fact.
 *
 * @see docs/roadmap/AI_NATIVE_FICTION_PLATFORM_ROADMAP.md §1.4
 */

import type { AIJsonProperty } from "../types/ai-chat.js";
import type { StoryState } from "../types/story.js";
import { RULES_LANGUAGE_LOCALIZATION } from "./prompt.js";
import { formatLanguage } from "./translation.js";
import { resolveCharacterDisplayName } from "./characters.js";
import { resolvePlaceDisplayName } from "./places.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Semantic vector memory context (retrieved from pgvector tables). */
export interface CompanionSemanticContext {
  /** Semantically relevant past scene excerpts (from pageEmbeddings). */
  relevantPastScenes?: Array<{ page: number; sourceText: string | null; similarity?: number }>;
  /** Semantically relevant thread clues (from clueEmbeddings). */
  relevantClues?: Array<{ page: number; threadId?: string; sourceText: string | null; similarity?: number }>;
}

/** Minimal page context the prompt builder needs (subset of EnrichedStoryPage). */
export interface CompanionPageContext {
  /** Narrative context history (story summary up to this page). */
  contextHistory: string;
  /** Characters present in the story up to this page. */
  characters: Array<{ name: string; role?: string; bio?: string; status?: string }>;
  /** Places known up to this page. */
  places: Array<{ name: string; context?: string }>;
  /** Plot flags (established facts) up to this page. */
  plotFlags: Array<{ type: string; fact: string; page: number; isMajorEvent?: boolean }>;
  /** Actions taken so far. */
  actionsHistory: Array<{ text: string }>;
  /** Story threads being tracked. */
  threads: Array<{ title: string; question: string; summary?: string }>;
  /** Optional pgvector semantic retrieval augmentation. */
  semanticContext?: CompanionSemanticContext;
}

/** A single prior turn in the active companion chat session. */
export interface CompanionChatTurn {
  question: string;
  answer: string;
}

/** Result of building a companion Q&A prompt. */
export type CompanionPrompt = {
  systemPrompt: string;
  userPrompt: string;
};

/** Structured output shape for the companion answer. */
export type CompanionResult = {
  answer: string;
  sources: string[];
  suggestedFollowUps: string[];
};

/** Structured-output schema for the companion answer. */
export const COMPANION_RESULT_SCHEMA: Record<keyof CompanionResult, AIJsonProperty> = {
  answer: {
    type: "string",
    description:
      "A grounded answer to the reader's question, based only on the provided story context. " +
      "Never reveal unrevealed canon secrets; give possibilities, not spoilers.",
  },
  sources: {
    type: "array",
    description:
      "Short labels identifying which context sections the answer draws from " +
      '(e.g. "Characters", "Plot Events", "Story Threads", "Story Summary").',
    items: { type: "string" },
  },
  suggestedFollowUps: {
    type: "array",
    description:
      "2-4 natural follow-up questions the reader might want to ask next, " +
      "grounded in the same page context. Each must be a complete question string.",
    items: { type: "string" },
  },
};

/** Required fields for the companion structured output. */
export const COMPANION_RESULT_REQUIRED_FIELDS: (keyof CompanionResult)[] = [
  "answer",
  "sources",
  "suggestedFollowUps",
];

// ── System prompt ──────────────────────────────────────────────────────────

/**
 * Static, cache-friendly system prompt for the reader companion Q&A.
 *
 * A pure string const — no interpolation at request time — so it ships on
 * every companion call and stays a stable prefix for provider-side prompt
 * caching.
 *
 * All volatile content (page context, user question) lives in the user prompt.
 */
export const COMPANION_SYSTEM = `You are the Story Companion — a knowledgeable guide who has read the story up to the current page and answers reader questions about it.

CRITICAL SPOILER SAFETY:
- NEVER reveal events that have not yet happened in the story. You only know what has occurred up to the current page.
- When the reader asks about future events, characters' true intentions, or hidden truths that haven't been revealed yet, you MUST say you don't know for certain. You MAY offer educated guesses, theories, or possibilities — but you must clearly label them as speculation, not fact.
- You may discuss anything that HAS been established in the story context provided: characters, places, events, plot threads, and actions taken so far.
- If a question asks "what happens next?" or "will X happen?", respond with "I can only tell you what has happened so far" and then summarize the relevant known context.

RESPONSE STYLE:
- Be concise and helpful — answer in 2-4 sentences unless the question requires more detail.
- Use the story's tone and language. Match the narrative voice when quoting or paraphrasing.
- Ground every claim in the provided context. If the context doesn't contain enough information to answer, say so honestly.
- Never invent details that aren't supported by the context.

FOLLOW-UP QUESTIONS:
- After answering, suggest 2-4 natural follow-up questions the reader might want to ask. These should be grounded in the same page context and reflect genuine reader curiosity (e.g. "What does Marcus know about the diary?", "Can I trust Elena?", "What happened at the lighthouse?").
- Each follow-up must be a complete, standalone question string.
- Focus on character motivations, hidden relationships, unresolved mysteries, and plot implications.

${RULES_LANGUAGE_LOCALIZATION}`;

// ── User prompt builder ────────────────────────────────────────────────────

/**
 * Builds the user prompt for a companion Q&A call.
 *
 * The prompt is ordered stable-per-session first (context sections) and the
 * user's question last, matching the pen-prompt caching convention.
 *
 * @param context - Current page context (characters, places, threads, etc.)
 * @param question - The reader's question
 * @param language - Story language code (e.g. "en", "id")
 * @param mcName - Main character name (for labeling context)
 * @returns The user prompt string
 */
export function buildCompanionUserPrompt(
  context: CompanionPageContext,
  question: string,
  language: string,
  mcName: string,
  history?: CompanionChatTurn[]
): string {
  const sections: string[] = [];

  // Language directive
  sections.push(`WRITE IN LANGUAGE: ${formatLanguage(language)}`);

  // Story summary (stable, cacheable prefix)
  if (context.contextHistory) {
    sections.push(`STORY SUMMARY:\n${context.contextHistory}`);
  }

  // Characters
  if (context.characters.length > 0) {
    const charLines = context.characters.map((c) => {
      const parts = [c.name];
      if (c.role) parts.push(`role:${c.role}`);
      if (c.bio) parts.push(c.bio);
      if (c.status) parts.push(`status:${c.status}`);
      return `- ${parts.join(" — ")}`;
    });
    sections.push(`KNOWN CHARACTERS:\n${charLines.join("\n")}`);
  }

  // Places
  if (context.places.length > 0) {
    const placeLines = context.places.map((p) => {
      const parts = [p.name];
      if (p.context) parts.push(p.context);
      return `- ${parts.join(": ")}`;
    });
    sections.push(`KNOWN PLACES:\n${placeLines.join("\n")}`);
  }

  // Plot flags (established facts)
  if (context.plotFlags.length > 0) {
    const flagLines = context.plotFlags.map((f) => `- [Page ${f.page}] ${f.type}: ${f.fact}`);
    sections.push(`ESTABLISHED FACTS (PLOT EVENTS):\n${flagLines.join("\n")}`);
  }

  // Actions taken
  if (context.actionsHistory.length > 0) {
    const actionLines = context.actionsHistory.map((a) => `- ${a.text}`);
    sections.push(`ACTIONS TAKEN SO FAR:\n${actionLines.join("\n")}`);
  }

  // Story threads
  if (context.threads.length > 0) {
    const threadLines = context.threads.map((t) => {
      const parts = [`"${t.title}"`];
      if (t.question) parts.push(`question: ${t.question}`);
      if (t.summary) parts.push(`summary: ${t.summary}`);
      return `- ${parts.join(" — ")}`;
    });
    sections.push(`STORY THREADS:\n${threadLines.join("\n")}`);
  }

  // Main character label
  if (mcName) {
    sections.push(`MAIN CHARACTER: ${mcName}`);
  }

  // Semantically recalled clues & past scene moments (pgvector memory)
  if (context.semanticContext) {
    const memoryItems: string[] = [];
    const seenTexts = new Set<string>();

    if (context.semanticContext.relevantClues && context.semanticContext.relevantClues.length > 0) {
      for (const clue of context.semanticContext.relevantClues) {
        const text = (clue.sourceText || "").trim();
        if (text && !seenTexts.has(text.toLowerCase())) {
          seenTexts.add(text.toLowerCase());
          memoryItems.push(`- [Page ${clue.page}] Clue: ${text}`);
        }
      }
    }
    if (context.semanticContext.relevantPastScenes && context.semanticContext.relevantPastScenes.length > 0) {
      for (const scene of context.semanticContext.relevantPastScenes) {
        const text = (scene.sourceText || "").trim();
        if (text && !seenTexts.has(text.toLowerCase())) {
          seenTexts.add(text.toLowerCase());
          memoryItems.push(`- [Page ${scene.page}] Past Scene: ${text}`);
        }
      }
    }
    if (memoryItems.length > 0) {
      sections.push(`RELEVANT HISTORICAL CLUES & PAST MOMENTS (SEMANTIC RECALL):\n${memoryItems.join("\n")}`);
    }
  }

  // Recent conversation history (last 3 turns max, truncated to avoid ballooning context)
  if (history && history.length > 0) {
    const recentTurns = history.slice(-3).map((turn) => {
      const q = turn.question.trim().slice(0, 300);
      const a = turn.answer.trim().slice(0, 400);
      return `Reader: ${q}\nCompanion: ${a}`;
    });
    sections.push(`RECENT CONVERSATION:\n${recentTurns.join("\n\n")}`);
  }

  // User question (last — changes every turn)
  sections.push(`READER'S CURRENT QUESTION:\n${question}`);

  return sections.join("\n\n");
}

/** Options for building companion page context with hybrid pruning & semantic memory. */
export interface BuildCompanionPageContextOptions {
  /** Current page number (1-indexed) for recency horizon calculations. */
  currentPageNumber?: number;
  /** Optional pgvector semantic retrieval augmentation. */
  semanticContext?: CompanionSemanticContext;
}

/**
 * Builds a {@link CompanionPageContext} from raw story state, applying
 * spoiler-safe name resolution via {@link resolveCharacterDisplayName}
 * and {@link resolvePlaceDisplayName}.
 *
 * Implements 3-tier hybrid pruning:
 * - All `isMajorEvent: true` and discovery/milestone plot flags are ALWAYS preserved.
 * - Minor ambient flags older than 5 pages are pruned.
 * - Semantic vector recall (clues & past pages) are attached to `semanticContext`.
 *
 * @param storyState - Full story state from `getStoryStateWithBranch`
 * @param options - Context pruning and semantic memory options
 * @returns A `CompanionPageContext` ready for the prompt builder
 */
export function buildCompanionPageContext(
  storyState: Pick<
    StoryState,
    "characters" | "places" | "plotFlags" | "actionsHistory" | "contextHistory" | "threads"
  >,
  options?: BuildCompanionPageContextOptions
): CompanionPageContext {
  const characters = storyState.characters
    ? Object.values(storyState.characters).map((c) => ({
        name: resolveCharacterDisplayName(c),
        role: c.role,
        bio: c.bio,
        status: c.status,
      }))
    : [];

  const places = storyState.places
    ? Object.values(storyState.places).map((p) => ({
        name: resolvePlaceDisplayName(p),
        context: p.context,
      }))
    : [];

  const rawFlags = storyState.plotFlags ?? [];
  const currentPage = options?.currentPageNumber;

  // Hybrid plot flag pruning:
  // 1. ALWAYS preserve all major events / discoveries across the whole story history
  // 2. For minor ambient flags, keep only those from the last 5 pages
  const plotFlags = rawFlags.filter((f) => {
    if (f.isMajorEvent) return true;
    const typeLower = (f.type || "").toLowerCase();
    if (
      typeLower.includes("discovery") ||
      typeLower.includes("milestone") ||
      typeLower.includes("revelation") ||
      typeLower.includes("clue") ||
      typeLower.includes("death") ||
      typeLower.includes("betrayal")
    ) {
      return true;
    }
    if (currentPage && currentPage > 5) {
      return f.page >= currentPage - 5;
    }
    return true;
  });

  const actionsHistory: Array<{ text: string }> =
    storyState.actionsHistory ?? [];

  const threads: Array<{ title: string; question: string; summary?: string }> =
    storyState.threads ?? [];

  return {
    contextHistory: storyState.contextHistory ?? "",
    characters,
    places,
    plotFlags,
    actionsHistory,
    threads,
    semanticContext: options?.semanticContext,
  };
}
