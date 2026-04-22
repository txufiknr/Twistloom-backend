import type { CharacterMemory, StoryMC, StoryMCCandidate } from "./character.js";
import type { PlaceMood, PlaceType } from "./places.js";
import type { EnrichedAction, StoryPage, StoryState } from "./story.js";
import type { DBUserSession } from "./schema.js";
import type { User } from "./user.js";

export type BookStatus = 'active' | 'archived' | 'draft';

/**
 * Book statistics for display
 */
export interface BookStats {
  likesCount: number;
  readCount: number;
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
  topPick?: Date;
  createdAt: Date;
  updatedAt: Date;
  mc: Record<string, unknown>;
  author: User | null;
  stats: BookStats;
  isLiked: boolean;
  isRead: boolean;
  lastReadAt?: Date | null;
  lastPage?: string | null;
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
  /** Initial ending for the story */
  initialState: Pick<StoryState, 'flags' | 'difficulty' | 'viableEnding'>;
  /** Initial place memory setup */
  initialPlace: {
    name: string;
    type: PlaceType;
    currentMood: PlaceMood;
    context?: string;
    familiarity: number; // 0-1, important for reuse priority
  };
  /** Initial character memories setup (excluding MC) */
  initialCharacters: Array<Pick<CharacterMemory, 'name' | 'role' | 'gender' | 'status' | 'relationshipToMC' | 'bio'>>;
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
  /** User session for the new book */
  session: DBUserSession | null;
};

export interface CreateBookResponse {
  book: Book;
  firstPage: Omit<StoryPage, 'actions'> & {actions: EnrichedAction[]};
  initialState: StoryState;
  session: DBUserSession | null;
}

/**
 * Book sorting options
 * 
 * Available options:
 * - popular: Sorts by branchesCount/totalPages ratio (most branched stories)
 * - newest: Sorts by createdAt timestamp (latest books)
 * - trending: Sorts by weighted formula: readCount(0.5) + likesCount(0.3) + favoritedCount(0.2)
 * - top-picks: Sorts by latest topPick timestamp (only books marked as editor's picks)
 */
export type BookSortOption = 'popular' | 'newest' | 'trending' | 'top-picks';