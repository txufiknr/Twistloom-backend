import { dbRead, dbWrite } from "../db/client.js";
import { eq, and, sql } from "drizzle-orm";
import { storyStates, userSessions, userPageProgress, pages } from "../db/schema.js";
import type { StoryState, StoryProgress, Action, SetActiveSessionParams, ActionedStoryPage, UserStoryPage, UserSession } from "../types/story.js";
import type { DBNewUserPageProgress, DBStoryState, DBUserSession } from "../types/schema.js";
import { getDeletedState } from "./story-state-cache.js";
import { getBook, getPageActionsFromDB, getStoryPageById, mapToUserStoryPage } from "./book.js";
import { getErrorMessage } from "../utils/error.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { logUserActivity } from "./user.js";
import { cleanupStoryStatesWithStrategy } from "./story-branch.js";
import { MAX_PAGE_HISTORY } from "../config/story.js";

/**
 * Retrieves the current session for a user including both bookId, current pageId, branchId, and status
 * 
 * @param userId - The user's unique identifier
 * @param bookId - Optional book ID to filter sessions for a specific book
 * @param pageId - Optional page ID to filter sessions for a specific page
 * @returns Promise that resolves to user session or null if no session found
 * 
 * Behavior:
 * - Queries user_sessions table ordered by status (prioritizing "active")
 * - Joins with pages table to get branchId of the current page
 * - Returns bookId, pageId, previousPageId, branchId, and status from the session
 * - Handles cases where user has no sessions
 * - Uses composite primary key for efficient lookup
 * - Prioritizes active sessions but can return sessions with any status
 * 
 * Example:
 * ```typescript
 * const userSession = await getUserSession("user123");
 * if (userSession) {
 *   console.log(`User is reading book ${userSession.bookId} on page ${userSession.pageId} in branch ${userSession.branchId} with status ${userSession.status}`);
 * } else {
 *   console.log("User has no reading session");
 * }
 * ```
 */
export async function getUserSession(userId: string, bookId?: string, pageId?: string): Promise<UserSession | null> {
  try {
    const result = await dbRead
      .select({
        bookId: userSessions.bookId,
        pageId: userSessions.pageId,
        previousPageId: userSessions.previousPageId,
        branchId: pages.branchId,
        status: userSessions.status,
      })
      .from(userSessions)
      .leftJoin(pages, eq(userSessions.pageId, pages.id))
      .where(
        and(
          eq(userSessions.userId, userId),
          bookId ? eq(userSessions.bookId, bookId) : undefined,
          pageId ? eq(userSessions.pageId, pageId) : undefined,
        )
      )
      .orderBy(sql`CASE WHEN ${userSessions.status} = 'active' THEN 0 ELSE 1 END`)
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
      status: session.status,
    };
  } catch (error) {
    console.error(`[getUserSession] ❌ Failed to get user session:`, {userId, error: getErrorMessage(error)});
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
export async function getStoryProgress(userId: string, bookId?: string, pageId?: string): Promise<StoryProgress> {
  try {
    // Step 1: Get active session
    const userSession = await getUserSession(userId, bookId, pageId);
    bookId ??= userSession?.bookId;
    pageId ??= userSession?.pageId;

    if (!bookId || !pageId) {
      return { book: null, page: null, state: null, session: null };
    }

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
      session: userSession,
      book: currentBook,
    } satisfies StoryProgress;
  } catch (error) {
    console.error(`[getStoryProgress] ❌ Failed to get story progress for user ${userId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve story progress: ${getErrorMessage(error)}`, { cause: error });
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

    // Log user activity (session update)
    await logUserActivity({
      userId,
      activityType: 'session_updated',
      targetType: 'book',
      targetId: bookId,
      metadata: { pageId, previousPageId },
    });
    
    console.log(`[setActiveSession] ✅ Session activated for user ${userId}, book ${bookId}`);
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
        plotFlags: state.plotFlags,
        inventory: state.inventory,
        psychologicalProfile: state.psychologicalProfile,
        hiddenState: state.hiddenState,
        memoryIntegrity: state.memoryIntegrity,
        difficulty: state.difficulty,
        viableEnding: state.viableEnding,
        characters: state.characters,
        places: state.places,
        actionsHistory: state.actionsHistory,
        contextHistory: state.contextHistory,
      })
      .onConflictDoUpdate({
        target: [storyStates.userId, storyStates.bookId, storyStates.pageId],
        set: {
          page: state.page,
          maxPage: state.maxPage,
          flags: state.flags,
          traumaTags: state.traumaTags,
          plotFlags: state.plotFlags,
          inventory: state.inventory,
          psychologicalProfile: state.psychologicalProfile,
          hiddenState: state.hiddenState,
          memoryIntegrity: state.memoryIntegrity,
          difficulty: state.difficulty,
          viableEnding: state.viableEnding,
          characters: state.characters,
          places: state.places,
          actionsHistory: state.actionsHistory,
          contextHistory: state.contextHistory,
          updatedAt: new Date(),
        }
      });

    // Optimize story states strategically
    await cleanupStoryStatesWithStrategy(userId, bookId);
  } catch (error) {
    console.error(`[insertStoryState] ❌ Failed to insert story state for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to insert story state: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Marks a page as visited by updating user session and page progress
 * 
 * This function is called when a user actually navigates to a page (not during pre-generation).
 * It updates the active session to point to the new page and records the action choice.
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param pageId - The page identifier being visited
 * @param previousPageId - The previous page identifier (for navigation history)
 * @param action - The action chosen to reach this page
 * @returns Promise that resolves when session and progress are updated
 * 
 * Behavior:
 * - Updates user session to point to the new page
 * - Inserts page progress record with action choice
 * - Updates user's last activity timestamp
 * 
 * Example:
 * ```typescript
 * await markPageVisited("user123", "book456", "page789", "page456", action);
 * ```
 */
export async function markPageVisited(
  userId: string,
  bookId: string,
  pageId: string,
  previousPageId: string,
  action: Action
): Promise<void> {
  try {
    // Update active session to point to the new page
    await setActiveSession({ userId, bookId, pageId, previousPageId });
    
    // Insert page progress record
    await insertUserPageProgress({
      userId,
      bookId,
      pageId: previousPageId,
      action,
      nextPageId: pageId
    });
    
    console.log(`[markPageVisited] 👀 User ${userId} visited page ${pageId} in book ${bookId}`);
  } catch (error) {
    console.error(`[markPageVisited] ❌ Failed to mark page visited:`, getErrorMessage(error));
    throw new Error(`Unable to mark page visited: ${getErrorMessage(error)}`, { cause: error });
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
      console.warn(`[deactivateSession] ⏩ No active session found for user ${userId}, book ${bookId}`);
    } else {
      console.log(`[deactivateSession] ✅ Session deactivated for user ${userId}, book ${bookId}`);
    }
  } catch (error) {
    console.error(`[deactivateSession] ❌ Failed to deactivate session for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to deactivate session: ${getErrorMessage(error)}`, { cause: error });
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
      console.log(`[getStoryState] 🍪 Retrieved from deleted cache for user ${userId}, page ${pageId}`);
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
    threads: dbStoryState.threads,
    traumaTags: dbStoryState.traumaTags,
    plotFlags: dbStoryState.plotFlags,
    inventory: dbStoryState.inventory,
    psychologicalProfile: dbStoryState.psychologicalProfile,
    hiddenState: dbStoryState.hiddenState,
    memoryIntegrity: dbStoryState.memoryIntegrity,
    difficulty: dbStoryState.difficulty,
    characters: dbStoryState.characters || {},
    places: dbStoryState.places || {},
    actionsHistory: dbStoryState.actionsHistory || [],
    contextHistory: dbStoryState.contextHistory || "",
    viableEnding: dbStoryState.viableEnding || undefined,
    isMajorEvent: dbStoryState.isMajorEvent || false,
    injuries: dbStoryState.injuries || [],
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
    const userPageProgressData: DBNewUserPageProgress = {
      userId: params.userId,
      bookId: params.bookId,
      pageId: params.pageId,
      action: params.action,
      nextPageId: params.nextPageId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await dbWrite
      .insert(userPageProgress)
      .values(userPageProgressData)
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

/**
 * Gets previous pages by traversing the parent chain
 * 
 * This function retrieves the last MAX_PAGE_HISTORY pages by:
 * 1. Starting from the current page (from actionedPage)
 * 2. Traversing backwards using parentId to get previous pages
 * 3. Using userPageProgress to track which action the user selected to reach each page
 * 4. Mapping each page to UserStoryPage with the selected action included
 * 
 * @param actionedPage - Current actioned page containing page info
 * @param userId - User ID for tracking page progress
 * @param bookId - Book ID for filtering pages
 * @returns Promise resolving to array of UserStoryPage with selected actions
 * 
 * @example
 * ```typescript
 * const previousPages = await getPreviousPages(actionedPage, "user123", "book456");
 * // Returns: [UserStoryPage, ...] with selectedAction populated
 * ```
 */
export async function getPreviousPages(
  actionedPage: ActionedStoryPage,
  userId: string,
  bookId: string
): Promise<UserStoryPage[]> {
  try {
    const previousPages: UserStoryPage[] = [];
    let currentPageId = actionedPage.parentId;
    
    // Traverse backwards through the parent chain
    while (currentPageId && previousPages.length < MAX_PAGE_HISTORY) {
      // Get the page from database
      const pageResult = await dbRead
        .select()
        .from(pages)
        .where(eq(pages.id, currentPageId))
        .limit(1);
      
      const dbPage = pageResult[0];
      if (!dbPage) break;
      
      // Get the action that led to this page from userPageProgress
      const selectedActions = await getPageActionsFromDB(userId, bookId, currentPageId);
      
      // Map to UserStoryPage with selected action included
      const userPage = await mapToUserStoryPage(dbPage, userId, selectedActions);
      previousPages.push(userPage);
      
      currentPageId = dbPage.parentId;
    }
    
    // Reverse to get chronological order (oldest first)
    previousPages.reverse();
    
    return previousPages;
  } catch (error) {
    console.error(`[getPreviousPages] ❌ Failed to get previous pages:`, getErrorMessage(error));
    return [];
  }
}