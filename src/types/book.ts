import type { CharacterMemory, StoryMC, StoryMCCandidate } from "./character.js";
import type { PlaceMood, PlaceType } from "./places.js";
import type { StoryPage, StoryState, StoryStateInitialGeneration } from "./story.js";
import type { DBBookTranslations, DBUserSession } from "./schema.js";
import type { User } from "./user.js";
import type { Request } from "express";
import type { DBTransaction } from "../db/client.js";

export type BookStatus = 'active' | 'archived' | 'draft';
export type BookGenerationStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type StoryGenerationStep = 'theme_validation' | 'book_initialization' | 'ai_generation' | 'ai_evaluation' | 'finalizing' | 'complete';

export type BookGenerationPayload = {
  bookId: string;
  step?: StoryGenerationStep;
  status?: BookGenerationStatus;
  error?: string;
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
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
  generationStartedAt?: Date | null;
  generationCompletedAt?: Date | null;
}

/**
 * Book statistics for display
 */
export interface BookStats {
  likesCount: number;
  readCount: number;
  completeCount: number;
  commentsCount: number;
  branchesCount: number;
}

/**
 * Complete book data as stored in database
 * 
 * This type represents the full book structure including all metadata
 * and story content as persisted in the database.
 */
export type Book = {
  /** Unique identifier for the book */
  id: string;
  /** User ID who owns this book */
  userId: string;
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
  image?: string;
  /** ImageKit file ID for deletion */
  imageId?: string;
  /** Trending score for book discovery */
  trendingScore: number;
  /** Keywords for book discovery (e.g. ['cardiff mosque', 'peel street mosque']) */
  keywords: string[];
  /** Book status ('active' | 'archived' | 'draft') */
  status: BookStatus;
  /** Main character profile with name, age, gender */
  mc: StoryMC;
  /** Book statistics */
  stats?: BookStats;
  /** When the book was marked as top pick */
  topPick?: Date;
  /** Whether this book is an auto-generated original (via cron job) */
  isOriginal: boolean;
  /** Total unique branches (maintained by database triggers) */
  branchesCount: number;
  /** When the book was created */
  createdAt: Date;
  /** When the book was last updated */
  updatedAt: Date;
};

/**
 * Enriched book data with author info and engagement metrics
 */
export interface EnrichedBookData {
  id: string;
  userId: string;
  slug: string | null;
  title: string;
  hook: string | null;
  summary: string | null;
  image: string | null;
  keywords: string[] | null;
  status: string | null;
  trendingScore: number | null;
  totalPages: number | null;
  language: string | null;
  topPick: Date | null;
  isOriginal: boolean;
  createdAt: Date;
  updatedAt: Date;
  mc: Record<string, unknown>;
  author: User | null;
  stats: BookStats;
  isLiked: boolean;
  isRead: boolean;
  lastReadAt?: Date | null;
  lastPage?: string | null;
  firstPageId: string;
  firstPageText: string;
  translation: DBBookTranslations | null
}

/**
 * AI response structure for book creation
 * 
 * This type defines the complete response structure from AI when creating
 * a new psychological thriller book, including all metadata and initial content.
 */
export type BookCreationResponse = {
  /** Book title (catchy, mysterious) */
  title: string;
  alternativeTitles: string[];
  /** Total number of pages in the book */
  totalPages: number;
  /** Language code (e.g. 'en') */
  language: string;
  /** Hook text (1-2 sentences, intriguing) */
  hook: string;
  /** Summary (50-100 words, sets up psychological tension) */
  summary: string;
  /** Keywords (3-5 relevant tags) */
  keywords: string[];
  /** Main character's complete info */
  mainCharacter: StoryMC;
  /** First story page content */
  firstPage: StoryPage;
  /** Initial state for the story */
  initialState: StoryStateInitialGeneration;
  /** Initial place memory setup */
  initialPlace: {
    name: string;
    type: PlaceType;
    currentMood: PlaceMood;
    context?: string;
    familiarity: number; // 0-1, important for reuse priority
  };
  /** Initial character memories setup (excluding MC) */
  initialCharacters: Array<Pick<CharacterMemory, 'name' | 'role' | 'gender' | 'status' | 'relationshipToMC' | 'bio' | 'visualDescription'>>;
};

/**
 * Parameters for initializeBook function
 * 
 * Defines the input parameters required to initialize a new book
 * with AI-generated content and setup.
 */
export type InitializeBookParams = {
  /** User ID who owns the book */
  userId: string;
  /** Book theme or topic for AI generation */
  theme: string;
  /** Optional main character candidate for personalization */
  mcCandidate?: StoryMCCandidate;
  /** Whether to generate a cover image for the book */
  generateCoverImage?: boolean;
  /** Whether this book is an auto-generated original (via cron job) */
  isOriginal?: boolean;
  /** Express request object for activity log */
  req?: Request;
  /** Optional: Update existing book by ID instead of inserting new (for async book creation) */
  bookId?: string;
  /** Optional: Database client / transaction to run all DB operations within (for atomicity) */
  tx?: DBTransaction;
};

/**
 * Return type for initializeBook function
 * 
 * Defines the complete result structure returned after successfully
 * initializing a new book with all its components.
 */
export type InitializeBookResult = {
  /** Complete book metadata and structure */
  book: Book;
  /** First generated story page */
  firstPage: StoryPage;
  /** Initial story state configuration */
  initialState: StoryState;
};

/**
 * Available book sorting options
 * 
 * These define the primary sorting behavior for book lists
 */
export const bookSortOptions = [
  'popular',
  'newest', 
  'trending',
  'top-picks',
  'originals'
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
}

/**
 * Result of slug generation with the chosen title
 */
export type BookSlugGenerationResult = {
  /** The generated unique slug */
  slug: string;
  /** The title that was used to generate the slug (may be alternative) */
  title: string;
};