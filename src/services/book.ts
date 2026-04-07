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
import { pages, books, userPageProgress } from "../db/schema.js";
import { and, eq, asc } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import type { DBBook, DBNewBook, DBNewPage, DBPage } from "../types/schema.js";
import type { Book, BookStatus } from "../types/book.js";
import type { StoryPage, PersistedStoryPage, UserStoryPage, Action } from "../types/story.js";

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
  pageMeta: Pick<PersistedStoryPage, 'bookId' | 'branchId' | 'parentId'>,
): Promise<PersistedStoryPage> {
  const { bookId, branchId, parentId } = pageMeta;
  try {
    const result = await dbWrite
      .insert(pages)
      .values({
        userId,
        bookId,
        branchId,
        parentId,
        page: pageNumber,
        text: page.text,
        mood: page.mood,
        place: page.place || "Unknown", // Default place if not provided
        timeOfDay: page.timeOfDay || "unknown",
        charactersPresent: [], // Empty array for root page
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
export async function getBookPages(bookId: string, branchId?: string): Promise<DBPage[]> {
  const conditions = [eq(pages.bookId, bookId)];
  
  // If branchId is provided, add branch condition
  if (branchId !== undefined) {
    conditions.push(eq(pages.branchId, branchId));
  }
  
  const result = await dbRead
    .select()
    .from(pages)
    .where(and(...conditions))
    .orderBy(pages.page);

  return result;
}

/**
 * Inserts a new book into the database
 * 
 * @param userId - User identifier who owns the book
 * @param displayTitle - Display title for the book
 * @param totalPages - Total number of pages in the book
 * @param hook - Hook text for the book
 * @param summary - Summary text for the book
 * @param keywords - Keywords array for the book
 * @param status - Book status (active, archived, draft)
 * @returns Promise resolving to the inserted book record
 */
export async function insertBook(book: DBNewBook): Promise<DBBook> {
  const result = await dbWrite.insert(books).values({
    ...book,
    status: 'active',
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
export async function getBookFromDB(bookId: string): Promise<DBBook | null> {
  const result = await dbRead
    .select()
    .from(books)
    .where(eq(books.id, bookId))
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
export async function getBook(bookId: string): Promise<Book | null> {
  // Try database first
  const dbResult = await getBookFromDB(bookId);
  if (dbResult) {
    return mapBookFromDb(dbResult);
  }
  
  return null;
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
export async function getPageFromDB(pageId: string, branchId?: string): Promise<DBPage | null> {
  try {
    const conditions = [eq(pages.id, pageId)];
    
    // If branchId is provided, add branch condition
    if (branchId !== undefined) {
      conditions.push(eq(pages.branchId, branchId));
    }
    
    const result = await dbRead
      .select()
      .from(pages)
      .where(and(...conditions))
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
    branchId: dbPage.branchId,
    page: dbPage.page,
    text: dbPage.text,
    mood: dbPage.mood || undefined,
    place: dbPage.place || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    charactersPresent: dbPage.charactersPresent || [],
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
    branchId: dbPage.branchId,
    page: dbPage.page,
    text: dbPage.text,
    mood: dbPage.mood || undefined,
    place: dbPage.place || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    charactersPresent: dbPage.charactersPresent || [],
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
 * - Excludes database-specific fields like id, bookId, parentId, branchId
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
    mood: dbPage.mood || undefined,
    place: dbPage.place || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    charactersPresent: dbPage.charactersPresent || [],
    keyEvents: dbPage.keyEvents || [],
    importantObjects: dbPage.importantObjects || [],
    actions: dbPage.actions || [],
    addTraumaTag: dbPage.addTraumaTag || undefined,
    characterUpdates: dbPage.characterUpdates || undefined,
    placeUpdates: dbPage.placeUpdates || undefined,
  } satisfies StoryPage;
}

/**
 * Maps database book data to the Book type with proper type safety
 * 
 * Converts nullable database fields to appropriate types and handles
 * optional fields according to the Book interface specification.
 * 
 * @param dbBook - Raw book data from database
 * @returns Properly typed Book object
 */
export function mapBookFromDb(dbBook: DBBook): Book {
  return {
    id: dbBook.id,
    userId: dbBook.userId,
    title: dbBook.title,
    totalPages: dbBook.totalPages,
    language: dbBook.language || '',
    hook: dbBook.hook || '',
    summary: dbBook.summary || '',
    image: dbBook.image || undefined,
    imageId: dbBook.imageId || undefined,
    trendingScore: dbBook.trendingScore || 0,
    keywords: dbBook.keywords,
    status: dbBook.status || 'active',
    mc: dbBook.mc,
    createdAt: dbBook.createdAt,
    updatedAt: dbBook.updatedAt,
  };
}