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

import { type DBClient, dbRead, dbWrite, isTransaction } from "../db/client.js";
import { pages, books, branches, users, userPageProgress, userCompletedBooks, userActionHints, customActions, bookGenerations, userComments, canonValidations } from "../db/schema.js";
import type { ImageKitUploadResponse } from "../types/image.js";
import { and, eq, asc, or, desc, ne, sql, isNull, lt } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { sanitizeActionsForMode } from "../utils/book-mode.js";
import { validateGeneratedPage } from "../utils/page-validation.js";
import { MAX_GENERATION_DURATION_MS } from "../config/book-creation.js";
import { isPublicActiveBook, notifyForumBranchAdded } from "./forum-queue.js";
import { notifyFollowersOfPublishedBook } from "./book-publish-notification.js";
import { getEnrichedBookSelect } from "./book-controller.js";
import type { DBBook, DBNewBook, DBNewPage, DBPage, DBUpdateBook } from "../types/schema.js";
import type { Book, BookSlugGenerationResult, BookStatus, BookVisibility, EnrichedBookData, EnrichedPageOptions, PublicStats } from "../types/book.js";
import { bookVisibilities } from "../types/book.js";
import { actionTypes, type StoryPage, type PersistedStoryPage, type UserStoryPage, type StoryState, type StoryPageMeta, type EnrichedStoryPage, type StateDelta, type StoryGeneration, type SelectedAction, type Action, type EnrichedStoryPageContext, type TranslatedStoryPage, type EnrichedStoryPagePlace, type EnrichedStoryPageCharacter, type ActionType, type ActionHintType } from "../types/story.js";
import type { CanonValidationSummary } from "../types/canon-validation.js";
import { getStoryStateFromPage, insertStoryState } from "./story.js";
import { formatPlacesForPrompt, resolvePlaceLoreNames } from "../utils/places.js";
import { buildCustomActionAction, deriveActionRisk } from "../utils/custom-action.js";
import { formatBookMetaForPrompt } from "../utils/books.js";
import { calculateHealthStatus, formatCharactersForPrompt, formatPlannedCharactersForPrompt, resolveCharacterLoreNames } from "../utils/characters.js";
import { formatSystemPromptWithDocuments } from "../utils/ai-chat.js";
import { IS_PRODUCTION } from "../config/env.js";
import { geminiGenerateImage } from "../utils/ai-image.js";
import { retryWithBranchConflict, isUniqueConstraintError } from "../utils/retry.js";
import { generateBranchId } from "./story-branch.js";
import { deleteFileFromImageKit, persistUploadedImage, uploadBookCover, uploadBookCharacterImage } from "./image.js";
import { sanitizeText, generateSlug, sanitizeKeywords, parseTrait } from "../utils/text-processing.js";
import { generateId, isValidUuid } from "../utils/uuid.js";
import { calculateActionTendency, calculateStoryMomentum, getStoryStateInfo } from "../utils/story.js";
import { applyPageTranslation, getPageToTranslate, getPageTranslation, shouldTranslate } from "./translation.js";
import { LRUCache } from "lru-cache";
import { createCacheKey } from "../utils/cache.js";
import { getFromCache, setCache, deleteCachePattern, CACHE_KEYS, CACHE_TTL } from "./cache.js";
import { isRedisAvailable } from "../utils/redis.js";
import { daysBetween } from "../utils/time.js";
import type { CandidateGenerationPage } from "../types/candidate-generation.js";
import type { AIDocument, AIPromptDocuments, AIResponseProvider } from "../types/ai-chat.js";
import type { StoryMC } from "../types/character.js";
import type { ImageUploadSource } from "../types/image.js";
import { MAX_ACTION_CHOICES_COMMUNITY } from "../config/story.js";

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
 * LRU cache for basic book data
 * 
 * Cache key format: "book:{bookId}"
 * - bookId: Book identifier
 * 
 * Only caches books with 'active' status (published and stable).
 * 
 * TTL: 5 minutes to balance freshness with performance
 * Max size: 1000 entries to prevent memory bloat
 */
const bookCache = new LRUCache<string, Book>({
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
const publicBookStatsCache = new LRUCache<string, PublicStats>({
  max: 1,
  ttl: 2 * 60 * 1000, // 2 minutes
});

/**
 * LRU cache for popular tags
 * 
 * Cache key: "popular:tags:{limit}"
 * - limit: number of tags requested
 * 
 * TTL: 10 minutes (popular tags change infrequently)
 * Max size: 5 entries (different limits)
 */
const popularTagsCache = new LRUCache<string, string[]>({
  max: 5,
  ttl: 10 * 60 * 1000, // 10 minutes
});

/**
 * Invalidates the popular tags LRU cache
 * Called when tags might have changed (book created/updated)
 */
export function invalidatePopularTagsCache(): void {
  popularTagsCache.clear();
}

/**
 * LRU cache for enriched page data
 * 
 * Cache key format: "page:{pageId}:{userId|null}:{translate}:{headerLanguage|en}"
 * - pageId: Page identifier
 * - userId: Current user ID (or "null" for anonymous) - affects selectedActions
 * - translate: Whether translation is enabled
 * - headerLanguage: Target language code (or "en" default) - affects translation
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
 * @param headerLanguage - Optional target language code
 * @returns Cache key string
 */
function getEnrichedPageCacheKey(
  pageId: string,
  userId?: string | null,
  translate: boolean = false,
  headerLanguage?: string | null
): string {
  return `page:${pageId}:${userId || 'null'}:${translate}:${headerLanguage || 'en'}`;
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
 * Generates the Redis cache key for a book's static page 1 payload.
 *
 * Keyed by book ID + effective content language because translation changes
 * the page content. The payload is shared across all users (page 1 has no
 * parent action, so per-user fields are re-merged on read instead).
 *
 * @param bookId - Book identifier
 * @param contentLanguage - Effective content language (book language or translation target)
 * @returns Redis cache key for the page 1 payload
 */
function getPageOneCacheKey(bookId: string, contentLanguage: string): string {
  return CACHE_KEYS.PAGE_ONE(bookId, contentLanguage);
}

/**
 * Invalidates the Redis page 1 cache for a book (all languages).
 *
 * Page 1 content is immutable for active books, so this is primarily a safety
 * net for when a book is deleted (the payload would otherwise linger until the
 * PAGE_ONE TTL expires).
 *
 * @param bookId - Book identifier
 */
export async function invalidatePageOneCache(bookId: string): Promise<void> {
  await deleteCachePattern(`book:page1:${bookId}:*`);
}

/**
 * Generates cache key for basic book data
 * 
 * @param bookId - Book identifier
 * @returns Cache key string
 */
function getBookCacheKey(bookId: string): string {
  return `book:${bookId}`;
}

/**
 * Invalidates cache entries for a specific book (basic cache)
 * 
 * Removes cache entry for a book by ID.
 * Called when book data is mutated (create, update, delete).
 * 
 * @param bookId - Book ID to invalidate
 */
export function invalidateBookCache(bookId: string): void {
  bookCache.delete(getBookCacheKey(bookId));
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
 * Matches bracketed action-type markers (e.g. "[dialogue]", "[explore]") in
 * story page text, including any trailing period the model may append.
 *
 * Built from the known actionTypes keys so only real action-type markers are
 * stripped — arbitrary bracketed text in the narrative is preserved.
 */
const ACTION_TYPE_TAG_PATTERN = new RegExp(
  `\\s*\\[(${Object.keys(actionTypes).join('|')})\\]\\s*\\.?`,
  'gi'
);

/**
 * Removes bracketed action-type markers (e.g. "[dialogue]", "[explore]") from
 * story page text.
 *
 * The generation prompt instructs the model to begin dialogue actions with
 * "[dialogue]." and similar markers can leak into other action types. These are
 * control markers for the AI, not part of the narrative, so they must not be
 * stored in the database or served to readers.
 *
 * @param text - Raw AI-generated page text
 * @returns Text with action-type markers stripped and whitespace normalized
 */
function stripActionTypeTags(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(ACTION_TYPE_TAG_PATTERN, '').trim();
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
 * @example
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
  const { bookId, branchId, parentId, aiResponseProvider, storyStartDate } = pageMeta;
  const { calendarDate } = page;

  // Validation runs the same regardless of mode
  if (pageNumber > 1) {
    if (!parentId) throw new Error(`Parent page required for page ${pageNumber}`);
    
    const [parentPage] = await client
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.id, parentId))
      .limit(1);

    if (!parentPage) throw new Error(`Parent page ${parentId} not found`);
  }

  const {
    provider: aiProvider,
    model: aiModel,
    evalProvider: aiEvalProvider,
    evalModel: aiEvalModel,
    scoreBefore,
    scoreAfter,
  } = aiResponseProvider;

  const elapsedDays = storyStartDate && calendarDate ? daysBetween(storyStartDate, calendarDate) : undefined;
  // Strip AI control markers (e.g. "[dialogue]") from the narrative before it
  // touches the database — they are prompt scaffolding, not story content.
  const sanitizedPageText = stripActionTypeTags(page.text);
  const newPageData: DBNewPage = {
    userId,
    bookId,
    branchId,
    parentId,
    page: pageNumber,
    text: sanitizedPageText,
    mood: page.mood,
    placeId: page.placeId,
    weather: page.weather,
    calendarDate,
    elapsedDays,
    timeOfDay: page.timeOfDay,
    sceneType: page.sceneType,
    momentum: page.momentum,
    charactersPresent: page.charactersPresent || [],
    keyEvents: page.keyEvents || [],
    keyObjects: page.keyObjects || [],
    actions: page.actions,
    stateDelta: pageNumber > 1 ? page.stateDelta : {},
    aiProvider,
    aiModel,
    aiEvalProvider,
    aiEvalModel,
    scoreBefore,
    scoreAfter,
    createdAt: new Date(),
    updatedAt: new Date()
  } satisfies Record<keyof Omit<DBNewPage, 'id' | 'isGeneratingStartedAt' | 'visitCount' | 'authorshipOrigin' | 'humanAuthorUserId' | 'aiContributionPercent'>, unknown>;
  // } satisfies DBNewPage;

  if (isTransaction(client)) {
    // ── Transaction mode ────────────────────────────────────────────────────
    // Skip internal retry: retrying inside a transaction is impossible because
    // PostgreSQL aborts the transaction on the first constraint failure.
    // The caller (persistPageWithState) owns the retry loop and wraps the
    // transaction. Re-throw the original error unwrapped so isUniqueConstraintError
    // can read code: '23505' directly.
    try {
      const [newPage] = await client.insert(pages).values(newPageData).returning();

      // If this is the first page, set the book's storyStartDate to the
      // page's calendarDate so the book records when the story begins.
      if (pageNumber === 1 && page.calendarDate) {
        try {
          await client.update(books).set({ storyStartDate: page.calendarDate }).where(eq(books.id, bookId));
          console.log(`[insertStoryPage] ✅ Set books.storyStartDate for book ${bookId} to ${page.calendarDate}`);
        } catch (err) {
          console.error(`[insertStoryPage] ⚠️ Failed to update books.storyStartDate for book ${bookId}:`, err);
        }
      }

      return mapToPersistedStoryPage(newPage);
    } catch (error) {
      console.error(`[insertStoryPage] ❌ Insert failed (tx mode) for page ${pageNumber}:`, getErrorMessage(error));
      throw error; // Preserve original error — do NOT wrap
    }
  }

  // ── Standalone mode ──────────────────────────────────────────────────────
  // Retry with a fresh branchId on constraint violation. Safe here because
  // each retry is an independent statement with no enclosing transaction.
  try {
    const persisted = await retryWithBranchConflict(
      async (data: DBNewPage) => {
        const [newPage] = await client.insert(pages).values(data).returning();
        return mapToPersistedStoryPage(newPage);
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
        // Note: shouldRetry here is passed to retryWithBranchConflict → retryWithUniqueConstraint,
        // which does NOT use this field (it applies isUniqueConstraintError internally).
        // Keeping it as documentation of intent only.
      }
    );

    // If this was the first page, update the book's storyStartDate (best-effort).
    if (pageNumber === 1 && page.calendarDate) {
      try {
        await client.update(books).set({ storyStartDate: page.calendarDate }).where(eq(books.id, bookId));
        console.log(`[insertStoryPage] ✅ Set books.storyStartDate for book ${bookId} to ${page.calendarDate}`);
      } catch (err) {
        console.error(`[insertStoryPage] ⚠️ Failed to update books.storyStartDate for book ${bookId}:`, err);
      }
    }

    return persisted;
  } catch (error) {
    // const errorMessage = getErrorMessage(error);
    // console.error(`[insertStoryPage] ❌ Failed to insert story page ${pageNumber}:`, errorMessage);
    // throw new Error(`Unable to insert story page: ${errorMessage}`, { cause: error });
    console.error(`[insertStoryPage] ❌ Failed to insert story page ${pageNumber}:`, error);
    throw error;
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
 * Deletes a story page by ID.
 *
 * Used exclusively by persistPageWithState for orphan cleanup: when a page
 * is successfully inserted but its story-state insertion fails, we remove
 * the page so the DB stays consistent and the action can be retried cleanly.
 *
 * @param pageId - The page to delete
 */
export async function deleteStoryPage(pageId: string): Promise<void> {
  await dbWrite.delete(pages).where(eq(pages.id, pageId));
}

/**
 * Resolves a unique display name for a new branch from AI-suggested alternatives.
 *
 * Tries up to 3 AI suggestions; if all conflict, appends a numeric suffix up to
 * 5 times. If still conflicting (extremely unlikely), returns the raw first
 * suggestion — the UUID v7 branchId remains the true unique identifier.
 *
 * @param branchNames - AI-suggested branch names (up to 3 used)
 * @param existingNames - Set of display names already used in this book
 * @returns A unique (or best-effort) display name for the branch
 */
function resolveBranchDisplayName(
  branchNames: string[] | undefined,
  existingNames: Set<string>,
): string {
  const candidates = branchNames ?? [];

  for (const name of candidates) {
    if (!existingNames.has(name)) {
      return name;
    }
  }

  // All AI suggestions conflicted → append numeric suffix
  const base = candidates[0] || 'Alternative Timeline';
  if (base) {
    for (let i = 1; i <= 5; i++) {
      const fallback = `${base} ${i}`;
      if (!existingNames.has(fallback)) {
        return fallback;
      }
    }
  }

  // Last resort: return raw first suggestion (duplicate allowed)
  return base;
}

/**
 * Atomically persists a generated page and its story state.
 *
 * ── Atomicity ────────────────────────────────────────────────────────────────
 * A true DB transaction is not used here because insertStoryPage already
 * contains retryWithBranchConflict (which retries with a new branchId on
 * unique-constraint violation). Running that retry inside a transaction would
 * abort the transaction on the first constraint failure, defeating the retry.
 *
 * Instead we approximate atomicity with a cleanup contract:
 *   1. insertStoryPage   — succeeds or throws (no side effects on throw)
 *   2. insertStoryState  — on failure → delete the already-committed page
 *
 * If the delete also fails (e.g. network partition), the orphan page will be
 * detectable by a periodic reconciliation job (no state, never linked as a
 * destination). The function re-throws the original state error in all cases.
 *
 * @param context  Short log prefix for debugging (e.g. 'generateNextPages')
 */
export async function persistPageWithState(params: {
  userId: string;
  expectedPageNumber: number;
  generatedStoryPage: StoryGeneration;
  fullStateDelta: StateDelta;
  newState: StoryState;
  aiResponseProvider: AIResponseProvider;
  actionedPage: CandidateGenerationPage;
  action: Action;
  branchId: string;
  usedBranchIds: Set<string>; // must be passed in for within-call collision safety on retry
  context?: string;
  book: Pick<Book, 'storyStartDate' | 'mode' | 'id' | 'visibility' | 'status'>;
  allowEmptyActions?: boolean;
}): Promise<PersistedStoryPage> {
  const {
    userId,
    expectedPageNumber,
    generatedStoryPage,
    fullStateDelta,
    newState,
    aiResponseProvider,
    actionedPage,
    action,
    usedBranchIds,
    context = "persistPageWithState",
    book,
    allowEmptyActions,
  } = params;

  const { storyStartDate, mode } = book;

  // ── MODE BRANCHING CONTRACT (insert-time gate) ───────────────────────────
  // Enforce the book's creation mode before any DB write. A freshly generated
  // page has no destinations yet (they are filled later by candidate
  // generation), so this validates only the ACTION-COUNT rule:
  //   novel       → exactly 1 action (linear path)
  //   interactive → 1..MAX actions
  //   multiverse  → 1..MAX actions
  // The per-action destination limit is enforced later, when candidate
  // generation writes destinations back (see enforceModeOnActionDestinations).
  // Throws loudly if the AI produced a page that breaks its book's mode,
  // rather than silently persisting an invalid story graph.
  generatedStoryPage.actions = sanitizeActionsForMode(mode, generatedStoryPage.actions);

  // Double-defense: revalidate the page before persisting (text length, JSON
  // leaks, actions). Throw here rather than silently inserting bad data.
  validateGeneratedPage(generatedStoryPage, mode, 'persistPageWithState', { allowEmpty: allowEmptyActions });

  const { momentum: calculatedMomentum } = calculateStoryMomentum({
    state: newState,
    currentPage: expectedPageNumber,
    sceneType: generatedStoryPage.sceneType,
    charactersPresent: generatedStoryPage.charactersPresent,
    previousMomentum: actionedPage.momentum,
  });

  // Annotate actions with tendency scores against the freshly-updated state
  const actionsWithTendency = generatedStoryPage.actions.map<Action>(action => ({
    ...action,
    tendency: calculateActionTendency(action, newState),
    source: 'ai',
    // Engine-derived per-action risk (deterministic, no AI authoring).
    risk: deriveActionRisk(action.type),
  }));

  const pageToInsert: StoryPage = {
    ...generatedStoryPage,
    stateDelta: fullStateDelta,
    momentum: calculatedMomentum,
    actions: actionsWithTendency,
  };

  const MAX_BRANCH_RETRIES = 3;
  let currentBranchId = params.branchId;

  for (let attempt = 1; attempt <= MAX_BRANCH_RETRIES; attempt++) {
    try {
      const { page: newPage, insertedBranch } = await dbWrite.transaction(async (tx) => {
        const pageMeta: StoryPageMeta = {
          bookId: actionedPage.bookId,
          branchId: currentBranchId,
          parentId: actionedPage.id,
          aiResponseProvider,
          storyStartDate,
        };

        // insertStoryPage detects tx client → skips internal retry → bubbles original error
        const newPage = await insertStoryPage(userId, expectedPageNumber, pageToInsert, pageMeta, { client: tx });
        const selectedAction: SelectedAction = {
          text: action.text,
          type: action.type,
          hint: action.hint,
          page: actionedPage.page,
          pageId: actionedPage.id,
          nextPageId: newPage.id
        };

        // Add chosen action to history (removed existing entries with same page number)
        newState.actionsHistory = newState.actionsHistory.filter(action => action.page !== actionedPage.page);
        newState.actionsHistory.push(selectedAction);

        // Ensure new state matches the new page
        newState.page = newPage.page;
        newState.pageId = newPage.id;

        // Calculate health status
        newState.healthStatus = calculateHealthStatus(newState.injuries, {
          traumaTagCount:  newState.traumaTags.length,
          memoryIntegrity: newState.memoryIntegrity,
          fearLevel:       newState.flags.fear,
        });

        // If this is a new branch (not "main"), create a branches row atomically
        let inserted: { branchId: string; displayName: string; slug: string }[] = [];
        if (currentBranchId !== "main") {
          const existingRows = await tx
            .select({ name: branches.displayName })
            .from(branches)
            .where(eq(branches.bookId, actionedPage.bookId));
          const existingNames = new Set(existingRows.map(r => r.name));
          const displayName = resolveBranchDisplayName(generatedStoryPage.branchNames, existingNames);

          inserted = await tx.insert(branches).values({
            branchId: currentBranchId,
            bookId: actionedPage.bookId,
            displayName,
          }).onConflictDoNothing().returning({
            branchId: branches.branchId,
            displayName: branches.displayName,
            slug: branches.slug,
          }) as unknown as { branchId: string; displayName: string; slug: string }[];
        }

        // If this throws, the transaction auto-rolls back — no orphan page
        await insertStoryState(newPage.bookId, newPage.id, newState, 'original', { client: tx });

        // Pen delta-validation clock (Phase 0.d / §6.7): a published page is new
        // canon, so later draft spans validated against the old world are stale.
        // factsHistory entries only ever arrive via this same page-publish path,
        // so one increment per persisted page covers both cases. The lore-entries
        // create/edit path (Phase 5) increments here-equivalent when it lands.
        await tx
          .update(books)
          .set({ canonVersion: sql`${books.canonVersion} + 1`, updatedAt: new Date() })
          .where(eq(books.id, actionedPage.bookId));

        return {
          page: newPage,
          insertedBranch: inserted.length > 0 ? inserted[0] : null,
        };
      });

      if (insertedBranch && isPublicActiveBook(book)) {
        notifyForumBranchAdded(book.id, insertedBranch.branchId, insertedBranch.displayName, insertedBranch.slug);
      }

      return newPage;
    } catch (error) {
      // isUniqueConstraintError now walks the cause chain, so code: '23505' is
      // reliably detected even if the error is wrapped by Drizzle or insertStoryPage
      if (isUniqueConstraintError(error) && attempt < MAX_BRANCH_RETRIES) {
        let newBranchId = generateBranchId();
        while (usedBranchIds.has(newBranchId)) newBranchId = generateBranchId();
        usedBranchIds.add(newBranchId);
        currentBranchId = newBranchId;
        console.warn(`[${context}] ⚠️ branchId conflict on attempt ${attempt}/${MAX_BRANCH_RETRIES}, retrying with ${newBranchId}`);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`[${context}] ❌ Failed to persist page after ${MAX_BRANCH_RETRIES} branch conflict retries`);
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
 * Checks if a slug already exists in the database
 * 
 * @param slug - The slug to check
 * @returns Promise resolving to true if slug exists, false otherwise
 */
async function slugExists(slug: string): Promise<boolean> {
  const existing = await dbRead
    .select({ slug: books.slug })
    .from(books)
    .where(eq(books.slug, slug))
    .limit(1);
  return existing.length > 0;
}

/**
 * Generates a unique slug for a book by checking existing slugs
 * 
 * Creates a slug from the title and ensures uniqueness by trying
 * alternative titles or appending a numeric suffix if needed.
 * 
 * @param title - The book title to generate slug from
 * @param alternativeTitles - Optional array of alternative titles to try as fallback
 * @returns Promise resolving to slug and the title that was used
 * 
 * @example
 * ```typescript
 * const result = await generateUniqueSlug("The Amazing Adventure", ["Dead City"]);
 * // If "amazing-adventure" exists, returns { slug: "dead-city", title: "Dead City" }
 * ```
 */
async function generateUniqueSlug(title: string, alternativeTitles?: string[]): Promise<BookSlugGenerationResult> {
  const RESERVED_SLUGS = new Set(['stats', 'explore']);
  const baseSlug = generateSlug(title);

  if (baseSlug) {
    // If base slug is available and not a reserved endpoint, use original title
    if (!await slugExists(baseSlug) && !RESERVED_SLUGS.has(baseSlug)) {
      return { slug: baseSlug, title };
    }

    // Base slug exists or is reserved, try alternative titles if provided
    if (alternativeTitles && alternativeTitles.length > 0) {
      for (const altTitle of alternativeTitles) {
        const altSlug = generateSlug(altTitle);
        if (!altSlug) continue;
        if (RESERVED_SLUGS.has(altSlug)) continue;

        if (!await slugExists(altSlug)) {
          return { slug: altSlug, title: altTitle };
        }
      }
    }

    // All alternatives failed, try with numeric suffixes on original title
    let suffix = 2;
    let uniqueSlug = `${baseSlug}-${suffix}`;

    while (suffix <= 100) { // Prevent infinite loops
      // Skip any suffix that would produce a reserved slug
      if (RESERVED_SLUGS.has(uniqueSlug)) {
        suffix++;
        uniqueSlug = `${baseSlug}-${suffix}`;
        continue;
      }

      if (!await slugExists(uniqueSlug)) {
        return { slug: uniqueSlug, title };
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
  return { slug: id, title };
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
export async function insertBook(book: DBNewBook, options: { client?: DBClient, alternativeTitles?: string[] } = {}): Promise<DBBook> {
  const { client = dbWrite, alternativeTitles } = options;

  // Generate unique slug from title (may use alternative title to avoid duplicate)
  const { slug: uniqueSlug, title: chosenTitle } = await generateUniqueSlug(book.title, alternativeTitles);
  
  // Compose final book data to be inserted
  const newBookData: DBNewBook = { // DBNewBook = typeof books.$inferInsert;
    ...book,
    id: book.id ?? generateId(),
    slug: uniqueSlug,
    title: sanitizeText(chosenTitle),
    hook: book.hook ? sanitizeText(book.hook) : null,
    summary: book.summary ? sanitizeText(book.summary) : null,
    keywords: book.keywords ? sanitizeKeywords(book.keywords) : undefined,
    status: 'active' satisfies BookStatus,
    mc: book.mc satisfies StoryMC,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const [result] = await client.insert(books).values(newBookData).returning();
  const { id, slug, title, totalPages, language, hook, summary, isOriginal, keywords, status, mc, creditsPrice } = result;

  console.log(`[insertBook] 📔 Book "${chosenTitle}" inserted:`, { id, slug, title, totalPages, language, hook, summary, isOriginal, keywords, status, mc, ...(creditsPrice ? {creditsPrice} : {}) });
  
  // Invalidate cache for this book (by both ID and slug)
  invalidateBookCache(id);
  invalidateEnrichedBookCache(id);
  invalidateEnrichedBookCache(slug!);
  
  return result;
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

  const [result] = await client
    .select()
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  return result;
}

/**
 * Gets a book by ID with LRU caching for active books
 * 
 * @param bookId - Book identifier to retrieve
 * @returns Promise resolving to the book record or null if not found
 * 
 * Behavior:
 * - Checks cache first for active books
 * - Falls back to database query if cache miss
 * - Only caches books with 'active' status (published and stable)
 * - Returns null if book doesn't exist
 */
export async function getBook(bookId: string): Promise<Book | null> {
  const cacheKey = getBookCacheKey(bookId);
  
  // Check cache first
  const cached = bookCache.get(cacheKey);
  if (cached) return cached;

  try {
    const dbResult = await getBookFromDB(bookId) ?? await getBookFromDB(bookId, { client: dbWrite });
    if (dbResult) {
      const book = mapBookFromDb(dbResult);
      // Only cache active books (published and stable)
      if (book.status === 'active') {
        bookCache.set(cacheKey, book);
      }
      return book;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Resolves a book ID by identifier (slug or UUID v7)
 *
 * If the identifier is already a valid UUID, returns it immediately.
 * Otherwise performs a lightweight query to look up the book ID by slug.
 *
 * @param identifier - Book slug or UUID v7
 * @returns Promise resolving to the book ID or null if not found
 *
 * @example
 * ```typescript
 * // UUID: early return
 * const id = await resolveBookId("0190f123-4567-...");
 *
 * // Slug: lightweight query
 * const id = await resolveBookId("twistloom");
 *
 * // Not found
 * const id = await resolveBookId("nonexistent"); // null
 * ```
 */
export async function resolveBookId(identifier: string): Promise<string | null> {
  if (isValidUuid(identifier)) return identifier;

  const [book] = await dbRead
    .select({ id: books.id })
    .from(books)
    .where(eq(books.slug, identifier))
    .limit(1);

  return book?.id ?? null;
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
  if (isValidUuid(identifier)) conditions.push(eq(books.id, identifier));

  const [book] = await dbRead.select().from(books).where(or(...conditions)).limit(1);
  if (book) return mapBookFromDb(book);

  return null;
}

/**
 * Retrieves an enriched book with author info, stats, and user-specific flags
 * 
 * Uses LRU cache for performance. Cache key includes both book identifier
 * and user ID since results are user-specific (isLiked, isRead flags).
 * 
 * Only caches books with 'active' status (published and stable).
 * 
 * @param identifier - Book slug or ID to retrieve
 * @param currentUserId - Optional current user ID for user-specific flags (isLiked, isRead)
 * @param language - Optional language filter
 * @returns Promise resolving to enriched book data or null if not found
 */
export async function getEnrichedBook(
  identifier: string,
  currentUserId?: string | null,
  language?: string | null
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

  const [result] = await dbRead
    .select(getEnrichedBookSelect(currentUserId, language))
    .from(books)
    // TODO: should add left join to userSessions & firstPageSq
    .leftJoin(users, eq(books.userId, users.userId))
    .where(or(...conditions))
    .limit(1);

  if (result) {
    const enrichedBook = result as EnrichedBookData;
    // Only cache active books (published and stable)
    if (enrichedBook.status === 'active') {
      enrichedBookCache.set(cacheKey, enrichedBook);
    }
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
  updates: DBUpdateBook,
  options?: { client?: DBClient; invalidateCache?: boolean }
): Promise<DBBook> {
  const { client = dbWrite, invalidateCache = true } = options ?? {};

  // ── Publish-transition detection (visibility: non-public → 'public') ─────
  // This is the single chokepoint for "publishing" a book, so follower
  // notifications live here — every path that flips a book public (the
  // PATCH /visibility route used by AI / pen / story books, admin tools, etc.)
  // is covered automatically. Only do the extra read when a visibility change
  // is actually requested (publishing is rare, so common edits stay cheap).
  let publishNotify: { authorId: string; bookId: string; bookSlug: string; bookTitle: string } | null = null;
  if (updates.visibility === 'public') {
    const [current] = await client
      .select({
        visibility: books.visibility,
        status: books.status,
        isOriginal: books.isOriginal,
        userId: books.userId,
        slug: books.slug,
        title: books.title,
      })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (
      current &&
      current.visibility !== 'public' &&
      current.status === 'active' &&
      !current.isOriginal &&
      current.userId
    ) {
      publishNotify = {
        authorId: current.userId,
        bookId,
        bookSlug: current.slug ?? '',
        bookTitle: current.title,
      };
    }
  }

  const [updated] = await client
    .update(books)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(books.id, bookId))
    .returning();

  if (invalidateCache) {
    // Invalidate cache for this book
    invalidateBookCache(bookId);
    invalidateEnrichedBookCache(bookId);
    // Book metadata changes (e.g. title → main-branch branchName) must not
    // leave a stale 30-day page 1 payload behind
    await invalidatePageOneCache(bookId);
  }

  // Fire follower notifications outside the (possible) transaction so a publish
  // is always announced even if this call is nested in a larger tx. Best-effort:
  // a failure here must never break the publish itself.
  if (publishNotify) {
    void notifyFollowersOfPublishedBook(publishNotify).catch((e) => {
      console.error('[updateBook] ❌ Failed to notify followers of published book:', getErrorMessage(e));
    });
  }

  return updated;
}

/**
 * Updates a book's visibility setting
 *
 * Validates the visibility value against allowed values before updating.
 * Only the book owner or an admin can change visibility.
 *
 * @param bookId - Book identifier to update
 * @param visibility - New visibility value ('private' | 'followers' | 'public')
 * @returns Promise resolving to the updated book record
 *
 * @throws Error if visibility value is invalid
 */
export async function updateBookVisibility(
  bookId: string,
  visibility: BookVisibility,
): Promise<DBBook> {
  if (!bookVisibilities.includes(visibility)) {
    throw new Error(`Invalid visibility value. Must be one of: ${bookVisibilities.join(', ')}`);
  }

  return updateBook(bookId, { visibility });
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
        const [book] = await client
          .select({ id: books.id })
          .from(books)
          .where(eq(books.slug, bookIdentifier))
          .limit(1);

        if (book) bookId = book.id;
      }
  
      if (!bookId) {
        // throw new Error("Book not found");
        return null;
      }
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

    return result.length ? result[0] : null;
  } catch (error) {
    console.error(`[getPageFromDB] ❌ Failed to get page ${pageId}:`, error);
    // throw new Error(`Unable to retrieve page: ${errorMessage}`, { cause: error });
    return null;
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
export async function getPageActionsFromDB(userId: string, bookId: string, pageId: string): Promise<SelectedAction[]> {
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
export async function mapToUserStoryPage(dbPage: DBPage, userId: string, selectedActions?: SelectedAction[]): Promise<UserStoryPage> {
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
    placeId: dbPage.placeId || undefined,
    weather: dbPage.weather || 'unknown',
    calendarDate: dbPage.calendarDate || undefined,
    elapsedDays: dbPage.elapsedDays,
    timeOfDay: dbPage.timeOfDay || undefined,
    sceneType: dbPage.sceneType || undefined,
    momentum: dbPage.momentum || undefined,
    charactersPresent: dbPage.charactersPresent,
    keyEvents: dbPage.keyEvents,
    keyObjects: dbPage.keyObjects,
    actions: dbPage.actions,
    stateDelta: dbPage.stateDelta || {},
    aiProvider: dbPage.aiProvider || 'none',
    aiModel: dbPage.aiModel || 'none',
    aiEvalProvider: dbPage.aiEvalProvider || 'none',
    aiEvalModel: dbPage.aiEvalModel || 'none',
    scoreBefore: dbPage.scoreBefore ?? null,
    scoreAfter: dbPage.scoreAfter ?? null,
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
    placeId: dbPage.placeId || undefined,
    weather: dbPage.weather || 'unknown',
    calendarDate: dbPage.calendarDate || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    sceneType: dbPage.sceneType || undefined,
    momentum: dbPage.momentum || undefined,
    charactersPresent: dbPage.charactersPresent || [],
    keyEvents: dbPage.keyEvents || [],
    keyObjects: dbPage.keyObjects || [],
    actions: dbPage.actions || [],
    stateDelta: dbPage.stateDelta || {},
  } satisfies Record<keyof StoryPage, unknown>;
}

/**
 * Applies a `PageTranslation` overlay on top of a `PersistedStoryPage` and returns
 * an enriched page ready to serve to the client.
 *
 * This is the single entry-point for the page-translation pipeline in the request
 * handler layer. It orchestrates:
 * 1. Converting the raw `DBPage` to a typed `PersistedStoryPage`
 * 2. Determining whether translation is needed (`shouldTranslate`)
 * 3. Fetching/caching the translation (`getPageTranslation`)
 * 4. Merging translated fields onto the page (`applyPageTranslation`)
 *
 * Falls back gracefully to the original page on any translation failure; callers
 * should not need to handle translation errors separately.
 *
 * @param dbPage  - Raw database page record
 * @param options - Enrichment options including language and translate flag
 * @returns `PersistedStoryPage` with translated fields applied (or original if not needed)
 *
 * @example
 * ```typescript
 * const translatedPage = await mapToTranslatedPage(dbPage, {
 *   bookLanguage: book.language,
 *   headerLanguage: c.req.header('accept-language'),
 *   translate: true,
 * });
 * c.json(enrichedPage);
 * ```
 */
export async function mapToTranslatedPage(
  dbPage: DBPage,
  options: EnrichedPageOptions
): Promise<TranslatedStoryPage> {
  const page = mapToPersistedStoryPage(dbPage);
  const { translate, book, headerLanguage } = options;
  const { language } = book ?? {};

  // Skip translation when not requested or book language is unavailable
  if (!translate || !language) return page;

  const targetLanguage = shouldTranslate(language, headerLanguage);
  if (!targetLanguage) return page; // Same language — no translation needed

  const pageToTranslate = await getPageToTranslate(dbPage);
  if (!pageToTranslate) return page;

  const { translation, error } = await getPageTranslation({
    page: pageToTranslate,
    language,
    targetLanguage,
  });

  if (error) {
    // Log and fall back silently — callers always get a usable page
    console.warn(`[mapToTranslatedPage] ⚠️ Translation failed for page ${page.id}:`, error.message);
    return page;
  }

  if (!translation) return page;

  return applyPageTranslation(page, translation);
}

/**
 * Builds the query for community custom actions on a page.
 *
 * Same language, non-rejected, highest plausibility first, capped at
 * `MAX_ACTION_CHOICES_COMMUNITY`. The current user's own actions are excluded
 * when authenticated.
 *
 * The returned Drizzle builder is lazy — it only executes when awaited, so it
 * can be created up-front and awaited exactly once per request path.
 *
 * Exported so the frontend's lazy-load endpoint
 * `GET /:id/pages/:pageId/community-actions` (used to fetch community actions
 * once the reader scrolls down to the action area, on any page) reuses the
 * exact same query — including the current user's own actions being excluded.
 *
 * Community actions are intentionally NOT loaded in the enriched page path;
 * this query is only ever run by the dedicated lazy-load endpoint.
 *
 * @param bookId - Book identifier
 * @param pageId - Page identifier
 * @param userId - Optional current user ID (their own actions are excluded)
 * @param language - Content language to filter on
 * @returns Lazy Drizzle query for community custom actions
 */
export function loadCommunityActions(bookId: string, pageId: string, userId?: string | null, language = 'en') {
  return dbRead
    .select({
      text: customActions.originalText,
      plausibilityScore: sql<number>`COALESCE(${customActions.plausibilityScore}, 0)`,
      nextPageId: customActions.nextPageId,
    })
    .from(customActions)
    .where(and(
      eq(customActions.bookId, bookId),
      eq(customActions.pageId, pageId),
      ...(userId ? [ne(customActions.userId, userId)] : []),
      ne(customActions.outcome, 'reject'),
      eq(customActions.language, language),
    ))
    .orderBy(desc(customActions.plausibilityScore))
    .limit(MAX_ACTION_CHOICES_COMMUNITY);
}

/**
 * Loads the current user's OWN custom actions for a page (the "custom action"
 * rows they submitted here). These are merged into the enriched page payload
 * as the reader's own action choices — appended to the page's canon actions so
 * they remain visible across page refreshes and drive candidate-generation
 * polling via `originalActionsCount`. Other users' submissions stay in the
 * separate community list (`loadCommunityActions`).
 *
 * Returns every non-rejected row (pending + completed). Rows without a
 * `nextPageId` are still generating; once generation backfills `nextPageId`
 * they surface as navigable choices.
 *
 * @param bookId - Book identifier
 * @param pageId - Page identifier
 * @param userId - Current user ID (their own custom actions)
 * @param language - Content language to filter on
 * @returns Lazy Drizzle query for the user's own custom actions
 */
export function loadOwnCustomActions(bookId: string, pageId: string, userId: string) {
  return dbRead
    .select({
      id: customActions.id,
      text: customActions.originalText,
      actionType: customActions.actionType,
      hintType: customActions.hintType,
      canonicalIntent: customActions.canonicalIntent,
      hintText: customActions.hintText,
      nextPageId: customActions.nextPageId,
      generationStartedAt: customActions.generationStartedAt,
    })
    .from(customActions)
    .where(and(
      eq(customActions.bookId, bookId),
      eq(customActions.pageId, pageId),
      eq(customActions.userId, userId),
      ne(customActions.outcome, 'reject'),
    ))
    .orderBy(desc(customActions.createdAt));
}

/**
 * Maps one of the current user's own custom-action rows to an `Action`.
 * Completed rows carry their generated destination; pending ones don't (they
 * ship with an empty `destinationPageIds` and are included in `visibleActions`
 * so the reader sees the choice immediately — disabled — while it generates).
 *
 * Delegates to the shared `buildCustomActionAction` builder (the same one used
 * by `buildCanonicalAction` at submit time) so reloads are byte-identical to
 * the originally-submitted Action.
 */
export function mapCustomActionRowToAction(row: {
  id: string;
  text: string;
  actionType: string | null;
  hintType: string | null;
  canonicalIntent: string | null;
  hintText: string | null;
  nextPageId: string | null;
}): Action {
  return buildCustomActionAction({
    originalText: row.text,
    interpretedIntent: row.canonicalIntent ?? '',
    hintText: row.hintText ?? '',
    hintType: (row.hintType as ActionHintType) || 'custom',
    actionType: (row.actionType as ActionType) || 'custom',
    nextPageId: row.nextPageId,
    customActionId: row.id,
  });
}

/**
 * Builds the query for per-paragraph comment counts on a page.
 *
 * Page-level comments (no paragraph scope) are reported under key `0`. Grouped
 * server-side to avoid transferring full comment rows for the count badges.
 *
 * Exported so the lightweight `GET /:id/pages/:pageId/comment-counts` endpoint
 * (used by the frontend to refresh badge values in the background) can reuse
 * the exact same aggregation as the enriched page payload.
 *
 * The returned Drizzle builder is lazy — it only executes when awaited, so it
 * can be created up-front and awaited exactly once per request path.
 *
 * @param bookId - Book identifier
 * @param pageId - Page identifier
 * @returns Lazy Drizzle query returning `{ paragraphNumber, count }` rows
 */
export function loadParagraphCommentCounts(bookId: string, pageId: string) {
  return dbRead
    .select({
      paragraphNumber: sql<number>`COALESCE(${userComments.paragraphNumber}, 0)`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(userComments)
    .where(and(
      eq(userComments.bookId, bookId),
      eq(userComments.pageId, pageId),
    ))
    .groupBy(sql`COALESCE(${userComments.paragraphNumber}, 0)`);
}

/**
 * Builds the query for the latest canon validation audit on a page.
 *
 * The returned Drizzle builder is lazy — it only executes when awaited, so it
 * can be created up-front and awaited exactly once per request path.
 *
 * @param pageId - Page identifier
 * @returns Lazy Drizzle query returning the most recent audit row or null
 */
function loadLatestCanonValidation(pageId: string) {
  return dbRead
    .select({
      outcome: canonValidations.outcome,
      violationType: canonValidations.violationType,
      severityScore: canonValidations.severityScore,
      wasRevised: canonValidations.wasRevised,
    })
    .from(canonValidations)
    .where(eq(canonValidations.pageId, pageId))
    .orderBy(desc(canonValidations.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Maps database page data to enriched page format with caching
 *
 * This function transforms raw database page data into a frontend-ready format,
 * including user-specific data (selected actions), translation support, and
 * story context. Uses LRU cache for performance when pages have complete actions.
 *
 * **Caching Behavior:**
 * - Page 1 of an active book is cached in Redis (keyed by bookId + content
 *   language, 30-day TTL). The full static payload is stored including
 *   paragraphCommentCounts and canonValidation (best-effort instant-render
 *   data that may be up to the TTL stale — the frontend polls the dedicated
 *   comment-counts endpoint for the authoritative badge values). A Redis hit
 *   performs ZERO database queries.
 * - Page 1 always omits per-user/deferrable fields: `selectedActions` and
 *   `shownActionHint` are empty (no prior choice to hint — the reader may
 *   freely pick any action).
 * - Community actions are omitted from EVERY page's payload (page 1 and
 *   beyond). They live at the very bottom of the page, so the frontend
 *   lazy-loads them from the dedicated community-actions endpoint once the
 *   reader scrolls down to the action area — keeping that query off every
 *   page's hot path and keeping cached payloads user-independent.
 * - All other pages use the in-memory LRU cache.
 * - Only caches pages with no incomplete actions (all actions have destinations)
 * - Pages with pending generation are not cached since they change frequently
 * - LRU cache key includes: pageId, userId, translate, headerLanguage
 * - LRU cache TTL: 2 minutes to balance freshness with performance
 *
 * **User-Specific Data:**
 * - selectedActions: User's chosen actions for this page (varies per user)
 * - translation: Translated page if Accept-Language differs from book language
 * - context: Story state including places, characters, injuries, inventory
 *
 * **Story Context (Single Source of Truth):**
 * `context.actionsHistory` and `context.plotFlags` are read directly from the
 * persisted StoryState for this page. Because `persistPageWithState` accumulates
 * both fields on every page generation, these arrays always represent the full
 * chronological sequence from page 1 to the current page:
 *
 * ```
 * actionsHistory[0] = action taken on page 1 → led to page 2
 * actionsHistory[1] = action taken on page 2 → led to page 3
 * …
 * actionsHistory[n-2] = action taken on page n-1 → led to page n (current)
 *
 * plotFlags[0..k] = all narrative flags added from page 1 through current
 * ```
 *
 * The convenience field `sourceAction` (the single action that led to the
 * current page) is equivalent to `context.actionsHistory.at(-1)` but is
 * provided explicitly so the frontend can display "You chose: …" without
 * having to sort the history array.
 *
 * **Performance Considerations:**
 * - Database queries: selectedActions (if authenticated), storyState
 * - Translation API call: Only when translation is requested and needed
 * - Cache hit: Returns immediately without database queries
 *
 * @param dbPage - Raw page data from database
 * @param options - Configuration options for enrichment
 * @param options.userId           - Optional current user ID for user-specific selectedActions
 * @param options.bookLanguage     - Book's language code (default: 'en')
 * @param options.headerLanguage   - Optional target language for translation
 * @param options.translate        - Whether to enable translation (default: false)
 * @param options.sourceAction     - Action that led to this page (required for pages > 1
 *                                   when isUserTakeAction is true; used for the
 *                                   "You chose: …" display)
 * @param options.isUserTakeAction - Whether this is a real navigation action by the user
 * @returns Promise resolving to enriched page or null if mapping fails
 *
 * @example
 * ```typescript
 * // Basic usage without translation
 * const page = await mapToEnrichedPage(dbPage, { userId: 'user123' });
 *
 * // With translation to Spanish
 * const page = await mapToEnrichedPage(dbPage, {
 *   userId: 'user123',
 *   bookLanguage: 'en',
 *   headerLanguage: 'es',
 *   translate: true,
 * });
 *
 * // Full page-visit usage (from the route handler)
 * const page = await mapToEnrichedPage(dbPage, {
 *   userId,
 *   bookLanguage: book.language,
 *   headerLanguage,
 *   translate,
 *   sourceAction,   // action that led here — mirrors context.actionsHistory.at(-1)
 *   isUserTakeAction,
 * });
 *
 * // Accessing the full action + plot-flag chronology:
 * page.context?.actionsHistory
 * // [
 * //   { page: 1, pageId: 'page123', text: 'Run away.',      nextPageId: 'page456', ... },
 * //   { page: 2, pageId: 'page456', text: 'Open the door.', nextPageId: 'page789', ... },
 * // ]
 *
 * page.context?.plotFlags
 * // [
 * //   { page: 1, fact: 'MC witnessed the murder.', type: 'revelation', isMajorEvent: true },
 * //   { page: 2, fact: 'The door leads to the cellar.', type: 'discovery', isMajorEvent: false },
 * // ]
 * ```
 */
export async function mapToEnrichedPage(dbPage: DBPage, options: EnrichedPageOptions): Promise<EnrichedStoryPage | null> {
  const { userId, book, headerLanguage, translate = false, sourceAction, isUserTakeAction } = options;
  const { language = 'en' } = book ?? {};

  const canonActions = dbPage.actions;
  let allActions = canonActions;
  // Ship EVERY action — completed AND still-pending — so the reader sees all
  // choices immediately on first render. Actions whose `destinationPageIds` is
  // still empty render as disabled buttons with a progress/radar indicator
  // (see StoryActionButton: isDisabledByProgress + getProgressIcon), and become
  // clickable the moment candidate generation resolves their destination. The
  // old filter (completed-only) was what left the frontend with NO buttons on
  // a fresh page until the first poll round-trip.
  let visibleActions = canonActions;
  // Cache-gating flag: a page is "incomplete" while ANY action lacks a
  // destination. Such pages must never be served from / written to the Redis or
  // LRU caches — a cached copy would freeze the pending actions as permanently
  // disabled. Computed independently of `visibleActions` (which now always
  // carries the full list) so the two concerns stay decoupled.
  let hasIncompleteActions = allActions.some(action => !action.destinationPageIds?.length);
  const { id: pageId, bookId } = dbPage;
  const isPageOne = dbPage.page === 1;

  // ── Own custom actions (reader-authored choices) ────────────────────────────
  // Merged into this reader's action list for pages > 1: pending ones (no
  // nextPageId yet) raise `originalActionsCount` so the frontend's candidate
  // polling re-engages, completed ones surface as navigable choices. Restricted
  // to pages > 1 because page 1 is cached user-independently (Redis) and custom
  // actions are disabled there by the submit gate. When the owner has ANY custom
  // action on the page, the payload must never be served from the shared LRU
  // cache (a cached copy would lack the merged rows).
  let hasOwnCustomActions = false;
  if (!isPageOne && userId) {
    const ownCustomActionRows = await loadOwnCustomActions(bookId, pageId, userId);
    if (ownCustomActionRows.length > 0) {
      hasOwnCustomActions = true;
      allActions = [...allActions, ...ownCustomActionRows.map(mapCustomActionRowToAction)];
      visibleActions = allActions;
      hasIncompleteActions = allActions.some(action => !action.destinationPageIds?.length);
    }
  }

  // Determine if translation is needed (synchronous check)
  const targetLanguage = translate ? shouldTranslate(language, headerLanguage) : undefined;

  // ── Page 1 → Redis cache (static content shared across all users) ───────────
  //
  // Page 1 content is immutable per book, so the fully-enriched payload is
  // cached in Redis keyed by bookId + effective content language (translation
  // changes the content). Only active books qualify — draft books are transient
  // (they may be regenerated) and must not poison the long-lived cache.
  //
  // The payload is user-independent because page 1 has no parent action, so
  // selectedActions is always empty. Page 1 also omits shownActionHint (no
  // prior choice to hint — the reader may still freely pick any action).
  // Community actions are omitted from every page's payload — see the note at
  // the Promise.all below; they live at the very bottom of the page, so the
  // frontend lazy-loads them from a dedicated endpoint once the reader scrolls
  // down to the action area.
  // The stored payload includes the static paragraphCommentCounts and
  // canonValidation as best-effort instant-render data; on a hit we only fix up
  // updatedAt. A Redis hit therefore needs ZERO database queries. On a miss we
  // fall through to the shared enrichment path and store the full static payload
  // back into Redis.
  const useRedisForPageOne = isPageOne && !hasIncompleteActions && book?.status === 'active' && isRedisAvailable();
  const pageOneRedisKey = useRedisForPageOne
    ? getPageOneCacheKey(bookId, (targetLanguage || language || 'en').toLowerCase())
    : null;

  if (useRedisForPageOne) {
    const cached = await getFromCache<EnrichedStoryPage>(pageOneRedisKey!);
    if (cached.hit && cached.data) {
      // Re-merge only the cheap constants over the cached static payload.
      // paragraphCommentCounts and canonValidation ship from cache as
      // best-effort data; the frontend polls the comment-counts endpoint for
      // the authoritative badge values and lazy-loads community actions.
      return {
        ...cached.data,
        // Keep the payload's updatedAt in sync with the always-fresh DB row
        // (the route derives its ETag from dbPage.updatedAt).
        updatedAt: dbPage.updatedAt,
        selectedActions: [],
        shownActionHint: [],
        communityActions: undefined,
      };
    }
  }

  // Check the in-memory LRU cache first (pages > 1, or page 1 when Redis is not
  // eligible/unavailable — preserves the pre-Redis behaviour for those cases).
  // Re-merge `communityActions` to undefined in case a stale entry (written before
  // the lazy-load change, or by the shared path) still carries an old list.
  const cacheKey = getEnrichedPageCacheKey(pageId, userId, translate, headerLanguage);
  if (!hasIncompleteActions && !hasOwnCustomActions) {
    const cached = enrichedPageCache.get(cacheKey);
    if (cached) return { ...cached, communityActions: undefined };
  }

  // Fetch the page document to translate (only when translation is requested).
  // Runs after the cache checks so LRU hits stay query-free.
  const pageToTranslate = targetLanguage ? await getPageToTranslate(dbPage) : undefined;

  // Resolve human-readable branch name: query branches table for non-main branches,
  // fall back to book title for "main" branch
  const branchNamePromise = dbPage.branchId === "main"
    ? Promise.resolve(book?.title ?? null)
    : dbRead
        .select({ displayName: branches.displayName })
        .from(branches)
        .where(and(
          eq(branches.branchId, dbPage.branchId),
          eq(branches.bookId, bookId),
        ))
        .limit(1)
        .then(rows => rows[0]?.displayName ?? book?.title ?? null);

  // Parallelize independent database queries and API calls.
  //
  // NOTE: communityActions are intentionally NOT loaded here for any page.
  // They live at the very bottom of the page (after the story text and the
  // reader's own choices), so the frontend lazy-loads them from the dedicated
  // community-actions endpoint once the reader scrolls down to the action
  // area — removing the query from every page's hot path across all page
  // numbers, not just page 1.
  const [selectedActions, storyState, translation, shownActionHint, branchName, paragraphCommentCountsRows, latestCanonValidation] = await Promise.all([
    // Query user's chosen action for this page (if authenticated).
    // Page 1 has no parent page → no previously-selected action is possible.
    isPageOne
      ? Promise.resolve<SelectedAction[]>([])
      : (userId ? getPageActionsFromDB(userId, bookId, pageId) : Promise.resolve<SelectedAction[]>([])),

    // Get story state for context — actionsHistory and plotFlags are fully
    // accumulated from page 1 to current by persistPageWithState
    getStoryStateFromPage(dbPage),

    // Handle translation if needed
    targetLanguage && pageToTranslate ? getPageTranslation({
      page: pageToTranslate,
      language,
      targetLanguage
    }).then(result => result.translation) : Promise.resolve(undefined),

    // Fetch user's purchased action hints for this page (if authenticated).
    // Page 1 omits hints — the reader may freely choose, so there is nothing
    // to reveal/reveal.
    isPageOne
      ? Promise.resolve<string[]>([])
      : (userId ? getUserActionHints(userId, pageId) : Promise.resolve<string[]>([])),

    // Resolve human-readable branch name
    branchNamePromise,

    // Fetch per-paragraph comment counts for this page (page-level comments
    // use paragraphNumber = 0). Grouped server-side to avoid transferring
    // full comment rows for the count badges.
    loadParagraphCommentCounts(bookId, pageId),

    // Latest canon validation audit for this page (roadmap 1.1)
    loadLatestCanonValidation(pageId),
  ]);

  if (targetLanguage && translation) {
    console.log(`[mapToEnrichedPage] 🌐 Page translated to ${targetLanguage}: ${translation.text.slice(0, 25)}...`);
  } else if (targetLanguage) {
    console.warn(`[mapToEnrichedPage] ⚠️ Page translation failed`);
  }

  // Extract context from story state if available.
  // actionsHistory: full sequence of actions taken from page 1 to reach this page.
  // plotFlags:      all narrative flags accumulated from page 1 through current page.
  let context: EnrichedStoryPageContext | undefined;
  if (storyState) {
    const { places, characters, injuries, inventory, healthStatus, sanityState, contextHistory, actionsHistory, plotFlags, threads, viableEnding, flags, traumaTags } = storyState;
    const { phase } = getStoryStateInfo(storyState);
    const activeThreads = threads.filter(t => ['open', 'developing'].includes(t.status));
    // Reader-safe composure slice (omit decayRate — engine-only)
    const enrichedSanity = sanityState
      ? {
          composure: sanityState.composure,
          maxComposure: sanityState.maxComposure,
          hasCrashed: sanityState.hasCrashed,
          ...(sanityState.crashedAtPage != null && { crashedAtPage: sanityState.crashedAtPage }),
        }
      : undefined;
    context = {
      phase,
      healthStatus,
      sanityState: enrichedSanity,
      injuries,
      inventory: inventory.map(item => ({
        ...item,
        traits: item.traits?.map(parseTrait)
      })),
      contextHistory,
      actionsHistory,
      plotFlags,
      flags,
      traumaTags,
      threads: activeThreads,
      ending: viableEnding,
      maxPage: storyState.maxPage,
      // Filter only necessary fields for frontend
      places: Object.entries(places).map(([placeId, place]) => ({
        placeId,
        name: place.isRealNameKnown ? place.realName : place.knownName,
        type: place.type,
        category: place.category,
        context: place.context,
        traits: place.traits?.map(parseTrait),
        names: resolvePlaceLoreNames(place),
        lastVisitedAtPage: place.lastVisitedAtPage,
      }) satisfies Record<keyof EnrichedStoryPagePlace, unknown>),
      characters: Object.entries(characters).map(([characterId, character]) => ({
        characterId,
        name: ['full_name_known', 'first_name_known'].includes(character.recognitionLevel) ? character.realName : character.knownName,
        gender: character.gender,
        role: character.role,
        bio: character.bio,
        traits: character.traits?.map(parseTrait),
        names: resolveCharacterLoreNames(character),
        lastInteractionAtPage: character.pastInteractions?.length
          ? Math.max(...character.pastInteractions.map(pi => pi.page))
          : character.introducedAtPage,
      }) satisfies Record<keyof EnrichedStoryPageCharacter, unknown>)
    } satisfies Record<keyof EnrichedStoryPageContext, unknown>;
  }

  if (isUserTakeAction && dbPage.page > 1 && !sourceAction) {
    console.error(`[mapToEnrichedPage] ❌ Source action should be exists for page ${dbPage.page}`);
  }

  // Return only frontend-relevant fields.
  // Exclude backend-specific fields: userId, aiEvalProvider,
  // aiEvalModel, pendingGenerationCount.
  const enrichedPage: EnrichedStoryPage = {
    id: dbPage.id,
    page: dbPage.page,
    bookId: dbPage.bookId,
    branchId: dbPage.branchId,
    parentId: dbPage.parentId,
    text: dbPage.text,
    mood: dbPage.mood || undefined,
    placeId: dbPage.placeId || undefined,
    weather: dbPage.weather || undefined,
    calendarDate: dbPage.calendarDate || undefined,
    elapsedDays: dbPage.elapsedDays || undefined,
    timeOfDay: dbPage.timeOfDay || undefined,
    sceneType: dbPage.sceneType || undefined,
    momentum: dbPage.momentum || undefined,
    charactersPresent: dbPage.charactersPresent,
    keyEvents: dbPage.keyEvents,
    keyObjects: dbPage.keyObjects,
    createdAt: dbPage.createdAt,
    updatedAt: dbPage.updatedAt,

    // Enriched columns
    actions: visibleActions, // ALL actions — completed AND still-pending (empty destinationPageIds until generation resolves them)
    originalActionsCount: allActions.length,
    selectedActions,
    sourceAction, // sourceAction is the convenience shortcut for the single action that led to this page.
    branchName: branchName ?? undefined,
    translation: translation
      ? ({
          ...translation,
          characters: translation.characters?.map(ch => ({
            ...ch,
            traits: (ch.traits as string[] | undefined)?.map(parseTrait)
          })),
          places: translation.places?.map(place => ({
            ...place,
            traits: (place.traits as string[] | undefined)?.map(parseTrait)
          })),
          inventory: translation.inventory?.map(item => ({
            ...item,
            traits: (item.traits as string[] | undefined)?.map(parseTrait)
          }))
        } as typeof translation)
      : undefined,
    shownActionHint,
    context, // context is the SSOT for full action + plot-flag history
    // Community actions are never bundled into the page payload. They live at
    // the very bottom of the page, so the frontend lazy-loads them from the
    // dedicated community-actions endpoint once the reader scrolls down to the
    // action area — for every page, not just page 1. Keeps the query off every
    // page's hot path and keeps cached payloads user-independent (community
    // actions otherwise vary per-user by excluding their own submissions).
    communityActions: undefined,

    // Per-paragraph comment counts for this page (key 0 = page-level comments)
    paragraphCommentCounts: paragraphCommentCountsRows.length > 0
      ? Object.fromEntries(paragraphCommentCountsRows.map(row => [row.paragraphNumber, row.count]))
      : undefined,

    // Provider info
    aiProvider: dbPage.aiProvider || undefined,
    aiModel: dbPage.aiModel || undefined,
    aiEvalProvider: dbPage.aiEvalProvider || undefined,
    aiEvalModel: dbPage.aiEvalModel || undefined,

    // Canon validation summary (roadmap 1.1)
    canonValidation: latestCanonValidation
      ? ({
          outcome: latestCanonValidation.outcome,
          violationType: latestCanonValidation.violationType ?? undefined,
          severityScore: latestCanonValidation.severityScore ?? undefined,
          wasRevised: latestCanonValidation.wasRevised,
        } satisfies CanonValidationSummary)
      : undefined,
  // } satisfies Record<keyof EnrichedStoryPage, unknown>;
  };

  // Cache the result only if page has complete actions (no pending generation)
  if (!hasIncompleteActions) {
    if (useRedisForPageOne) {
      // Page 1 → Redis (static identity per book + language: text, context,
      // translations, actions, metadata, comment counts, canon validation).
      // Page 1 always carries empty per-user fields (no hints, no community
      // actions, no selected actions), so the payload is safe to share across
      // all readers unchanged.
      await setCache(
        pageOneRedisKey!,
        {
          ...enrichedPage,
          selectedActions: [],
          shownActionHint: [],
          communityActions: undefined,
        },
        CACHE_TTL.PAGE_ONE,
      );
    } else {
      enrichedPageCache.set(cacheKey, enrichedPage);
    }
  }

  return enrichedPage;
}

/**
 * Fetches user's purchased action hints for a specific page
 * 
 * This function queries the database to find all action hints that the user
 * has purchased for a specific page. These hints represent actions for which
 * the user has paid 1 credit to reveal additional information.
 * 
 * @param userId - User ID to fetch hints for
 * @param pageId - Page ID to fetch hints for
 * @returns Array of action texts for which hints have been purchased
 * 
 * @example
 * ```typescript
 * const hints = await getUserActionHints('user123', 'page456');
 * console.log('Purchased hints:', hints); // ['Investigate the noise', 'Run away']
 * ```
 */
export async function getUserActionHints(userId: string, pageId: string): Promise<string[]> {
  try {
    const hints = await dbRead
      .select({ actionText: userActionHints.actionText })
      .from(userActionHints)
      .where(and(
        eq(userActionHints.userId, userId),
        eq(userActionHints.pageId, pageId)
      ));
    
    return hints.map(h => h.actionText);
  } catch (error) {
    console.error(`[getUserActionHints] ❌ Failed to fetch hints for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    return [];
  }
}

/**
 * Sanitizes a single book metadata text field with consistent rules.
 *
 * Mirrors the sanitizeFieldValue pattern from user.ts.
 * Returns `undefined` when the input is not a usable string — the caller
 * interprets this as "skip this field" for partial updates.
 *
 * Field-specific rules:
 * - `title`   → sanitizeText (XSS + double-quote correction)
 * - `hook`    → sanitizeText
 * - `summary` → sanitizeText
 *
 * @param field - The book field to sanitize
 * @param value - Raw value from the request body
 * @returns Sanitized text, or undefined to skip
 *
 * @example
 * sanitizeBookTextField('title', '  New Title  ')       // 'New Title'
 * sanitizeBookTextField('hook', '<script>...</script>') // '' (XSS stripped)
 * sanitizeBookTextField('title', '')                     // undefined
 */
export function sanitizeBookTextField(
  field: 'title' | 'hook' | 'summary',
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return sanitizeText(trimmed);
}

/**
 * Uploads a main character avatar image to ImageKit
 *
 * Wraps {@link uploadBookCharacterImage} with consistent logging and null-guarding.
 * Callers are responsible for persisting to `uploaded_images` via
 * {@link persistUploadedImage}.
 *
 * @param bookMeta - Book metadata used for ImageKit tags and filenames
 * @param image - Image source (URL, base64, or file object)
 * @returns ImageKit upload response, or null on failure
 */
export async function uploadBookCharacterAvatarImage(
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords'>,
  image: ImageUploadSource,
): Promise<ImageKitUploadResponse | null> {
  try {
    const characterName = bookMeta.title ? `avatar-${bookMeta.title}` : 'avatar';
    const uploadResult = await uploadBookCharacterImage(image, bookMeta.id, characterName);

    if (!uploadResult?.url) {
      console.warn(`[uploadBookCharacterAvatarImage] ⚠️ Failed to upload MC avatar for book ${bookMeta.id}`);
      return null;
    }

    console.log(`[uploadBookCharacterAvatarImage] 🌐 Uploaded MC avatar: ${uploadResult.url}`);

    return uploadResult;
  } catch (error) {
    console.error('[uploadBookCharacterAvatarImage] ❌ Error:', { bookId: bookMeta.id, error: getErrorMessage(error) });
    return null;
  }
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
    language: dbBook.language || 'en',
    hook: dbBook.hook || '',
    summary: dbBook.summary || '',
    imageId: dbBook.imageId || undefined,
    trendingScore: dbBook.trendingScore || 0,
    keywords: dbBook.keywords,
    status: dbBook.status || 'active',
    visibility: dbBook.visibility || 'private',
    mc: dbBook.mc,
    topPick: dbBook.topPick || undefined,
    isOriginal: dbBook.isOriginal ?? false,
    isPenBook: dbBook.isPenBook ?? false,
    authoringStatus: dbBook.authoringStatus ?? 'draft',
    mode: dbBook.mode ?? 'interactive',
    creditsPrice: dbBook.creditsPrice || 0,
    originalThemeInput: dbBook.originalThemeInput || undefined,
    storyStartDate: dbBook.storyStartDate || undefined,
    canonVersion: dbBook.canonVersion ?? 0,
    advancedOptions: dbBook.advancedOptions || undefined,
    ending: dbBook.ending || undefined,
    createdAt: dbBook.createdAt,
    updatedAt: dbBook.updatedAt,
  } satisfies Record<keyof Omit<Book, 'stats' | 'imageUrl'>, unknown>;
}

/**
 * Core system prompt defining the AI writer's persona and fundamental behavior
 * 
 * This prompt establishes the psychological thriller writer persona inspired by
 * R.L. Stine but darker, with specific rules for narrative manipulation and
 * psychological horror elements.
 */
export async function buildBookMetaDocuments(
  book?: Book,
  state?: Pick<StoryState, 'characters' | 'plannedCharacters' | 'places' | 'page'>,
  /**
   * pgvector semantic memory (Use Cases 2 & 5) — pre-computed "recalled"
   * blocks keyed by characterId/placeId, for interactions/events that have
   * scrolled out of the live pastInteractions/keyEvents sliding windows.
   * Optional and additive: omitting this changes nothing about the existing
   * output. Computed once in prepareNextPageGenerationSetup (prompt.ts),
   * before this function is called — never fetched from inside here.
   */
  semanticRecall?: { characters?: Record<string, string>; places?: Record<string, string> }
): Promise<AIPromptDocuments> {
  const documents: AIDocument[] = [];

  if (book) {
    documents.push({ title: `BOOK META`, snippet: formatBookMetaForPrompt(book) });
    documents.push({ title: `KNOWN CHARACTERS`, snippet: formatCharactersForPrompt(book.mc, state?.characters ?? {}, semanticRecall?.characters) });
    if (state?.plannedCharacters?.length) documents.push({ title: `PLANNED CHARACTERS`, snippet: formatPlannedCharactersForPrompt(state.plannedCharacters) });
  }
  if (state) {
    documents.push({ title: `KNOWN PLACES`, snippet: formatPlacesForPrompt(state.places, state.page, semanticRecall?.places) });
  }

  // Generate unique identifier per identical `book.id + state.characters + state.places`
  const cachedContentId = await createCacheKey([
    book?.id,
    state?.characters ? Object.values(state.characters) : undefined,
    state?.plannedCharacters ? state.plannedCharacters : undefined,
    state?.places ? Object.values(state.places) : undefined,
  ].filter(Boolean));

  return { documents, cachedContentId };
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
  const [firstPage] = await dbRead
    .select()
    .from(pages)
    .where(and(eq(pages.bookId, bookId), eq(pages.page, 1)))
    .limit(1);
  
  return firstPage;
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
export async function generateCoverImages(book: Book, state?: StoryState, total?: number): Promise<Uint8Array[]> {
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
    const bookMeta = await buildBookMetaDocuments(book, state);
    const mcGender = book.mc.gender;
    const mcAge = book.mc.age;
    const mcAppearance = mcGender == 'male' ? 'dapper' : 'lovely';
    const taskPrompt = `Create compelling book cover for thriller novel - dramatic, clear minimum texts, high-impact design, cartoony Goosebumps style (not realistic). Focus on ${mcAppearance} ${mcAge} years-old ${mcGender} protagonist.`;
    const fullPrompt = formatSystemPromptWithDocuments('gemini', {
      systemPrompt: taskPrompt,
      documents: bookMeta.documents,
      logPrompts: true
    });
    
    // Generate images without writing to disk
    const { buffers } = await geminiGenerateImage(fullPrompt, {
      numberOfImages: total || 1,
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
 * Uploads book cover image to ImageKit
 * 
 * Handles image upload to ImageKit only. Does NOT update the book record,
 * persist to uploaded_images, or queue deletion. Callers are responsible
 * for all three of those steps.
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
 *   await persistUploadedImage({
 *     imageId: result.fileId!, imageUrl: result.url!,
 *     type: 'cover', userId,
 *   });
 *   await updateBook(bookId, { imageId: result.fileId });
 *   await deleteFileFromImageKit(oldImageId);
 * }
 * ```
 */
export async function uploadBookCoverImage(
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords' | 'slug'>,
  image: ImageUploadSource,
): Promise<ImageKitUploadResponse | null> {
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
  const buffers = await generateCoverImages(book, state, 1); // TODO: 3 selectable images for premium users
  if (buffers.length === 0) return; // Cover image generation failed

  const oldImageId = book.imageId;
  const uploadResult = await uploadBookCoverImage(book, buffers[0]); // Direct buffer upload
  
  if (uploadResult) {
    // TODO: make it all atomic with db transaction

    if (book.userId) {
      await persistUploadedImage({
        imageId: uploadResult.fileId!,
        imageUrl: uploadResult.url!,
        type: 'cover',
        userId: book.userId,
      });
    }

    // Update book with new image ID
    await updateBook(book.id, { imageId: uploadResult.fileId });
    
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
 * - shadowsWeaved: Total number of users who have joined the platform
 * 
 * Results are cached for 3 minutes to reduce database load.
 * 
 * @returns Promise resolving to object containing the four stats
 * 
 * @example
 * ```typescript
 * const stats = await getPublicBookStats();
 * console.log(`Stories: ${stats.storiesCreated}`);
 * console.log(`Branches: ${stats.branchesExplored}`);
 * console.log(`Pages: ${stats.pagesCrafted}`);
 * console.log(`Shadows: ${stats.shadowsWeaved}`);
 * ```
 */
export async function getPublicBookStats(): Promise<PublicStats> {
  const cacheKey = 'public:book:stats';
  
  // Try to get from cache first
  const cached = publicBookStatsCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Execute all four queries in parallel for faster response time
    // These queries are independent and can run concurrently
    const [booksCount, branchesCount, pagesCount, usersCount] = await Promise.all([
      // Get total number of books (stories created) using SQL COUNT(*)
      // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
      // This transfers only a single number instead of all matching rows, reducing memory and network overhead.
      dbRead.select({ count: sql<number>`count(*)::int` }).from(books),

      // Get total number of unique branches using SUM of pre-calculated branchesCount
      // Using SUM of denormalized column is much faster than COUNT(DISTINCT branch_id) on pages table
      dbRead.select({ count: sql<number>`COALESCE(SUM(branches_count), 0)::int` }).from(books),

      // Get total number of pages using SQL COUNT(*)
      // Using SQL COUNT(*) is more efficient than selecting all rows and counting in JavaScript.
      dbRead.select({ count: sql<number>`count(*)::int` }).from(pages),

      // Get total number of users using SQL COUNT(*)
      dbRead.select({ count: sql<number>`count(*)::int` }).from(users),
    ]);

    const stats: PublicStats = {
      storiesCreated: booksCount[0].count,
      branchesExplored: branchesCount[0].count,
      pagesCrafted: pagesCount[0].count,
      shadowsWeaved: usersCount[0].count,
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
    const [targetBook] = await dbRead
      .select({ keywords: books.keywords })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!targetBook) return [];

    const targetKeywords = targetBook.keywords;

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
        // TODO: imageUrl subquery (is it optimal?)
        imageUrl: sql<string | null>`(
          SELECT ui.image_url
          FROM uploaded_images ui
          WHERE ui.image_id = books.image_id
          LIMIT 1
        )`,
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

    return similarBooks as Array<DBBook & { imageUrl?: string | null; similarityScore: number; }>;
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
 * - Expands native PostgreSQL text[] arrays and groups by keyword
 * - Returns most popular tags sorted by frequency
 * - Filters out empty arrays and null values
 * 
 * Performance:
 * - Uses PostgreSQL's unnest() for efficient array expansion
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
  const cacheKey = `popular:tags:${limit}`;

  const cached = popularTagsCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Use database-level aggregation for efficient keyword counting
    const result = await dbRead.execute(sql`
      SELECT keyword, COUNT(*) AS count
      FROM (
        SELECT unnest(${books.keywords}) AS keyword
        FROM ${books}
        WHERE cardinality(${books.keywords}) > 0
      ) expanded
      WHERE keyword IS NOT NULL
        AND keyword != ''
      GROUP BY keyword
      ORDER BY count DESC
      LIMIT ${limit}
    `);

    // Extract tag names from result
    const tags = result.rows.map(row => row.keyword as string);

    popularTagsCache.set(cacheKey, tags);

    return tags;
  } catch (error) {
    console.error('[getPopularTags] Failed to fetch popular tags:', getErrorMessage(error));
    return [];
  }
}

/**
 * Inserts a record into userCompletedBooks table when a user completes a book.
 * Records that a user has discovered a book ending.
 *
 * This table is append-only:
 * - One row represents one unique ending discovered by one user.
 * - Reaching the same ending again is ignored.
 * - Discovering a different ending inserts a new row.
 *
 * This historical data powers:
 * - "You've discovered X endings"
 * - Ending rarity statistics
 * - Replay achievements
 * 
 * @param userId - User ID who completed the book
 * @param bookId - Book ID that was completed
 * @param pageId - Page ID that the user completed (last page)
 * @param branchId - Branch ID that the user completed
 * @param client - Optional database client (defaults to dbWrite)
 * @returns Promise resolving to the inserted record or null if already exists
 * 
 * @example
 * ```typescript
 * const completion = await insertUserCompletedBook('user123', 'book456', 'page789', 'branch789');
 * console.log('Book completed at:', completion?.completedAt);
 * ```
 */
export async function insertUserCompletedBook(
  userId: string,
  bookId: string,
  pageId: string,
  branchId: string,
  client: DBClient = dbWrite
): Promise<{ id: string; completedAt: Date } | null> {
  try {
    const [result] = await client
      .insert(userCompletedBooks)
      .values({
        userId,
        bookId,
        pageId,
        branchId,
        completedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [userCompletedBooks.userId, userCompletedBooks.bookId, userCompletedBooks.pageId],
      })
      .returning({
        id: userCompletedBooks.id,
        completedAt: userCompletedBooks.completedAt,
      });

    return result ?? null;
  } catch (error) {
    console.error('[insertUserCompletedBook] ❌ Failed to insert completion record:', getErrorMessage(error));
    return null;
  }
}

/**
 * Attempts to atomically acquire the generation lock for a book.
 *
 * Uses `isGeneratingStartedAt` as a mutex to prevent duplicate GitHub
 * workflow runs for the same book:
 * - `NULL`: lock is free → can acquire
 * - Set and <1 minute old: lock held by another process → skip
 * - Set and >=1 minute old: stale lock (e.g. crashed runner) → can acquire
 *
 * The conditional UPDATE is atomic — no TOCTOU race between checking and
 * setting the lock.
 *
 * @param bookId - UUID v7 of the target book
 * @returns `true` if the lock was acquired, `false` if held by another process
 *
 * @example
 * ```typescript
 * const acquired = await acquireBookGenerationLock(bookId);
 * if (!acquired) {
 *   console.log(`Book ${bookId} is already being processed, skipping`);
 *   return;
 * }
 * ```
 */
export async function acquireBookGenerationLock(bookId: string): Promise<boolean> {
  const ONE_MINUTE_AGO = new Date(Date.now() - 60000);
  const [locked] = await dbWrite
    .update(bookGenerations)
    .set({ isGeneratingStartedAt: new Date() })
    .where(
      and(
        eq(bookGenerations.bookId, bookId),
        or(
          isNull(bookGenerations.isGeneratingStartedAt),
          lt(bookGenerations.isGeneratingStartedAt, ONE_MINUTE_AGO)
        )
      )
    )
    .returning({ id: bookGenerations.bookId });

  return !!locked;
}

/**
 * Result of a workflow dispatch gate check.
 */
export interface WorkflowDispatchGateResult {
  /** `true` if the caller should proceed with dispatching the workflow */
  shouldDispatch: boolean;
  /** Human-readable reason for denial (only set when `shouldDispatch` is `false`) */
  reason?: string;
}

/**
 * Read-only gate that decides whether a GitHub workflow should be dispatched
 * for a given book.
 *
 * This is **not** a mutex — it only inspects the current state. The actual
 * processing lock (`isGeneratingStartedAt`) is acquired by the GitHub runner
 * (`processBookGeneration` in the cron job) to prevent concurrent processing.
 * The dispatcher's job is simply to avoid dispatching when it's clearly futile.
 *
 * **Rejection cases:**
 * - Terminal states (`completed`, `failed`, `cancelled`): no point dispatching.
 * - Alive runner (`in_progress` + `isGeneratingStartedAt` set and within
 *   `MAX_GENERATION_DURATION_MS`): a runner is actively processing, dispatching
 *   again would be wasteful (the runner's own lock prevents double-processing).
 *
 * @param bookId - UUID v7 of the target book
 * @returns A `WorkflowDispatchGateResult` indicating whether to dispatch
 *
 * @example
 * ```typescript
 * const gate = await tryAcquireWorkflowDispatchGate(bookId);
 * if (!gate.shouldDispatch) {
 *   console.log(`[dispatch] ⏸️ ${gate.reason}`);
 *   return;
 * }
 * triggerBookGenerationWorkflow(bookId, 'my-context');
 * ```
 */
export async function tryAcquireWorkflowDispatchGate(bookId: string): Promise<WorkflowDispatchGateResult> {
  const [row] = await dbRead
    .select({
      generationStatus:      bookGenerations.generationStatus,
      isGeneratingStartedAt: bookGenerations.isGeneratingStartedAt,
    })
    .from(bookGenerations)
    .where(eq(bookGenerations.bookId, bookId))
    .limit(1);

  if (!row) {
    return { shouldDispatch: false, reason: `Book generation record not found for ${bookId}` };
  }

  const { generationStatus, isGeneratingStartedAt } = row;

  // Terminal states — no point dispatching
  if (generationStatus === 'completed' || generationStatus === 'failed' || generationStatus === 'cancelled') {
    return { shouldDispatch: false, reason: `Book ${bookId} is already ${generationStatus}` };
  }

  // Runner appears alive — isGeneratingStartedAt is set and recent
  if (generationStatus === 'in_progress' && isGeneratingStartedAt) {
    const elapsed = Date.now() - new Date(isGeneratingStartedAt).getTime();
    if (elapsed < MAX_GENERATION_DURATION_MS) {
      return { shouldDispatch: false, reason: `Book ${bookId} is still in progress (lock held, ${Math.round(elapsed / 1000)}s elapsed)` };
    }
  }

  return { shouldDispatch: true };
}

/**
 * Creates a PostgreSQL text[] literal from a JS string array.
 *
 * Required because PostgreSQL array operators (&&, @>, <@)
 * expect actual arrays, not record tuples.
 */
export function keywordsToTextArray(keywords: string[]) {
  return sql`ARRAY[${sql.join(keywords.map(v => sql`${v}`), sql`, `)}]::text[]`;
}