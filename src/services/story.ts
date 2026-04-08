import { dbRead, dbWrite } from "../db/client.js";
import { eq, and } from "drizzle-orm";
import { storyStates, userSessions, userPageProgress, pages } from "../db/schema.js";
import type { StoryState, StoryProgress, UserActiveSession, Action, SetActiveSessionParams } from "../types/story.js";
import type { DBNewUserPageProgress, DBStoryState, DBUserSession } from "../types/schema.js";
import { getDeletedState } from "./story-state-cache.js";
import { getBook, getStoryPageById } from "./book.js";
import { getErrorMessage } from "../utils/error.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { updateUserLastActivity } from "./user.js";
import { cleanupStoryStatesWithStrategy } from "./story-branch.js";

/**
 * Retrieves the active session for a user including both bookId, current pageId, and branchId
 * 
 * @param userId - The user's unique identifier
 * @returns Promise that resolves to active session or null if no active session
 * 
 * Behavior:
 * - Queries user_sessions table for active status
 * - Joins with pages table to get branchId of the active page
 * - Returns bookId, pageId, previousPageId, and branchId from active session
 * - Handles cases where user has no active sessions
 * - Uses composite primary key for efficient lookup
 * 
 * Example:
 * ```typescript
 * const activeSession = await getActiveSession("user123");
 * if (activeSession) {
 *   console.log(`User is reading book ${activeSession.bookId} on page ${activeSession.pageId} in branch ${activeSession.branchId}`);
 * } else {
 *   console.log("User has no active reading session");
 * }
 * ```
 */
export async function getActiveSession(userId: string): Promise<UserActiveSession | null> {
  try {
    const result = await dbRead
      .select({
        bookId: userSessions.bookId,
        pageId: userSessions.pageId,
        previousPageId: userSessions.previousPageId,
        branchId: pages.branchId,
      })
      .from(userSessions)
      .leftJoin(pages, eq(userSessions.pageId, pages.id))
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.status, 'active')
        )
      )
      .limit(1);
    
    const session = result[0];
    if (!session || !session.branchId) {
      return null;
    }
    
    return {
      bookId: session.bookId,
      pageId: session.pageId,
      previousPageId: session.previousPageId,
      branchId: session.branchId,
    };
  } catch (error) {
    console.error(`[getActiveSession] ❌ Failed to get active session:`, {userId, error: getErrorMessage(error)});
    return null;
  }
}

/**
 * Retrieves complete story progress for a user including session, page, and state
 * 
 * @param userId - The user's unique identifier
 * @returns Promise that resolves to story progress object
 * 
 * Behavior:
 * - Gets active session (bookId, pageId) in parallel with story state
 * - Retrieves current page if pageId exists
 * - Returns all data needed for story progression
 * - Optimizes database queries with parallel execution
 * 
 * Example:
 * ```typescript
 * const { page: currentPage, state: currentState } = await getStoryProgress("user123");
 * if (currentPage && currentState) {
 *   console.log(`Reading page ${currentState.page} in book ${currentState.bookId}`);
 * }
 * ```
 */
export async function getStoryProgress(userId: string): Promise<StoryProgress> {
  try {
    // Step 1: Get active session
    const activeSession = await getActiveSession(userId);
    if (!activeSession) {
      return { book: null, page: null, state: null, session: null };
    }

    const { bookId, pageId } = activeSession;

    // Step 2: Get current page, story state, and book info in parallel
    const [currentPage, currentState, currentBook] = await Promise.all([
      getStoryPageById(userId, bookId, pageId),
      getStoryStateWithBranch(userId, bookId, pageId),
      getBook(bookId),
    ]);

    // Step 3: Return
    return {
      page: currentPage,
      state: currentState,
      session: activeSession,
      book: currentBook,
    } satisfies StoryProgress;
  } catch (error) {
    console.error(`Failed to get story progress for user ${userId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve story progress: ${getErrorMessage(error)}`);
  }
}

/**
 * Creates or updates the active session for a user with new page information
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param pageId - The new page identifier to set as current
 * @returns Promise that resolves to the created/updated session object
 * 
 * Behavior:
 * - Uses upsert operation (create or update) for user_sessions table
 * - Maintains active status and book association
 * - Handles session creation if none exists
 * - Ensures user always has a valid active session
 * - Updates user's last activity timestamp for tracking
 * - Returns the complete session object for further processing
 * 
 * Example:
 * ```typescript
 * const session = await setActiveSession({ 
 *   userId: "user123", 
 *   bookId: "book456", 
 *   pageId: "page789",
 *   previousPageId: "page456" 
 * });
 * console.log(`Session ${session.id} activated for user ${session.userId}`);
 * // User's active session now points to the new page and activity is tracked
 * ```
 */
export async function setActiveSession(params: SetActiveSessionParams): Promise<DBUserSession | null> {
  const { userId, bookId, pageId, previousPageId } = params;
  try {
    const result = await dbWrite
      .insert(userSessions)
      .values({
        userId,
        bookId,
        pageId,
        previousPageId,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [userSessions.userId, userSessions.bookId],
        set: {
          pageId,
          previousPageId,
          status: 'active',
          updatedAt: new Date(),
        }
      }).returning();

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
    
    console.log(`Session activated for user ${userId}, book ${bookId}`);
    return result[0];
  } catch (error) {
    console.error(`[setActiveSession] ❌ Failed to set active session for:`, {userId, bookId, error: getErrorMessage(error)});
    return null;
  }
}

/**
 * Updates the story state for a user and book
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param state - The updated story state to persist
 * @returns Promise that resolves when state is updated
 * 
 * Behavior:
 * - Updates story_states table with new state data
 * - Maintains composite key relationship
 * - Handles all story state fields including psychological data
 * - Preserves candidate flag for branching narratives
 * 
 * Example:
 * ```typescript
 * await insertStoryState("user123", "book456", "page789", state);
 * ```
 */
export async function insertStoryState(
  userId: string,
  bookId: string,
  pageId: string,
  state: StoryState
): Promise<void> {
  try {
    await dbWrite
      .insert(storyStates)
      .values({
        userId,
        pageId,
        bookId,
        page: state.page,
        maxPage: state.maxPage,
        flags: state.flags,
        traumaTags: state.traumaTags,
        psychologicalProfile: state.psychologicalProfile,
        hiddenState: state.hiddenState,
        memoryIntegrity: state.memoryIntegrity,
        difficulty: state.difficulty,
        characters: state.characters,
        places: state.places,
        pageHistory: state.pageHistory,
        actionsHistory: state.actionsHistory,
        contextHistory: state.contextHistory,
        viableEnding: state.viableEnding,
      })
      .onConflictDoUpdate({
        target: [storyStates.userId, storyStates.bookId, storyStates.pageId],
        set: {
          page: state.page,
          maxPage: state.maxPage,
          flags: state.flags,
          traumaTags: state.traumaTags,
          psychologicalProfile: state.psychologicalProfile,
          hiddenState: state.hiddenState,
          memoryIntegrity: state.memoryIntegrity,
          difficulty: state.difficulty,
          characters: state.characters,
          places: state.places,
          pageHistory: state.pageHistory,
          actionsHistory: state.actionsHistory,
          contextHistory: state.contextHistory,
          viableEnding: state.viableEnding,
          updatedAt: new Date(),
        }
      });

    // Cleanup old story states - keep only the latest MAX_STORY_STATES_PER_PAGE per user/book
    await cleanupStoryStatesWithStrategy(userId, bookId);
  } catch (error) {
    console.error(`Failed to update story state for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to update story state: ${getErrorMessage(error)}`);
  }
}

/**
 * Deactivates a user's session for a specific book
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @returns Promise that resolves when session is deactivated
 * 
 * Behavior:
 * - Updates session status to 'past'
 * - Preserves session record for history
 * - Handles cases where session doesn't exist
 * 
 * Example:
 * ```typescript
 * await deactivateSession("user123", "book456");
 * console.log("Session deactivated");
 * ```
 */
export async function deactivateSession(userId: string, bookId: string) {
  try {
    const result = await dbWrite
      .update(userSessions)
      .set({ 
        status: 'past',
        updatedAt: new Date()
      })
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.bookId, bookId)
        )
      );
    
    if (result.rowCount === 0) {
      console.warn(`No active session found for user ${userId}, book ${bookId}`);
    } else {
      console.log(`Session deactivated for user ${userId}, book ${bookId}`);
    }
  } catch (error) {
    console.error(`Failed to deactivate session for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to deactivate session: ${getErrorMessage(error)}`);
  }
}

/**
 * Retrieves story state by user ID and book ID
 * 
 * @param userId - User identifier for the story state
 * @param bookId - Book identifier for the story state
 * @returns Promise resolving to the story state record or null if not found
 */
export async function getStoryStateFromDB(
  userId: string,
  pageId: string
): Promise<DBStoryState | null> {
  const result = await dbRead
    .select()
    .from(storyStates)
    .where(and(eq(storyStates.userId, userId), eq(storyStates.pageId, pageId)))
    .limit(1);

  return result[0] || null;
}

/**
 * Gets story state from database and deleted state cache
 * 
 * This function provides basic state retrieval without reconstruction.
 * It only attempts to fetch from database and deleted state cache,
 * returning null if state is not found in either location.
 * 
 * Use {@link getStoryStateWithBranch} for branch-aware reconstruction
 * when the state needs to be reconstructed from snapshots/deltas.
 * 
 * @param userId - User identifier for story state
 * @param pageId - Page identifier for story state
 * @returns Promise resolving to story state from DB/cache, or null if not found
 * 
 * Behavior:
 * - First attempts database lookup via getStoryStateFromDB()
 * - Falls back to deleted state cache if database lookup fails
 * - Returns null if state is not found in either location
 * - Does NOT perform any state reconstruction
 * 
 * @example
 * ```typescript
 * // Basic state retrieval
 * const state = await getStoryState("user123", "page456");
 * if (state) {
 *   console.log(`Found state for page ${state.page}`);
 * } else {
 *   console.log("State not found, use getStoryStateWithBranch() for reconstruction");
 * }
 * ```
 */
export async function getStoryState(
  userId: string,
  pageId: string,
): Promise<StoryState | null> {
  try {
    // Try database first
    const dbResult = await getStoryStateFromDB(userId, pageId);
    if (dbResult) {
      return mapStoryStateFromDb(dbResult);
    }
    
    // Fall back to deleted state cache
    const cachedState = getDeletedState(userId, pageId);
    if (cachedState) {
      console.log(`[getStoryState] Retrieved from deleted cache for user ${userId}, page ${pageId}`);
      return cachedState;
    }

    // NO reconstruction here, should use `getStoryStateWithBranch` instead
    return null;
  } catch (error) {
    console.log(`[getStoryState] ❌ Failed to get story state`, {userId, pageId, error: getErrorMessage(error)});
    return null;
  }
}

/**
 * Maps database StoryState to domain StoryState
 * 
 * Converts the database record to the domain StoryState type used throughout the application.
 * 
 * @param dbStoryState - StoryState record from database
 * @returns Mapped domain StoryState object
 */
export function mapStoryStateFromDb(dbStoryState: DBStoryState): StoryState {
  return {
    pageId: dbStoryState.pageId,
    page: dbStoryState.page,
    maxPage: dbStoryState.maxPage,
    flags: dbStoryState.flags,
    traumaTags: dbStoryState.traumaTags,
    psychologicalProfile: dbStoryState.psychologicalProfile,
    hiddenState: dbStoryState.hiddenState,
    memoryIntegrity: dbStoryState.memoryIntegrity,
    difficulty: dbStoryState.difficulty,
    characters: dbStoryState.characters || {},
    places: dbStoryState.places || {},
    pageHistory: dbStoryState.pageHistory || [],
    actionsHistory: dbStoryState.actionsHistory || [],
    contextHistory: dbStoryState.contextHistory || "",
    viableEnding: dbStoryState.viableEnding || undefined,
  };
}

export async function insertUserPageProgress(params: {
  userId: string;
  bookId: string;
  pageId: string;
  action: Action;
  nextPageId: string;
}): Promise<void> {
  try {
    await dbWrite
      .insert(userPageProgress)
      .values({
        userId: params.userId,
        bookId: params.bookId,
        pageId: params.pageId,
        action: params.action,
        nextPageId: params.nextPageId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies DBNewUserPageProgress)
      .onConflictDoUpdate({
        target: [userPageProgress.userId, userPageProgress.bookId, userPageProgress.pageId],
        set: {
          action: params.action,
          nextPageId: params.nextPageId,
        }
      });
  } catch (error) {
    console.error(`[insertUserPageProgress] ❌ Failed to insert user page progress:`, getErrorMessage(error));
  }
}