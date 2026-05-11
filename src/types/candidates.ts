import type { Book } from "./book.js";
import type { Action, PersistedStoryPage, StoryState, UserStoryPage } from "./story.js";

export type CandidateGenerationStrategy = 'vercel' | 'github-action' | 'cron';

/**
 * Generation strategy options
 */
export interface GenerationStrategy {
  /** Whether to use parallel generation (default: true) */
  useParallel?: boolean;
  /** Whether to enforce Vercel timeout limits (default: true) */
  enforceVercelLimits?: boolean;
  /** Custom timeout in milliseconds (overrides calculated timeout) */
  customTimeoutMs?: number;
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
 * Progress event for individual action generation
 */
export interface ActionProgressEvent {
  /** Action text being processed */
  action: string;
  /** Current status of the action */
  status: ActionProgressStatus;
  /** Number of actions completed so far */
  completed: number;
  /** Total number of actions to process */
  total: number;
  /** Progress percentage (0-100) */
  progress: number;
  /** Error message if status is 'failed' */
  error?: string;
  /** ISO timestamp of when the event occurred */
  timestamp: string;
}

export type ActionProgressStatus = 'started' | 'completed' | 'failed';
export type ActionProgressCallback = (
  action: Action,
  status: ActionProgressStatus,
  result?: PersistedStoryPage,
  error?: unknown
) => void;

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
  /** Optional progress callback for real-time tracking */
  onProgress?: ActionProgressCallback;
}