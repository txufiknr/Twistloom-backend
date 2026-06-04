import type { Book } from "./book.js";
import type { CandidateGenerationPage } from "./candidate-generation.js";
import type { StoryState, UserStoryPage } from "./story.js";

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
  previousPages: UserStoryPage[],
  candidateCount: number;
}