import type { Book } from "./book.js";
import type { Action, PersistedStoryPage, StoryState, UserStoryPage } from "./story.js";

/**
 * Result interface for parallel candidate generation
 */
export interface CandidateGenerationResult {
  /** The action that was processed */
  action: Action;
  /** Whether the generation succeeded */
  success: boolean;
  /** The generated candidate page (if successful) */
  candidatePage: PersistedStoryPage | null;
  /** The error that occurred (if failed) */
  error: unknown;
}

/**
 * Parameters for parallel candidate generation
 */
export interface GenerateCandidatesInParallelParams {
  /** User ID for database operations */
  userId: string;
  /** Actions to generate candidates for */
  actions: Action[];
  /** Current page context */
  currentPage: UserStoryPage;
  /** Current story state */
  currentState: StoryState | null | undefined;
  /** Current book context */
  currentBook: Book | null;
  /** Whether to generate new branch IDs for subsequent actions */
  initialGenerateNewBranchId: boolean;
  /** Timeout for each generation operation */
  timeoutMs: number;
  /** Current depth level for multi-level pre-generation */
  currentDepth: number;
  /** Maximum depth to pre-generate */
  maxDepth: number;
}