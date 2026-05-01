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
  "secondary",  // Important supporting thread
  "minor"        // Background detail thread
] as const;

/**
 * Available thread truth values for reality tracking
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

  id: string;

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
  plannedRevealAt?: number;

  // Narrative control
  importance: number; // 0–1 (drives focus frequency)
  urgency: number;    // 0–1 (how close to resolution)

  // Clues & progression
  clues: string[];
  falseClues: string[];

  // Resolution
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
  newThreads?: Array<{
    title: string;
    question: string;
    priority: ThreadPriority;
    truth: ThreadTruth;
    importance?: number;
  }>;
  
  /** Updates to existing threads by ID */
  updateThreads?: Array<{
    id: string;
    status?: ThreadStatus;
    priority?: ThreadPriority;
    truth?: ThreadTruth;
    importance?: number;
    urgency?: number;
    resolution?: string;
  }>;
  
  /** Clues to add to existing threads by ID */
  addClues?: Array<{
    threadId: string;
    clue: string;
    isFalse?: boolean;
  }>;
  
  /** Threads to close/resolve by ID */
  closeThreads?: string[];
}