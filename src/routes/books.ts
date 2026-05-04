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
 * - GET /api/books/:identifier/:pageId - Retrieve specific pages with translation support (requires auth)
 * - POST /api/books/:identifier/:pageId/visit - Mark page as visited and track progress (requires auth)
 * - POST /api/books/:identifier/:pageId/candidates - Pre-generate candidate pages (requires auth)
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
import { books, pages, userSessions, deletedImages, users, userLikes, userFavorites, userComments, userPageProgress } from "../db/schema.js";
import { getErrorMessage, handleApiError, handleNotFoundError, handleValidationError } from "../utils/error.js";
import { deepEqualSimple } from "../utils/parser.js";
import { eq, and, desc, sql, or } from "drizzle-orm";
import { formatOneOf, generateBookCreationPromptStream, ensureCandidatesForPage } from "../utils/prompt.js";
import { enrichActions, getEnrichedBook } from "../services/book.js";
import { imageUpload, deleteFileFromImageKit } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, applySorting, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { validateSearchQuery, buildSearchConditions, createRelevanceExpression, validateLanguageCode, type SearchParams } from "../utils/search.js";
import type { ImageUploadSource } from "../types/image.js";
import { setActiveSession, markPageVisited } from "../services/story.js";
import { getBook, updateBook, insertBook, uploadBookCoverImage, resolveBook, getPublicBookStats, applyBookSorting, getPopularTags, triggerCandidateGenerationRetry, mapToUserStoryPage } from "../services/book.js";
import { isValidBookSortOption } from "../utils/books.js";
import { getEnrichedBookSelect, getSimilarBookSelect } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache, invalidatePopularTagsCache } from "../services/cache.js";
import type { BookSortOption, EnrichedBookData } from "../types/book.js";
import type { StoryMCCandidate } from "../types/character.js";
import type { Action, EnrichedAction } from "../types/story.js";
import { createBookCore, handleBookCreationError } from "../services/book-creation.js";
import { consumeCredits } from "../services/credits.js";
import { getTranslatedText, shouldTranslate } from "../services/translation.js";
import { CREDIT_COSTS } from "../config/credits.js";
import { isCreditError } from "../config/errors.js";
import { initSSEHeaders, sendSSEEvent } from "../utils/sse.js";
import type { ProgressCallback } from "../types/sse.js";
import { MAX_THEME_LENGTH } from "../config/theme-validation.js";
import { MIN_CHARACTER_AGE, MAX_CHARACTER_AGE } from "../config/story.js";
import type { DBPage } from "../types/schema.js";
import { isValidUuid } from "../utils/uuid.js";

const router = Router();

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
 * Supports search, language filtering, and sorting.
 * 
 * Enhanced search features:
 * - Searches across title, hook, summary, and keywords
 * - Language filter (ISO 639-1 codes: en, es, fr, etc.)
 * - Fuzzy matching for typo tolerance (enabled by default)
 * - Relevance scoring for search results
 * 
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of books per page (default: 10)
 * @query search - Search query for title, hook, summary, keywords
 * @query language - Filter by language code (e.g., "en", "es")
 * @query fuzzy - Enable fuzzy matching for typo tolerance (default: true)
 * @query sortBy - Field to sort by (default: updatedAt)
 * @query sortOrder - Sort direction (default: desc)
 * @returns Paginated list of user's books with progress
 * 
 * @todo
 * - do we need to migrate offset pagination into cursor pagination to support post-query sorting?
 * - enable fuzzy search with jaccard
 * - activate pg_trgm extension
 * - modify books indexes to use pg_trgm
 * - follow `BOOK_SEARCH_ENHANCEMENT_ROADMAP.md` roadmap docs
 * 
 * @example
 * // Search for thriller books
 * GET /api/books?search=thriller&fuzzy=true
 * 
 * // Filter by English language
 * GET /api/books?language=en
 * 
 * // Combined search with language filter
 * GET /api/books?search=mystery&language=en&fuzzy=true
 */
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder } = extractPaginationParams(req);
    const language = req.query.language as string | undefined;
    const fuzzy = req.query.fuzzy === 'false' ? false : true;
    const userId = req.userId!;
    
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
    
    // Skip caching for search queries (dynamic)
    const shouldCache = !search && !language;
    const cacheKey = CACHE_KEYS.USER_BOOKS(userId, page);
    
    // Fetch function for cache
    const fetchBooks = async () => {
      // Build search conditions using utility function
      const searchParams: SearchParams = {
        search: sanitizedSearch,
        language,
        fuzzy
      };
      
      const searchCondition = buildSearchConditions(searchParams, books);
      
      // Build complete condition upfront
      const baseCondition = eq(books.userId, userId);
      const finalCondition = searchCondition 
        ? and(baseCondition, searchCondition) 
        : baseCondition;

      // Build base query with enriched fields
      let query = dbRead
        .select({
          ...getEnrichedBookSelect(userId),
          lastReadAt: userSessions.updatedAt,
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
        .where(finalCondition);

      // Apply relevance scoring and sorting if search is enabled
      if (sanitizedSearch) {
        // Add relevance score to query for database-level sorting
        const relevanceExpression = createRelevanceExpression(sanitizedSearch, books);
        query = (query as any).addSelect({
          relevanceScore: relevanceExpression
        }).orderBy(desc(relevanceExpression));
      } else {
        // Apply regular sorting when no search
        query = applySorting(query, sortBy, sortOrder);
      }

      // Get total count for pagination
      const countResult = await dbRead
        .select({ count: sql`COUNT(*)::int` })
        .from(books)
        .where(finalCondition);

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

    // Handle array case for identifier (Express can return string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(identifierStr);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get enriched book data with author info and stats
    const enrichedBook = await getEnrichedBook(book.id, req.userId);

    res.json({ book: enrichedBook });
  } catch (error) {
    handleApiError(res, "Failed to retrieve book", error);
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
router.get("/:identifier/:pageId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId } = req.params;

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
        userId: pages.userId,
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
        stateDelta: pages.stateDelta,
        aiProvider: pages.aiProvider,
        aiModel: pages.aiModel,
        pendingGenerationCount: pages.pendingGenerationCount,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt
      })
      .from(pages)
      .where(
        and(
          eq(pages.bookId, book.id),
          eq(pages.branchId, pageId as string)
        )
      )
      .limit(1);

    if (!pageData.length) {
      return handleNotFoundError(res, "Page not found");
    }

    const page: DBPage = pageData[0];

    // Query user's chosen action for this page (if authenticated)
    let userChosenAction: Action | undefined;
    if (req.user) {
      const userProgress = await dbRead
        .select()
        .from(userPageProgress)
        .where(
          and(
            eq(userPageProgress.userId, req.user.id),
            eq(userPageProgress.pageId, page.id)
          )
        )
        .limit(1);
      
      if (userProgress.length > 0) {
        userChosenAction = userProgress[0].action;
      }
    }

    // Enrich actions with navigation metadata and filter out incomplete actions
    const allEnrichedActions = enrichActions(page.actions, page.page, userChosenAction);
    const visibleActions = allEnrichedActions.filter((action: EnrichedAction) => action.destination?.branchId && action.destination?.pageId);

    // Fire-and-forget retry of failed candidate generations if any actions are missing destinations
    // This provides immediate recovery when users visit pages with incomplete actions
    // TODO: Supports polling/SSE for real-time action availability updates
    // Pass pre-checked hasIncompleteActions to avoid double-enrichment
    if (req.userId && visibleActions.length < allEnrichedActions.length) {
      void triggerCandidateGenerationRetry(req.userId, page, userChosenAction, true);
    }

    // Handle translation if Accept-Language header is provided and differs from book language
    let translatedText: string | undefined;
    const acceptLanguage = req.headers['accept-language'] as string | undefined;
    const bookLanguage = book.language || 'en';
    
    const targetLanguage = shouldTranslate(bookLanguage, acceptLanguage);
    if (targetLanguage) {
      const translationResult = await getTranslatedText({
        pageId: page.id,
        text: page.text,
        bookLanguage,
        targetLanguage
      });
      
      if (translationResult.text) {
        translatedText = translationResult.text;
      }
      // If translation failed, translationResult.error contains error info
      // but we continue with original text (fallback behavior)
    }

    // Return enriched page with only frontend-relevant fields
    // Exclude backend-specific fields: userId, aiProvider, aiModel, pendingGenerationCount
    const enrichedPage: Partial<Omit<DBPage, 'actions'>> & { actions: EnrichedAction[], originalActionsCount: number, selectedAction?: Action, translatedText?: string } = {
      id: page.id,
      page: page.page,
      bookId: page.bookId,
      branchId: page.branchId,
      parentId: page.parentId,
      text: page.text,
      mood: page.mood,
      place: page.place,
      timeOfDay: page.timeOfDay,
      charactersPresent: page.charactersPresent,
      keyEvents: page.keyEvents,
      importantObjects: page.importantObjects,
      actions: visibleActions, // Only actions that has destination page
      selectedAction: userChosenAction,
      translatedText: translatedText,
      originalActionsCount: allEnrichedActions.length,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };

    res.json({
      page: enrichedPage,
      book
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve page", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/visit
 * 
 * Marks a page as visited by updating user session and page progress.
 * This is called when a user navigates to a page (not during pre-generation).
 * 
 * @param identifier - Book slug or UUID v7
 * @param branchId - Branch identifier
 * @param page - Page number
 * @param action - The action chosen to reach this page
 * @param previousPageId - The previous page ID
 * @returns Success confirmation
 */
router.post("/:identifier/:pageId/visit", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId } = req.params;
    const { action, previousPageId } = req.body;
    const userId = req.userId!;

    if (!action) return handleValidationError(res, "Missing required field: action is required");
    if (!previousPageId) return handleValidationError(res, "Missing required field: previousPageId is required");
    if (!isValidUuid(previousPageId)) return handleValidationError(res, "Invalid previousPageId: must be valid uuid");

    // Handle array case for identifier (Express can return string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(identifierStr);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Get the page by branch and page number to get the pageId and branchId
    const pageData = await dbRead
      .select({ id: pages.id, branchId: pages.branchId, page: pages.page })
      .from(pages)
      .where(
        and(
          eq(pages.bookId, book.id),
          eq(pages.branchId, pageId as string)
        )
      )
      .limit(1);

    if (!pageData.length) {
      return handleNotFoundError(res, "Page not found");
    }

    const pageBranchId = pageData[0].branchId;
    const pageNumber = pageData[0].page;

    // Validate that the action exists on the previous page
    const previousPageData = await dbRead
      .select({ actions: pages.actions })
      .from(pages)
      .where(eq(pages.id, previousPageId))
      .limit(1);

    if (!previousPageData.length) {
      return handleNotFoundError(res, "Previous page not found");
    }

    // TODO: except for premium user via custom action
    const isValidAction = previousPageData[0].actions.some((a: Action) => deepEqualSimple(a, action));
    if (!isValidAction) {
      return handleValidationError(res, "Invalid action: The provided action does not exist on the previous page");
    }

    // Validate user's action choice: check if user already chose a different action on previous page
    const previousPageProgress = await dbRead
      .select()
      .from(userPageProgress)
      .where(
        and(
          eq(userPageProgress.userId, userId),
          eq(userPageProgress.pageId, previousPageId)
        )
      )
      .limit(1);

    if (previousPageProgress.length > 0) {
      const previouslyChosenAction = previousPageProgress[0].action as Action;
      if (!deepEqualSimple(previouslyChosenAction, action)) {
        // TODO: except for premium user via chooose other action
        return res.status(400).json({
          error: "Choice made, can't make another choice",
          message: "You already chose a different action on this page"
        });
      }
    }

    // Mark page as visited and persists chosen action
    await markPageVisited(userId, book.id, pageId as string, previousPageId, action);

    // TODO: stats
    // - you're 2,000th visitor
    // - you're 2% of people ever seen this page

    res.json({ pageId, branchId: pageBranchId, page: pageNumber });
  } catch (error) {
    handleApiError(res, "Failed to mark page visited", error);
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
 * POST /api/books/:identifier/:pageId/candidates
 * 
 * Pre-generates candidate pages for all actions on a story page.
 * This ensures that when users select actions, the corresponding destination pages
 * are immediately available without waiting for AI generation.
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * @param id - Book ID
 * @param pageId - Page ID for which to generate candidates
 * @returns Updated page with pre-generated candidates
 * 
 * @example
 * POST /api/books/book123/page456/candidates
 * 
 * Response (200):
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
 */
router.post("/:identifier/:pageId/candidates", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId } = req.params;
    const userId = req.userId!;

    // Handle array case for identifier (Express can return string[])
    const identifierStr = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(identifierStr);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Validate
    if (!isValidUuid(pageId)) {
      return handleValidationError(res, "Invalid pageId: must be valid uuid");
    }

    // Get the page from database
    const pageResult = await dbRead
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);

    if (!pageResult.length) {
      return handleNotFoundError(res, "Page not found");
    }

    const dbPage = pageResult[0];

    // Verify page belongs to the specified book
    if (dbPage.bookId !== book.id) {
      return handleValidationError(res, "Page does not belong to the specified book");
    }

    // Convert to UserStoryPage
    const userPage = mapToUserStoryPage(dbPage);

    // Pre-generate candidates
    const updatedPage = await ensureCandidatesForPage(
      userId,
      userPage,
      null, // currentState - can be inferred if needed
      book // currentBook - used for totalPages check
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
    
    // Cache page 1 without search and tags
    // Trending uses shorter TTL (5 min) due to incremental updates, newest uses longer TTL (30 min)
    const shouldCache = page === 1 && !search && tags.length === 0;
    const cacheKey = normalizedSortBy === 'trending' ? CACHE_KEYS.EXPLORE_PAGE_1_TRENDING : CACHE_KEYS.EXPLORE_PAGE_1;
    const cacheTTL = normalizedSortBy === 'trending' ? CACHE_TTL.FIVE_MINUTES : CACHE_TTL.THIRTY_MINUTES;
    
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
      // TODO: fuzzy search using jaccard
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
      const httpCacheMaxAge = normalizedSortBy === 'trending' ? 300 : 1800; // 5 min for trending, 30 min for newest
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

    // Increment book likes count and trending score (atomic operation)
    // Note: No GREATEST protection needed on increments - only decrements can go negative
    const updatedBook = await dbWrite
      .update(books)
      .set({
        likesCount: sql`${books.likesCount} + 1`,
        trendingScore: sql`${books.trendingScore} + 0.3`, // Incremental update for hybrid approach
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string))
      .returning({ likesCount: books.likesCount });

    // Invalidate explore cache (likes changed)
    // Note: Cache invalidation after DB update is acceptable - window of stale data is minimal (milliseconds)
    await invalidateExploreCache();

    res.json({
      message: "Book liked successfully",
      liked: true,
      likesCount: updatedBook[0]?.likesCount ?? book[0].likesCount + 1
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

    // Decrement book likes count and trending score (atomic operation)
    const updatedBook = await dbWrite
      .update(books)
      .set({
        likesCount: sql`GREATEST(${books.likesCount} - 1, 0)`,
        trendingScore: sql`GREATEST(${books.trendingScore} - 0.3, 0)`, // Incremental update for hybrid approach
        updatedAt: new Date()
      })
      .where(eq(books.id, id as string))
      .returning({ likesCount: books.likesCount });

    // Invalidate explore cache (likes changed)
    // Note: Cache invalidation after DB update is acceptable - window of stale data is minimal (milliseconds)
    await invalidateExploreCache();

    res.json({
      message: "Book unliked successfully",
      liked: false,
      likesCount: updatedBook[0]?.likesCount ?? Math.max(0, book[0].likesCount - 1)
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

export default router;
