import type { Book } from "./book.js";
import type { StoryState, ActionedStoryPage, UserStoryPage } from "./story.js";

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
  /** Story state for previous page (page number not incremented yet) */
  previousState: StoryState;
  /** Previous page with selected action for context */
  actionedPage: ActionedStoryPage;
};

/**
 * Parameters for generating a candidate page for an action
 */
export type GenerateCandidatePageParams = {
  /** User identifier for whom candidate page is being generated */
  userId: string;
  /** The action text for which to generate a candidate (will be matched against current page actions) */
  actionText: string;
  /** Current page context */
  currentPage?: UserStoryPage | null;
  /** Optional current story state (avoids database lookup when provided) */
  currentState?: StoryState | null;
};