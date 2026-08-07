import type { CharacterMemoryTranslation, CharacterPlan, InjuryTranslation, InventoryItemTranslation, NewCharacter, RelationshipUpdate, StoryMC, StoryMCTranslation } from "./character.js";
import type { NewPlace, PlaceMemoryTranslation } from "./places.js";
import type { ActionTranslation, PersistedStoryPage, StoryPage, StoryState, InitialStoryState, InitialFact, SelectedAction, InitialStoryPageGeneration, StoryPlan, Ending, InitialEnding, FutureNoteGeneration } from "./story.js";
import type { DBBook, DBPage, DBUserSession } from "./schema.js";
import type { User } from "./user.js";
import type { DBTransaction } from "../db/client.js";
import type { AIResponse } from "./ai-chat.js";
import type { NewThread, StoryThreadTranslation } from "./story-thread.js";
import type { AdvancedOptionsConfig } from "./book-creation.js";

export const bookStatuses = ['active', 'archived', 'draft'] as const;
export type BookStatus = typeof bookStatuses[number];

/**
 * Book visibility levels controlling discoverability and access
 * 
 * - `private`: Only the book owner can view it via their library
 * - `unlisted`: Only those with the direct shareable link can view it
 * - `followers`: Owner and their followers can view it in their feeds
 * - `public`: Anyone can discover and read it (explorable)
 */
export const bookVisibilities = ['private', 'unlisted', 'followers', 'public'] as const;
export type BookVisibility = typeof bookVisibilities[number];

/**
 * Book creation modes (story format / storytelling philosophy).
 *
 * - `novel`:      A traditional linear story with a single path and ending.
 * - `interactive`: Readers make choices that lead to different branches and endings.
 * - `multiverse`: Every choice creates unseen parallel timelines that continue to
 *                  evolve, making the world feel alive beyond the reader's path.
 *
 * Each mode carries a different AI generation cost (see BOOK_MODE_CREDIT_COSTS).
 */
export const bookModes = ['novel', 'interactive', 'multiverse'] as const;
export type BookMode = typeof bookModes[number];

export const bookGenerationStatuses = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

export type BookGenerationStatus = typeof bookGenerationStatuses[number];

/**
 * Story generation step types
 * 
 * These steps map to backend SSE events:
 * - theme_validation: Backend theme validation process
 * - book_initialization: Backend book initialization
 * - ai_generation: Backend AI content generation
 * - ai_evaluation: Backend AI content evaluation
 * - finalizing: Backend database operations and finalization
 * - complete: Process complete
 */
export const storyGenerationSteps = {
  theme_validation:    'Validating your theme',
  book_initialization: 'Setting up the story world',
  ai_generation:       'AI is crafting your story',
  ai_evaluation:       'Reviewing story quality',
  finalizing:          'Finalising and saving your book',
  complete:            'Book generation complete',
};

export type StoryGenerationStep = keyof typeof storyGenerationSteps;

export type BookGenerationPayload = {
  bookId: string;
  step?: StoryGenerationStep;
  status?: BookGenerationStatus;
  error?: string;
  aiFinalComment?: string;
};
export type BookGenerationProgress = Omit<BookGenerationPayload, 'bookId'>;

/**
 * Book creation status for polling endpoint
 */
export interface BookCreationStatus {
  bookId: string;
  status: BookStatus; // Publication state (active, archived, draft)
  generationStatus: BookGenerationStatus; // Generation tracking (pending, in_progress, completed, failed)
  generationStep: StoryGenerationStep;
  generationStepDescription?: string;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
  aiComment: string | null;
  aiFinalComment: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Date when credits were refunded (null if not yet refunded).
   *  Populated after auto-refund on failure or manual cancel. */
  isRefunded: Date | null;
  /**
   * Full enriched book payload, populated only on terminal `completed` poll.
   *
   * Eliminates the extra `GET /api/books/:bookId` round-trip after generation
   * finishes — the frontend can immediately render the book with `firstPage`,
   * `title`, `summary`, `hook`, `totalPages`, `mc`, etc. without a follow-up
   * request.
   */
  book?: EnrichedBookData | null;
}

/**
 * Book statistics for display
 */
export interface BookStats {
  likesCount: number;
  readCount: number;
  completeCount: number;
  commentsCount: number;
  /** Total testimonials (maintained by database triggers) */
  testimonialsCount: number;
  /** Average rating (1-5 scale, 1 decimal) of approved testimonials (maintained by database trigger). Null = no approved rated testimonials yet */
  rating: number | null;
  /** Number of approved testimonials carrying a rating (maintained by database trigger) */
  ratingCount: number | null;
  /** Completion rate: completed/started percentage (maintained by database triggers) */
  completionRate: number | null;
  /** Total unique branches (maintained by database triggers) */
  branchesCount: number;
}

export type BookAuthor = { id: string } & Pick<User, 'email' | 'username' | 'name' | 'imageUrl'>;

/**
 * Complete book data as stored in database
 * 
 * This type represents the full book structure including all metadata
 * and story content as persisted in the database.
 */
export type Book = {
  /** Unique identifier for the book */
  id: string;
  /** User ID who owns this book (null if user was deleted) */
  userId: string | null;
  /** SEO-friendly URL identifier (null if not implemented) */
  slug?: string;
  /** Book title (catchy, mysterious) */
  title: string;
  /** Total number of pages in the book */
  totalPages: number;
  /** Book language */
  language: string;
  /** Hook text (1-2 sentences, intriguing) */
  hook: string;
  /** Summary (50-100 words, sets up psychological tension) */
  summary: string;
  /** Cover image ImageKit URL */
  imageUrl?: string;
  /** ImageKit file ID for deletion */
  imageId?: string;
  /** Trending score for book discovery */
  trendingScore: number;
  /** Keywords for book discovery (e.g. ['cardiff mosque', 'peel street mosque']) */
  keywords: string[];
  /** Book status ('active' | 'archived' | 'draft') */
  status: BookStatus;
  /** Book visibility ('private' | 'followers' | 'public') */
  visibility: BookVisibility;
  /** Main character profile with name, age, gender */
  mc: StoryMC;
  /** Book statistics */
  stats?: BookStats;
  /** When the book was marked as top pick */
  topPick?: Date;
  /** Whether this book is an auto-generated original (via cron job) */
  isOriginal: boolean;
  /** Whether this book was authored in the Pen (human co-writing, POST /books/pen) */
  isPenBook: boolean;
  /** Author-completion state for Pen books ('draft' = still authoring, 'complete' = done). Always 'draft' for non-Pen books. */
  authoringStatus: 'draft' | 'complete';
  /** Book creation mode (story format): 'novel' | 'interactive' | 'multiverse' */
  mode: BookMode;
  /** Credits to pay to continue reading */
  creditsPrice: number;
  /** Original theme input from user (undefined if hidden by author) */
  originalThemeInput?: string;
  /** Calendar date of the first page (auto-filled via insertStoryPage) */
  storyStartDate?: string;
  /** Monotonic "state of the world" clock for Pen delta validation (Phase 0.d). */
  canonVersion: number;
  /** Advanced options config (writing preset, developer overrides) persisted for ongoing page generation */
  advancedOptions?: AdvancedOptionsConfig;
  /** Author-edited ending text/outline for the story (overrides derived ending) */
  ending?: Ending;
  /** When the book was created */
  createdAt: Date;
  /** When the book was last updated */
  updatedAt: Date;
};

/**
 * Enriched book data with author info and engagement metrics
 */
export type EnrichedBookData = Pick<DBBook,
  | 'id'
  | 'userId'
  | 'slug'
  | 'title'
  | 'hook'
  | 'summary'
  | 'keywords'
  | 'status'
  | 'visibility'
  | 'trendingScore'
  | 'totalPages'
  | 'language'
  | 'topPick'
  | 'isOriginal'
  | 'isPenBook'
  | 'authoringStatus'
  | 'mode'
  | 'creditsPrice'
  | 'originalThemeInput'
  | 'createdAt'
  | 'updatedAt'
  | 'mc'
> & {
  imageUrl: string | null;
  author: BookAuthor | null;
  stats: BookStats;
  isMine: boolean;
  isLiked: boolean;
  isSaved: boolean;
  isRead: boolean;
  isCompleted: boolean;
  isPurchased: boolean;
  firstPage: EnrichedBookFirstPage | null;
  session: EnrichedBookSession | null;
  translation: BookTranslation | null;
  generation: EnrichedBookGeneration | null;
  collection: string | null;
}

export type EnrichedBookFirstPage = { id: string; text: string };

/**
 * User reading session with branch-aware "active-tip" frontier tracking.
 *
 * **Frontier (branch-aware active tip):**
 * `frontierPageId` tracks the furthest page the reader has reached across
 * **any** branch. It is the page where the reader has not yet chosen an
 * action — because choosing an action navigates forward to the next page,
 * which then becomes the new frontier.
 *
 * **Back-navigation rule (preserved on revisit):**
 * When the reader revisits an ancestor page (detected via
 * `frontierAncestorIds`), the frontier stays put. It advances only on
 * forward progress or cross-branch navigation — moving to a page whose
 * id is NOT in the current frontier's ancestry.
 *
 * **Invariant:** `frontierPageId` always points to the page where the
 * reader last landed after choosing an action, which is the page where
 * they have not yet made their next choice.
 *
 * @example
 * ```typescript
 * // Reader goes p1 → p2 → p3 (ancestors: [p1, p2, p3])
 * // frontier = p3, frontierAncestorIds = [p1_id, p2_id, p3_id]
 *
 * // Goes back to p2, chooses a different action → p4
 * // p4 NOT in [p1, p2, p3] → forward progress → frontier advances to p4
 * // frontier = p4, frontierAncestorIds = [p1_id, p2_id, p4_id]
 *
 * // Revisits p3 — p3 NOT in [p1, p2, p4] → cross-branch → frontier moves to p3
 * // frontier = p3
 * ```
 */
export type EnrichedBookSession = {
  /** Timestamp of the reader's last activity in this book */
  lastReadAt: Date;
  /** The reader's current page id (updates on every navigation) */
  lastPageId: string;
  /** The reader's current page number (display hint only) */
  lastPageNumber: number;
  /**
   * Active-tip frontier: the furthest page the reader has reached on
   * any branch. Preserved on back-navigation. Always points to the
   * page where an action has not yet been selected.
   */
  frontierPageId: string | null;
  /**
   * Display hint for the frontier page number (NOT used for gating).
   * Mirrors the page number of `frontierPageId`.
   */
  frontierPageNumber: number;
  /**
   * Ancestor chain of the frontier page: the frontier's own page id
   * plus every page id in its `actionsHistory`. Used by the back-
   * navigation test: if a visited page id is found in this list, the
   * frontier is kept; otherwise it advances.
   */
  frontierAncestorIds: string[];
  /** AI-summarized story context from page 1 to frontier page */
  contextHistory: string;
};
export type EnrichedBookGeneration = {
  generationStatus?: BookGenerationStatus;
  generationStep?: StoryGenerationStep;
  generationDurationMs?: number | null;
};

/**
 * AI response structure for book creation
 * 
 * This type defines the complete response structure from AI when creating
 * a new psychological thriller book, including all metadata and initial content.
 */
export type BookCreationResponse = {
  /** Book title (catchy, mysterious) */
  title: string;
  /** Optional alternative titles (e.g., english version) */
  alternativeTitles: string[];
  /** Total number of pages in the book */
  totalPages: number;
  /** Detected language code (ISO 639-1) (e.g., 'en') */
  language: string;
  /** Hook text (1-2 sentences, intriguing) */
  hook: string;
  /** Summary (50-100 words, sets up psychological tension) */
  summary: string;
  /** Keywords (3-5 relevant tags) */
  keywords: string[];
  /** Main character's complete info (Who is the story about?) */
  mainCharacter: StoryMC;
  /** First story page content */
  firstPage: InitialStoryPageGeneration;
  /** Initial state for the story */
  initialState: InitialStoryState;
  /** Initial place memory setup */
  initialPlace: NewPlace;
  /** Initial character memories setup (excluding MC, who matters?) */
  initialCharacters: NewCharacter[];
  /** Unintroduced characters inferred from theme */
  plannedCharacters: CharacterPlan[];
  /** Initial character relationships setup (excluding MC) */
  initialRelationships: RelationshipUpdate[];
  /** Initial facts discovered in first page */
  initialFacts: InitialFact[];
  /** What questions keep readers reading? / What unanswered questions should keep the reader engaged? */
  initialThreads: NewThread[];
  /** Where is everything heading? / What inevitable destination is this story moving toward? */
  viableEnding: InitialEnding;
  /** What promises must the story fulfill? / What important events or obligations happen later? */
  futureNotes: FutureNoteGeneration[];
  /** Creative thriller-themed congratulatory message about the generation */
  aiFinalComment?: string;
};

/**
 * Parameters for initializeBook function
 * 
 * Defines the input parameters required to initialize a new book
 * with AI-generated content and setup.
 */
/**
 * Minimal request context passed for activity-log metadata.
 * Mirrors the small subset of a Hono `Context` that book creation needs
 * (client IP and a header getter), keeping services framework-agnostic.
 */
export interface ActivityRequestContext {
  /** Client IP address (e.g. from {@link getClientIp}) */
  ip?: string;
  /** Reads a request header by name (e.g. `c.req.header(name)`) */
  get?(header: string): string | null | undefined;
}

export type InitializeBookParams = StoryPlan & {
  /** User ID who owns the book */
  userId: string;
  /** Book theme or topic for AI generation */
  theme: string;
  /** Whether to generate a cover image for the book */
  generateCoverImage?: boolean;
  /** Whether this book is an auto-generated original (via cron job) */
  isOriginal?: boolean;
  /** Complimentary comment from AI */
  aiComment?: string | null;
  /** Hono request context for activity-log metadata (IP, accept-language) */
  req?: ActivityRequestContext;
  /** Optional: Update existing book by ID instead of inserting new (for async book creation) */
  bookId?: string;
  /** Optional: Database client / transaction to run all DB operations within (for atomicity) */
  tx?: DBTransaction;
  /** Optional: Advanced options for writing preset, creativity, AI config overrides */
  advancedOptions?: AdvancedOptionsConfig;
  /** Book creation mode (story format). Defaults to 'interactive' when omitted. */
  mode?: BookMode;
};

export type CreateBookParams = Omit<InitializeBookParams, 'aiComment' | 'language' | 'bookId' | 'tx'> & { context?: string; mode?: BookMode }

/**
 * Return type for initializeBook function
 * 
 * Defines the complete result structure returned after successfully
 * initializing a new book with all its components.
 */
export type CreateBookResponse = {
  /** Complete book metadata and structure */
  book: Book;
  /** First generated story page */
  firstPage: StoryPage;
  /** Initial story state configuration */
  initialState: StoryState;
  /** Complimentary comment from AI */
  aiComment?: string | null;
  /** Creative thriller-themed congratulatory message about the generation */
  aiFinalComment?: string;
};

/**
 * Available book sorting options
 * 
 * These define the primary sorting behavior for book lists
 */
export const bookSortOptions = [
  'for-you', // You might like
  'popular',
  'newest', 
  'trending',
  'top-picks',
  'originals',
  'reads', // Continue reading
  'recommendations', // You might like
  'creations', // User's created books
  'pen-drafts', // User's own in-progress Pen books (is_pen_book + authoring_status='draft')
  'favorites', // User's saved books
  'likes', // Books the user liked (user_likes)
] as const;

export type BookSortOption = typeof bookSortOptions[number];

/**
 * Available lastUpdated filter values
 * 
 * These define time-based filtering options for book lists
 */
export const lastUpdatedFilterOptions = [
  'anytime',
  'today',
  'this-week',
  'this-month',
  'this-year'
] as const;

export type LastUpdatedFilter = typeof lastUpdatedFilterOptions[number];

export type BookPageVisit = {
  session?: DBUserSession | null;
  nthVisit: number;
  visitorPercentage: number;
  readerUserId?: string;
  endingStats?: BookEndingStats;
}

export type VisitBookPageParams = {
  userId?: string,
  pageId: string,
  bookIdentifier?: string,
  skipVisit?: boolean,
  takeAction?: boolean,
  consumeCredits?: boolean,
  language?: string | null,
};

export type VisitBookPageResult = {
  visitDetails?: BookPageVisit,
  book?: EnrichedBookData,
  dbPage?: DBPage,
} & TakeActionValidity;

export type EnrichedPageOptions = {
  userId?: string,
  book?: Pick<Book, 'language' | 'title' | 'status'>,
  headerLanguage?: string | null,
  translate?: boolean
} & TakeActionValidity;

export type TakeActionValidity = {
  sourceAction?: SelectedAction, // should be defined for page number > 1
  isUserTakeAction?: boolean;
};

/**
 * Result of slug generation with the chosen title
 */
export type BookSlugGenerationResult = {
  /** The generated unique slug */
  slug: string;
  /** The title that was used to generate the slug (may be alternative) */
  title: string;
};

/**
 * Book translation structure for AI generation
 */
export type BookTranslation = {
  title?: string | null;
  hook?: string | null;
  summary?: string | null;
  keywords: string[];
  mc: StoryMCTranslation;
}

export type BookToTranslate = Pick<Book, 'id' | 'title' | 'hook' | 'summary' | 'keywords' | 'language'>;
export type BookTranslationWithID = BookTranslation & { bookId: string };
export type BookTranslationBulk = { translations: BookTranslationWithID[] };
export type BookTranslationBulkResponse = BookTranslationBulk & Pick<AIResponse<BookTranslationBulk>, 'provider' | 'model'>;

/**
 * Page translation structure for AI generation
 */
export type PageTranslation = {
  // page translations
  text: string;
  timeOfDay?: string | null;
  mood?: string | null;
  weather?: string | null;
  keyEvents: string[];
  keyObjects: string[];
  actions: ActionTranslation[];
  // state translations
  actionsHistory: ActionTranslation[];
  contextHistory?: string | null;
  characters?: CharacterMemoryTranslation[];
  places?: PlaceMemoryTranslation[];
  inventory?: InventoryItemTranslation[];
  injuries?: InjuryTranslation[];
  threads?: StoryThreadTranslation[];
};

export type PageToTranslate = PersistedStoryPage & { state: StoryState } & { book: Book };
export type PageTranslationWithID = PageTranslation & { pageId: string };
export type PageTranslationBulk = { translations: PageTranslationWithID[] };
export type PageTranslationBulkResponse = PageTranslationBulk & Pick<AIResponse<PageTranslationBulk>, 'provider' | 'model'>;

/**
 * Public statistics about the platform, with a creative thriller-themed twist
 */
export type PublicStats = {
  storiesCreated: number;
  branchesExplored: number;
  pagesCrafted: number;
  /** The number of shadows that have joined the platform, each with their own tale to spin */
  shadowsWeaved: number;
};

export type UploadedImageType =
  | 'cover' // Book cover
  | 'mc'    // Main character's picture
  | 'user'  // Profile picture
  | 'feedback'; // Feedback screenshot

export type PageVisitStats = {
  nthVisit: number;
  visitorPercentage: number;
  totalBookReaders: number;
};

export type BookEndingStats = {
  completedReaders: number;
  endingReaders: number;
  endingPercentage: number;
  /** How many distinct endings readers have found for this book so far. */
  distinctEndingsFound?: number;
  /** Minutes, approximate — wall-clock time between the reader's first and last recorded action on this book. */
  readingTimeMinutes?: number;
};