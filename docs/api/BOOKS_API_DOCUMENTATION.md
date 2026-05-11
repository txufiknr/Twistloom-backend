# Books API Documentation

## Overview

The Books API provides endpoints for managing psychological thriller books, including creation, reading, social interactions (likes, favorites, comments), and exploration. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Base URL:** `/api/books`

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies. Guest users can access read-only endpoints and create books (guest data migrates on login).

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ book: {...} }`, `{ books: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ book: {...} }`, `{ page: {...} }`)
- PUT endpoints: Return updated resources with 200 status (e.g., `{ book: {...} }`)
- DELETE endpoints: Return simple messages or operation metadata (e.g., `{ message: "..." }`)

---

## Type Definitions

### BookStats

Book engagement statistics.

```typescript
interface BookStats {
  likesCount: number;         // Total likes
  readCount: number;          // Unique users who have started reading the book (from userPageProgress)
  completeCount: number;      // Unique users who have completed the book (reached the last page)
  commentsCount: number;      // Total comments
  branchesCount: number;      // Total branches in this book (denormalized column)
}
```

### Book

Complete book data as stored in database.

```typescript
interface Book {
  id: string;                  // Book's unique identifier (UUID v7)
  userId: string;              // Author's user ID
  slug?: string;               // SEO-friendly URL identifier (auto-generated from title)
  title: string;               // Book title
  totalPages: number;         // Total number of pages in the book
  language: string;           // Book language
  hook: string;               // Hook text (1-2 sentences, intriguing)
  summary: string;            // Summary (50-100 words, sets up psychological tension)
  image?: string;              // Cover image ImageKit URL
  imageId?: string;           // ImageKit file ID for deletion
  trendingScore: number;      // Trending score for book discovery (hybrid: cron-based + incremental updates)
  keywords: string[];         // Keywords for book discovery
  status: 'active' | 'archived' | 'draft';
  mc: StoryMC;                // Main character profile with name, age, gender
  stats?: BookStats;           // Book statistics
  topPick?: Date;             // When the book was marked as top pick
  isOriginal: boolean;         // Whether this book is an auto-generated original (via cron job)
  branchesCount: number;       // Total unique branches (maintained by database triggers)
  createdAt: Date;             // When the book was created
  updatedAt: Date;             // When the book was last updated
}
```

### EnrichedBookData

Enriched book data with author info and engagement metrics.

```typescript
interface EnrichedBookData {
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
  branchesCount?: number;
  firstPageId: string;
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
```

### StoryPage

Story page structure for AI-generated content.

```typescript
interface StoryPage {
  text: string;               // Main story page content (60-120 words, first-person POV)
  mood?: Mood;                // Current emotional atmosphere
  place?: string;             // Current place where the story is taking place
  timeOfDay?: string;         // Current time mark (e.g. 'night', 'HH:mm', 'unknown')
  charactersPresent?: string[]; // Characters present in the page
  keyEvents?: string[];       // Key events that occurred in the page
  importantObjects?: string[]; // Important objects mentioned in the page
  actions: Action[];          // Next branching actions for user choice (2-3 options)
  addTraumaTag?: string;      // New trauma tag based on page events
  characterUpdates?: CharacterUpdates; // Updates to characters (new and existing)
  relationshipUpdates?: RelationshipUpdate[]; // Updates to character relationships
  placeUpdates?: PlaceUpdates; // Updates to places (new and existing)
  threadUpdates?: ThreadUpdates; // Updates to story threads
  aiProvider?: AIChatProvider | 'none'; // AI provider used for generating the page content
  aiModel?: string;           // AI model used for generating the page content
}
```

### Action

User action choice for story progression.

```typescript
interface Action {
  text: string;               // Action text
  type: ActionType;          // Category of action for psychological impact
  hint: ActionHint;          // Consequence hint for the action (for AI guidance)
  destination: {
    branchId?: string;       // Destination branch ID for the action
    pageId?: string;         // Destination page ID for the action
  };
}
```

### EnrichedAction

Action with navigation metadata for frontend URL building.

```typescript
interface EnrichedAction extends Action {
  nextPageNumber?: number;   // Next page number this action leads to
  isUserChosen?: boolean;    // Whether this action was chosen by the current user
}
```

### ActionType

Available action types for user choices.

```typescript
type ActionType = 
  | 'explore'     // Investigate, examine, search, discover, observe, learn
  | 'escape'      // Run away, hide, avoid danger, withdraw, panic
  | 'social'      // Interact, communicate, help, console, cooperate, teach
  | 'risk'        // Take chances, make bold moves, challenge, resist
  | 'ignore'      // Avoid engagement, dismiss events, submit, surrender
  | 'attack'      // Aggressive actions, fight, confront, destroy
  | 'deceive'     // Lie, manipulate, hide truth, betray
  | 'protect'     // Defend others, shield from harm, sacrifice
  | 'create'      // Build something new, artistic expression, innovate
  | 'heal'        // Repair damage, restore health/trust
  | 'dialogue'    // Interact with other characters, self-talk, mutter
  | 'custom'      // Custom prompt from reader
  | 'other';      // Catch-all for uncategorized actions
```

### Mood

Available moods for story pages.

```typescript
type Mood = 
  | 'calm'         // Peaceful, relaxed atmosphere
  | 'uneasy'       // Uncomfortable, slightly disturbed
  | 'fear'         // Scared, frightened
  | 'eerie'        // Unsettling, strange atmosphere
  | 'tense'        // High tension, anticipation of danger
  | 'dread'        // Deep feeling of impending doom
  | 'panic'        // Overwhelming fear and urgency
  | 'confusion'    // Disorientation, unclear reality
  | 'suspicious'   // Distrust, feeling of being watched
  | 'hopeless'     // No escape, despair
  | 'relief'       // Temporary safety or resolution
  | 'sad'          // Grief, loss, melancholy
  | 'distorted'    // Warped perception, unreality
  | 'urgency'      // Time pressure, immediate need to act
  | 'shock'        // Sudden revelation or horror
  | 'other';       // Catch-all for unique emotional states
```

### Session

User reading session information.

```typescript
interface Session {
  id: string;                  // Session's unique identifier
  userId: string;              // User ID
  bookId: string;              // Book ID
  pageId: string;              // Current page ID
  previousPageId?: string;     // Previous page ID
  status: 'active' | 'completed';
  createdAt: Date;             // Creation timestamp
  updatedAt: Date;             // Last update timestamp
}
```

### PaginationMeta

Pagination metadata.

```typescript
interface PaginationMeta {
  page: number;                // Current page number
  limit: number;               // Items per page
  totalCount: number;         // Total number of items
  totalPages: number;          // Total number of pages
  hasNext: boolean;            // Whether next page exists
  hasPrevious: boolean;        // Whether previous page exists
}
```

### BookSortOption

Book sorting options for explore endpoint.

```typescript
type BookSortingOptions = 
  | 'popular'     // Sorts by branchesCount (pre-calculated branchesCount maintained by database triggers)
  | 'newest'       // Sorts by createdAt timestamp (latest books)
  | 'trending'     // Sorts by pre-calculated trendingScore (hybrid: cron-based with time decay + incremental updates on likes/favorites)
  | 'top-picks'    // Sorts by latest topPick timestamp (only books marked as editor's picks)
  | 'originals';   // Filters by isOriginal: true (auto-generated books via cron job), sorts by createdAt (newest first)
```

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Frontend Integration](#frontend-integration)
3. [Book Management](#book-management)
   - [Create Book](#post-apibooks)
   - [Create Book with SSE](#post-apibooksstream)
   - [Get User's Books](#get-apibooks)
   - [Get Book by ID](#get-apibooksidentifier)
   - [Get Similar Books](#get-apibooksidsimilar)
   - [Update Book](#put-apibooksid)
   - [Delete Book](#delete-apibooksid)
4. [Book Reading](#book-reading)
   - [Get Book by Identifier](#get-apibooksidentifier)
   - [Get Specific Page](#get-apibooksidentifierpageid)
   - [Mark Page Visited](#post-apibooksidentifierpageidvisit)
   - [Generate Candidates](#post-apibooksidentifierpageidcandidates)
   - [Start Reading Session](#post-apibooksidsessions)
5. [Social Interactions](#social-interactions)
   - [Like Book](#post-apibooksidlike)
   - [Unlike Book](#delete-apibooksidlike)
   - [Favorite Book](#post-apibooksidfavorite)
   - [Unfavorite Book](#delete-apibooksidfavorite)
6. [Comments](#comments)
   - [Get Book Comments](#get-apibooksidcomments)
   - [Create Comment](#post-apibooksidcomments)
   - [Delete Comment](#delete-apibookscommentsid)
7. [Exploration](#exploration)
   - [Explore Books](#get-apibooksexplore)
   - [Get Popular Tags](#get-apibookstagspopular)
   - [Get Book Stats](#get-apibooksstats)
8. [Utilities](#utilities)
   - [Generate Book Prompt](#get-apibooksprompt)
   - [Insert Book (Test)](#post-apibooksinsert)
9. [Error Handling](#error-handling)
10. [HTTP Headers](#http-headers)
11. [Caching Strategy](#caching-strategy)
12. [Rate Limiting](#rate-limiting)
13. [Authentication](#authentication)
14. [Changelog](#changelog)

---

## Book Management

### POST /api/books

Creates a new psychological thriller book with AI-generated content. Accepts a story theme and optional main character details. The AI generates the book's title, hook, summary, first page, and initial story state. Candidate pages for each action in the first page are pre-generated automatically in the background for immediate navigation.

**Authentication:** Required (via `requireAuth`) - Book creation now requires authentication and consumes credits

**Request Body:**
```json
{
  "theme": "haunted mansion mystery",
  "mcCandidate": {
    "name": "Sarah",
    "age": 28,
    "gender": "female",
    "bio": "Shy librarian with hidden past"
  },
  "generateCoverImage": false
}
```

**Credit Consumption:**
- Requires 5 credits to create a story (configurable via `CREDIT_COSTS.STORY_GENERATION`)
- Credits are deducted transactionally before book creation
- Returns 402 Payment Required if insufficient credits

**Parameters:**
- `theme` (string, required): Story theme description (max 1000 chars)
- `mcCandidate` (object, optional): Main character candidate
  - `name` (string, optional): Character's display name
  - `age` (number, optional): Character's age (13-25)
  - `gender` (string, optional): "male" or "female"
  - `bio` (string, optional): Character's bio
- `generateCoverImage` (boolean, optional): Whether to generate AI cover image (default: false)

**Response (201 Created):**
```json
{
  "book": {
    "id": "book123",
    "userId": "user456",
    "slug": "whispering-halls",
    "title": "The Whispering Halls",
    "totalPages": 120,
    "language": "en",
    "hook": "Sarah never believed in ghosts until she found the diary",
    "summary": "A psychological thriller about a librarian who discovers dark secrets",
    "keywords": ["mystery", "thriller", "haunted"],
    "image": "https://example.com/cover.jpg",
    "status": "active",
    "mc": {
      "name": "Sarah",
      "age": 28,
      "gender": "female",
      "bio": "Shy librarian with hidden past"
    },
    "author": {
      "id": "user456",
      "name": "John Doe",
      "username": "johndoe",
      "image": "https://example.com/avatar.jpg"
    },
    "stats": {
      "likesCount": 0,
      "readCount": 0,
      "commentsCount": 0,
      "branchesCount": 1
    },
    "isLiked": false,
    "isRead": false,
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  },
  "firstPage": {
    "id": "page456",
    "page": 1,
    "text": "The library was silent except for the rain...",
    "mood": "eerie",
    "place": "library",
    "timeOfDay": "night",
    "actions": [
      {
        "text": "Investigate the noise",
        "type": "explore",
        "hint": {
          "text": "Something waits in the shadows",
          "type": "dark_discovery"
        }
      }
    ],
    "createdAt": "2023-01-01T00:00:00.000Z"
  },
  "initialState": {
    "page": 1,
    "maxPage": 120,
    "flags": {
      "trust": "medium",
      "fear": "low",
      "guilt": "low",
      "curiosity": "high"
    },
    "threads": [],
    "traumaTags": [],
    "psychologicalProfile": {
      "archetype": "investigator"
    },
    "hiddenState": {},
    "memoryIntegrity": "stable",
    "difficulty": "medium"
  },
  "session": {
    "id": "session789",
    "userId": "user456",
    "bookId": "book123",
    "pageId": "page456",
    "status": "active",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid theme, missing required fields, theme validation failed
- `401 Unauthorized`: Authentication required
- `402 Payment Required`: Insufficient credits
- `500 Internal Server Error`: AI generation failed

**Theme Validation Errors:**
```json
{
  "error": {
    "type": "VALIDATION_ERROR",
    "code": "THEME_INVALID",
    "message": "Your story theme contains inappropriate content.",
    "details": {
      "category": "INAPPROPRIATE_CONTENT",
      "detectedWords": ["prophet muhammad"],
      "detectedPatterns": [],
      "aiExplanation": "depicting religious figures in fictional stories",
      "suggestion": "Please avoid using real religious figures in your story theme."
    }
  }
}
```

---

### POST /api/books/stream

Creates a new psychological thriller book with AI-generated content using Server-Sent Events (SSE). Provides real-time progress updates for each step in the book creation process.

**Authentication:** Required (via `requireAuth`) - Book creation now requires authentication and consumes credits

**Request Body:** Same as `POST /api/books`

**Credit Consumption:**
- Requires 5 credits to create a story (configurable via `CREDIT_COSTS.STORY_GENERATION`)
- Credits are deducted transactionally before book creation
- Returns 402 Payment Required if insufficient credits

**SSE Events:**
```
event: theme_validation_start
data: {}

event: theme_validation_complete
data: {"isValid":true,"category":"NONE"}

event: book_initialization_start
data: {}

event: ai_generation_start
data: {}

event: ai_generation_complete
data: {}

event: ai_evaluation_start
data: {}

event: ai_evaluation_complete
data: {}

event: finalizing_start
data: {}

event: complete
data: {"book":{...},"firstPage":{...},...}

event: error
data: {"error":"Theme validation failed"}
```

**Response:** SSE stream (text/event-stream)

**Error Responses:**
- `400 Bad Request`: Invalid theme, missing required fields, theme validation failed
- `401 Unauthorized`: Authentication required
- `402 Payment Required`: Insufficient credits
- `500 Internal Server Error`: AI generation failed

---

### GET /api/books

Retrieves all books for the authenticated user. Returns paginated list with metadata and reading progress. Supports enhanced search, language filtering, time-based filtering, and sorting.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `page` (number, optional): Page number for pagination (default: 1)
- `limit` (number, optional): Number of books per page (default: 10)
- `search` (string, optional): Search query for title, hook, summary, keywords
- `language` (string, optional): Filter by language code (e.g., "en", "es")
- `tags` (string, optional): Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
- `fuzzy` (boolean, optional): Enable fuzzy matching for typo tolerance (default: true)
- `sortBy` (string, optional): **Book-specific sort option** - popular|newest|trending|top-picks|originals (default: newest)
- `sortOrder` (string, optional): Sort direction for generic fallback sorting (asc|desc, default: desc)
- `lastUpdated` (string, optional): Filter by last update time: anytime|today|this-week|this-month|this-year (default: anytime)

**Enhanced Search Features:**
- Searches across title, hook, summary, and keywords (JSONB array)
- Language filter for internationalization
- Tags filter with OR logic for multiple tags
- Time-based filtering by last update date
- Fuzzy matching toggle for typo tolerance
- **Two-level sorting hierarchy:**
  * **Primary:** Book-specific sorting (popular, trending, top-picks, originals, newest)
  * **Secondary:** Relevance scoring for search results (title: 40%, hook: 25%, summary: 20%, keywords: 15%)
- Results sorted by relevance when search is enabled, otherwise by book-specific sort

**Response (200 OK):**
```json
{
  "books": [
    {
      "id": "book123",
      "title": "The Whispering Halls",
      "hook": "Sarah never believed in ghosts until she found the diary",
      "summary": "A psychological thriller about a librarian...",
      "image": "https://example.com/cover.jpg",
      "status": "active",
      "totalPages": 120,
      "language": "en",
      "keywords": ["thriller", "mystery", "haunted"],
      "mc": {
        "name": "Sarah",
        "age": 28,
        "gender": "female"
      },
      "firstPageId": "page456",
      "author": {
        "id": "user456",
        "name": "John Doe",
        "username": "johndoe",
        "image": "https://example.com/avatar.jpg"
      },
      "stats": {
        "likesCount": 42,
        "readCount": 156,
        "completeCount": 23,
        "commentsCount": 25,
        "branchesCount": 12
      },
      "isLiked": true,
      "isRead": true,
      "lastReadAt": "2023-01-15T10:30:00.000Z",
      "lastPage": "page789",
      "relevanceScore": 0.85,
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalCount": 42,
    "totalPages": 5,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid search query (too short, too long, or contains invalid characters)
- `400 Bad Request`: Invalid lastUpdated value (must be: anytime, today, this-week, this-month, or this-year)

**Examples:**
```
# Search for thriller books
GET /api/books?search=thriller

# Filter by English language
GET /api/books?language=en

# Filter by books updated this week
GET /api/books?lastUpdated=this-week

# Filter by tags
GET /api/books?tags=thriller,mystery

# Combined search with all filters
GET /api/books?search=mystery&language=en&lastUpdated=this-month&tags=thriller&fuzzy=true

# Disable fuzzy matching (exact matches only)
GET /api/books?search=thriller&fuzzy=false
```

---

### PUT /api/books/:id

Updates book information including title, hook, summary, keywords, and cover image. Supports partial updates - only provided fields will be modified. Handles multiple image upload sources: URL, base64, or multipart file.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "title": "Updated Title",
  "hook": "Updated hook text",
  "summary": "Updated summary",
  "keywords": ["mystery", "thriller"],
  "imageUrl": "https://example.com/new-cover.jpg"
}
```

**Or multipart/form-data:**
- `imageFile` (file, optional): Cover image file
- `title` (string, optional): Updated title
- `hook` (string, optional): Updated hook
- `summary` (string, optional): Updated summary
- `keywords` (string, optional): JSON array of keywords
- `imageUrl` (string, optional): Cover image URL

**Response (200 OK):**
```json
{
  "book": {
    "id": "book123",
    "title": "Updated Title",
    "hook": "Updated hook text",
    "summary": "Updated summary",
    "keywords": ["mystery", "thriller"],
    "image": "https://example.com/new-cover.jpg",
    "updatedAt": "2023-01-15T11:00:00.000Z"
  },
  "imageUploaded": true,
  "oldImageQueuedForDeletion": true,
  "uploadSource": "url"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid image upload
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

---

### DELETE /api/books/:id

Deletes a book and all its associated data (pages, sessions, story states). If the book has an imageId, queues it for deletion in the deletedImages table.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (200 OK):**
```json
{
  "message": "Book deleted successfully",
  "bookId": "book123",
  "imageQueuedForDeletion": true
}
```

**Error Responses:**
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

---

## Book Reading

### GET /api/books/:identifier/:pageId

Retrieves a specific page within a book. Accepts both slug and UUID v7 as identifier. Returns only actions with complete destinations (both branchId and pageId required). Automatically retries failed candidate generations for incomplete actions. Supports translation via Accept-Language header.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Request Headers:**
- `Accept-Language` (string, optional): Desired language code (e.g., "en", "es", "fr")

**Response (200 OK):**
```json
{
  "page": {
    "id": "page456",
    "page": 1,
    "bookId": "book123",
    "branchId": "main",
    "parentId": null,
    "text": "The library was silent except for the rain...",
    "mood": "eerie",
    "place": "library",
    "timeOfDay": "night",
    "charactersPresent": [],
    "keyEvents": [],
    "importantObjects": [],
    "actions": [
      {
        "text": "Investigate the noise",
        "type": "explore",
        "hint": {
          "text": "Something waits in the shadows",
          "type": "dark_discovery"
        },
        "destination": {
          "branchId": "main",
          "pageId": "page789"
        },
        "nextPageNumber": 2,
        "isUserChosen": false
      }
    ],
    "selectedAction": {
      "text": "Investigate the noise",
      "type": "explore",
      "hint": {
        "text": "Something waits in the shadows",
        "type": "dark_discovery"
      }
    },
    "originalActionsCount": 5,
    "translatedText": "La biblioteca estaba en silencio excepto por la lluvia...",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls",
    "slug": "whispering-halls",
    "totalPages": 120
  }
}
```

**Behavior:**
- Filters out actions without complete destinations (both branchId and pageId required)
- Enriches actions with nextPageNumber for frontend URL building
- Marks user's previously chosen action with isUserChosen: true
- Includes selectedAction field showing user's chosen action for this page
- Includes originalActionsCount showing total actions before filtering
- Translates page text if Accept-Language header differs from book language (cached for performance)
- Automatically retries failed candidate generations for incomplete actions (fire-and-forget)
- Excludes backend-specific fields: userId, aiProvider, aiModel, pendingGenerationCount, stateDelta

**Error Responses:**
- `404 Not Found`: Book or page not found

---

### POST /api/books/:identifier/:pageId/visit

Marks a page as visited by updating user session and page progress. This is called when a user navigates to a page (not during pre-generation). The frontend should call this endpoint after the user lands on a page to track reading progress.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Request Body:**
```json
{
  "action": {
    "text": "Investigate the noise",
    "type": "explore",
    "hint": {
      "text": "Something waits in the shadows",
      "type": "dark_discovery"
    }
  },
  "previousPageId": "page456"
}
```

**Parameters:**
- `action` (object, required): The action chosen to reach this page
  - `text` (string): Action text
  - `type` (string): Action type (explore, escape, social, risk, ignore, attack, deceive, protect, create, heal, dialogue, custom, other)
  - `hint` (object): Consequence hint
- `previousPageId` (string, required): The previous page ID (for navigation history)

**Response (200 OK):**
```json
{
  "pageId": "page789",
  "branchId": "main",
  "page": 5
}
```

**Behavior:**
- Validates that the action exists on the previous page
- Prevents users from selecting alternate branches on revisited pages (except for premium users)
- Validates user's action choice to prevent multiple selections on the same page
- Updates user session and page progress tracking

**Error Responses:**
- `400 Bad Request`: Missing action or previousPageId
- `404 Not Found`: Book or page not found

**Note:**
- Page generation happens automatically via pre-generation when books are created or pages are generated
- This endpoint only tracks user navigation and progress, not page generation
- Candidate pages are pre-generated in the background for immediate navigation

---

### GET /api/books/:identifier/:pageId/candidates

Pre-generates candidate pages for all actions on a story page. This ensures that when users select actions, the corresponding destination pages are immediately available without waiting for AI generation.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID for which to generate candidates

**Response (200 OK):**

This endpoint **always** uses Server-Sent Events (SSE) for consistent response format:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**SSE Events:**

**1. Initial Progress Event:**
Sent immediately when the endpoint is called.

```http
event: progress
data: {"status": "waiting", "message": "Candidate generation started..."}
```

Or if generation is already in progress:

```http
event: progress
data: {"status": "waiting", "message": "Candidate generation in progress..."}
```

**2. Periodic Progress Events:**
Sent every 10 seconds during polling with elapsed time.

```http
event: progress
data: {"status": "waiting", "message": "Still generating... (10s elapsed)"}
```

**3. Per-Action Progress Events:**
Sent when individual actions are completed (if progress event storage is enabled).

```http
event: action_progress
data: {
  "action": "Open the door",
  "status": "completed",
  "completed": 2,
  "total": 3,
  "progress": 66,
  "timestamp": "2023-01-01T00:00:00.000Z"
}
```

**4. Complete Event:**
Sent when generation finishes with updated page data.

```http
event: complete
data: {
  "id": "page456",
  "page": 5,
  "text": "The hallway stretched endlessly before me...",
  "mood": "eerie",
  "place": "hallway",
  "timeOfDay": "night",
  "actions": [
    {
      "text": "Open the door",
      "type": "explore",
      "hint": {
        "text": "Something waits behind",
        "type": "dark_discovery"
      },
      "destination": {
        "branchId": "branch789",
        "pageId": "page790"
      }
    }
  ],
  "createdAt": "2023-01-01T00:00:00.000Z"
}
```

**5. Timeout Event:**
Sent after 5 minutes if generation hasn't completed.

```http
event: timeout
data: {
  "id": "page456",
  "page": 5,
  "text": "...",
  "warning": "Generation timeout, returning current state"
}
```

**6. Error Event:**
Sent if page is deleted during polling or other error occurs.

```http
event: error
data: {"error": "Page not found during polling"}
```

**Behavior:**
- Validates that page belongs to the specified book
- Always sets SSE headers first for consistent response format
- Checks `isGeneratingStartedAt` timestamp to detect in-progress generation (non-null means in-progress)
- If `isGeneratingStartedAt` is set: Uses SSE to poll for completion
- If `isGeneratingStartedAt` is null: Triggers background generation via `triggerBackgroundGeneration`, then polls for completion
- If no actions need generation: Sends SSE complete event immediately with current page
- Skips last page (no candidates needed for final page)
- Uses distributed lock to prevent concurrent processing
- Retries failed generations up to 3 times with exponential backoff
- Removes invalid actions (e.g., validation errors) from the page
- Returns updated page with pre-generated candidate destinations via SSE
- **Single operation guarantee**: Only one generation operation runs per (bookId + pageId) combination

**Error Responses:**
- `400 Bad Request`: Invalid UUID format
- `404 Not Found`: Book or page not found
- `500 Internal Server Error`: Candidate generation failed

---

### GET /api/books/:identifier

Retrieves a book by slug or UUID v7 identifier. Returns complete book information including metadata, author details, and engagement statistics.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Response (200 OK):**
```json
{
  "book": {
    "id": "book123",
    "userId": "user456",
    "slug": "whispering-halls",
    "title": "The Whispering Halls",
    "hook": "Sarah never believed in ghosts until she found the diary",
    "summary": "A psychological thriller about a librarian who discovers dark secrets",
    "image": "https://example.com/cover.jpg",
    "keywords": ["mystery", "thriller", "haunted"],
    "status": "active",
    "trendingScore": 0.85,
    "totalPages": 120,
    "language": "en",
    "topPick": null,
    "isOriginal": false,
    "branchesCount": 12,
    "firstPageId": "page456",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T10:30:00.000Z",
    "mc": {
      "name": "Sarah",
      "age": 28,
      "gender": "female",
      "bio": "Shy librarian with hidden past"
    },
    "author": {
      "id": "user456",
      "email": "user@example.com",
      "username": "johndoe",
      "name": "John Doe",
      "image": "https://example.com/avatar.jpg"
    },
    "stats": {
      "likesCount": 42,
      "readCount": 156,
      "completeCount": 23,
      "commentsCount": 25,
      "branchesCount": 12
    },
    "isLiked": false,
    "isRead": true
  }
}
```

**Behavior:**
- Resolves book by slug first, then UUID v7
- Returns enriched data with author information and engagement metrics
- Includes user-specific flags (isLiked, isRead) if authenticated
- Uses denormalized fields for O(1) performance on aggregate metrics
- readCount counts unique users who have started reading the book
- completeCount counts unique users who have completed the book (reached the last page)

**Error Responses:**
- `404 Not Found`: Book not found

---

### POST /api/books/:id/sessions

Creates or updates a reading session for a book. Tracks reading progress and manages active sessions.

**Authentication:** Optional (via `guestOrAuthMiddleware`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "pageId": "page456" // Optional - if not provided, auto-finds page 1
}
```

**Parameters:**
- `pageId` (string, optional): Current page ID in reading session. If not provided, automatically finds and uses page 1 of the book.

**Response (201 Created):**
```json
{
  "session": {
    "id": "session789",
    "userId": "user456",
    "bookId": "book123",
    "pageId": "page456",
    "previousPageId": null,
    "status": "active",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid pageId format
- `404 Not Found`: Book not found, or book has no pages

---

### GET /api/books/:id/similar

Retrieves similar books based on keyword Jaccard similarity. Uses PostgreSQL's native array operations to calculate similarity scores between the target book's keywords and all other books' keywords.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `id` (string, required): Book ID or slug to find similar books for

**Query Parameters:**
- `limit` (number, optional): Maximum number of similar books to return (default: 10, max: 50)

**Response (200 OK):**
```json
{
  "similarBooks": [
    {
      "id": "book456",
      "userId": "user789",
      "slug": "another-thriller",
      "title": "Another Thriller",
      "hook": "A dark secret lies beneath...",
      "summary": "A psychological thriller about...",
      "image": "https://example.com/cover2.jpg",
      "keywords": ["thriller", "mystery"],
      "status": "active",
      "trendingScore": 0.75,
      "totalPages": 100,
      "language": "en",
      "topPick": null,
      "isOriginal": false,
      "branchesCount": 8,
      "createdAt": "2023-01-02T00:00:00.000Z",
      "updatedAt": "2023-01-02T00:00:00.000Z",
      "mc": {
        "name": "John",
        "age": 30,
        "gender": "male"
      },
      "firstPageId": "page789",
      "author": {
        "id": "user789",
        "name": "Jane Doe",
        "username": "janedoe",
        "image": "https://example.com/avatar2.jpg"
      },
      "stats": {
        "likesCount": 25,
        "readCount": 100,
        "completeCount": 12,
        "commentsCount": 10,
        "branchesCount": 8
      },
      "isLiked": false,
      "isRead": true,
      "similarityScore": 0.75
    }
  ],
  "targetBook": {
    "id": "book123",
    "title": "The Whispering Halls",
    "keywords": ["mystery", "thriller", "haunted"]
  }
}
```

**Jaccard Similarity Formula:** J(A, B) = |A ∩ B| / |A ∪ B|

**Behavior:**
- Calculates similarity using PostgreSQL's native array operations
- Returns books with highest keyword overlap, sorted by similarity score
- Excludes the target book itself from results
- Only includes books with keywords and active status
- Includes author information and user-specific engagement flags (isLiked, isRead)

**Error Responses:**
- `404 Not Found`: Book not found

---

## Social Interactions

### POST /api/books/:id/like

Likes a book for the authenticated user. Increments the book's likes count and records the like in user_likes table.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (200 OK):**
```json
{
  "message": "Book liked successfully",
  "liked": true,
  "likesCount": 42
}
```

**Response (409 Conflict - already liked):**
```json
{
  "message": "Book already liked",
  "liked": true,
  "likesCount": 42
}
```

**Error Responses:**
- `404 Not Found`: Book not found

---

### DELETE /api/books/:id/like

Unlikes a book for the authenticated user. Decrements the book's likes count and removes the like from user_likes table.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (200 OK):**
```json
{
  "message": "Book unliked successfully",
  "liked": false,
  "likesCount": 41
}
```

**Response (404 Not Found - not liked):**
```json
{
  "message": "Book not liked",
  "liked": false,
  "likesCount": 42
}
```

**Error Responses:**
- `404 Not Found`: Book not found

---

### POST /api/books/:id/favorite

Adds a book to the authenticated user's favorites. Records the favorite in user_favorites table.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (201 Created):**
```json
{
  "message": "Book added to favorites",
  "favorited": true
}
```

**Response (409 Conflict - already favorited):**
```json
{
  "message": "Book already in favorites",
  "favorited": true
}
```

**Error Responses:**
- `404 Not Found`: Book not found

---

### DELETE /api/books/:id/favorite

Removes a book from the authenticated user's favorites. Removes the favorite from user_favorites table.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (200 OK):**
```json
{
  "message": "Book removed from favorites",
  "favorited": false
}
```

**Response (404 Not Found - not favorited):**
```json
{
  "message": "Book not in favorites",
  "favorited": false
}
```

**Error Responses:**
- `404 Not Found`: Book not found

---

## Comments

### GET /api/books/:id/comments

Retrieves all comments for a specific book. Supports pagination for large comment threads.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Comments per page (default: 20)

**Response (200 OK):**
```json
{
  "comments": [
    {
      "id": "comment123",
      "userId": "user456",
      "userName": "John Doe",
      "userImage": "https://example.com/avatar.jpg",
      "bookId": "book123",
      "parentCommentId": null,
      "content": "This story is amazing!",
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `404 Not Found`: Book not found

---

### POST /api/books/:id/comments

Creates a new comment on a book. Supports threaded comments via parentCommentId for replies.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "content": "This story is amazing!",
  "parentCommentId": "comment789"
}
```

**Parameters:**
- `content` (string, required): Comment content (max 5000 chars)
- `parentCommentId` (string, optional): Parent comment ID for replies

**Response (201 Created):**
```json
{
  "id": "comment123",
  "userId": "user456",
  "userName": "John Doe",
  "userImage": "https://example.com/avatar.jpg",
  "bookId": "book123",
  "parentCommentId": null,
  "content": "This story is amazing!",
  "createdAt": "2023-01-01T00:00:00.000Z",
  "updatedAt": "2023-01-01T00:00:00.000Z"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid content, parent comment not found, parent comment belongs to different book
- `404 Not Found`: Book not found

---

### DELETE /api/books/comments/:id

Deletes a comment. Only the comment author can delete their own comments.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Comment ID

**Response (200 OK):**
```json
{
  "message": "Comment deleted successfully"
}
```

**Error Responses:**
- `403 Forbidden`: Not the comment author
- `404 Not Found`: Comment not found

---

## Exploration

### GET /api/books/explore

Retrieves all published books for exploration. Supports both guest and authenticated users. Includes search, tags filtering, sorting, and pagination capabilities. Uses shared filter and query building logic with GET /api/books for consistency.

**Authentication:** Optional (via `optionalAuth`)

**Query Parameters:**
- `page` (number, optional): Page number for pagination (default: 1)
- `limit` (number, optional): Number of books per page (default: 20)
- `search` (string, optional): Search query for title, hook, summary, keywords
- `language` (string, optional): Filter by language code (e.g., "en", "es")
- `tags` (string, optional): Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
- `fuzzy` (boolean, optional): Enable fuzzy matching for typo tolerance (default: true)
- `sortBy` (string, optional): **Book-specific sort option** - popular|newest|trending|top-picks|originals (default: newest)
- `sortOrder` (string, optional): Sort direction for generic fallback sorting (asc|desc, default: desc)
- `lastUpdated` (string, optional): Filter by last update time: anytime|today|this-week|this-month|this-year (default: anytime)

**Shared Implementation:**
- Uses same filter building helpers as GET /api/books (buildSearchCondition, buildTagsFilterCondition, combineFilterConditions)
- Consistent query structure and pagination pattern
- Same enriched book data format with author info and engagement metrics
- Unified caching strategy with TTL based on sort option

**Response (200 OK):**
```json
{
  "books": [
    {
      "id": "book123",
      "title": "The Whispering Halls",
      "hook": "Sarah never believed in ghosts until she found the diary",
      "summary": "A psychological thriller about a librarian...",
      "image": "https://example.com/cover.jpg",
      "status": "active",
      "totalPages": 120,
      "language": "en",
      "mc": {
        "name": "Sarah",
        "age": 28,
        "gender": "female"
      },
      "author": {
        "id": "user456",
        "name": "John Doe",
        "username": "johndoe",
        "image": "https://example.com/avatar.jpg"
      },
      "stats": {
        "likesCount": 42,
        "readCount": 156,
        "commentsCount": 25,
        "branchesCount": 12
      },
      "trendingScore": 0.85,
      "isLiked": false,
      "isRead": false,
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 1234,
    "totalPages": 62,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

### GET /api/books/tags/popular

Fetches popular tags/keywords from books for filtering. Returns most frequently used tags across all published books. Useful for building tag filters and tag clouds.

**Authentication:** Not required

**Query Parameters:**
- `limit` (number, optional): Maximum number of tags to return (default: 20, max: 100)

**Response (200 OK):**
```json
{
  "tags": ["thriller", "mystery", "horror", "suspense", "detective", "psychological", "crime", "adventure"]
}
```

**Example:**
```
GET /api/books/tags/popular?limit=10
```

**Behavior:**
- Queries all books' keywords (JSONB array)
- Flattens and counts keyword occurrences
- Returns most popular tags sorted by frequency
- Filters out empty arrays and null values

---

### GET /api/books/stats

Retrieves public book statistics. Returns aggregate statistics about all books in the platform. Accessible to both authenticated and guest users.

**Authentication:** Optional (via `optionalAuth`)

**Response (200 OK):**
```json
{
  "storiesCreated": 1234,
  "branchesExplored": 5678,
  "pagesCrafted": 9012
}
```

---

## Utilities

### GET /api/books/prompt

Generates a creative book creation prompt using AI streaming. This endpoint is used for the "surprise me" feature to provide users with engaging story prompt suggestions.

**Authentication:** Optional (via `optionalAuth`)

**Response:** SSE stream (text/event-stream)

**SSE Events:**
```
event: start
data: {"type":"start","provider":"gemini","model":"gemini-3-flash-preview"}

event: chunk
data: {"type":"chunk","content":"Story about your best friend disappearing...","done":false}

event: end
data: {"type":"end","provider":"gemini","model":"gemini-2.5-flash"}
```

---

### POST /api/books/insert

Test route for directly inserting a book with provided data. Bypasses AI generation and uses the provided book data directly. Useful for testing and manual book creation.

**Authentication:** Required (via `requireAuth`)

**Request Body:**
```json
{
  "title": "The House That Breathes Below",
  "totalPages": 120,
  "language": "en",
  "hook": "The basement door wasn't just open—it was breathing.",
  "summary": "Daniel Vey returns to the abandoned Vey Manor...",
  "keywords": ["psychological-horror", "false-memory"],
  "mc": {
    "name": "Daniel Vey",
    "age": 22,
    "gender": "male",
    "bio": "A skeptic with a habit of lying to himself..."
  }
}
```

**Response (201 Created):**
```json
{
  "book": {
    "id": "book123",
    "title": "The House That Breathes Below",
    "totalPages": 120,
    "language": "en",
    "hook": "The basement door wasn't just open—it was breathing.",
    "summary": "Daniel Vey returns to the abandoned Vey Manor...",
    "keywords": ["psychological-horror", "false-memory"],
    "mc": {
      "name": "Daniel Vey",
      "age": 22,
      "gender": "male",
      "bio": "A skeptic with a habit of lying to himself..."
    },
    "status": "active",
    "likesCount": 0,
    "readCount": 0,
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  }
}
```

---

## Error Handling

All endpoints follow consistent error response formats:

**Standard Error Response:**
```json
{
  "success": false,
  "error": "Error message description"
}
```

**Validation Error Response:**
```json
{
  "success": false,
  "error": "Validation error message"
}
```

**Not Found Error Response:**
```json
{
  "success": false,
  "error": "Resource not found"
}
```

**Forbidden Error Response:**
```json
{
  "success": false,
  "error": "Forbidden: You do not have permission to access this resource"
}
```

**HTTP Status Codes:**
- `200 OK`: Successful GET or PUT request
- `201 Created`: Successful POST request
- `400 Bad Request`: Invalid request data
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Permission denied
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server error

---

## HTTP Headers

### Request Headers

- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (`android`, `ios`, `web`)
- `Content-Type`: `application/json` or `multipart/form-data` (for file uploads)
- `Cookie`: NextAuth session cookie (for authenticated endpoints)

### Response Headers

- `Cache-Control`: Cache directives (varies by endpoint)
  - `public, max-age=60, s-maxage=60, stale-while-revalidate=30` for public explore endpoint
  - `no-cache` for SSE streaming endpoint

---

## Caching Strategy

The API implements multi-level caching for performance:
- **Redis caching**: User books, explore page 1, user profiles, popular tags
- **HTTP caching**: Public explore endpoint uses CDN/edge caching with stale-while-revalidate
- **Cache invalidation**: Automatic invalidation on book creation, updates, deletions, likes, favorites, comments

**Cache TTLs:**
- User books: 5 minutes (PER_USER_BOOKS)
- Explore page 1 (newest): 30 minutes (EXPLORE_PAGE_1)
- Explore page 1 (trending): 5 minutes (EXPLORE_PAGE_1_TRENDING)
- Popular tags: 10 minutes (POPULAR_TAGS)
- User profiles: 5 minutes

---

## Authentication

Most endpoints require authentication via NextAuth JWT cookies. The middleware automatically verifies the JWT and extracts user information.

**Middleware Types:**
- `requireAuth`: Requires valid authentication (returns 401 if not authenticated)
- `optionalAuth`: Accepts both authenticated and guest users
- `guestOrAuthMiddleware`: Creates guest users if not authenticated, supports data migration on login

**Guest User Flow:**
1. Guest user visits site → Backend creates guest user in DB
2. Guest generates story → Associated with guest user ID
3. Guest logs in → Data migrates to authenticated user
4. Guest user deleted → Authenticated user takes over

---

## Twistloom Originals

Twistloom Originals are auto-generated psychological thriller books created by a weekly cron job. These books are marked with `isOriginal: true` and are discoverable via the "originals" sort option in the explore endpoint.

**Key Features:**
- **Auto-generated**: Created weekly via GitHub Actions cron job (every Monday at 9:00 UTC)
- **AI-powered themes**: Each original book uses a unique AI-generated theme
- **System-owned**: Owned by a system user ID (configured via `SYSTEM_USER_ID` environment variable)
- **Cover images**: Original books include AI-generated cover images
- **Discoverable**: Available via the "originals" sorting option on the explore endpoint

**Sorting Option:**
- `sortBy: "originals"` - Filters by `isOriginal: true`, sorts by `createdAt` (newest first)

**Implementation:**
- Cron script: `src/cron/generate-originals.ts`
- GitHub workflow: `.github/workflows/generate-originals.yml`
- Database field: `is_original` (boolean, default: false)

**Frontend Integration:**
- Display "Twistloom Original" badge on book cards when `isOriginal: true`
- Use the "originals" sort option to show only auto-generated books
- Original books can be read, liked, favorited, and commented like user-created books

---

## Database Schema

### Books Table
```sql
CREATE TABLE "books" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid REFERENCES users(user_id) ON DELETE set null,
  "slug" text UNIQUE,
  "title" text NOT NULL,
  "total_pages" integer DEFAULT 120 NOT NULL,
  "language" text,
  "hook" text,
  "summary" text,
  "image" text,
  "image_id" text,
  "trending_score" real DEFAULT 0,
  "is_original" boolean DEFAULT false NOT NULL,
  "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active',
  "mc" jsonb NOT NULL,
  "likes_count" integer DEFAULT 0 NOT NULL,
  "read_count" integer DEFAULT 0 NOT NULL,
  "branches_count" integer DEFAULT 0 NOT NULL,
  "top_pick" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

### User Likes Table
```sql
CREATE TABLE "user_likes" (
  "user_id" uuid NOT NULL,
  "target_type" text NOT NULL, -- "book" | "comment" | "user"
  "target_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "target_type", "target_id")
);
```

### User Favorites Table
```sql
CREATE TABLE "user_favorites" (
  "user_id" uuid NOT NULL,
  "book_id" uuid REFERENCES books(id) ON DELETE cascade NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "book_id")
);
```

### User Comments Table
```sql
CREATE TABLE "user_comments" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "book_id" uuid REFERENCES books(id) ON DELETE cascade NOT NULL,
  "parent_comment_id" uuid,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

---

## Testing

### Example cURL Commands

**Create a book:**
```bash
curl -X POST https://api.twistloom.com/api/books \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "theme": "haunted mansion mystery",
    "mcCandidate": {
      "name": "Sarah",
      "age": 28,
      "gender": "female"
    }
  }'
```

**Get user's books:**
```bash
curl https://api.twistloom.com/api/books \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

---

## Changelog

### v2.6.0 (2026-05-05)
- Implemented robust two-level sorting hierarchy for book endpoints
- **Primary sorting:** Book-specific sorting (applyBookSorting) with specialized logic:
  * popular: branchesCount/totalPages ratio
  * trending: weighted formula (readCount*0.5 + likesCount*0.3 + favoritedCount*0.2)
  * top-picks: latest topPick timestamp
  * originals: isOriginal=true + createdAt
  * newest: createdAt (default)
- **Secondary sorting:** Contextual sorting - relevance scoring for search, generic column fallback
- Refactored buildBookQuery to handle proper sorting hierarchy and eliminate sorting conflicts
- Updated both GET /api/books and GET /api/books/explore to use unified sorting approach
- Removed generic applySorting replacement that was breaking book-specific sorting logic
- Enhanced documentation to clarify two-level sorting behavior and book-specific sort options
- Maintained all existing filtering capabilities (search, tags, language, lastUpdated)
- Ensured backward compatibility with existing sortBy parameter values

### v2.5.0 (2026-05-05)
- Added comprehensive filtering consistency across book endpoints
- Unified filtering options between GET /api/books and GET /api/books/explore
- Added tags filtering to GET /api/books endpoint (comma-separated, OR logic)
- Added language and lastUpdated filtering to GET /api/books/explore endpoint
- Added relevance scoring with createRelevanceExpression to GET /api/books/explore
- Implemented consistent sorting with applySorting across both endpoints
- Added shared buildBookQuery helper function in book-controller.ts for DRY code
- Updated pagination utils to support tags parameter
- Enhanced search validation and sanitization across both routes
- Updated API documentation to reflect consistent filtering capabilities

### v2.4.0 (2026-05-04)
- Added new GET /api/books/:identifier endpoint to retrieve book by slug or UUID v7
- Added firstPageId field to book responses (ID of page 1 for direct navigation)
- Added originalActionsCount field to page responses (total actions before filtering)
- Added completeCount field to BookStats (unique users who completed the book)
- Updated readCount logic to count unique users from userPageProgress table (previously user_sessions)
- Updated branchesCount to use denormalized column from books table (previously subquery)
- Updated database trigger to maintain readCount based on user_page_progress INSERT/UPDATE
- Added completeCount query to count unique users who reached the last page of the book
- Updated EnrichedBookData type definition to include firstPageId
- Updated BookStats type definition to include completeCount and updated readCount documentation

### v2.3.0 (2026-05-04)
- Updated POST /api/books and POST /api/books/stream to require authentication (requireAuth instead of guestOrAuthMiddleware)
- Added credit consumption to book creation endpoints (requires 5 credits per story)
- Added 402 Payment Required error response for insufficient credits
- Updated GET /api/books/:identifier/:pageId to require authentication (requireAuth instead of optionalAuth)
- Changed GET /api/books/:identifier/:pageId path from :identifier/:branchId/:page to :identifier/:pageId
- Added selectedAction field to GET /api/books/:identifier/:pageId response (shows user's chosen action)
- Added translatedText field to GET /api/books/:identifier/:pageId response (supports Accept-Language header)
- Added Accept-Language header support for page translation (cached for performance)
- Updated POST /api/books/:identifier/:pageId/visit path from :identifier/:branchId/:page/visit to :identifier/:pageId/visit
- Added new GET /api/books/:identifier/:pageId/candidates endpoint for pre-generating candidate pages
- Added transaction metadata (context, metadata) to credits schema for better audit trail
- Fixed race condition in credit system by removing redundant hasSufficientCredits check
- Improved translation error handling with metadata and type-safe error responses
- Added language code validation (ISO 639-1) for translation service
- Fixed cache key separator in translation cache to prevent collisions
- Added updatedAt update logic for pageTranslations on translation insert/update
- Standardized credit error messages using constants (CREDIT_ERRORS)
- Added handleValidationError utility for consistent validation error responses

### v2.2.0 (2026-05-03)
- Added slug generation for books - auto-generates clean, URL-friendly slugs from titles
- Added `generateUniqueSlug()` function to ensure slug uniqueness with numeric suffixes
- Added `slug` field to database schema with unique constraint
- Updated `insertBook()` to automatically generate and include unique slugs
- Added `resolveBook()` function to accept both slug and UUID v7 for book lookup
- Updated `GET /api/books/:identifier/:branchId/:page` to accept slug or UUID
- Added `GET /api/books/:id/similar` endpoint for finding similar books via keyword Jaccard similarity
- Added `getSimilarBooks()` function using PostgreSQL native array operations
- Updated trending score to hybrid approach: cron-based with time decay + incremental updates on likes/favorites
- Likes increment trending score by +0.3, favorites by +0.2
- Updated page retrieval to filter actions without complete destinations (both branchId and pageId required)
- Added automatic retry of failed candidate generations when users visit pages with incomplete actions
- Added user choice validation to prevent selecting alternate branches on revisited pages
- Updated pagination field name from `totalCount` to `total` in comments endpoint
- Added `ai_evaluation_start` and `ai_evaluation_complete` SSE events to book creation stream
- Updated BookSortOption "popular" to sort by branchesCount (not ratio)
- Added slug generation utility function in text-processing.ts
- Updated cache TTLs: trending (5 min), newest (30 min)
- Added HTTP cache headers for explore endpoint with stale-while-revalidate

### v2.1.0 (2024-04-24)
- Added Twistloom Originals feature for weekly auto-generated books
- Added `isOriginal` boolean field to Book type (marks auto-generated books via cron job)
- Added `isOriginal` field to EnrichedBookData type
- Added "originals" sorting option to BookSortOption (filters by isOriginal: true, sorts by createdAt newest first)
- Updated database schema to include `is_original` column (boolean, default: false)
- Updated `mapBookFromDb()` function to include `isOriginal` and `topPick` fields
- Updated `getEnrichedBookSelect()` to include `isOriginal` and `topPick` in query results
- Created weekly cron job script (`src/cron/generate-originals.ts`) for automatic book generation
- Created GitHub Actions workflow (`.github/workflows/generate-originals.yml`) scheduled for every Monday at 9:00 UTC
- Added Twistloom Originals documentation section with feature overview and frontend integration notes
- Fixed `topPick` type in EnrichedBookData from `Date | undefined` to `Date | null` to match database schema
- Note: `isOriginal` is not exposed in public API - only set internally by cron job
- Refactored trending score calculation from query-based to cron-based approach
- Created daily cron job script (`src/cron/update-trending-scores.ts`) for trending score updates with time decay
- Updated trending sorting to use pre-calculated `trendingScore` column (improved performance)
- Added time decay logic to trending scores (newer books weighted higher)
- Fixed `user_auth` index predicates (removed `NOW()` function to resolve PostgreSQL error)
- Added database indexes to support all sorting options (newest, top-picks, originals)
- Added `branchesCount` column to books schema (maintained by database triggers)
- Created database triggers to automatically maintain `branchesCount` on pages INSERT/DELETE
- Refactored "popular" sorting to use pre-calculated `branchesCount` (improved performance)
- Optimized `getPublicBookStats` to use SUM of pre-calculated `branchesCount` instead of COUNT(DISTINCT branch_id)

### v2.0.0 (2024-04-24)
- Consolidated API documentation from BACKEND_BOOK_API_SPECIFICATION.md
- Added comprehensive Type Definitions section with TypeScript interfaces from src/types/book.ts and src/types/story.ts
- Added ActionType enum with all available action types for psychological impact
- Added Mood enum with all available emotional atmospheres
- Added BookSortOption type with sorting options for explore endpoint
- Added HTTP Headers section with request/response header documentation
- Updated Caching Strategy section with Redis caching details and cache key references
- Updated Rate Limiting section with specific rate limits per endpoint type
- Enhanced Error Handling documentation with HTTP status codes
- Updated Response Pattern section to align with industry-standard API patterns
- Maintained all existing endpoints and functionality
- Aligned documentation with actual canonical route implementation in src/routes/books.ts
- Verified pagination field name `totalCount` matches actual implementation
- Added comprehensive frontend integration notes
```

---

## HTTP Headers

### Request Headers

- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (`android`, `ios`, `web`)
- `Content-Type`: `application/json` or `multipart/form-data` (for file uploads)
- `Cookie`: NextAuth session cookie (for authenticated endpoints)

### Response Headers

- `Cache-Control`: Cache directives (varies by endpoint)
  - `public, max-age=60, s-maxage=60, stale-while-revalidate=30` for public explore endpoint
  - `no-cache` for SSE streaming endpoint

---

## Caching Strategy

- User's books list: Cached with TTL of 5 minutes (PER_USER_BOOKS)
- Explore page 1: Cached with TTL of 1 minute (EXPLORE_PAGE_1)
- Cache is invalidated on book creation, updates, and deletions
- Public explore endpoint uses CDN/edge caching with stale-while-revalidate

---

## Rate Limiting

Rate limits are enforced on a per-user basis to prevent abuse:

- GET endpoints: 100 requests per minute
- POST/PUT/DELETE endpoints: 50 requests per minute
- SSE streaming endpoint: 5 concurrent connections per user

---

## Version History

### v1.4.0 (2026-05-05)
- Added lastUpdated query parameter to GET /api/books for time-based filtering (anytime|today|this-week|this-month|this-year)
- Created shared filter building helpers in book-controller.ts (buildTimeFilterCondition, buildLanguageFilterCondition, buildSearchCondition, buildTagsFilterCondition, combineFilterConditions)
- Refactored GET /api/books to use shared filter helpers for DRY code
- Refactored GET /api/books/explore to use shared filter helpers for consistency
- Updated pagination utils to support lastUpdated and language parameters
- Added 'transactions' to ResourceName type for payments API consistency
- Unified query building logic across book list endpoints for maintainability

### v1.3.0 (2026-04-24)
- Updated Action type to use nested destination object with branchId and pageId
- Added isUserChosen field to EnrichedAction for user-specific action tracking
- Added POST /api/books/:identifier/:branchId/:page/visit endpoint for tracking user navigation
- Removed POST /api/books/:identifier/generate endpoint (page generation is now automatic)
- Updated GET page response to filter actions without complete destination (both branchId and pageId required)
- Added user choice validation to prevent selecting alternate branches on revisited pages
- Updated POST /visit response to return { pageId, branchId, page } for navigation context
- Removed redundant nextBranchId from EnrichedAction (use action.destination.branchId directly)
- Enhanced pre-generation with retry logic and exponential backoff
- Decoupled page generation from user session updates

### v1.2.0 (2025-04-24)
- Added tags filtering to explore endpoint (OR logic for multiple tags)
- Added GET /api/books/tags/popular endpoint for popular tags discovery
- Added 'originals' sort option
- Updated session endpoint to support optional pageId (auto-finds page 1)
- Enhanced guest user flow with session management

### v1.1.0 (2023-04-23)
- Added like/unlike book endpoints
- Added favorite/unfavorite book endpoints
- Added comment CRUD endpoints
- Enhanced documentation with comprehensive API reference
