/**
 * @overview Books Routes Module
 * 
 * Provides endpoints for managing psychological thriller books and story pages.
 * Implements CRUD operations for book creation, page generation, and session management.
 * 
 * Architecture Features:
 * - Book creation with AI-powered story initialization and credit consumption
 * - Dynamic page generation with branching narratives and candidate pre-generation
 * - Session management for reading progress
 * - Character and place tracking
 * - Psychological state management
 * - Translation support with caching
 * - Social interactions (likes, favorites, comments)
 * 
 * Endpoints:
 * - POST /api/books - Create new psychological thriller books (requires auth + credits)
 * - POST /api/books/stream - Create new psychological thriller books with streaming (requires auth + credits)
 * - GET /api/books - Retrieve user's book library (requires auth)
 * - GET /api/books/explore - Explore published books with search and pagination (optional auth)
 * - PUT /api/books/:id - Update book information and cover image (requires auth)
 * - GET /api/books/:identifier - Retrieve specific book by slug or id
 * - GET /api/books/:identifier/:pageId - Retrieve specific pages with translation support (requires auth)
 * - GET /api/books/:identifier/:pageId/candidates - Pre-generate candidate pages (requires auth)
 * - POST /api/books/:id/sessions - Manage reading sessions (optional auth)
 * - GET /api/books/:id/similar - Get similar books by keyword Jaccard similarity (optional auth)
 * - POST /api/books/:id/like - Like a book (requires auth)
 * - DELETE /api/books/:id/like - Unlike a book (requires auth)
 * - POST /api/books/:id/favorite - Add book to favorites (requires auth)
 * - DELETE /api/books/:id/favorite - Remove book from favorites (requires auth)
 * - GET /api/books/:id/comments - Get book comments with pagination (optional auth)
 * - POST /api/books/:id/comments - Create comment on book (requires auth)
 * - DELETE /api/books/comments/:id - Delete comment (requires auth)
 * - GET /api/books/tags/popular - Get popular tags for filtering (no auth required)
 * - GET /api/books/stats - Get public book statistics (optional auth)
 * - GET /api/books/prompt - Generate book creation prompt via SSE (optional auth)
 * - POST /api/books/insert - Test route for direct book insertion (requires auth)
 * - DELETE /api/books/:id - Delete a book and queue image for deletion (requires auth)
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { optionalAuth, requireAuth } from "../middleware/nextauth.js";
import { guestOrAuthMiddleware } from "../middleware/guest.js";
import { books, userSessions, deletedImages, users, userLikes, userFavorites, userComments } from "../db/schema.js";
import { getErrorMessage, handleApiError, handleNotFoundError, handleValidationError } from "../utils/error.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { formatOneOf, generateBookCreationPromptStream, ensureCandidatesForPage } from "../utils/prompt.js";
import { getEnrichedBook, getPageFromDB, mapToEnrichedPage } from "../services/book.js";
import { imageUpload, deleteFileFromImageKit } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { validateSearchQuery, validateLanguageCode } from "../utils/search.js";
import type { ImageUploadSource } from "../types/image.js";
import { updateBook, insertBook, uploadBookCoverImage, resolveBook, getPublicBookStats, getPopularTags, mapToUserStoryPage } from "../services/book.js";
import { isValidBookSortOption, isValidLastUpdatedFilter } from "../utils/books.js";
import { getEnrichedBookSelect, getSimilarBookSelect, buildBookQuery, visitBookPage } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache, invalidatePopularTagsCache } from "../services/cache.js";
import { lastUpdatedFilterOptions, type BookSortOption, type EnrichedBookData } from "../types/book.js";
import type { StoryMCCandidate } from "../types/character.js";
import { createBookCore, handleBookCreationError } from "../services/book-creation.js";
import { consumeCredits } from "../services/credits.js";
import { logUserActivity } from "../services/user.js";
import { CREDIT_COSTS } from "../config/credits.js";
import { isCreditError } from "../config/errors.js";
import { initSSEHeaders, sendSSEEvent } from "../utils/sse.js";
import type { ProgressCallback } from "../types/sse.js";
import { MAX_THEME_LENGTH } from "../config/theme-validation.js";
import { MIN_CHARACTER_AGE, MAX_CHARACTER_AGE } from "../config/story.js";
import { isValidUuid } from "../utils/uuid.js";

const router = Router();

// SSE polling configuration
const SSE_POLL_INTERVAL_MS = 2000; // 2s
const SSE_MAX_ATTEMPTS = 150; // 5 minutes / 2s
const SSE_PROGRESS_INTERVAL = 5; // every 5 polls => 10s

/**
 * POST /api/books
 *
 * Creates a new psychological thriller book with AI-generated content.
 * Accepts theme and main character candidate, initializes story with AI.
 * Returns complete book information with first page and initial state.
 *
 * **Authentication:** Guest or Authenticated (via `guestOrAuthMiddleware`)
 * - Guest users can create books without signup
 * - Guest-created books are associated with a temporary guest user ID
 * - When guest signs up, all their books migrate to their authenticated account via `migrateGuestData()`
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
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;
    const userId = req.userId!;
    
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

    // Consume credits for story generation (transactional check included)
    try {
      await consumeCredits(userId, "STORY_GENERATION", {
        context: "book_creation",
        metadata: { theme: theme.trim() }
      });
    } catch (error) {
      if (isCreditError(error)) {
        return res.status(402).json({
          error: {
            type: "INSUFFICIENT_CREDITS",
            message: `Insufficient credits to create a story. Requires ${CREDIT_COSTS.STORY_GENERATION} credits.`,
            required: CREDIT_COSTS.STORY_GENERATION
          }
        });
      }
      throw error; // Re-throw other errors
    }

    // Use shared core logic (without progress callback for synchronous response)
    const result = await createBookCore(
      {
        userId,
        theme,
        mcCandidate,
        generateCoverImage
      },
      // No progress callback for POST endpoint (synchronous response)
      undefined
    );

    // Invalidate popular tags cache since new book may have new keywords
    await invalidatePopularTagsCache();

    // Log user activity (book creation)
    await logUserActivity({
      userId,
      activityType: 'book_created',
      targetType: 'book',
      targetId: result.book.id,
      metadata: { theme: theme.trim() },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      platform: req.get('x-platform'),
      appVersion: req.get('x-app-version'),
    });

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
 * **Authentication:** Guest or Authenticated (via `guestOrAuthMiddleware`)
 * - Guest users can create books without signup
 * - Guest-created books are associated with a temporary guest user ID
 * - When guest signs up, all their books migrate to their authenticated account via `migrateGuestData()`
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
 * event: ai_generation_complete
 * data: {}
 *
 * event: ai_evaluation_start
 * data: {}
 *
 * event: ai_evaluation_complete
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
router.post("/stream", requireAuth, async (req: Request, res: Response) => {
  try {
    const { theme, mcCandidate, generateCoverImage } = req.body;
    const userId = req.userId!;

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

    // Consume credits for story generation (transactional check included)
    try {
      await consumeCredits(userId, "STORY_GENERATION", {
        context: "book_creation_stream",
        metadata: { theme: theme.trim() }
      });
    } catch (error) {
      if (isCreditError(error)) {
        return res.status(402).json({
          error: {
            type: "INSUFFICIENT_CREDITS",
            message: `Insufficient credits to create a story. Requires ${CREDIT_COSTS.STORY_GENERATION} credits.`,
            required: CREDIT_COSTS.STORY_GENERATION
          }
        });
      }
      throw error; // Re-throw other errors
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

    // Credits already consumed above in transactional check

    // Create book with progress events
    const result = await createBookCore(
      {
        userId,
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
    const stream = await generateBookCreationPromptStream({signal: abortController.signal});

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
      const errorMessage = getErrorMessage(error, 'Failed to generate prompt');
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
 * Supports search, language filtering, sorting, and time-based filtering.
 * 
 * **Enhanced Search Features:**
* Searches across title, hook, summary, and keywords
* Language filter (ISO 639-1 codes: en, es, fr, etc.)
* Tags filter (comma-separated, OR logic)
* Relevance scoring for search results (title: 40%, hook: 25%, summary: 20%, keywords: 15%)
* Time-based filtering by last update date
* **Two-level sorting hierarchy:**
  * **Primary:** Book-specific sorting (popular, trending, top-picks, originals, newest)
  * **Secondary:** Relevance scoring (when searching) or generic column sorting
 * 
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of books per page (default: 10)
 * @query search - Search query for title, hook, summary, keywords
 * @query language - Filter by language code (e.g., "en", "es")
 * @query tags - Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
 * @query sortBy - Field to sort by (default: updatedAt)
 * @query sortOrder - Sort direction (default: desc)
 * @query lastUpdated - Filter by last update time: anytime|today|this-week|this-month|this-year
 * @returns Paginated list of user's books with progress
 * 
 * @todo
 * - do we need to migrate offset pagination into cursor pagination to support post-query sorting?
 * - follow `BOOK_SEARCH_ENHANCEMENT_ROADMAP.md` roadmap docs
 * 
 * @example
 * // Search for thriller books
 * GET /api/books?search=thriller
 * 
 * // Filter by English language
 * GET /api/books?language=en
 * 
 * // Filter by books updated this week
 * GET /api/books?lastUpdated=this-week
 * 
 * // Filter by tags
 * GET /api/books?tags=thriller,mystery
 * 
 * // Combined search with all filters
 * GET /api/books?search=mystery&language=en&lastUpdated=this-month&tags=thriller
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder, lastUpdated, language, tags } = extractPaginationParams(req);
    const userId = req.userId!;
    
    // Extract tags from query parameter (comma-separated)
    const tagsParam = tags as string;
    const tagsArray = tagsParam ? tagsParam.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : [];
    
    // Validate search query if provided
    let sanitizedSearch: string | undefined;
    if (search) {
      const validation = validateSearchQuery(search);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error
        });
      }
      sanitizedSearch = validation.sanitized;
    }

    // Validate language code if provided
    if (language) {
      const langValidation = validateLanguageCode(language);
      if (!langValidation.isValid) {
        return res.status(400).json({
          error: langValidation.error
        });
      }
    }

    // Validate lastUpdated filter if provided
    if (lastUpdated && !isValidLastUpdatedFilter(lastUpdated)) {
      return res.status(400).json({
        error: `Invalid lastUpdated value. Must be: ${lastUpdatedFilterOptions.join(', ')}`
      });
    }
    
    // Validate and normalize sortBy parameter
    const bookSortBy: BookSortOption = isValidBookSortOption(sortBy || '') 
      ? (sortBy as BookSortOption) 
      : 'newest';
    
    // Skip caching for search queries (dynamic)
    const shouldCache = !search && !language && !lastUpdated && tagsArray.length === 0;
    const cacheKey = lastUpdated 
      ? `books:user:${userId}:page:${page}:lastUpdated:${lastUpdated}`
      : CACHE_KEYS.USER_BOOKS(userId, page);
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Create subquery for latest user sessions using ROW_NUMBER() window function
      const latestUserSessions = dbRead
        .select({
          id: userSessions.id,
          userId: userSessions.userId,
          bookId: userSessions.bookId,
          pageId: userSessions.pageId,
          updatedAt: userSessions.updatedAt,
          rowNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${userSessions.userId}, ${userSessions.bookId} ORDER BY ${userSessions.updatedAt} DESC)`.as('row_number')
        })
        .from(userSessions)
        .where(eq(userSessions.userId, userId))
        .as('latestUserSessions');

      // Build base query with enriched fields
      const baseQuery = dbRead
        .select({
          ...getEnrichedBookSelect(userId),
          lastReadAt: latestUserSessions.updatedAt,
          lastPage: latestUserSessions.pageId
        })
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId))
        .leftJoin(
          latestUserSessions,
          and(
            eq(latestUserSessions.bookId, books.id),
            eq(latestUserSessions.userId, userId),
            eq(latestUserSessions.rowNumber, 1) // Only get the latest session per book
          )
        );

      // Build comprehensive query using shared helper
      const { query, countQuery } = buildBookQuery<typeof baseQuery>({
        baseQuery,
        baseCondition: eq(books.userId, userId),
        search: sanitizedSearch,
        bookSortBy, // Primary: book-specific sorting
        genericSortBy: sortBy, // Secondary: generic fallback (when no search)
        sortOrder,
        tags: tagsArray,
        language,
        lastUpdated
      });

      const countResult = await countQuery;
      const totalCount = typeof countResult[0]?.count === 'number' ? countResult[0]?.count : 0;

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
 * GET /api/books/:id/similar
 * 
 * Retrieves similar books based on keyword Jaccard similarity.
 * Uses PostgreSQL's native array operations to calculate similarity scores.
 * 
 * Jaccard Similarity Formula: J(A, B) = |A ∩ B| / |A ∪ B|
 * 
 * Returns books with highest keyword overlap, sorted by similarity score.
 * Includes author information and user-specific engagement flags.
 * 
 * @param id - Book ID to find similar books for (accepts both slug and UUID)
 * @param limit - Maximum number of similar books to return (default: 10, max: 50)
 * @returns Array of similar books with similarity scores and enriched metadata
 * 
 * @example
 * GET /api/books/book123/similar?limit=5
 * 
 * Response:
 * {
 *   "similarBooks": [
 *     {
 *       "id": "book456",
 *       "title": "Another Thriller",
 *       "similarityScore": 0.75,
 *       "author": {...},
 *       "stats": {...},
 *       "isLiked": false,
 *       "isRead": true,
 *       ...
 *     },
 *     ...
 *   ]
 * }
 */
router.get("/:id/similar", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const currentUserId = req.userId || null;

    // Handle array case for id (Express can return string[])
    const bookId = Array.isArray(id) ? id[0] : id;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(bookId);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get similar books with enriched data
    const similarBooks = await dbRead
      .select({
        ...getSimilarBookSelect(book.keywords, currentUserId),
      })
      .from(books)
      .leftJoin(users, eq(books.userId, users.userId))
      .where(
        and(
          // Exclude the target book itself
          sql`${books.id} != ${book.id}`,
          // Only include books with keywords
          sql`cardinality(${books.keywords}::text[]) > 0`,
          // Only include active books
          eq(books.status, 'active')
        )
      )
      .orderBy(desc(sql`similarityScore`))
      .limit(limit);

    res.json({
      similarBooks,
      targetBook: {
        id: book.id,
        title: book.title,
        keywords: book.keywords,
      },
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve similar books", error);
  }
});

/**
 * GET /api/books/:identifier/:pageId
 * 
 * Retrieves a specific page within a branch of a book.
 * Accepts both slug and UUID v7 as identifier.
 * 
 * Supports translation via Accept-Language header. If the requested language
 * differs from the book's language, the page text will be translated and cached.
 * 
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page identifier (e.g., "main", "abc123")
 * @header Accept-Language - Desired language code (e.g., "en", "es", "fr")
 * @returns Page with actions and book metadata
 */
router.get("/:identifier/:pageId", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId, prefetch } = req.params;
    const userId = req.userId!; // Always defined even for guests
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    const { visitDetails, book, dbPage } = await visitBookPage(res, { userId, pageId: pageId as string, bookIdentifier, skipVisit: prefetch === 'true' });
    if (!dbPage) return handleNotFoundError(res, "Page not found");
    if (!book) return handleNotFoundError(res, "Book not found");

    // Handle translation if Accept-Language header is provided and differs from book language
    const acceptLanguage = req.headers['accept-language'] as string | undefined;
    const bookLanguage = book.language || 'en';
    
    // Return enriched page with only frontend-relevant fields
    const page = await mapToEnrichedPage(dbPage, {
      userId,
      bookLanguage,
      acceptLanguage,
    });

    if (!page) {
      return handleApiError(res, "Failed to get enriched page");
    }

    res.json({
      page,
      book,
      visitDetails
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve page", error);
  }
});

// /**
//  * POST /api/books/:id/sessions
//  * 
//  * Creates or updates a reading session for the book.
//  * Tracks reading progress and manages active sessions.
//  * 
//  * @param id - Book ID
//  * @param pageId - Current page ID in reading session (optional - auto-finds page 1 if not provided)
//  * @returns Session information with progress
//  */
// router.post("/:id/sessions", guestOrAuthMiddleware, async (req: Request, res: Response) => {
//   try {
//     const { id } = req.params;
//     const { pageId } = req.body;
//     const userId = req.userId!; // Always defined even for guests
//     const bookId = id as string;

//     // If no pageId provided, find the first page of the book
//     let targetPageId = pageId;
//     if (!pageId) {
//       const firstPage = await dbRead
//         .select({ id: pages.id })
//         .from(pages)
//         .where(and(
//           eq(pages.bookId, bookId),
//           eq(pages.page, 1)
//         ))
//         .limit(1);
      
//       if (!firstPage.length) {
//         return res.status(404).json({ error: "Book has no pages" });
//       }
      
//       targetPageId = firstPage[0].id;
//     }

//     const book = await getBook(bookId);
//     if (!book) {
//       return handleNotFoundError(res, "Book not found");
//     }

//     // Create or update existing session
//     const session = await setActiveSession({
//       userId, // Guest middleware always sets userId to a string (user ID or guest ID)
//       bookId, 
//       pageId: targetPageId!
//     });

//     // Invalidate caches on session start
//     await invalidateExploreCache(); // readCount changed via trigger
//     await invalidateUserProfileCache(userId); // readsCount changed

//     res.status(201).json({
//       session,
//       book
//     });
//   } catch (error) {
//     handleApiError(res, "Failed to manage session", error);
//   }
// });

/**
 * GET /api/books/:identifier/:pageId/candidates
 * 
 * Pre-generates candidate pages for all actions on a story page.
 * This ensures that when users select actions, the corresponding destination pages
 * are immediately available without waiting for AI generation.
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * If candidate generation is already in progress (isGeneratingStartedAt is not null), this endpoint
 * uses Server-Sent Events (SSE) to wait for completion instead of triggering duplicate
 * operations. This prevents expensive AI generation from running multiple times for
 * the same (bookId + pageId) combination.
 * 
 * @param id - Book ID
 * @param pageId - Page ID for which to generate candidates
 * @returns Updated page with pre-generated candidates (via JSON or SSE)
 * 
 * @example
 * GET /api/books/book123/page456/candidates
 * 
 * Response (200) - JSON when generation completes immediately:
 * {
 *   "id": "page456",
 *   "page": 5,
 *   "text": "...",
 *   "actions": [
 *     {
 *       "text": "Open the door",
 *       "destination": { "branchId": "branch789", "pageId": "page790" }
 *     }
 *   ]
 * }
 * 
 * Response (200) - SSE when generation is in progress:
 * event: progress
 * data: {"status": "waiting", "message": "Candidate generation in progress..."}
 * 
 * event: complete
 * data: {"id": "page456", "page": 5, "text": "...", "actions": [...]}
 */
router.get("/:identifier/:pageId/candidates", guestOrAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId } = req.params;
    const userId = req.userId!;

    // Early validation
    if (!isValidUuid(pageId)) {
      return handleValidationError(res, "Invalid pageId: must be valid uuid");
    }

    // Resolve book by identifier (slug first, then UUID)
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const book = await resolveBook(bookIdentifier);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get the page from database
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return handleNotFoundError(res, "Page not found");
    }

    // Verify page belongs to the specified book
    if (dbPage.bookId !== book.id) {
      return handleValidationError(res, "Page does not belong to the specified book");
    }

    // Check if generation is already in progress (timestamp field)
    if (dbPage.isGeneratingStartedAt) {
      console.log(`[GET /candidates] Generation in progress for page ${pageId}, using SSE to wait (started at ${dbPage.isGeneratingStartedAt})`);

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send initial waiting message
      res.write(`event: progress\n`);
      res.write(`data: ${JSON.stringify({ status: 'waiting', message: 'Candidate generation in progress...' })}\n\n`);

      // Poll for completion (check every SSE_POLL_INTERVAL_MS, max SSE_MAX_ATTEMPTS)
      let attempts = 0;
      let clientDisconnected = false;

      const onClientDisconnect = () => {
        clientDisconnected = true;
        console.log(`[GET /candidates] Client disconnected while waiting for generation of page ${pageId}`);
        try {
          res.end();
        } catch {
          // Ignore errors
        };
      };

      req.on('close', onClientDisconnect);
      req.on('aborted', onClientDisconnect);

      while (attempts < SSE_MAX_ATTEMPTS) {
        // Break early if client disconnected
        if (clientDisconnected || res.writableEnded) {
          req.off('close', onClientDisconnect);
          req.off('aborted', onClientDisconnect);
          console.log(`[GET /candidates] Stopping polling for page ${pageId} due to client disconnect`);
          return;
        }

        await new Promise(resolve => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
        attempts++;

        // Refresh page from database
        const freshPage = await getPageFromDB(pageId);
        if (!freshPage) {
          if (!res.writableEnded) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: 'Page not found during polling' })}\n\n`);
            res.end();
          }
          req.off('close', onClientDisconnect);
          req.off('aborted', onClientDisconnect);
          return;
        }

        // Check if generation is complete (timestamp cleared)
        if (!freshPage.isGeneratingStartedAt) {
          console.log(`[GET /candidates] Generation completed for page ${pageId} after ${attempts} polls`);
          try {
            const userPage = await mapToUserStoryPage(freshPage, userId);
            if (!res.writableEnded) {
              res.write(`event: complete\n`);
              res.write(`data: ${JSON.stringify(userPage)}\n\n`);
              res.end();
            }
          } catch {
            if (!res.writableEnded) {
              res.write(`event: error\n`);
              res.write(`data: ${JSON.stringify({ error: 'Failed to process page data' })}\n\n`);
              res.end();
            }
          } finally {
            req.off('close', onClientDisconnect);
            req.off('aborted', onClientDisconnect);
          }
          return;
        }

        // Send progress update periodically
        if (attempts % SSE_PROGRESS_INTERVAL === 0 && !res.writableEnded) {
          res.write(`event: progress\n`);
          res.write(`data: ${JSON.stringify({ status: 'waiting', message: `Still generating... (${attempts * SSE_POLL_INTERVAL_MS/1000}s elapsed)` })}\n\n`);
        }
      }

      // Timeout - fetch freshest state and return it
      console.log(`[GET /candidates] Timeout waiting for generation of page ${pageId}`);
      try {
        const freshAfterTimeout = await getPageFromDB(pageId, { client: dbWrite });
        try {
          const userPage = await mapToUserStoryPage(freshAfterTimeout || dbPage, userId);
          if (!res.writableEnded) {
            res.write(`event: timeout\n`);
            res.write(`data: ${JSON.stringify({ ...userPage, warning: 'Generation timeout, returning current state' })}\n\n`);
            res.end();
          }
        } catch {
          if (!res.writableEnded) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: 'Failed to process page data' })}\n\n`);
            res.end();
          }
        }
      } finally {
        req.off('close', onClientDisconnect);
        req.off('aborted', onClientDisconnect);
      }
      return;
    }

    // Pre-generate candidates for page (not currently in progress)
    const userPage = await mapToUserStoryPage(dbPage, userId);
    const updatedPage = await ensureCandidatesForPage(
      userId,   // Candidate pages initiator
      userPage, // Used for determining which actions need candidates
      null,     // Will be inferred in generateCandidatePage via getStoryProgress
      book      // Used for totalPages check
    );

    res.json(updatedPage);
  } catch (error) {
    handleApiError(res, "Failed to generate candidates", error);
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
 * @query search - Search query for title, hook, summary, keywords
 * @query language - Filter by language code (e.g., "en", "es")
 * @query tags - Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
 * @query sortBy - Field to sort by (default: updatedAt)
 * @query sortOrder - Sort direction (default: desc)
 * @query lastUpdated - Filter by last update time: anytime|today|this-week|this-month|this-year
 * @returns Paginated list of published books
 */
router.get("/explore", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder, lastUpdated, language, tags } = extractPaginationParams(req);
    const userId = req.userId || null;
    
    // Extract tags from query parameter (comma-separated)
    const tagsParam = tags as string;
    const tagsArray = tagsParam ? tagsParam.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : [];
    
    // Validate search query if provided
    let sanitizedSearch: string | undefined;
    if (search) {
      const validation = validateSearchQuery(search);
      if (!validation.isValid) {
        return res.status(400).json({
          error: validation.error
        });
      }
      sanitizedSearch = validation.sanitized;
    }

    // Validate language code if provided
    if (language) {
      const langValidation = validateLanguageCode(language);
      if (!langValidation.isValid) {
        return res.status(400).json({
          error: langValidation.error
        });
      }
    }

    // Validate lastUpdated filter if provided
    if (lastUpdated && !isValidLastUpdatedFilter(lastUpdated)) {
      return res.status(400).json({
        error: `Invalid lastUpdated value. Must be: ${lastUpdatedFilterOptions.join(', ')}`
      });
    }
    
    // Validate and normalize sortBy parameter
    const bookSortBy: BookSortOption = isValidBookSortOption(sortBy || '') 
      ? (sortBy as BookSortOption) 
      : 'newest';
    
    // Cache page 1 without search, tags, language, and time filters
    // Trending uses shorter TTL (5 min) due to incremental updates, newest uses longer TTL (30 min)
    const shouldCache = page === 1 && !search && tagsArray.length === 0 && !language && !lastUpdated;
    const cacheKey = bookSortBy === 'trending' ? CACHE_KEYS.EXPLORE_PAGE_1_TRENDING : CACHE_KEYS.EXPLORE_PAGE_1;
    const cacheTTL = bookSortBy === 'trending' ? CACHE_TTL.FIVE_MINUTES : CACHE_TTL.THIRTY_MINUTES;
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      const baseQuery = dbRead
        .select(getEnrichedBookSelect(userId))
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId));

      // Build comprehensive query using shared helper
      const { query, countQuery } = buildBookQuery<typeof baseQuery>({
        baseQuery,
        baseCondition: eq(books.status, 'active'),
        search: sanitizedSearch,
        bookSortBy, // Primary: book-specific sorting
        genericSortBy: sortBy, // Secondary: generic fallback (when no search)
        sortOrder,
        tags: tagsArray,
        language,
        lastUpdated
      });

      const totalCountResult = await countQuery;
      const totalCount = totalCountResult.length;

      // Apply pagination
      // TODO: similar books via pgvector embedding
      const offset = (page - 1) * limit;
      const booksResult: EnrichedBookData[] = await query.limit(limit).offset(offset);

      const pagination = calculatePaginationMeta(page, limit, totalCount);

      return createPaginatedResponse(booksResult, pagination, 'books');
    };
    
    // Use cache if applicable, otherwise fetch directly
    const result = shouldCache
      ? await withCache(cacheKey, fetchBooks, cacheTTL)
      : await fetchBooks();

    // Add HTTP cache headers for CDN/edge caching (works alongside Redis)
    if (shouldCache) {
      const httpCacheMaxAge = bookSortBy === 'trending' ? 300 : 1800; // 5 min for trending, 30 min for newest
      res.set('Cache-Control', `public, max-age=${httpCacheMaxAge}, s-maxage=${httpCacheMaxAge}, stale-while-revalidate=${httpCacheMaxAge / 2}`);
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

    // Use transaction for atomic like operation
    const result = await dbWrite.transaction(async (tx) => {
      // Check if book exists and get current likes count in single query
      const book = await tx
        .select({ id: books.id, likesCount: books.likesCount })
        .from(books)
        .where(eq(books.id, id as string))
        .limit(1)
        .for('update'); // Lock the row for the transaction

      if (!book.length) {
        throw new Error('BOOK_NOT_FOUND');
      }

      // Check if already liked
      const existingLike = await tx
        .select()
        .from(userLikes)
        .where(and(
          eq(userLikes.userId, userId),
          eq(userLikes.targetType, 'book'),
          eq(userLikes.targetId, id as string)
        ))
        .limit(1);

      if (existingLike.length > 0) {
        return {
          alreadyLiked: true,
          likesCount: book[0].likesCount
        };
      }

      // Add like
      await tx
        .insert(userLikes)
        .values({
          userId,
          targetType: 'book',
          targetId: id as string,
          createdAt: new Date(),
        });

      // Increment book likes count and trending score (atomic operation)
      const updatedBook = await tx
        .update(books)
        .set({
          likesCount: sql`${books.likesCount} + 1`,
          trendingScore: sql`${books.trendingScore} + 0.3`,
          updatedAt: new Date()
        })
        .where(eq(books.id, id as string))
        .returning({ likesCount: books.likesCount });

      return {
        alreadyLiked: false,
        likesCount: updatedBook[0]?.likesCount
      };
    });

    // Invalidate explore cache after successful transaction
    await invalidateExploreCache();

    if (result.alreadyLiked) {
      return res.status(409).json({
        message: "Book already liked",
        liked: true,
        likesCount: result.likesCount
      });
    }

    res.json({
      message: "Book liked successfully",
      liked: true,
      likesCount: result.likesCount!
    });
  } catch (error) {
    if (getErrorMessage(error) === 'BOOK_NOT_FOUND') {
      return handleNotFoundError(res, "Book not found");
    }
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

    // Use transaction for atomic unlike operation
    const result = await dbWrite.transaction(async (tx) => {
      // Check if book exists and get current likes count in single query
      const book = await tx
        .select({ id: books.id, likesCount: books.likesCount })
        .from(books)
        .where(eq(books.id, id as string))
        .limit(1)
        .for('update'); // Lock the row for the transaction

      if (!book.length) {
        throw new Error('BOOK_NOT_FOUND');
      }

      // Check if liked
      const existingLike = await tx
        .select()
        .from(userLikes)
        .where(and(
          eq(userLikes.userId, userId),
          eq(userLikes.targetType, 'book'),
          eq(userLikes.targetId, id as string)
        ))
        .limit(1);

      if (existingLike.length === 0) {
        return {
          notLiked: true,
          likesCount: book[0].likesCount
        };
      }

      // Remove like
      await tx
        .delete(userLikes)
        .where(and(
          eq(userLikes.userId, userId),
          eq(userLikes.targetType, 'book'),
          eq(userLikes.targetId, id as string)
        ));

      // Decrement book likes count and trending score (atomic operation)
      const updatedBook = await tx
        .update(books)
        .set({
          likesCount: sql`GREATEST(${books.likesCount} - 1, 0)`,
          trendingScore: sql`GREATEST(${books.trendingScore} - 0.3, 0)`,
          updatedAt: new Date()
        })
        .where(eq(books.id, id as string))
        .returning({ likesCount: books.likesCount });

      return {
        notLiked: false,
        likesCount: updatedBook[0]?.likesCount
      };
    });

    // Invalidate explore cache after successful transaction
    await invalidateExploreCache();

    if (result.notLiked) {
      return res.status(404).json({
        message: "Book not liked",
        liked: false,
        likesCount: result.likesCount
      });
    }

    res.json({
      message: "Book unliked successfully",
      liked: false,
      likesCount: result.likesCount!
    });
  } catch (error) {
    if (getErrorMessage(error) === 'BOOK_NOT_FOUND') {
      return handleNotFoundError(res, "Book not found");
    }
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

    // Add favorite and increment trending score
    await dbWrite
      .insert(userFavorites)
      .values({
        userId,
        bookId: id as string,
        createdAt: new Date(),
      });

    // Increment trending score for hybrid approach
    // Note: No GREATEST protection needed on increments - only decrements can go negative
    await dbWrite
      .update(books)
      .set({
        trendingScore: sql`${books.trendingScore} + 0.2`,
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string));

    // Invalidate user's book cache
    // Note: Cache invalidation after DB update is acceptable - window of stale data is minimal (milliseconds)
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

    // Remove favorite and decrement trending score
    await dbWrite
      .delete(userFavorites)
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.bookId, id as string)
      ));

    // Decrement trending score for hybrid approach
    await dbWrite
      .update(books)
      .set({
        trendingScore: sql`GREATEST(${books.trendingScore} - 0.2, 0)`,
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string));

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

/**
 * GET /api/books/:identifier
 * 
 * Retrieves a book by slug or UUID v7 identifier.
 * Returns complete book information including metadata and author details.
 * 
 * @param identifier - Book slug or UUID v7
 * @returns Complete book with enriched metadata
 * 
 * @example
 * GET /api/books/whispering-halls
 * 
 * Response:
 * {
 *   "book": {
 *     "id": "book123",
 *     "userId": "user456",
 *     "slug": "whispering-halls",
 *     "title": "The Whispering Halls",
 *     "totalPages": 120,
 *     "language": "en",
 *     "hook": "Sarah never believed in ghosts until she found the diary",
 *     "summary": "A psychological thriller about a librarian who discovers dark secrets",
 *     "image": "https://example.com/cover.jpg",
 *     "keywords": ["mystery", "thriller", "haunted"],
 *     "status": "active",
 *     "mc": {
 *       "name": "Sarah",
 *       "age": 28,
 *       "gender": "female",
 *       "bio": "Shy librarian with hidden past"
 *     },
 *     "author": {
 *       "id": "user456",
 *       "name": "John Doe",
 *       "username": "johndoe",
 *       "image": "https://example.com/avatar.jpg"
 *     },
 *     "stats": {
 *       "likesCount": 42,
 *       "readCount": 156,
 *       "commentsCount": 25,
 *       "branchesCount": 12
 *     },
 *     "isLiked": false,
 *     "isRead": false,
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-15T10:30:00.000Z"
 *   }
 * }
 */
router.get("/:identifier", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    const enrichedBook = await getEnrichedBook(bookIdentifier, req.userId);
    if (!enrichedBook) {
      return handleNotFoundError(res, "Book not found");
    }

    res.json({ book: enrichedBook });
  } catch (error) {
    handleApiError(res, "Failed to retrieve book", error);
  }
});

export default router;
