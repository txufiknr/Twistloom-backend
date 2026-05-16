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

import { type DBClient, dbRead, dbWrite } from "../db/client.js";
import { pages, books, users, userPageProgress } from "../db/schema.js";
import type ImageKit from "@imagekit/nodejs";
import { and, eq, asc, or, desc, sql } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { getEnrichedBookSelect } from "./book-controller.js";
import type { DBBook, DBNewBook, DBNewPage, DBPage, DBUpdateBook } from "../types/schema.js";
import type { Book, BookStatus, EnrichedBookData } from "../types/book.js";
import type { StoryPage, PersistedStoryPage, UserStoryPage, Action, StoryState, StoryPageMeta, EnrichedStoryPage } from "../types/story.js";
import { getStoryStateFromPage } from "./story.js";
import { formatPlacesForPrompt } from "../utils/places.js";
import { formatBookMetaForPrompt } from "../utils/books.js";
import { formatCharactersForPrompt } from "../utils/characters.js";
import type { AIDocument } from "../types/ai-chat.js";
import { formatSystemPromptWithDocuments } from "../utils/ai-chat.js";
import { IS_PRODUCTION } from "../config/env.js";
import { geminiGenerateImage } from "../utils/ai-image.js";
import { retryWithBranchConflict, isUniqueConstraintError } from "../utils/retry.js";
import { generateBranchId } from "./story-branch.js";
import { deleteFileFromImageKit, uploadBookCover } from "./image.js";
import { sanitizeText, generateSlug } from "../utils/text-processing.js";
import { generateId, isValidUuid } from "../utils/uuid.js";
import type { StoryMC } from "../types/character.js";
import type { ImageUploadSource } from "../types/image.js";
import { extractStateDelta, getStoryStateInfo } from "../utils/story.js";
import { getTranslatedText, shouldTranslate } from "./translation.js";
import { LRUCache } from "lru-cache";

/**
 * LRU cache for enriched book data
 * 
 * Cache key format: "book:{identifier}:{userId|null}"
 * - identifier: book slug or ID
 * - userId: current user ID (or "null" for anonymous)
 * 
 * TTL: 5 minutes to balance freshness with performance
 * Max size: 1000 entries to prevent memory bloat
 */
const enrichedBookCache = new LRUCache<string, EnrichedBookData>({
  max: 1000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

/**
 * LRU cache for public book statistics
 * 
 * Cache key: "public:book:stats"
 * 
 * TTL: 3 minutes to balance freshness with performance
 * Max size: 1 entry (single global stats object)
 */
const publicBookStatsCache = new LRUCache<string, {
  storiesCreated: number;
  branchesExplored: number;
  pagesCrafted: number;
}>({
  max: 1,
  ttl: 2 * 60 * 1000, // 2 minutes
});

/**
 * LRU cache for enriched page data
 * 
 * Cache key format: "page:{pageId}:{userId|null}:{translate}:{acceptLanguage|en}"
 * - pageId: Page identifier
 * - userId: Current user ID (or "null" for anonymous) - affects selectedActions
 * - translate: Whether translation is enabled
 * - acceptLanguage: Target language code (or "en" default) - affects translatedText
 * 
 * Only caches pages with no incomplete actions (all actions have destinations).
 * Pages with pending generation are not cached since they change frequently.
 * 
 * TTL: 2 minutes to balance freshness with performance
 * Max size: 500 entries to prevent memory bloat
 */
const enrichedPageCache = new LRUCache<string, EnrichedStoryPage>({
  max: 500,
  ttl: 2 * 60 * 1000, // 2 minutes
});

/**
 * Generates cache key for enriched page data
 * 
 * @param pageId - Page identifier
 * @param userId - Optional current user ID
 * @param translate - Whether translation is enabled
 * @param acceptLanguage - Optional target language code
 * @returns Cache key string
 */
function getEnrichedPageCacheKey(
  pageId: string,
  userId?: string | null,
  translate: boolean = false,
  acceptLanguage?: string | null
): string {
  return `page:${pageId}:${userId || 'null'}:${translate}:${acceptLanguage || 'en'}`;
}

/**
 * Invalidates cache entries for a specific page
 * 
 * Removes all cache entries for a page regardless of user context or language.
 * Called when page data is mutated (update, delete, action generation completes).
 * 
 * @param pageId - Page identifier to invalidate
 */
export function invalidateEnrichedPageCache(pageId: string): void {
  // Find and delete all cache keys matching the page identifier
  for (const key of enrichedPageCache.keys()) {
    if (key.startsWith(`page:${pageId}:`)) {
      enrichedPageCache.delete(key);
    }
  }
}

/**
 * Generates cache key for enriched book data
 * 
 * @param identifier - Book slug or ID
 * @param currentUserId - Optional current user ID
 * @returns Cache key string
 */
function getEnrichedBookCacheKey(identifier: string, currentUserId?: string | null): string {
  return `book:${identifier}:${currentUserId || 'null'}`;
}

/**
 * Invalidates cache entries for a specific book
 * 
 * Removes all cache entries for a book regardless of user context.
 * Called when book data is mutated (create, update, delete).
 * 
 * @param bookIdentifier - Book slug or ID to invalidate
 */
export function invalidateEnrichedBookCache(bookIdentifier: string): void {
  // Find and delete all cache keys matching the book identifier
  for (const key of enrichedBookCache.keys()) {
    if (key.startsWith(`book:${bookIdentifier}:`)) {
      enrichedBookCache.delete(key);
    }
  }
}

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
  pageMeta: StoryPageMeta,
  options: { client?: DBClient } = {},
): Promise<PersistedStoryPage> {
  const { client = dbWrite } = options;
  const { bookId, branchId, parentId, selectedAction } = pageMeta;
  
  try {
    // Early validation: check specific selectedAction in parent page if provided
    if (parentId && selectedAction) {
      const parentPage = await getPageFromDB(parentId, { client });
      if (!parentPage) {
        throw new Error(`Parent page ${parentId} not found`);
      }
      
      // Find the specific action in parent that matches the selectedAction
      const matchingAction = parentPage.actions.find(action => action.text === selectedAction.text);
      
      // Check if the matching action already has a destination pageId
      if (matchingAction?.destination?.pageId && matchingAction.destination.pageId !== 'pending') {
        console.warn(`[insertStoryPage] ⚠️ Parent action "${selectedAction.text}" already has destination pageId ${matchingAction.destination.pageId}, skipping insertion`);
        // Return the existing page instead of inserting a new one
        const existingPage = await getPageFromDB(matchingAction.destination.pageId, { client });
        if (existingPage) {
          return mapToPersistedStoryPage(existingPage);
        }
        // If existing page not found, proceed with insertion (race condition handling)
      }
    }

    // // Count actions without destinations for initial pendingGenerationCount
    // const pendingGenerationCount = pageMeta.pendingGenerationCount ?? page.actions.filter(action => !action.destination?.pageId).length;

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
      charactersPresent: page.charactersPresent || [],
      keyEvents: page.keyEvents || [],
      importantObjects: page.importantObjects || [],
      actions: page.actions,
      stateDelta: extractStateDelta(page),
      aiProvider: page.aiProvider || null,
      aiModel: page.aiModel || null,
      // pendingGenerationCount,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Use retryWithBranchConflict to handle unique constraint violations
    const result = await retryWithBranchConflict(
      async (data: DBNewPage) => {
        const insertResult = await client
          .insert(pages)
          .values(data)
          .returning();
        return insertResult[0];
      },
      newPageData,
      generateBranchId,
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 4000,
        onRetry: (attempt) => {
          console.log(`[insertStoryPage] 🔄 Branch conflict retry ${attempt}/3 for page ${pageNumber} (parent: ${parentId})`);
        },
        shouldRetry: (error) => {
          // Only retry on unique constraint violations
          return isUniqueConstraintError(error);
        }
      }
    );

    const insertedPage = mapToPersistedStoryPage(result);
    return insertedPage;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[insertStoryPage] ❌ Failed to insert story page for page ${pageNumber}:`, errorMessage);
    throw new Error(`Unable to insert story page: ${errorMessage}`, { cause: error });
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
 * Generates a unique slug for a book by checking existing slugs
 * 
 * Creates a slug from the title and ensures uniqueness by appending
 * a numeric suffix if the base slug already exists.
 * 
 * @param title - The book title to generate slug from
 * @returns Promise resolving to a unique slug string
 * 
 * @example
 * ```typescript
 * const slug = await generateUniqueSlug("The Amazing Adventure");
 * // Returns "amazing-adventure" or "amazing-adventure-2" if already taken
 * ```
 */
async function generateUniqueSlug(title: string): Promise<string> {
  const RESERVED_SLUGS = new Set(['stats', 'explore']);
  const baseSlug = generateSlug(title);

  if (baseSlug) {
    // Check if base slug already exists
    const existing = await dbRead
      .select({ slug: books.slug })
      .from(books)
      .where(eq(books.slug, baseSlug))
      .limit(1);

    // If base slug is available and not a reserved endpoint, use it
    if (existing.length === 0 && !RESERVED_SLUGS.has(baseSlug)) {
      return baseSlug;
    }

    // Base slug exists or is reserved, try with numeric suffixes
    let suffix = 2;
    let uniqueSlug = `${baseSlug}-${suffix}`;

    while (suffix <= 100) { // Prevent infinite loops
      // Skip any suffix that would produce a reserved slug
      if (RESERVED_SLUGS.has(uniqueSlug)) {
        suffix++;
        uniqueSlug = `${baseSlug}-${suffix}`;
        continue;
      }

      const existingWithSuffix = await dbRead
        .select({ slug: books.slug })
        .from(books)
        .where(eq(books.slug, uniqueSlug))
        .limit(1);

      if (existingWithSuffix.length === 0) {
        return uniqueSlug;
      }

      suffix++;
      uniqueSlug = `${baseSlug}-${suffix}`;
    }

    // Fallback: use random ID if we can't find a unique slug (avoid reserved collisions)
    console.warn(`[generateUniqueSlug] ⚠️ Could not generate unique slug for "${title}", using random ID`);
  }

  // If base slug is empty, generate a random one (avoid reserved collisions)
  let id = generateId().substring(0, 8);
  while (RESERVED_SLUGS.has(id)) {
    id = generateId().substring(0, 8);
  }
  return id;
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
export async function insertBook(book: DBNewBook, options: { client?: DBClient } = {}): Promise<DBBook> {
  const { client = dbWrite } = options;
  // Generate unique slug from title
  const uniqueSlug = await generateUniqueSlug(book.title);
  
  const newBookData: DBNewBook = {
    ...book,
    id: book.id ?? generateId(),
    slug: uniqueSlug,
    title: sanitizeText(book.title),
    hook: book.hook ? sanitizeText(book.hook) : null,
    summary: book.summary ? sanitizeText(book.summary) : null,
    status: 'active' satisfies BookStatus,
    mc: book.mc satisfies StoryMC,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await client.insert(books).values(newBookData).returning();
  const insertedBook = result[0];
  console.log(`[insertBook] 📔 Inserted book with slug "${uniqueSlug}":`, insertedBook);
  
  // Invalidate cache for this book (by both ID and slug)
  invalidateEnrichedBookCache(insertedBook.id);
  invalidateEnrichedBookCache(insertedBook.slug!);
  
  return insertedBook;
}

/**
 * Retrieves a book by ID
 * 
 * @param bookId - Book identifier to retrieve
 * @returns Promise resolving to the book record or null if not found
 */
export async function getBookFromDB(bookId: string, options: {
  client?: DBClient // use dbWrite to avoid read replica stale
} = {}): Promise<DBBook | null> {
  const { client = dbRead } = options;

  // TODO: need to implement LRU cache (only for 'active' book)?
  const result = await client
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
  try {
    // const dbResult = await getBookFromDB(bookId);
    const dbResult = await getBookFromDB(bookId) ?? await getBookFromDB(bookId, { client: dbWrite });
    if (dbResult) return mapBookFromDb(dbResult);
  } catch {
    // Ignore errors
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
  // Build query conditions dynamically based on identifier format
  const conditions = [eq(books.slug, identifier)];
  
  // Only add UUID condition if identifier is a valid UUID
  if (isValidUuid(identifier)) {
    conditions.push(eq(books.id, identifier));
  }

  const book = await dbRead
    .select()
    .from(books)
    .where(or(...conditions))
    .limit(1);

  if (book.length > 0) {
    return mapBookFromDb(book[0]);
  }

  return null;
}

/**
 * Retrieves an enriched book with author info, stats, and user-specific flags
 * 
 * Uses LRU cache for performance. Cache key includes both book identifier
 * and user ID since results are user-specific (isLiked, isRead flags).
 * 
 * @param identifier - Book slug or ID to retrieve
 * @param currentUserId - Optional current user ID for user-specific flags (isLiked, isRead)
 * @returns Promise resolving to enriched book data or null if not found
 */
export async function getEnrichedBook(
  identifier: string,
  currentUserId?: string | null
): Promise<EnrichedBookData | null> {
  const cacheKey = getEnrichedBookCacheKey(identifier, currentUserId);
  
  // Check cache first
  const cached = enrichedBookCache.get(cacheKey);
  if (cached) return cached;

  // Build query conditions dynamically based on identifier format
  const conditions = [eq(books.slug, identifier)];
  
  // Only add UUID condition if identifier is a valid UUID
  if (isValidUuid(identifier)) {
    conditions.push(eq(books.id, identifier));
  }

  const result = await dbRead
    .select(getEnrichedBookSelect(currentUserId || null))
    .from(books)
    .leftJoin(users, eq(books.userId, users.userId))
    .where(or(...conditions))
    .limit(1);

  if (result.length > 0) {
    const enrichedBook = result[0] as EnrichedBookData;
    // Cache the result
    enrichedBookCache.set(cacheKey, enrichedBook);
    return enrichedBook;
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
  updates: DBUpdateBook
): Promise<DBBook> {
  const result = await dbWrite
    .update(books)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(books.id, bookId))
    .returning();

  // Invalidate cache for this book
  invalidateEnrichedBookCache(bookId);

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
export async function getPageFromDB(pageId: string, options: {
  bookIdentifier?: string,
  client?: DBClient // use dbWrite to avoid read replica stale
} = {}): Promise<DBPage | null> {
  const { bookIdentifier, client = dbRead } = options;

  try {
    // Validate when bookIdentifier provided (page must be in book)
    let bookId: string | undefined;
    if (bookIdentifier) {
      bookId = isValidUuid(bookIdentifier) ? bookIdentifier : undefined;
      if (!bookId) {
        const book = await client
          .select({ id: books.id })
          .from(books)
          .where(eq(books.slug, bookIdentifier))
          .limit(1);

        if (book.length > 0) {
          bookId = book[0].id;
        }
      }
  
      if (!bookId) throw new Error("Book not found");
    }
  
    // Build where conditions - only include bookId filter if bookId is defined
    const whereConditions = [eq(pages.id, pageId)];
    if (bookId) {
      whereConditions.push(eq(pages.bookId, bookId));
    }

    const result = await client
      .select()
      .from(pages)
      .where(and(...whereConditions))
      .limit(1);    
    return result[0] || null;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[getPageFromDB] ❌ Failed to get page ${pageId}:`, errorMessage);
    throw new Error(`Unable to retrieve page: ${errorMessage}`, { cause: error });
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
export async function getPageActionsFromDB(userId: string, bookId: string, pageId: string): Promise<Action[]> {
  const userProgress = await dbRead
    .select()
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.userId, userId),
      eq(userPageProgress.bookId, bookId),
      eq(userPageProgress.actionedPageId, pageId),
    ))
    .orderBy(asc(userPageProgress.updatedAt));
  
  return userProgress.map(progress => progress.action);
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
    // Try to get the specific page by pageId or fallback to first page
    const dbPage = await getPageFromDB(pageId) ?? await getFirstPage(bookId);
    if (!dbPage) return null;

    return completePageWithSelectedAction(dbPage, userId);
  } catch (error) {
    console.error(`Failed to get story page for book ${bookId}, page ${pageId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve story page: ${getErrorMessage(error)}`, { cause: error });
  }
}

async function completePageWithSelectedAction(dbPage: DBPage, userId: string): Promise<UserStoryPage> {
  // Get user page progress to include selected action
  const selectedActions = await getPageActionsFromDB(userId, dbPage.bookId, dbPage.id);
  return await mapToUserStoryPage(dbPage, userId, selectedActions);
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
 * - Enriches actions with nextPageNumber for frontend URL building
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
export async function mapToUserStoryPage(dbPage: DBPage, userId: string, selectedActions?: Action[]): Promise<UserStoryPage> {
  const persistedPage = mapToPersistedStoryPage(dbPage);
  selectedActions ??= await getPageActionsFromDB(userId, persistedPage.bookId, persistedPage.id);

  return {
    ...persistedPage,
    selectedActions,
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
    charactersPresent: dbPage.charactersPresent,
    keyEvents: dbPage.keyEvents,
    importantObjects: dbPage.importantObjects,
    actions: dbPage.actions,
    stateDelta: dbPage.stateDelta || {},
    aiProvider: dbPage.aiProvider || 'none',
    aiModel: dbPage.aiModel || 'none',
    createdAt: dbPage.createdAt,
    updatedAt: dbPage.updatedAt,
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
    mood: dbPage.mood || undefined,
    place: dbPage.place || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    charactersPresent: dbPage.charactersPresent || [],
    keyEvents: dbPage.keyEvents || [],
    importantObjects: dbPage.importantObjects || [],
    actions: dbPage.actions || [],
    stateDelta: dbPage.stateDelta || {},
    aiProvider: dbPage.aiProvider || 'none',
    aiModel: dbPage.aiModel || 'none',
  } satisfies StoryPage;
}

/**
 * Maps database page data to enriched page format with caching
 * 
 * This function transforms raw database page data into a frontend-ready format,
 * including user-specific data (selected actions), translation support, and
 * story context. Uses LRU cache for performance when pages have complete actions.
 * 
 * **Caching Behavior:**
 * - Only caches pages with no incomplete actions (all actions have destinations)
 * - Pages with pending generation are not cached since they change frequently
 * - Cache key includes: pageId, userId, translate, acceptLanguage
 * - Cache TTL: 2 minutes to balance freshness with performance
 * 
 * **User-Specific Data:**
 * - selectedActions: User's chosen actions for this page (varies per user)
 * - translatedText: Translated text if Accept-Language differs from book language
 * - context: Story state including places, characters, injuries, inventory
 * 
 * **Performance Considerations:**
 * - Database queries: selectedActions (if authenticated), storyState
 * - Translation API call: Only when translation is requested and needed
 * - Cache hit: Returns immediately without database queries
 * 
 * @param dbPage - Raw page data from database
 * @param options - Configuration options for enrichment
 * @param options.userId - Optional current user ID for user-specific selectedActions
 * @param options.bookLanguage - Book's language code (default: 'en')
 * @param options.acceptLanguage - Optional target language for translation
 * @param options.translate - Whether to enable translation (default: false)
 * @param options.sourceAction - Source action that led to this page (required for pages > 1)
 * @returns Promise resolving to enriched page or null if mapping fails
 * 
 * @example
 * ```typescript
 * // Basic usage without translation
 * const page = await mapToEnrichedPage(dbPage, { userId: 'user123' });
 * 
 * // With translation to Spanish
 * const translatedPage = await mapToEnrichedPage(dbPage, {
 *   userId: 'user123',
 *   bookLanguage: 'en',
 *   acceptLanguage: 'es',
 *   translate: true
 * });
 * 
 * // With source action for page navigation
 * const pageWithSource = await mapToEnrichedPage(dbPage, {
 *   userId: 'user123',
 *   sourceAction: selectedAction
 * });
 * ```
 */
export async function mapToEnrichedPage(dbPage: DBPage, options: {
  userId?: string,
  bookLanguage?: string,
  acceptLanguage?: string,
  translate?: boolean,
  sourceAction?: Action
}): Promise<EnrichedStoryPage | null> {
  const { userId, bookLanguage = 'en', acceptLanguage, translate = false, sourceAction } = options;
  const allActions = dbPage.actions;
  const visibleActions = allActions.filter(action => action.destination?.pageId);
  const hasIncompleteActions = allActions.length > visibleActions.length;
  const { id: pageId, text, bookId } = dbPage;

  // Check cache first (only for pages with complete actions)
  const cacheKey = getEnrichedPageCacheKey(pageId, userId, translate, acceptLanguage);
  if (!hasIncompleteActions) {
    const cached = enrichedPageCache.get(cacheKey);
    if (cached) return cached;
  }

  // Query user's chosen action for this page (if authenticated)
  const selectedActions: Action[] = userId ? await getPageActionsFromDB(userId, bookId, pageId) : [];

  // Get story state for context
  const storyState = await getStoryStateFromPage(dbPage);

  // Handle translation if Accept-Language header is provided and differs from book language
  let translatedText: string | undefined;
  const targetLanguage = translate ? shouldTranslate(bookLanguage, acceptLanguage) : undefined;

  if (targetLanguage) {
    console.log(`[mapToEnrichedPage] 🌐 shouldTranslate into:`, targetLanguage);
    const translationResult = await getTranslatedText({
      pageId,
      text,
      bookLanguage,
      targetLanguage
    });
    
    if (translationResult.text) {
      translatedText = translationResult.text;
      console.log(`[mapToEnrichedPage] ✅ Translation success:`, translatedText);
    } else {
      console.warn(`[mapToEnrichedPage] ⚠️ Translation failed:`, translationResult.error);
    }
    // Note: If translation failed, translationResult.error contains error info
    // but we continue with original text (fallback behavior)
  }

  // Extract context from story state if available
  let context: EnrichedStoryPage['context'];
  if (storyState) {
    const { places, characters, injuries, inventory, contextHistory, actionsHistory } = storyState;
    const { phase } = getStoryStateInfo(storyState);
    context = {
      phase,
      injuries,
      inventory,
      contextHistory,
      actionsHistory,
      places: Object.values(places).map(place => ({
        name: place.name,
        type: place.type,
        context: place.context
      })),
      characters: Object.values(characters).map(character => ({
        name: character.name,
        gender: character.gender,
        role: character.role,
        bio: character.bio
      }))
    };
  }

  if (dbPage.page > 1 && !sourceAction) {
    console.error(`[mapToEnrichedPage] ❌ Source action should be exists for page ${dbPage.page}`);
  }

  // Return enriched page with only frontend-relevant fields
  // Exclude backend-specific fields: userId, aiProvider, aiModel, pendingGenerationCount
  const enrichedPage: EnrichedStoryPage = {
    id: dbPage.id,
    page: dbPage.page,
    bookId: dbPage.bookId,
    branchId: dbPage.branchId,
    parentId: dbPage.parentId,
    text: dbPage.text,
    mood: dbPage.mood || undefined,
    place: dbPage.place || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    charactersPresent: dbPage.charactersPresent,
    keyEvents: dbPage.keyEvents,
    importantObjects: dbPage.importantObjects,
    createdAt: dbPage.createdAt,
    updatedAt: dbPage.updatedAt,

    // Enriched columns
    actions: visibleActions, // Only actions that has destination page
    originalActionsCount: allActions.length,
    selectedActions,
    sourceAction,
    translatedText,
    context,
  };

  // Cache the result only if page has complete actions (no pending generation)
  if (!hasIncompleteActions) {
    enrichedPageCache.set(cacheKey, enrichedPage);
  }

  return enrichedPage;
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
    slug: dbBook.slug || undefined,
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
    topPick: dbBook.topPick || undefined,
    isOriginal: dbBook.isOriginal ?? false,
    branchesCount: dbBook.branchesCount || 0,
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
  const charactersMeta = { title: `CHARACTERS`, snippet: formatCharactersForPrompt(book.mc, state) };
  const placesMeta = { title: `PLACES`, snippet: formatPlacesForPrompt(state) };

  return [bookMeta, charactersMeta, placesMeta];
}

/**
 * Retrieves the initial story state for a book (page 1)
 * 
 * This function finds the first page of a book and retrieves its story state
 * to provide context for cover image generation when no state is provided.
 * 
 * @param book - Book object with metadata
 * @returns Promise resolving to initial story state or null if not found
 * 
 * @example
 * ```typescript
 * const initialState = await getBookInitialState(book);
 * if (initialState) {
 *   console.log(`Found initial state for page ${initialState.page}`);
 * }
 * ```
 */
export async function getBookInitialState(book: Book): Promise<StoryState | null> {
  try {
    // Get the first page of the book
    const firstPage = await getFirstPage(book.id);
    
    if (!firstPage) {
      console.log(`[getBookInitialState] ❓ No pages found for book ${book.id}`);
      return null;
    }
    
    // Get the story state for the first page
    const initialState = await getStoryStateFromPage(firstPage);
    if (initialState) {
      console.log(`[getBookInitialState] 🎯 Found initial state for book ${book.id} at page ${initialState.page}`);
    } else {
      console.log(`[getBookInitialState] ❓ No story state found for first page of book ${book.id}`);
    }
    
    return initialState;
  } catch (error) {
    console.error(`[getBookInitialState] ❌ Failed to get initial state for book ${book.id}:`, error);
    return null;
  }
}

export async function getFirstPage(bookId: string): Promise<DBPage | null> {
  const firstPage = await dbRead
    .select()
    .from(pages)
    .where(and(eq(pages.bookId, bookId), eq(pages.page, 1)))
    .limit(1);
  
  return firstPage[0] || null;
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

  // Get initial story state if none provided
  if (!state) {
    const initialState = await getBookInitialState(book);
    if (initialState) {
      state = initialState;
      console.log(`[generateCoverImages] 🎯 Using initial story state for book ${book.id} (page ${state.page})`);
    } else {
      console.log(`[generateCoverImages] ❓ No story state available for book ${book.id}, using book metadata only`);
    }
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
      numberOfImages: total || 1, // TODO: 3 selectable images for premium users
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

/**
 * Retrieves public book statistics
 * 
 * Returns aggregate statistics about all books in the platform:
 * - storiesCreated: Total number of books created
 * - branchesExplored: Total number of unique branches across all books (pre-calculated)
 * - pagesCrafted: Total number of pages created
 * 
 * Results are cached for 3 minutes to reduce database load.
 * 
 * @returns Promise resolving to object containing the three stats
 * 
 * @example
 * ```typescript
 * const stats = await getPublicBookStats();
 * console.log(`Stories: ${stats.storiesCreated}`);
 * console.log(`Branches: ${stats.branchesExplored}`);
 * console.log(`Pages: ${stats.pagesCrafted}`);
 * ```
 */
export async function getPublicBookStats(): Promise<{
  storiesCreated: number;
  branchesExplored: number;
  pagesCrafted: number;
}> {
  const cacheKey = 'public:book:stats';
  
  // Try to get from cache first
  const cached = publicBookStatsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // Get total number of books (stories created) using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const booksCount = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(books);

    // Get total number of unique branches using SUM of pre-calculated branchesCount
    // Using SUM of denormalized column is much faster than COUNT(DISTINCT branch_id) on pages table
    const branchesCount = await dbRead
      .select({ count: sql<number>`COALESCE(SUM(branches_count), 0)::int` })
      .from(books);

    // Get total number of pages using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    const pagesCount = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(pages);

    const stats = {
      storiesCreated: booksCount[0].count,
      branchesExplored: branchesCount[0].count,
      pagesCrafted: pagesCount[0].count,
    };

    // Store in cache
    publicBookStatsCache.set(cacheKey, stats);

    return stats;
  } catch (error) {
    console.error('Failed to get public book stats:', getErrorMessage(error));
    throw new Error(`Unable to retrieve public book stats: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Fetches similar books based on keyword Jaccard similarity
 * 
 * Uses PostgreSQL's native array operations to calculate Jaccard similarity
 * between the target book's keywords and all other books' keywords.
 * 
 * Jaccard Similarity Formula: J(A, B) = |A ∩ B| / |A ∪ B|
 * 
 * Calculated entirely in SQL for optimal performance:
 * - Uses `&` operator for array intersection
 * - Uses `|` operator for array union
 * - Uses `cardinality()` to count elements
 * - Sorts by highest similarity score
 * 
 * @param bookId - The book ID to find similar books for
 * @param limit - Maximum number of similar books to return (default: 10)
 * @returns Promise resolving to array of similar books with similarity scores
 * 
 * @example
 * ```typescript
 * const similarBooks = await getSimilarBooks("book123", 5);
 * // Returns books with highest keyword overlap, sorted by similarity score
 * ```
 */
export async function getSimilarBooks(bookId: string, limit: number = 10): Promise<Array<DBBook & { similarityScore: number }>> {
  try {
    // Get the target book's keywords first
    const targetBook = await dbRead
      .select({ keywords: books.keywords })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!targetBook[0]) {
      return [];
    }

    const targetKeywords = targetBook[0].keywords;

    // Query similar books using PostgreSQL Jaccard similarity calculation
    // Jaccard = |A ∩ B| / |A ∪ B|
    const similarBooks = await dbRead
      .select({
        id: books.id,
        userId: books.userId,
        slug: books.slug,
        title: books.title,
        totalPages: books.totalPages,
        language: books.language,
        hook: books.hook,
        summary: books.summary,
        image: books.image,
        imageId: books.imageId,
        trendingScore: books.trendingScore,
        isOriginal: books.isOriginal,
        keywords: books.keywords,
        status: books.status,
        mc: books.mc,
        likesCount: books.likesCount,
        readCount: books.readCount,
        branchesCount: books.branchesCount,
        topPick: books.topPick,
        createdAt: books.createdAt,
        updatedAt: books.updatedAt,
        // Calculate Jaccard similarity using SQL array operations
        similarityScore: sql<number>`
          (
            cardinality(${books.keywords}::text[] & ${targetKeywords}::text[])::float
            / NULLIF(cardinality(${books.keywords}::text[] | ${targetKeywords}::text[]), 0)
          )
        `,
      })
      .from(books)
      .where(
        and(
          // Exclude the target book itself
          sql`${books.id} != ${bookId}`,
          // Only include books with keywords
          sql`cardinality(${books.keywords}::text[]) > 0`,
          // Only include active books
          eq(books.status, 'active')
        )
      )
      .orderBy(desc(sql`similarityScore`))
      .limit(limit);

    return similarBooks as Array<DBBook & { similarityScore: number }>;
  } catch (error) {
    console.error(`Failed to get similar books for ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve similar books: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Get popular tags/keywords from books
 * 
 * @param limit - Maximum number of popular tags to return (default: 20)
 * @returns Promise that resolves to array of popular tag names sorted by frequency
 * 
 * Behavior:
 * - Uses database-level aggregation to count keyword frequencies
 * - Expands JSONB arrays and groups by keyword
 * - Returns most popular tags sorted by frequency
 * - Filters out empty arrays and null values
 * 
 * Performance:
 * - Uses PostgreSQL's jsonb_array_elements for efficient array expansion
 * - Aggregates at database level (O(n log n) vs O(n) in-memory)
 * - Single query instead of query + in-memory processing
 * 
 * Example:
 * ```typescript
 * const tags = await getPopularTags(10);
 * // Returns: ["thriller", "mystery", "horror", "suspense", ...]
 * ```
 */
export async function getPopularTags(limit: number = 20): Promise<string[]> {
  try {
    // Use database-level aggregation for efficient keyword counting
    const result = await dbRead.execute(sql`
      SELECT keyword, COUNT(*) as count
      FROM (
        SELECT jsonb_array_elements_text(${books.keywords}) as keyword
        FROM ${books}
        WHERE ${books.keywords} IS NOT NULL 
          AND jsonb_array_length(${books.keywords}) > 0
      ) expanded
      WHERE keyword IS NOT NULL AND keyword != ''
      GROUP BY keyword
      ORDER BY count DESC
      LIMIT ${limit}
    `);

    // Extract tag names from result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tags = result.rows.map((row: any) => row.keyword);
    return tags;
  } catch (error) {
    console.error('[getPopularTags] Failed to fetch popular tags:', getErrorMessage(error));
    return [];
  }
}

// /**
//  * Triggers a fire-and-forget retry of failed candidate page generations
//  * 
//  * This function initiates a retry of candidate generation for pages with incomplete actions
//  * when users visit them. Uses deduplication to prevent rapid retries within a time window.
//  * 
//  * @param userId - User ID initiating the retry
//  * @param page - Page data with actions
//  * @param userChosenAction - Optional user's chosen action for this page
//  * 
//  * Behavior:
//  * - Checks if actions are missing destinations (unless hasIncompleteActions is provided)
//  * - Uses deduplication to prevent multiple retries within the time window
//  * - Initiates retry asynchronously (fire-and-forget)
//  * - Logs errors but doesn't block the response
//  * 
//  * Deduplication:
//  * - Uses time-based keys to prevent retries within the deduplication window
//  * - Keys are automatically cleaned up after expiration
//  * - Safe for concurrent requests
//  * 
//  * Performance:
//  * - If hasIncompleteActions is true, skips enrichment check for efficiency
//  * - If hasIncompleteActions is undefined, performs enrichment check
//  * 
//  * Example:
//  * ```typescript
//  * // With pre-checked incomplete actions (efficient)
//  * await triggerCandidateGenerationRetry(userId, page, userChosenAction, true);
//  * 
//  * // Let helper check (less efficient but simpler)
//  * await triggerCandidateGenerationRetry(userId, page, userChosenAction);
//  * ```
//  */
// export async function triggerCandidateGenerationRetry(
//   userId: string,
//   page: DBPage,
//   selectedActions?: Action[],
// ): Promise<void> {
//   // Check for incomplete actions if not provided
//   const allActions = page.actions || [];
//   const visibleActions = allActions.filter((action: Action) => action.destination?.pageId);
//   const hasIncompleteActions = visibleActions.length < allActions.length;

//   // Skip if all actions have destinations
//   if (!hasIncompleteActions) return;

//   // Generate deduplication key based on page ID and time window (default 1 minute)
//   const timeWindow = Math.floor(Date.now() / 60000);
//   const retryKey = `retry:candidate:${page.id}:${timeWindow}`;

//   // Check if retry should proceed (deduplication)
//   if (!shouldProceedWithRetry(retryKey, 60000)) {
//     return;
//   }

//   // Fire-and-forget retry
//   void (async () => {
//     try {
//       const { ensureCandidatesForPageWithStrategy } = await import("../utils/candidate-generation.js");
//       const userPage = await mapToUserStoryPage(page, userId, selectedActions);
//       await ensureCandidatesForPageWithStrategy({
//         strategy: 'cron',
//         userId,
//         page: userPage,
//         currentState: await getStoryState(page.id, { dbPage: page, maxTraversalDepth: 1 })
//       });
//     } catch (error) {
//       console.error(`[triggerCandidateGenerationRetry] ❌ Failed for page ${page.id}:`, getErrorMessage(error));
//     }
//   })();
// }