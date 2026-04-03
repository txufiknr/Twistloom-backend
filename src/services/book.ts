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
import { updateUserLastActivity } from "./user.js";
import { userSessions, books, pages, storyStates } from "../db/schema.js";
import { eq, and, asc } from "drizzle-orm";
import { PersistedStoryPage, StoryPage, StoryProgress, StoryState } from "../types/story.js";
import { StoryMC } from "../types/character.js";
import { DBNewStoryState, DBNewUserSession, DBPage, DBUserSession } from "../types/schema.js";
import { getStoryState } from "./story.js";

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
    console.error(`Failed to get active session for user ${userId}:`, error);
    throw new Error(`Unable to retrieve active session: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
 * const page = await getPageById("page789");
 * if (page) {
 *   console.log(`Page ${page.page}: ${page.text.substring(0, 50)}...`);
 * }
 * ```
 */
export async function getPageById(pageId: string) {
  try {
    const result = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    
    return result[0] || null;
  } catch (error) {
    console.error(`Failed to get page ${pageId}:`, error);
    throw new Error(`Unable to retrieve page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Retrieves a specific story page by its ID and maps to domain type
 * 
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
 * const storyPage = await getStoryPageById("book456", "page789");
 * if (storyPage) {
 *   console.log(`Page ${storyPage.text.substring(0, 50)}...`);
 *   console.log(`Actions: ${storyPage.actions.map(a => a.text).join(', ')}`);
 * }
 * ```
 */
export async function getStoryPageById(bookId: string, pageId?: string | null): Promise<PersistedStoryPage | null> {
  try {
    // If pageId is provided, try to get that specific page
    if (pageId) {
      const dbPage = await getPageById(pageId);
      if (dbPage) {
        return mapToPersistedStoryPage(dbPage);
      }
    }
    
    // Fallback: get the first page of the book
    const firstPage = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.bookId, bookId))
      .orderBy(asc(pages.page))
      .limit(1);
    
    return firstPage[0] ? mapToPersistedStoryPage(firstPage[0]) : null;
  } catch (error) {
    console.error(`Failed to get story page for book ${bookId}, page ${pageId}:`, error);
    throw new Error(`Unable to retrieve story page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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
  };
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
  };
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
      return {
        page: null,
        state: null,
        session: null,
        mc: null,
      };
    }

    const { bookId, pageId } = activeSession;

    // Step 2: Get current page, story state, and book info in parallel
    const [currentPage, currentState, bookInfo] = await Promise.all([
      getStoryPageById(bookId, pageId),
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
    console.error(`Failed to get story progress for user ${userId}:`, error);
    throw new Error(`Unable to retrieve story progress: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    console.error(`Failed to set active session for user ${userId}, book ${bookId}:`, error);
    throw new Error(`Unable to set active session: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
 * await insertStoryState("user123", "page456", state);
 * ```
 */
export async function insertStoryState(userId: string, pageId: string, state: StoryState): Promise<void> {
  // TODO: cleanup old states (last 10 pages sliding window, set config const)
  try {
    await dbWrite
      .insert(storyStates)
      .values({
        userId,
        pageId,
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
        target: [storyStates.userId, storyStates.pageId],
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
  } catch (error) {
    console.error(`Failed to update story state for user ${userId}, page ${pageId}:`, error);
    throw new Error(`Unable to update story state: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
 * Example:
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
    console.error(`Failed to get book info for ${bookId}:`, error);
    throw new Error(`Unable to retrieve book information: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    console.error(`Failed to deactivate session for user ${userId}, book ${bookId}:`, error);
    throw new Error(`Unable to deactivate session: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
