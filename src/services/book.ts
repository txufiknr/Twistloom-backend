/**
 * @overview Book Service Module
 * 
 * Provides book-related database operations and business logic.
 * Handles user sessions, book retrieval, and active book management.
 * 
 * Features:
 * - Active book retrieval from user sessions
 * - Book information queries
 * - Session management utilities
 * - Type-safe database operations
 */

import { dbRead, dbWrite } from "../db/client.js";
import { pages, books, storyStates, userPageProgress, userSessions } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import type { DBBook, DBNewBook, DBNewPage, DBPage, DBStoryState, DBUserSession } from "../types/schema.js";
import type { BookStatus } from "../types/book.js";
import { StoryMC } from "../types/character.js";
import type { StoryState, StoryProgress, StoryPage, PersistedStoryPage, UserStoryPage, Action } from "../types/story.js";
import { mapStoryStateFromDb, getStoryState } from "./story.js";
import { deletedStateCache } from "./story-state-cache.js";
import { MAX_STORY_STATES_PER_PAGE } from "../config/story.js";
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
 * Retrieves a specific page by its ID
 * 
 * @param pageId - The page's unique identifier
 * @returns Promise that resolves to page information or null if not found
 * 
 * Behavior:
 * - Queries pages table by ID
 * - Returns all page fields including content and metadata
 * - Handles cases where page doesn't exist
 * - Includes actions and character information
 * 
 * Example:
 * ```typescript
 * const page = await getPageFromDB("page789");
 * if (page) {
 *   console.log(`Page ${page.page}: ${page.text.substring(0, 50)}...`);
 * }
 * ```
 */
export async function getPageFromDB(pageId: string): Promise<DBPage | null> {
  try {
    const result = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`Failed to get page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve page: ${getErrorMessage(error)}`);
  }
}

async function getUserPageProgressMap(userId: string, bookId: string): Promise<Map<string, Action>> {
  const rows = await dbRead
    .select()
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.userId, userId),
      eq(userPageProgress.bookId, bookId)
    ));
  
  return new Map(rows.map(r => [r.pageId, r.action]));
}

/**
 * Gets user's selected action for a specific page
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param pageId - The page's unique identifier
 * @returns Promise resolving to user's selected action or null if not found
 */
async function getPageProgressFromDB(userId: string, bookId: string, pageId: string): Promise<Action | null> {
  const userProgress = await dbRead
    .select()
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.userId, userId),
      eq(userPageProgress.bookId, bookId),
      eq(userPageProgress.pageId, pageId)
    ))
    .limit(1);
  
  return userProgress[0]?.action || null;
}

/**
 * Retrieves a specific story page by its ID and maps to domain type
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param pageId - The page's unique identifier
 * @returns Promise that resolves to StoryPage domain object or null if not found
 * 
 * Behavior:
 * - Queries pages table by ID using getPageById
 * - Maps database Page type to domain StoryPage type
 * - Returns properly typed domain object for story logic
 * - Handles cases where page doesn't exist
 * 
 * Example:
 * ```typescript
 * const storyPage = await getStoryPageById("user123", "book456", "page789");
 * if (storyPage) {
 *   console.log(`Page ${storyPage.text.substring(0, 50)}...`);
 *   console.log(`Actions: ${storyPage.actions.map(a => a.text).join(', ')}`);
 * }
 * ```
 */
export async function getStoryPageById(userId: string, bookId: string, pageId: string): Promise<UserStoryPage | null> {
  try {
    // If pageId is provided, try to get that specific page
    if (pageId) {
      const dbPage = await getPageFromDB(pageId);
      if (dbPage) {
        // Get user page progress to include selected action
        const selectedAction = await getPageProgressFromDB(userId, bookId, pageId);
        return mapToUserStoryPage(dbPage, selectedAction || undefined);
      }
    }
    
    // Fallback: get the first page of the book
    const firstPage = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.bookId, bookId))
      .orderBy(asc(pages.page))
      .limit(1);
    
    if (firstPage[0]) {
      // Get progress for first page
      const selectedAction = await getPageProgressFromDB(userId, bookId, firstPage[0].id);
      return mapToUserStoryPage(firstPage[0], selectedAction || undefined);
    }
    
    return null;
  } catch (error) {
    console.error(`Failed to get story page for book ${bookId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve story page: ${getErrorMessage(error)}`);
  }
}

/**
 * Maps database Page type to domain UserStoryPage type with optional selected action
 * 
 * @param dbPage - Page data from database
 * @param selectedAction - User's selected action for this page (optional)
 * @returns UserStoryPage domain object with optional selectedAction
 * 
 * Behavior:
 * - Maps all fields from database to domain types
 * - Includes user's selected action if available
 * - Handles optional fields correctly
 * - Preserves data integrity during transformation
 * 
 * Example:
 * ```typescript
 * const userPage = mapToUserStoryPage(dbPage, userAction);
 * console.log(`Page ${userPage.page}: ${userPage.text.substring(0, 50)}...`);
 * if (userPage.selectedAction) {
 *   console.log(`User chose: ${userPage.selectedAction.text}`);
 * }
 * ```
 */
export function mapToUserStoryPage(dbPage: DBPage, selectedAction?: Action): UserStoryPage {
  return {
    id: dbPage.id,
    bookId: dbPage.bookId,
    parentId: dbPage.parentId,
    page: dbPage.page,
    text: dbPage.text,
    mood: dbPage.mood,
    place: dbPage.place,
    characters: dbPage.characters || [],
    keyEvents: dbPage.keyEvents || [],
    importantObjects: dbPage.importantObjects || [],
    actions: dbPage.actions || [],
    addTraumaTag: dbPage.addTraumaTag || undefined,
    characterUpdates: dbPage.characterUpdates || undefined,
    placeUpdates: dbPage.placeUpdates || undefined,
    selectedAction: selectedAction || undefined,
  } satisfies UserStoryPage;
}

/**
 * Maps database Page type to domain PersistedStoryPage type
 * 
 * @param dbPage - Page data from database
 * @returns PersistedStoryPage domain object with proper type mapping
 * 
 * Behavior:
 * - Maps all fields from database to domain types
 * - Handles optional fields correctly
 * - Preserves data integrity during transformation
 * 
 * Example:
 * ```typescript
 * const storyPage = mapToPersistedStoryPage(dbPage);
 * console.log(`Page ${storyPage.page}: ${storyPage.text.substring(0, 50)}...`);
 * ```
 */
export function mapToPersistedStoryPage(dbPage: DBPage): PersistedStoryPage {
  return {
    id: dbPage.id,
    bookId: dbPage.bookId,
    parentId: dbPage.parentId,
    page: dbPage.page,
    text: dbPage.text,
    mood: dbPage.mood,
    place: dbPage.place,
    characters: dbPage.characters || [],
    keyEvents: dbPage.keyEvents || [],
    importantObjects: dbPage.importantObjects || [],
    actions: dbPage.actions || [],
    addTraumaTag: dbPage.addTraumaTag || undefined,
    characterUpdates: dbPage.characterUpdates || undefined,
    placeUpdates: dbPage.placeUpdates || undefined,
  } satisfies PersistedStoryPage;
}

/**
 * Maps database Page type to domain StoryPage type (without database fields)
 * 
 * @param dbPage - Page data from database
 * @returns StoryPage domain object with proper type mapping
 * 
 * Behavior:
 * - Maps only story content fields from database to domain types
 * - Excludes database-specific fields like id, bookId, parentId
 * - Handles optional fields correctly
 * - Preserves data integrity during transformation
 * 
 * Example:
 * ```typescript
 * const storyPage = mapToStoryPage(dbPage);
 * console.log(`Page ${storyPage.page}: ${storyPage.text.substring(0, 50)}...`);
 * ```
 */
export function mapToStoryPage(dbPage: DBPage): StoryPage {
  return {
    text: dbPage.text,
    mood: dbPage.mood,
    place: dbPage.place,
    characters: dbPage.characters || [],
    keyEvents: dbPage.keyEvents || [],
    importantObjects: dbPage.importantObjects || [],
    actions: dbPage.actions || [],
    addTraumaTag: dbPage.addTraumaTag || undefined,
    characterUpdates: dbPage.characterUpdates || undefined,
    placeUpdates: dbPage.placeUpdates || undefined,
  } satisfies StoryPage;
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
      return { page: null, state: null, session: null, mc: null };
    }

    const { bookId, pageId } = activeSession;

    // Step 2: Get current page, story state, and book info in parallel
    const [currentPage, currentState, bookInfo] = await Promise.all([
      getStoryPageById(userId, bookId, pageId),
      getStoryState(userId, pageId),
      getBookInfo(bookId),
    ]);

    // Step 3: Return
    return {
      page: currentPage,
      state: currentState,
      session: activeSession,
      mc: bookInfo.mc,
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
export async function insertStoryState(userId: string, bookId: string, pageId: string, state: StoryState): Promise<void> {
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
        cachedEndingArchetype: state.cachedEndingArchetype || null,
        characters: state.characters,
        places: state.places,
        pageHistory: state.pageHistory,
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
          psychologicalProfile: state.psychologicalProfile,
          hiddenState: state.hiddenState,
          memoryIntegrity: state.memoryIntegrity,
          difficulty: state.difficulty,
          cachedEndingArchetype: state.cachedEndingArchetype || null,
          characters: state.characters,
          places: state.places,
          pageHistory: state.pageHistory,
          actionsHistory: state.actionsHistory,
          contextHistory: state.contextHistory,
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
 * Cleans up old story states for a specific user/book combination
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @returns Promise that resolves when cleanup is complete
 * 
 * Behavior:
 * - Keeps only the latest MAX_STORY_STATES_PER_PAGE states across all pages
 * - Orders by updatedAt descending to identify newest states
 * - Deletes older states beyond the limit
 */
async function cleanupOldStoryStates(userId: string, bookId: string): Promise<void> {
  try {
    // Get all story states for this user/book combination, ordered by newest first
    const allStates = await dbRead
      .select({ 
        pageId: storyStates.pageId,
        updatedAt: storyStates.updatedAt 
      })
      .from(storyStates)
      .where(and(
        eq(storyStates.userId, userId),
        eq(storyStates.bookId, bookId)
      ))
      .orderBy(desc(storyStates.updatedAt));

    // If we have more states than the limit, delete the oldest ones
    if (allStates.length > MAX_STORY_STATES_PER_PAGE) {
      const statesToDelete = allStates.slice(MAX_STORY_STATES_PER_PAGE); // Get the oldest states to delete
      
      for (const stateToDelete of statesToDelete) {
        // Cache the state before deletion for safety net
        const fullState = await getStoryState(userId, stateToDelete.pageId);
        if (fullState) {
          deletedStateCache.set(userId, stateToDelete.pageId, fullState);
          console.log(`[cleanupOldStoryStates] 💾 Cached state before deletion for user ${userId}, page ${stateToDelete.pageId}`);
        }
        
        await dbWrite
          .delete(storyStates)
          .where(and(
            eq(storyStates.userId, userId),
            eq(storyStates.bookId, bookId),
            eq(storyStates.pageId, stateToDelete.pageId)
          ));
      }
      
      console.log(`[cleanupOldStoryStates] 🗑️ Cleaned up ${statesToDelete.length} old states for user ${userId}, book ${bookId}`);
    }
  } catch (error) {
    console.error(`Failed to cleanup old story states for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    // Don't throw error here - cleanup failure shouldn't break the main operation
  }
}

/**
 * Retrieves complete book information for a given book ID
 * 
 * @param bookId - The book's unique identifier
 * @returns Promise that resolves to book information or null if not found
 * 
 * Behavior:
 * - Queries books table by ID
 * - Returns all book fields including metadata
 * - Handles cases where book doesn't exist
 * - Includes main character information
 * 
 * @example
 * ```typescript
 * const bookInfo = await getBookInfo("book456");
 * if (bookInfo) {
 *   console.log(`Book: ${bookInfo.displayTitle} by MC: ${bookInfo.mcName}`);
 * }
 * ```
 */
export async function getBookInfo(bookId: string) {
  try {
    const result = await dbRead
      .select()
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`Failed to get book info for ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve book information: ${getErrorMessage(error)}`);
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
