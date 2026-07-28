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
 * - Custom actions with AI validation
 * - Ending sharing and psychological profiles
 * 
 * Endpoints:
 * 
 * Book Creation & Generation:
 * - POST /api/books - Create new psychological thriller books (requires auth + credits)
 * - POST /api/books/stream - Create new psychological thriller books with streaming (requires auth + credits)
 * - POST /api/books/async - Create new book asynchronously via GitHub Actions (requires auth + credits)
 * - GET /api/books/:bookId/status - Poll async book creation status (requires auth)
 * - POST /api/books/:bookId/cancel - Cancel a pending/in-progress book generation (requires auth)
 * - POST /api/books/:bookId/retry - Retry a failed/cancelled book generation (requires auth)
 * - GET /api/books/generations/active - List active in-progress generations (requires auth)
 * - POST /api/books/workflow-webhook - Internal webhook for GitHub Actions workflow (internal auth)
 * - POST /api/books/insert - Test route for direct book insertion (requires auth)
 * 
 * Book Retrieval & Management:
 * - GET /api/books - Retrieve user's book library (requires auth)
 * - GET /api/books/explore - Explore published books with search and pagination (optional auth)
 * - GET /api/books/:identifier - Retrieve specific book by slug or id (optional auth)
 * - PUT /api/books/:id - Update book information and cover image (requires auth)
 * - PATCH /api/books/:id/visibility - Update book visibility level (requires auth)
 * - PATCH /api/books/:id/archive - Archive or unarchive a book (requires auth)
 * - DELETE /api/books/:id - Delete a book and queue image for deletion (requires auth)
 * - GET /api/books/:id/similar - Get similar books by keyword Jaccard similarity (optional auth)
 * - GET /api/books/tags/popular - Get popular tags for filtering (no auth required)
 * - GET /api/books/stats - Get public book statistics (optional auth)
 * - POST /api/books/:identifier/purchase - Purchase a paid book with credits (requires auth)
 * 
 * Book Reading & Navigation:
 * - GET /api/books/:identifier/:pageId - Retrieve specific pages with translation support (optional auth)
 * - POST /api/books/:identifier/:pageId/confirm-visit - Confirm page visit and record progress (requires auth)
 * - POST /api/books/:identifier/:pageId/touch - Lightweight "last read" heartbeat updating session updatedAt (requires auth)
 * - GET /api/books/:identifier/branches - List all branches for a book (optional auth)
 * - GET /api/books/:identifier/:pageId/candidates - Pre-generate candidate pages via SSE (requires auth)
 * - GET /api/books/:identifier/:pageId/candidates/status - Poll candidate generation status (optional auth)
 * - POST /api/books/:identifier/:pageId/actions/hint - Purchase an action hint (requires auth + credits)
 * 
 * Custom Actions:
 * - POST /api/books/:identifier/:pageId/custom-actions/preview - Preview a custom action without charging (requires auth)
 * - POST /api/books/:identifier/:pageId/custom-actions/submit - Submit a custom action and generate page (requires auth + credits)
 * 
 * Psychological Features:
 * - GET /api/books/:identifier/psychological-profile - Get psychological "autopsy" of the MC (requires auth)
 * - GET /api/books/:identifier/locked-paths - Get timeline of locked/closed paths (requires auth)
 * 
 * Social Interactions:
 * - POST /api/books/:id/like - Like a book (requires auth)
 * - DELETE /api/books/:id/like - Unlike a book (requires auth)
 * - POST /api/books/:id/favorite - Add book to favorites (requires auth)
 * - DELETE /api/books/:id/favorite - Remove book from favorites (requires auth)
 * - PATCH /api/books/favorites/rename-collection - Rename a collection across all favorites (requires auth)
 * - POST /api/books/:identifier/:pageId/share - Share a completed ending (requires auth)
 * - GET /api/books/share/:username/:bookSlug/:pageId - Public endpoint for viewing a shared ending (no auth)
 * 
 * Comments:
 * - GET /api/books/:id/comments - Get book comments with pagination (optional auth)
 * - POST /api/books/:id/comments - Create comment on book (or page/paragraph) (requires auth)
 * - GET /api/books/:id/pages/:pageId/comments - Get comments for a page (optional auth)
 * - POST /api/books/:id/pages/:pageId/comments - Create comment on a page (requires auth)
 * - GET /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments - Get comments for a paragraph (optional auth)
 * - POST /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments - Create comment on a paragraph (requires auth)
 * - PUT /api/books/comments/:id - Update comment (requires auth)
 * - DELETE /api/books/comments/:id - Delete comment (requires auth)
 * - GET /api/books/comments - Get authenticated user's comments (requires auth)
 * 
 * Utilities:
 * - GET /api/books/prompt - Generate book creation prompt via SSE (optional auth)
 * 
 * Book Testimonials:
 * - GET /api/books/testimonials - Get authenticated user's own book testimonials (requires auth)
 * - GET /api/books/:identifier/testimonials - List book testimonials (optional auth)
 * - POST /api/books/:identifier/testimonials - Create a testimonial for a book (requires auth)
 * - GET /api/books/:identifier/testimonials/:id - Get a single testimonial (optional auth)
 * - PATCH /api/books/:identifier/testimonials/:id - Update a testimonial (requires auth, owner only)
 * - DELETE /api/books/:identifier/testimonials/:id - Delete a testimonial (requires auth, owner only)
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { streamSSE } from "hono/streaming";
import { getClientIp } from "../hono/express-shim.js";
import { dbRead, dbWrite } from "../db/client.js";
import { optionalAuth, requireAuth } from "../middleware/nextauth.js";
import { books, branches, deletedImages, users, userLikes, userFavorites, userComments, bookGenerations, userActionHints, userPurchasedBooks, userPageProgress, userCompletedBooks, uploadedImages, userActivityLogs, pages, bookTestimonials } from "../db/schema.js";
import { getErrorMessage, cApiError, cForbiddenError, cNotFoundError, cRateLimitError, cUnauthorizedError, cValidationError } from "../utils/error.js";
import { sanitizeTextForDB, sanitizeKeywords } from '../utils/text-processing.js';
import { stripHtml } from '../utils/sanitize-html.js';
import { eq, and, desc, sql, ne, inArray, arrayOverlaps } from "drizzle-orm";
import { generateBookCreationPromptStream } from "../utils/prompt.js";
import { getBook, getBookFromDB, getEnrichedBook, getPageFromDB, mapToEnrichedPage, tryAcquireWorkflowDispatchGate } from "../services/book.js";
import { shouldUseCache, getFreshPromptForUser, trackPromptView, savePromptToCache } from "../services/prompt-cache.js";
import { streamCachedPrompt } from "../utils/prompt-stream.js";
import { PROMPT_CACHE_CONFIG } from "../config/prompt-cache.js";
import { imageUploadMiddleware } from "../middleware/upload.js";
import { deleteFileFromImageKit, isBase64Upload, persistUploadedImage } from "../services/image.js";
import { extractPaginationParams, createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { DEFAULT_ITEMS_PER_PAGE } from "../config/pagination.js";
import { validateSearchQuery, validateLanguageCode, validateAgeRange, validateGender, createRelevanceExpression, buildTokenizedSearchCondition } from "../utils/search.js";
import type { ImageUploadSource } from "../types/image.js";
import { updateBook, updateBookVisibility, insertBook, uploadBookCoverImage, uploadBookCharacterAvatarImage, sanitizeBookTextField, resolveBook, getPublicBookStats, getPopularTags, mapToUserStoryPage, mapBookFromDb, invalidatePopularTagsCache, invalidateBookCache, invalidateEnrichedBookCache } from "../services/book.js";
import { isValidBookSortOption, isValidLastUpdatedFilter } from "../utils/books.js";
import { getEnrichedBookSelect, getSimilarBookSelect, buildBookQuery, visitBookPage } from "../services/book-controller.js";
import { withCache, CACHE_KEYS, CACHE_TTL, invalidateUserBooksCache, invalidateExploreCache, invalidateUserProfileCache } from "../services/cache.js";
import type { BookCreationStatus, BookGenerationPayload, BookMode, BookSortOption, BookStatus, BookVisibility, EnrichedBookData } from "../types/book.js";
import { bookStatuses, bookVisibilities, bookModes, lastUpdatedFilterOptions, storyGenerationSteps } from "../types/book.js";
import { createBookCore, createBookValidate, handleBookCreationError, updateBookGenerationStatus } from "../services/book-creation.js";
import { executeWithCredits, addCredits } from "../services/credits.js";
import { logUserActivity, updateUserLastActivity } from "../services/user.js";
import type { ProgressCallback } from "../types/sse.js";
import { generateId, isValidUuid } from "../utils/uuid.js";
import { getActionProgressEvents, clearActionProgressEvents } from "../utils/progress-tracking.js";
import type { DBBook, DBNewBook, DBNewBookGeneration, DBUpdateBook } from "../types/schema.js";
import type { ActionProgressEvent, CandidateGenerationStatus } from "../types/candidate-generation.js";
import { GITHUB_REPO_CONFIG } from "../config/env.js";
import { pollForCandidateGeneration, sendSSEEvent } from "../utils/sse.js";
import type { StoryMC } from "../types/character.js";
import { triggerCandidateGenerationWorkflow, validateAndRetrievePageForGeneration } from "../utils/candidate-generation.js";
import { SSE_POLLING_CONFIG } from "../config/candidate-generation.js";
import { getPsychologicalProfileResult } from "../services/psychological-profile.js";
import { getLockedPaths } from "../services/locked-paths.js";
import { runGate0, runGate1, buildCustomActionValidationPrompt, buildCanonicalAction, getRejectionMessage, CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION, CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS } from "../services/custom-actions.js";
import { customActions } from "../db/schema.js";
import { getStoryStateFromPage, computeEndingStats, setActiveSession } from "../services/story.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { notifyForumOfBookChange, notifyForumStoryArchived } from "../services/forum-queue.js";
import { createAIOptionsWithSchema, aiPrompt } from "../utils/ai-chat.js";
import { AI_CHAT_MODELS_THEME } from "../config/ai-clients.js";
import { BOOK_MIN_PAGES } from "../config/story.js";
import type { CustomActionValidationResult, CustomActionPreviewResponse, CustomActionSubmitResponse } from "../types/custom-action.js";
import type { AIPromptForJson } from "../types/ai-chat.js";
import { MAX_BRANCHING_PREGENERATION_DEPTH } from "../config/story.js";
import { CREDIT_COSTS, getBookModeCreditCost } from "../config/credits.js";
import { CREDIT_ERRORS } from "../config/errors.js";
import { getRefundForStep, isAtPointOfNoReturn, BOOK_GENERATION_COST } from "../config/generation-refund.js";
import { triggerBookGenerationWorkflow, isGenerationStale } from "../services/book-creation.js";
import { cancelGitHubWorkflowRuns } from "../utils/github-workflow.js";
import { requireEnv } from "../utils/env.js";
import type { UserComment } from "../types/user.js";
import type { AIChatProvider } from "../types/ai-chat.js";
import { MAX_CONCURRENT_GENERATIONS, AI_VALIDATION_TIMEOUT_MS } from "../config/book-creation.js";
import { generateRandomCharacter } from "../utils/characters.js";

const router = new Hono<AppEnv>();

/**
 * Checks whether the user has reached the concurrent generation limit.
 * If so, responds with 429 and returns true.
 */
async function isConcurrentGenerationLimitReached(userId: string, c: Context<AppEnv>): Promise<boolean> {
  const [result] = await dbRead
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(bookGenerations)
    .where(
      and(
        eq(bookGenerations.userId, userId),
        inArray(bookGenerations.generationStatus, ['pending', 'in_progress']),
      ),
    );

  if (result.count >= MAX_CONCURRENT_GENERATIONS) {
    cRateLimitError(
      c,
      `You can only have ${MAX_CONCURRENT_GENERATIONS} concurrent book generations. Please wait for existing generations to complete.`,
    );
    return true;
  }

  return false;
}

/**
 * POST /api/books
 *
 * Creates a new psychological thriller book with AI-generated content.
 * Accepts theme and main character candidate, initializes story with AI.
 * Returns complete book information with first page and initial state.
 *
 * @route POST /api/books
 * @description Create a new book with AI-generated content
 * @auth Required (requireAuth)
 *
 * @body {Object} Book creation payload
 * @body {string} theme - Story theme (max 1000 chars)
 * @body {Object} [mcCandidate] - Main character candidate
 * @body {string} [mcCandidate.name] - Character's display name
 * @body {number} [mcCandidate.age] - Character's age in years (13-25)
 * @body {string} [mcCandidate.gender] - Character's gender (male/female)
 * @body {string} [mcCandidate.bio] - Character's bio
 * @body {boolean} [generateCoverImage] - Whether to generate AI cover image
 *
 * @returns {Object} Book creation response
 * @returns {Object} book - Created book metadata
 * @returns {Object} firstPage - First story page with actions
 * @returns {Object} initialState - Initial story state including flags, threads, profile
 * @returns {string} [aiComment] - AI evaluation comment on the book
 * @returns {string} [aiFinalComment] - AI final evaluation comment
 *
 * @example
 * // Request (valid theme)
 * POST /api/books
 * Body: { "theme": "haunted mansion mystery", "mcCandidate": { "name": "Sarah", "age": 28, "gender": "female", "bio": "Shy librarian with hidden past" } }
 *
 * // Response (201)
 * {
 *   "book": { "id": "book123", "title": "The Whispering Halls", "slug": "whispering-halls", "hook": "Sarah never believed in ghosts until she found the diary", "summary": "A psychological thriller...", "keywords": ["mystery", "thriller", "haunted"], "imageUrl": "https://example.com/cover.jpg", "status": "active", "totalPages": 120, "language": "en", "mc": { "name": "Sarah", "age": 28, "gender": "female", "bio": "Shy librarian with hidden past" }, "createdAt": "2023-01-01T00:00:00.000Z", "updatedAt": "2023-01-01T00:00:00.000Z" },
 *   "firstPage": { "id": "page456", "page": 1, "text": "The library was silent except for the rain...", "actions": [...] },
 *   "initialState": { "page": 1, "maxPage": 120, "flags": { "trust": "medium", "fear": "low" }, "threads": [], "traumaTags": [], "psychologicalProfile": { "archetype": "investigator" } }
 * }
 */
router.post("/", requireAuth, async (c) => {
  try {
    const { theme, mcCandidate, generateCoverImage, advancedOptions, mode } = c.get("body");
    const userId = c.get("userId")!;

    // Enforce concurrent generation limit
    if (await isConcurrentGenerationLimitReached(userId, c)) return;
    
    // Use shared core logic (without progress callback for synchronous response)
    const result = await createBookCore(
      {
        req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } as any,
        userId,
        theme,
        mcCandidate,
        generateCoverImage,
        advancedOptions,
        mode,
        context: "book_creation",
      },
      // No progress callback for POST endpoint (synchronous response)
    );

    c.status(201); return c.json(result);
  } catch (error) {
    handleBookCreationError(c, error);
  }
});

/**
 * POST /api/books/workflow-webhook
 *
 * Internal webhook called by the GitHub Actions runner to push generation
 * progress or a terminal result back to the backend.
 *
 * Secured by the `x-internal-secret` header (value must match `INTERNAL_SECRET`
 * env var). Not protected by `requireAuth` since it is called by machine actors.
 *
 * Body: `{ bookId, status?, step?, error? }` — same shape as `BookGenerationPayload`.
 *
 * @route POST /api/books/workflow-webhook
 */
router.post('/workflow-webhook', async (c) => {
  try {
    const secret = c.req.header('x-internal-secret');
    if (!secret || secret !== process.env.INTERNAL_SECRET) {
      return cForbiddenError(c, 'Invalid or missing internal secret');
    }

    const payload = c.get("body") as BookGenerationPayload;
    await updateBookGenerationStatus(payload);

    return c.json({ ok: true });
  } catch (error) {
    console.error('[POST /api/books/workflow-webhook] ❌ Error:', error);
    handleBookCreationError(c, error, 'Failed to process workflow webhook');
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
router.post("/stream", requireAuth, async (c) => {
  try {
    const { theme, mcCandidate, generateCoverImage, advancedOptions, mode } = c.get("body");
    const userId = c.get("userId")!;

    // Enforce concurrent generation limit
    if (await isConcurrentGenerationLimitReached(userId, c)) return;

    return streamSSE(c, async (stream) => {
      // Create progress callback for SSE events
      const onProgress: ProgressCallback = (event) => {
        sendSSEEvent(stream, event);
      };

      // Create book with progress events
      const result = await createBookCore(
        {
          req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } as any,
          userId,
          theme,
          mcCandidate,
          generateCoverImage,
          advancedOptions,
          mode,
          context: "book_creation_stream",
        },
        onProgress
      );

      // Send final complete event
      sendSSEEvent(stream, { type: 'complete', data: result });
    });
  } catch (error) {
    return cApiError(c, "Failed to create book", error);
  }
});

/**
 * POST /api/books/async
 *
 * Creates a new book asynchronously via GitHub Actions, bypassing Vercel's
 * 5-minute function timeout.
 *
 * Flow:
 * 1. Structural + heuristic validation, then AI validation with a 15s timeout
 * 2. Atomically consume credits and insert draft `books` + `bookGenerations` rows
 * 3. Dispatch the `on-demand-book-creation.yml` GitHub workflow (fire-and-forget)
 * 4. Return `bookId` immediately with HTTP 202
 *
 * **AI validation** is raced against `AI_VALIDATION_TIMEOUT_MS` (15s) so a
 * hanging provider cannot block the Vercel serverless limit. If the AI call
 * completes in time, the `bookGenerations` row is stamped
 * `aiValidationCompleted: true` and the GitHub Actions runner skips re-validation.
 * If the AI call times out or fails the runner performs full AI validation
 * (with no timeout) before the expensive book generation — failing fast on
 * content violations.
 *
 * The GitHub Actions runner reads all generation params (`theme`, `mcCandidate`,
 * `language`, `titleIdea`, `aiComment`, `advancedOptions`) from the
 * `bookGenerations` row, so no sensitive data is passed as workflow inputs.
 *
 * If the workflow dispatch fails silently, the stale-detection logic in
 * `GET /api/books/:bookId/status` will re-trigger it after `PENDING_TIMEOUT_MS`.
 *
 * Credit Atomicity:
 * Credits are consumed inside `executeWithCredits` together with the draft row
 * inserts. If either insert fails, the whole transaction rolls back and credits
 * are preserved automatically — no explicit refund is needed for this step.
 *
 * @route   POST /api/books/async
 * @auth    Required
 * @body    `{ theme: string, mcCandidate?: StoryMCCandidate, generateCoverImage?: boolean }`
 * @returns HTTP 202 `{ bookId: string, message: string }`
 *
 * @example
 * // Request
 * POST /api/books/async
 * { "theme": "haunted mansion mystery", "mcCandidate": { "name": "Sarah", "age": 28 } }
 *
 * // Response 202
 * { "bookId": "01912345-6789-1234-5678-123456789012", "message": "Book creation started..." }
 */
router.post('/async', requireAuth, async (c) => {
  try {
    const { theme, mcCandidate: initialMCCandidate, generateCoverImage, advancedOptions, mode: requestedMode } = c.get("body");
    const userId = c.get("userId")!;
    const themePreview = theme?.length > 80 ? theme.slice(0, 80) + '…' : theme;

    const startTime = Date.now();
    console.log(`[POST /api/books/async] 🚀 Starting async book creation for user ${userId}: "${themePreview}"`);

    // ── STEP 0: Enforce concurrent generation limit ─────────────────────────
    if (await isConcurrentGenerationLimitReached(userId, c)) return;

    // ── STEP 0b: Validate + resolve book creation mode ─────────────────────
    const mode = bookModes.includes(requestedMode) ? requestedMode : 'interactive';

    // ── STEP 1: Validate theme + MC candidate with timed AI ──────────────────
    //
    // 1a. Structural + heuristic checks run unconditionally (<1 ms).
    // 1b. AI validation (`validateThemeWithAI`) is raced against
    //     `AI_VALIDATION_TIMEOUT_MS` so a hanging provider cannot block Vercel's
    //     300 s serverless limit.
    //
    // If the AI call completes in time → aiResult carries content-safety
    // verification + metadata (title, hook, summary, MC candidate, language)
    // and is persisted as `aiValidationCompleted: true` in the generation row.
    //
    // If the AI call times out or fails → aiResult is undefined, the runner
    // performs AI validation (without timeout) before the expensive generation.
    const { aiResult, normalizedAdvancedOptions } = await createBookValidate({
      theme,
      mcCandidate: initialMCCandidate,
      generateCoverImage,
      advancedOptions,
      isOriginal: false,
      aiValidationTimeout: AI_VALIDATION_TIMEOUT_MS,
      onProgress: undefined // No SSE progress callback for async route
    });

    console.log(`[POST /api/books/async] ✅ Structural + heuristic validation passed`);

    const { comment: aiComment, language = 'en', titleIdea, hook, summary, mcCandidate } = aiResult || {};

    if (aiResult) {
      console.log(`[POST /api/books/async] ✅ AI validation completed within ${AI_VALIDATION_TIMEOUT_MS}ms limit`);
    } else {
      console.log(`[POST /api/books/async] ⏰ AI validation did not complete within ${AI_VALIDATION_TIMEOUT_MS}ms — runner will re-validate`);
    }

    // ── STEP 2: Generate deterministic book ID ────────────────────────────────
    const bookId = generateId();

    // ── STEP 3: Build draft records ───────────────────────────────────────────
    const mc: StoryMC = generateRandomCharacter(mcCandidate);

    const initialBookData: DBNewBook = {
      id: bookId,
      userId,
      title: titleIdea || 'Generating…', // Temporary placeholder, replaced by initializeBook
      hook: hook || null,
      summary: summary || null,
      keywords: [],
      language,
      totalPages: BOOK_MIN_PAGES, // Sensible default until initializeBook populates the real value
      mc,
      mode, // Book creation mode (story format)
      status: 'draft', // Promoted to 'active' when initializeBook completes
      originalThemeInput: theme, // Preserve original user input for frontend display
    };

    const initialBookGenerationData: DBNewBookGeneration = {
      bookId,
      userId,
      theme,
      language,
      titleIdea,
      aiComment,
      aiValidationCompleted: !!aiResult,
      aiProvider: aiResult?.aiProvider,
      aiModel: aiResult?.aiModel,
      mode, // Runner reads this from DB — not workflow inputs
      mcCandidate, // Runner reads this from DB — not workflow inputs
      generateCoverImage: generateCoverImage ?? false,
      advancedOptions: normalizedAdvancedOptions, // Optional — runner picks this up from the DB row
      generationStatus: 'pending',
      generationStep: 'theme_validation', // Reflects last completed frontend step
    };

    // ── STEP 4: Atomically consume credits + insert draft rows ────────────────
    //
    // `executeWithCredits` opens a single Postgres transaction:
    //   - Deducts STORY_GENERATION credits (row-locked)
    //   - Inserts `books` draft row (returned via `.returning()`)
    //   - Inserts `bookGenerations` tracking row
    //
    // If any insert fails the transaction rolls back and credits are preserved
    // automatically. The runner picks up all generation params from the DB row.
    const { result: dbBook } = await executeWithCredits<DBBook>(
      userId,
      getBookModeCreditCost(mode),
      async (tx) => {
        const [insertedBook] = await tx.insert(books).values(initialBookData).returning();
        await tx.insert(bookGenerations).values(initialBookGenerationData);
        return insertedBook;
      },
      {
        context:  'book_creation_async',
        metadata: { theme, bookId, mode },
      }
    );

    // Map DB row to frontend-facing Book shape for the response.
    console.log(`[POST /api/books/async] 💰 Credits consumed, draft rows inserted for book ${bookId}`);
    const book = mapBookFromDb(dbBook);

    // ── STEP 5: Acquire workflow dispatch gate & dispatch ──────────────────
    //
    // Two-layer gate: pre-flight check (terminal / alive-runner rejection) +
    // atomic mutex (only one process claims the right to dispatch).
    const gate = await tryAcquireWorkflowDispatchGate(bookId);
    if (!gate.shouldDispatch) {
      console.log(`[POST /api/books/async] ⏸️ Workflow dispatch blocked for book ${bookId}: ${gate.reason}`);
    } else {
      console.log(`[POST /api/books/async] 🔧 Dispatching on-demand-book-creation.yml for book ${bookId}`);
      // Fire-and-forget — response is sent before any long-running dispatch logic.
      // Dispatch failures are logged and handled by stale-detection.
      triggerBookGenerationWorkflow(bookId, 'POST /api/books/async');
    }

    // ── STEP 6: Log user activity (fire-and-forget) ────────────
    void logUserActivity({
      userId,
      activityType: 'book_creation_started',
      targetType:   'book',
      targetId:     bookId,
      metadata:     { theme, method: 'async' },
    },
    { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } }).catch((err) => {
      console.error('[POST /api/books/async] ❌ Failed to log user activity:', err);
    });

    // ── STEP 7: Respond immediately with 202 Accepted ─────────────────────────
    //
    // HTTP 202 is the correct semantic: "request accepted for background processing."
    // Include the draft book object + aiComment so the frontend can render
    // title/mc/summary/hook/commentary immediately without waiting for the first
    // status poll tick.
    console.log(`[POST /api/books/async] ✅ Creation started (202) for book ${bookId} (${(Date.now() - startTime).toFixed(0)} ms)`);
    return c.json({
      bookId,
      message: 'Book creation started. Poll /api/books/:bookId/status for updates.',
      aiComment,
      book,
    }, 202);
  } catch (error) {
    console.error('[POST /api/books/async] ❌ Failed to start book creation:', error);
    handleBookCreationError(c, error, 'Failed to start book creation');
  }
});

/**
 * GET /api/books/generations/active
 *
 * Returns all active (in-progress) book generations for the authenticated user.
 * Lightweight endpoint for the frontend to display generation progress indicators.
 *
 * @route GET /api/books/generations/active
 * @auth Required
 * @returns Array of { bookId, generationStatus, generationStep }
 *
 * @example
 * GET /api/books/generations/active
 * Response 200:
 * [
 *   { "bookId": "01912345-6789-1234-5678-123456789012", "generationStatus": "in_progress", "generationStep": "ai_generation" },
 *   { "bookId": "01912345-6789-1234-5678-123456789013", "generationStatus": "in_progress", "generationStep": "theme_validation" }
 * ]
 */
router.get('/generations/active', requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;

    const rows = await dbRead
      .select({
        bookId: bookGenerations.bookId,
        generationStatus: bookGenerations.generationStatus,
        generationStep: bookGenerations.generationStep,
      })
      .from(bookGenerations)
      .where(
        and(
          eq(bookGenerations.userId, userId),
          eq(bookGenerations.generationStatus, 'in_progress'),
        ),
      );

    return c.json(rows);
  } catch (error) {
    console.error('[GET /api/books/generations/active] ❌ Error:', error);
    return cApiError(c, 'Failed to get active generations', error);
  }
});

/**
 * GET /api/books/:bookId/status
 *
 * Polls for the current progress of an async book creation.
 * Called repeatedly by the frontend until `generationStatus === 'completed'`.
 *
 * **Stale-detection:**
 * If the generation appears stuck (`isGenerationStale` returns `true`) and
 * has not already been refunded, this endpoint re-triggers the workflow.
 * This provides automatic recovery without manual intervention.
 *
 * @route   GET /api/books/:bookId/status
 * @auth    Required (users may only query their own books)
 * @param   bookId - UUID v7 of the target book
 * @returns `BookCreationStatus`
 *
 * @example
 * // In-progress response
 * {
 *   "bookId": "...",
 *   "status": "draft",
 *   "generationStatus": "in_progress",
 *   "generationStep": "ai_generation",
 *   "generationStepDescription": "In progress: AI is crafting your story",
 *   "generationStartedAt": "2026-06-01T10:00:05.000Z",
 *   "generationCompletedAt": null,
 *   "aiComment": null,
 *   "createdAt": "...",
 *   "updatedAt": "..."
 * }
 *
 * // Completed response
 * {
 *   "bookId": "...",
 *   "status": "active",
 *   "generationStatus": "completed",
 *   "generationStep": "complete",
 *   "generationStepDescription": "Book generation complete",
 *   ...
 * }
 *
 * // Failed response
 * {
 *   "bookId": "...",
 *   "status": "draft",
 *   "generationStatus": "failed",
 *   "generationStepDescription": "Book generation failed",
 *   "error": "AI generation failed: timeout",
 *   ...
 * }
 */
router.get('/:bookId/status', requireAuth, async (c) => {
  try {
    const { bookId } = c.req.param();
    const userId = c.get("userId")!;

    // Validate bookId format
    if (!isValidUuid(bookId)) {
      return cValidationError(c, 'Invalid book ID format');
    }

    // Join `books` (LEFT JOIN `bookGenerations`) so that books created via the
    // sync/SSE routes (which have no bookGenerations row) still return a result.
    const [data] = await dbRead
      .select({
        // books table
        bookId:        books.id,
        bookUserId:    books.userId,
        bookStatus:    books.status,
        bookCreatedAt: books.createdAt,
        bookUpdatedAt: books.updatedAt,
        // bookGenerations table (nullable — leftJoin)
        generationStatus:       bookGenerations.generationStatus,
        generationStep:         bookGenerations.generationStep,
        generationError:        bookGenerations.generationError,
        generationStartedAt:    bookGenerations.generationStartedAt,
        generationCompletedAt:  bookGenerations.generationCompletedAt,
        isGeneratingStartedAt:  bookGenerations.isGeneratingStartedAt,
        isRefunded:             bookGenerations.isRefunded,
        aiComment:              bookGenerations.aiComment,
        aiFinalComment:         bookGenerations.aiFinalComment,
        createdAt:              bookGenerations.createdAt, // used for stale-detection fallback
      })
      .from(books)
      .leftJoin(bookGenerations, eq(books.id, bookGenerations.bookId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!data) {
      return cNotFoundError(c, 'Book not found');
    }

    // Verify user owns the book
    if (data.bookUserId !== userId) {
      return cForbiddenError(c, 'You can only view status for your own books');
    }

    // Check if generation is stale and try to dispatch a fresh workflow.
    // The gate protects against double-dispatch: pre-flight rejects terminal /
    // alive-runner states, and the atomic lock ensures only one caller wins.
    const isStale = isGenerationStale(data);
    if (isStale && !data.isRefunded && GITHUB_REPO_CONFIG.token) {
      const gate = await tryAcquireWorkflowDispatchGate(bookId);
      if (gate.shouldDispatch) {
        console.log(`[GET /api/books/:bookId/status] 🔄 Stale generation detected for book ${bookId}, re-triggering workflow`);
        triggerBookGenerationWorkflow(bookId, 'GET /api/books/:bookId/status');
      } else {
        console.log(`[GET /api/books/:bookId/status] ⏸️ Stale but gate blocked: ${gate.reason}`);
      }
    }

    // Map generation status to current step description
    // ── Build user-facing step description ────────────────────────────────────
    //
    // Bug fix: previously exposed raw enum values (e.g. 'ai_generation') directly
    // to the frontend. Now maps through STEP_DESCRIPTIONS for friendly labels.
    // TODO: shouldn't we just need to handle translation in frontend? so I think exposing raw enum values is intended
    let generationStepDescription: string | undefined;

    switch (data.generationStatus) {
      case 'pending':
        generationStepDescription = 'Waiting for the generation worker to start';
        break;

      case 'in_progress': {
        const stepLabel = data.generationStep
          ? (storyGenerationSteps[data.generationStep] ?? data.generationStep)
          : 'Initialising';
        generationStepDescription = `In progress: ${stepLabel}`;
        break;
      }

      case 'completed':
        generationStepDescription = 'Book generation complete';
        break;

      case 'failed':
        generationStepDescription = 'Book generation failed';
        break;

      case 'cancelled':
        generationStepDescription = 'Book generation was cancelled';
        break;

      default:
        generationStepDescription = undefined;
    }

    // ── Terminal payload: include full enriched book ───────────────────────────
    //
    // When generation completes, fetch the enriched book (with firstPage, author
    // info, stats, user-specific flags) so the frontend can render immediately
    // without an extra GET /api/books/:bookId round-trip. This eliminates the
    // cross-request race window entirely — the book data travels in the same
    // response that signals completion.
    //
    // The enriched book is only fetched on the terminal 'completed' state to keep
    // in-progress polls lightweight (no joins on users, pages, subqueries, etc.).
    let enrichedBook: EnrichedBookData | null = null;
    if (data.generationStatus === 'completed') {
      try {
        enrichedBook = await getEnrichedBook(bookId, userId, undefined);
      } catch {
        // Non-fatal: the frontend can fall back to GET /api/books/:bookId.
        // The generation status is already persisted — a stale-book fallback
        // is better than failing the poll response entirely.
      }
    }

    const status: BookCreationStatus = {
      bookId:                   data.bookId,
      status:                   data.bookStatus ?? 'draft',
      generationStatus:         data.generationStatus ?? 'pending',
      generationStep:           data.generationStep  ?? 'theme_validation',
      generationStepDescription,
      generationStartedAt:      data.generationStartedAt,
      generationCompletedAt:    data.generationCompletedAt,
      aiComment:                data.aiComment,
      aiFinalComment:           data.aiFinalComment,
      error:                    data.generationError,
      createdAt:                data.bookCreatedAt,
      updatedAt:                data.bookUpdatedAt,
      isRefunded:               data.isRefunded,
      book: enrichedBook,
    };

    return c.json(status);
  } catch (error) {
    console.error('[GET /api/books/:bookId/status] ❌ Error:', error);
    return cApiError(c, 'Failed to get book status', error);
  }
});

/**
 * POST /api/books/:bookId/cancel
 *
 * Cancels a pending, in-progress, or failed book generation and issues a
 * pro-rata credit refund. The draft `books` row is **preserved** (not deleted)
 * so the user can retry the generation later without re-entering their theme.
 *
 * **Finding cancelled books:**
 * All draft books (pending, generating, failed, cancelled) appear in the
 * user's creations tab — use the explore endpoint with status filter:
 * ```
 * GET /api/books/explore?sortBy=creations&status=draft
 * ```
 * Check a specific book's generation status via:
 * ```
 * GET /api/books/:bookId/status
 * ```
 *
 * **Guards:**
 * - Completed books (`status === 'active'` OR `generationStatus === 'completed'`)
 *   cannot be cancelled — the book already exists and is readable.
 * - Books already refunded (`isRefunded` is set) are rejected to prevent
 *   double-refunds. This can happen if the user cancels and then retries.
 *
 * **Atomicity note:**
 * The status update and refund are separate DB writes (not one transaction) so
 * the cancel itself cannot fail due to a refund error. If `refundCredits` fails
 * after the status update, the user can retry — `isRefunded` is only stamped
 * after a successful refund, so the `isRefunded` guard won't block retries.
 *
 * **Debounce bypass:**
 * The status update uses a direct `dbWrite` call instead of the debounced
 * `updateBookGenerationStatus` helper to avoid unnecessary 500 ms latency on a
 * one-shot operation. The debounced helper is designed for high-frequency
 * progress events, not for cancellation.
 *
 * @route   POST /api/books/:bookId/cancel
 * @auth    Required
 * @param   bookId - UUID v7 of the target book
 * @returns `{ success: true, message: string }` on success
 *
 * @example
 * // Success
 * POST /api/books/01912345-6789-1234-5678-123456789012/cancel
 * → 200 { "success": true, "message": "Book generation cancelled. 5 credits refunded." }
 *
 * // Cannot cancel completed book
 * → 400 { "error": "Cannot cancel completed book" }
 *
 * // Already refunded
 * → 400 { "error": "Book generation already refunded" }
 */
router.post('/:bookId/cancel', requireAuth, async (c) => {
  try {
    const { bookId } = c.req.param();
    const userId = c.get("userId")!;

    // Validate bookId format
    if (!isValidUuid(bookId)) {
      return cValidationError(c, 'Invalid book ID format');
    }

    // Fetch book and generation data
    const [data] = await dbRead
      .select({
        bookUserId:       books.userId,
        bookStatus:       books.status,
        generationStatus: bookGenerations.generationStatus,
        generationStep:   bookGenerations.generationStep,
        isRefunded:       bookGenerations.isRefunded,
      })
      .from(books)
      .leftJoin(bookGenerations, eq(books.id, bookGenerations.bookId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!data) {
      return cNotFoundError(c, 'Book not found');
    }

    // Verify user owns the book
    if (data.bookUserId !== userId) {
      return cForbiddenError(c, 'You can only cancel your own books');
    }

    // Completed books are not cancellable — the content already exists
    if (data.bookStatus === 'active' || data.generationStatus === 'completed') {
      return c.json({ error: 'Cannot cancel completed book' }, 400);
    }

    // Prevent double-refunds (idempotency guard)
    if (data.isRefunded) {
      return c.json({ error: 'Book generation already refunded' }, 400);
    }

    // ── Point of no return ─────────────────────────────────────────────────────
    //
    // If generation has reached the finalizing stage, we cannot stop the workflow
    // (the AI cost is already sunk). Instead, we mark `cancellationRequestedAt`
    // on the generation row so that `initializeBook` sets `status: 'archived'`
    // instead of `status: 'active'` when the workflow completes.
    //
    // The workflow continues in the background. The book will exist but will be
    // hidden from the user's main library and explore feeds.
    if (isAtPointOfNoReturn(data.generationStep ?? null)) {
      await dbWrite
        .update(bookGenerations)
        .set({ cancellationRequestedAt: new Date() })
        .where(eq(bookGenerations.bookId, bookId));

      console.log(`[POST /api/books/:bookId/cancel] 📌 Book ${bookId} at point of no return — archiving on completion per user request`);
      return c.json({
        success: true,
        message:
          'Generation is almost complete and will finish in the background. ' +
          'The book will be archived instead of published.',
      }, 202);
    }

    // ── Cancel any running GitHub Actions workflow (best-effort) ─────────────
    //
    // Must run BEFORE the DB status update so that cancellation wins in a race
    // with the dying runner's catch block (which sends `{ status: 'failed' }`).
    // The runner receives SIGTERM with a 7.5 s grace period before SIGKILL.
    void cancelGitHubWorkflowRuns(
      GITHUB_REPO_CONFIG,
      { workflowFile: 'on-demand-book-creation.yml' },
      { context: 'POST /api/books/:bookId/cancel' },
    );

    // ── Set status to 'cancelled' directly (bypasses debounce for instant effect) ──
    //
    // Bug fix: previously used `updateBookGenerationStatus` (debounced, 500 ms delay)
    // which added unnecessary latency and required a separate clear of isGeneratingStartedAt.
    // A single direct write is cleaner and immediate.
    //
    // TOCTOU guard: the WHERE clause ensures the update only succeeds if the
    // generation hasn't already completed since the initial read. This prevents
    // a race where the GitHub webhook fires `completed` between our read and write.
    const [cancelledRow] = await dbWrite
      .update(bookGenerations)
      .set({
        generationStatus:      'cancelled',
        isGeneratingStartedAt: null,         // Release in-progress lock
        generationError:       null,         // Clear any stale error message
        generationCompletedAt: new Date(),
      })
      .where(
        and(
          eq(bookGenerations.bookId, bookId),
          ne(bookGenerations.generationStatus, 'completed'),
        ),
      )
      .returning({ id: bookGenerations.bookId });

    // If no row was updated, the generation completed between our read and write
    if (!cancelledRow) {
      console.log(`[POST /api/books/:bookId/cancel] ℹ️ Book ${bookId} was already completed, skipping cancellation`);
      return c.json({ error: 'Cannot cancel completed book' }, 400);
    }

    // ── Calculate stage-based refund ──────────────────────────────────────────
    //
    // Refund depends on the generation step the workflow had reached.
    // Early stages get a full refund; later stages get a partial refund.
    const refundAmount = getRefundForStep(data.generationStep ?? null);

    // ── Refund credits ────────────────────────────────────────────────────────
    //
    // Handled separately from the status update so that a refund failure doesn't
    // undo the cancellation. The user can retry the cancel route if the refund
    // fails (isRefunded guard won't block because it wasn't set).
    try {
      if (refundAmount && refundAmount > 0) {
        await addCredits(userId, refundAmount, {
          context:  'book_creation_cancelled',
          metadata: { bookId, generationStep: data.generationStep, originalCost: BOOK_GENERATION_COST, refundAmount },
        });
      }

      // Stamp the refund timestamp only after confirmed success
      await dbWrite
        .update(bookGenerations)
        .set({ isRefunded: new Date() })
        .where(eq(bookGenerations.bookId, bookId));

      const refundMsg = refundAmount
        ? `${refundAmount}/${BOOK_GENERATION_COST} credits refunded`
        : 'no refund (generation had not started)';
      console.log(`[POST /api/books/:bookId/cancel] ✅ Book ${bookId} cancelled, ${refundMsg} for user ${userId}`);
    } catch (refundError) {
      console.error(`[POST /api/books/:bookId/cancel] ❌ Failed to refund credits for book ${bookId}:`, refundError);
      // Return 500 so the client knows to retry; status is already 'cancelled'.
      return c.json({ error: 'Failed to refund credits' }, 500);
    }

    // ── Keep the draft book for retryability ───────────────────────────────────
    //
    // The `books` row is preserved as `status: 'draft'` so the user can retry
    // the generation later without re-entering their theme and MC. The book is
    // hidden from feeds (only appears in the user's creations tab with a
    // "cancelled" badge). The bookGenerations row is kept alongside it.
    // Only an explicit DELETE from the user permanently removes the record.
    await dbWrite
      .update(books)
      .set({ status: 'draft', updatedAt: new Date() })
      .where(eq(books.id, bookId));
    invalidateBookCache(bookId);
    invalidateEnrichedBookCache(bookId);

    const message = refundAmount
      ? `Book generation cancelled. ${refundAmount} credit${refundAmount === 1 ? '' : 's'} refunded.`
      : 'Book generation cancelled.';
    return c.json({ success: true, message });
  } catch (error) {
    console.error('[POST /api/books/:bookId/cancel] ❌ Error:', error);
    return cApiError(c, 'Failed to cancel book generation', error);
  }
});

/**
 * POST /api/books/:bookId/retry
 *
 * Retries a failed or cancelled async book generation by resetting the
 * generation state and re-dispatching the GitHub Actions workflow.
 *
 * **Finding retryable books:**
 * All draft books (including cancelled/failed) appear in the user's creations
 * tab filtered by draft status:
 * ```
 * GET /api/books/explore?sortBy=creations&status=draft
 * ```
 * Use `GET /api/books/:bookId/status` to check the generation status before
 * retrying.
 *
 * **Guards:**
 * - Only `failed` or `cancelled` generations can be retried. Completed or
 *   in-progress generations are rejected.
 * - The user must own the book.
 *
 * **What it does:**
 * 1. Validates book ownership and that `generationStatus` is retryable
 * 2. Re-consumes credits via `executeWithCredits` (they were refunded on
 *    failure/cancellation — the retry is a fresh attempt with a new deduction)
 * 3. Resets `generationStatus` → `'pending'`, clears `generationError`,
 *    `isGeneratingStartedAt`, `generationCompletedAt`, and `isRefunded`
 * 4. Dispatches the `on-demand-book-creation.yml` workflow (fire-and-forget)
 *
 * **Credit note:**
 * Credits are re-consumed atomically with the state reset. If the original
 * generation was refunded (cancelled or failed), the user pays again for the
 * retry. Generations still in progress are not retryable — cancel first.
 *
 * @route   POST /api/books/:bookId/retry
 * @auth    Required
 * @param   bookId - UUID v7 of the target book
 * @returns `{ success: true, message: string }` on success
 *
 * @example
 * // Success
 * POST /api/books/01912345-6789-1234-5678-123456789012/retry
 * → 200 { "success": true, "message": "Book generation retry initiated. 5 credits consumed." }
 *
 * // Not retryable
 * → 400 { "error": "Book generation is not in a retryable state (current: completed)" }
 */
router.post('/:bookId/retry', requireAuth, async (c) => {
  try {
    const { bookId } = c.req.param();
    const userId = c.get("userId")!;

    if (!isValidUuid(bookId)) {
      return cValidationError(c, 'Invalid book ID format');
    }

    const [data] = await dbRead
      .select({
        bookUserId:       books.userId,
        generationStatus: bookGenerations.generationStatus,
        isRefunded:       bookGenerations.isRefunded,
        mode:             bookGenerations.mode,
      })
      .from(books)
      .leftJoin(bookGenerations, eq(books.id, bookGenerations.bookId))
      .where(eq(books.id, bookId))
      .limit(1);

    if (!data) {
      return cNotFoundError(c, 'Book not found');
    }

    if (data.bookUserId !== userId) {
      return cForbiddenError(c, 'You can only retry your own books');
    }

    if (data.generationStatus !== 'failed' && data.generationStatus !== 'cancelled') {
      return c.json({
        error: `Book generation is not in a retryable state (current: ${data.generationStatus ?? 'none'})`,
      }, 400);
    }

    // Enforce concurrent generation limit
    if (await isConcurrentGenerationLimitReached(userId, c)) return;

    // Consume credits atomically with resetting the generation state.
    // Credits were refunded when the generation failed or was cancelled,
    // so retrying re-deducts them. Cost matches the book's original mode.
    await executeWithCredits(
      userId,
      getBookModeCreditCost(data.mode),
      async (tx) => {
        await tx
          .update(bookGenerations)
          .set({
            generationStatus:      'pending',
            generationStep:        'theme_validation',
            generationError:       null,
            isGeneratingStartedAt: null,
            generationCompletedAt: null,
            isRefunded:            null,
          })
          .where(eq(bookGenerations.bookId, bookId));
      },
      {
        context:  'book_generation_retry',
        metadata: { bookId },
      },
    );

    const gate = await tryAcquireWorkflowDispatchGate(bookId);
    if (!gate.shouldDispatch) {
      console.log(`[POST /api/books/:bookId/retry] ⏸️ ${gate.reason}`);
      return c.json({
        error: `Cannot retry book generation: ${gate.reason}`,
      }, 409);
    }

    triggerBookGenerationWorkflow(bookId, 'POST /api/books/:bookId/retry');

    const message = `Book generation retry initiated. ${getBookModeCreditCost(data.mode)} credits consumed.`;
    return c.json({ success: true, message });
  } catch (error) {
    console.error('[POST /api/books/:bookId/retry] ❌ Error:', error);
    return cApiError(c, 'Failed to retry book generation', error);
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
router.get("/prompt", optionalAuth, async (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const userId = c.get("userId") || null;
      const language = c.get("headerLanguage") || 'en';
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
        const { stream: aiStream, provider } = await generateBookCreationPromptStream({
          signal: c.req.raw.signal,
          language,
        });
        
        // Collect the full content from the stream
        const chunks: Uint8Array[] = [];
        for await (const chunk of aiStream) {
          chunks.push(chunk);
          await stream.write(chunk);
        }
        
        // Combine chunks to get full content
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const combined = new Uint8Array(totalLen);
        let combinedOffset = 0;
        for (const c of chunks) { combined.set(c, combinedOffset); combinedOffset += c.length; }
        promptContent = new TextDecoder().decode(combined);
        
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
      } else {
        // Stream from cache with simulated typing effect
        const cacheStream = await streamCachedPrompt(promptContent);
        
        // Stream chunks to client
        for await (const chunk of cacheStream) {
          await stream.write(chunk);
        }
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
      const encoder = new TextEncoder();
      const errorMessage = getErrorMessage(error, 'Failed to generate prompt');
      await stream.write(encoder.encode(`event: error\ndata: ${errorMessage}\n\n`));
    }
  });
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
router.post("/insert", requireAuth, async (c) => {
  try {
    const bookData = c.get("body");
    const userId = c.get("userId")!;

    // Add userId to the book data
    const book = await insertBook({ ...bookData, userId });

    c.status(201); return c.json({ book });
  } catch (error) {
    return cApiError(c, "Failed to insert book", error);
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
 * @param visibility - New visibility value (optional)
 * @param status - New status value (optional)
 * @param imageUrl - New cover image URL to upload (optional)
 * @param imageFile - New cover image file from multipart upload (optional)
 * @returns Updated book information
 */
router.put("/:id", requireAuth, imageUploadMiddleware(), async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;
    const { title, hook, summary, keywords, visibility, status: newStatus, imageUrl, mc, ending } = c.get("body");

    // Verify book ownership
    const [book] = await dbRead.select({ 
      id: books.id,
      userId: books.userId,
      slug: books.slug,
      title: books.title,
      keywords: books.keywords,
      imageId: books.imageId,
      status: books.status,
      visibility: books.visibility,
      mc: books.mc,
    })
    .from(books)
    .where(and(
      eq(books.id, id as string),
      eq(books.userId, userId)
    ))
    .limit(1);

    if (!book) return cNotFoundError(c, "Book not found");

    let newImageUrl: string | undefined;
    let newImageId: string | undefined;
    let oldImageIdQueued = false;

    // Handle image upload from different sources
    let imageSource: ImageUploadSource | undefined;

    if (c.get("file")) {
      // Multipart file upload
      imageSource = c.get("file");
    } else if (imageUrl) {
      // URL or base64 string upload
      imageSource = imageUrl;
    }

    let coverUploadResult: Awaited<ReturnType<typeof uploadBookCoverImage>> | null = null;
    let mcAvatarUploadResult: Awaited<ReturnType<typeof uploadBookCharacterAvatarImage>> | null = null;

    // Process image upload if source is provided
    if (imageSource) {
      coverUploadResult = await uploadBookCoverImage(
        {
          id: book.id,
          slug: book.slug ?? undefined,
          title: title || book.title,
          keywords: keywords || book.keywords
        },
        imageSource
      );

      if (!coverUploadResult) {
        return c.json({
          error: "Failed to upload cover image"
        }, 400);
      }

      newImageUrl = coverUploadResult.url;
      newImageId = coverUploadResult.fileId;
    }

    // --- MC avatar image upload ---
    let mcAvatarUploaded = false;
    const oldMcImageId = book.mc?.imageId;
    if (mc?.imageUrl && typeof mc.imageUrl === 'string') {
      mcAvatarUploadResult = await uploadBookCharacterAvatarImage(
        { id: book.id, title: title || book.title, keywords: keywords || book.keywords },
        mc.imageUrl,
      );
      if (mcAvatarUploadResult?.url) {
        mc.imageUrl = mcAvatarUploadResult.url;
        if (mcAvatarUploadResult.fileId) mc.imageId = mcAvatarUploadResult.fileId;
        mcAvatarUploaded = true;
      }
    }

    // Prepare update data (only include provided fields)
    const updateData: DBUpdateBook = {
      updatedAt: new Date(),
    };

    // Sanitize text fields using sanitizeBookTextField
    const sanitizedTitle = sanitizeBookTextField('title', title);
    const sanitizedHook = sanitizeBookTextField('hook', hook);
    const sanitizedSummary = sanitizeBookTextField('summary', summary);

    if (sanitizedTitle !== undefined) updateData.title = sanitizedTitle;
    if (sanitizedHook !== undefined) updateData.hook = sanitizedHook;
    if (sanitizedSummary !== undefined) updateData.summary = sanitizedSummary;
    if (keywords !== undefined) updateData.keywords = sanitizeKeywords(keywords);
    if (visibility !== undefined && bookVisibilities.includes(visibility as BookVisibility)) updateData.visibility = visibility;
    if (newStatus !== undefined && bookStatuses.includes(newStatus as BookStatus)) updateData.status = newStatus;
    if (newImageId) updateData.imageId = newImageId;
    if (mc !== undefined) updateData.mc = mc;
    if (ending !== undefined) updateData.ending = ending;

    let updatedBook: Awaited<ReturnType<typeof updateBook>>;

    try {
      updatedBook = await dbWrite.transaction(async (tx) => {
        if (coverUploadResult?.fileId) {
          await persistUploadedImage({
            imageId: coverUploadResult.fileId,
            imageUrl: coverUploadResult.url!,
            type: 'cover',
            userId,
            client: tx,
          });
        }

        if (mcAvatarUploadResult?.fileId) {
          await persistUploadedImage({
            imageId: mcAvatarUploadResult.fileId,
            imageUrl: mcAvatarUploadResult.url!,
            type: 'mc',
            userId,
            client: tx,
          });
        }

        return updateBook(book.id, updateData, { client: tx, invalidateCache: false });
      });
    } catch (error) {
      if (coverUploadResult?.fileId) {
        await deleteFileFromImageKit(coverUploadResult.fileId);
      }
      if (mcAvatarUploadResult?.fileId) {
        await deleteFileFromImageKit(mcAvatarUploadResult.fileId);
      }
      throw error;
    }

    // Invalidate user's book cache
    await invalidateUserBooksCache(userId);

    // Invalidate popular tags cache if keywords were updated
    if (keywords !== undefined) {
      invalidatePopularTagsCache();
    }

    // Invalidate explore cache only if this public+active book's metadata changed,
    // or if visibility/status changed in a way that affects explore visibility
    await invalidateExploreCache({ before: book, after: updatedBook });

    // Delete old image from ImageKit (with fallback to deletion queue)
    if (coverUploadResult && book.imageId) {
      await deleteFileFromImageKit(book.imageId);
      oldImageIdQueued = true;
    }

    // Delete old MC avatar from ImageKit
    if (mcAvatarUploadResult && oldMcImageId) {
      await deleteFileFromImageKit(oldMcImageId);
    }

    notifyForumOfBookChange({
      before: book,
      after: {
        id: updatedBook.id,
        slug: updatedBook.slug,
        title: updatedBook.title,
        summary: updatedBook.summary,
        hook: updatedBook.hook,
        userId: updatedBook.userId,
        status: updatedBook.status,
        visibility: updatedBook.visibility,
        mode: updatedBook.mode,
        language: updatedBook.language,
        imageUrl: newImageUrl ?? undefined,
      },
    });

    return c.json({
      book: updatedBook,
      imageUploaded: !!newImageUrl,
      oldImageQueuedForDeletion: oldImageIdQueued,
      mcAvatarUploaded,
      uploadSource: c.get("file") ? 'file' : (isBase64Upload(imageUrl) ? 'base64' : 'url'),
    });
  } catch (error) {
    return cApiError(c, "Failed to update book", error);
  }
});

/**
 * PATCH /api/books/:id/visibility
 * 
 * Updates the visibility setting of a book.
 * Controls who can see the book in listings and explore feeds.
 * 
 * Visibility levels:
 * - `private`: Only the owner can see it in their library
 * - `unlisted`: Only accessible via a direct shareable link
 * - `followers`: Owner and their followers can see it in feeds
 * - `public`: Anyone can discover and read it (explorable)
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * @param id - Book ID to update
 * @param visibility - New visibility value ('private' | 'unlisted' | 'followers' | 'public')
 * @returns Updated book with new visibility setting
 * 
 * @example
 * PATCH /api/books/book123/visibility
 * Body: { "visibility": "public" }
 * 
 * Response (200):
 * {
 *   "book": { ... },
 *   "visibility": "public"
 * }
 */
router.patch("/:id/visibility", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const { visibility } = c.get("body");
    const userId = c.get("userId")!;

    // Validate visibility value
    if (!visibility || typeof visibility !== 'string') {
      return cValidationError(c, "visibility is required");
    }

    if (!bookVisibilities.includes(visibility as BookVisibility)) {
      return cValidationError(c, `Invalid visibility. Must be one of: ${bookVisibilities.join(', ')}`);
    }

    // Verify book ownership
    const [book] = await dbRead
      .select({ id: books.id, userId: books.userId, visibility: books.visibility, status: books.status })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book) return cNotFoundError(c, "Book not found");
    if (book.userId !== userId) return cForbiddenError(c, "You can only update visibility for your own books");

    // Update visibility
    const updatedBook = await updateBookVisibility(id as string, visibility as BookVisibility);

    await invalidateUserBooksCache(userId);

    // Invalidate explore cache only if visibility changed to/from 'public'
    // (any change to/from 'public' affects whether the book appears in explore)
    await invalidateExploreCache({ before: book, after: { ...book, visibility: visibility as string } });

    notifyForumOfBookChange({
      before: book,
      after: {
        id: updatedBook.id,
        slug: updatedBook.slug,
        title: updatedBook.title,
        summary: updatedBook.summary,
        hook: updatedBook.hook,
        userId: updatedBook.userId,
        status: updatedBook.status,
        visibility: updatedBook.visibility,
        mode: updatedBook.mode,
        language: updatedBook.language,
      },
    });

    return c.json({
      book: updatedBook,
      visibility: updatedBook.visibility,
    });
  } catch (error) {
    return cApiError(c, "Failed to update book visibility", error);
  }
});

/**
 * PATCH /api/books/:id/archive
 * 
 * Archives or unarchives a book (toggles status between 'active' and 'archived').
 * Archiving removes the book from public listings and explore feeds
 * without deleting it. Unarchiving restores it.
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * @param id - Book ID to update
 * @param status - New status value ('active' | 'archived')
 * @returns Updated book with new status
 * 
 * @example
 * PATCH /api/books/book123/archive
 * Body: { "status": "archived" }
 * 
 * Response (200):
 * {
 *   "book": { ... },
 *   "status": "archived"
 * }
 */
router.patch("/:id/archive", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const { status: newStatus } = c.get("body");
    const userId = c.get("userId")!;

    // Validate status value
    if (!newStatus || typeof newStatus !== 'string') {
      return cValidationError(c, "status is required");
    }

    if (!bookStatuses.includes(newStatus as BookStatus)) {
      return cValidationError(c, `Invalid status. Must be one of: ${bookStatuses.join(', ')}`);
    }

    // Only allow toggling between 'active' and 'archived'
    if (newStatus !== 'active' && newStatus !== 'archived') {
      return cValidationError(c, "Status must be 'active' or 'archived'");
    }

    // Verify book ownership
    const [book] = await dbRead
      .select({ id: books.id, userId: books.userId, status: books.status, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book) return cNotFoundError(c, "Book not found");
    if (book.userId !== userId) return cForbiddenError(c, "You can only archive/unarchive your own books");

    // Update status
    const updatedBook = await updateBook(id as string, { status: newStatus as BookStatus });

    await invalidateUserBooksCache(userId);

    // Invalidate explore cache if the book is public and its status changed to/from 'active'
    await invalidateExploreCache({ before: book, after: { ...book, status: newStatus as string } });

    notifyForumOfBookChange({
      before: book,
      after: {
        id: updatedBook.id,
        slug: updatedBook.slug,
        title: updatedBook.title,
        summary: updatedBook.summary,
        hook: updatedBook.hook,
        userId: updatedBook.userId,
        status: updatedBook.status,
        visibility: updatedBook.visibility,
        mode: updatedBook.mode,
        language: updatedBook.language,
      },
    });

    return c.json({
      book: updatedBook,
      status: updatedBook.status,
    });
  } catch (error) {
    return cApiError(c, "Failed to update book status", error);
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
router.get("/:id/similar", optionalAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const limit = Math.min(parseInt(c.req.query().limit as string) || 10, 50);
    const currentUserId = c.get("userId") || null;

    // Handle array case for id (route params may be string[])
    const bookId = Array.isArray(id) ? id[0] : id;

    // Resolve book by identifier (slug first, then UUID)
    const book = await resolveBook(bookId);
    if (!book) return cNotFoundError(c, "Book not found");
    const targetKeywords = book.keywords;

    // Get similar books with enriched data
    const similarBooksSelect = getSimilarBookSelect(targetKeywords, currentUserId, c.get("headerLanguage"));
    const similarBooks = await dbRead
      .select(similarBooksSelect)
      .from(books)
      // TODO: should add left join to userSessions & firstPageSq
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

    return c.json({
      similarBooks,
      targetBook: {
        id: book.id,
        title: book.title,
        keywords: book.keywords,
      },
    });
  } catch (error) {
    return cApiError(c, "Failed to retrieve similar books", error);
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
 * @query mode - Filter by book creation mode (story format): novel|interactive|multiverse
 * @query status - Filter by comma-separated statuses (only applies with sortBy=creations). Values: active, draft, archived. E.g., "active,draft"
 * @returns Paginated list of books
 * 
 * @remarks
 * - creations: Shows user's own created books (requires authentication). Optionally filtered by `status` query param.
 * - reads: Shows books the user has read, sorted by lastReadAt (requires authentication)
 * - recommendations: Recommends books based on user likes (requires authentication)
 * - favorites: Shows user's saved/favorited books (requires authentication)
 * - All other options: Show published books only (optional authentication, status filter ignored)
 * 
 * @example
 * // Get user's own active and draft books
 * GET /api/books/explore?sortBy=creations&status=active,draft&page=1&limit=20
 * 
 * // Filter published books by mode (story format)
 * GET /api/books/explore?mode=multiverse&sortBy=trending&page=1&limit=20
 * 
 * // Combine mode with other filters
 * GET /api/books/explore?mode=interactive&language=en&ageRange=18-30&tags=thriller,mystery&sortBy=newest
 * 
 * // Response
 * {
 *   "books": [
 *     {
 *       "id": "book1",
 *       "title": "The Whispering Halls",
 *       "status": "active",
 *       "author": { "name": "John Doe", "username": "johndoe" },
 *       "stats": { "readsCount": 150, "likesCount": 32 },
 *       ...
 *     },
 *     {
 *       "id": "book2",
 *       "title": "Shadows of the Past",
 *       "status": "draft",
 *       ...
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 20,
 *     "totalCount": 2,
 *     "totalPages": 1,
 *     "hasNext": false,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/explore", optionalAuth, async (c) => {
  try {
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE, search, sortBy, sortOrder, lastUpdated, language, tags, ageRange, gender, mode, collection, profileUserId } = extractPaginationParams(c.req.query());
    const userId = c.get("userId") || null;
    
    // Extract tags from query parameter (comma-separated)
    const tagsParam = tags as string;
    const tagsArray = tagsParam ? tagsParam.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0) : [];
    
    // Validate search query if provided
    let sanitizedSearch: string | undefined;
    if (search) {
      const validation = validateSearchQuery(search);
      if (!validation.isValid) {
        return cValidationError(c, validation.error || 'Invalid search query');
      }
      sanitizedSearch = validation.sanitized;
    }

    // Validate language code if provided
    let sanitizedLanguage: string | undefined;
    if (language) {
      const langValidation = validateLanguageCode(language);
      if (!langValidation.isValid) {
        return cValidationError(c, langValidation.error || 'Invalid language code');
      }
      sanitizedLanguage = langValidation.sanitized;
    }

    // Validate age range if provided
    let minAge: number | undefined;
    let maxAge: number | undefined;
    if (ageRange) {
      const ageValidation = validateAgeRange(ageRange);
      if (!ageValidation.isValid) {
        return cValidationError(c, ageValidation.error || 'Invalid age range');
      }
      minAge = ageValidation.minAge;
      maxAge = ageValidation.maxAge;
    }

    // Validate gender if provided
    let sanitizedGender: string | undefined;
    if (gender) {
      const genderValidation = validateGender(gender);
      if (!genderValidation.isValid) {
        return cValidationError(c, genderValidation.error || 'Invalid gender');
      }
      sanitizedGender = genderValidation.sanitized;
    }

    // Validate mode if provided
    let sanitizedMode: BookMode | undefined;
    if (mode) {
      if (!bookModes.includes(mode as BookMode)) {
        return cValidationError(c, `Invalid mode value. Must be one of: ${bookModes.join(', ')}`);
      }
      sanitizedMode = mode as BookMode;
    }

    // Validate lastUpdated filter if provided
    if (lastUpdated && !isValidLastUpdatedFilter(lastUpdated)) {
      return cValidationError(c, `Invalid lastUpdated value. Must be: ${lastUpdatedFilterOptions.join(', ')}`);
    }
    
    // Validate and normalize sortBy parameter
    const bookSortBy: BookSortOption = isValidBookSortOption(sortBy || '')
      ? (sortBy as BookSortOption)
      : 'newest';

    // Check if authentication is required for this sort option.
    // When profileUserId is provided for 'creations', 'reads', or 'favorites',
    // we are viewing another user's list — no auth needed since the target user
    // is explicit. 'recommendations' and 'for-you' still require auth because
    // they use the viewer's own reading history.
    const sortNeedsAuth = ['creations', 'reads', 'recommendations', 'favorites', 'for-you'].includes(bookSortBy);
    const profileUserIdBypasses = ['creations', 'reads', 'favorites'];
    const requiresAuth = sortNeedsAuth && !(profileUserId && profileUserIdBypasses.includes(bookSortBy));
    if (requiresAuth && !userId) {
      const emptyBooks: EnrichedBookData[] = [];
      const pagination = calculatePaginationMeta(page, limit, 0);
      return c.json(createPaginatedResponse(emptyBooks, pagination, 'books'));
    }

    // Determine whether these are user's created books (can apply status filtering)
    const isCreations = bookSortBy === 'creations';

    // Extract and validate status filter (comma-separated, e.g. "active,draft")
    let statusFilter: BookStatus[] | undefined;
    if (isCreations) {
      const statusParam = c.req.query().status as string | undefined;
      if (statusParam) {
        const rawStatuses = statusParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        statusFilter = rawStatuses.filter((s): s is BookStatus => bookStatuses.includes(s as BookStatus));
        if (statusFilter.length === 0) {
          return cValidationError(c, `Invalid status value. Must be one or more of: ${bookStatuses.join(', ')}`);
        }
      }
    }

    // Determine base condition based on sort option.
    // When profileUserId is provided (from ?userId=X), we are viewing books
    // by/for a specific user:
    //   - 'creations' → that user's own books (any status)
    //   - 'favorites'/'reads' → public books, filtered by that user's list (handled in sort)
    //   - other sorts → public books authored by that user
    const targetUserId = profileUserId || userId;
    const baseCondition: ReturnType<typeof sql> = isCreations
      ? statusFilter
        ? and(eq(books.userId, targetUserId!), inArray(books.status, statusFilter))!
        : eq(books.userId, targetUserId!) // User's own books regardless of status
      : profileUserId && bookSortBy !== 'favorites' && bookSortBy !== 'reads'
        ? and(eq(books.status, 'active'), eq(books.visibility, 'public'), eq(books.userId, profileUserId))!
        : and(eq(books.status, 'active'), eq(books.visibility, 'public'))!;

    // Cache strategy: don't cache user-specific or filtered queries
    const shouldCache = page === 1 && !profileUserId && !isCreations && !search && tagsArray.length === 0 && !language && !lastUpdated && !ageRange && !gender && !mode && !statusFilter && bookSortBy !== 'reads' && bookSortBy !== 'favorites' && bookSortBy !== 'recommendations' && bookSortBy !== 'for-you';
    const cacheKey = isCreations
      ? `books:user:${targetUserId}:page:${page}`
      : bookSortBy === 'trending'
      ? CACHE_KEYS.EXPLORE_PAGE_1_TRENDING
      : CACHE_KEYS.EXPLORE_PAGE_1;
    const cacheTTL = bookSortBy === 'trending'
      ? CACHE_TTL.EXPLORE_PAGE_1_TRENDING
      : CACHE_TTL.EXPLORE_PAGE_1;

    // Fetch function for cache
    const fetchBooks = async () => {
      // Build base query with enriched fields
      const baseSelect = getEnrichedBookSelect(userId, c.get("headerLanguage"));
      const baseQuery = dbRead
        .select(sanitizedSearch
          ? { ...baseSelect, relevanceScore: createRelevanceExpression(sanitizedSearch, books) }
          : baseSelect)
        .from(books)
        // TODO: should add left join to userSessions & firstPageSq
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
        mode: sanitizedMode,
        currentUserId: profileUserId || userId, // Use profileUserId for viewing another user's list
        collection, // Filter favorites by collection name
      });

      const [totalCountResult] = await countQuery;
      const totalCount = (totalCountResult?.count as number) ?? 0;

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
      c.header('Cache-Control', `public, max-age=${httpCacheMaxAge}, s-maxage=${httpCacheMaxAge}, stale-while-revalidate=${httpCacheMaxAge / 2}`);
    }
    
    // Update user activity in background for authenticated users
    if (userId) {
      void updateUserLastActivity(userId);
    }

    return c.json(result);
  } catch (error) {
    return cApiError(c, "Failed to explore books", error);
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
router.get("/tags/popular", async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query().limit as string) || 20, 100);
    
    // Uses LRU cache internally via getPopularTags
    const tags = await getPopularTags(limit);
    
    return c.json({ tags });
  } catch (error) {
    return cApiError(c, "Failed to fetch popular tags", error);
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
router.delete("/:id", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;

    // Get book information before deletion
    const book = await dbRead
      .select({ 
        id: books.id,
        slug: books.slug,
        imageId: books.imageId,
        userId: books.userId,
        status: books.status,
        visibility: books.visibility,
      })
      .from(books)
      .where(and(
        eq(books.id, id as string),
        eq(books.userId, userId)
      ))
      .limit(1);

    if (!book.length) {
      return cNotFoundError(c, "Book not found");
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
    
    // Invalidate explore cache only if the deleted book was publicly visible
    await invalidateExploreCache({ book: bookToDelete });

    if (bookToDelete.status === 'active' && bookToDelete.visibility === 'public') {
      notifyForumStoryArchived(bookToDelete.id, bookToDelete.slug);
    }

    return c.json({
      message: "Book deleted successfully",
      bookId: id,
      imageQueuedForDeletion: !!bookToDelete.imageId
    });
  } catch (error) {
    return cApiError(c, "Failed to delete book", error);
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
router.get("/stats", optionalAuth, async (c) => {
  try {
    const stats = await getPublicBookStats();
    return c.json(stats);
  } catch (error) {
    return cApiError(c, "Failed to retrieve book stats", error);
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
router.post("/:id/like", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;
    const { collection } = c.get("body");

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

      // Add to favorites if collection is provided (always upsert)
      let favorited = false;
      if (collection) {
        await tx
          .insert(userFavorites)
          .values({
            userId,
            bookId: id as string,
            collection,
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [userFavorites.userId, userFavorites.bookId],
            set: { collection },
          });
        favorited = true;
      }

      if (existingLike.length > 0) {
        return {
          alreadyLiked: true,
          likesCount: book[0].likesCount,
          favorited,
          collection,
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
        likesCount: updatedBook[0]?.likesCount,
        favorited,
        collection: favorited ? collection : null
      };
    });

    // Invalidate explore cache if the liked book is publicly visible
    const [likedBook] = await dbRead
      .select({ status: books.status, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);
    if (likedBook) {
      await invalidateExploreCache({ book: likedBook });
    }

    // Invalidate user profile cache if book was added to favorites (savedBooksCount changed)
    if (result.favorited) {
      await invalidateUserProfileCache(userId);
    }

    c.status(result.alreadyLiked ? 200 : 200);
    return c.json({
      message: result.alreadyLiked ? "Book already liked" : "Book liked successfully",
      liked: true,
      likesCount: result.likesCount!,
      ...(result.favorited && {
        favorited: true,
        collection: result.collection
      })
    });
  } catch (error) {
    if (getErrorMessage(error) === 'BOOK_NOT_FOUND') {
      return cNotFoundError(c, "Book not found");
    }
    return cApiError(c, "Failed to like book", error);
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
router.delete("/:id/like", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;

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

    // Invalidate explore cache if the unliked book is publicly visible
    const [unlikedBook] = await dbRead
      .select({ status: books.status, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);
    if (unlikedBook) {
      await invalidateExploreCache({ book: unlikedBook });
    }

    if (result.notLiked) {
      return c.json({
        message: "Book not liked",
        liked: false,
        likesCount: result.likesCount
      });
    }

    return c.json({
      message: "Book unliked successfully",
      liked: false,
      likesCount: result.likesCount!
    });
  } catch (error) {
    if (getErrorMessage(error) === 'BOOK_NOT_FOUND') {
      return cNotFoundError(c, "Book not found");
    }
    return cApiError(c, "Failed to unlike book", error);
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
router.post("/:id/favorite", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return cNotFoundError(c, "Book not found");
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
      return c.json({
        message: "Book already in favorites",
        favorited: true
      }, 409);
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

    // Invalidate explore cache if book is publicly visible (trendingScore affects sort order)
    const [favBook] = await dbRead
      .select({ status: books.status, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);
    if (favBook) {
      await invalidateExploreCache({ book: favBook });
    }

    c.status(201); return c.json({
      message: "Book added to favorites",
      favorited: true
    });
  } catch (error) {
    return cApiError(c, "Failed to favorite book", error);
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
router.delete("/:id/favorite", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return cNotFoundError(c, "Book not found");
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
      return c.json({
        message: "Book not in favorites",
        favorited: false
      }, 404);
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

    // Invalidate explore cache if book is publicly visible (trendingScore affects sort order)
    const [unfavBook] = await dbRead
      .select({ status: books.status, visibility: books.visibility })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);
    if (unfavBook) {
      await invalidateExploreCache({ book: unfavBook });
    }

    return c.json({
      message: "Book removed from favorites",
      favorited: false
    });
  } catch (error) {
    return cApiError(c, "Failed to unfavorite book", error);
  }
});

/**
 * PATCH /api/books/favorites/rename-collection
 * 
 * Renames a collection for the authenticated user across all their favorites.
 * Updates every row in user_favorites where collection matches the old name
 * to use the new collection name instead.
 * 
 * **Authentication:** Required (via `requireAuth`)
 * 
 * @body oldCollection - Current collection name to rename
 * @body newCollection - New collection name to apply
 * @returns Updated count of affected rows
 * 
 * @example
 * PATCH /api/books/favorites/rename-collection
 * Body: { "oldCollection": "Thriller", "newCollection": "Horror" }
 * 
 * Response (200):
 * {
 *   "updatedCount": 5,
 *   "message": "Collection renamed successfully"
 * }
 * 
 * @example
 * PATCH /api/books/favorites/rename-collection
 * Body: { "oldCollection": "NonExistent", "newCollection": "Horror" }
 * 
 * Response (200):
 * {
 *   "updatedCount": 0,
 *   "message": "No favorites found with collection 'NonExistent'"
 * }
 */
router.patch("/favorites/rename-collection", requireAuth, async (c) => {
  try {
    const { oldCollection, newCollection } = c.get("body");
    const userId = c.get("userId")!;

    if (!oldCollection || typeof oldCollection !== 'string') {
      return cValidationError(c, "oldCollection is required and must be a string");
    }

    if (!newCollection || typeof newCollection !== 'string') {
      return cValidationError(c, "newCollection is required and must be a string");
    }

    if (oldCollection === newCollection) {
      return c.json({
        updatedCount: 0,
        message: "oldCollection and newCollection are the same — no changes needed",
      });
    }

    const result = await dbWrite
      .update(userFavorites)
      .set({ collection: newCollection })
      .where(and(
        eq(userFavorites.userId, userId),
        eq(userFavorites.collection, oldCollection),
      ));

    const updatedCount = (result as { rowCount?: number })?.rowCount ?? 0;

    return c.json({
      updatedCount,
      message: updatedCount > 0
        ? "Collection renamed successfully"
        : `No favorites found with collection '${oldCollection}'`,
    });
  } catch (error) {
    return cApiError(c, "Failed to rename collection", error);
  }
});

/**
 * GET /api/books/:id/comments
 * 
 * Retrieves all comments for a specific book.
 * Supports pagination for large comment threads.
 *
 * @route GET /api/books/:id/comments
 * @description Get paginated comments for a book
 * @auth Optional (optionalAuth)
 * 
 * @param id - Book ID
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of comments per page (default: 20)
 * @query pageId - Filter to comments on a specific page (optional)
 * @query paragraphNumber - Filter to comments on a specific paragraph within the page (optional, requires pageId)
 * @returns Paginated list of comments with user info
 * 
 * @example
 * GET /api/books/book123/comments?page=1&limit=20
 * GET /api/books/book123/comments?pageId=page456
 * GET /api/books/book123/comments?pageId=page456&paragraphNumber=3
 * 
 * Response (200):
 * {
 *   "comments": [
 *     {
 *       "id": "comment123",
 *       "userId": "user456",
 *       "name": "John Doe",
 *       "imageUrl": "https://example.com/avatar.jpg",
 *       "bookId": "book123",
 *       "pageId": null,
 *       "paragraphNumber": null,
 *       "parentCommentId": null,
 *       "content": "This story is amazing!",
 *       "createdAt": "2023-01-01T00:00:00.000Z",
 *       "updatedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 20,
 *     "totalCount": 42,
 *     "totalPages": 3,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   }
 * }
 */
router.get("/:id/comments", optionalAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE } = extractPaginationParams(c.req.query());
    const { pageId, paragraphNumber } = c.req.query();

    // Check if book exists
    const book = await getBookFromDB(id as string);
    if (!book) return cNotFoundError(c, "Book not found");

    // Build filter conditions (book-scoped, optionally narrowed by page/paragraph)
    const conditions = [eq(userComments.bookId, id as string)];
    if (pageId) {
      conditions.push(eq(userComments.pageId, pageId as string));
      if (paragraphNumber !== undefined && paragraphNumber !== null && paragraphNumber !== '') {
        const parsed = parseInt(paragraphNumber as string, 10);
        if (Number.isNaN(parsed)) {
          return cValidationError(c, "paragraphNumber must be an integer");
        }
        conditions.push(eq(userComments.paragraphNumber, parsed));
      }
    }

    // Get total count using SQL COUNT(*)
    // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
    // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
    const [countResult] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(userComments)
      .where(and(...conditions));
    const totalCount = countResult.count;

    // Get comments with user info
    const offset = (page - 1) * limit;
    const comments = await dbRead
      .select({
        id: userComments.id,
        userId: userComments.userId,
        name: users.name,
        imageUrl: users.imageUrl,
        bookId: userComments.bookId,
        pageId: userComments.pageId,
        paragraphNumber: userComments.paragraphNumber,
        parentCommentId: userComments.parentCommentId,
        content: userComments.content,
        createdAt: userComments.createdAt,
        updatedAt: userComments.updatedAt
      } satisfies Record<keyof UserComment, unknown>)
      .from(userComments)
      .leftJoin(users, eq(userComments.userId, users.userId))
      .where(and(...conditions))
      .orderBy(desc(userComments.createdAt))
      .limit(limit)
      .offset(offset);

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    return c.json({
      comments,
      pagination
    });
  } catch (error) {
    return cApiError(c, "Failed to retrieve comments", error);
  }
});

/**
 * POST /api/books/:id/comments
 * 
 * Creates a new comment on a book.
 * Supports threaded comments via parentCommentId.
 *
 * @route POST /api/books/:id/comments
 * @description Create a comment on a book
 * @auth Required (requireAuth)
 * 
 * @param id - Book ID
 * @body {string} content - Comment content (max 5000 chars)
 * @body {string} [parentCommentId] - Parent comment ID for replies
 * @body {string} [pageId] - Page ID when commenting on a specific page
 * @body {number} [paragraphNumber] - 1-based paragraph number when commenting on a paragraph (requires pageId)
 * @returns Created comment with user info
 * 
 * @example
 * POST /api/books/book123/comments
 * Body: { "content": "This story is amazing!", "parentCommentId": "comment789" }
 * 
 * POST /api/books/book123/comments
 * Body: { "content": "Loved this page!", "pageId": "page456" }
 * 
 * POST /api/books/book123/comments
 * Body: { "content": "This paragraph was intense", "pageId": "page456", "paragraphNumber": 3 }
 * 
 * Response (201):
 * {
 *   "comment": {
 *     "id": "comment123",
 *     "userId": "user456",
 *     "name": "John Doe",
 *     "imageUrl": "https://example.com/avatar.jpg",
 *     "bookId": "book123",
 *     "pageId": null,
 *     "paragraphNumber": null,
 *     "parentCommentId": null,
 *     "content": "This story is amazing!",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T00:00:00.000Z"
 *   }
 * }
 */
router.post("/:id/comments", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const { content, parentCommentId, pageId, paragraphNumber } = c.get("body");
    const userId = c.get("userId")!;

    const contentError = validateCommentContent(content);
    if (contentError) return c.json({ error: contentError }, 400);

    // Normalize and validate optional page/paragraph scope
    let normalizedPageId: string | null = null;
    let normalizedParagraphNumber: number | null = null;
    if (pageId) {
      if (typeof pageId !== 'string') {
        return cValidationError(c, "pageId must be a string");
      }
      normalizedPageId = pageId;
      if (paragraphNumber !== undefined && paragraphNumber !== null) {
        const parsed = parseInt(paragraphNumber, 10);
        if (Number.isNaN(parsed) || parsed < 1) {
          return cValidationError(c, "paragraphNumber must be a positive integer");
        }
        normalizedParagraphNumber = parsed;
      }
    } else if (paragraphNumber !== undefined && paragraphNumber !== null) {
      return cValidationError(c, "paragraphNumber requires pageId");
    }

    // Check if book exists
    const book = await dbRead
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, id as string))
      .limit(1);

    if (!book.length) {
      return cNotFoundError(c, "Book not found");
    }

    // Validate pageId belongs to this book when provided
    if (normalizedPageId) {
      const [page] = await dbRead
        .select({ id: pages.id, bookId: pages.bookId })
        .from(pages)
        .where(eq(pages.id, normalizedPageId!))
        .limit(1);

      if (!page) {
        return cNotFoundError(c, "Page not found");
      }

      if (page.bookId !== id) {
        return cValidationError(c, "Page does not belong to this book");
      }
    }

    // Validate parentCommentId if provided
    if (parentCommentId) {
      const [parentComment] = await dbRead
        .select({ id: userComments.id, bookId: userComments.bookId, pageId: userComments.pageId, paragraphNumber: userComments.paragraphNumber })
        .from(userComments)
        .where(eq(userComments.id, parentCommentId))
        .limit(1);

      if (!parentComment) {
        return cNotFoundError(c, "Parent comment not found");
      }

      if (parentComment.bookId !== id) {
        return cValidationError(c, "Parent comment does not belong to this book");
      }

      // Replies must live in the same scope as the parent comment
      if ((parentComment.pageId ?? null) !== normalizedPageId) {
        return cValidationError(c, "Parent comment does not belong to this page");
      }
      if ((parentComment.paragraphNumber ?? null) !== normalizedParagraphNumber) {
        return cValidationError(c, "Parent comment does not belong to this paragraph");
      }
    }

    // Sanitize content for DB and safety
    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return cValidationError(c, 'Content is required and cannot be empty after sanitization');
    }

    // Create comment and fetch user info in a single transaction to ensure consistency
    const commentWithUser = await dbWrite.transaction(async (tx) => {
      const [newComment] = await tx.insert(userComments).values({
        userId,
        bookId: id as string,
        pageId: normalizedPageId,
        paragraphNumber: normalizedParagraphNumber,
        parentCommentId: parentCommentId || null,
        content: cleanContent,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      const [joined] = await tx
        .select({
          id: userComments.id,
          userId: userComments.userId,
          name: users.name,
          imageUrl: users.imageUrl,
          bookId: userComments.bookId,
          pageId: userComments.pageId,
          paragraphNumber: userComments.paragraphNumber,
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

    c.status(201); return c.json({ comment: commentWithUser });
  } catch (error) {
    return cApiError(c, "Failed to create comment", error);
  }
});

/**
 * Shared helper: validate raw comment content from the request body.
 * Returns a human-readable error string when invalid, or null when valid.
 */
function validateCommentContent(content: unknown): string | null {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return "Content is required and must be a non-empty string";
  }
  if (content.length > 5000) {
    return "Content exceeds maximum length of 5000 characters";
  }
  return null;
}

/**
 * Shared helper: validate that a page belongs to the given book.
 * Returns the page row (with bookId) or null when not found / mismatched.
 */
async function findPageInBook(pageId: string, bookId: string): Promise<{ id: string; bookId: string } | null> {
  const [page] = await dbRead
    .select({ id: pages.id, bookId: pages.bookId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!page || page.bookId !== bookId) return null;
  return page;
}

/**
 * Shared helper: create a comment within a resolved scope and return it joined with user info.
 */
async function createCommentInScope(
  userId: string,
  bookId: string,
  content: string,
  scope: { pageId: string | null; paragraphNumber: number | null },
  parentCommentId?: string,
): Promise<Record<keyof UserComment, unknown>> {
  return dbWrite.transaction(async (tx) => {
    const [newComment] = await tx.insert(userComments).values({
      userId,
      bookId,
      pageId: scope.pageId,
      paragraphNumber: scope.paragraphNumber,
      parentCommentId: parentCommentId || null,
      content,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    const [joined] = await tx
      .select({
        id: userComments.id,
        userId: userComments.userId,
        name: users.name,
        imageUrl: users.imageUrl,
        bookId: userComments.bookId,
        pageId: userComments.pageId,
        paragraphNumber: userComments.paragraphNumber,
        parentCommentId: userComments.parentCommentId,
        content: userComments.content,
        createdAt: userComments.createdAt,
        updatedAt: userComments.updatedAt,
      } satisfies Record<keyof UserComment, unknown>)
      .from(userComments)
      .leftJoin(users, eq(userComments.userId, users.userId))
      .where(eq(userComments.id, newComment.id))
      .limit(1);

    return joined;
  });
}

/**
 * Shared helper: fetch paginated comments for a given book-scoped condition set.
 */
async function fetchComments(
  bookId: string,
  conditions: ReturnType<typeof eq>[],
  page: number,
  limit: number,
): Promise<{ comments: Record<keyof UserComment, unknown>[]; pagination: ReturnType<typeof calculatePaginationMeta> }> {
  const [countResult] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userComments)
    .where(and(...conditions));
  const totalCount = countResult.count;

  const offset = (page - 1) * limit;
  const comments = await dbRead
    .select({
      id: userComments.id,
      userId: userComments.userId,
      name: users.name,
      imageUrl: users.imageUrl,
      bookId: userComments.bookId,
      pageId: userComments.pageId,
      paragraphNumber: userComments.paragraphNumber,
      parentCommentId: userComments.parentCommentId,
      content: userComments.content,
      createdAt: userComments.createdAt,
      updatedAt: userComments.updatedAt,
    } satisfies Record<keyof UserComment, unknown>)
    .from(userComments)
    .leftJoin(users, eq(userComments.userId, users.userId))
    .where(and(...conditions))
    .orderBy(desc(userComments.createdAt))
    .limit(limit)
    .offset(offset);

  const pagination = calculatePaginationMeta(page, limit, totalCount);
  return { comments, pagination };
}

/**
 * GET /api/books/:id/pages/:pageId/comments
 *
 * Retrieves all comments scoped to a specific page of a book, optionally narrowed
 * to a single paragraph. Supports pagination for large comment threads.
 *
 * @route GET /api/books/:id/pages/:pageId/comments
 * @description Get paginated comments for a page (and optionally a paragraph)
 * @auth Optional (optionalAuth)
 *
 * @param id - Book ID
 * @param pageId - Page ID
 * @query paragraphNumber - Filter to comments on a specific paragraph (optional)
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of comments per page (default: 20)
 * @returns Paginated list of comments with user info
 *
 * @example
 * GET /api/books/book123/pages/page456/comments
 * GET /api/books/book123/pages/page456/comments?paragraphNumber=3
 */
router.get("/:id/pages/:pageId/comments", optionalAuth, async (c) => {
  try {
    const { id, pageId } = c.req.param();
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE } = extractPaginationParams(c.req.query());
    const { paragraphNumber } = c.req.query();

    const book = await getBookFromDB(id as string);
    if (!book) return cNotFoundError(c, "Book not found");

    const pageRow = await findPageInBook(pageId as string, id as string);
    if (!pageRow) return cNotFoundError(c, "Page not found");

    const conditions = [eq(userComments.bookId, id as string), eq(userComments.pageId, pageId as string)];
    if (paragraphNumber !== undefined && paragraphNumber !== null && paragraphNumber !== '') {
      const parsed = parseInt(paragraphNumber as string, 10);
      if (Number.isNaN(parsed)) {
        return cValidationError(c, "paragraphNumber must be an integer");
      }
      conditions.push(eq(userComments.paragraphNumber, parsed));
    }

    const { comments, pagination } = await fetchComments(id as string, conditions, page, limit);
    return c.json({ comments, pagination });
  } catch (error) {
    return cApiError(c, "Failed to retrieve page comments", error);
  }
});

/**
 * POST /api/books/:id/pages/:pageId/comments
 *
 * Creates a new comment on a specific page of a book. Supports threaded replies
 * (via parentCommentId) and paragraph-level scoping via `paragraphNumber`.
 *
 * @route POST /api/books/:id/pages/:pageId/comments
 * @description Create a comment on a page (optionally on a paragraph)
 * @auth Required (requireAuth)
 *
 * @param id - Book ID
 * @param pageId - Page ID
 * @body {string} content - Comment content (max 5000 chars)
 * @body {string} [parentCommentId] - Parent comment ID for replies
 * @body {number} [paragraphNumber] - 1-based paragraph number within the page
 * @returns Created comment with user info
 *
 * @example
 * POST /api/books/book123/pages/page456/comments
 * Body: { "content": "Loved this page!" }
 *
 * POST /api/books/book123/pages/page456/comments
 * Body: { "content": "This paragraph was intense", "paragraphNumber": 3 }
 */
router.post("/:id/pages/:pageId/comments", requireAuth, async (c) => {
  try {
    const { id, pageId } = c.req.param();
    const { content, parentCommentId, paragraphNumber } = c.get("body");
    const userId = c.get("userId")!;

    const contentError = validateCommentContent(content);
    if (contentError) return c.json({ error: contentError }, 400);

    const book = await dbRead.select({ id: books.id }).from(books).where(eq(books.id, id as string)).limit(1);
    if (!book.length) return cNotFoundError(c, "Book not found");

    const pageRow = await findPageInBook(pageId as string, id as string);
    if (!pageRow) return cNotFoundError(c, "Page not found");

    let normalizedParagraphNumber: number | null = null;
    if (paragraphNumber !== undefined && paragraphNumber !== null) {
      const parsed = parseInt(paragraphNumber, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        return cValidationError(c, "paragraphNumber must be a positive integer");
      }
      normalizedParagraphNumber = parsed;
    }

    // Validate parentCommentId + scope consistency
    if (parentCommentId) {
      const [parentComment] = await dbRead
        .select({ id: userComments.id, bookId: userComments.bookId, pageId: userComments.pageId, paragraphNumber: userComments.paragraphNumber })
        .from(userComments)
        .where(eq(userComments.id, parentCommentId))
        .limit(1);

      if (!parentComment) return cNotFoundError(c, "Parent comment not found");
      if (parentComment.bookId !== id) return cValidationError(c, "Parent comment does not belong to this book");
      if ((parentComment.pageId ?? null) !== pageId) return cValidationError(c, "Parent comment does not belong to this page");
      if ((parentComment.paragraphNumber ?? null) !== normalizedParagraphNumber) return cValidationError(c, "Parent comment does not belong to this paragraph");
    }

    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return cValidationError(c, "Content is required and cannot be empty after sanitization");
    }

    const comment = await createCommentInScope(userId, id as string, cleanContent, {
      pageId: pageId as string,
      paragraphNumber: normalizedParagraphNumber,
    }, parentCommentId);

    c.status(201); return c.json({ comment });
  } catch (error) {
    return cApiError(c, "Failed to create page comment", error);
  }
});

/**
 * GET /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments
 *
 * Retrieves all comments scoped to a specific paragraph of a page.
 * Convenience route equivalent to
 * `GET /api/books/:id/pages/:pageId/comments?paragraphNumber=N`.
 *
 * @route GET /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments
 * @description Get paginated comments for a single paragraph
 * @auth Optional (optionalAuth)
 *
 * @param id - Book ID
 * @param pageId - Page ID
 * @param paragraphNumber - 1-based paragraph number
 * @query page - Page number for pagination (default: 1)
 * @query limit - Number of comments per page (default: 20)
 * @returns Paginated list of comments with user info
 *
 * @example
 * GET /api/books/book123/pages/page456/paragraphs/3/comments
 */
router.get("/:id/pages/:pageId/paragraphs/:paragraphNumber/comments", optionalAuth, async (c) => {
  try {
    const { id, pageId, paragraphNumber } = c.req.param();
    const { page = 1, limit = DEFAULT_ITEMS_PER_PAGE } = extractPaginationParams(c.req.query());

    const book = await getBookFromDB(id as string);
    if (!book) return cNotFoundError(c, "Book not found");

    const pageRow = await findPageInBook(pageId as string, id as string);
    if (!pageRow) return cNotFoundError(c, "Page not found");

    const parsedParagraph = parseInt(paragraphNumber as string, 10);
    if (Number.isNaN(parsedParagraph) || parsedParagraph < 1) {
      return cValidationError(c, "paragraphNumber must be a positive integer");
    }

    const conditions = [
      eq(userComments.bookId, id as string),
      eq(userComments.pageId, pageId as string),
      eq(userComments.paragraphNumber, parsedParagraph),
    ];

    const { comments, pagination } = await fetchComments(id as string, conditions, page, limit);
    return c.json({ comments, pagination });
  } catch (error) {
    return cApiError(c, "Failed to retrieve paragraph comments", error);
  }
});

/**
 * POST /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments
 *
 * Creates a new comment on a specific paragraph of a page. Supports threaded
 * replies (via parentCommentId).
 *
 * @route POST /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments
 * @description Create a comment on a paragraph
 * @auth Required (requireAuth)
 *
 * @param id - Book ID
 * @param pageId - Page ID
 * @param paragraphNumber - 1-based paragraph number
 * @body {string} content - Comment content (max 5000 chars)
 * @body {string} [parentCommentId] - Parent comment ID for replies
 * @returns Created comment with user info
 *
 * @example
 * POST /api/books/book123/pages/page456/paragraphs/3/comments
 * Body: { "content": "This paragraph was intense" }
 */
router.post("/:id/pages/:pageId/paragraphs/:paragraphNumber/comments", requireAuth, async (c) => {
  try {
    const { id, pageId, paragraphNumber } = c.req.param();
    const { content, parentCommentId } = c.get("body");
    const userId = c.get("userId")!;

    const contentError = validateCommentContent(content);
    if (contentError) return c.json({ error: contentError }, 400);

    const parsedParagraph = parseInt(paragraphNumber as string, 10);
    if (Number.isNaN(parsedParagraph) || parsedParagraph < 1) {
      return cValidationError(c, "paragraphNumber must be a positive integer");
    }

    const book = await dbRead.select({ id: books.id }).from(books).where(eq(books.id, id as string)).limit(1);
    if (!book.length) return cNotFoundError(c, "Book not found");

    const pageRow = await findPageInBook(pageId as string, id as string);
    if (!pageRow) return cNotFoundError(c, "Page not found");

    if (parentCommentId) {
      const [parentComment] = await dbRead
        .select({ id: userComments.id, bookId: userComments.bookId, pageId: userComments.pageId, paragraphNumber: userComments.paragraphNumber })
        .from(userComments)
        .where(eq(userComments.id, parentCommentId))
        .limit(1);

      if (!parentComment) return cNotFoundError(c, "Parent comment not found");
      if (parentComment.bookId !== id) return cValidationError(c, "Parent comment does not belong to this book");
      if ((parentComment.pageId ?? null) !== pageId) return cValidationError(c, "Parent comment does not belong to this page");
      if ((parentComment.paragraphNumber ?? null) !== parsedParagraph) return cValidationError(c, "Parent comment does not belong to this paragraph");
    }

    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return cValidationError(c, "Content is required and cannot be empty after sanitization");
    }

    const comment = await createCommentInScope(userId, id as string, cleanContent, {
      pageId: pageId as string,
      paragraphNumber: parsedParagraph,
    }, parentCommentId);

    c.status(201); return c.json({ comment });
  } catch (error) {
    return cApiError(c, "Failed to create paragraph comment", error);
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
router.delete("/comments/:id", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const userId = c.get("userId")!;

    // Check if comment exists and user owns it
    const comment = await dbRead
      .select({ id: userComments.id, userId: userComments.userId, parentCommentId: userComments.parentCommentId })
      .from(userComments)
      .where(eq(userComments.id, id as string))
      .limit(1);

    if (!comment.length) {
      return cNotFoundError(c, "Comment not found");
    }

    if (comment[0].userId !== userId) {
      return cForbiddenError(c, "You can only delete your own comments");
    }

    // Delete comment
    await dbWrite
      .delete(userComments)
      .where(eq(userComments.id, id as string));

    // TODO: stale-while-revalidate instead when book detail opened
    // // Invalidate explore cache if parent comment (commentsCount changes)
    // if (!comment[0].parentCommentId) {
    //   await invalidateExploreCache();
    // }

    return c.json({
      message: "Comment deleted successfully"
    });
  } catch (error) {
    return cApiError(c, "Failed to delete comment", error);
  }
});

/**
 * PUT /api/books/comments/:id
 *
 * Updates a comment. Only the original author can update their own comments.
 *
 * @param id - Comment ID to update
 * @body content - Updated comment content (required)
 * @returns Updated comment record
 *
 * @example
 * PUT /api/books/comments/comment123
 * Body: { "content": "Updated comment content" }
 *
 * Response (200):
 * {
 *   "comment": {
 *     "id": "comment123",
 *     "userId": "user456",
 *     "bookId": "book123",
 *     "pageId": "page456",
 *     "paragraphNumber": 3,
 *     "parentCommentId": null,
 *     "content": "Updated comment content",
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-01T12:00:00.000Z"
 *   }
 * }
 */
router.put("/comments/:id", requireAuth, async (c) => {
  try {
    const { id } = c.req.param();
    const { content } = c.get("body");
    const userId = c.get("userId")!;

    const contentError = validateCommentContent(content);
    if (contentError) return c.json({ error: contentError }, 400);

    // Sanitize content before storing
    const cleanContent = sanitizeTextForDB(String(content).trim());
    if (!cleanContent || cleanContent.length === 0) {
      return cValidationError(c, "Comment content is empty after sanitization");
    }

    // Check if comment exists and belongs to user
    const existingComment = await dbRead
      .select({ id: userComments.id, userId: userComments.userId })
      .from(userComments)
      .where(eq(userComments.id, id as string))
      .limit(1);

    if (!existingComment.length) {
      return cNotFoundError(c, "Comment not found");
    }

    if (existingComment[0].userId !== userId) {
      return cForbiddenError(c, "You can only edit your own comments");
    }

    // Update comment
    const [comment] = await dbWrite
      .update(userComments)
      .set({
        content: cleanContent,
        updatedAt: new Date(),
      })
      .where(and(
        eq(userComments.id, id as string),
        eq(userComments.userId, userId)
      ))
      .returning();

    return c.json({ comment });
  } catch (error) {
    return cApiError(c, "Failed to update comment", error);
  }
});

/**
 * GET /api/books/comments
 *
 * Retrieves comments by the authenticated user, optionally filtered by book.
 *
 * @query bookId - Filter by book ID (optional)
 * @query limit - Maximum number of results (default: 50)
 * @query offset - Pagination offset (default: 0)
 * @returns Array of comment records
 *
 * @example
 * GET /api/books/comments?bookId=book123&limit=10
 *
 * Response (200):
 * {
 *   "comments": [
 *     {
 *       "id": "comment123",
 *       "userId": "user456",
 *       "bookId": "book123",
 *       "pageId": "page456",
 *       "paragraphNumber": 3,
 *       "parentCommentId": null,
 *       "content": "This story is amazing!",
 *       "createdAt": "2023-01-01T00:00:00.000Z",
 *       "updatedAt": "2023-01-01T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
router.get("/comments", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const { bookId, limit = "50", offset = "0" } = c.req.query();

    // Build base query conditions
    const baseConditions = [eq(userComments.userId, userId)];

    // Add book filter if provided
    if (bookId) {
      baseConditions.push(eq(userComments.bookId, bookId as string));
    }

    const comments = await dbRead
      .select()
      .from(userComments)
      .where(and(...baseConditions))
      .orderBy(desc(userComments.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    return c.json({ comments });
  } catch (error) {
    return cApiError(c, "Failed to retrieve comments", error);
  }
});

/**
 * GET /api/books/:identifier/branches
 *
 * Retrieves all branches (id & display name) for a book.
 * Accepts both slug and UUID v7 as book identifier.
 *
 * Returns an array of { branchId, displayName } for all non-main branches,
 * plus the main branch entry with the book's title as display name.
 *
 * @param identifier - Book slug or UUID v7
 * @returns Array of branch objects with id and name
 *
 * @example
 * GET /api/books/twistloom/branches
 * Response 200:
 * [
 *   { "branchId": "main", "displayName": "The Whispering Halls" },
 *   { "branchId": "0194f2d1-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "displayName": "The Dark Path" }
 * ]
 */
router.get("/:identifier/branches", optionalAuth, async (c) => {
  try {
    const { identifier } = c.req.param();
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    // Resolve book ID from identifier
    const bookId = isValidUuid(bookIdentifier)
      ? bookIdentifier
      : (await dbRead
          .select({ id: books.id })
          .from(books)
          .where(eq(books.slug, bookIdentifier))
          .limit(1)
          .then(rows => rows[0]?.id ?? null));

    if (!bookId) return cNotFoundError(c, "Book not found");

    // Fetch book to get the title for the main branch
    const book = await getBook(bookId);
    if (!book) return cNotFoundError(c, "Book not found");

    // Fetch non-main branches from the branches table
    const branchRows = await dbRead
      .select({
        branchId: branches.branchId,
        displayName: branches.displayName,
      })
      .from(branches)
      .where(eq(branches.bookId, bookId))
      .orderBy(branches.createdAt);

    // Construct the list with the main branch first
    const result = [
      { branchId: "main", displayName: book.title },
      ...branchRows,
    ];

    return c.json(result);
  } catch (error) {
    return cApiError(c, "Failed to retrieve branches", error);
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
router.get("/:identifier/:pageId", optionalAuth, async (c) => {
  try {
    const headerLanguage = c.get("headerLanguage");
    const { identifier, pageId } = c.req.param();
    const { prefetch, translate: shouldTranslate, credits, actioning } = c.req.query();
    const userId = c.get("userId");
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier; // Book slug or id (uuid v7)
    const skipVisit = !userId || prefetch === 'true' || c.req.method === 'HEAD'; // Skip for non-actual user navigation
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
    }, { c });

    // Response already sent by `visitBookPage` internally
    if (!dbPage || !book) return;

    // Access control: reject if book is archived or private and user is not the owner
    if ((book.status === 'archived' || book.visibility === 'private') && (!c.get("userId") || c.get("userId") !== book.userId)) {
      if (!c.get("userId")) return cUnauthorizedError(c, "Authentication required to view this book");
      return cForbiddenError(c, "You do not have access to this book");
    }

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

    if (!page) return cApiError(c, "Failed to get enriched page");

    // Generate ETag from page updatedAt + userId + translation params (different content per user/language)
    const lastModified = dbPage.updatedAt;
    const etagInput = `${lastModified.getTime()}-${userId}-${translate}-${headerLanguage || 'en'}`;
    const etag = `"${etagInput}"`;

    // Check If-None-Match header (ETag includes translation params)
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304);

    // Set caching headers
    c.header('Last-Modified', lastModified.toUTCString());
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=60'); // 1 minute (pages update more frequently)

    return c.json({
      page,
      book,
      visitDetails
    });
  } catch (error) {
    return cApiError(c, "Failed to retrieve page", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/confirm-visit
 *
 * Confirms a user's visit to a specific page and records it in the user's
 * reading progress. Called when a user actively navigates to a page (via
 * selecting an action), as opposed to prefetching.
 *
 * @route POST /api/books/:identifier/:pageId/confirm-visit
 * @description Record user page visit and optionally consume credits
 * @auth Required (requireAuth)
 *
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page identifier
 * @body {boolean} [consumeCredits] - Whether to consume credits for this page
 *
 * @returns Object with visit details including progress info
 *
 * @example
 * POST /api/books/whispering-halls/page456/confirm-visit
 * Body: { "consumeCredits": false }
 *
 * Response (200):
 * { "visitDetails": { "userId": "user456", "bookId": "book123", "pageId": "page456", "lastPageNumber": 5, "isCompleted": false } }
 */
router.post('/:identifier/:pageId/confirm-visit', requireAuth, async (c) => {
  const { identifier: bookIdentifier, pageId } = c.req.param();
  const { consumeCredits } = c.get("body") as { actionedPageId?: string; consumeCredits?: boolean };
  const userId = c.get("userId")!;

  const { visitDetails, dbPage, book } = await visitBookPage(
    { userId, pageId: pageId as string, bookIdentifier: bookIdentifier as string, skipVisit: false, takeAction: true, consumeCredits: !!consumeCredits, language: c.req.header('accept-language') },
    { c }
  );
  if (!dbPage || !book) return; // visitBookPage already sent the error response

  return c.json({ visitDetails });
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
router.get("/:identifier/:pageId/candidates", requireAuth, async (c) => {
  try {
    const { identifier, pageId } = c.req.param();
    const userId = c.get("userId")!;

    // Handle array case for identifier and pageId (harmless no-op on Hono string params)
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;

    if (!isValidUuid(pageIdStr)) {
      return cValidationError(c, "Invalid pageId: must be valid uuid");
    }

    // Use common validation and page retrieval
    const validationResult = await validateAndRetrievePageForGeneration(bookIdentifier, pageIdStr, userId);
    if (!validationResult) {
      return cNotFoundError(c, "Page not found");
    }

    const { dbBook, dbPage, userPage, isGenerating, isDone } = validationResult;

    return streamSSE(c, async (stream) => {
      // Check if some actions need generation
      if (isDone) {
        console.log(`[GET /candidates] ℹ️ No actions need generation for page ${pageIdStr}, sending SSE complete event`);
        try {
          await stream.writeSSE({ event: 'complete', data: JSON.stringify(userPage) });
          // Clear all progress events in database since generation is complete
          await clearActionProgressEvents(pageIdStr);
        } catch {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Failed to process page data' }) });
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
        stream,
        initialMessage,
        getPageFromDB: (pid) => getPageFromDB(pid, { client: dbWrite }),
        mapToUserStoryPage,
        getActionProgressEvents,
        clearActionProgressEvents,
        config: SSE_POLLING_CONFIG,
        signal: c.req.raw.signal,
      });
    });
  } catch (error) {
    return cApiError(c, "Failed to generate candidates", error);
  }
});

/**
 * GET /api/books/:identifier/:pageId/candidates/status
 * 
 * Polling endpoint for candidate generation status.
 * 
 * Returns current `CandidateGenerationStatus` as a plain JSON response (no SSE).
 * Designed for short-lived polling requests from the frontend (no timeout risk).
 * 
 * **Authentication:** Optional (via `optionalAuth`)
 * 
 * **Three-state machine:**
 * 
 * | `isGenerating` | `isDone` | Behaviour |
 * |:---:|:---:|---|
 * | `true` | `false` | Workflow is running. Returns `isGenerating: true` with `completedActions`/`totalActions` from page actions, plus live `actionProgress` events from the `actionProgress` DB table (falling back to synthetic events). |
 * | `false` | `true` | All actions have `destinationPageIds`. Returns `isGenerating: false` with all actions completed. Clears stale progress events. |
 * | `false` | `false` | No workflow running and actions are pending. Triggers the GitHub workflow via `triggerCandidateGenerationWorkflow`, then returns `isGenerating: true` with current progress. |
 * 
 * **State derivation:**
 * - `isGenerating` is derived from `dbPage.isGeneratingStartedAt` — if set and not stale (within `MAX_GENERATION_DURATION_MS`), the workflow is considered active.
 * - `isDone` is derived from `pendingGenerationCount` (or count of actions without `destinationPageIds`). When zero, all actions have destinations.
 * - `completedActions` counts actions that already have `destinationPageIds` (source of truth from the page data).
 * - `actionProgress` is fetched live from the `actionProgress` DB table via `getActionProgressEvents`, falling back to synthetic events derived from the page's actions when no DB events exist.
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
 * 
 * @todo When `userId` is undefined (unauthenticated request), the fallback on
 *       line 3915 uses `requireEnv("SYSTEM_USER_ID")` to trigger the workflow.
 *       However, `validateAndRetrievePageForGeneration` on line 3841 passes
 *       `userId` (which may be `undefined`), causing `mapToPersistedStoryPage`
 *       to be used instead of `mapToUserStoryPage`. This means the `actions`
 *       array in the response won't include user-specific flags like
 *       `isSelected`. This is acceptable for a status endpoint, but if
 *       user-specific action metadata is needed in the future, consider
 *       passing a resolved user ID (e.g. from a session token or the
 *       `SYSTEM_USER_ID` fallback) to `validateAndRetrievePageForGeneration`
 *       so that `mapToUserStoryPage` is used consistently.
 */
router.get("/:identifier/:pageId/candidates/status", optionalAuth, async (c) => {
  try {
    const userId = c.get("userId");
    const { identifier, pageId } = c.req.param();

    // Handle array case for identifier and pageId
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;

    if (!isValidUuid(pageIdStr)) {
      return cValidationError(c, "Invalid pageId: must be valid uuid");
    }

    // Use common validation and page retrieval
    const validationResult = await validateAndRetrievePageForGeneration(bookIdentifier, pageIdStr, userId);
    if (!validationResult) {
      return cNotFoundError(c, "Page not found");
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
      return c.json(response);
    }

    // Generation not in progress - check if actions are complete
    if (isDone) {
      // All actions complete, clear progress events and return full data
      console.log(`[GET /candidates/status] ✅ Generation complete for page ${pageIdStr} - all actions completed`);
      void clearActionProgressEvents(pageIdStr);

      return c.json({
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
      return c.json({
        error: 'Failed to trigger generation workflow',
        details: workflowResult.error,
        isGenerating: false,
      }, 503);
    }

    return c.json({
      isGenerating: true,
      completedActions,
      totalActions,
      actions: actionsWithDestinations, // Current completed actions, this should be already correct
      actionProgress: progressEventFallback,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    } satisfies CandidateGenerationStatus);

  } catch (error) {
    return cApiError(c, "Failed to get candidate status", error);
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
router.post("/:identifier/:pageId/actions/hint", requireAuth, async (c) => {
  try {
    const { identifier, pageId: pageIdParam } = c.req.param();
    const { actionText: rawActionText } = c.get("body");
    const userId = c.get("userId")!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate actionText parameter
    if (!rawActionText || typeof rawActionText !== 'string') {
      return cValidationError(c, "actionText is required");
    }

    // Strip HTML as defense-in-depth for plain-text inputs
    const actionText = stripHtml(rawActionText);

    if (!actionText) {
      return cValidationError(c, "actionText is empty after sanitization");
    }

    // Validate that the page exists and belongs to the book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return cNotFoundError(c, "Page not found");
    }

    // Verify the book identifier matches
    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return cNotFoundError(c, "Book not found or page does not belong to this book");
    }

    // Validate that the action exists on the page
    const actionExists = dbPage.actions.some(action => action.text === actionText);
    if (!actionExists) {
      return cValidationError(c, "Action not found on this page");
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
      return c.json({
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
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    // // Get updated user credit balance
    // const userResult = await dbRead
    //   .select({ credits: users.credits })
    //   .from(users)
    //   .where(eq(users.userId, userId))
    //   .limit(1);

    // const creditsRemaining = userResult[0]?.credits || 0;

    console.log(`[POST /actions/hint] ✅ User ${userId} purchased hint for action "${actionText}" on page ${pageId}`);

    return c.json({
      success: true,
      actionText,
      alreadyPurchased: false,
      // creditsRemaining
    });

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    
    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return c.json({
        error: "Insufficient credits",
        message: `You need at least ${CREDIT_COSTS.SHOW_ACTION_HINT} credit to purchase an action hint`
      }, 402);
    }

    return cApiError(c, "Failed to purchase action hint", error);
  }
});

/**
 * POST /api/books/:identifier/:pageId/touch
 *
 * Lightweight "last read" heartbeat. Updates the user's reading session
 * `updated_at` (which the `reads` dashboard sort keys on) without recording a
 * page visit, inserting page progress, consuming credits, or writing activity
 * logs.
 *
 * Intended to be fired exactly once per page open from the reader client so the
 * "continue reading" / sessions list re-orders with the most-recently-opened
 * book on top. Idempotent: hitting the same page repeatedly just keeps bumping
 * `updated_at`.
 *
 * @route POST /api/books/:identifier/:pageId/touch
 * @description Mark the book's session as recently read (no progress side effects)
 * @auth Required (requireAuth)
 *
 * @param identifier - Book slug or UUID v7
 * @param pageId - Page identifier (UUID v7)
 * @returns 200 `{ success: true, lastReadAt }` on success (or 404 if book/page missing)
 *
 * @example
 * POST /api/books/whispering-halls/page456/touch
 * → 200 { "success": true, "lastReadAt": "2026-07-17T12:00:00.000Z" }
 */
router.post("/:identifier/:pageId/touch", requireAuth, async (c) => {
  const { identifier: bookIdentifier, pageId } = c.req.param();
  const userId = c.get("userId")!;
  const pageIdStr = Array.isArray(pageId) ? pageId[0] : pageId;
  const bookIdentifierStr = Array.isArray(bookIdentifier) ? bookIdentifier[0] : bookIdentifier;

  if (!isValidUuid(pageIdStr)) {
    return cValidationError(c, "Invalid pageId: must be valid uuid");
  }

  // Resolve book id (slug or uuid) and confirm the page belongs to it.
  const book = await resolveBook(bookIdentifierStr);
  if (!book) return cNotFoundError(c, "Book not found");
  const dbPage = await getPageFromDB(pageIdStr, { bookIdentifier: book.id });
  if (!dbPage) return cNotFoundError(c, "Page not found");

  // Upsert the active session row via setActiveSession, which applies the
  // branch-aware frontier rule (active-tip, preserved on back-navigation) and
  // bumps updated_at. This is the same row the `reads` sort and
  // `getEnrichedBook` session subquery read from, so the dashboard reorders
  // immediately — without any visit/progress/credit side effects.
  const now = new Date();
  const session = await setActiveSession({
    userId,
    bookId: book.id,
    pageId: pageIdStr,
    pageNumber: dbPage.page,
    previousPageId: dbPage.parentId ?? undefined,
  });

  return c.json({ success: true, lastReadAt: session?.updatedAt ?? now });
});

/**
 * POST /api/books/:identifier/:pageId/share
 *
 * Records a user sharing a completed ending page for a book.
 * The user must have actually reached this page (have a completion record).
 *
 * @route POST /api/books/:identifier/:pageId/share
 * @auth Required
 * @param identifier - Book slug or UUID v7
 * @param pageId - UUID v7 of the ending page to share
 * @returns 200 `{ success: true }` on success
 * @returns 404 if no completion record exists for this user+page
 *
 * @example
 * POST /api/books/the-haunting/01912345-6789-1234-5678-123456789012/share
 * → 200 { "success": true }
 */
router.post("/:identifier/:pageId/share", requireAuth, async (c) => {
  const bookIdentifier = c.req.param().identifier as string;
  const pageId = c.req.param().pageId as string;
  const userId = c.get("userId")!;

  // Get page
  const dbPage = await getPageFromDB(pageId, { bookIdentifier });
  if (!dbPage) {
    return cNotFoundError(c, `Page not found`);
  }

  const bookId = dbPage.bookId;

  // Resolve the specific completion this share refers to
  const [completion] = await dbRead
    .select({ id: userCompletedBooks.id, bookId: userCompletedBooks.bookId, branchId: userCompletedBooks.branchId })
    .from(userCompletedBooks)
    .where(and(
      eq(userCompletedBooks.userId, userId),
      eq(userCompletedBooks.pageId, pageId),
      eq(userCompletedBooks.bookId, bookId),
    ))
    .limit(1);

  if (!completion) {
    return cNotFoundError(c, 'No completion found for this page — cannot share an ending you have not reached.');
  }

  // Log user activity
  await logUserActivity({
    userId,
    activityType: 'shared_ending',
    targetType: 'book',
    targetId: completion.id,
    metadata: { bookId: completion.bookId, pageId, branchId: completion.branchId },
  }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

  return c.json({ success: true });
});

/**
 * GET /share/:username/:bookSlug/:pageId
 *
 * Public endpoint for viewing a shared ending page.
 * No authentication required — this is a marketing/share surface.
 *
 * Three gates restrict access:
 * 1. Book visibility must not be 'private'
 * 2. The completion must exist in userCompletedBooks
 * 3. The completion must have been shared via POST .../share
 *
 * Only returns public-safe fields — nothing personal to the sharer
 * beyond what they explicitly agreed to expose by clicking Share.
 *
 * @route GET /share/:username/:bookSlug/:pageId
 * @auth None (public)
 * @param username - Sharer's username
 * @param bookSlug - Book slug
 * @param pageId - UUID v7 of the ending page
 * @returns 200 with sharer, book, and ending data
 * @returns 404 if any gate fails
 *
 * @example
 * GET /share/jane/the-haunting/01912345-6789-1234-5678-123456789012
 * → 200 {
 *     "sharer": { "name": "Jane", "imageUrl": "https://..." },
 *     "book": { "title": "The Haunting", "hook": "...", "slug": "the-haunting", "imageUrl": null, "readCount": 142 },
 *     "ending": { "text": "I walked out the front door...", "percentage": 12.5 }
 *   }
 */
router.get("/share/:username/:bookSlug/:pageId", async (c) => {
  try {
    const username = c.req.param().username as string;
    const bookSlug = c.req.param().bookSlug as string;
    const pageId = c.req.param().pageId as string;

    // ── Lookup user by username ────────────────────────────────────────────
    const [user] = await dbRead
      .select({ userId: users.userId, name: users.name, imageUrl: users.imageUrl })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!user) return cNotFoundError(c, 'Not found');

    // ── Lookup book by slug ─────────────────────────────────────────────────
    const [book] = await dbRead
      .select({
        id: books.id,
        title: books.title,
        hook: books.hook,
        slug: books.slug,
        visibility: books.visibility,
        readCount: books.readCount,
        imageUrl: sql<string | null>`(
          SELECT ui.image_url FROM ${uploadedImages} ui WHERE ui.image_id = books.image_id LIMIT 1
        )`,
      })
      .from(books)
      .where(eq(books.slug, bookSlug))
      .limit(1);
    if (!book) return cNotFoundError(c, 'Not found');

    // Gate 1: visibility — private books are never publicly reachable
    if (book.visibility === 'private') return cNotFoundError(c, 'Not found');

    // Gate 2: did this completion actually happen
    const [completion] = await dbRead
      .select({ id: userCompletedBooks.id, bookId: userCompletedBooks.bookId, branchId: userCompletedBooks.branchId })
      .from(userCompletedBooks)
      .where(and(
        eq(userCompletedBooks.userId, user.userId),
        eq(userCompletedBooks.bookId, book.id),
        eq(userCompletedBooks.pageId, pageId),
      ))
      .limit(1);
    if (!completion) return cNotFoundError(c, 'Not found');

    // Gate 3: consent — was this specific completion ever actually shared
    const [shareLog] = await dbRead
      .select({ id: userActivityLogs.id })
      .from(userActivityLogs)
      .where(and(
        eq(userActivityLogs.activityType, 'shared_ending'),
        eq(userActivityLogs.targetId, completion.id),
      ))
      .limit(1);
    if (!shareLog) return cNotFoundError(c, 'Not found');

    // ── Compute ending stats ───────────────────────────────────────────────
    const endingStats = await computeEndingStats(book.id, pageId, user.userId);

    // ── Get page text ──────────────────────────────────────────────────────
    const page = await getPageFromDB(pageId);

    return c.json({
      sharer: { name: user.name, imageUrl: user.imageUrl },
      book: {
        title: book.title,
        hook: book.hook,
        slug: book.slug,
        imageUrl: book.imageUrl,
        readCount: book.readCount,
      },
      ending: {
        text: page?.text ?? null,
        percentage: endingStats.endingPercentage,
      },
    });
  } catch (error) {
    console.error('[GET /share/:username/:bookSlug/:pageId] ❌ Error:', error);
    cApiError(c, 'Failed to load shared ending', error);
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
router.post("/:identifier/purchase", requireAuth, async (c) => {
  try {
    const { identifier } = c.req.param();
    const userId = c.get("userId")!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    // Validate that the book exists
    const dbBook = await getBookFromDB(bookIdentifier);
    if (!dbBook) {
      return cNotFoundError(c, "Book not found");
    }

    // Validate that the book has a creditsPrice (is a paid book)
    if (!dbBook.creditsPrice || dbBook.creditsPrice <= 0) {
      return cValidationError(c, "This book is not available for purchase");
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
      return c.json({
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
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    console.log(`[POST /purchase] ✅ User ${userId} purchased book "${dbBook.title}" for ${dbBook.creditsPrice} credits`);

    return c.json({
      success: true,
      bookId: dbBook.id,
      creditsPrice: dbBook.creditsPrice,
      alreadyPurchased: false,
    });

  } catch (error) {
    const errorMessage = getErrorMessage(error);
    
    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return c.json({
        error: "Insufficient credits",
        message: "You need more credits to purchase this book"
      }, 402);
    }

    return cApiError(c, "Failed to purchase book", error);
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
router.get("/:identifier/psychological-profile", requireAuth, async (c) => {
  try {
    const { identifier } = c.req.param();
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const userId = c.get("userId")!;

    // Fetch the book to verify ownership/access
    const book = await resolveBook(bookIdentifier);
    if (!book) {
      return cNotFoundError(c, "Book not found");
    }

    // Only the book owner can view the psychological profile
    if (book.userId !== userId) {
      return cForbiddenError(c, "You do not have access to this book's psychological profile");
    }

    const result = await getPsychologicalProfileResult(book.id);
    if (!result) {
      return cNotFoundError(c, "No psychological profile data found for this book");
    }

    return c.json(result);
  } catch (error) {
    console.error("[GET /psychological-profile] ❌ Error:", error);
    cApiError(c, "Failed to get psychological profile", error);
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
router.get("/:identifier/locked-paths", requireAuth, async (c) => {
  try {
    const { identifier } = c.req.param();
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const userId = c.get("userId")!;

    const book = await resolveBook(bookIdentifier);
    if (!book) {
      return cNotFoundError(c, "Book not found");
    }

    // Only the book owner can view locked paths
    if (book.userId !== userId) {
      return cForbiddenError(c, "You do not have access to this book's locked path data");
    }

    const lockedPaths = await getLockedPaths(book.id);
    return c.json({ lockedPaths });
  } catch (error) {
    console.error("[GET /locked-paths] ❌ Error:", error);
    cApiError(c, "Failed to get locked paths", error);
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
router.post("/:identifier/:pageId/custom-actions/preview", requireAuth, async (c) => {
  try {
    const { identifier, pageId: pageIdParam } = c.req.param();
    const { text: rawText } = c.get("body");
    const userId = c.get("userId")!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate input
    if (!rawText || typeof rawText !== 'string') {
      return cValidationError(c, "text is required");
    }

    // Strip HTML as defense-in-depth for plain-text inputs
    const text = stripHtml(rawText);

    if (!text) {
      return cValidationError(c, "text is empty after sanitization");
    }

    // Validate pageId format
    if (!isValidUuid(pageId)) {
      return cValidationError(c, "Invalid pageId format");
    }

    // Fetch the page and book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return cNotFoundError(c, "Page not found");
    }

    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return cNotFoundError(c, "Book not found or page does not belong to this book");
    }

    // Fetch story state
    const storyState = await getStoryStateFromPage(dbPage);
    if (!storyState) {
      return cNotFoundError(c, "Story state not found for this page");
    }

    // Gate 0 — Eligibility (no credit check for preview)
    const gate0Result = runGate0(storyState, userId, book.id, pageId);
    if (!gate0Result.passed) {
      return c.json({
        outcome: 'reject',
        message: gate0Result.message,
      } satisfies CustomActionPreviewResponse);
    }

    // Gate 1 — Security filter
    const gate1Result = runGate1(text);
    if (!gate1Result.passed) {
      return c.json({
        outcome: 'reject',
        message: getRejectionMessage(gate1Result.category),
      } satisfies CustomActionPreviewResponse);
    }

    // Check if user already chose an action on this page (higher cost)
    const [hasExistingChoice] = await dbRead
      .select({ exists: sql`1` })
      .from(userPageProgress)
      .where(and(
        eq(userPageProgress.userId, userId),
        eq(userPageProgress.bookId, book.id),
        eq(userPageProgress.actionedPageId, pageId),
      ))
      .limit(1);

    const creditsCost = hasExistingChoice
      ? CREDIT_COSTS.CUSTOM_ACTION_AFTER_CHOICE
      : CREDIT_COSTS.CUSTOM_ACTION;

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
      return cApiError(c, "Failed to validate custom action");
    }

    const result = response.result;

    // Map outcome to response
    if (result.outcome === 'reject') {
      return c.json({
        outcome: 'reject',
        rejectionCategory: result.rejectionCategory,
        message: getRejectionMessage(result.rejectionCategory),
      } satisfies CustomActionPreviewResponse);
    }

    // allow or allow_as_attempt — return preview
    return c.json({
      outcome: result.outcome,
      preview: {
        canonicalIntent: result.interpretedIntent,
        cost: creditsCost,
      },
    } satisfies CustomActionPreviewResponse);

  } catch (error) {
    console.error('[POST /custom-actions/preview] ❌ Error:', error);
    cApiError(c, "Failed to preview custom action", error);
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
router.post("/:identifier/:pageId/custom-actions/submit", requireAuth, async (c) => {
  let creditsCost: number = CREDIT_COSTS.CUSTOM_ACTION;
  try {
    const { identifier, pageId: pageIdParam } = c.req.param();
    const { text: rawText } = c.get("body");
    const userId = c.get("userId")!;
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;
    const pageId = Array.isArray(pageIdParam) ? pageIdParam[0] : pageIdParam;

    // Validate input
    if (!rawText || typeof rawText !== 'string') {
      return cValidationError(c, "text is required");
    }

    // Strip HTML as defense-in-depth for plain-text inputs
    const text = stripHtml(rawText);

    if (!text) {
      return cValidationError(c, "text is empty after sanitization");
    }

    // Validate pageId format
    if (!isValidUuid(pageId)) {
      return cValidationError(c, "Invalid pageId format");
    }

    // Fetch the page and book
    const dbPage = await getPageFromDB(pageId);
    if (!dbPage) {
      return cNotFoundError(c, "Page not found");
    }

    const book = await resolveBook(bookIdentifier);
    if (!book || book.id !== dbPage.bookId) {
      return cNotFoundError(c, "Book not found or page does not belong to this book");
    }

    // Fetch story state
    const storyState = await getStoryStateFromPage(dbPage);
    if (!storyState) {
      return cNotFoundError(c, "Story state not found for this page");
    }

    // Check if user already chose an action on this page (higher cost)
    const [hasExistingChoice] = await dbRead
      .select({ exists: sql`1` })
      .from(userPageProgress)
      .where(and(
        eq(userPageProgress.userId, userId),
        eq(userPageProgress.bookId, book.id),
        eq(userPageProgress.actionedPageId, pageId),
      ))
      .limit(1);

    creditsCost = hasExistingChoice
      ? CREDIT_COSTS.CUSTOM_ACTION_AFTER_CHOICE
      : CREDIT_COSTS.CUSTOM_ACTION;

    // Gate 0 — Eligibility with credit check
    const gate0Result = runGate0(storyState, userId, book.id, pageId);
    if (!gate0Result.passed) {
      return c.json({
        message: gate0Result.message,
      }, 400);
    }

    // Gate 1 — Security filter
    const gate1Result = runGate1(text);
    if (!gate1Result.passed) {
      return c.json({
        message: getRejectionMessage(gate1Result.category),
      }, 400);
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
      return cApiError(c, "Failed to validate custom action");
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
        language: result.language,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return c.json({
        message: getRejectionMessage(result.rejectionCategory),
      }, 400);
    }

    // Construct canonical Action
    const canonicalAction = buildCanonicalAction(text, result);

    // Charge credits and persist action in a transaction
    await executeWithCredits(
      userId,
      creditsCost,
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
          creditsCharged: creditsCost,
          language: result.language,
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
        req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) },
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
    }, { req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });

    // Return success with generation info
    // The frontend should poll for the next page using the existing candidates/status endpoint
    const pollingUrl = `/api/books/${bookIdentifier}/${pageId}/candidates/status`;

    return c.json({
      message: 'Custom action submitted successfully. Page generation in progress.',
      pollingInfo: {
        pollingUrl,
        pollingIntervalMs: 2000,
        maxPollingTimeMs: 80000,
      },
    } satisfies CustomActionSubmitResponse, 202);

  } catch (error) {
    const errorMessage = getErrorMessage(error);

    // Handle insufficient credits error
    if (errorMessage.includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS)) {
      return c.json({
        error: 'Insufficient credits',
        message: `You need at least ${creditsCost} credits to submit a custom action`,
      }, 402);
    }

    console.error('[POST /custom-actions/submit] ❌ Error:', error);
    return cApiError(c, 'Failed to submit custom action', error);
  }
});

/**
 * Shared select shape that joins each testimonial with its author's public
 * profile fields (name + avatar) so the frontend can render testimonials the
 * same way it renders comments.
 */
const testimonialWithAuthorSelect = {
  id: bookTestimonials.id,
  userId: bookTestimonials.userId,
  bookId: bookTestimonials.bookId,
  rating: bookTestimonials.rating,
  content: bookTestimonials.content,
  status: bookTestimonials.status,
  featured: bookTestimonials.featured,
  createdAt: bookTestimonials.createdAt,
  updatedAt: bookTestimonials.updatedAt,
  name: users.name,
  imageUrl: users.imageUrl,
};

/**
 * @route GET /api/books/testimonials
 * @description Get the authenticated user's own book testimonials, enriched with book title and cover image.
 *              Supports optional `search` query parameter to filter by book title and/or testimonial content.
 * @access Private (requires auth)
 * 
 * @param {string} [c.req.query().search] - Search query to filter by book title or testimonial content (min 2 chars)
 * 
 * @returns {Object} 200 - Paginated list of the user's testimonials with book info
 * @returns {Error} 401 - Unauthorized
 */
router.get("/testimonials", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const { limit = DEFAULT_ITEMS_PER_PAGE, page = 1 } = extractPaginationParams(c.req.query());
  const offset = (page - 1) * limit;
  const search = c.req.query().search as string | undefined;

  const conditions = [eq(bookTestimonials.userId, userId)];

  if (search) {
    const validation = validateSearchQuery(search);
    if (!validation.isValid) {
      return cValidationError(c, `Invalid search: ${validation.error}`);
    }
    const searchCondition = buildTokenizedSearchCondition(validation.sanitized!, [
      books.title,
      bookTestimonials.content,
    ]);
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  const rows = await dbRead
    .select({
      ...testimonialWithAuthorSelect,
      bookTitle: books.title,
      bookImageUrl: uploadedImages.imageUrl,
    })
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .leftJoin(books, eq(bookTestimonials.bookId, books.id))
    .leftJoin(uploadedImages, eq(books.imageId, uploadedImages.imageId))
    .where(and(...conditions))
    .orderBy(desc(bookTestimonials.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(bookTestimonials)
    .leftJoin(books, eq(bookTestimonials.bookId, books.id))
    .where(and(...conditions));

  const testimonials = rows.map(({ bookTitle, bookImageUrl, ...testimonial }) => ({
    ...testimonial,
    book: {
      title: bookTitle,
      imageUrl: bookImageUrl,
    },
  }));

  const pagination = calculatePaginationMeta(page, limit, count);
  c.status(200); return c.json(createPaginatedResponse(testimonials, pagination, 'testimonials'));
});

/**
 * @route GET /api/books/:identifier/testimonials
 * @description List testimonials for a book
 * 
 * When authenticated as the book owner or the testimonial author, all statuses are returned.
 * Otherwise only `approved` testimonials are returned. Supports optional `featured` filter.
 * 
 * @access Optional auth
 * 
 * @param {string} c.req.param().identifier - Book slug or id
 * @param {string} [c.req.query().featured] - When "true", only featured testimonials
 * 
 * @returns {Object} 200 - Paginated list of testimonials
 * @returns {Error} 404 - Book not found
 */
router.get("/:identifier/testimonials", optionalAuth, async (c) => {
  const identifier = c.req.param().identifier as string;
  const userId = c.get("userId");
  const { limit = DEFAULT_ITEMS_PER_PAGE, page = 1 } = extractPaginationParams(c.req.query());
  const offset = (page - 1) * limit;
  const featuredOnly = c.req.query().featured === "true";

  const book = await resolveBook(identifier);
  if (!book) {
    return cNotFoundError(c, "Book not found");
  }

  const conditions = [eq(bookTestimonials.bookId, book.id)];

  // Non-privileged viewers only see approved testimonials
  const isPrivileged = userId && (userId === book.userId);
  if (!isPrivileged) {
    conditions.push(eq(bookTestimonials.status, "approved"));
  }
  if (featuredOnly) {
    conditions.push(eq(bookTestimonials.featured, true));
  }

  const rows = await dbRead
    .select(testimonialWithAuthorSelect)
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .where(and(...conditions))
    .orderBy(desc(bookTestimonials.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(bookTestimonials)
    .where(and(...conditions));

  const pagination = calculatePaginationMeta(page, limit, count);
  c.status(200); return c.json(createPaginatedResponse(rows, pagination, 'testimonials'));
});

/**
 * @route POST /api/books/:identifier/testimonials
 * @description Create a testimonial for a book
 * 
 * The authenticated user submits a rating (1-5, optional) and content. New testimonials
 * default to `pending` status and are not featured until curated.
 * 
 * @access Private (requires auth)
 * 
 * @param {string} c.req.param().identifier - Book slug or id
 * @param {number} [c.get("body").rating] - Rating from 1 to 5
 * @param {string} c.get("body").content - Testimonial text (non-empty)
 * 
 * @returns {Object} 201 - Created testimonial
 * @returns {Error} 400 - Validation error
 * @returns {Error} 401 - Unauthorized
 * @returns {Error} 404 - Book not found
 */
router.post("/:identifier/testimonials", requireAuth, async (c) => {
  const identifier = c.req.param().identifier as string;
  const userId = c.get("userId")!;
  const { rating, content } = c.get("body") as { rating?: number; content?: string };

  const book = await resolveBook(identifier);
  if (!book) {
    return cNotFoundError(c, "Book not found");
  }

  if (typeof content !== "string" || content.trim().length === 0) {
    return cValidationError(c, "Content is required");
  }
  if (content.trim().length > 5000) {
    return cValidationError(c, "Content must be at most 5000 characters");
  }

  let normalizedRating: number | null = null;
  if (rating !== undefined && rating !== null) {
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return cValidationError(c, "Rating must be an integer between 1 and 5");
    }
    normalizedRating = numericRating;
  }

  const [created] = await dbWrite
    .insert(bookTestimonials)
    .values({
      userId,
      bookId: book.id,
      rating: normalizedRating,
      content: content.trim(),
      status: "pending",
      featured: false,
    })
    .returning({ id: bookTestimonials.id });

  const [testimonial] = await dbRead
    .select(testimonialWithAuthorSelect)
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .where(eq(bookTestimonials.id, created.id))
    .limit(1);

  c.status(201); return c.json({ testimonial });
});

/**
 * @route GET /api/books/:identifier/testimonials/:id
 * @description Get a single testimonial
 * 
 * Owners of the testimonial or of the book may view any status. Other viewers
 * may only view `approved` testimonials.
 * 
 * @access Optional auth
 * 
 * @param {string} c.req.param().identifier - Book slug or id
 * @param {string} c.req.param().id - Testimonial id
 * 
 * @returns {Object} 200 - The testimonial
 * @returns {Error} 404 - Testimonial not found
 */
router.get("/:identifier/testimonials/:id", optionalAuth, async (c) => {
  const identifier = c.req.param().identifier as string;
  const id = c.req.param().id as string;
  const userId = c.get("userId");

  const book = await resolveBook(identifier);
  if (!book) {
    return cNotFoundError(c, "Book not found");
  }

  const [testimonial] = await dbRead
    .select(testimonialWithAuthorSelect)
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .where(and(eq(bookTestimonials.id, id), eq(bookTestimonials.bookId, book.id)))
    .limit(1);

  if (!testimonial) {
    return cNotFoundError(c, "Testimonial not found");
  }

  const isPrivileged = userId && (userId === testimonial.userId || userId === book.userId);
  if (!isPrivileged && testimonial.status !== "approved") {
    return cNotFoundError(c, "Testimonial not found");
  }

  c.status(200); return c.json({ testimonial });
});

/**
 * @route PATCH /api/books/:identifier/testimonials/:id
 * @description Update a testimonial
 * 
 * Only the testimonial author may update it. Editing resets status to `pending`
 * and clears the featured flag so it can be re-curated.
 * 
 * @access Private (requires auth, owner only)
 * 
 * @param {string} c.req.param().identifier - Book slug or id
 * @param {string} c.req.param().id - Testimonial id
 * @param {number} [c.get("body").rating] - Rating from 1 to 5
 * @param {string} [c.get("body").content] - Testimonial text (non-empty)
 * 
 * @returns {Object} 200 - Updated testimonial
 * @returns {Error} 403 - Forbidden (not the owner)
 * @returns {Error} 404 - Testimonial not found
 */
router.patch("/:identifier/testimonials/:id", requireAuth, async (c) => {
  const identifier = c.req.param().identifier as string;
  const id = c.req.param().id as string;
  const userId = c.get("userId")!;
  const { rating, content } = c.get("body") as { rating?: number; content?: string };

  const book = await resolveBook(identifier);
  if (!book) {
    return cNotFoundError(c, "Book not found");
  }

  const [existing] = await dbRead
    .select()
    .from(bookTestimonials)
    .where(and(eq(bookTestimonials.id, id), eq(bookTestimonials.bookId, book.id)))
    .limit(1);

  if (!existing) {
    return cNotFoundError(c, "Testimonial not found");
  }
  if (existing.userId !== userId) {
    return cForbiddenError(c, "You can only edit your own testimonial");
  }

  const updateValues: Partial<typeof bookTestimonials.$inferInsert> = {};
  if (content !== undefined) {
    if (typeof content !== "string" || content.trim().length === 0) {
      return cValidationError(c, "Content is required");
    }
    if (content.trim().length > 5000) {
      return cValidationError(c, "Content must be at most 5000 characters");
    }
    updateValues.content = content.trim();
  }
  if (rating !== undefined && rating !== null) {
    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return cValidationError(c, "Rating must be an integer between 1 and 5");
    }
    updateValues.rating = numericRating;
  }

  if (Object.keys(updateValues).length === 0) {
    c.status(200); return c.json({ testimonial: existing });
    return;
  }

  // Editing requires re-curation
  updateValues.status = "pending";
  updateValues.featured = false;

  await dbWrite
    .update(bookTestimonials)
    .set({ ...updateValues, updatedAt: new Date() })
    .where(eq(bookTestimonials.id, id));

  const [updated] = await dbRead
    .select(testimonialWithAuthorSelect)
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .where(eq(bookTestimonials.id, id))
    .limit(1);

  c.status(200); return c.json({ testimonial: updated });
});

/**
 * @route DELETE /api/books/:identifier/testimonials/:id
 * @description Delete a testimonial
 * 
 * Only the testimonial author may delete it.
 * 
 * @access Private (requires auth, owner only)
 * 
 * @param {string} c.req.param().identifier - Book slug or id
 * @param {string} c.req.param().id - Testimonial id
 * 
 * @returns {Object} 200 - Deletion confirmation
 * @returns {Error} 403 - Forbidden (not the owner)
 * @returns {Error} 404 - Testimonial not found
 */
router.delete("/:identifier/testimonials/:id", requireAuth, async (c) => {
  const identifier = c.req.param().identifier as string;
  const id = c.req.param().id as string;
  const userId = c.get("userId")!;

  const book = await resolveBook(identifier);
  if (!book) {
    return cNotFoundError(c, "Book not found");
  }

  const [existing] = await dbRead
    .select()
    .from(bookTestimonials)
    .where(and(eq(bookTestimonials.id, id), eq(bookTestimonials.bookId, book.id)))
    .limit(1);

  if (!existing) {
    return cNotFoundError(c, "Testimonial not found");
  }
  if (existing.userId !== userId) {
    return cForbiddenError(c, "You can only delete your own testimonial");
  }

  await dbWrite
    .delete(bookTestimonials)
    .where(eq(bookTestimonials.id, id));

  c.status(200); return c.json({ message: "Testimonial deleted successfully" });
});

/**
 * GET /api/books/:identifier
 * 
 * Retrieves a book by slug or UUID v7 identifier.
 * Returns complete book information including metadata, author details,
 * engagement statistics, and user-specific engagement flags.
 *
 * @route GET /api/books/:identifier
 * @description Retrieve a book by slug or UUID
 * @auth Optional (optionalAuth)
 * 
 * @param identifier - Book slug or UUID v7
 * @returns Object with enriched book metadata including author, stats, and user flags
 * 
 * @example
 * GET /api/books/whispering-halls
 * 
 * Response (200):
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
 *     "imageUrl": "https://example.com/cover.jpg",
 *     "keywords": ["mystery", "thriller", "haunted"],
 *     "status": "active",
 *     "trendingScore": 0.85,
 *     "topPick": null,
 *     "isOriginal": false,
 *     "branchesCount": 12,
 *     "firstPageId": "page456",
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
 *       "imageUrl": "https://example.com/avatar.jpg"
 *     },
 *     "stats": {
 *       "likesCount": 42,
 *       "readCount": 156,
 *       "completeCount": 23,
 *       "commentsCount": 25,
 *       "branchesCount": 12
 *     },
 *     "isLiked": false,
 *     "isRead": true,
 *     "isMine": false,
 *     "isSaved": false,
 *     "isCompleted": false,
 *     "isPurchased": false,
 *     "session": null,
 *     "collection": null,
 *     "createdAt": "2023-01-01T00:00:00.000Z",
 *     "updatedAt": "2023-01-15T10:30:00.000Z"
 *   }
 * }
 */
router.get("/:identifier", optionalAuth, async (c) => {
  try {
    const { identifier } = c.req.param();
    const bookIdentifier = Array.isArray(identifier) ? identifier[0] : identifier;

    const enrichedBook = await getEnrichedBook(bookIdentifier, c.get("userId"), c.get("headerLanguage"));
    if (!enrichedBook) return cNotFoundError(c, "Book not found");

    // Generate ETag from updatedAt + userId (user-specific columns: isMine, isLiked, isRead, lastReadAt, lastPageId, lastPageNumber, contextHistory)
    const lastModified = enrichedBook.updatedAt;
    const etagInput = `${lastModified.getTime()}-${c.get("userId") || 'anonymous'}`;
    const etag = `"${etagInput}"`;

    // Check If-None-Match header (ETag includes userId for user-specific data)
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304);

    // Set caching headers
    c.header('Last-Modified', lastModified.toUTCString());
    c.header('ETag', etag);

    // Active books: private cache so Vercel edge doesn't serve stale user-specific data
    // Non-active (draft/archived) books: no cache — these change frequently during generation
    // and must never be served stale from the edge
    if (enrichedBook.status === 'active') {
      c.header('Cache-Control', 'private, max-age=300, stale-while-revalidate=150');
    } else {
      c.header('Cache-Control', 'private, no-cache');
    }

    return c.json({ book: enrichedBook });
  } catch (error) {
    return cApiError(c, "Failed to retrieve book", error);
  }
});

export default router;
