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
 * - GET /api/books/:identifier/:pageId/candidates - Pre-generate candidate pages via SSE (requires auth)
 * - GET /api/books/:identifier/:pageId/candidates/status - Poll candidate generation status (requires auth)
 * - POST /api/books/:identifier/:pageId/generate - Pre-generate candidate pages via github workflow (requires auth)
 * - GET /api/books/:id/similar - Get similar books by keyword Jaccard similarity (optional auth)
 * - POST /api/books/:id/like - Like a book (requires auth)
 * - DELETE /api/books/:id/like - Unlike a book (requires auth)
 * - POST /api/books/:id/favorite - Add book to favorites (requires auth)
 * - DELETE /api/books/:id/favorite - Remove book from favorites (requires auth)
 * - GET /api/books/:id/comments - Get book comments with pagination (optional auth)
 * - POST /api/books/:id/comments - Create comment on book (requires auth)
 * - DELETE /api/books/comments/:id - Delete comment on book (requires auth)
 * - GET /api/books/tags/popular - Get popular tags for filtering (no auth required)
 * - GET /api/books/stats - Get public book statistics (optional auth)
 * - GET /api/books/prompt - Generate book creation prompt via SSE (optional auth)
 * - POST /api/books/insert - Test route for direct book insertion (requires auth)
 * - DELETE /api/books/:id - Delete a book and queue image for deletion (requires auth)
 */

import type { Request, Response, Router as RouterType } from "express";
import { Router } from "express";
import { dbRead, dbWrite } from "../db/client.js";
import { optionalAuth, requireAuth } from "../middleware/nextauth.js";
import { books, deletedImages, users, userLikes, userFavorites, userComments, bookGenerations, userActionHints, userPurchasedBooks } from "../db/schema.js";
import { getErrorMessage, handleApiError, handleForbiddenError, handleNotFoundError, handleValidationError } from "../utils/error.js";
import { sanitizeTextForDB } from '../utils/text-processing.js';
import { eq, and, desc, sql, ne, arrayOverlaps } from "drizzle-orm";
import { generateBookCreationPromptStream } from "../utils/prompt.js";
import { getBookFromDB, getEnrichedBook, getPageFromDB, mapToEnrichedPage } from "../services/book.js";
import { shouldUseCache, getFreshPromptForUser, trackPromptView, savePromptToCache } from "../services/prompt-cache.js";
import { streamCachedPrompt } from "../utils/prompt-stream.js";
import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";
import { imageUpload, deleteFileFromImageKit } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { validateSearchQuery, validateLanguageCode, validateAgeRange, validateGender } from "../utils/search.js";
import type { ImageUploadSource } from "../types/image.js";
import { updateBook, insertBook, uploadBookCoverImage, resolveBook, getPublicBookStats, getPopularTags, mapToUserStoryPage } from "../services/book.js";
import { isValidBookSortOption, isValidLastUpdatedFilter } from "../utils/books.js";
import { getEnrichedBookSelect, getSimilarBookSelect, buildBookQuery, visitBookPage } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache, invalidatePopularTagsCache } from "../services/cache.js";
import type { BookCreationStatus, BookGenerationPayload, BookSortOption, EnrichedBookData } from "../types/book.js";
import { lastUpdatedFilterOptions } from "../types/book.js";
import { createBookCore, createBookValidate, handleBookCreationError, updateBookGenerationStatus } from "../services/book-creation.js";
import { executeWithCredits, refundCredits } from "../services/credits.js";
import { logUserActivity } from "../services/user.js";
import type { ProgressCallback } from "../types/sse.js";
import { generateId, isValidUuid } from "../utils/uuid.js";
import { getActionProgressEvents, clearActionProgressEvents } from "../utils/progress-tracking.js";
import type { DBNewBook, DBNewBookGeneration, DBUpdateBook } from "../types/schema.js";
import type { ActionProgressEvent, CandidateGenerationStatus } from "../types/candidate-generation.js";
import { GITHUB_REPO_CONFIG } from "../config/env.js";
import { initSSEHeaders, pollForCandidateGeneration, sendSSEEvent } from "../utils/sse.js";
import type { StoryMC } from "../types/character.js";
import { triggerCandidateGenerationWorkflow, validateAndRetrievePageForGeneration } from "../utils/candidate-generation.js";
import { SSE_POLLING_CONFIG } from "../config/candidate-generation.js";
import { getPsychologicalProfileResult } from "../services/psychological-profile.js";
import { getLockedPaths } from "../services/locked-paths.js";
import { runGate0, runGate1, buildCustomActionValidationPrompt, buildCanonicalAction, getRejectionMessage, CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION, CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS } from "../services/custom-actions.js";
import { CUSTOM_ACTION_CREDIT_COST } from "../config/custom-actions.js";
import { customActions } from "../db/schema.js";
import { getStoryStateFromPage } from "../services/story.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { createAIOptionsWithSchema, aiPrompt } from "../utils/ai-chat.js";
import { AI_CHAT_MODELS_THEME } from "../config/ai-clients.js";
import type { CustomActionValidationResult, CustomActionPreviewResponse, CustomActionSubmitResponse } from "../types/custom-action.js";
import type { AIPromptForJson } from "../types/ai-chat.js";
import { MAX_BRANCHING_PREGENERATION_DEPTH } from "../config/story.js";
import { CREDIT_COSTS } from "../config/credits.js";
import { CREDIT_ERRORS } from "../config/errors.js";
import { triggerBookGenerationWorkflow, isGenerationStale } from "../services/book-creation.js";
import { requireEnv } from "../utils/env.js";
import type { UserComment } from "../types/user.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { generateRandomCharacter } from "../utils/characters.js";

const router: RouterType = Router();

/**
 * POST /api/books
 *
 * Creates a new psychological thriller book with AI-generated content.
 * Accepts theme and main character candidate, initializes story with AI.
 * Returns complete book information with first page and initial state.
 *
 * **Authentication:** Required (via `requireAuth`)
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
    
    // Use shared core logic (without progress callback for synchronous response)
    const result = await createBookCore(
      {
        req,
        userId,
        theme,
        mcCandidate,
        generateCoverImage,
        context: "book_creation",
      },
      // No progress callback for POST endpoint (synchronous response)
    );

    res.status(201).json(result);
  } catch (error) {
    handleBookCreationError(res, error);
  }
});

/**
 * POST /api/books/workflow-webhook
 *
 * Internal webhook for GitHub Actions workflow to notify completion/failure.
 * Secured by `INTERNAL_SECRET` header: `x-internal-secret`.
 *
 * Body: { bookId: string, status?: BookGenerationStatus, error?: string, step: StoryGenerationStep }
 */
router.post('/workflow-webhook', async (req: Request, res: Response) => {
  try {
    const secret = req.get('x-internal-secret');
    if (!secret || secret !== process.env.INTERNAL_SECRET) {
      return handleForbiddenError(res, 'Invalid or missing internal secret');
    }

    const payload = req.body as BookGenerationPayload;
    await updateBookGenerationStatus(payload);

    res.json({ ok: true });
  } catch (error) {
    console.error('[POST /api/books/workflow-webhook] ❌ Error:', error);
    handleBookCreationError(res, error, "Failed to process workflow webhook");
  }
});

/**
 * POST /api/books/stream
 *
 * Creates a new psychological thriller book with AI-generated content using SSE.
 * Provides real-time progress updates for each step in the book creation process.
 *
 * **Authentication:** Required (via `requireAuth`)
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

    // Initialize SSE headers
    initSSEHeaders(res);

    // Create progress callback for SSE events
    const onProgress: ProgressCallback = (event) => {
      sendSSEEvent(res, event);
    };

    // Create book with progress events
    const result = await createBookCore(
      {
        req,
        userId,
        theme,
        mcCandidate,
        generateCoverImage,
        context: "book_creation_stream",
      },
      onProgress
    );

    // Send final complete event
    sendSSEEvent(res, { type: 'complete', data: result });

    // End response
    res.end();
  } catch (error) {
    // Send error event if response is still writable
    if (!res.writableEnded) {
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
 * POST /api/books/async
 * 
 * Creates a new book asynchronously using GitHub Actions.
 * Returns bookId immediately, bypassing Vercel's 5-minute timeout.
 * 
 * Flow:
 * 1. Validate request parameters
 * 2. Consume credits
 * 3. Generate bookId (UUID v7)
 * 4. Create book record with status 'pending'
 * 5. Trigger GitHub Actions workflow (unawaited)
 * 6. Return bookId immediately
 * 
 * Frontend should poll GET /api/books/:bookId/status for updates.
 * 
 * @param theme - Story theme (required)
 * @param mcCandidate - Main character candidate (optional)
 * @param generateCoverImage - Whether to generate cover image (optional)
 * 
 * @returns { bookId: string } - The generated book ID
 * 
 * @example
 * POST /api/books/async
 * Body: {
 *   "theme": "haunted mansion mystery",
 *   "mcCandidate": {
 *     "name": "Sarah",
 *     "age": 28,
 *     "gender": "female"
 *   },
 *   "generateCoverImage": true
 * }
 * 
 * Response (200):
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "message": "Book creation started. Poll /api/books/:bookId/status for updates."
 * }
 */
router.post("/async", requireAuth, async (req: Request, res: Response) => {
  try {
    const { theme: themeInput, mcCandidate: initialMCCandidate, generateCoverImage } = req.body;
    const userId = req.userId!;
    const theme = themeInput.trim();

    // STEP 1: VALIDATE THEME
    const { aiResult } = await createBookValidate(theme, initialMCCandidate, generateCoverImage, undefined);
    const { comment: aiComment, language, titleIdea, mcCandidate } = aiResult || {};

    // STEP 2: GENERATE BOOK ID
    const bookId = generateId();
    
    // STEP 3: DRAFTING INITIAL DATA
    const mc: StoryMC = generateRandomCharacter(mcCandidate);

    const initialBookData: DBNewBook = {
      id: bookId,
      userId,
      title: titleIdea || 'Generating...', // Temporary title
      hook: null,
      summary: null,
      keywords: [],
      language,
      totalPages: 0,
      mc,
      status: 'draft', // Will be updated to 'active' when complete
    };

    const initialBookGenerationData: DBNewBookGeneration = {
      bookId,
      userId,
      theme,
      language,
      titleIdea,
      aiComment,
      mcCandidate,
      generateCoverImage: generateCoverImage || false,
      generationStatus: 'pending',
      generationStep: 'theme_validation',
    };

    // STEP 4: CONSUME CREDITS IN TRANSACTION
    // Use unified transaction flow for atomic credit consumption
    await executeWithCredits(
      userId,
      "STORY_GENERATION",
      async (tx) => {
        // STEP 5: CREATE DRAFT BOOK RECORD
        // Credits consumed for the book creation operation
        // The actual book update happens in the cron job via initializeBook
        await tx.insert(books).values(initialBookData);
        await tx.insert(bookGenerations).values(initialBookGenerationData);
      },
      {
        context: "book_creation_async",
        metadata: { theme, bookId }
      }
    );

    // STEP 6: TRIGGER GITHUB ACTIONS WORKFLOW (UNAWAITED)
    // Use shared function for DRY and consistency
    triggerBookGenerationWorkflow(bookId, 'POST /api/books/async');

    // STEP 7: RETURN BOOK ID IMMEDIATELY
    res.json({
      bookId,
      message: "Book creation started. Poll /api/books/:bookId/status for updates."
    });

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'book_creation_started',
      targetType: 'book',
      targetId: bookId,
      metadata: { theme, method: 'async' }
    }, { req });
  } catch (error) {
    console.error('[POST /api/books/async] ❌ Failed to start book creation:', error);
    handleBookCreationError(res, error, "Failed to start book creation");
  }
});

/**
 * GET /api/books/:bookId/status
 * 
 * Polls for book creation status.
 * Used by frontend to check progress of async book creation.
 * 
 * @param bookId - Book ID (UUID v7)
 * 
 * @returns BookCreationStatus with current status and generation step
 * 
 * @example
 * GET /api/books/01912345-6789-1234-5678-123456789012/status
 * 
 * Response (200) - In Progress:
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "draft",
 *   "generationStatus": "in_progress",
 *   "generationStep": "generating",
 *   "generationStepDescription": "AI generation in progress: generating",
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:02:30.000Z",
 *   "generationStartedAt": "2026-05-12T10:00:05.000Z",
 *   "generationCompletedAt": null
 * }
 * 
 * Response (200) - Complete:
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "active",
 *   "generationStatus": "completed",
 *   "generationStep": "completed",
 *   "generationStepDescription": "Book generation completed",
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:05:00.000Z",
 *   "generationStartedAt": "2026-05-12T10:00:05.000Z",
 *   "generationCompletedAt": "2026-05-12T10:05:00.000Z"
 * }
 * 
 * Response (200) - Failed:
 * {
 *   "bookId": "01912345-6789-1234-5678-123456789012",
 *   "status": "draft",
 *   "generationStatus": "failed",
 *   "generationStep": null,
 *   "generationStepDescription": "Book generation failed",
 *   "error": "AI generation failed: timeout",
 *   "createdAt": "2026-05-12T10:00:00.000Z",
 *   "updatedAt": "2026-05-12T10:10:00.000Z"
 * }
 */
router.get("/:bookId/status", requireAuth, async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    const userId = req.userId!;

    // Validate bookId format
    if (!isValidUuid(bookId)) {
      return handleValidationError(res, "Invalid book ID format");
    }

    // Fetch book and generation data from both tables
    const [data] = await dbRead
      .select({
        // From books table
        bookId: books.id,
        bookUserId: books.userId,
        bookStatus: books.status,
        bookCreatedAt: books.createdAt,
        bookUpdatedAt: books.updatedAt,
        // From bookGenerations table
        generationStatus: bookGenerations.generationStatus,
        generationStep: bookGenerations.generationStep,
        generationError: bookGenerations.generationError,
        generationStartedAt: bookGenerations.generationStartedAt,
        generationCompletedAt: bookGenerations.generationCompletedAt,
        isGeneratingStartedAt: bookGenerations.isGeneratingStartedAt,
        isRefunded: bookGenerations.isRefunded,
        aiComment: bookGenerations.aiComment,
        createdAt: bookGenerations.createdAt,
      })
      .from(books)
      .leftJoin(bookGenerations, eq(books.id, bookGenerations.bookId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!data) {
      return handleNotFoundError(res, "Book not found");
    }

    // Verify user owns the book
    if (data.bookUserId !== userId) {
      return handleForbiddenError(res, "You can only view status for your own books");
    }

    // Check if generation is stale and trigger workflow if needed
    const isStale = isGenerationStale(data);
    if (isStale && !data.isRefunded && GITHUB_REPO_CONFIG.token) {
      console.log(`[GET /api/books/:bookId/status] 🔄 Stale generation detected for book ${bookId}, triggering workflow`);
      
      // Trigger workflow unawaited using shared function
      triggerBookGenerationWorkflow(bookId, 'GET /api/books/:bookId/status');
    }

    // Map generation status to current step description
    let generationStepDescription: string | undefined;
    
    switch (data.generationStatus) {
      case 'pending':
        generationStepDescription = 'Waiting for workflow to start';
        break;
      case 'in_progress':
        generationStepDescription = `AI generation in progress: ${data.generationStep || 'initializing'}`;
        break;
      case 'completed':
        generationStepDescription = 'Book generation completed';
        break;
      case 'failed':
        generationStepDescription = 'Book generation failed';
        break;
      default:
        generationStepDescription = undefined;
    }

    const status: BookCreationStatus = {
      bookId: data.bookId,
      status: data.bookStatus || 'draft',
      generationStatus: data.generationStatus || 'pending',
      generationStep: data.generationStep || 'theme_validation',
      generationStepDescription,
      generationStartedAt: data.generationStartedAt,
      generationCompletedAt: data.generationCompletedAt,
      aiComment: data.aiComment,
      error: data.generationError,
      createdAt: data.bookCreatedAt,
      updatedAt: data.bookUpdatedAt,
    };

    res.json(status);
  } catch (error) {
    console.error('[GET /api/books/:bookId/status] Error:', error);
    handleApiError(res, "Failed to get book status", error);
  }
});

/**
 * POST /api/books/:bookId/cancel
 * 
 * Cancels a pending or failed book generation and refunds credits.
 * Users can cancel book creation via the UI and get their credits back.
 * 
 * @route POST /api/books/:bookId/cancel
 * @authentication Required
 * @param bookId - Book ID (UUID v7)
 * @returns Success response with refund confirmation
 * 
 * @example
 * POST /api/books/01912345-6789-1234-5678-123456789012/cancel
 * 
 * Response (200):
 * {
 *   "success": true,
 *   "message": "Book generation cancelled and credits refunded"
 * }
 * 
 * Response (400) - Cannot cancel:
 * {
 *   "error": "Cannot cancel completed book"
 * }
 * 
 * Response (400) - Already refunded:
 * {
 *   "error": "Book generation already refunded"
 * }
 */
router.post("/:bookId/cancel", requireAuth, async (req: Request, res: Response) => {
  try {
    const { bookId } = req.params;
    const userId = req.userId!;

    // Validate bookId format
    if (!isValidUuid(bookId)) {
      return handleValidationError(res, "Invalid book ID format");
    }

    // Fetch book and generation data
    const bookData = await dbRead
      .select({
        bookUserId: books.userId,
        bookStatus: books.status,
        generationStatus: bookGenerations.generationStatus,
        isRefunded: bookGenerations.isRefunded,
      })
      .from(books)
      .leftJoin(bookGenerations, eq(books.id, bookGenerations.bookId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!bookData.length) {
      return handleNotFoundError(res, "Book not found");
    }

    const data = bookData[0];

    // Verify user owns the book
    if (data.bookUserId !== userId) {
      return handleForbiddenError(res, "You can only cancel your own books");
    }

    // Check if book can be cancelled
    if (data.bookStatus === 'active' || data.generationStatus === 'completed') {
      return res.status(400).json({ error: "Cannot cancel completed book" });
    }

    // Check if already refunded
    if (data.isRefunded) {
      return res.status(400).json({ error: "Book generation already refunded" });
    }

    // Update book generation status to cancelled using shared function
    await updateBookGenerationStatus({
      bookId,
      status: 'cancelled'
    });

    // Clear lock timestamp to allow retry if needed
    await dbWrite
      .update(bookGenerations)
      .set({ isGeneratingStartedAt: null })
      .where(eq(bookGenerations.bookId, bookId));

    // Refund credits
    try {
      await refundCredits(userId, "STORY_GENERATION", {
        context: "book_creation_cancelled",
        metadata: { bookId }
      });

      // Mark book as refunded in bookGenerations table
      await dbWrite
        .update(bookGenerations)
        .set({ isRefunded: new Date() })
        .where(eq(bookGenerations.bookId, bookId));

      console.log(`[POST /api/books/:bookId/cancel] ✅ Book ${bookId} cancelled and credits refunded for user ${userId}`);
    } catch (refundError) {
      console.error(`[POST /api/books/:bookId/cancel] ❌ Failed to refund credits for book ${bookId}:`, getErrorMessage(refundError));
      return res.status(500).json({ error: "Failed to refund credits" });
    }

    res.json({
      success: true,
      message: "Book generation cancelled and credits refunded"
    });
  } catch (error) {
    console.error('[POST /api/books/:bookId/cancel] Error:', error);
    handleApiError(res, "Failed to cancel book generation", error);
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
    const userId = req.userId || null;
    const language = req.headerLanguage || 'en';
    let promptContent: string | null = null;
    let promptId: string | null = null;

    // Check if cache should be used
    if (PROMPT_CACHE_CONFIG.enabled && await shouldUseCache()) {
      // Try to get fresh prompt from cache for authenticated users
      if (userId) {
        const cachedPrompt = await getFreshPromptForUser(userId, language);
        if (cachedPrompt) {
          promptContent = cachedPrompt.content;
          promptId = cachedPrompt.id;
        }
      }
      
      if (promptContent) {
        console.log('[GET /api/books/prompt] ✅ Serving from cache for user:', userId);
      } else {
        // If no user-specific prompt available, use weighted random selection
        // For now, fallback to AI generation if cache miss
        // TODO: could implement selectPromptByUsageWeight() here in future
        console.log('[GET /api/books/prompt] 🍪 Cache miss, generating via AI');
      }
    }

    // Generate via AI if cache not used or cache miss
    if (!promptContent) {
      const { stream, provider } = await generateBookCreationPromptStream({
        signal: abortController.signal,
        language,
        userId,
      });
      
      // Collect the full content from the stream
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        res.write(chunk);
      }
      
      // Combine chunks to get full content
      promptContent = Buffer.concat(chunks).toString('utf-8');
      
      // Validate and save to cache if quality is good
      if (PROMPT_CACHE_CONFIG.enabled && userId) {
        // Attempt to read provider/model used from the stream's metadata promise
        let aiProvider: AIChatProvider | 'none' = 'none';
        let aiModel: string | undefined = undefined;
        try {
          const used = await provider;
          if (used && used.provider && used.model) {
            aiProvider = used.provider;
            aiModel = used.model;
          }
        } catch {
          // ignore - fall back to 'none'
        }

        promptId = await savePromptToCache({
          content: promptContent,
          userId,
          language,
          aiProvider,
          aiModel
        });
      }
      
      res.end();
    } else {
      // Stream from cache with simulated typing effect
      const cacheStream = await streamCachedPrompt(promptContent);
      
      // Stream chunks to client
      for await (const chunk of cacheStream) {
        res.write(chunk);
      }
      
      res.end();
    }

    // Track prompt view if user is authenticated and we have a prompt ID
    if (userId && promptId) {
      try {
        await trackPromptView(userId, promptId);
      } catch (error) {
        console.error('[GET /api/books/prompt] ❌ Failed to track prompt view:', error);
      }
    }

  } catch (error) {
    console.error('[GET /api/books/prompt] ❌ Failed to generate story theme:', error);
    
    // Send SSE error event before closing
    if (!res.writableEnded) {
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
    const book = await insertBook({ ...bookData, userId });

    res.status(201).json({ book });
  } catch (error) {
    handleApiError(res, "Failed to insert book", error);
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
    const { title, hook, summary, keywords, imageUrl } = req.body;

    // Verify book ownership
    const [book] = await dbRead.select({ 
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

    if (!book) return handleNotFoundError(res, "Book not found");

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
    const updateData: DBUpdateBook = {
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
 * Retrieves similar books based on keyword tags similarity.
 * Uses PostgreSQL's native array operations to calculate similarity scores.
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
    if (!book) return handleNotFoundError(res, "Book not found");
    const targetKeywords = book.keywords;

    // Get similar books with enriched data
    const similarBooksSelect = getSimilarBookSelect(targetKeywords, currentUserId, req.headerLanguage);
    const similarBooks = await dbRead
      .select(similarBooksSelect)
      .from(books)
      .leftJoin(users, eq(books.userId, users.userId))
      .where(
        and(
          // Exclude the target book itself
          ne(books.id, book.id),
          // Only include active books
          eq(books.status, 'active'),
          // Avoid scanning unrelated books entirely (required)
          // sql`${books.keywords} && ${keywordsToTextArray(targetKeywords)}`
          arrayOverlaps(books.keywords, targetKeywords)
        )
      )
      .orderBy(
        desc(similarBooksSelect.similarityScoreExpr),
        desc(books.trendingScore)
      )
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
 * GET /api/books/explore
 * 
 * Retrieves books for exploration or user's own creations.
 * Supports both authenticated and unauthenticated users.
 * Includes search, filtering, and pagination capabilities.
 * 
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of books per page (default: 20)
 * @query search - Search query for title, hook, summary, keywords
 * @query language - Filter by language code (e.g., "en", "es")
 * @query tags - Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
 * @query sortBy - Field to sort by (default: newest). Options: newest, popular, trending, top-picks, originals, reads, recommendations, creations
 * @query sortOrder - Sort direction (default: desc)
 * @query lastUpdated - Filter by last update time: anytime|today|this-week|this-month|this-year
 * @query ageRange - Filter by main character age range (format: n-m, e.g., 18-30)
 * @query gender - Filter by main character gender (male/female)
 * @returns Paginated list of books
 * 
 * @remarks
 * - creations: Shows user's own created books (requires authentication)
 * - reads: Shows books the user has read, sorted by lastReadAt (requires authentication)
 * - recommendations: Recommends books based on user likes (requires authentication)
 * - All other options: Show published books (optional authentication)
 */
router.get("/explore", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder, lastUpdated, language, tags, ageRange, gender } = extractPaginationParams(req);
    const userId = req.userId || null;
    
    // Extract tags from query parameter (comma-separated)
    const tagsParam = tags as string;
    const tagsArray = tagsParam ? tagsParam.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : [];
    
    // Validate search query if provided
    let sanitizedSearch: string | undefined;
    if (search) {
      const validation = validateSearchQuery(search);
      if (!validation.isValid) {
        return handleValidationError(res, validation.error || 'Invalid search query');
      }
      sanitizedSearch = validation.sanitized;
    }

    // Validate language code if provided
    let sanitizedLanguage: string | undefined;
    if (language) {
      const langValidation = validateLanguageCode(language);
      if (!langValidation.isValid) {
        return handleValidationError(res, langValidation.error || 'Invalid language code');
      }
      sanitizedLanguage = langValidation.sanitized;
    }

    // Validate age range if provided
    let minAge: number | undefined;
    let maxAge: number | undefined;
    if (ageRange) {
      const ageValidation = validateAgeRange(ageRange);
      if (!ageValidation.isValid) {
        return handleValidationError(res, ageValidation.error || 'Invalid age range');
      }
      minAge = ageValidation.minAge;
      maxAge = ageValidation.maxAge;
    }

    // Validate gender if provided
    let sanitizedGender: string | undefined;
    if (gender) {
      const genderValidation = validateGender(gender);
      if (!genderValidation.isValid) {
        return handleValidationError(res, genderValidation.error || 'Invalid gender');
      }
      sanitizedGender = genderValidation.sanitized;
    }

    // Validate lastUpdated filter if provided
    if (lastUpdated && !isValidLastUpdatedFilter(lastUpdated)) {
      return handleValidationError(res, `Invalid lastUpdated value. Must be: ${lastUpdatedFilterOptions.join(', ')}`);
    }
    
    // Validate and normalize sortBy parameter
    const bookSortBy: BookSortOption = isValidBookSortOption(sortBy || '')
      ? (sortBy as BookSortOption)
      : 'newest';

    // Check if authentication is required for this sort option
    const requiresAuth = ['creations', 'reads', 'recommendations'].includes(bookSortBy);
    if (requiresAuth && !userId) {
      const emptyBooks: EnrichedBookData[] = [];
      const pagination = calculatePaginationMeta(page, limit, 0);
      return res.json(createPaginatedResponse(emptyBooks, pagination, 'books'));
    }

    // Determine base condition based on sort option
    const isCreations = bookSortBy === 'creations';
    const baseCondition = isCreations
      ? eq(books.userId, userId!) // User's own books (userId is guaranteed to be non-null when isCreations is true)
      : eq(books.status, 'active'); // Published books

    // Cache strategy: don't cache user-specific queries
    const shouldCache = page === 1 && !isCreations && !search && tagsArray.length === 0 && !language && !lastUpdated && !ageRange && !gender && bookSortBy !== 'reads' && bookSortBy !== 'recommendations';
    const cacheKey = isCreations
      ? `books:user:${userId}:page:${page}`
      : bookSortBy === 'trending'
      ? CACHE_KEYS.EXPLORE_PAGE_1_TRENDING
      : CACHE_KEYS.EXPLORE_PAGE_1;
    const cacheTTL = bookSortBy === 'trending'
      ? CACHE_TTL.EXPLORE_PAGE_1_TRENDING
      : CACHE_TTL.EXPLORE_PAGE_1;

    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      const baseQuery = dbRead
        .select(getEnrichedBookSelect(userId, req.headerLanguage))
        .from(books)
        .leftJoin(users, eq(books.userId, users.userId));

      // Build comprehensive query using shared helper
      const { query, countQuery } = buildBookQuery<typeof baseQuery>({
        baseQuery,
        baseCondition,
        search: sanitizedSearch,
        bookSortBy, // Primary: book-specific sorting
        genericSortBy: sortBy, // Secondary: generic fallback (when no search)
        sortOrder,
        tags: tagsArray,
        language: sanitizedLanguage,
        lastUpdated,
        minAge,
        maxAge,
        gender: sanitizedGender,
        currentUserId: userId // Pass userId for user-specific sorting (reads, recommendations)
      });

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
      ? await withCache(cacheKey, fetchBooks, cacheTTL)
      : await fetchBooks();

    // Add HTTP cache headers for CDN/edge caching (works alongside Redis)
    if (shouldCache) {
      const httpCacheMaxAge = cacheTTL; // 5 min for trending, 30 min for newest
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
    // TODO: kayanya gaperlu redis
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
 * Accessible to both authenticated and unauthenticated users.
 * 
 * @returns Object containing storiesCreated, branchesExplored, pagesCrafted, and shadowsWeaved
 * 
 * @example
 * GET /api/books/stats
 * 
 * Response:
 * {
 *   "storiesCreated": 1234,
 *   "branchesExplored": 5678,
 *   "pagesCrafted": 9012,
 *   "shadowsWeaved": 345
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
 * Optionally adds the book to favorites with a collection name if provided.
 * 
 * @param id - Book ID to like
 * @body {string} [collection] - Optional collection name to add book to favorites
 * @returns Success message with updated like status
 * 
 * @example
 * POST /api/books/book123/like
 * Body: { "collection": "Thriller" }
 * 
 * Response (200):
 * {
 *   "message": "Book liked successfully",
 *   "liked": true,
 *   "likesCount": 42,
 *   "favorited": true,
 *   "collection": "Thriller"
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
    const { collection } = req.body;

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

      // Add to favorites if collection is provided
      let favorited = false;
      if (collection) {
        // Check if already in favorites (upsert logic)
        const existingFavorite = await tx
          .select()
          .from(userFavorites)
          .where(and(
            eq(userFavorites.userId, userId),
            eq(userFavorites.bookId, id as string)
          ))
          .limit(1);

        if (existingFavorite.length === 0) {
          await tx
            .insert(userFavorites)
            .values({
              userId,
              bookId: id as string,
              collection,
              createdAt: new Date(),
            });
          favorited = true;
        } else {
          // Update collection if already favorited
          await tx
            .update(userFavorites)
            .set({ collection })
            .where(and(
              eq(userFavorites.userId, userId),
              eq(userFavorites.bookId, id as string)
            ));
          favorited = true;
        }
      }

      return {
        alreadyLiked: false,
        likesCount: updatedBook[0]?.likesCount,
        favorited,
        collection: favorited ? collection : null
      };
    });

    // Invalidate explore cache after successful transaction
    await invalidateExploreCache();

    // Invalidate user profile cache if book was added to favorites (savedBooksCount changed)
    if (result.favorited) {
      await invalidateUserProfileCache(userId);
    }

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
      likesCount: result.likesCount!,
      ...(result.favorited && {
        favorited: true,
        collection: result.collection
      })
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
      } satisfies Record<keyof UserComment, unknown>)
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
 *   "comment": {
 *     "id": "comment123",
 *     "userId": "user456",
 *     "userName": "John Doe",
 *     "userImage": "https://example.com/avatar.jpg",
 *     "bookId": "book123",
 *     "parentCommentId": null,
 *     "content": "This story is amazing!",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
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
      const [parentComment] = await dbRead
        .select({ id: userComments.id, bookId: userComments.bookId })
        .from(userComments)
        .where(eq(userComments.id, parentCommentId))
        .limit(1);

      if (!parentComment) {
        return handleNotFoundError(res, "Parent comment not found");
      }

      if (parentComment.bookId !== id) {
        return handleValidationError(res, "Parent comment does not belong to this book");
      }
    }

    // Sanitize content for DB and safety
    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return handleValidationError(res, 'Content is required and cannot be empty after sanitization');
    }

    // Create comment and fetch user info in a single transaction to ensure consistency
    const commentWithUser = await dbWrite.transaction(async (tx) => {
      const [newComment] = await tx.insert(userComments).values({
        userId,
        bookId: id as string,
        parentCommentId: parentCommentId || null,
        content: cleanContent,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      const [joined] = await tx
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
        } satisfies Record<keyof UserComment, unknown>)
        .from(userComments)
        .leftJoin(users, eq(userComments.userId, users.userId))
        .where(eq(userComments.id, newComment.id))
        .limit(1);

      return joined;
    });

    res.status(201).json({ comment: commentWithUser });
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
      return handleForbiddenError(res, "You can only delete your own comments");
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

    const enrichedBook = await getEnrichedBook(bookIdentifier, req.userId, req.headerLanguage);
    if (!enrichedBook) return handleNotFoundError(res, "Book not found");

    // Generate ETag from updatedAt + userId (user-specific columns: isLiked, isRead, lastReadAt, lastPage)
    const lastModified = enrichedBook.updatedAt;
    const etagInput = `${lastModified.getTime()}-${req.userId || 'anonymous'}`;
    const etag = `"${etagInput}"`;

    // Check If-None-Match header (ETag includes userId for user-specific data)
    if (req.get('If-None-Match') === etag) return res.status(304).end();

    // Set caching headers
    res.set('Last-Modified', lastModified.toUTCString());
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes

    res.json({ book: enrichedBook });
  } catch (error) {
    handleApiError(res, "Failed to retrieve book", error);
  }
});

/**
 * GET /api/books/:identifier/:pageId
 * 
 * Retrieves a specific page within a book.
 * Accepts both slug and UUID v7 as book identifier.
 * 
 * Supports translation via Accept-Language header. If the requested language
 * differs from the book's language, the page text will be translated and cached.
 * 
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page identifier (e.g., "main", "abc123")
 * @header Accept-Language - Desired language code (e.g., "en", "es", "fr")
 * @returns Page with actions and book metadata
 */
router.get("/:identifier/:pageId", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { headerLanguage } = req;
    const { identifier, pageId } = req.params;
    const { prefetch, translate: shouldTranslate, credits, actioning } = req.query;
    const userId = req.userId;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier; // Book slug or id (uuid v7)
    const skipVisit = !userId || prefetch === 'true' || req.method === 'HEAD'; // Skip for non-actual user navigation
    const translate = shouldTranslate === 'true'; // Should translate to Accept-Language header
    const consumeCredits = credits === 'true'; // Should consume credits
    const takeAction = !!userId && actioning === 'true'; // Should insert to user page progress

    const { visitDetails, book, dbPage, sourceAction, isUserTakeAction } = await visitBookPage({
      userId,
      pageId: pageId as string,
      bookIdentifier,
      skipVisit,
      takeAction,
      consumeCredits,
      language: headerLanguage
    }, { req, res });

    // Response already sent by `visitBookPage` internally
    if (!dbPage || !book) return;

    // Return enriched page with only frontend-relevant fields
    // Handle translation if Accept-Language header is provided and differs from book language
    const page = await mapToEnrichedPage(dbPage, {
      userId,
      book,
      headerLanguage,
      translate,
      sourceAction,
      isUserTakeAction
    });

    if (!page) return handleApiError(res, "Failed to get enriched page");

    // Generate ETag from page updatedAt + userId + translation params (different content per user/language)
    const lastModified = dbPage.updatedAt;
    const etagInput = `${lastModified.getTime()}-${userId}-${translate}-${headerLanguage || 'en'}`;
    const etag = `"${etagInput}"`;

    // Check If-None-Match header (ETag includes translation params)
    if (req.get('If-None-Match') === etag) return res.status(304).end();

    // Set caching headers
    res.set('Last-Modified', lastModified.toUTCString());
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=60'); // 1 minute (pages update more frequently)

    res.json({
      page,
      book,
      visitDetails
    });
  } catch (error) {
    handleApiError(res, "Failed to retrieve page", error);
  }
});

/**
 * GET /api/books/:identifier/:pageId/candidates
 * 
 * Pre-generates candidate pages for all actions on a story page.
 * This ensures that when users select actions, the corresponding destination pages
 * are immediately available without waiting for AI generation.
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * **Response Format:** Always uses Server-Sent Events (SSE)
 * 
 * This endpoint always returns SSE responses for consistency:
 * - If generation is already in progress (isGeneratingStartedAt is set): Polls for completion
 * - If generation is not in progress: Triggers background generation, then polls for completion
 * - If no actions need generation: Sends SSE complete event immediately
 * 
 * This approach prevents expensive AI generation from running multiple times for
 * the same (bookId + pageId) combination and provides a consistent response format.
 * 
 * Known Issue (in Vercel hobby tier):
 * SSE connections on Vercel hobby are subject to the same 5-min maxDuration limit
 * 
 * @param id - Book ID
 * @param pageId - Page ID for which to generate candidates
 * @returns Updated page with pre-generated candidates (via SSE)
 * 
 * @example
 * GET /api/books/book123/page456/candidates
 * 
 * Response (200) - SSE format:
 * event: progress
 * data: {"status": "waiting", "message": "Candidate generation in progress..."}
 * 
 * event: complete
 * data: {"id": "page456", "page": 5, "text": "...", "actions": [...]}
 */
router.get("/:identifier/:pageId/candidates", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId } = req.params;
    const userId = req.userId!;

    // Handle array case for identifier and pageId
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;

    if (!isValidUuid(pageIdStr)) {
      return handleValidationError(res, "Invalid pageId: must be valid uuid");
    }

    // Use common validation and page retrieval
    const validationResult = await validateAndRetrievePageForGeneration(bookIdentifier, pageIdStr, userId);
    if (!validationResult) {
      return handleNotFoundError(res, "Page not found");
    }

    const { dbBook, dbPage, userPage, isGenerating, isDone } = validationResult;

    // Always set SSE headers first for consistent response format
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Check if some actions need generation
    if (isDone) {
      console.log(`[GET /candidates] ℹ️ No actions need generation for page ${pageIdStr}, sending SSE complete event`);
      try {
        if (!res.writableEnded) {
          res.write(`event: complete\n`);
          res.write(`data: ${JSON.stringify(userPage)}\n\n`);
          res.end();
        }
        // Clear all progress events in database since generation is complete
        await clearActionProgressEvents(pageIdStr);
      } catch {
        if (!res.writableEnded) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ error: 'Failed to process page data' })}\n\n`);
          res.end();
        }
      }
      return;
    }

    // Trigger background generation via GitHub workflow if not already in progress
    if (!isGenerating) {
      triggerCandidateGenerationWorkflow({
        bookTitle: dbBook.title,
        bookId: dbPage.bookId,
        pageId: pageIdStr,
        userId,
        maxDepth: MAX_BRANCHING_PREGENERATION_DEPTH, // Also pre-generate next-level depths
        context: 'GET /candidates'
      }).catch(error => {
        console.error(`[GET /candidates] ❌ Failed to trigger GitHub workflow:`, error);
      });
    } else {
      console.log(`[GET /candidates] 🛬 Generation in progress for page ${pageIdStr}, using SSE to wait (started at ${dbPage.isGeneratingStartedAt})`);
    }

    // Determine if generation is already in progress
    const initialMessage = isGenerating 
      ? 'Candidate generation in progress...' 
      : 'Candidate generation started...';

    // Use shared polling function
    await pollForCandidateGeneration({
      pageId: pageIdStr,
      userId,
      req,
      res,
      initialMessage,
      getPageFromDB: (pid) => getPageFromDB(pid, { client: dbWrite }),
      mapToUserStoryPage,
      getActionProgressEvents,
      clearActionProgressEvents,
      config: SSE_POLLING_CONFIG,
    });
  } catch (error) {
    handleApiError(res, "Failed to generate candidates", error);
  }
});

/**
 * GET /api/books/:identifier/:pageId/candidates/status
 * 
 * Polling endpoint for candidate generation status
 * 
 * Returns current generation status without SSE overhead.
 * Designed for short-lived polling requests (no timeout risk).
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * Response:
 * {
 *   isGenerating: boolean;
 *   completedActions: number;
 *   totalActions: number;
 *   actions: Action[];
 *   actionProgress: ActionProgressEvent[];
 *   startedAt?: string;
 *   lastUpdated?: string;
 * }
 * 
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page ID for which to check status
 * @returns Generation status (JSON)
 * 
 * @example
 * GET /api/books/book123/page456/candidates/status
 * 
 * Response (200):
 * {
 *   "isGenerating": true,
 *   "completedActions": 2,
 *   "totalActions": 4,
 *   "actions": [...],
 *   "actionProgress": [...],
 *   "startedAt": "2024-01-01T00:00:00Z",
 *   "lastUpdated": "2024-01-01T00:00:10Z"
 * }
 */
router.get("/:identifier/:pageId/candidates/status", optionalAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req;
    const { identifier, pageId } = req.params;

    // Handle array case for identifier and pageId
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;

    if (!isValidUuid(pageIdStr)) {
      return handleValidationError(res, "Invalid pageId: must be valid uuid");
    }

    // Use common validation and page retrieval
    const validationResult = await validateAndRetrievePageForGeneration(bookIdentifier, pageIdStr, userId);
    if (!validationResult) {
      return handleNotFoundError(res, "Page not found");
    }

    const { dbBook, dbPage, userPage, isGenerating, isDone } = validationResult;
    const { actions, updatedAt } = userPage;

    // Calculate completed/total from page actions (SSOT)
    const actionsWithDestinations = actions.filter(a => a.destinationPageIds?.length);
    const completedActions = actionsWithDestinations.length;
    const totalActions = actions.length;
    const progressEventFallback = actions.map((action) => {
      const hasDestination = !!action.destinationPageIds?.length;
      return {
        action: action.text,
        status: hasDestination ? 'completed' : 'started',
        timestamp: new Date().toISOString(),
        destinationPageIds: hasDestination ? action.destinationPageIds : undefined,
      } satisfies ActionProgressEvent;
    });

    // Check if generation is in progress (using timestamp field)
    if (isGenerating) {
      // Generation in progress - return current status
      // Check for progress events in database
      const progressEvents = await getActionProgressEvents(pageIdStr);
      const startedAt = dbPage.isGeneratingStartedAt!.toISOString();

      const actionProgress: ActionProgressEvent[] = progressEvents.length > 0
        // Include all progress events for per-action status
        ? progressEvents
        // Fallback: generate synthetic progress events for actions
        : progressEventFallback;

      const response: CandidateGenerationStatus = {
        isGenerating: true,
        completedActions,
        totalActions,
        actions: actionsWithDestinations, // Current completed actions, this should be already correct
        actionProgress, // Include per-action progress events
        startedAt,
        lastUpdated: new Date().toISOString(),
      };

      console.log(`[GET /candidates/status] ⏰ Generation in progress for page ${pageIdStr}: ${completedActions}/${totalActions} actions completed`);
      return res.json(response);
    }

    // Generation not in progress - check if actions are complete
    if (isDone) {
      // All actions complete, clear progress events and return full data
      console.log(`[GET /candidates/status] ✅ Generation complete for page ${pageIdStr} - all actions completed`);
      void clearActionProgressEvents(pageIdStr);

      return res.json({
        isGenerating: false,
        completedActions: actions.length,
        totalActions: actions.length,
        actions,
        actionProgress: progressEventFallback,
        startedAt: undefined,
        lastUpdated: updatedAt.toISOString(),
      } satisfies CandidateGenerationStatus);
    }
    
    // Actions incomplete, trigger background generation via GitHub workflow
    console.log(`[GET /candidates/status] ⏳ Generation incomplete for page ${pageIdStr}: ${completedActions}/${actions.length} actions completed`);
    
    // Trigger workflow and wait for result to ensure it actually starts
    const workflowResult = await triggerCandidateGenerationWorkflow({
      bookTitle: dbBook.title,
      bookId: dbPage.bookId,
      pageId: pageIdStr,
      userId: userId ?? requireEnv("SYSTEM_USER_ID"), // Use system user ID for unauthenticated requests
      maxDepth: MAX_BRANCHING_PREGENERATION_DEPTH, // Also pre-generate next-level depths
      context: 'GET /candidates/status',
    });

    // If workflow trigger failed, log error and inform client
    if (!workflowResult.success && !workflowResult.alreadyInProgress) {
      console.error(`[GET /candidates/status] ❌ Failed to trigger GitHub workflow for page ${pageIdStr}:`, workflowResult.error);
      // Return error response to client so they can retry
      return res.status(503).json({
        error: 'Failed to trigger generation workflow',
        details: workflowResult.error,
        isGenerating: false,
      });
    }

    return res.json({
      isGenerating: true,
      completedActions,
      totalActions,
      actions: actionsWithDestinations, // Current completed actions, this should be already correct
      actionProgress: progressEventFallback,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    } satisfies CandidateGenerationStatus);

  } catch (error) {
    handleApiError(res, "Failed to get candidate status", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/actions/hint
 * 
 * Purchases an action hint for a specific action on a page
 * 
 * Consumes 1 credit to reveal additional information about an action.
 * Users can purchase hints for actions they haven't selected yet.
 * 
 * @route POST /api/books/:identifier/:pageId/actions/hint
 * @authentication Required
 * @param identifier - Book slug or ID
 * @param pageId - Page ID
 * @body actionText - Action text to purchase hint for
 * @returns Success response with purchased hint info
 * 
 * @example
 * POST /api/books/the-haunting/page123/actions/hint
 * Body: { "actionText": "Investigate the noise" }
 * 
 * Response:
 * {
 *   "success": true,
 *   "actionText": "Investigate the noise",
 *   "alreadyPurchased": false
 * }
 */
router.post("/:identifier/:pageId/actions/hint", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId: pageIdParam } = req.params;
    const { actionText } = req.body;
    const userId = req.userId!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate actionText parameter
    if (!actionText || typeof actionText !== 'string') {
      return handleValidationError(res, "actionText is required");
    }

    // Validate that the page exists and belongs to the book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return handleNotFoundError(res, "Page not found");
    }

    // Verify the book identifier matches
    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return handleNotFoundError(res, "Book not found or page does not belong to this book");
    }

    // Validate that the action exists on the page
    const actionExists = dbPage.actions.some(action => action.text === actionText);
    if (!actionExists) {
      return handleValidationError(res, "Action not found on this page");
    }

    // Check if user already purchased this hint
    const existingHint = await dbRead
      .select()
      .from(userActionHints)
      .where(and(
        eq(userActionHints.userId, userId),
        eq(userActionHints.pageId, pageId),
        eq(userActionHints.actionText, actionText)
      ))
      .limit(1);

    if (existingHint.length > 0) {
      return res.json({
        success: true,
        actionText,
        alreadyPurchased: true,
        message: "You have already purchased this hint"
      });
    }

    // Consume credits and insert hint record in a single transaction
    // Note: executeWithCredits handles automatic refund if the operation fails
    await executeWithCredits(
      userId,
      "SHOW_ACTION_HINT",
      async (tx) => {
        // Insert the action hint record
        await tx.insert(userActionHints).values({
          userId,
          pageId,
          actionText,
          createdAt: new Date()
        });
      },
      {
        context: "action_hint_purchase",
        metadata: { bookId: book.id, pageId, actionText }
      }
    );

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'credits_consumed',
      targetType: 'action',
      targetId: pageId,
      metadata: { actionText, bookId: book.id }
    }, { req });

    // // Get updated user credit balance
    // const userResult = await dbRead
    //   .select({ credits: users.credits })
    //   .from(users)
    //   .where(eq(users.userId, userId))
    //   .limit(1);

    // const creditsRemaining = userResult[0]?.credits || 0;

    console.log(`[POST /actions/hint] ✅ User ${userId} purchased hint for action "${actionText}" on page ${pageId}`);

    return res.json({
      success: true,
      actionText,
      alreadyPurchased: false,
      // creditsRemaining
    });

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    
    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return res.status(402).json({
        error: "Insufficient credits",
        message: `You need at least ${CREDIT_COSTS.SHOW_ACTION_HINT} credit to purchase an action hint`
      });
    }

    handleApiError(res, "Failed to purchase action hint", error);
  }
});

/**
 * POST /api/books/:identifier/purchase
 * 
 * Purchases a paid book with credits
 * 
 * Consumes credits equal to the book's creditsPrice to unlock access to the book.
 * Users can purchase books that have a creditsPrice set.
 * 
 * @route POST /api/books/:identifier/purchase
 * @authentication Required
 * @param identifier - Book slug or ID
 * @returns Success response with purchased book info
 * 
 * @example
 * POST /api/books/the-haunting/purchase
 * 
 * Response:
 * {
 *   "success": true,
 *   "bookId": "book123",
 *   "creditsPrice": 50,
 *   "alreadyPurchased": false
 * }
 */
router.post("/:identifier/purchase", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const userId = req.userId!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    // Validate that the book exists
    const dbBook = await getBookFromDB(bookIdentifier);
    if (!dbBook) {
      return handleNotFoundError(res, "Book not found");
    }

    // Validate that the book has a creditsPrice (is a paid book)
    if (!dbBook.creditsPrice || dbBook.creditsPrice <= 0) {
      return handleValidationError(res, "This book is not available for purchase");
    }

    // Check if user already purchased this book
    const existingPurchase = await dbRead
      .select()
      .from(userPurchasedBooks)
      .where(and(
        eq(userPurchasedBooks.userId, userId),
        eq(userPurchasedBooks.bookId, dbBook.id)
      ))
      .limit(1);

    if (existingPurchase.length > 0) {
      return res.json({
        success: true,
        bookId: dbBook.id,
        creditsPrice: dbBook.creditsPrice,
        alreadyPurchased: true,
        message: "You have already purchased this book"
      });
    }

    // Consume credits and insert purchase record in a single transaction
    // Note: executeWithCredits handles automatic refund if the operation fails
    await executeWithCredits(
      userId,
      dbBook.creditsPrice!,
      async (tx) => {
        // Insert the book purchase record
        await tx.insert(userPurchasedBooks).values({
          userId,
          bookId: dbBook.id,
          creditsPrice: dbBook.creditsPrice!, // Non-null assertion: validated above
          createdAt: new Date()
        });
      },
      {
        context: "book_purchase",
        metadata: { bookId: dbBook.id, creditsPrice: dbBook.creditsPrice! },
      }
    );

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'credits_consumed',
      targetType: 'book',
      targetId: dbBook.id,
      metadata: { creditsPrice: dbBook.creditsPrice }
    }, { req });

    console.log(`[POST /purchase] ✅ User ${userId} purchased book "${dbBook.title}" for ${dbBook.creditsPrice} credits`);

    return res.json({
      success: true,
      bookId: dbBook.id,
      creditsPrice: dbBook.creditsPrice,
      alreadyPurchased: false,
    });

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    
    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return res.status(402).json({
        error: "Insufficient credits",
        message: "You need more credits to purchase this book"
      });
    }

    handleApiError(res, "Failed to purchase book", error);
  }
});

/**
 * GET /api/books/:identifier/psychological-profile
 *
 * Returns the post-ending "psychological autopsy" — who the MC became,
 * the ending they reached, and teasers for what they didn't trigger.
 *
 * Uses the final page's story state to derive the profile and ending
 * recommendation. No AI calls: purely templated from already-computed data.
 *
 * **Authentication:** Required (via `requireAuth`)
 *
 * @param identifier - Book slug or UUID
 * @returns Psychological profile result with missed-ending teasers
 *
 * @example
 * GET /api/books/the-haunting/psychological-profile
 *
 * Response (200):
 * {
 *   "archetype": "the_paranoid",
 *   "stability": "cracking",
 *   "dominantTraits": ["fearful", "suspicious", "cautious"],
 *   "manipulationAffinity": "fear",
 *   "ending": {
 *     "type": "false_reality",
 *     "summary": "Paranoia pays off: the world actually isn't real."
 *   },
 *   "missedTeasers": [
 *     {
 *       "archetype": "the_explorer",
 *       "trigger": "you let fear close your eyes",
 *       "wouldHaveEnded": "loop",
 *       "teaser": "If you'd trusted just once, you'd have uncovered the truth beneath the lies."
 *     }
 *   ]
 * }
 */
router.get("/:identifier/psychological-profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const userId = req.userId!;

    // Fetch the book to verify ownership/access
    const book = await resolveBook(bookIdentifier);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Only the book owner can view the psychological profile
    if (book.userId !== userId) {
      return handleForbiddenError(res, "You do not have access to this book's psychological profile");
    }

    const result = await getPsychologicalProfileResult(book.id);
    if (!result) {
      return handleNotFoundError(res, "No psychological profile data found for this book");
    }

    return res.json(result);
  } catch (error) {
    console.error("[GET /psychological-profile] ❌ Error:", error);
    handleApiError(res, "Failed to get psychological profile", error);
  }
});

/**
 * GET /api/books/:identifier/locked-paths
 *
 * Returns a timeline of places, connections, and threads that became
 * permanently locked or closed during the story — the "paths not taken."
 *
 * Scans story state history to detect when:
 * - Place connections became blocked/destroyed/restricted
 * - Story threads were closed/resolved
 *
 * **Authentication:** Required (via `requireAuth`)
 *
 * @param identifier - Book slug or UUID
 * @returns Array of locked path events, sorted by page
 *
 * @example
 * GET /api/books/the-haunting/locked-paths
 *
 * Response (200):
 * {
 *   "lockedPaths": [
 *     {
 *       "kind": "place_connection",
 *       "label": "Abandoned Station → Underground Tunnel",
 *       "restriction": "Route blocked",
 *       "page": 12,
 *       "context": "The route between Abandoned Station and Underground Tunnel is now blocked."
 *     },
 *     {
 *       "kind": "thread",
 *       "label": "Who left the footsteps?",
 *       "restriction": "Closed",
 *       "page": 18,
 *       "context": "The thread \"Who left the footsteps?\" is now closed."
 *     }
 *   ]
 * }
 */
router.get("/:identifier/locked-paths", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const userId = req.userId!;

    const book = await resolveBook(bookIdentifier);
    if (!book) {
      return handleNotFoundError(res, "Book not found");
    }

    // Only the book owner can view locked paths
    if (book.userId !== userId) {
      return handleForbiddenError(res, "You do not have access to this book's locked path data");
    }

    const lockedPaths = await getLockedPaths(book.id);
    return res.json({ lockedPaths });
  } catch (error) {
    console.error("[GET /locked-paths] ❌ Error:", error);
    handleApiError(res, "Failed to get locked paths", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/custom-actions/preview
 *
 * Preview a custom action without charging credits.
 * Runs Gate 0 (eligibility, no charge) + Gate 1 (security) + Gate 2 (AI interpreter).
 *
 * **Authentication:** Required (via `requireAuth`)
 *
 * @param identifier - Book slug or UUID
 * @param pageId - Current page ID
 * @body text - Custom action text (3-60 chars)
 *
 * @example
 * POST /api/books/the-haunting/page123/custom-actions/preview
 * Body: { "text": "I try to pick the lock with my hairpin" }
 *
 * Response (200) - Allowed:
 * {
 *   "outcome": "allow",
 *   "preview": {
 *     "canonicalIntent": "attempt lockpicking escape",
 *     "cost": 3
 *   }
 * }
 *
 * Response (200) - Rejected:
 * {
 *   "outcome": "reject",
 *   "message": "That doesn't match what's true in this story so far."
 * }
 */
router.post("/:identifier/:pageId/custom-actions/preview", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId: pageIdParam } = req.params;
    const { text } = req.body;
    const userId = req.userId!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate input
    if (!text || typeof text !== 'string') {
      return handleValidationError(res, "text is required");
    }

    // Validate pageId format
    if (!isValidUuid(pageId)) {
      return handleValidationError(res, "Invalid pageId format");
    }

    // Fetch the page and book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return handleNotFoundError(res, "Page not found");
    }

    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return handleNotFoundError(res, "Book not found or page does not belong to this book");
    }

    // Fetch story state
    const storyState = await getStoryStateFromPage(dbPage);
    if (!storyState) {
      return handleNotFoundError(res, "Story state not found for this page");
    }

    // Gate 0 — Eligibility (no credit check for preview)
    const gate0Result = runGate0(storyState, userId, book.id, pageId);
    if (!gate0Result.passed) {
      return res.json({
        outcome: 'reject',
        message: gate0Result.message,
      } satisfies CustomActionPreviewResponse);
    }

    // Gate 1 — Security filter
    const gate1Result = runGate1(text);
    if (!gate1Result.passed) {
      return res.json({
        outcome: 'reject',
        message: getRejectionMessage(gate1Result.category),
      } satisfies CustomActionPreviewResponse);
    }

    // Gate 2 — AI validation (light tier)
    const userPrompt = buildCustomActionValidationPrompt(text, storyState, dbPage);

    const evalConfig: AIPromptForJson<CustomActionValidationResult> = {
      schema: CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION,
      requiredFields: CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS,
      fallbackField: 'interpretedIntent',
      baseOptions: {
        modelSelection: AI_CHAT_MODELS_THEME,
        context: 'custom-action-validation',
        config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 400 },
      },
    };

    const options = createAIOptionsWithSchema<CustomActionValidationResult>(evalConfig);
    const response = await aiPrompt<CustomActionValidationResult>(userPrompt, options);

    if (!response.result) {
      console.error('[POST /custom-actions/preview] ❌ AI returned no result');
      return handleApiError(res, "Failed to validate custom action");
    }

    const result = response.result;

    // Map outcome to response
    if (result.outcome === 'reject') {
      return res.json({
        outcome: 'reject',
        rejectionCategory: result.rejectionCategory,
        message: getRejectionMessage(result.rejectionCategory),
      } satisfies CustomActionPreviewResponse);
    }

    // allow or allow_as_attempt — return preview
    return res.json({
      outcome: result.outcome,
      preview: {
        canonicalIntent: result.interpretedIntent,
        cost: CUSTOM_ACTION_CREDIT_COST,
      },
    } satisfies CustomActionPreviewResponse);

  } catch (error) {
    console.error('[POST /custom-actions/preview] ❌ Error:', error);
    handleApiError(res, "Failed to preview custom action", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/custom-actions/submit
 *
 * Submit a custom action. Charges credits and triggers page generation.
 *
 * Flow:
 * 1. Re-runs Gate 0 (including credit charge) — do NOT trust preview result for charging
 * 2. Re-runs Gate 1 + Gate 2 (state may have changed since preview)
 * 3. Constructs canonical Action
 * 4. Persists audit record
 * 5. Returns polling info for the generated page
 *
 * **Authentication:** Required (via `requireAuth`)
 *
 * @param identifier - Book slug or UUID
 * @param pageId - Current page ID
 * @body text - Custom action text (3-60 chars)
 * @body [confirmationToken] - Token from preview (optional, for idempotency)
 *
 * @example
 * POST /api/books/the-haunting/page123/custom-actions/submit
 * Body: { "text": "I try to pick the lock with my hairpin" }
 *
 * Response (202):
 * {
 *   "nextPageId": "page456",
 *   "pollingInfo": {
 *     "pollingUrl": "/api/books/the-haunting/page456/candidates/status",
 *     "pollingIntervalMs": 2000,
 *     "maxPollingTimeMs": 80000
 *   }
 * }
 */
router.post("/:identifier/:pageId/custom-actions/submit", requireAuth, async (req: Request, res: Response) => {
  try {
    const { identifier, pageId: pageIdParam } = req.params;
    const { text } = req.body;
    const userId = req.userId!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate input
    if (!text || typeof text !== 'string') {
      return handleValidationError(res, "text is required");
    }

    // Validate pageId format
    if (!isValidUuid(pageId)) {
      return handleValidationError(res, "Invalid pageId format");
    }

    // Fetch the page and book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return handleNotFoundError(res, "Page not found");
    }

    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return handleNotFoundError(res, "Book not found or page does not belong to this book");
    }

    // Fetch story state
    const storyState = await getStoryStateFromPage(dbPage);
    if (!storyState) {
      return handleNotFoundError(res, "Story state not found for this page");
    }

    // Gate 0 — Eligibility with credit check
    const gate0Result = runGate0(storyState, userId, book.id, pageId);
    if (!gate0Result.passed) {
      return res.status(400).json({
        message: gate0Result.message,
      });
    }

    // Gate 1 — Security filter
    const gate1Result = runGate1(text);
    if (!gate1Result.passed) {
      return res.status(400).json({
        message: getRejectionMessage(gate1Result.category),
      });
    }

    // Gate 2 — AI validation
    const userPrompt = buildCustomActionValidationPrompt(text, storyState, dbPage);

    const evalConfig: AIPromptForJson<CustomActionValidationResult> = {
      schema: CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION,
      requiredFields: CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS,
      fallbackField: 'interpretedIntent',
      baseOptions: {
        modelSelection: AI_CHAT_MODELS_THEME,
        context: 'custom-action-validation',
        config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 400 },
      },
    };

    const options = createAIOptionsWithSchema<CustomActionValidationResult>(evalConfig);
    const aiResponse = await aiPrompt<CustomActionValidationResult>(userPrompt, options);

    if (!aiResponse.result) {
      console.error('[POST /custom-actions/submit] ❌ AI returned no result');
      return handleApiError(res, "Failed to validate custom action");
    }

    const result = aiResponse.result;

    // Check if hard reject (no generation, no charge)
    if (result.outcome === 'reject') {
      // Persist rejection to audit log (no credit charge for rejections)
      const auditId = generateId();
      await dbWrite.insert(customActions).values({
        id: auditId,
        bookId: book.id,
        pageId,
        userId,
        originalText: text,
        canonicalIntent: result.interpretedIntent,
        actionType: result.actionType,
        hintType: result.hintType,
        outcome: 'reject',
        rejectionCategory: result.rejectionCategory,
        plausibilityScore: result.plausibilityScore,
        progressionScore: result.progressionScore,
        creditsCharged: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return res.status(400).json({
        message: getRejectionMessage(result.rejectionCategory),
      });
    }

    // Construct canonical Action
    const canonicalAction = buildCanonicalAction(text, result);

    // Charge credits and persist action in a transaction
    await executeWithCredits(
      userId,
      CUSTOM_ACTION_CREDIT_COST,
      async (tx) => {
        // Persist audit record
        const auditId = generateId();
        await tx.insert(customActions).values({
          id: auditId,
          bookId: book.id,
          pageId,
          userId,
          originalText: text,
          canonicalIntent: result.interpretedIntent,
          actionType: result.actionType,
          hintType: result.hintType,
          outcome: result.outcome,
          rejectionCategory: result.rejectionCategory,
          plausibilityScore: result.plausibilityScore,
          progressionScore: result.progressionScore,
          creditsCharged: CUSTOM_ACTION_CREDIT_COST,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      },
      {
        context: 'custom_action_submit',
        metadata: {
          bookId: book.id,
          pageId,
          outcome: result.outcome,
          actionType: result.actionType,
        },
        req,
      },
    );

    console.log(`[POST /custom-actions/submit] ✅ Custom action "${canonicalAction.text}" submitted for page ${pageId} (outcome: ${result.outcome})`);

    // Log user activity
    await logUserActivity({
      userId,
      activityType: 'credits_consumed',
      targetType: 'page',
      targetId: pageId,
      metadata: {
        actionType: 'custom_action',
        canonicalIntent: result.interpretedIntent,
        bookId: book.id,
        outcome: result.outcome,
      },
    }, { req });

    // Return success with generation info
    // The frontend should poll for the next page using the existing candidates/status endpoint
    const pollingUrl = `/api/books/${bookIdentifier}/${pageId}/candidates/status`;

    return res.status(202).json({
      message: 'Custom action submitted successfully. Page generation in progress.',
      pollingInfo: {
        pollingUrl,
        pollingIntervalMs: 2000,
        maxPollingTimeMs: 80000,
      },
    } satisfies CustomActionSubmitResponse);

  } catch (error) {
    const errorMessage = getErrorMessage(error);

    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return res.status(402).json({
        error: 'Insufficient credits',
        message: `You need at least ${CUSTOM_ACTION_CREDIT_COST} credits to submit a custom action`,
      });
    }

    console.error('[POST /custom-actions/submit] ❌ Error:', error);
    handleApiError(res, 'Failed to submit custom action', error);
  }
});

export default router;
