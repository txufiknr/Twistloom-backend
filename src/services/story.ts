import { dbRead, dbWrite } from "../db/client.js";
import { eq, and } from "drizzle-orm";
import { storyStates, userSessions } from "../db/schema.js";
import type { StoryState, StoryProgress, StateReconstructionDeps } from "../types/story.js";
import type { DBStoryState, DBUserSession } from "../types/schema.js";
import { deletedStateCache } from "./story-state-cache.js";
import { getBook, getBookFromDB, getPageFromDB, getStoryPageById } from "./book.js";
import { getErrorMessage } from "../utils/error.js";
import { getStateSnapshot } from "./snapshots.js";
import { getStateDelta } from "./deltas.js";
import { reconstructStoryState } from "../utils/branch-traversal.js";
import { SNAPSHOT_INTERVAL, MIN_PAGES_FOR_MIDDLE } from "../config/story.js";
import { updateUserLastActivity } from "./user.js";

/**
 * Retrieves the active session for a user including both bookId and current pageId
 * 
 * @param userId - The user's unique identifier
 * @returns Promise that resolves to active session or null if no active session
 * 
 * Behavior:
 * - Queries user_sessions table for active status
 * - Returns both bookId and pageId from active session
 * - Handles cases where user has no active sessions
 * - Uses composite primary key for efficient lookup
 * 
 * Example:
 * ```typescript
 * const activeSession = await getActiveSession("user123");
 * if (activeSession) {
 *   console.log(`User is reading book ${activeSession.bookId} on page ${activeSession.pageId}`);
 * } else {
 *   console.log("User has no active reading session");
 * }
 * ```
 */
export async function getActiveSession(userId: string): Promise<{ bookId: string; pageId: string } | null> {
  try {
    const result = await dbRead
      .select({ bookId: userSessions.bookId, pageId: userSessions.pageId })
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          eq(userSessions.status, 'active')
        )
      )
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`Failed to get active session for user ${userId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve active session: ${getErrorMessage(error)}`);
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
      getStoryState(userId, pageId),
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
 * const session = await setActiveSession("user123", "book456", "page789");
 * console.log(`Session ${session.id} activated for user ${session.userId}`);
 * // User's active session now points to the new page and activity is tracked
 * ```
 */
export async function setActiveSession(userId: string, bookId: string, pageId: string): Promise<DBUserSession> {
  try {
    const result = await dbWrite
      .insert(userSessions)
      .values({
        userId,
        bookId,
        pageId,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [userSessions.userId, userSessions.bookId],
        set: {
          pageId,
          status: 'active',
          updatedAt: new Date(),
        }
      }).returning();

    // Update user's last activity timestamp
    await updateUserLastActivity(userId);
    
    console.log(`Session activated for user ${userId}, book ${bookId}`);
    return result[0];
  } catch (error) {
    console.error(`Failed to set active session for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to set active session: ${getErrorMessage(error)}`);
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
    await cleanupOldStoryStates(userId, bookId);
  } catch (error) {
    console.error(`Failed to update story state for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to update story state: ${getErrorMessage(error)}`);
  }
}

/**
 * Strategic cleanup of story states using hybrid retention strategy
 * 
 * Combines fixed checkpoints with interval snapshots for optimal performance:
 * 1. Always keep: First page, Last page (current)
 * 2. Keep every Nth page: page % SNAPSHOT_INTERVAL === 0  
 * 3. Keep middle page: If totalPages >= MIN_PAGES_FOR_MIDDLE
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @returns Promise that resolves when cleanup is complete
 * 
 * Performance: Max 10 delta applications between snapshots
 * Storage: ~13 states per 100-page book vs 3 states in simple strategy
 */
async function cleanupOldStoryStates(userId: string, bookId: string): Promise<void> {
  try {
    // Get book information to retrieve totalPages
    const bookInfo = await getBookFromDB(bookId);
    if (!bookInfo) {
      console.log(`[cleanupOldStoryStates] ⚠️ Book not found for user ${userId}, book ${bookId}`);
      return;
    }

    const totalPages = bookInfo.totalPages;
    console.log(`[cleanupOldStoryStates] 📚 Using totalPages from book schema: ${totalPages}`);
    
    // Get all story states for this user/book combination, ordered by page number
    const allStates = await dbRead
      .select({ 
        pageId: storyStates.pageId,
        page: storyStates.page,
        updatedAt: storyStates.updatedAt 
      })
      .from(storyStates)
      .where(and(
        eq(storyStates.userId, userId),
        eq(storyStates.bookId, bookId)
      ))
      .orderBy(storyStates.page);

    if (allStates.length === 0) {
      console.log(`[cleanupOldStoryStates] ℹ️ No states to cleanup for user ${userId}, book ${bookId}`);
      return;
    }
    const pagesToKeep = new Set<string>();
    
    // 1. Always keep first page
    pagesToKeep.add(allStates[0].pageId);
    console.log(`[cleanupOldStoryStates] 📍 Keeping first page: ${allStates[0].pageId} (page ${allStates[0].page})`);
    
    // 2. Always keep last page (current)
    const lastState = allStates[allStates.length - 1];
    pagesToKeep.add(lastState.pageId);
    console.log(`[cleanupOldStoryStates] 📍 Keeping last page: ${lastState.pageId} (page ${lastState.page})`);
    
    // 3. Keep middle page for substantial books
    if (totalPages >= MIN_PAGES_FOR_MIDDLE) {
      const middleIndex = Math.floor(allStates.length / 2);
      const middleState = allStates[middleIndex];
      pagesToKeep.add(middleState.pageId);
      console.log(`[cleanupOldStoryStates] 📍 Keeping middle page: ${middleState.pageId} (page ${middleState.page})`);
    }
    
    // 4. Keep interval snapshots
    const intervalStates = allStates.filter(state => state.page % SNAPSHOT_INTERVAL === 0);
    for (const state of intervalStates) {
      pagesToKeep.add(state.pageId);
    }
    console.log(`[cleanupOldStoryStates] 📍 Keeping ${intervalStates.length} interval snapshots (every ${SNAPSHOT_INTERVAL} pages)`);
    
    // 5. Identify states to delete
    const statesToDelete = allStates.filter(state => !pagesToKeep.has(state.pageId));
    
    if (statesToDelete.length > 0) {
      console.log(`[cleanupOldStoryStates] 🗑️ Preparing to delete ${statesToDelete.length} states, keeping ${pagesToKeep.size} states`);
      
      for (const stateToDelete of statesToDelete) {
        // Cache the state before deletion for safety net
        const fullState = await getStoryState(userId, stateToDelete.pageId);
        if (fullState) {
          deletedStateCache.set(userId, stateToDelete.pageId, fullState);
          console.log(`[cleanupOldStoryStates] 💾 Cached state before deletion for user ${userId}, page ${stateToDelete.pageId} (page ${stateToDelete.page})`);
        }
        
        await dbWrite
          .delete(storyStates)
          .where(and(
            eq(storyStates.userId, userId),
            eq(storyStates.bookId, bookId),
            eq(storyStates.pageId, stateToDelete.pageId)
          ));
      }
      
      console.log(`[cleanupOldStoryStates] ✨ Strategic cleanup complete: ${statesToDelete.length} deleted, ${pagesToKeep.size} kept for user ${userId}, book ${bookId}`);
    } else {
      console.log(`[cleanupOldStoryStates] ✅ No cleanup needed: all ${pagesToKeep.size} states are strategic checkpoints`);
    }
    
    // Log performance metrics
    const keepRatio = (pagesToKeep.size / allStates.length * 100).toFixed(1);
    console.log(`[cleanupOldStoryStates] 📊 Storage efficiency: ${keepRatio}% of states retained (${pagesToKeep.size}/${allStates.length})`);
    
  } catch (error) {
    console.error(`Failed to cleanup story states for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    // Don't throw error here - cleanup failure shouldn't break the main operation
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
 * Gets story state with fallback to deleted state cache
 * 
 * @param userId - User identifier for the story state
 * @param pageId - Page identifier for the story state
 * @returns Promise resolving to the story state record or null if not found
 * 
 * Behavior:
 * - First tries to get from database
 * - Falls back to deleted state cache if not found
 * - Returns null if state doesn't exist anywhere
 */
export async function getStoryState(
  userId: string,
  pageId: string
): Promise<StoryState | null> {
  try {
    // Try database first
    const dbResult = await getStoryStateFromDB(userId, pageId);
    if (dbResult) {
      return mapStoryStateFromDb(dbResult);
    }
    
    // Fall back to deleted state cache
    const cachedState = deletedStateCache.get(userId, pageId);
    if (cachedState) {
      console.log(`[getStoryState] Retrieved from deleted cache for user ${userId}, page ${pageId}`);
      return cachedState;
    }
  
    // Fall back to reconstruction
    console.log(`[getStoryState] 🔄 currentState is null, reconstructing from branch traversal for page ${pageId}`);
    
    // Get the target page first to determine its branchId
    const targetPage = await getPageFromDB(pageId);
    const targetBranchId = targetPage?.branchId || undefined;
    console.log(`[getStoryState] 🌱 Target branchId for reconstruction: ${targetBranchId || 'main'}`);
    
    // Create dependencies for reconstruction with branch-aware page retrieval
    const reconstructionDeps: StateReconstructionDeps = {
      getPageById: async (id: string) => await getPageFromDB(id, targetBranchId),
      getBook: async (bookId: string) => await getBookFromDB(bookId),
      getSnapshot: async (id: string) => await getStateSnapshot(userId, id),
      getDelta: async (id: string) => await getStateDelta(userId, id),
      getStoryState: async (id: string) => await getStoryState(userId, id),
    };
    
    // Reconstruct state using branch traversal
    const reconstructionResult = await reconstructStoryState(pageId, userId, reconstructionDeps);
    console.log(`[getStoryState] ✅ State reconstructed using ${reconstructionResult.method} (${reconstructionResult.reconstructionTimeMs}ms)`);
    return reconstructionResult.state;
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