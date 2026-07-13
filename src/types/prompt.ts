import type { Book } from "./book.js";
import type { CandidateGenerationPage } from "./candidate-generation.js";
import type { ActionedStoryPage, StoryState } from "./story.js";

export type GenerateBookCreationPromptParams = {
  /** Whether to include prompt generation logging information. */
  logPrompts?: boolean;
  /** Abort signal used to cancel prompt generation. */
  signal?: AbortSignal;
  /** Language code from Accept-Language header (e.g. 'en', 'es'). */
  language?: string | null;
  /** Initiator user id who requested or generated this prompt. */
  userId?: string | null;
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
};

export type BuildNextPagePromptParams = {
  book: Book,
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
}