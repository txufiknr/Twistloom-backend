import type { Book, BookMode, StoryGenerationStep } from "./book.js";
import type { CandidateGenerationPage } from "./candidate-generation.js";
import type { ActionedStoryPage, StoryState } from "./story.js";
import type { AIChatConfig, AIDocument, AIJsonProperty, GenerationStage } from "./ai-chat.js";
import type { ProgressCallback } from "./sse.js";

export type GenerateBookCreationPromptParams = {
  /** Whether to include prompt generation logging information. */
  logPrompts?: boolean;
  /** Abort signal used to cancel prompt generation. */
  signal?: AbortSignal;
  /** Language code from Accept-Language header (e.g. 'en', 'es'). */
  language?: string | null;
  /** Initiator user id who requested or generated this prompt. */
  userId?: string | null;
  /** Optional book title to guide the generated story concept (AI context). */
  title?: string | null;
  /** Optional existing summary/blurb to expand into a fuller story concept. */
  summary?: string | null;
};

/**
 * Parameters for building the next page in a story
 */
export type BuildNextPageParams = {
  /** User identifier for whom page is being generated */
  userId: string;
  /** Book information containing metadata and settings */
  book: Book;
  /** Story state for current page (can be provided for faster generation) */
  currentState?: StoryState | null;
  /** Current page with selected action for generation context */
  actionedPage: CandidateGenerationPage;
  /** Whether next page should have new branchId */
  generateNewBranchId?: boolean;
  /** Number of candidate pages to generate per action (default: DEFAULT_CANDIDATE_PAGE_PER_ACTION) */
  candidateCount?: number;
  /** Opt-in generation-time canon/consistency pass */
  enableCanonValidation?: boolean;
  /**
   * Optional SSE/progress hooks — threaded through to every underlying
   * aiPrompt/executePromptForJSON call (both the legacy single-shot path
   * and the multi-turn StoryPage/StateDelta/evaluation calls) so callers
   * that DO supply them get consistent progress events regardless of which
   * path USE_MULTI_TURN_GENERATION selects. Added at checkpoint 5
   * (external review) for parity — no caller in this codebase passes them
   * today (the legacy path never accepted them either, so this isn't a
   * regression fix so much as making both paths equally capable going
   * forward, and removing any doubt about it either way).
   */
  onProgress?: ProgressCallback;
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>;
};

export type BuildNextPagePromptParams = {
  book: Book,
  /** Book creation mode (story format) — drives branching behaviour in prompts */
  mode?: BookMode,
  actionedPage: CandidateGenerationPage,
  advancedState: StoryState,
  previousPages: ActionedStoryPage[],
  candidateCount: number;
  /**
   * pgvector semantic memory (Use Case 1) — pre-computed "RELEVANT PAST
   * EVENTS" prompt block, via buildRelevantPastEventsBlock() in
   * prepareNextPageGenerationSetup, before this params object is built.
   * Computed once and reused by both buildNextPagePrompt and
   * buildNextPageEvaluatorPrompt, since they'd otherwise each trigger their
   * own identical (and wasteful) Jina retrieval call.
   * Undefined/empty string means "nothing relevant found, omit the block" —
   * formatNextPageStoryContextPrompt treats both the same way.
   */
  relevantPastEventsBlock?: string;
  /**
   * pgvector semantic memory (Use Case 3) — ranked note keys for the
   * unscheduled future-notes bucket, ordered by semantic similarity to
   * the current scene query. Computed once in
   * prepareNextPageGenerationSetup alongside the other semantic redisplays.
   * When provided, formatFutureNotes() displays the unscheduled bucket in
   * this order rather than the default chronological sort.
   */
  relevantFutureNoteKeys?: string[];
  /**
   * pgvector semantic memory (Use Case 4) — pre-computed "Earlier clues
   * (recalled)" blocks keyed by threadId, for clues that have scrolled out
   * of formatActiveThreads()'s live MAX_THREADS_CLUES display window.
   * Computed once in prepareNextPageGenerationSetup, alongside
   * characterRecallBlocks/placeRecallBlocks. Read by
   * formatNextPageNarrativePrompt and passed down through
   * formatThreadsPrompt to formatActiveThreads.
   */
  clueRecallBlocks?: Record<string, string>;
  /**
   * Resolved evaluator strategy — whether the evaluation schema's `output`
   * field is a JSON string (true) or a structured object (false). Defaults
   * to the auto resolution used by aiPrompt: true when Gemini is in the
   * evaluator chain (see resolveUseStringEvaluator). Threaded into
   * buildNextPageEvaluatorPrompt so its OUTPUT FORMAT example matches the
   * schema actually sent to the AI.
   */
  useStringEvaluatorOutput?: boolean;
}

/**
 * Everything runGenerationStage (prompt.ts) needs to run ONE generation turn
 * through executePromptForJSON — parameterized by T so the same runner
 * serves both the StoryPage turn (T = StoryPageGeneration) and the
 * StateDelta turn (T = StateDeltaGenerationWithBranch).
 * MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 2.3/3 Phase 3.
 *
 * No `evaluatorPrompt` field — per-turn evaluation was removed at
 * checkpoint 2 (Part 5.5 Q2, see evaluateMergedStoryGeneration); evaluation
 * runs once, after both turns are merged, not per stage.
 */
export type GenerationStageDefinition<T extends Record<string, unknown>> = {
  /**
   * Which turn this is. Used by runGenerationStage to suffix `cachedContentId`
   * (`:story_page` / `:state_delta`) so Turn A and Turn B never collide on
   * the same Gemini explicit-cache slot despite sending different system
   * prompts (see the Gemini cache-collision finding, roadmap Part 0.5 item
   * 1) — and to suffix the log `context` string the same way.
   */
  stage: GenerationStage;
  prompt: string;
  systemPrompt: string;
  fieldInstructions: string;
  reviewChecklist: string;
  jsonStructure: string;
  schema: Record<keyof T, AIJsonProperty>;
  requiredFields: (keyof T)[];
  fallbackField: keyof T;
  /** Base AI config (from determineAIConfig — dynamic per advancedState/psychological progress, NOT a static preset) — runGenerationStage spreads this with the per-stage `maxOutputToken` override, matching the pattern generateNextPage(s) already use for their single combined call. */
  config: AIChatConfig;
  maxOutputToken: number;
  documents: AIDocument[];
  /** Base cache key from buildBookMetaDocuments — runGenerationStage appends `:${stage}`. Omitted when the caller has no book-level cache key to share (shouldn't normally happen for next-page generation, but kept optional for robustness). */
  cachedContentId?: string;
  /** Base context string (e.g. `next-page-2turn:b-${bookId}`) — runGenerationStage appends `:${stage}`. */
  context: string;
  bookId: string;
};