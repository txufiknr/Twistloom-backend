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
import { guestOrAuthMiddleware } from "../middleware/guest.js";
import { books, pages, userSessions, deletedImages, users, userLikes, userFavorites, userComments } from "../db/schema.js";
import { getErrorMessage, handleApiError, handleNotFoundError } from "../utils/error.js";
import { eq, and, desc, sql, or } from "drizzle-orm";
import { chooseAction, generateBookCreationPrompt } from "../utils/prompt.js";
import { enrichActions } from "../services/book.js";
import { imageUpload, deleteFileFromImageKit } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, applySorting, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import type { ImageUploadSource } from "../types/image.js";
import { setActiveSession, getStoryProgress } from "../services/story.js";
import { getBook, updateBook, insertBook, uploadBookCoverImage, resolveBook, getPublicBookStats, applyBookSorting, getPopularTags } from "../services/book.js";
import { isValidBookSortOption } from "../utils/books.js";
import { getEnrichedBookSelect } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache, invalidatePopularTagsCache } from "../services/cache.js";
import type { BookSortOption, EnrichedBookData } from "../types/book.js";
import type { StoryMCCandidate } from "../types/character.js";
import { createBookCore, handleBookCreationError } from "../services/book-creation.js";
import { initSSEHeaders, sendSSEEvent } from "../utils/sse.js";
import type { ProgressCallback } from "../types/sse.js";
import { MAX_THEME_LENGTH } from "../config/theme-validation.js";
import { MIN_CHARACTER_AGE, MAX_CHARACTER_AGE } from "../config/story.js";

/**
 * Formats an array of items for error messages
 * @param items - Array of strings to format
 * @returns Formatted string with items quoted and joined by commas
 */
function formatOneOf(items: string[] | readonly string[]): string {
  return `'${items.join(`', '`)}'`;
}

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
 * // Request (valid theme)
 * POST /api/books
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
 * // Response (success)
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
 * 
 * @example
 * // Request (invalid theme - contains inappropriate content)
 * POST /api/books
 * Body: {
 *   "theme": "A story about prophet muhammad"
 * }
 * 
 * // Response (validation error - 400)
 * {
 *   "error": {
 *     "type": "VALIDATION_ERROR",
 *     "code": "THEME_INVALID",
 *     "message": "Your story theme contains inappropriate content.",
 *     "details": {
 *       "category": "INAPPROPRIATE_CONTENT",
 *       "detectedWords": ["prophet muhammad"],
 *       "detectedPatterns": [],
 *       "aiExplanation": "depicting religious figures in fictional stories",
 *       "suggestion": "Please avoid using real religious figures in your story theme."
 *     }
 *   }
 * }
 * 
 * @example
 * // Request (invalid theme - POV instruction)
 * POST /api/books
 * Body: {
 *   "theme": "Tell a story in third person perspective"
 * }
 * 
 * // Response (validation error - 400)
 * {
 *   "error": {
 *     "type": "VALIDATION_ERROR",
 *     "code": "THEME_INVALID",
 *     "message": "Your story theme contains invalid POV instructions.",
 *     "details": {
 *       "category": "INVALID_THEME",
 *       "detectedWords": [],
 *       "detectedPatterns": ["Invalid POV instruction: third\\sperson"],
 *       "aiExplanation": "explicit non-1st person POV instruction",
 *       "suggestion": "Twistloom generates 1st person POV stories only. Remove POV instructions from your theme."
 *     }
 *   }
 * }
 */
router.post("/", guestOrAuthMiddleware, async (req: Request, res: Response) => {
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

    // Use shared core logic (without progress callback for synchronous response)
    const result = await createBookCore(
      {
        userId: req.userId!,
        theme,
        mcCandidate,
        generateCoverImage
      },
      // No progress callback for POST endpoint (synchronous response)
      undefined
    );

    // Invalidate popular tags cache since new book may have new keywords
    await invalidatePopularTagsCache();

    res.status(201).json(result);
  } catch (error) {
    handleBookCreationError(res, error);
  }
});

/**
 * POST /api/books/stream
 *
 * Creates a new psychological thriller book with AI-generated content using SSE.
 * Provides real-time progress updates for each step in the book creation process.
 *
 * Accepts theme and main character candidate in request body.
 * Emits SSE events for theme validation, book initialization, AI generation,
 * and finalization steps.
 *
 * @param theme - Story theme (required)
 * @param mcCandidate.name - Character's display name (optional)
 * @param mcCandidate.age - Character's age in years (optional, 0-150)
 * @param mcCandidate.gender - Character's gender (optional, male/female)
 * @param mcCandidate.bio - Character's bio (optional)
 * @param generateCoverImage - Whether to generate cover image (optional, default: false)
 *
 * @example
 * POST /api/books/stream
 * Body: {
 *   "theme": "haunted mansion mystery",
 *   "mcCandidate": {
 *     "name": "Sarah",
 *     "age": 28,
 *     "gender": "female",
 *     "bio": "Shy librarian with hidden past"
 *   },
 *   "generateCoverImage": true
 * }
 *
 * SSE Events:
 * event: theme_validation_start
 * data: {}
 *
 * event: theme_validation_complete
 * data: {"isValid":true,...}
 *
 * event: book_initialization_start
 * data: {}
 *
 * event: ai_generation_start
 * data: {}
 *
 * event: ai_evaluation_start
 * data: {}
 *
 * event: ai_evaluation_complete
 * data: {}
 *
 * event: ai_generation_complete
 * data: {}
 *
 * event: finalizing_start
 * data: {}
 *
 * event: complete
 * data: {"book":{...},"firstPage":{...},...}
 *
 * event: error
 * data: {"error":"Theme validation failed"}
 */
router.post("/stream", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;

    // STEP 1: VALIDATING THEME
    // Validate theme (required)
    if (!theme || typeof theme !== 'string' || theme.trim().length === 0) {
      return res.status(400).json({
        error: "Missing required field: theme is required and must be a non-empty string"
      });
    }

    // Validate theme length
    if (theme.trim().length > MAX_THEME_LENGTH) {
      return res.status(400).json({
        error: `Theme exceeds maximum length of ${MAX_THEME_LENGTH} characters`
      });
    }

    // STEP 2: VALIDATING MC CANDIDATE
    // Validate mcCandidate if provided
    let parsedMcCandidate: StoryMCCandidate | undefined;
    if (mcCandidate !== undefined && mcCandidate !== null) {
      // Ensure mcCandidate is an object
      if (typeof mcCandidate !== 'object' || Array.isArray(mcCandidate)) {
        return res.status(400).json({
          error: "Invalid mcCandidate: must be an object"
        });
      }

      // Validate name (optional)
      if (mcCandidate.name !== undefined) {
        if (typeof mcCandidate.name !== 'string' || mcCandidate.name.trim().length === 0) {
          return res.status(400).json({
            error: "Invalid mcCandidate.name: must be a non-empty string if provided"
          });
        }
      }

      // Validate age (optional)
      if (mcCandidate.age !== undefined) {
        if (typeof mcCandidate.age !== 'number' || !Number.isInteger(mcCandidate.age)) {
          return res.status(400).json({
            error: "Invalid mcCandidate.age: must be an integer"
          });
        }
        if (mcCandidate.age < MIN_CHARACTER_AGE || mcCandidate.age > MAX_CHARACTER_AGE) {
          return res.status(400).json({
            error: `Invalid mcCandidate.age: must be between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}`
          });
        }
      }

      // Validate gender (optional)
      if (mcCandidate.gender !== undefined) {
        if (typeof mcCandidate.gender !== 'string') {
          return res.status(400).json({
            error: "Invalid mcCandidate.gender: must be a string"
          });
        }
        const genders = ['male', 'female'];
        if (!genders.includes(mcCandidate.gender)) {
          return res.status(400).json({
            error: `Invalid mcCandidate.gender: must be one of ${formatOneOf(genders)}`
          });
        }
      }

      // Validate bio (optional)
      if (mcCandidate.bio !== undefined) {
        if (typeof mcCandidate.bio !== 'string' || mcCandidate.bio.trim().length === 0) {
          return res.status(400).json({
            error: "Invalid mcCandidate.bio: must be a non-empty string if provided"
          });
        }
      }

      parsedMcCandidate = mcCandidate as StoryMCCandidate;
    }

    // STEP 3: VALIDATING GENERATE COVER IMAGE
    // Validate generateCoverImage if provided
    let parsedGenerateCoverImage: boolean | undefined;
    if (generateCoverImage !== undefined) {
      if (typeof generateCoverImage !== 'boolean') {
        return res.status(400).json({
          error: "Invalid generateCoverImage: must be a boolean"
        });
      }
      parsedGenerateCoverImage = generateCoverImage;
    }

    // Initialize SSE headers
    initSSEHeaders(res);

    // Create progress callback for SSE events
    const onProgress: ProgressCallback = (event) => {
      sendSSEEvent(res, event);
    };

    // Create book with progress events
    const result = await createBookCore(
      {
        userId: req.userId!,
        theme: theme.trim(),
        mcCandidate: parsedMcCandidate,
        generateCoverImage: parsedGenerateCoverImage
      },
      onProgress
    );

    // Send final complete event
    sendSSEEvent(res, { type: 'complete', data: result });

    // End response
    res.end();
  } catch (error) {
    // Send error event if headers not sent
    if (!res.headersSent) {
      initSSEHeaders(res);
    }
    sendSSEEvent(res, {
      type: 'error',
      error: getErrorMessage(error)
    });
    res.end();
  }
});

/**
 * GET /api/books/prompt
 * 
 * Generates a creative book creation prompt using AI streaming.
 * This endpoint is used for the "surprise me" feature to provide users
 * with engaging story prompt suggestions.
 * 
 * Returns Server-Sent Events (SSE) stream for real-time typing effect.
 * 
 * @example
 * GET /api/books/prompt
 * 
 * SSE Response:
 * event: start
 * data: {"type":"start","provider":"gemini","model":"gemini-3-flash-preview"}
 * 
 * event: error
 * data: {"type":"error","message":"Model gemini-3-flash-preview failed: ..."}
 * 
 * event: start
 * data: {"type":"start","provider":"gemini","model":"gemini-2.5-flash"}
 * 
 * event: chunk
 * data: {"type":"chunk","content":"Story about your best friend disappearing after joining a","done":false}
 * 
 * event: chunk
 * data: {"type":"chunk","content":" mysterious online community, forcing you to infiltrate its depths to find them, only to uncover a chilling truth about its real purpose and your own connection to it.\nMC: Maya, Female, 19","done":false}
 * 
 * event: end
 * data: {"type":"end","provider":"gemini","model":"gemini-2.5-flash"}
 */
router.get("/prompt", optionalAuth, async (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Create abort controller for client disconnection
  const abortController = new AbortController();
  
  // Handle client disconnection
  req.on('close', () => {
    abortController.abort();
  });

  try {
    // Get the stream from the service
    const stream = await generateBookCreationPrompt(abortController.signal);

    // Stream chunks to client
    for await (const chunk of stream) {
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    console.error('[GET /api/books/prompt] Error:', error);
    
    // Send SSE error event before closing
    if (!res.headersSent) {
      const encoder = new TextEncoder();
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate prompt';
      res.write(encoder.encode(`event: error\ndata: ${errorMessage}\n\n`));
    }
    
    res.end();
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

      // Apply search filter if provided using Drizzle sql template literals
      if (search) {
        const searchPattern = `%${search}%`;
        const searchConditions = [
          sql`${books.title} ILIKE ${searchPattern}`,
          sql`${books.hook} ILIKE ${searchPattern}`,
          sql`${books.summary} ILIKE ${searchPattern}`
        ];
        // Type assertion necessary due to Drizzle ORM's type system limitations with complex queries involving joins
        query = (query as any).where(and(eq(books.userId, userId), or(...searchConditions) as any));
      }

      // Apply sorting
      query = applySorting(query, sortBy, sortOrder);

      // Get total count for pagination
      let countQuery = dbRead
        .select({ count: books.id })
        .from(books)
        .where(eq(books.userId, userId));
        
      if (search) {
        const searchPattern = `%${search}%`;
        const searchConditions = [
          sql`${books.title} ILIKE ${searchPattern}`,
          sql`${books.hook} ILIKE ${searchPattern}`,
          sql`${books.summary} ILIKE ${searchPattern}`
        ];
        // Type assertion necessary due to Drizzle ORM's type system limitations with complex queries involving joins
        countQuery = (countQuery as any).where(and(eq(books.userId, userId), or(...searchConditions) as any));
      }

      const totalCountResult = await countQuery;
      const totalCount = totalCountResult.length;

      // Apply pagination
      const offset = (page - 1) * limit;
      const userBooks: EnrichedBookData[] = await query.limit(limit).offset(offset);

      const pagination = calculatePaginationMeta(page, limit, totalCount);

      return createPaginatedResponse(userBooks, pagination, 'books');
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
    
    // Invalidate popular tags cache if keywords were updated
    if (keywords !== undefined) {
      await invalidatePopularTagsCache();
    }
    
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
      currentPage: newPage.id,
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
    }
    // TODO: ensure type
    // satisfies Omit<DBPage, 'actions'> & { actions: EnrichedAction[] };

    res.json({
      page: enrichedPage,
      book
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
 * @param pageId - Current page ID in reading session (optional - auto-finds page 1 if not provided)
 * @returns Session information with progress
 */
router.post("/:id/sessions", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { pageId } = req.body;
    const userId = req.userId!; // Always defined even for guests
    const bookId = id as string;

    // If no pageId provided, find the first page of the book
    let targetPageId = pageId;
    if (!pageId) {
      const firstPage = await dbRead
        .select({ id: pages.id })
        .from(pages)
        .where(and(
          eq(pages.bookId, bookId),
          eq(pages.page, 1)
        ))
        .limit(1);
      
      if (!firstPage.length) {
        return res.status(404).json({ error: "Book has no pages" });
      }
      
      targetPageId = firstPage[0].id;
    }

    const book = await getBook(bookId);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Create or update existing session
    const session = await setActiveSession({
      userId, // Guest middleware always sets userId to a string (user ID or guest ID)
      bookId, 
      pageId: targetPageId!
    });

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
 * @query tags - Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
 * @query sortBy - Sort option: popular, newest, trending, top-picks, originals (default: newest)
 * @returns Paginated list of published books
 */
router.get("/explore", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy } = extractPaginationParams(req);
    const userId = req.userId || null;
    
    // Extract tags from query parameter (comma-separated)
    const tagsParam = req.query.tags as string;
    const tags = tagsParam ? tagsParam.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : [];
    
    // Validate and normalize sortBy parameter
    const normalizedSortBy: BookSortOption = isValidBookSortOption(sortBy || '') 
      ? (sortBy as BookSortOption) 
      : 'newest';
    
    // Only cache page 1 without search, tags, and with default sort (rapidly changing)
    const shouldCache = page === 1 && !search && tags.length === 0 && normalizedSortBy === 'newest';
    const cacheKey = CACHE_KEYS.EXPLORE_PAGE_1;
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      let query = dbRead
        .select(getEnrichedBookSelect(userId))
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId));

      // Build conditions array starting with status
      const conditions = [eq(books.status, 'active')];

      // Add search conditions if provided
      if (search) {
        const searchPattern = `%${search}%`;
        const searchConditions = [
          sql`${books.title} ILIKE ${searchPattern}`,
          sql`${books.hook} ILIKE ${searchPattern}`,
          sql`${books.summary} ILIKE ${searchPattern}`,
          sql`${books.keywords} ILIKE ${searchPattern}`
        ];
        conditions.push(or(...searchConditions) as any);
      }

      // Add tags filter if provided (OR logic - books matching ANY tag)
      if (tags.length > 0) {
        const tagConditions = tags.map(tag => 
          sql`${books.keywords} @> ${JSON.stringify([tag])}::jsonb`
        );
        conditions.push(or(...tagConditions) as any);
      }

      // Apply all conditions in a single where clause to avoid overwriting
      // Type assertion necessary due to Drizzle ORM's type system limitations with complex queries involving joins
      if (search || tags.length > 0) {
        query = (query as any).where(and(...conditions));
      } else {
        // Only apply status condition if no search and no tags
        query = (query as any).where(eq(books.status, 'active'));
      }

      // Apply book-specific sorting
      query = applyBookSorting(query, normalizedSortBy);

      // Get total count for pagination
      let countQuery = dbRead
        .select({ count: books.id })
        .from(books);

      // Build count conditions array
      const countConditions = [eq(books.status, 'active')];

      // Add search conditions to count query
      if (search) {
        const searchPattern = `%${search}%`;
        const searchConditions = [
          sql`${books.title} ILIKE ${searchPattern}`,
          sql`${books.hook} ILIKE ${searchPattern}`,
          sql`${books.summary} ILIKE ${searchPattern}`,
          sql`${books.keywords} ILIKE ${searchPattern}`
        ];
        countConditions.push(or(...searchConditions) as any);
      }

      // Add tags filter to count query
      if (tags.length > 0) {
        const tagConditions = tags.map(tag => 
          sql`${books.keywords} @> ${JSON.stringify([tag])}::jsonb`
        );
        countConditions.push(or(...tagConditions) as any);
      }

      // Apply all count conditions in a single where clause
      // Type assertion necessary due to Drizzle ORM's type system limitations with complex queries
      if (search || tags.length > 0) {
        countQuery = (countQuery as any).where(and(...countConditions));
      } else {
        countQuery = (countQuery as any).where(eq(books.status, 'active'));
      }

      const totalCountResult = await countQuery;
      const totalCount = totalCountResult.length;

      // Apply pagination
      const offset = (page - 1) * limit;
      const booksResult: EnrichedBookData[] = await query.limit(limit).offset(offset);

      const pagination = calculatePaginationMeta(page, limit, totalCount);

      return createPaginatedResponse(booksResult, pagination, 'books');
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
 * GET /api/books/tags/popular
 * 
 * Fetches popular tags/keywords from books for filtering.
 * Returns most frequently used tags across all published books.
 * 
 * @query limit - Maximum number of tags to return (default: 20, max: 100)
 * @returns Array of popular tag names sorted by frequency
 * 
 * @example
 * // Request
 * GET /api/books/tags/popular?limit=10
 * 
 * // Response
 * {
 *   "tags": ["thriller", "mystery", "horror", "suspense", "detective", "psychological", "crime", "adventure"]
 * }
 */
router.get("/tags/popular", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    
    // Use cache for popular tags
    const tags = await withCache(
      CACHE_KEYS.POPULAR_TAGS,
      async () => await getPopularTags(limit),
      CACHE_TTL.POPULAR_TAGS
    );
    
    res.json({ tags });
  } catch (error) {
    handleApiError(res, "Failed to fetch popular tags", error);
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

/**
 * GET /api/books/stats
 * 
 * Retrieves public book statistics.
 * Returns aggregate statistics about all books in the platform.
 * Accessible to both authenticated and guest users.
 * 
 * @returns Object containing storiesCreated, branchesExplored, and pagesCrafted
 * 
 * @example
 * GET /api/books/stats
 * 
 * Response:
 * {
 *   "storiesCreated": 1234,
 *   "branchesExplored": 5678,
 *   "pagesCrafted": 9012
 * }
 */
router.get("/stats", optionalAuth, async (req: Request, res: Response) => {
  try {
    const stats = await getPublicBookStats();
    res.json(stats);
  } catch (error) {
    handleApiError(res, "Failed to retrieve book stats", error);
  }
});

/**
 * POST /api/books/:id/like
 * 
 * Likes a book for the authenticated user.
 * Increments the book's likes count and records the like in user_likes table.
 * 
 * @param id - Book ID to like
 * @returns Success message with updated like status
 * 
 * @example
 * POST /api/books/book123/like
 * 
 * Response (200):
 * {
 *   "message": "Book liked successfully",
 *   "liked": true,
 *   "likesCount": 42
 * }
 * 
 * Response (409 - already liked):
 * {
 *   "message": "Book already liked",
 *   "liked": true,
 *   "likesCount": 42
 * }
 */
router.post("/:id/like", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id, likesCount: books.likesCount })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Check if already liked
    const existingLike = await dbRead
      .select()
      .from(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, 'book'),
        eq(userLikes.targetId, id as string)
      ))
      .limit(1);

    if (existingLike.length > 0) {
      return res.status(409).json({
        message: "Book already liked",
        liked: true,
        likesCount: book[0].likesCount
      });
    }

    // Add like
    await dbWrite
      .insert(userLikes)
      .values({
        userId,
        targetType: 'book',
        targetId: id as string,
        createdAt: new Date(),
      });

    // Increment book likes count (atomic operation)
    await dbWrite
      .update(books)
      .set({ 
        likesCount: sql`${books.likesCount} + 1`,
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string));

    // Invalidate explore cache (likes changed)
    await invalidateExploreCache();

    res.json({
      message: "Book liked successfully",
      liked: true,
      likesCount: book[0].likesCount + 1
    });
  } catch (error) {
    handleApiError(res, "Failed to like book", error);
  }
});

/**
 * DELETE /api/books/:id/like
 * 
 * Unlikes a book for the authenticated user.
 * Decrements the book's likes count and removes the like from user_likes table.
 * 
 * @param id - Book ID to unlike
 * @returns Success message with updated like status
 * 
 * @example
 * DELETE /api/books/book123/like
 * 
 * Response (200):
 * {
 *   "message": "Book unliked successfully",
 *   "liked": false,
 *   "likesCount": 41
 * }
 * 
 * Response (404 - not liked):
 * {
 *   "message": "Book not liked",
 *   "liked": false,
 *   "likesCount": 42
 * }
 */
router.delete("/:id/like", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id, likesCount: books.likesCount })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Check if liked
    const existingLike = await dbRead
      .select()
      .from(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, 'book'),
        eq(userLikes.targetId, id as string)
      ))
      .limit(1);

    if (existingLike.length === 0) {
      return res.status(404).json({
        message: "Book not liked",
        liked: false,
        likesCount: book[0].likesCount
      });
    }

    // Remove like
    await dbWrite
      .delete(userLikes)
      .where(and(
        eq(userLikes.userId, userId),
        eq(userLikes.targetType, 'book'),
        eq(userLikes.targetId, id as string)
      ));

    // Decrement book likes count (atomic operation)
    await dbWrite
      .update(books)
      .set({ 
        likesCount: sql`GREATEST(${books.likesCount} - 1, 0)`,
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string));

    // Invalidate explore cache (likes changed)
    await invalidateExploreCache();

    res.json({
      message: "Book unliked successfully",
      liked: false,
      likesCount: Math.max(0, book[0].likesCount - 1)
    });
  } catch (error) {
    handleApiError(res, "Failed to unlike book", error);
  }
});

/**
 * POST /api/books/:id/favorite
 * 
 * Adds a book to the authenticated user's favorites.
 * Records the favorite in user_favorites table.
 * 
 * @param id - Book ID to favorite
 * @returns Success message with favorite status
 * 
 * @example
 * POST /api/books/book123/favorite
 * 
 * Response (201):
 * {
 *   "message": "Book added to favorites",
 *   "favorited": true
 * }
 * 
 * Response (409 - already favorited):
 * {
 *   "message": "Book already in favorites",
 *   "favorited": true
 * }
 */
router.post("/:id/favorite", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Check if already favorited
    const existingFavorite = await dbRead
      .select()
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, id as string)
      ))
      .limit(1);

    if (existingFavorite.length > 0) {
      return res.status(409).json({
        message: "Book already in favorites",
        favorited: true
      });
    }

    // Add favorite
    await dbWrite
      .insert(userFavorites)
      .values({
        userId,
        bookId: id as string,
        createdAt: new Date(),
      });

    // Invalidate user's book cache
    await invalidateUserBooksCache(userId);

    res.status(201).json({
      message: "Book added to favorites",
      favorited: true
    });
  } catch (error) {
    handleApiError(res, "Failed to favorite book", error);
  }
});

/**
 * DELETE /api/books/:id/favorite
 * 
 * Removes a book from the authenticated user's favorites.
 * Removes the favorite from user_favorites table.
 * 
 * @param id - Book ID to unfavorite
 * @returns Success message with favorite status
 * 
 * @example
 * DELETE /api/books/book123/favorite
 * 
 * Response (200):
 * {
 *   "message": "Book removed from favorites",
 *   "favorited": false
 * }
 * 
 * Response (404 - not favorited):
 * {
 *   "message": "Book not in favorites",
 *   "favorited": false
 * }
 */
router.delete("/:id/favorite", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Check if favorited
    const existingFavorite = await dbRead
      .select()
      .from(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, id as string)
      ))
      .limit(1);

    if (existingFavorite.length === 0) {
      return res.status(404).json({
        message: "Book not in favorites",
        favorited: false
      });
    }

    // Remove favorite
    await dbWrite
      .delete(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, id as string)
      ));

    // Invalidate user's book cache
    await invalidateUserBooksCache(userId);

    res.json({
      message: "Book removed from favorites",
      favorited: false
    });
  } catch (error) {
    handleApiError(res, "Failed to unfavorite book", error);
  }
});

/**
 * GET /api/books/:id/comments
 * 
 * Retrieves all comments for a specific book.
 * Supports pagination for large comment threads.
 * 
 * @param id - Book ID
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of comments per page (default: 20)
 * @returns Paginated list of comments with user info
 * 
 * @example
 * GET /api/books/book123/comments?page=1&limit=20
 * 
 * Response (200):
 * {
 *   "comments": [
 *     {
 *       "id": "comment123",
 *       "userId": "user456",
 *       "userName": "John Doe",
 *       "userImage": "https://example.com/avatar.jpg",
 *       "bookId": "book123",
 *       "parentCommentId": null,
 *       "content": "This story is amazing!",
 *       "createdAt": "2023-01-01T00:00:00.000Z",
 *       "updatedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 20,
 *     "total": 42,
 *     "totalPages": 3
 *   }
 * }
 */
router.get("/:id/comments", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE } = extractPaginationParams(req);

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userComments)
      .where(eq(userComments.bookId, id as string));
    const totalCount = countResult[0].count;

    // Get comments with user info
    const offset = (page - 1) * limit;
    const comments = await dbRead
      .select({
        id: userComments.id,
        userId: userComments.userId,
        userName: users.name,
        userImage: users.image,
        bookId: userComments.bookId,
        parentCommentId: userComments.parentCommentId,
        content: userComments.content,
        createdAt: userComments.createdAt,
        updatedAt: userComments.updatedAt
      })
      .from(userComments)
      .leftJoin(users, eq(userComments.userId, users.userId))
      .where(eq(userComments.bookId, id as string))
      .orderBy(desc(userComments.createdAt))
      .limit(limit)
      .offset(offset);

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    res.json({
      comments,
      pagination
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve comments", error);
  }
});

/**
 * POST /api/books/:id/comments
 * 
 * Creates a new comment on a book.
 * Supports threaded comments via parentCommentId.
 * 
 * @param id - Book ID
 * @param content - Comment content (required, max 5000 chars)
 * @param parentCommentId - Parent comment ID for replies (optional)
 * @returns Created comment with user info
 * 
 * @example
 * POST /api/books/book123/comments
 * Body: {
 *   "content": "This story is amazing!",
 *   "parentCommentId": "comment789" // optional, for replies
 * }
 * 
 * Response (201):
 * {
 *   "id": "comment123",
 *   "userId": "user456",
 *   "userName": "John Doe",
 *   "userImage": "https://example.com/avatar.jpg",
 *   "bookId": "book123",
 *   "parentCommentId": null,
 *   "content": "This story is amazing!",
 *   "createdAt": "2023-01-01T00:00:00.000Z",
 *   "updatedAt": "2023-01-01T00:00:00.000Z"
 * }
 */
router.post("/:id/comments", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content, parentCommentId } = req.body;
    const userId = req.userId!;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        error: "Content is required and must be a non-empty string"
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        error: "Content exceeds maximum length of 5000 characters"
      });
    }

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return handleNotFoundError(res, "Book not found");
    }

    // Validate parentCommentId if provided
    if (parentCommentId) {
      const parentComment = await dbRead
        .select({ id: userComments.id, bookId: userComments.bookId })
        .from(userComments)
        .where(eq(userComments.id, parentCommentId))
        .limit(1);

      if (!parentComment.length) {
        return res.status(400).json({
          error: "Parent comment not found"
        });
      }

      if (parentComment[0].bookId !== id) {
        return res.status(400).json({
          error: "Parent comment does not belong to this book"
        });
      }
    }

    // Create comment
    const newComment = await dbWrite
      .insert(userComments)
      .values({
        userId,
        bookId: id as string,
        parentCommentId: parentCommentId || null,
        content: content.trim(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // Get user info for response
    const commentWithUser = await dbRead
      .select({
        id: userComments.id,
        userId: userComments.userId,
        userName: users.name,
        userImage: users.image,
        bookId: userComments.bookId,
        parentCommentId: userComments.parentCommentId,
        content: userComments.content,
        createdAt: userComments.createdAt,
        updatedAt: userComments.updatedAt
      })
      .from(userComments)
      .leftJoin(users, eq(userComments.userId, users.userId))
      .where(eq(userComments.id, newComment[0].id))
      .limit(1);

    res.status(201).json(commentWithUser[0]);
  } catch (error) {
    handleApiError(res, "Failed to create comment", error);
  }
});

/**
 * DELETE /api/comments/:id
 * 
 * Deletes a comment.
 * Only the comment author can delete their own comments.
 * 
 * @param id - Comment ID to delete
 * @returns Success message
 * 
 * @example
 * DELETE /api/comments/comment123
 * 
 * Response (200):
 * {
 *   "message": "Comment deleted successfully"
 * }
 */
router.delete("/comments/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    // Check if comment exists and user owns it
    const comment = await dbRead
      .select({ id: userComments.id, userId: userComments.userId })
      .from(userComments)
      .where(eq(userComments.id, id as string))
      .limit(1);

    if (!comment.length) {
      return handleNotFoundError(res, "Comment not found");
    }

    if (comment[0].userId !== userId) {
      return res.status(403).json({
        error: "Forbidden: You can only delete your own comments"
      });
    }

    // Delete comment
    await dbWrite
      .delete(userComments)
      .where(eq(userComments.id, id as string));

    res.json({
      message: "Comment deleted successfully"
    });
  } catch (error) {
    handleApiError(res, "Failed to delete comment", error);
  }
});

export default router;
