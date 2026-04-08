import type { CharacterStatus, StoryMC } from "./character.js";
import type { PlaceMood, PlaceType } from "./places.js";
import type { StoryPage, StoryState } from "./story.js";
import type { Gender } from "./user.js";

export type BookStatus = 'active' | 'archived' | 'draft';

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
  
  /** When the book was created */
  createdAt: Date;
  
  /** When the book was last updated */
  updatedAt: Date;
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
  /** Total number of pages in the book */
  totalPages: number;
  language: string;
  /** Hook text (1-2 sentences, intriguing) */
  hook: string;
  /** Summary (50-100 words, sets up psychological tension) */
  summary: string;
  /** Keywords (3-5 relevant tags) */
  keywords: string[];
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
  /** Initial character memories setup */
  initialCharacters: Array<{
    name: string;
    gender: Gender;
    status: CharacterStatus;
    relationshipToMC?: string;
    bio?: string;
  }>;
};