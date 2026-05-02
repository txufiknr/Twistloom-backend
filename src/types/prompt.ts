import type { Book } from "./book.js";
import type { StoryState, ActionedStoryPage, UserStoryPage, Action } from "./story.js";

export type GenerateBookCreationPromptParams = {
  logPrompts?: boolean,
  signal?: AbortSignal;
};

/**
 * Parameters for building the next page in a story
 */
export type BuildNextPageParams = {
  /** User identifier for whom page is being generated */
  userId: string;
  /** Book information containing metadata and settings */
  book: Book;
  /** Story state for current page (page number not incremented yet) */
  currentState: StoryState;
  /** Current page with selected action for context */
  actionedPage: ActionedStoryPage;
  /** Whether next page should have new branchId */
  generateNewBranchId?: boolean;
};

export type BuildNextPagePromptParams = {
  book: Book,
  actionedPage: ActionedStoryPage,
  advancedState: StoryState,
  previousPages: UserStoryPage[]
}

/**
 * Parameters for generating a candidate page for an action
 */
export type GenerateCandidatePageParams = {
  /** User identifier for whom candidate page is being generated */
  userId: string;
  /** The action for which to generate a candidate (will be matched against current page actions) */
  action: Action;
  /** Current page context */
  currentPage?: UserStoryPage | null;
  /** Optional current story state (avoids database lookup when provided) */
  currentState?: StoryState | null;
  /** Optional book context (avoids session lookup when provided, e.g., for system-generated originals) */
  currentBook?: Book | null;
  /** Whether candidate page should have new branchId */
  generateNewBranchId?: boolean;
};