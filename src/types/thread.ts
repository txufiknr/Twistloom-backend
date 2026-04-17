export type ThreadStatus = 'open' | 'developing' | 'revealed' | 'closed' | 'twisted';

export type ThreadPriority = 'main' | 'secondary' | 'minor';

export type ThreadTruth = 'true' | 'false' | 'unknown';

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