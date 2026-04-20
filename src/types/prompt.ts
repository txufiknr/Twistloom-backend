import type { Book } from "./book.js";
import type { StoryState, ActionedStoryPage, Action, UserStoryPage } from "./story.js";

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
  /** Whether this is a user-selected action or just candidate pre-generation */
  isUserAction?: boolean;
};

/**
 * Parameters for choosing an action in a story
 */
export type ChooseActionParams = {
  /** User identifier for whom action is being chosen */
  userId: string;
  /** The action text being chosen (will be matched against current page actions) */
  actionText: string;
  /** Whether this is a user-selected action or just candidate pre-generation */
  isUserAction?: boolean;
  /** Current page context */
  currentPage?: UserStoryPage | null;
};