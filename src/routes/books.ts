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
 * - POST /api/books/:id/pages - Generate new story pages
 * - GET /api/books/:id/pages/:pageId - Retrieve specific pages
 * - POST /api/books/:id/sessions - Manage reading sessions
 * - DELETE /api/books/:id - Delete a book and queue image for deletion
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { optionalClientId, requireClientId } from "../middleware/auth.js";
import { books, pages, userSessions, deletedImages } from "../db/schema.js";
import { handleApiError, handleNotFoundError } from "../utils/error.js";
import { eq, and, isNull } from "drizzle-orm";
import { initializeBook, chooseAction } from "../utils/prompt.js";
import { getActiveSession, setActiveSession } from "../services/book.js";
import { getStoryState, getStoryStateFromDB } from "../services/story.js";
import { imageUpload, uploadBookCover } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, createSearchFilter, applySorting, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { ImageUploadSource } from "../types/image.js";

const router = Router();

/**
 * POST /api/books
 * 
 * Creates a new psychological thriller book with AI-generated content.
 * Accepts theme and main character candidate, initializes story with AI.
 * Returns complete book information with first page and initial state.
 * 
 * @param theme - Story theme (e.g., "abandoned asylum", "haunted mansion")
 * @param mcCandidate - Main character information for story generation
 * @returns Book object with first page and initial story state
 */
router.post("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate } = req.body;
    
    if (!theme) {
      return res.status(400).json({ 
        error: "Missing required field: theme is required" 
      });
    }

    // Initialize book with AI
    const { book, firstPage, initialState } = await initializeBook(
      req.userId!,
      theme,
      mcCandidate
    );

    // Create reading session
    const session = await setActiveSession(req.userId!, book.id, firstPage.id);

    res.status(201).json({
      book,
      firstPage,
      initialState,
      session
    });
  } catch (error) {
    handleApiError(res, "Failed to create book", error);
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
router.get("/", requireClientId, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder } = extractPaginationParams(req);
    const userId = req.userId!;
    
    // Build base query
    let query = dbRead
      .select({
        id: books.id,
        displayTitle: books.displayTitle,
        hook: books.hook,
        summary: books.summary,
        image: books.image,
        status: books.status,
        createdAt: books.createdAt,
        updatedAt: books.updatedAt,
        lastReadAt: userSessions.updatedAt, // Join to check active session
        lastPage: userSessions.pageId
      })
      .from(books)
      .leftJoin(
        userSessions,
        and(
          eq(userSessions.bookId, books.id),
          eq(userSessions.userId, userId),
          isNull(userSessions.updatedAt)
        )
      )
      .where(eq(books.userId, userId));

    // Apply search filter if provided
    if (search) {
      query = createSearchFilter(search, ['displayTitle', 'hook', 'summary'])(query);
    }

    // Apply sorting
    query = applySorting(query, sortBy, sortOrder);

    // Get total count for pagination
    let countQuery = dbRead
      .select({ count: books.id })
      .from(books)
      .where(eq(books.userId, userId));
      
    if (search) {
      countQuery = createSearchFilter(search, ['displayTitle', 'hook', 'summary'])(countQuery);
    }

    const totalCountResult = await countQuery;
    const totalCount = totalCountResult.length;

    // Apply pagination
    const offset = (page - 1) * limit;
    const userBooks = await query.limit(limit).offset(offset);

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    res.json(createPaginatedResponse(userBooks, pagination));
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
 * @param displayTitle - Updated book title (optional)
 * @param hook - Updated book hook/description (optional)
 * @param summary - Updated book summary (optional)
 * @param keywords - Updated book keywords array (optional)
 * @param imageUrl - New cover image URL to upload (optional)
 * @param imageFile - New cover image file from multipart upload (optional)
 * @returns Updated book information
 */
router.put("/:id", requireClientId, imageUpload.single('imageFile'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const { 
      displayTitle, 
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
        displayTitle: books.displayTitle,
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
      const uploadResult = await uploadBookCover(
        imageSource,
        book.id,
        displayTitle || book.displayTitle,
        keywords || []
      );

      if (uploadResult) {
        newImageUrl = uploadResult.url;
        newImageId = uploadResult.fileId;

        // Queue old image for deletion if it exists
        if (book.imageId) {
          await dbWrite
            .insert(deletedImages)
            .values({
              fileId: book.imageId,
              createdAt: new Date(),
            });
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

    if (displayTitle !== undefined) updateData.displayTitle = displayTitle;
    if (hook !== undefined) updateData.hook = hook;
    if (summary !== undefined) updateData.summary = summary;
    if (keywords !== undefined) updateData.keywords = keywords;
    if (newImageUrl) updateData.image = newImageUrl;
    if (newImageId) updateData.imageId = newImageId;

    // Update the book
    const updatedBook = await dbWrite
      .update(books)
      .set(updateData)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ))
      .returning();

    res.json({
      book: updatedBook[0],
      imageUploaded: !!newImageUrl,
      oldImageQueuedForDeletion: oldImageIdQueued,
      uploadSource: req.file ? 'file' : (imageUrl?.startsWith('data:') ? 'base64' : 'url'),
    });
  } catch (error) {
    handleApiError(res, "Failed to update book", error);
  }
});

/**
 * POST /api/books/:id/pages
 * 
 * Generates new story pages based on user actions or continuation.
 * Accepts complete Action object with text, type, hint, and optional pageId.
 * Uses chooseAction function for complete story progression pipeline.
 * 
 * @param id - Book ID
 * @param action - Complete Action object with text, type, hint, and optional pageId
 * @returns New page with updated story state
 */
router.post("/:id/pages", requireClientId, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    const userId = req.userId!;

    if (!action || !action.text) {
      return res.status(400).json({ 
        error: "Missing required field: action is required" 
      });
    }

    // Verify book ownership
    const book = await dbRead
      .select()
      .from(books)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Process user action choice using chooseAction function
    const newPage = await chooseAction(userId, action, false);

    res.status(201).json({
      page: newPage,
      bookProgress: {
        currentPage: newPage.id
      }
    });
  } catch (error) {
    handleApiError(res, "Failed to generate page", error);
  }
});

/**
 * GET /api/books/:id/pages/:pageId
 * 
 * Retrieves a specific story page with full context.
 * Includes page content, available actions, and psychological state.
 * 
 * @param id - Book ID
 * @param pageId - Page ID to retrieve
 * @returns Page content with actions and state
 */
router.get("/:id/pages/:pageId", requireClientId, async (req: Request, res: Response) => {
  try {
    const { id, pageId } = req.params;

    const userId = req.userId!;

    // Verify book ownership and get page
    const page = await dbRead
      .select({
        id: pages.id,
        pageNumber: pages.page,
        content: pages.text,
        actions: pages.actions,
        characters: pages.characters,
        places: pages.place,
        keyEvents: pages.keyEvents,
        importantObjects: pages.importantObjects,
        createdAt: pages.createdAt
      })
      .from(pages)
      .innerJoin(
        books,
        and(
          eq(books.id, pages.bookId),
          eq(books.id, id as string),
          eq(books.userId, userId)
        )
      )
      .where(eq(pages.id, pageId as string))
      .limit(1);

    if (!page.length) {
      return handleNotFoundError(res, "Page not found");
    }

    res.json({
      page: page[0],
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
 * @param currentPage - Current page number in reading session
 * @returns Session information with progress
 */
router.post("/:id/sessions", requireClientId, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { currentPage } = req.body;
    const userId = req.userId!;
    const bookId = id as string;

    if (!currentPage) {
      return res.status(400).json({ 
        error: "Missing required field: currentPage is required" 
      });
    }

    // Verify book ownership
    const book = await dbRead
      .select()
      .from(books)
      .where(and(
        eq(books.id, bookId),
        eq(books.userId, userId)
      ))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Check for existing active session
    const existingSession = await getActiveSession(userId);
 
    let session;
    if (existingSession) {
      // Update existing session
      session = await setActiveSession(userId, bookId, currentPage);
    } else {
      // Create new session
      session = await setActiveSession(userId, bookId, currentPage);
    }

    res.status(201).json({
      session,
      book: {
        id: book[0].id,
        displayTitle: book[0].displayTitle,
        image: book[0].image,
        currentPage: session.pageId
      }
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
router.get("/explore", optionalClientId, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder } = extractPaginationParams(req);
    
    // Build base query
    let query = dbRead
      .select({
        id: books.id,
        displayTitle: books.displayTitle,
        hook: books.hook,
        summary: books.summary,
        image: books.image,
        keywords: books.keywords,
        status: books.status,
        trendingScore: books.trendingScore,
        createdAt: books.createdAt,
        updatedAt: books.updatedAt,
        mc: books.mc
      })
      .from(books)
      .where(eq(books.status, 'active'));

    // Apply search filter if provided
    if (search) {
      query = createSearchFilter(search, ['displayTitle', 'hook', 'summary', 'keywords'])(query);
    }

    // Apply sorting
    query = applySorting(query, sortBy, sortOrder);

    // Get total count for pagination
    let countQuery = dbRead
      .select({ count: books.id })
      .from(books)
      .where(eq(books.status, 'active'));
      
    if (search) {
      countQuery = createSearchFilter(search, ['displayTitle', 'hook', 'summary', 'keywords'])(countQuery);
    }

    const totalCountResult = await countQuery;
    const totalCount = totalCountResult.length;

    // Apply pagination
    const offset = (page - 1) * limit;
    const booksResult = await query.limit(limit).offset(offset);

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    res.json(createPaginatedResponse(booksResult, pagination));
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
router.delete("/:id", requireClientId, async (req: Request, res: Response) => {
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
