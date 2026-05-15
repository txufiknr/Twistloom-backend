import type { Book } from "./book.js";
import type { Action, PersistedStoryPage, StoryState, UserStoryPage } from "./story.js";

/**
 * Candidate generation strategies for different deployment contexts
 */
export type CandidateGenerationStrategy =
  /** User-facing API requests with immediate response requirements */
  'vercel' |
  /** Automated workflows and manual CI/CD operations */
  'github-action' |
  /** Background processing and extended timeout operations */
  'cron';

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
  currentPage: UserStoryPage;
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
  /** Action text being processed (unique identifier) */
  action: string;
  /** Current status of the action */
  status: ActionProgressStatus;
  /** Error message if status is 'failed' */
  error?: string;
  /** ISO timestamp of when the event occurred */
  timestamp: string;
}

/** Status of an action generation operation */
export type ActionProgressStatus = 'started' | 'completed' | 'failed';
/** Callback for tracking per-action generation progress */
export type ActionProgressCallback = (
  /** The action being processed */
  action: Action,
  /** Current status of the action generation */
  status: ActionProgressStatus,
  /** Generated candidate page if successful */
  result?: PersistedStoryPage,
  /** Error if generation failed */
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
  currentState?: StoryState | null;
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
  /** Optional progress callback for per-action real-time tracking */
  onProgress?: ActionProgressCallback;
}

/** Parameters for generating candidates with a specific strategy */
export interface GenerateCandidatesWithStrategyParams {
  /** Generation strategy to use */
  strategy: CandidateGenerationStrategy;
  /** User ID for database operations */
  userId: string;
  /** Current page to generate candidates for */
  page: UserStoryPage;
  /** Current story state for context */
  currentState?: StoryState | null;
  /** Current book context */
  currentBook?: Book | null;
  /** Optional generation options */
  options?: GenerateCandidatesOptions
}

/** Optional configuration for candidate generation */
export interface GenerateCandidatesOptions {
  /** Timeout for each generation operation in milliseconds */
  timeoutMs?: number;
  /** Optional progress callback for per-action real-time tracking */
  onProgress?: ActionProgressCallback;
  /** Current depth level for multi-level pre-generation */
  currentDepth?: number;
  /** Maximum depth to pre-generate */
  maxDepth?: number;
}