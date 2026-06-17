/**
 * Available thread statuses for story progression tracking
 * 
 * These statuses track the lifecycle of narrative threads
 * from introduction through development to resolution.
 */
export const threadStatuses = [
  "open",        // Thread is active and unresolved
  "developing",  // Thread is evolving and gaining complexity
  "revealed",    // Thread's truth has been partially disclosed
  "closed",      // Thread has been resolved
  "twisted"      // Thread has undergone a plot twist
] as const;

/**
 * Available thread priorities for narrative focus
 * 
 * These priorities determine how much narrative attention
 * and screen time each thread receives.
 */
export const threadPriorities = [
  "main",        // Primary story driver
  "secondary",   // Important supporting thread
  "minor"        // Background detail thread
] as const;

/**
 * Available thread truth values for reality tracking
 * Answers: "Does this mystery correspond to something real?"
 * 
 * These track the fundamental nature of thread content
 * and whether it reflects actual reality.
 */
export const threadTruths = [
  "true",        // Thread reflects actual reality
  "false",       // Thread is deception/misdirection
  "unknown"      // Thread's reality status is unclear
] as const;

/**
 * Union type of all possible thread status values
 * 
 * Generated from the threadStatuses array to ensure type safety
 * and autocomplete support for status selection.
 */
export type ThreadStatus = typeof threadStatuses[number];

/**
 * Union type of all possible thread priority values
 * 
 * Generated from the threadPriorities array to ensure type safety
 * when specifying thread importance.
 */
export type ThreadPriority = typeof threadPriorities[number];

/**
 * Union type of all possible thread truth values
 * 
 * Generated from the threadTruths array to ensure type safety
 * when tracking thread reality status.
 */
export type ThreadTruth = typeof threadTruths[number];

export interface StoryThread {
  threadId: string;

  // What the mystery is
  title: string;
  question: string;

  // Narrative role
  priority: ThreadPriority;
  status: ThreadStatus;

  // Truth layer
  truth: ThreadTruth;

  // Lifecycle tracking
  introducedAt: number;
  lastUpdatedAt: number;

  // Narrative control
  importance: number; // 0–1 (drives focus frequency)
  urgency: number;    // 0–1 (how close to resolution)

  // Clues & progression
  clues: ThreadClue[];

  // Resolution
  summary?: string;
  resolution?: string;
}

/**
 * Thread update operations for AI-generated content
 * 
 * Defines the structure for thread updates that can be requested from AI
 * during story generation, including new thread creation, existing thread
 * modifications, and clue additions.
 */
export interface ThreadUpdates {
  /** New threads to create (max 1-2 per page) */
  newThreads?: NewThread[];
  /** Updates to existing threads by title */
  updateThreads?: UpdateThread[];
  /** Clues to add to existing threads by title */
  addClues?: AddThreadClue[];
  /** Threads to close/resolve by title */
  closeThreads?: string[];
}

export type NewThread = Pick<StoryThread,
  | 'threadId'
  | 'title'
  | 'question'
  | 'priority'
  | 'truth'
  | 'importance'
  | 'summary'> & { clues?: InitialThreadClue[] };

export type UpdateThread = {
  threadId: string;
  status?: ThreadStatus;
  priority?: ThreadPriority;
  truth?: ThreadTruth;
  importance?: number;
  urgencyCorrection?: number;
  summary?: string;
  resolution?: string;
};

export type ThreadClue = {
  clue: string;
  isFalse?: boolean;
  discoveredAtPage: number;
};

export type InitialThreadClue = Omit<ThreadClue, 'discoveredAtPage'>;
export type AddThreadClue = InitialThreadClue & {
  threadId: string;
};
