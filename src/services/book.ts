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
import type ImageKit from "@imagekit/nodejs";
import { and, eq, asc, or } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import type { DBBook, DBNewBook, DBNewPage, DBPage } from "../types/schema.js";
import type { Book, BookStatus } from "../types/book.js";
import type { StoryPage, PersistedStoryPage, UserStoryPage, Action, StoryState, EnrichedAction } from "../types/story.js";
import { formatPlacesForPrompt } from "../utils/places.js";
import { formatBookMetaForPrompt } from "../utils/books.js";
import { formatCharactersForPrompt } from "../utils/characters.js";
import type { AIDocument } from "../types/ai-chat.js";
import { formatSystemPromptWithDocuments } from "../utils/ai-chat.js";
import { IS_PRODUCTION } from "../config/constants.js";
import { geminiGenerateImage } from "../utils/ai-image.js";
import { deleteFileFromImageKit, uploadBookCover } from "./image.js";
import { sanitizeText } from "../utils/text-processing.js";
import { generateId } from "../utils/uuid.js";
import type { StoryMC } from "../types/character.js";
import type { ImageUploadSource } from "../types/image.js";

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
  pageMeta: Pick<DBNewPage, 'bookId' | 'branchId' | 'parentId'>,
): Promise<PersistedStoryPage> {
  const { bookId, branchId, parentId } = pageMeta;
  try {
    const newPageData: DBNewPage = {
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
      aiProvider: page.aiProvider || null,
      aiModel: page.aiModel || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await dbWrite
      .insert(pages)
      .values(newPageData)
      .returning();

    return mapToPersistedStoryPage(result[0]);
  } catch (error) {
    console.error(`Failed to insert story page for page ${pageNumber}:`, getErrorMessage(error));
    throw new Error(`Unable to insert story page: ${getErrorMessage(error)}`, { cause: error });
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
 * @param totalPages - Total number of pages in the book
 * @param hook - Hook text for the book
 * @param summary - Summary text for the book
 * @param keywords - Keywords array for the book
 * @param status - Book status (active, archived, draft)
 * @returns Promise resolving to the inserted book record
 */
export async function insertBook(book: DBNewBook): Promise<DBBook> {
  const newBookData: DBNewBook = {
    ...book,
    id: book.id ?? generateId(),
    title: sanitizeText(book.title),
    hook: book.hook ? sanitizeText(book.hook) : null,
    summary: book.summary ? sanitizeText(book.summary) : null,
    status: 'active' satisfies BookStatus,
    mc: book.mc satisfies StoryMC,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  console.log(`[insertBook] 📔 newBookData:`, newBookData);
  const result = await dbWrite.insert(books).values(newBookData).returning();
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
 * Resolves a book by identifier (slug or UUID v7)
 * 
 * This function uses a single OR query to match either slug or UUID,
 * enabling the frontend to use both interchangeably without breaking changes.
 * 
 * @param identifier - Book slug or UUID v7
 * @returns Promise resolving to the book record or null if not found
 * 
 * @example
 * ```typescript
 * // Lookup by slug
 * const book = await resolveBook("twistloom");
 * 
 * // Lookup by UUID
 * const book = await resolveBook("0190f1234567");
 * 
 * // Returns null if not found
 * const book = await resolveBook("nonexistent");
 * ```
 */
export async function resolveBook(identifier: string): Promise<Book | null> {
  const book = await dbRead
    .select()
    .from(books)
    .where(
      or(
        eq(books.slug, identifier),
        eq(books.id, identifier)
      )
    )
    .limit(1);

  if (book.length > 0) {
    return mapBookFromDb(book[0]);
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
    throw new Error(`Unable to retrieve page: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Gets user's selected action for a specific page
 * 
 * @param userId - The user's unique identifier
 * @param bookId - The book's unique identifier
 * @param pageId - The page's unique identifier
 * @returns Promise resolving to user's selected action or null if not found
 */
export async function getPageActionFromDB(userId: string, bookId: string, pageId: string): Promise<Action | null> {
  const userProgress = await dbRead
    .select()
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.userId, userId),
      eq(userPageProgress.bookId, bookId),
      eq(userPageProgress.pageId, pageId),
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
    // Try to get the specific page by pageId
    const dbPage = await getPageFromDB(pageId);
    if (dbPage) {
      // Get user page progress to include selected action
      return completePageWithSelectedAction(dbPage, userId);
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
      return completePageWithSelectedAction(firstPage[0], userId);
    }
    
    return null;
  } catch (error) {
    console.error(`Failed to get story page for book ${bookId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve story page: ${getErrorMessage(error)}`, { cause: error });
  }
}

async function completePageWithSelectedAction(dbPage: DBPage, userId: string): Promise<UserStoryPage> {
  // Get user page progress to include selected action
  const selectedAction = await getPageActionFromDB(userId, dbPage.bookId, dbPage.id);
  return mapToUserStoryPage(dbPage, selectedAction || undefined);
}

/**
 * Maps database Page type to domain UserStoryPage type with optional selected action
 * 
 * @param dbPage - Page data from database
 * @param selectedAction - User's selected action for this page (optional)
 * @returns UserStoryPage domain object with optional selectedAction and enriched actions
 * 
 * Behavior:
 * - Maps all fields from database to domain types
 * - Enriches actions with nextPageNumber and nextBranchId for frontend URL building
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
 * console.log(`Next page: ${userPage.actions[0].nextPageNumber}`);
 * ```
 */
export function mapToUserStoryPage(dbPage: DBPage, selectedAction?: Action): UserStoryPage {
  const persistedPage = mapToPersistedStoryPage(dbPage);
  return {
    ...persistedPage,
    actions: enrichActions(dbPage.actions || [], persistedPage),
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
    aiProvider: dbPage.aiProvider || 'none',
    aiModel: dbPage.aiModel || 'none',
  } satisfies PersistedStoryPage;
}

/**
 * Enriches actions with navigation metadata for frontend URL building
 * 
 * This function computes nextPageNumber and nextBranchId for each action
 * based on the current page context. Actions without a pageId will not
 * have navigation metadata.
 * 
 * @param actions - Array of actions to enrich
 * @param currentPage - Current page with page number and branch ID
 * @returns Array of enriched actions with navigation metadata
 * 
 * Behavior:
 * - Adds nextPageNumber (current page + 1) if action has pageId
 * - Adds nextBranchId (current branchId) if action has pageId
 * - Actions without pageId remain unchanged
 * - Preserves all original action properties
 * 
 * Example:
 * ```typescript
 * const enriched = enrichActions(page.actions, page);
 * // enriched[0].nextPageNumber === page.page + 1
 * // enriched[0].nextBranchId === page.branchId
 * ```
 */
export function enrichActions(
  actions: Action[],
  currentPage: Pick<PersistedStoryPage, 'page' | 'branchId'>
): EnrichedAction[] {
  return actions.map(action => ({
    ...action,
    nextPageNumber: action.pageId ? currentPage.page + 1 : undefined,
    nextBranchId: action.pageId ? currentPage.branchId : undefined,
  }));
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
    aiProvider: dbPage.aiProvider || 'none',
    aiModel: dbPage.aiModel || 'none',
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

/**
 * Core system prompt defining the AI writer's persona and fundamental behavior
 * 
 * This prompt establishes the psychological thriller writer persona inspired by
 * R.L. Stine but darker, with specific rules for narrative manipulation and
 * psychological horror elements.
 */
export function buildBookMetaDocuments(book?: Book, state?: StoryState): AIDocument[] {
  if (!book) return [];
  
  const bookMeta = { title: `BOOK META`, snippet: formatBookMetaForPrompt(book) };
  if (!state) return [bookMeta];
  
  const charactersMeta = { title: `CHARACTERS`, snippet: formatCharactersForPrompt(state.characters) };
  const placesMeta = { title: `PLACES`, snippet: formatPlacesForPrompt(state) };

  return [bookMeta, charactersMeta, placesMeta];
}

/**
 * Generate book cover and upload directly to ImageKit without disk I/O
 * 
 * Optimized version that skips disk writing and uploads buffers directly to ImageKit.
 * This is the preferred method for production environments.
 * 
 * @param book - Book object with metadata
 * @param state - Optional story state context
 * @returns Promise resolving to void (updates book with ImageKit URL)
 */
export async function generateCoverImages(book: Book, state?: StoryState, total?: number): Promise<Buffer<ArrayBufferLike>[]> {
  // Skip generation in development since there's no way to persist without ImageKit
  if (!IS_PRODUCTION) {
    console.log(`[generateAndUpdateBookCoverImage] ⏩ Skipping cover generation in development`);
    return [];
  }

  try {
    const bookMeta = buildBookMetaDocuments(book, state);
    const mcGender = book.mc.gender;
    const mcAge = book.mc.age;
    const mcAppearance = mcGender == 'male' ? 'dapper' : 'lovely';
    const taskPrompt = `Create compelling book cover for thriller novel - dramatic, clear minimum texts, high-impact design, cartoony Goosebumps style (not realistic). Focus on ${mcAppearance} ${mcAge} years-old ${mcGender} protagonist.`;
    const fullPrompt = formatSystemPromptWithDocuments('gemini', {
      systemPrompt: taskPrompt,
      documents: bookMeta,
      logPrompts: true
    });
    
    // Generate images without writing to disk
    const { buffers } = await geminiGenerateImage(fullPrompt, {
      numberOfImages: total || 1, // TODO: 3 for premium users
      aspectRatio: "3:4",
    });
    
    if (buffers.length > 0) {
      console.log(`[generateAndUpdateBookCoverImage] 🖼️ Generated ${buffers.length} cover image buffer(s) for book ${book.id}`);
    } else {
      console.warn(`[generateAndUpdateBookCoverImage] ⚠️ No cover image generated for book ${book.id}`);
    }

    return buffers;
  } catch(error) {
    console.error('[generateAndUpdateBookCoverImage] ❌ Error generating and updating book cover:', {bookId: book.id, error: getErrorMessage(error)});
    // Fail silently, don't throw error
    return [];
  }
}

/**
 * Updates book cover image with ImageKit upload
 * 
 * Handles image upload to ImageKit. Does NOT update the book record or queue deletion.
 * Callers should handle book update and deletion queue separately.
 * 
 * @param bookMeta - Book metadata (id, title, keywords)
 * @param image - Image source (buffer, file, URL, or base64)
 * @returns Promise resolving to upload result or null on failure
 * 
 * @example
 * ```typescript
 * const result = await uploadBookCoverImage(
 *   { id: 'book123', title: 'My Book', keywords: ['mystery'] },
 *   imageBuffer
 * );
 * if (result) {
 *   await updateBook(bookId, { image: result.url, imageId: result.fileId });
 *   await queueImageForDeletion(oldImageId);
 * }
 * ```
 */
export async function uploadBookCoverImage(
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords'>,
  image: ImageUploadSource
): Promise<ImageKit.Files.FileUploadResponse | null> {
  try {
    const uploadResult = await uploadBookCover(image, bookMeta);
    
    if (!uploadResult?.url) {
      console.warn(`[uploadBookCoverImage] ⚠️ Failed to upload to ImageKit for book ${bookMeta.id}`);
      return null;
    }
    
    console.log(`[uploadBookCoverImage] 🌐 Uploaded to ImageKit: ${uploadResult.url}`);
    return uploadResult;
  } catch (error) {
    console.error('[uploadBookCoverImage] ❌ Error uploading cover image:', {bookId: bookMeta.id, error: getErrorMessage(error)});
    return null;
  }
}

/**
 * Generates AI cover image and updates book with new image
 * 
 * This function:
 * - Generates cover image using AI based on book content and state
 * - Uploads the generated image to ImageKit
 * - Updates the book record with new image URL and ID
 * - Deletes old image from ImageKit (with fallback to deletion queue)
 * 
 * @param book - Book object with metadata for image generation
 * @param state - Optional story state context for generation
 * @returns Promise resolving when cover is generated and updated
 * 
 * @example
 * ```typescript
 * await generateAndUpdateBookCoverImage(book, storyState);
 * ```
 */
export async function generateAndUpdateBookCoverImage(book: Book, state?: StoryState): Promise<void> {
  const buffers = await generateCoverImages(book, state, 1);
  if (buffers.length === 0) return; // Cover image generation failed

  const oldImageId = book.imageId;
  const uploadResult = await uploadBookCoverImage(book, buffers[0]); // Direct buffer upload
  
  if (uploadResult) {
    // Update book with new image URL and ID
    await updateBook(book.id, {
      image: uploadResult.url,
      imageId: uploadResult.fileId
    });
    
    // Delete old image from ImageKit (with fallback to deletion queue)
    if (oldImageId) {
      await deleteFileFromImageKit(oldImageId);
    }
  }
}