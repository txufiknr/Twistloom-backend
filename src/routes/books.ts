/**
 * @overview Books Routes Module
 * 
 * Provides endpoints for managing psychological thriller books and story pages.
 * Implements CRUD operations for book creation, page generation, and session management.
 * 
 * Architecture Features:
 * - Book creation with AI-powered story initialization
 * - Dynamic page generation with branching narratives
 * - Session management for reading progress
 * - Character and place tracking
 * - Psychological state management
 * 
 * Endpoints:
 * - POST /api/books - Create new psychological thriller books
 * - GET /api/books - Retrieve user's book library
 * - GET /api/books/explore - Explore published books with search and pagination
 * - PUT /api/books/:id - Update book information and cover image
 * - POST /api/books/:id/generate - Generate new story pages
 * - GET /api/books/:id/:pageId - Retrieve specific pages
 * - POST /api/books/:id/sessions - Manage reading sessions
 * - DELETE /api/books/:id - Delete a book and queue image for deletion
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { optionalAuth, requireAuth } from "../middleware/nextauth.js";
import { books, pages, userSessions, deletedImages, users } from "../db/schema.js";
import { handleApiError, handleNotFoundError } from "../utils/error.js";
import { eq, and } from "drizzle-orm";
import { initializeBook, chooseAction } from "../utils/prompt.js";
import { enrichActions } from "../services/book.js";
import { imageUpload, deleteFileFromImageKit } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, createSearchFilter, applySorting, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import type { ImageUploadSource } from "../types/image.js";
import { setActiveSession, getStoryProgress } from "../services/story.js";
import { getBook, updateBook, insertBook, uploadBookCoverImage, resolveBook } from "../services/book.js";
import type { EnrichedBookData } from "../services/book-controller.js";
import { getEnrichedBookSelect } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache } from "../services/cache.js";

const router = Router();

/**
 * POST /api/books
 * 
 * Creates a new psychological thriller book with AI-generated content.
 * Accepts theme and main character candidate, initializes story with AI.
 * Returns complete book information with first page and initial state.
 * 
 * @param theme - Story theme (e.g., "abandoned asylum", "haunted mansion") - Required
 * @param mcCandidate.name - Character's display name - Optional
 * @param mcCandidate.age - Character's age in years - Optional
 * @param mcCandidate.gender - Character's gender (male/female/other) - Optional
 * @param mcCandidate.bio - Character's bio - Optional
 * 
 * @example
 * // Request
 * POST /api/books
 * Headers: X-Client-Id: user123
 * Body: {
 *   "theme": "haunted mansion mystery",
 *   "mcCandidate": {
 *     "name": "Sarah",
 *     "age": 28,
 *     "gender": "female",
 *     "bio": "Shy librarian with hidden past"
 *   }
 * }
 * 
 * // Response
 * {
 *   "book": {
 *     "id": "book123",
 *     "title": "The Whispering Halls",
 *     "hook": "Sarah never believed in ghosts until she found the diary",
 *     "summary": "A psychological thriller about a librarian who discovers dark secrets",
 *     "keywords": ["mystery", "thriller", "haunted"],
 *     "image": "https://example.com/cover.jpg",
 *     "status": "active",
 *     "totalPages": 50,
 *     "language": "en",
 *     "mc": {
 *       "name": "Sarah",
 *       "age": 28,
 *       "gender": "female",
 *       "bio": "Shy librarian with hidden past"
 *     },
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   },
 *   "firstPage": {
 *     "id": "page456",
 *     "page": 1,
 *     "text": "The library was silent except for the rain...",
 *     "actions": [...]
 *   },
 *   "initialState": {
 *     "page": 1,
 *     "maxPage": 50,
 *     "flags": {...},
 *     "threads": [],
 *     "traumaTags": [],
 *     "psychologicalProfile": {...}
 *   },
 *   "session": {
 *     "userId": "user123",
 *     "bookId": "book123",
 *     "pageId": "page456"
 *   }
 * }
 */
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;
    
    if (!theme) {
      return res.status(400).json({ 
        error: "Missing required field: theme is required" 
      });
    }

    if (typeof theme !== 'string' || theme.trim().length === 0) {
      return res.status(400).json({ 
        error: "Invalid theme: must be a non-empty string" 
      });
    }

    // Validate mcCandidate if provided
    if (mcCandidate) {
      if (typeof mcCandidate !== 'object' || mcCandidate === null) {
        return res.status(400).json({ 
          error: "Invalid mcCandidate: must be an object" 
        });
      }

      if (mcCandidate.name !== undefined) {
        if (typeof mcCandidate.name !== 'string' || mcCandidate.name.trim().length === 0) {
          return res.status(400).json({ 
            error: "Invalid mcCandidate.name: must be a non-empty string" 
          });
        }
      }

      if (mcCandidate.age !== undefined) {
        if (typeof mcCandidate.age !== 'number' || mcCandidate.age < 0 || mcCandidate.age > 150) {
          return res.status(400).json({ 
            error: "Invalid mcCandidate.age: must be a number between 0 and 150" 
          });
        }
      }

      if (mcCandidate.gender !== undefined) {
        if (typeof mcCandidate.gender !== 'string' || !['male', 'female', 'other'].includes(mcCandidate.gender)) {
          return res.status(400).json({ 
            error: "Invalid mcCandidate.gender: must be 'male', 'female', or 'other'" 
          });
        }
      }

      if (mcCandidate.bio !== undefined) {
        if (typeof mcCandidate.bio !== 'string' || mcCandidate.bio.trim().length === 0) {
          return res.status(400).json({ 
            error: "Invalid mcCandidate.bio: must be a non-empty string" 
          });
        }
      }
    }

    // Validate generateCoverImage if provided
    if (generateCoverImage !== undefined) {
      if (typeof generateCoverImage !== 'boolean') {
        return res.status(400).json({ 
          error: "Invalid generateCoverImage: must be a boolean" 
        });
      }
    }

    // Initialize book and set active session
    const result = await initializeBook({
      userId: req.userId!,
      theme,
      mcCandidate,
      generateCoverImage
    });

    // Enrich actions with navigation metadata for frontend URL building
    const enrichedResult = {
      ...result,
      firstPage: {
        ...result.firstPage,
        actions: enrichActions(result.firstPage.actions, { page: 1, branchId: 'main' })
      }
    };

    // Invalidate user's book cache
    await invalidateUserBooksCache(req.userId!);
    
    // Invalidate user profile cache (booksCount changed)
    await invalidateUserProfileCache(req.userId!);
    
    // Invalidate explore cache if book is active
    if (result.book.status === 'active') {
      await invalidateExploreCache();
    }

    res.status(201).json(enrichedResult);
  } catch (error) {
    handleApiError(res, "Failed to create book", error);
  }
});

/**
 * POST /api/books/insert
 * 
 * Test route for directly inserting a book with provided data.
 * Bypasses AI generation and uses the provided book data directly.
 * Useful for testing and manual book creation.
 * 
 * @param userId - User identifier (from auth middleware)
 * @param title - Book title
 * @param totalPages - Total number of pages
 * @param language - Book language (e.g., 'en')
 * @param hook - Optional hook text
 * @param summary - Optional summary text
 * @param keywords - Optional keywords array
 * @param mc - Main character object with name, age, gender, bio
 * @param image - Optional image URL
 * @param imageId - Optional image ID
 * @param trendingScore - Optional trending score
 * @param id - Optional book ID (will be generated if not provided)
 * 
 * @example
 * POST /api/books/insert
 * Headers: X-Client-Id: user123
 * Body: {
 *   "title": "The House That Breathes Below",
 *   "totalPages": 120,
 *   "language": "en",
 *   "hook": "The basement door wasn't just open—it was breathing.",
 *   "summary": "Daniel Vey returns to the abandoned Vey Manor...",
 *   "keywords": ["psychological-horror", "false-memory"],
 *   "mc": {
 *     "name": "Daniel Vey",
 *     "age": 22,
 *     "gender": "male",
 *     "bio": "A skeptic with a habit of lying to himself..."
 *   }
 * }
 */
router.post("/insert", requireAuth, async (req: Request, res: Response) => {
  try {
    const bookData = req.body;
    const userId = req.userId!;

    // Add userId to the book data
    const bookWithUserId = {
      ...bookData,
      userId
    };

    const insertedBook = await insertBook(bookWithUserId);

    res.status(201).json({
      book: insertedBook,
      message: "Book inserted successfully"
    });
  } catch (error) {
    handleApiError(res, "Failed to insert book", error);
  }
});

/**
 * GET /api/books
 * 
 * Retrieves all books for the authenticated user.
 * Returns paginated list with metadata and reading progress.
 * Supports search and sorting.
 * 
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of books per page (default: 10)
 * @query search - Search query for title, hook, summary
 * @query sortBy - Field to sort by (default: updatedAt)
 * @query sortOrder - Sort direction (default: desc)
 * @returns Paginated list of user's books with progress
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder } = extractPaginationParams(req);
    const userId = req.userId!;
    
    // Skip caching for search queries (dynamic)
    const shouldCache = !search;
    const cacheKey = CACHE_KEYS.USER_BOOKS(userId, page);
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      let query = dbRead
        .select({
          ...getEnrichedBookSelect(userId),
          lastReadAt: userSessions.updatedAt, // Join to check active session
          lastPage: userSessions.pageId
        })
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId))
        .leftJoin(
          userSessions,
          and(
            eq(userSessions.bookId, books.id),
            eq(userSessions.userId, userId),
          )
        )
        .where(eq(books.userId, userId));

      // Apply search filter if provided
      if (search) {
        query = createSearchFilter(search, ['title', 'hook', 'summary'])(query);
      }

      // Apply sorting
      query = applySorting(query, sortBy, sortOrder);

      // Get total count for pagination
      let countQuery = dbRead
        .select({ count: books.id })
        .from(books)
        .where(eq(books.userId, userId));
        
      if (search) {
        countQuery = createSearchFilter(search, ['title', 'hook', 'summary'])(countQuery);
      }

      const totalCountResult = await countQuery;
      const totalCount = totalCountResult.length;

      // Apply pagination
      const offset = (page - 1) * limit;
      const userBooks: EnrichedBookData[] = await query.limit(limit).offset(offset);

      const pagination = calculatePaginationMeta(page, limit, totalCount);

      return createPaginatedResponse(userBooks, pagination);
    };
    
    // Use cache if applicable, otherwise fetch directly
    const result = shouldCache
      ? await withCache(cacheKey, fetchBooks, CACHE_TTL.PER_USER_BOOKS)
      : await fetchBooks();
    
    res.json(result);
  } catch (error) {
    handleApiError(res, "Failed to retrieve books", error);
  }
});

/**
 * PUT /api/books/:id
 * 
 * Updates book information including title, hook, summary, keywords, and cover image.
 * Supports partial updates - only provided fields will be modified.
 * Handles multiple image upload sources: URL, base64, or multipart file.
 * 
 * @param id - Book ID to update
 * @param title - Updated book title (optional)
 * @param hook - Updated book hook/description (optional)
 * @param summary - Updated book summary (optional)
 * @param keywords - Updated book keywords array (optional)
 * @param imageUrl - New cover image URL to upload (optional)
 * @param imageFile - New cover image file from multipart upload (optional)
 * @returns Updated book information
 */
router.put("/:id", requireAuth, imageUpload.single('imageFile'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { 
      title, 
      hook, 
      summary, 
      keywords, 
      imageUrl 
    } = req.body;

    // Verify book ownership
    const existingBook = await dbRead
      .select({ 
        id: books.id,
        userId: books.userId,
        title: books.title,
        keywords: books.keywords,
        imageId: books.imageId
      })
      .from(books)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ))
      .limit(1);

    if (!existingBook.length) {
      return handleNotFoundError(res, "Book not found");
    }

    const book = existingBook[0];
    let newImageUrl: string | undefined;
    let newImageId: string | undefined;
    let oldImageIdQueued = false;

    // Handle image upload from different sources
    let imageSource: ImageUploadSource | undefined;

    if (req.file) {
      // Multipart file upload
      imageSource = req.file;
    } else if (imageUrl) {
      // URL or base64 string upload
      imageSource = imageUrl;
    }

    // Process image upload if source is provided
    if (imageSource) {
      const uploadResult = await uploadBookCoverImage(
        {
          id: book.id,
          title: title || book.title,
          keywords: keywords || book.keywords
        },
        imageSource
      );
      
      if (uploadResult) {
        newImageUrl = uploadResult.url;
        newImageId = uploadResult.fileId;
        
        // Delete old image from ImageKit (with fallback to deletion queue)
        if (book.imageId) {
          await deleteFileFromImageKit(book.imageId);
          oldImageIdQueued = true;
        }
      } else {
        return res.status(400).json({
          error: "Failed to upload cover image"
        });
      }
    }

    // Prepare update data (only include provided fields)
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updateData.title = title;
    if (hook !== undefined) updateData.hook = hook;
    if (summary !== undefined) updateData.summary = summary;
    if (keywords !== undefined) updateData.keywords = keywords;
    if (newImageUrl) updateData.image = newImageUrl;
    if (newImageId) updateData.imageId = newImageId;

    // Update the book
    const updatedBook = await updateBook(book.id, updateData);

    // Invalidate user's book cache
    await invalidateUserBooksCache(userId);
    
    // Invalidate explore cache if book status changed to/from active
    if (updateData.status || updatedBook.status === 'active') {
      await invalidateExploreCache();
    }

    res.json({
      book: updatedBook,
      imageUploaded: !!newImageUrl,
      oldImageQueuedForDeletion: oldImageIdQueued,
      uploadSource: req.file ? 'file' : (imageUrl?.startsWith('data:') ? 'base64' : 'url'),
    });
  } catch (error) {
    handleApiError(res, "Failed to update book", error);
  }
});

/**
 * POST /api/books/:identifier/generate
 * 
 * Generates new story pages based on user actions or continuation.
 * Accepts action text string (e.g. "Investigate the noise") which is matched
 * against current page actions to get the full Action object.
 * Uses chooseAction function for complete story progression pipeline.
 * 
 * @param identifier - Book slug or UUID v7
 * @param actionText - Action text string (e.g. "Investigate the noise")
 * @param currentPageId - Optional current page ID for validation
 * @param branchId - Optional current branch ID for validation
 * @returns New page with updated story state and enriched actions
 */
router.post("/:identifier/generate", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const { actionText, currentPageId, branchId } = req.body;
    const userId = req.userId!;

    if (!actionText) {
      return res.status(400).json({ 
        error: "Missing required field: actionText is required" 
      });
    }

    // Handle array case for identifier (Express can return string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(identifierStr);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Verify book ownership
    if (book.userId !== userId) {
      return res.status(403).json({ 
        error: "Forbidden: You do not own this book" 
      });
    }

    // Optional validation: validate currentPageId and branchId against user's active session
    if (currentPageId || branchId) {
      const { session: activeSession } = await getStoryProgress(userId);
      if (!activeSession) {
        return res.status(400).json({ 
          error: "No active session found" 
        });
      }

      if (currentPageId && activeSession.pageId !== currentPageId) {
        return res.status(400).json({ 
          error: "Invalid current page ID" 
        });
      }

      if (branchId && activeSession.bookId !== book.id) {
        return res.status(400).json({ 
          error: "Invalid branch ID for current session" 
        });
      }
    }

    // Process user action choice using chooseAction function
    const newPage = await chooseAction({userId, actionText, isUserAction: false});
    if (!newPage) return handleApiError(res, "Failed to generate page");

    // Enrich actions with navigation metadata for frontend URL building
    const enrichedPage = {
      ...newPage,
      actions: enrichActions(newPage.actions, { page: newPage.page, branchId: newPage.branchId })
    };

    res.status(201).json({
      page: enrichedPage,
      bookProgress: {
        currentPage: newPage.id
      }
    });
  } catch (error) {
    handleApiError(res, "Failed to generate page", error);
  }
});

/**
 * GET /api/books/:identifier/:branchId/:page
 * 
 * Retrieves a specific page within a branch of a book.
 * Accepts both slug and UUID v7 as identifier.
 * 
 * @param identifier - Book slug or UUID v7
 * @param branchId - Branch identifier (e.g., "main", "abc123")
 * @param page - Page number within the branch
 * @returns Page with actions and book metadata
 */
router.get("/:identifier/:branchId/:page", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, branchId, page } = req.params;

    // Handle array case for identifier (Express can return string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(identifierStr);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get page within branch by page number
    const pageData = await dbRead
      .select({
        id: pages.id,
        page: pages.page,
        bookId: pages.bookId,
        branchId: pages.branchId,
        parentId: pages.parentId,
        text: pages.text,
        mood: pages.mood,
        place: pages.place,
        timeOfDay: pages.timeOfDay,
        actions: pages.actions,
        charactersPresent: pages.charactersPresent,
        keyEvents: pages.keyEvents,
        importantObjects: pages.importantObjects,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt
      })
      .from(pages)
      .where(
        and(
          eq(pages.bookId, book.id),
          eq(pages.branchId, branchId as string),
          eq(pages.page, parseInt(page as string))
        )
      )
      .limit(1);

    if (!pageData.length) {
      return handleNotFoundError(res, "Page not found");
    }

    // Enrich actions with navigation metadata for frontend URL building
    const enrichedPage = {
      ...pageData[0],
      actions: enrichActions(pageData[0].actions, { page: pageData[0].page, branchId: pageData[0].branchId })
    };

    res.json({
      page: enrichedPage,
      book: {
        id: book.id,
        title: book.title,
        slug: (book as any).slug
      }
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve page", error);
  }
});

/**
 * POST /api/books/:id/sessions
 * 
 * Creates or updates a reading session for the book.
 * Tracks reading progress and manages active sessions.
 * 
 * @param id - Book ID
 * @param pageId - Current page ID in reading session
 * @returns Session information with progress
 */
router.post("/:id/sessions", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { pageId } = req.body;
    const userId = req.userId!;
    const bookId = id as string;

    if (!pageId) {
      return res.status(400).json({ 
        error: "Missing required field: pageId is required" 
      });
    }

    const book = await getBook(bookId);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Create or update existing session
    const session = await setActiveSession({userId, bookId, pageId});

    // Invalidate caches on session start
    await invalidateExploreCache(); // readCount changed via trigger
    await invalidateUserProfileCache(userId); // readsCount changed

    res.status(201).json({
      session,
      book
    });
  } catch (error) {
    handleApiError(res, "Failed to manage session", error);
  }
});

/**
 * GET /api/books/explore
 * 
 * Retrieves all published books for exploration.
 * Supports both guest and authenticated users.
 * Includes search, filtering, and pagination capabilities.
 * 
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of books per page (default: 20)
 * @query search - Search query for title, summary, keywords
 * @query sortBy - Field to sort by (default: updatedAt)
 * @query sortOrder - Sort direction (default: desc)
 * @returns Paginated list of published books
 */
router.get("/explore", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder } = extractPaginationParams(req);
    const userId = req.userId || null;
    
    // Only cache page 1 without search (rapidly changing)
    const shouldCache = page === 1 && !search;
    const cacheKey = CACHE_KEYS.EXPLORE_PAGE_1;
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      let query = dbRead
        .select(getEnrichedBookSelect(userId))
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId))
        .where(eq(books.status, 'active'));

      // Apply search filter if provided
      if (search) {
        query = createSearchFilter(search, ['title', 'hook', 'summary', 'keywords'])(query);
      }

      // Apply sorting
      query = applySorting(query, sortBy, sortOrder);

      // Get total count for pagination
      let countQuery = dbRead
        .select({ count: books.id })
        .from(books)
        .where(eq(books.status, 'active'));
        
      if (search) {
        countQuery = createSearchFilter(search, ['title', 'hook', 'summary', 'keywords'])(countQuery);
      }

      const totalCountResult = await countQuery;
      const totalCount = totalCountResult.length;

      // Apply pagination
      const offset = (page - 1) * limit;
      const booksResult: EnrichedBookData[] = await query.limit(limit).offset(offset);

      const pagination = calculatePaginationMeta(page, limit, totalCount);

      return createPaginatedResponse(booksResult, pagination);
    };
    
    // Use cache if applicable, otherwise fetch directly
    const result = shouldCache
      ? await withCache(cacheKey, fetchBooks, CACHE_TTL.EXPLORE_PAGE_1)
      : await fetchBooks();
    
    // Add HTTP cache headers for CDN/edge caching (works alongside Redis)
    if (shouldCache) {
      res.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=30');
    }
    
    res.json(result);
  } catch (error) {
    handleApiError(res, "Failed to explore books", error);
  }
});

/**
 * DELETE /api/books/:id
 * 
 * Deletes a book and all its associated data.
 * If the book has an imageId, queues it for deletion in the deletedImages table.
 * 
 * @param id - Book ID to delete
 * @returns Success message with deletion details
 */
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Get book information including imageId before deletion
    const book = await dbRead
      .select({ 
        id: books.id,
        imageId: books.imageId,
        userId: books.userId
      })
      .from(books)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    const bookToDelete = book[0];

    // Queue image for deletion if imageId exists
    if (bookToDelete.imageId) {
      await dbWrite
        .insert(deletedImages)
        .values({
          fileId: bookToDelete.imageId,
          createdAt: new Date(),
        });
    }

    // Delete the book (cascade will handle related records)
    await dbWrite
      .delete(books)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ));

    // Invalidate user's book cache
    await invalidateUserBooksCache(userId);
    
    // Invalidate user profile cache (booksCount changed)
    await invalidateUserProfileCache(userId);
    
    // Invalidate explore cache
    await invalidateExploreCache();

    res.json({
      message: "Book deleted successfully",
      bookId: id,
      imageQueuedForDeletion: !!bookToDelete.imageId
    });
  } catch (error) {
    handleApiError(res, "Failed to delete book", error);
  }
});

export default router;
