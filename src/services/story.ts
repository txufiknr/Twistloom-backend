import { dbRead, dbWrite } from "../db/client.js";
import { pages, books, storyStates } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import type { StoryPage, StoryState, PersistedStoryPage } from "../types/story.js";
import { DBBook, DBNewBook, DBNewPage, DBPage, DBStoryState } from "../types/schema.js";
import type { BookStatus } from "../types/book.js";
import { StoryMC } from "../types/character.js";
import { deletedStateCache } from "./story-state-cache.js";
import { mapToPersistedStoryPage } from "./book.js";
import { getErrorMessage } from "../utils/error.js";

/**
 * Inserts a story page into database (supports both root and child pages)
 * 
 * @param userId - User identifier who owns the page
 * @param pageNumber - The page number in the story sequence
 * @param page - The story page content to insert
 * @param bookId - The book's unique identifier
 * @param parentPageId - Parent page identifier for branching (optional for root pages)
 * @returns Promise that resolves when page is inserted
 * 
 * Behavior:
 * - Stores AI-generated page in pages table
 * - Associates with book and page number
 * - Creates parent-child relationship for branching when parentPageId provided
 * - Handles both root pages (no parent) and child pages (with parent)
 * 
 * Examples:
 * ```typescript
 * // Root page
 * const firstPage = await insertStoryPage("user123", 1, firstPageContent, "book456");
 * 
 * // Child page
 * const childPage = await insertStoryPage("user123", 5, childPageContent, "book456", "parent123");
 * ```
 */
export async function insertStoryPage(
  userId: string,
  pageNumber: number,
  page: StoryPage,
  bookId: string,
  parentPageId?: string,
): Promise<PersistedStoryPage> {
  try {
    const result = await dbWrite
      .insert(pages)
      .values({
        userId,
        parentId: parentPageId,
        bookId,
        page: pageNumber,
        text: page.text,
        mood: page.mood,
        place: page.place || "Unknown", // Default place if not provided
        characters: [], // Empty array for root page
        keyEvents: [], // Empty array for root page
        importantObjects: [], // Empty array for root page
        actions: page.actions,
        addTraumaTag: page.addTraumaTag || null,
        characterUpdates: page.characterUpdates || null,
        placeUpdates: page.placeUpdates || null,
        createdAt: new Date(),
        updatedAt: new Date()
      } satisfies DBNewPage)
      .returning();

    return mapToPersistedStoryPage(result[0]);
  } catch (error) {
    console.error(`Failed to insert story page for page ${pageNumber}:`, getErrorMessage(error));
    throw new Error(`Unable to insert story page: ${getErrorMessage(error)}`);
  }
}

/**
 * Updates an existing story page in the database
 * 
 * @param pageId - Page identifier to update
 * @param updates - Partial story page data to update
 * @returns Promise resolving to the updated page record
 */
export async function updateStoryPage(
  pageId: string,
  updates: Partial<Omit<DBNewPage, 'id' | 'bookId' | 'pageNumber' | 'createdAt'>>
): Promise<DBPage> {
  const result = await dbWrite
    .update(pages)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning();

  return result[0];
}

/**
 * Retrieves all pages for a book in order
 * 
 * @param bookId - Book identifier to retrieve pages for
 * @returns Promise resolving to array of page records ordered by page number
 */
export async function getBookPages(bookId: string): Promise<DBPage[]> {
  const result = await dbRead
    .select()
    .from(pages)
    .where(eq(pages.bookId, bookId))
    .orderBy(pages.page);

  return result;
}

/**
 * Inserts a new book into the database
 * 
 * @param userId - User identifier who owns the book
 * @param displayTitle - Display title for the book
 * @param hook - Hook text for the book
 * @param summary - Summary text for the book
 * @param keywords - Keywords array for the book
 * @param status - Book status (active, archived, draft)
 * @returns Promise resolving to the inserted book record
 */
export async function insertBook(
  userId: string,
  displayTitle: string,
  hook: string,
  summary: string,
  keywords: string[],
  status: BookStatus = 'active',
  mc: StoryMC,
): Promise<DBBook> {
  const result = await dbWrite.insert(books).values({
    userId,
    displayTitle,
    hook,
    summary,
    keywords,
    status,
    trendingScore: 0,
    mc,
    createdAt: new Date(),
    updatedAt: new Date()
  }).returning();

  return result[0];
}

/**
 * Retrieves a book by ID
 * 
 * @param bookId - Book identifier to retrieve
 * @returns Promise resolving to the book record or null if not found
 */
export async function getBook(bookId: string): Promise<DBBook | null> {
  const result = await dbRead
    .select()
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  return result[0] || null;
}

/**
 * Updates an existing book in the database
 * 
 * @param bookId - Book identifier to update
 * @param updates - Partial book data to update
 * @returns Promise resolving to the updated book record
 */
export async function updateBook(
  bookId: string,
  updates: Partial<Omit<DBNewBook, 'id' | 'userId' | 'createdAt'>>
): Promise<DBBook> {
  const result = await dbWrite
    .update(books)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(books.id, bookId))
    .returning();

  return result[0];
}

/**
 * Retrieves all books for a user ordered by creation date
 * 
 * @param userId - User identifier to retrieve books for
 * @param status - Optional status filter
 * @returns Promise resolving to array of book records ordered by creation date
 */
export async function getUserBooks(
  userId: string,
  status?: BookStatus
): Promise<DBBook[]> {
  if (status) {
    return await dbRead
      .select()
      .from(books)
      .where(and(eq(books.userId, userId), eq(books.status, status)))
      .orderBy(books.createdAt);
  }
  
  return await dbRead
    .select()
    .from(books)
    .where(eq(books.userId, userId))
    .orderBy(books.createdAt);
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
  
  return null;
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
    cachedEndingArchetype: dbStoryState.cachedEndingArchetype || undefined,
    characters: dbStoryState.characters || {},
    places: dbStoryState.places || {},
    pageHistory: dbStoryState.pageHistory || [],
    actionsHistory: dbStoryState.actionsHistory || [],
    contextHistory: dbStoryState.contextHistory || "",
  };
}