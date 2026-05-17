import { type DBClient, dbRead, dbWrite } from "../db/client.js";
import { eq, and, sql } from "drizzle-orm";
import { storyStates, userSessions, userPageProgress, pages } from "../db/schema.js";
import type { StoryProgress, Action, SetActiveSessionParams, ActionedStoryPage, UserStoryPage, UserSession, StoryState } from "../types/story.js";
import type { DBNewUserPageProgress, DBPage, DBStoryState, DBUserPageProgress, DBUserSession } from "../types/schema.js";
import { getDeletedState, getStoryState as getCachedStoryState, setStoryState as setCachedStoryState } from "./story-state-cache.js";
import { getBook, getPageActionsFromDB, getPageFromDB, getStoryPageById, mapToUserStoryPage } from "./book.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { logUserActivity } from "./user.js";
import { cleanupStoryStatesWithStrategy } from "./story-branch.js";
import { MAX_PAGE_HISTORY, MAX_TRAVERSAL_DEPTH_SHALLOW } from "../config/story.js";
import type { BookPageVisit, EnrichedBookData } from "../types/book.js";
import { getErrorMessage } from "../utils/error.js";
import { applyStateDelta } from "../utils/story.js";
import { executeWithCredits, refundCredits } from "./credits.js";

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
  console.log(`[getStoryProgress] 🧩 Getting story progress:`, { userId, bookId, pageId });

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
  const { userId, bookId, pageId, previousPageId, client = dbWrite } = params;
  const result = await client
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
    client,
  });
  
  console.log(`[setActiveSession] 🌟 Session activated:`, params);
  return result[0] || null;
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
  bookId: string,
  pageId: string,
  state: StoryState,
  options: { client?: DBClient } = {},
): Promise<void> {
  const { client = dbWrite } = options;
  try {
    await client
      .insert(storyStates)
      .values({
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
        target: [storyStates.pageId],
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

    // Optimize story states strategically per book (branch-aware)
    await cleanupStoryStatesWithStrategy(bookId);
  } catch (error) {
    console.error(`[insertStoryState] ❌ Failed to insert story state for page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to insert story state: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Helper function to mark a page as visited with the given database client
 * 
 * This function contains the common logic for marking a page as visited,
 * used by both credit transaction and non-credit paths.
 * 
 * @param params - Parameters for marking page visited
 * @returns Promise that resolves with session data and visit statistics
 */
async function markPageVisitedWithClient(params: {
  userId: string,
  bookId: string,
  pageId: string,
  pageNumber: number,
  visitCount: number,
  stats: Pick<EnrichedBookData, 'stats'>['stats'],
  actionedPageId?: string,
  action?: Action,
  client: DBClient
}): Promise<BookPageVisit> {
  const {
    userId,
    bookId,
    pageId,
    pageNumber,
    visitCount,
    stats,
    actionedPageId,
    action,
    client
  } = params;

  // Update active session to point to the new page
  const session = await setActiveSession({ userId, bookId, pageId, previousPageId: actionedPageId, client });

  // Insert user page progress for pages > 1, or manually increment visitCount for page 1
  if (pageNumber > 1) {
    if (!action || !actionedPageId) {
      throw new Error(`action and actionedPageId must be provided for pageNumber ${pageNumber}`);
    }

    // Insert page progress record (trigger will increment visitCount in pages table)
    const progress = await insertUserPageProgress({
      userId,
      bookId,
      actionedPageId,
      nextPageId: pageId,
      action,
      client,
    });
    if (progress) {
      console.log(`[markPageVisited] 🌟 User page progress updated:`, progress);
    } else {
      console.log(`[markPageVisited] ❌ User page progress not updated`);
    }
  } else {
    // Page 1: manually increment visitCount since no user_page_progress record is inserted
    await client
      .update(pages)
      .set({ visitCount: sql`${pages.visitCount} + 1`, updatedAt: new Date() })
      .where(eq(pages.id, pageId));
    console.log(`[markPageVisited] 📈 Manually incremented visitCount for page 1`);
  }

  // Calculate visit statistics using denormalized data
  // nthVisit: visitCount + 1 (already incremented above for page 1, or will be incremented by trigger for pages > 1)
  // visitorPercentage: use read_count from books table (maintained by existing trigger)
  const nthVisit = visitCount + 1;
  const totalBookReaders = stats.readCount;
  const visitorPercentage = totalBookReaders === 0 ? 100 : Math.round((nthVisit / totalBookReaders) * 100);

  console.log(`[markPageVisited] 👀 User ${userId} visited page ${pageId} in book ${bookId} (nthVisit=${nthVisit}, visitorPercentage=${visitorPercentage}%)`);

  return { session, nthVisit, visitorPercentage, readerUserId: userId };
}

/**
 * Marks a page as visited by updating user session and page progress
 * 
 * This function is called when a user actually navigates to a page (not during pre-generation).
 * It updates the active session to point to the new page and records the action choice.
 * 
 * @param userId - The user's unique identifier
 * @param book - Book data containing id and stats (readCount for visitor percentage)
 * @param dbPage - Page data containing id and visitCount (for nth visit calculation)
 * @param previousPageId - The previous page identifier (for navigation history), undefined for page 1
 * @param action - The action chosen to reach this page (undefined for page 1 or direct navigation)
 * @returns Promise that resolves with session data and visit statistics
 * 
 * Behavior:
 * - Updates user session to point to the new page
 * - Inserts page progress record with action choice (only if action is provided)
 * - Calculates visit statistics using denormalized data (visitCount, readCount)
 * - Trigger automatically increments visitCount in pages table on insert
 * 
 * Visit Statistics:
 * - nthVisit: The visit number for this user (e.g., "you're the 100th visitor")
 * - visitorPercentage: Percentage of book readers who have visited this page
 * 
 * Example:
 * ```typescript
 * const visitDetails = await markPageVisited(userId, book, dbPage, parentPageId, action);
 * console.log(`You're visitor #${visitDetails.nthVisit}`);
 * ```
 */
export async function markPageVisited(params: {
  userId: string,
  book: Pick<EnrichedBookData, 'id' | 'stats'>,
  visitedPage: Pick<DBPage, 'id' | 'page' | 'visitCount'>,
  actionedPageId?: string, // omit for page 1
  action?: Action // omit for page 1
  shouldConsumeCredits?: boolean // whether to consume credits for choosing a different action (only applicable for page 2 onwards)
}): Promise<BookPageVisit> {
  const {
    userId,
    book,
    visitedPage,
    actionedPageId,
    action,
    shouldConsumeCredits = false
  } = params;

  console.log(`[markPageVisited] 👣 Mark page visited:`, { visitedPage, actionedPageId, action, shouldConsumeCredits });

  const { id: bookId, stats } = book;
  const { id: pageId, page: pageNumber, visitCount } = visitedPage;

  if (action && action.destination.pageId !== pageId) {
    throw new Error(`action.destination.pageId and pageId mismatch`);
  }

  // Skip credit consumption for internal system user
  const isInternal = userId === process.env.SYSTEM_USER_ID;
  let correlationId: string | undefined;

  try {
    let result: BookPageVisit;

    if (shouldConsumeCredits && !isInternal) {
      // User request: consume credits and mark page visited atomically
      // This ensures credits are refunded if marking page visited fails
      const executeCreditsResult = await executeWithCredits<BookPageVisit>(
        userId,
        "CHOOSE_OTHER_ACTION",
        async (tx) => {
          return await markPageVisitedWithClient({
            userId,
            bookId,
            pageId,
            pageNumber,
            visitCount,
            stats,
            actionedPageId,
            action,
            client: tx
          });
        },
        {
          context: "choose_other_action",
          metadata: { bookId, pageId, pageNumber }
        }
      );
      
      result = executeCreditsResult.result;
      correlationId = executeCreditsResult.correlationId;
    } else {
      // Internal user or no credit consumption: mark page visited without credit transaction
      result = await markPageVisitedWithClient({
        userId,
        bookId,
        pageId,
        pageNumber,
        visitCount,
        stats,
        actionedPageId,
        action,
        client: dbWrite
      });
    }

    return result;
  } catch (error) {
    console.error(`[markPageVisited] ❌ Failed to mark page visited:`, getErrorMessage(error));
    
    // Refund credits idempotently using correlation ID for non-internal users
    // This prevents duplicate refunds if the error handler runs multiple times
    if (shouldConsumeCredits && !isInternal && correlationId) {
      try {
        await refundCredits(userId, "CHOOSE_OTHER_ACTION", {
          context: "choose_other_action_failed",
          metadata: { bookId, pageId, pageNumber },
          correlationId // Use correlation ID from executeWithCredits for idempotency
        });
        console.log('[markPageVisited] ✅ Credits refunded due to page visit failure');
      } catch (refundError) {
        // All retry attempts failed, log for manual review
        console.error('[markPageVisited] ⚠️ All refund attempts failed, manual review required:', {
          userId,
          correlationId,
          bookId,
          pageId,
          error: getErrorMessage(refundError)
        });
      }
    }
    
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
  pageId: string,
  options: {
    client?: DBClient
  } = {}
): Promise<DBStoryState | null> {
  // Try get from LRU cache first
  const cachedState = getCachedStoryState(pageId);
  if (cachedState) return cachedState;
  
  const { client = dbRead } = options;
  const result = await client
    .select()
    .from(storyStates)
    .where(eq(storyStates.pageId, pageId))
    .limit(1);
  
  const storyState = result[0] || null;
  
  // Cache the story state if found
  if (storyState) {
    setCachedStoryState(pageId, storyState);
  }
  
  return storyState;
}

/**
 * Performs shallow story state reconstruction by traversing parent chain and applying deltas
 * 
 * This function finds the nearest previous story state as the base and reconstructs
 * the current state by applying deltas from all pages in the chain. It respects
 * maxTraversalDepth but will stop early if it reaches page 1 (parentId is null).
 * 
 * @param dbPage - Current page data
 * @param maxTraversalDepth - Maximum depth to traverse up parent chain (default: 3)
 * @returns Promise resolving to reconstructed story state or null if reconstruction fails
 * 
 * Behavior:
 * - Finds nearest previous page with a stored story state as base
 * - Traverses up to maxTraversalDepth levels or until parentId is null (page 1), whichever comes first
 * - Applies deltas incrementally from base state to current page
 * - Persists reconstructed state to database for future lookups
 * 
 * @example
 * ```typescript
 * const state = await reconstructStoryStateFromParentChain(dbPage, 5);
 * if (state) {
 *   console.log(`Successfully reconstructed state for page ${state.page}`);
 * }
 * ```
 */
async function reconstructStoryStateFromParentChain(
  dbPage: DBPage, 
  maxTraversalDepth: number = MAX_TRAVERSAL_DEPTH_SHALLOW
): Promise<StoryState | null> {
  try {
    // Collect all pages in the parent chain from current to oldest
    const pageChain: DBPage[] = [];
    let currentPage: DBPage | null = dbPage;
    
    // Traverse up the parent chain with depth limit and respect for page 1 boundary
    for (let depth = 0; depth < maxTraversalDepth && currentPage; depth++) {
      pageChain.unshift(currentPage); // Add to beginning to build oldest-to-newest order
      
      // Check if this page has a story state
      const pageState = await getStoryStateFromDB(currentPage.id);
      if (pageState) {
        // Found the nearest previous state - this is our base state
        break;
      }
      
      // Move to parent page, or null if we've reached page 1 (parentId is null)
      currentPage = currentPage.parentId ? await getPageFromDB(currentPage.parentId) : null;
    }

    // If no state found in the traversed chain, return null
    if (!currentPage) {
      console.log(`[reconstructStoryStateFromParentChain] ⚠️ No story state found in parent chain for page ${dbPage.id} (traversed ${pageChain.length} pages)`);
      return null;
    }

    // Apply deltas incrementally from base state to current page
    const baseState = await getStoryStateFromDB(pageChain[0].id);
    if (!baseState) return null;
    let currentState = mapStoryStateFromDb(baseState);
    
    // Start from index 1 (skip the base state page) and apply each page's delta
    for (let i = 1; i < pageChain.length; i++) {
      const page = pageChain[i];
      console.log(`[reconstructStoryStateFromParentChain] 🧩 Applying state delta from page ${page.page}`);
      currentState = applyStateDelta(currentState, page.stateDelta);
    }

    // Ensure reconstructed state matches current page
    currentState.pageId = dbPage.id;
    currentState.page = dbPage.page;

    // Persist reconstructed story state to database (fire-and-forget)
    void insertStoryState(dbPage.bookId, dbPage.id, currentState);

    console.log(`[reconstructStoryStateFromParentChain] 🌳 Reconstructed state for page ${dbPage.id} from ${pageChain.length} pages (max depth: ${maxTraversalDepth})`);
    return currentState;
  } catch (error) {
    console.error(`[reconstructStoryStateFromParentChain] ❌ Failed to reconstruct story state for page ${dbPage.id}:`, error);
    return null;
  }
}

/**
 * Gets story state from database, deleted state cache, and lightweight parent chain reconstruction
 * 
 * This function provides basic state retrieval with minimal reconstruction capabilities.
 * It attempts database lookup first, then deleted state cache, and finally lightweight
 * parent chain traversal for incremental delta reconstruction.
 * 
 * Use {@link getStoryStateWithBranch} for full branch-aware reconstruction
 * when the state needs complex reconstruction from snapshots/deltas.
 * 
 * @param pageId - Page identifier for story state
 * @param options - Optional configuration parameters
 * @param options.dbPage - Pre-fetched page data to avoid extra database query
 * @param options.maxTraversalDepth - Maximum depth to traverse up parent chain (default: 3)
 * @returns Promise resolving to story state from DB/cache/reconstruction, or null if not found
 * 
 * Behavior:
 * - First attempts database lookup via getStoryStateFromDB()
 * - Falls back to deleted state cache if database lookup fails
 * - Performs lightweight reconstruction by traversing parent chain and applying deltas incrementally
 * - Uses reconstructStoryStateFromParentChain() for state reconstruction with depth limit
 * 
 * @example
 * ```typescript
 * // Basic state retrieval
 * const state = await getStoryState("page456");
 * if (state) {
 *   console.log(`Found state for page ${state.page}`);
 * } else {
 *   console.log("State not found, use getStoryStateWithBranch() for full reconstruction");
 * }
 * 
 * // With custom traversal depth
 * const state = await getStoryState("page789", { maxTraversalDepth: 5 });
 * ```
 * 
 * @note
 * Using dbWrite client to avoid read replica stale
 */
export async function getStoryState(
  pageId: string,
  options: { dbPage?: DBPage, maxTraversalDepth?: number } = {}
): Promise<StoryState | null> {
  try {
    // 1. Try direct query from database first
    const dbResult = await getStoryStateFromDB(pageId) ?? await getStoryStateFromDB(pageId, { client: dbWrite });
    if (dbResult) {
      console.log(`[getStoryState] ✅ Retrieved directly from database for page ${pageId}`);
      return mapStoryStateFromDb(dbResult);
    }
    
    // 2. Try find from recently deleted state cache
    const cachedState = getDeletedState(pageId);
    if (cachedState) {
      console.log(`[getStoryState] 🍪 Retrieved from deleted cache for page ${pageId}`);
      return cachedState;
    }

    // 3. Try lightweight story state reconstruction from parent pages
    const dbPage = options.dbPage ?? await getPageFromDB(pageId, { client: dbWrite });
    if (!dbPage) return null;
    
    // Note: NO heavy branch-aware reconstruction here, should use `getStoryStateWithBranch` instead
    const { maxTraversalDepth = MAX_TRAVERSAL_DEPTH_SHALLOW } = options;
    return await reconstructStoryStateFromParentChain(dbPage, maxTraversalDepth);
  } catch (error) {
    console.error(`[getStoryState] ❌ Failed to get story state for page ${pageId}:`, error);
    return null;
  }
}

export async function getStoryStateFromPage(dbPage: DBPage): Promise<StoryState | null> {
  return await getStoryState(dbPage.id, { dbPage });
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

export async function insertUserPageProgress(data: DBNewUserPageProgress & { client?: DBClient }): Promise<DBUserPageProgress | null> {
  try {
    const { action, nextPageId, client = dbWrite } = data;
    if (action.destination.pageId !== nextPageId) {
      throw new Error("Action destination pageId does not match nextPageId");
    }

    const newPageProgress = await client
      .insert(userPageProgress)
      .values(data)
      .onConflictDoUpdate({
        target: [userPageProgress.userId, userPageProgress.bookId, userPageProgress.actionedPageId],
        set: {
          action: data.action,
        }
      })
      .returning();

    return newPageProgress[0] || null;
  } catch (error) {
    console.error(`[insertUserPageProgress] ❌ Failed to insert user page progress:`, getErrorMessage(error));
    return null;
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
    const expectedPreviousPagesCount = Math.min(MAX_PAGE_HISTORY, actionedPage.page - 1);
    let currentPageId = actionedPage.parentId;
    
    // Traverse backwards through the parent chain
    while (currentPageId && previousPages.length < MAX_PAGE_HISTORY) {
      const userPage = await getUserPage(currentPageId, userId, { bookIdentifier: bookId, client: dbWrite });
      if (!userPage) break;
      
      previousPages.push(userPage);
      currentPageId = userPage.parentId;
    }
    
    // Reverse to get chronological order (oldest first)
    previousPages.reverse();

    if (previousPages.length !== expectedPreviousPagesCount) {
      console.warn(`[getPreviousPages] ⚠️ Expected ${expectedPreviousPagesCount} previous pages, got ${previousPages.length}`);
    }
    
    return previousPages;
  } catch (error) {
    console.error(`[getPreviousPages] ❌ Failed to get previous pages:`, getErrorMessage(error));
    return [];
  }
}

/**
 * Retrieves a user's story page with selected action context
 * 
 * This function fetches a specific page from the database and enriches it with
 * the user's interaction history by including the action they selected to reach
 * this page. The returned UserStoryPage contains both the page content and
 * the user's journey context.
 * 
 * @param pageId - Unique identifier of the page to retrieve
 * @param userId - User ID for fetching personalized action history
 * @param options - Optional configuration parameters
 * @param options.bookIdentifier - Book ID to validate page belongs to correct book
 * @param options.client - Database client to use (defaults to read client)
 * @returns Promise resolving to UserStoryPage with selected action, or null if page not found
 * 
 * @example
 * ```typescript
 * // Basic usage - get page with user's selected action
 * const userPage = await getUserPage("page123", "user456");
 * if (userPage) {
 *   console.log(`User selected: ${userPage.selectedAction?.text}`);
 * }
 * 
 * // With explicit book validation and write client
 * const page = await getUserPage("page789", "user456", {
 *   bookIdentifier: "book123",
 *   client: dbWrite
 * });
 * ```
 */
export async function getUserPage(pageId: string, userId: string, options: {
  bookIdentifier?: string,
  client?: DBClient
} = {}): Promise<UserStoryPage | null> {
  // Get the page from database
  const dbPage = await getPageFromDB(pageId, options);
  if (!dbPage) return null;
  
  // Get the action that led to this page from userPageProgress
  const selectedActions = await getPageActionsFromDB(userId, dbPage.bookId, pageId);
  
  // Map to UserStoryPage with selected action included
  return await mapToUserStoryPage(dbPage, userId, selectedActions);
}