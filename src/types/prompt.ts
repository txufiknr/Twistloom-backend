import type { Book } from "./book.js";
import type { StoryState, ActionedStoryPage, UserStoryPage } from "./story.js";

export type GenerateBookCreationPromptParams = {
  /** Whether to */
  logPrompts?: boolean;
  /** */
  signal?: AbortSignal;
  /** Language code from Accept-Language header (e.g. 'en', 'es') */
  language?: string | null;
  /** Initiator user id who requested/generated this prompt */
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
  /** Current page with selected action for context */
  actionedPage: ActionedStoryPage;
  /** Whether next page should have new branchId */
  generateNewBranchId?: boolean;
};

export type BuildNextPagePromptParams = {
  book: Book,
  actionedPage: ActionedStoryPage,
  advancedState: StoryState,
  previousPages: UserStoryPage[],
  candidateCount: number;
}