import type { Book } from "./book.js";
import type { DBBook, DBPage } from "./schema.js";
import type { Action, PersistedStoryPage, StoryGeneration, StoryState, UserStoryPage } from "./story.js";

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
  /** Book context */
  currentBook: Book;
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
  candidatePages: PersistedStoryPage[];
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
  /** Destination pageId — present when status is 'completed' */
  destinationPageIds?: string[];
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
  candidatePages?: PersistedStoryPage[],
  /** Error if generation failed */
  error?: unknown
) => Promise<void>;

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
  currentBook: Book;
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
  /** Whether to allow generating deeper levels beyond currentDepth */
  allowDeeperLevel?: boolean;
  /** Callback for when an action is completed */
  onActionComplete?: (action: Action, candidatePages: PersistedStoryPage[]) => Promise<void>;
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
  /** Whether to allow generating deeper levels beyond currentDepth */
  allowDeeperLevel?: boolean;
}

export interface CandidateGenerationPageValidation {
  dbPage: DBPage;
  dbBook: DBBook;
  userPage: UserStoryPage | PersistedStoryPage;
  isGenerating: boolean;
  isDone: boolean;
  totalPendingActions: number;
}

/**
 * Result of candidate generation validation
 */
export interface CandidateGenerationValidation {
  /** Whether generation should proceed */
  canGenerate: boolean;
  /** Reason why generation cannot proceed (if applicable) */
  reason?: string;
  /** Book context (resolved if available) */
  book: Book | null;
  /** Actions that need generation */
  pendingActions: Action[];
  /** Current depth for generation */
  currentDepth: number;
  /** Maximum depth for generation */
  maxDepth: number;
}

export interface CandidateGenerationStatus {
  isGenerating: boolean;
  completedActions: number;
  totalActions: number;
  actions: Action[];
  actionProgress: ActionProgressEvent[];
  startedAt?: string;
  lastUpdated: string;
}

export type CandidatePagesGeneration = {
  generatedPages: StoryGeneration[];
  output?: string;
};
