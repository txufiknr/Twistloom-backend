# Books API Documentation

## Overview

The Books API provides endpoints for managing psychological thriller books, including creation, reading, social interactions (likes, favorites, comments), and exploration. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Base URL:** `/api/books`

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies. Unauthenticated users can access read-only endpoints.

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ book: {...} }`, `{ books: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ book: {...} }`, `{ page: {...} }`)
- PUT endpoints: Return updated resources with 200 status (e.g., `{ book: {...} }`)
- DELETE endpoints: Return simple messages or operation metadata (e.g., `{ message: "..." }`)

---

## Type Definitions

### BookMode

Book creation mode (story format / storytelling philosophy). Determines how the story is structured and the credit cost to generate it.

```typescript
type BookMode =
  | 'novel'       // Traditional linear story with a single path and ending (cheapest)
  | 'interactive'  // Reader choices lead to different branches and endings (medium)
  | 'multiverse';  // Every choice spawns unseen parallel timelines that keep evolving (most expensive)
```

| Mode | Description | Credit Cost |
| --- | --- | --- |
| `novel` | A traditional linear story with a single path and ending. | 2 |
| `interactive` | Readers make choices that lead to different branches and endings. | 5 |
| `multiverse` | Every choice creates unseen parallel timelines that continue to evolve, making the world feel alive beyond the reader's current path. | 10 |

If `mode` is omitted from a creation request it defaults to `interactive` (cost 5).

### BookStats

Book engagement statistics.

```typescript
interface BookStats {
  likesCount: number;          // Total likes
  readCount: number;           // Unique users who have started reading the book (from userPageProgress)
  completeCount: number;       // Unique users who have completed the book (reached the last page)
  commentsCount: number;       // Total comments
  testimonialsCount: number;   // Total testimonials (denormalized column, maintained by database triggers)
  branchesCount: number;       // Total branches in this book (denormalized column)
  completionRate: number | null; // Completion rate (calculated, currently unused)
}
```

### Book

Complete book data as stored in database.

```typescript
interface Book {
  id: string;                    // Book's unique identifier (UUID v7)
  userId: string;                // Author's user ID
  slug?: string;                 // SEO-friendly URL identifier (auto-generated from title)
  title: string;                 // Book title
  totalPages: number;           // Total number of pages in the book
  language: string;             // Book language
  hook: string;                 // Hook text (1-2 sentences, intriguing)
  summary: string;              // Summary (50-100 words, sets up psychological tension)
  imageUrl?: string;            // Cover image ImageKit URL
  imageId?: string;             // ImageKit file ID for deletion
  trendingScore: number;        // Trending score for book discovery (hybrid: cron-based + incremental updates)
  keywords: string[];           // Keywords for book discovery
  status: 'active' | 'archived' | 'draft';
  visibility: 'private' | 'unlisted' | 'followers' | 'public';
  mode: 'novel' | 'interactive' | 'multiverse'; // Book creation mode (story format)
  mc: StoryMC;                  // Main character profile with name, age, gender, imageUrl, imageId
  creditsPrice: number;         // Credit cost to read this book
  isOriginal: boolean;          // Whether this book is an auto-generated original (via cron job)
  originalThemeInput?: string;  // Original theme input for the book
  storyStartDate?: string;      // In-story start date
  advancedOptions?: AdvancedOptionsConfig; // Advanced options for book generation
  ending?: Ending;              // Author-edited ending text/outline (overrides derived ending)
  topPick?: Date;               // When the book was marked as top pick
  createdAt: Date;              // When the book was created
  updatedAt: Date;              // When the book was last updated
}
```

### Ending

Author-edited ending configuration for a story. Overrides the system-derived ending from `storyStates.viableEnding` when present.

```typescript
interface Ending {
  text?: string;                     // Text describing the ending
  type?: EndingType;                 // Type of ending (e.g. 'good', 'bad', 'ambiguous')
  outline?: StoryOutline[];          // Outline hints for the ending structure
  changeNote?: EndingChangeNote;     // Note about changes to the ending plan
}
```

See `src/types/story.ts` for the full `EndingType`, `StoryOutline`, and `EndingChangeNote` definitions.

### EnrichedBookData

Enriched book data with author info and engagement metrics. Returned by enriched book endpoints.

```typescript
interface EnrichedBookData {
  id: string;
  userId: string;
  slug: string | null;
  title: string;
  hook: string | null;
  summary: string | null;
  imageUrl: string | null;
  keywords: string[] | null;
  status: string | null;
  visibility: string | null;
  trendingScore: number | null;
  totalPages: number | null;
  language: string | null;
  creditsPrice: number | null;
  originalThemeInput: string | null;
  topPick: Date | null;
  isOriginal: boolean;
  createdAt: Date;
  updatedAt: Date;
  mc: Record<string, unknown>;
  author: User | null;
  stats: BookStats;
  isMine: boolean;
  isLiked: boolean;
  isRead: boolean;
  isSaved: boolean;
  isCompleted: boolean;
  isPurchased: boolean;
  firstPage: EnrichedBookFirstPage | null;
  session: EnrichedBookSession | null;
  translation: BookTranslation | null;
  generation: EnrichedBookGeneration | null;
  collection: string | null;
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

### EnrichedBookSession

Enriched reading session for the authenticated user on a specific book, returned in the `session` field of book endpoints. `last*` fields reflect the **current** cursor (`lastPageId` is the resume target and updates on every open, including back-navigation). `frontier*` fields form the **branch-aware active-tip** frontier used to gate per-paragraph commenting: the frontier is the reader's current tip of progress, advanced on forward progress or a different branch, and **preserved** on back-navigation.

```typescript
interface EnrichedBookSession {
  lastReadAt: Date;            // When the user last touched this book's session (== user_sessions.updated_at)
  lastPageId: string;          // Current page ID the reader is on (resume target)
  lastPageNumber: number;      // Current page number (1-based); decreases when navigating back
  frontierPageId: string | null;     // Active-tip page id (branch-aware; NOT a numeric max)
  frontierPageNumber: number;  // Display hint only — do NOT use for gating (branches share/cross numbers)
  frontierAncestorIds: string[];     // Frontier page's own id + its actionsHistory pageIds (for the ancestry rule)
  contextHistory: string;      // Persisted context/history snapshot for the session
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
  | 'popular'        // Sorts by branchesCount (pre-calculated branchesCount maintained by database triggers)
  | 'newest'         // Sorts by createdAt timestamp (latest books)
  | 'trending'       // Sorts by pre-calculated trendingScore (hybrid: cron-based with time decay + incremental updates on likes/favorites)
  | 'top-picks'      // Sorts by latest topPick timestamp (only books marked as editor's picks)
  | 'originals'      // Filters by isOriginal: true (auto-generated books via cron job), sorts by createdAt (newest first)
  | 'reads'          // Shows books the user has read, sorted by lastReadAt (requires auth, or set profileUserId to view another user's reads)
  | 'recommendations' // Recommends books based on user likes (requires authentication — not scoped by profileUserId)
  | 'creations'      // Shows user's own created books (requires auth, or set profileUserId to view another user's creations)
  | 'favorites'      // Shows user's saved/favorited books (requires auth, or set profileUserId to view another user's favorites)
  | 'for-you';       // Personalized recommendations based on user preferences (requires authentication)
```

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Frontend Integration](#frontend-integration)
3. [Book Management](#book-management)
   - [Create Book](#post-apibooks)
   - [Create Book with SSE](#post-apibooksstream)
   - [Create Book Async](#post-apibooksasync)
   - [Get Book Creation Status](#get-apibooksbookidstatus)
   - [Cancel Book Generation](#post-apibooksbookidcancel)
   - [Retry Book Generation](#post-apibooksbookidretry)
   - [Get Active Generations](#get-apibooksgenerationsactive)
   - [Get User's Library](#get-apibooks)
   - [Get Book by Identifier](#get-apibooksidentifier)
    - [Update Book Metadata](#put-apibooksid)
    - [Upload Cover Image](#put-apibooksidcover-image)
    - [Upload Character Avatar](#put-apibooksidcharacter-image)
    - [Update Book Visibility](#patch-apibooksidvisibility)
   - [Archive Book](#patch-apibooksidarchive)
   - [Delete Book](#delete-apibooksid)
   - [Purchase Book](#post-apibooksidentifierpurchase)
   - [Get Similar Books](#get-apibooksidsimilar)
4. [Book Reading](#book-reading)
   - [Get Specific Page](#get-apibooksidentifierpageid)
   - [Confirm Page Visit](#post-apibooksidentifierpageidconfirm-visit)
   - [Get Book Branches](#get-apibooksidentifierbranches)
   - [Generate Candidates (SSE)](#get-apibooksidentifierpageidcandidates)
   - [Get Candidate Generation Status](#get-apibooksidentifierpageidcandidatesstatus)
   - [Purchase Action Hint](#post-apibooksidentifierpageidactionshint)
5. [Custom Actions](#custom-actions)
   - [Preview Custom Action](#post-apibooksidentifierpageidcustom-actionspreview)
   - [Submit Custom Action](#post-apibooksidentifierpageidcustom-actionssubmit)
6. [Psychological Features](#psychological-features)
   - [Get Psychological Profile](#get-apibooksidentifierpsychological-profile)
   - [Get Locked Paths](#get-apibooksidentifierlocked-paths)
7. [Social Interactions](#social-interactions)
   - [Like Book](#post-apibooksidlike)
   - [Unlike Book](#delete-apibooksidlike)
   - [Favorite Book](#post-apibooksidfavorite)
   - [Unfavorite Book](#delete-apibooksidfavorite)
   - [Rename Collection](#patch-apibooksfavoritesrename-collection)
   - [Share Ending](#post-apibooksidentifierpageidshare)
   - [View Shared Ending](#get-apibooksshareusernamebookslugpageid)
8. [Comments](#comments)
    - [Get User Comments](#get-apibookscomments)
    - [Get Book Comments](#get-apibooksidcomments)
    - [Get Page Comments](#get-apibooksidpagespageidcomments)
    - [Get Paragraph Comments](#get-apibooksidpagespageidparagraphsparagraphnumbercomments)
    - [Create Comment](#post-apibooksidcomments)
    - [Create Page Comment](#post-apibooksidpagespageidcomments)
    - [Create Paragraph Comment](#post-apibooksidpagespageidparagraphsparagraphnumbercomments)
    - [Update Comment](#put-apibookscommentsid)
   - [Delete Comment](#delete-apibookscommentsid)
 9. [Book Testimonials](#book-testimonials)
   - [Get My Testimonials](#get-apibookstestimonials)
   - [List Book Testimonials](#get-apibooksidentifiertestimonials)
   - [Create Book Testimonial](#post-apibooksidentifiertestimonials)
   - [Get Book Testimonial](#get-apibooksidentifiertestimonialsid)
   - [Update Book Testimonial](#patch-apibooksidentifiertestimonialsid)
   - [Delete Book Testimonial](#delete-apibooksidentifiertestimonialsid)
10. [Exploration](#exploration)
   - [Explore Books](#get-apibooksexplore)
   - [Get Popular Tags](#get-apibookstagspopular)
   - [Get Book Stats](#get-apibooksstats)
11. [Utilities](#utilities)
     - [Generate Book Prompt](#get-apibooksprompt)
     - [Insert Book (Test)](#post-apibooksinsert)
     - [Workflow Webhook (Internal)](#post-apibooksworkflow-webhook)
12. [Error Handling](#error-handling)
13. [HTTP Headers](#http-headers)
14. [Caching Strategy](#caching-strategy)
15. [Rate Limiting](#rate-limiting)
16. [Authentication](#authentication)
17. [Changelog](#changelog)

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
  "generateCoverImage": false,
  "mode": "interactive"
}
```

**Credit Consumption:**
- Credit cost depends on the requested `mode` (see `BookMode`): `novel` = 2, `interactive` = 5, `multiverse` = 10
- Defaults to `interactive` (5 credits) if `mode` is omitted
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
- `mode` (string, optional): Book creation mode — `novel`, `interactive`, or `multiverse` (default: `interactive`)

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
    "imageUrl": "https://example.com/cover.jpg",
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
      "imageUrl": "https://example.com/avatar.jpg"
    },
    "stats": {
      "likesCount": 0,
      "readCount": 0,
      "commentsCount": 0,
      "testimonialsCount": 0,
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
- Credit cost depends on the requested `mode` (see `BookMode`): `novel` = 2, `interactive` = 5, `multiverse` = 10
- Defaults to `interactive` (5 credits) if `mode` is omitted
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

---

### GET /api/books/generations/active

Returns all active (in-progress) book generations for the authenticated user. Lightweight endpoint for the frontend to display generation progress indicators.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
[
  {
    "bookId": "01912345-6789-1234-5678-123456789012",
    "generationStatus": "in_progress",
    "generationStep": "ai_generation"
  },
  {
    "bookId": "01912345-6789-1234-5678-123456789013",
    "generationStatus": "in_progress",
    "generationStep": "theme_validation"
  }
]
```

---

### GET /api/books

Retrieves the authenticated user's own book library. Supports the same search, filtering, sorting, and pagination options as the explore endpoint, scoped to the user's own books.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `page` (number, optional): Page number for pagination (default: 1)
- `limit` (number, optional): Number of books per page (default: 20)
- `search` (string, optional): Search query for title, hook, summary, keywords
- `sortBy` (string, optional): Field to sort by (default: newest)
- `sortOrder` (string, optional): Sort direction (default: desc)
- `status` (string, optional): Filter by comma-separated statuses. Values: active, draft, archived

**Response (200 OK):**
```json
{
  "books": [
    {
      "id": "book123",
      "title": "The Whispering Halls",
      "status": "active",
      "author": { "name": "John Doe", "username": "johndoe" },
      "stats": { "readsCount": 150, "likesCount": 32 },
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-15T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 5,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `401 Unauthorized`: Authentication required

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
    "imageUrl": "https://example.com/cover.jpg",
    "keywords": ["mystery", "thriller", "haunted"],
    "status": "active",
    "trendingScore": 0.85,
    "totalPages": 120,
    "language": "en",
    "topPick": null,
    "isOriginal": false,
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
      "imageUrl": "https://example.com/avatar.jpg"
    },
    "stats": {
      "likesCount": 42,
      "readCount": 156,
      "completeCount": 23,
      "commentsCount": 25,
      "testimonialsCount": 7,
      "branchesCount": 12
    },
    "isLiked": false,
    "isRead": true,
    "isMine": false,
    "isSaved": false,
    "isCompleted": false,
    "isPurchased": false,
    "session": {
      "lastReadAt": "2023-01-15T10:30:00.000Z",
      "lastPageId": "page789",
      "lastPageNumber": 5,
      "frontierPageId": "page812",
      "frontierPageNumber": 12,
      "frontierAncestorIds": ["page1", "page30", "page812"],
      "contextHistory": "The MC followed a stranger into the cellar…"
    },
    "collection": null
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

### PUT /api/books/:id

Updates book metadata (title, hook, summary, keywords, visibility, status, MC text fields, ending). Supports partial updates — only provided fields will be modified.

Does **not** handle image uploads. Use `PUT /api/books/:id/cover-image` and `PUT /api/books/:id/character-image` for image operations.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Field Sanitization:**
All text fields (`title`, `hook`, `summary`) are sanitized via `sanitizeBookTextField` before storage:
- XSS tags are stripped
- Double-width quotes are normalised
- Empty/whitespace-only values are treated as "not provided" (field is skipped)

**Request Body:**
```json
{
  "title": "Updated Title",
  "hook": "Updated hook text",
  "summary": "Updated summary",
  "keywords": ["thriller", "mystery"],
  "visibility": "public",
  "mc": {
    "name": "Sarah",
    "age": 28,
    "gender": "female",
    "bio": "Updated bio"
  },
  "ending": {
    "text": "Sarah finally confronts her past...",
    "type": "ambiguous",
    "outline": [
      { "text": "Confrontation scene", "isDone": false }
    ]
  }
}
```

**Parameters:**
- `title` (string, optional): Book title (sanitised for XSS)
- `hook` (string, optional): Hook text (sanitised for XSS)
- `summary` (string, optional): Summary text (sanitised for XSS)
- `keywords` (string[], optional): Keyword list (sanitised via `sanitizeKeywords`)
- `visibility` (string, optional): One of `private`, `unlisted`, `followers`, `public`
- `status` (string, optional): One of `active`, `archived`, `draft`
- `mc` (object, optional): MC text fields only (`name`, `age`, `gender`, `bio`). Image fields (`imageUrl`, `imageId`) are silently ignored — use `PUT /api/books/:id/character-image` for avatar operations
- `ending` (object, optional): Full ending object (replaces existing)
  - `text` (string, optional): Ending description
  - `type` (string, optional): Ending type (`good`, `bad`, `ambiguous`, etc.)
  - `outline` (array, optional): Story outline beats
  - `changeNote` (object, optional): Change tracking note

**Response (200 OK):**
```json
{
  "book": {
    "id": "book123",
    "title": "Updated Title",
    "hook": "Updated hook text",
    "summary": "Updated summary",
    "keywords": ["thriller", "mystery"],
    "mc": {
      "name": "Sarah",
      "age": 28,
      "gender": "female",
      "bio": "Updated bio"
    },
    "ending": {
      "text": "Sarah finally confronts her past...",
      "type": "ambiguous"
    },
    "updatedAt": "2023-01-15T12:00:00.000Z"
  }
}
```

**Behavior:**
- Text fields (`title`, `hook`, `summary`) are always sanitised — empty-string values are treated as "not provided" and the field retains its existing value
- `keywords` are sanitised via `sanitizeKeywords` (deduplication, length limits)
- MC `imageUrl`/`imageId` are silently stripped — use the dedicated cover-image or character-image endpoints
- `ending` replaces the entire JSONB value — partial merges are not performed
- Cache is invalidated for user books, explore listings, and popular tags (when keywords change)

**Error Responses:**
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### PUT /api/books/:id/cover-image

Uploads or replaces a book's cover image. Accepts multipart file upload, URL, or base64-encoded image data. Uploads to ImageKit, persists the upload record, updates the book's `imageId`, and cleans up the old cover image.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body (multipart/form-data):**
- `imageFile` (file, optional): Cover image file

**Request Body (JSON):**
```json
{
  "imageUrl": "https://example.com/new-cover.jpg"
}
```

**Parameters:**
- `imageUrl` (string, optional): Cover image URL or base64 data string
- `imageFile` (file, optional): Cover image file (multipart upload via `imageUploadMiddleware`)

**Response (200 OK):**
```json
{
  "imageUrl": "https://ik.imagekit.io/abc123/cover.jpg",
  "imageId": "file123",
  "imageUploaded": true,
  "oldImageQueuedForDeletion": false,
  "uploadSource": "file"
}
```

**Behavior:**
- Accepts one of: multipart `imageFile`, URL string, or base64 string via `imageUrl`
- Uploads to ImageKit and persists the upload record in `uploaded_images` with `type: 'cover'`
- Updates the book record with the new `imageId`
- Deletes the old cover image from ImageKit (queues for cron-based deletion if immediate deletion fails)
- Invalidates user books cache and explore cache

**Error Responses:**
- `400 Bad Request`: No image provided or upload failed
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### PUT /api/books/:id/character-image

Uploads or replaces the main character's avatar image. Accepts multipart file upload, URL, or base64-encoded image data. Uploads to ImageKit's `book-characters` folder, persists the upload record, updates the book's `mc.imageUrl`/`mc.imageId`, and cleans up the old avatar.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body (multipart/form-data):**
- `imageFile` (file, optional): Character avatar image file

**Request Body (JSON):**
```json
{
  "imageUrl": "https://example.com/avatar.jpg"
}
```

**Parameters:**
- `imageUrl` (string, optional): Avatar image URL or base64 data string
- `imageFile` (file, optional): Avatar image file (multipart upload via `imageUploadMiddleware`)

**Response (200 OK):**
```json
{
  "imageUrl": "https://ik.imagekit.io/abc123/characters/avatar.jpg",
  "imageId": "file456",
  "mcAvatarUploaded": true,
  "uploadSource": "file"
}
```

**Behavior:**
- Accepts one of: multipart `imageFile`, URL string, or base64 string via `imageUrl`
- Uploads to ImageKit's `book-characters` folder and persists the upload record in `uploaded_images` with `type: 'mc'`
- Updates the book's `mc.imageUrl` and `mc.imageId` fields
- Deletes the old MC avatar from ImageKit
- Invalidates user books cache and explore cache

**Error Responses:**
- `400 Bad Request`: No image provided or upload failed
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### DELETE /api/books/:id

Deletes a book and queues its cover image for deletion. Only the book author can delete their own books.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Response (200 OK):**
```json
{
  "message": "Book deleted successfully",
  "imageQueuedForDeletion": true
}
```

**Error Responses:**
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### PATCH /api/books/:id/visibility

Updates the visibility setting of a book. Controls who can see the book in listings and explore feeds.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Visibility Levels:**
- `private`: Only the owner can see it in their library
- `unlisted`: Only accessible via a direct shareable link
- `followers`: Owner and their followers can see it in feeds
- `public`: Anyone can discover and read it (explorable)

**Request Body:**
```json
{
  "visibility": "public"
}
```

**Response (200 OK):**
```json
{
  "book": {
    "id": "book123",
    "visibility": "public"
  },
  "visibility": "public"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid visibility value
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### PATCH /api/books/:id/archive

Archives or unarchives a book (toggles status between `active` and `archived`). Archiving removes the book from public listings and explore feeds without deleting it. Unarchiving restores it.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "status": "archived"
}
```

**Response (200 OK):**
```json
{
  "book": {
    "id": "book123",
    "status": "archived"
  },
  "status": "archived"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid status value
- `403 Forbidden`: Not the book author
- `404 Not Found`: Book not found

---

### POST /api/books/async

Creates a new book asynchronously using GitHub Actions workflow. Returns bookId immediately to bypass Vercel's 5-minute timeout. Frontend should poll GET /api/books/:bookId/status for updates.

**Authentication:** Required (via `requireAuth`)

**Credit Consumption:**
- Requires 5 credits to create a story (configurable via `CREDIT_COSTS.STORY_GENERATION`)
- Credits are deducted transactionally before book creation
- Returns 402 Payment Required if insufficient credits
- Credits are refunded if workflow trigger fails

**Request Body:** Same as `POST /api/books`

**Credit Consumption:**
- Credit cost depends on the requested `mode` (see `BookMode`): `novel` = 2, `interactive` = 5, `multiverse` = 10
- Defaults to `interactive` (5 credits) if `mode` is omitted
- Credits are deducted transactionally before book creation
- Returns 402 Payment Required if insufficient credits
- Credits are refunded if workflow trigger fails

**Response (200 OK):**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "message": "Book creation started. Poll /api/books/:bookId/status for updates."
}
```

**Error Responses:**
- `400 Bad Request`: Invalid theme, missing required fields, theme validation failed
- `401 Unauthorized`: Authentication required
- `402 Payment Required`: Insufficient credits
- `500 Internal Server Error`: Failed to trigger workflow

---

### GET /api/books/:bookId/status

Polls for book creation status when using async book creation. Used by frontend to check progress of GitHub Actions workflow.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `bookId` (string, required): Book ID (UUID v7)

**Response (200 OK) - In Progress:**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "status": "draft",
  "generationStatus": "in_progress",
  "generationStep": "generating",
  "generationStepDescription": "AI generation in progress: generating",
  "createdAt": "2026-05-12T10:00:00.000Z",
  "updatedAt": "2026-05-12T10:02:30.000Z",
  "generationStartedAt": "2026-05-12T10:00:05.000Z",
  "generationCompletedAt": null
}
```

**Response (200 OK) - Complete:**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "status": "active",
  "generationStatus": "completed",
  "generationStep": "completed",
  "generationStepDescription": "Book generation completed",
  "createdAt": "2026-05-12T10:00:00.000Z",
  "updatedAt": "2026-05-12T10:05:00.000Z",
  "generationStartedAt": "2026-05-12T10:00:05.000Z",
  "generationCompletedAt": "2026-05-12T10:05:00.000Z"
}
```

**Response (200 OK) - Failed:**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "status": "draft",
  "generationStatus": "failed",
  "generationStep": null,
  "generationStepDescription": "Book generation failed",
  "error": "AI generation failed: timeout",
  "createdAt": "2026-05-12T10:00:00.000Z",
  "updatedAt": "2026-05-12T10:10:00.000Z"
}
```

**Response (200 OK) - Cancelled (retryable):**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "status": "draft",
  "generationStatus": "cancelled",
  "generationStep": null,
  "generationStepDescription": "Book generation was cancelled",
  "createdAt": "2026-05-12T10:00:00.000Z",
  "updatedAt": "2026-05-12T10:10:00.000Z"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid book ID format
- `403 Forbidden`: You can only view status for your own books
- `404 Not Found`: Book not found

---

### POST /api/books/:bookId/cancel

Cancels a non-completed book generation. Sets the generation status to `cancelled`, cancels any running GitHub Actions workflow (best-effort), refunds credits on a pro-rata basis based on the current generation step, and keeps the draft book row (`status: 'draft'`) for later retry. If the generation is past the point of no return, the book is archived instead of deleted.

Cancelled (and all draft) books can be found via the creations tab:
```
GET /api/books/explore?sortBy=creations&status=draft
```
Each book's `generationStatus` can be checked individually via `GET /api/books/:bookId/status`.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `bookId` (string, required): Book ID (UUID v7)

**Guards:**
- Completed books (`status === 'active'` or `generationStatus === 'completed'`) cannot be cancelled
- Already refunded books are rejected to prevent double-refunds
- Generations past the point of no return (finalizing step) are instead marked with `cancellationRequestedAt` so the book is archived on completion rather than published

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Book generation cancelled. 5 credits refunded."
}
```

*The refunded amount matches the book's `mode` cost (2 / 5 / 10).*

**Response (202 Accepted) — past point of no return:**
```json
{
  "success": true,
  "message": "Generation is almost complete and will finish in the background. The book will be archived instead of published."
}
```

**Error Responses:**
- `400 Bad Request`: Invalid book ID format, cannot cancel completed book, already refunded
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

**Frontend integration:**
- Cancelled books appear in the user's creations tab with a "Cancelled" badge
- The book card shows the title, theme, and cancellation status
- Available actions: **Retry** (re-dispatch generation) or **Delete** (permanently remove)
- To find cancelled books, use `GET /api/books/explore?sortBy=creations&status=draft` and check `generationStatus` via the status endpoint

---

### POST /api/books/:bookId/retry

Retries a failed or cancelled async book generation. Resets the generation state back to `pending`, clears all error/refund timestamps, re-consumes credits, and re-dispatches the GitHub Actions workflow. The original theme and MC parameters are preserved from the draft book row.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `bookId` (string, required): Book ID (UUID v7)

**Finding retryable books:**
All draft books (including cancelled, failed, pending, and in-progress) appear in the user's creations tab. Filter by draft status to see them:
```
GET /api/books/explore?sortBy=creations&status=draft
```
Use `GET /api/books/:bookId/status` to check the exact generation status before retrying.

**Guards:**
- Only `failed` or `cancelled` generations can be retried. Completed or in-progress generations are rejected
- Credits are re-consumed atomically with the state reset (the original deduction was refunded on failure/cancellation)

**Credit Consumption:**
- Requires 5 credits to retry (same as initial creation, configurable via `CREDIT_COSTS.STORY_GENERATION`)
- Credits are deducted transactionally before the retry is initiated
- Returns 402 Payment Required if insufficient credits

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Book generation retry initiated. 5 credits consumed."
}
```

**Error Responses:**
- `400 Bad Request`: Invalid book ID format, generation not in retryable state
- `402 Payment Required`: Insufficient credits
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

---

### POST /api/books/:identifier/purchase

Purchases a paid book with credits. Consumes credits equal to the book's `creditsPrice` to unlock access.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Credit Consumption:**
- Consumes credits equal to the book's `creditsPrice`
- Returns 402 Payment Required if insufficient credits

**Response (200 OK):**
```json
{
  "success": true,
  "bookId": "book123",
  "creditsPrice": 50,
  "alreadyPurchased": false
}
```

**Response (200 OK - already purchased):**
```json
{
  "success": true,
  "bookId": "book123",
  "creditsPrice": 50,
  "alreadyPurchased": true,
  "message": "You have already purchased this book"
}
```

**Error Responses:**
- `400 Bad Request`: Book is not available for purchase
- `402 Payment Required`: Insufficient credits
- `404 Not Found`: Book not found

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
      "imageUrl": "https://example.com/cover2.jpg",
      "keywords": ["thriller", "mystery"],
      "status": "active",
      "trendingScore": 0.75,
      "totalPages": 100,
      "language": "en",
      "topPick": null,
      "isOriginal": false,
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
        "imageUrl": "https://example.com/avatar2.jpg"
      },
      "stats": {
        "likesCount": 25,
        "readCount": 100,
        "completeCount": 12,
        "commentsCount": 10,
        "testimonialsCount": 3,
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

## Book Reading

### GET /api/books/:identifier/:pageId

Retrieves a specific page by book identifier (slug or UUID) and page ID. Supports translation via Accept-Language header. Requires authentication.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Headers:**
- `Accept-Language` (string, optional): Desired language code (e.g., "en", "es", "fr")

**Response (200 OK):**
```json
{
  "page": {
    "id": "page456",
    "page": 5,
    "text": "The library was silent except for the rain...",
    "mood": "eerie",
    "place": "library",
    "timeOfDay": "night",
    "charactersPresent": ["Sarah"],
    "keyEvents": ["found diary"],
    "importantObjects": ["diary"],
    "actions": [
      {
        "text": "Investigate the noise",
        "type": "explore",
        "hint": {
          "text": "Something waits in the shadows",
          "type": "dark_discovery"
        },
        "destination": {
          "branchId": "branch123",
          "pageId": "page789"
        },
        "nextPageNumber": 6,
        "isUserChosen": false
      }
    ],
    "originalActionsCount": 3,
    "translatedText": "La biblioteca estaba en silencio excepto por la lluvia...",
    "aiProvider": "gemini",
    "aiModel": "gemini-2.5-flash",
    "paragraphCommentCounts": {
      "0": 5,
      "1": 2,
      "3": 1
    },
    "createdAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls",
    "totalPages": 120,
    "language": "en"
  },
  "selectedAction": {
    "text": "Investigate the noise",
    "type": "explore",
    "destination": {"branchId": "branch123", "pageId": "page789"}
  }
}
```

**Behavior:**
- Returns page with actions that have complete destinations (both branchId and pageId)
- Filters out actions without destinations
- Includes user's previously chosen action if they've visited this page
- Supports translation via Accept-Language header (cached for performance)
- Returns originalActionsCount to show total actions before filtering
- Returns `paragraphCommentCounts`, a map of comment counts keyed by paragraph number (1-based). Page-level comments (no paragraph scope) are reported under the key `0`. Only paragraphs with at least one comment are included. Use this for per-paragraph comment badges. Comments themselves are fetched via the page/paragraph comment endpoints.

**Error Responses:**
- `404 Not Found`: Book or page not found

---

### POST /api/books/:identifier/:pageId/confirm-visit

Confirms a user's visit to a specific page and records it in the user's reading progress. Called when a user actively navigates to a page (by selecting an action), as opposed to prefetching.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Request Body:**
```json
{
  "consumeCredits": false
}
```

**Parameters:**
- `consumeCredits` (boolean, optional): Whether to consume credits for this page

**Response (200 OK):**
```json
{
  "visitDetails": {
    "userId": "user456",
    "bookId": "book123",
    "pageId": "page456",
    "lastPageNumber": 5,
    "isCompleted": false
  }
}
```

---

### GET /api/books/:identifier/branches

Retrieves all branches (id & display name) for a book. Accepts both slug and UUID v7 as book identifier. Returns the main branch (using the book's title) followed by all non-main branches.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Response (200 OK):**
```json
[
  { "branchId": "main", "displayName": "The Whispering Halls" },
  { "branchId": "0194f2d1-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "displayName": "The Dark Path" }
]
```

**Error Responses:**
- `404 Not Found`: Book not found

---

### GET /api/books/:identifier/:pageId/candidates

Pre-generates candidate pages for all actions on a specific page using Server-Sent Events (SSE). Provides real-time progress updates for each candidate generation.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**SSE Events:**
```
event: start
data: {"type":"start","totalActions":3}

event: action_start
data: {"type":"action_start","actionIndex":0,"actionText":"Investigate the noise"}

event: action_complete
data: {"type":"action_complete","actionIndex":0,"pageId":"page789"}

event: complete
data: {"type":"complete","generatedPages":[{"pageId":"page789","actionIndex":0},...]}

event: error
data: {"type":"error","message":"Generation failed"}
```

**Response:** SSE stream (text/event-stream)

**Behavior:**
- Checks if generation is already in progress and resets if stuck (exceeded MAX_GENERATION_DURATION_MS)
- Generates candidate pages for all actions without existing pageId destinations
- Polls database for completion status every 2 seconds
- Sends progress events for each action generation
- Returns complete event with all generated page IDs

**Error Responses:**
- `400 Bad Request`: Invalid pageId format
- `404 Not Found`: Page not found

---

### GET /api/books/:identifier/:pageId/candidates/status

Polls the status of candidate page generation for a specific page. Used by frontend to check if candidate generation is complete.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Response (200 OK):**
```json
{
  "isGenerating": false,
  "isDone": true,
  "totalPendingActions": 0,
  "lastUpdated": "2024-01-01T00:00:10Z"
}
```

**Response (200 OK) - In Progress:**
```json
{
  "isGenerating": true,
  "isDone": false,
  "totalPendingActions": 2,
  "lastUpdated": "2024-01-01T00:00:05Z"
}
```

**Behavior:**
- Checks if generation is stuck and resets if needed
- Returns current generation status
- Counts total pending actions (actions without pageId destinations)
- Returns last updated timestamp

**Error Responses:**
- `400 Bad Request`: Invalid pageId format
- `404 Not Found`: Page not found

---

### POST /api/books/:identifier/:pageId/actions/hint

Purchases an action hint for a specific action on a page. Consumes 1 credit to reveal additional information about an action. Users can purchase hints for actions they haven't selected yet.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Page ID

**Credit Consumption:**
- Requires 1 credit to purchase a hint (configurable via `CREDIT_COSTS.SHOW_ACTION_HINT`)
- Returns 402 Payment Required if insufficient credits

**Request Body:**
```json
{
  "actionText": "Investigate the noise"
}
```

**Parameters:**
- `actionText` (string, required): Action text to purchase hint for

**Response (200 OK):**
```json
{
  "success": true,
  "actionText": "Investigate the noise",
  "alreadyPurchased": false
}
```

**Response (200 OK - already purchased):**
```json
{
  "success": true,
  "actionText": "Investigate the noise",
  "alreadyPurchased": true,
  "message": "You have already purchased this hint"
}
```

**Error Responses:**
- `400 Bad Request`: Missing actionText, action not found on page
- `402 Payment Required`: Insufficient credits
- `404 Not Found`: Page not found

---

## Social Interactions

### POST /api/books/:id/like

Likes a book for the authenticated user. Increments the book's likes count and records the like in user_likes table.

**Idempotent:** If the book is already liked, the endpoint returns 200 instead of 409 — no error, no duplicate count increment.

**Favorites upsert:** If a `collection` body is provided, the endpoint upserts the book into `user_favorites` (inserts if new, updates the collection name if already saved). This happens regardless of whether the book was already liked.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "collection": "Thriller"
}
```

**Parameters:**
- `collection` (string, optional): Collection name to save the book under in favorites

**Response (200 OK) - New like:**
```json
{
  "message": "Book liked successfully",
  "liked": true,
  "likesCount": 42
}
```

**Response (200 OK) - Already liked (idempotent):**
```json
{
  "message": "Book already liked",
  "liked": true,
  "likesCount": 42
}
```

**Response (200 OK) - Like with favorites upsert:**
```json
{
  "message": "Book liked successfully",
  "liked": true,
  "likesCount": 42,
  "favorited": true,
  "collection": "Thriller"
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

### PATCH /api/books/favorites/rename-collection

Renames a collection for the authenticated user across all their favorites. Every row in `user_favorites` where the `collection` column matches `oldCollection` is updated to `newCollection`.

**Authentication:** Required (via `requireAuth`)

**Request Body:**
```json
{
  "oldCollection": "Thriller",
  "newCollection": "Horror"
}
```

**Parameters:**
- `oldCollection` (string, required): Current collection name to rename
- `newCollection` (string, required): New collection name to apply

**Response (200 OK):**
```json
{
  "updatedCount": 5,
  "message": "Collection renamed successfully"
}
```

**Response (200 OK) - No matches:**
```json
{
  "updatedCount": 0,
  "message": "No favorites found with collection 'NonExistent'"
}
```

**Error Responses:**
- `400 Bad Request`: Missing or invalid oldCollection/newCollection

---

### POST /api/books/:identifier/:pageId/share

Records a user sharing a completed ending page for a book. The user must have actually reached this page (have a completion record).

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): UUID v7 of the ending page to share

**Response (200 OK):**
```json
{
  "success": true
}
```

**Error Responses:**
- `404 Not Found`: No completion found for this page

---

### GET /api/books/share/:username/:bookSlug/:pageId

Public endpoint for viewing a shared ending page. No authentication required. Three gates restrict access:
1. Book visibility must not be `private`
2. The completion must exist in `user_completed_books`
3. The completion must have been shared (activity log entry)

Only returns public-safe fields — nothing personal to the sharer beyond what they explicitly agreed to expose.

**Authentication:** Not required (public)

**Path Parameters:**
- `username` (string, required): Sharer's username
- `bookSlug` (string, required): Book slug
- `pageId` (string, required): UUID v7 of the ending page

**Response (200 OK):**
```json
{
  "sharer": {
    "name": "Jane",
    "imageUrl": "https://example.com/avatar.jpg"
  },
  "book": {
    "title": "The Haunting",
    "hook": "Sarah never believed in ghosts until she found the diary",
    "slug": "the-haunting",
    "imageUrl": null,
    "readCount": 142
  },
  "ending": {
    "text": "I walked out the front door and never looked back...",
    "percentage": 12.5
  }
}
```

**Error Responses:**
- `404 Not Found`: Not found (any gate failure)

---

## Custom Actions

Custom actions allow readers to type free-form actions instead of choosing from predefined options. They are validated by AI for narrative plausibility and may incur additional credit costs.

### POST /api/books/:identifier/:pageId/custom-actions/preview

Preview a custom action without charging credits. Runs validity checks (eligibility, security, AI interpretation) and returns the expected credit cost — but does not charge or generate anything.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Current page ID

**Request Body:**
```json
{
  "text": "I try to pick the lock with my hairpin"
}
```

**Parameters:**
- `text` (string, required): Custom action text (3-60 chars)

**Response (200 OK) - Allowed:**
```json
{
  "outcome": "allow",
  "preview": {
    "canonicalIntent": "attempt lockpicking escape",
    "cost": 3
  }
}
```

**Response (200 OK) - Rejected:**
```json
{
  "outcome": "reject",
  "message": "That doesn't match what's true in this story so far.",
  "rejectionCategory": "invalid_action"
}
```

**Error Responses:**
- `400 Bad Request`: Missing text, invalid pageId format
- `404 Not Found`: Page not found

---

### POST /api/books/:identifier/:pageId/custom-actions/submit

Submit a custom action. Re-runs all validation gates, charges credits (3 credits standard, 6 if the user already chose an action on this page), and triggers page generation.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `pageId` (string, required): Current page ID

**Credit Consumption:**
- Standard: 3 credits (configurable via `CREDIT_COSTS.CUSTOM_ACTION`)
- After existing choice: 6 credits (configurable via `CREDIT_COSTS.CUSTOM_ACTION_AFTER_CHOICE`)
- Returns 402 Payment Required if insufficient credits

**Request Body:**
```json
{
  "text": "I try to pick the lock with my hairpin"
}
```

**Parameters:**
- `text` (string, required): Custom action text (3-60 chars)

**Response (202 Accepted):**
```json
{
  "message": "Custom action submitted successfully. Page generation in progress.",
  "pollingInfo": {
    "pollingUrl": "/api/books/the-haunting/page456/candidates/status",
    "pollingIntervalMs": 2000,
    "maxPollingTimeMs": 80000
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing text, rejected custom action
- `402 Payment Required`: Insufficient credits
- `404 Not Found`: Page not found

---

## Psychological Features

### GET /api/books/:identifier/psychological-profile

Returns the post-ending "psychological autopsy" — who the MC became, the ending they reached, and teasers for what they didn't trigger. Uses the final page's story state to derive the profile and ending recommendation. No AI calls: purely templated from already-computed data.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Response (200 OK):**
```json
{
  "archetype": "the_paranoid",
  "stability": "cracking",
  "dominantTraits": ["fearful", "suspicious", "cautious"],
  "manipulationAffinity": "fear",
  "ending": {
    "type": "false_reality",
    "summary": "Paranoia pays off: the world actually isn't real."
  },
  "missedTeasers": [
    {
      "archetype": "the_explorer",
      "trigger": "you let fear close your eyes",
      "wouldHaveEnded": "loop",
      "teaser": "If you'd trusted just once, you'd have uncovered the truth beneath the lies."
    }
  ]
}
```

**Error Responses:**
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found or no profile data available

---

### GET /api/books/:identifier/locked-paths

Returns a timeline of places, connections, and threads that became permanently locked or closed during the story — the "paths not taken." Scans story state history to detect when place connections became blocked/destroyed/restricted and story threads were closed/resolved.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Response (200 OK):**
```json
{
  "lockedPaths": [
    {
      "kind": "place_connection",
      "label": "Abandoned Station → Underground Tunnel",
      "restriction": "Route blocked",
      "page": 12,
      "context": "The route between Abandoned Station and Underground Tunnel is now blocked."
    },
    {
      "kind": "thread",
      "label": "Who left the footsteps?",
      "restriction": "Closed",
      "page": 18,
      "context": "The thread \"Who left the footsteps?\" is now closed."
    }
  ]
}
```

**Error Responses:**
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

---

## Comments

### GET /api/books/comments

Retrieves comments made by the authenticated user, optionally filtered by book.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `bookId` (string, optional): Filter by book ID
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "comments": [
    {
      "id": "comment123",
      "userId": "user456",
      "bookId": "book123",
      "pageId": "page456",
      "paragraphNumber": 3,
      "parentCommentId": null,
      "content": "This story is amazing!",
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### GET /api/books/:id/comments

Retrieves all comments for a specific book. Supports pagination for large comment threads, and can be narrowed to a specific page and/or paragraph via query parameters.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Comments per page (default: 20)
- `pageId` (string, optional): Filter to comments on a specific page
- `paragraphNumber` (number, optional): Filter to comments on a specific paragraph within the page (requires `pageId`)

**Response (200 OK):**
```json
{
  "comments": [
    {
      "id": "comment123",
      "userId": "user456",
      "name": "John Doe",
      "imageUrl": "https://example.com/avatar.jpg",
      "bookId": "book123",
      "pageId": null,
      "paragraphNumber": null,
      "parentCommentId": null,
      "content": "This story is amazing!",
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 42,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `400 Bad Request`: `paragraphNumber` is not an integer
- `404 Not Found`: Book not found

---

### GET /api/books/:id/pages/:pageId/comments

Retrieves all comments scoped to a specific page of a book, optionally narrowed to a single paragraph. Supports pagination.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `id` (string, required): Book ID
- `pageId` (string, required): Page ID

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Comments per page (default: 20)
- `paragraphNumber` (number, optional): Filter to comments on a specific paragraph within the page

**Response (200 OK):** Same shape as `GET /api/books/:id/comments` (comments carry `pageId` and `paragraphNumber`).

**Error Responses:**
- `400 Bad Request`: `paragraphNumber` is not an integer
- `404 Not Found`: Book not found, or page does not belong to this book

---

### GET /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments

Retrieves all comments scoped to a specific paragraph of a page. Convenience route equivalent to `GET /api/books/:id/pages/:pageId/comments?paragraphNumber=N`.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `id` (string, required): Book ID
- `pageId` (string, required): Page ID
- `paragraphNumber` (number, required): 1-based paragraph number

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Comments per page (default: 20)

**Response (200 OK):** Same shape as `GET /api/books/:id/comments`.

**Error Responses:**
- `400 Bad Request`: `paragraphNumber` is not a positive integer
- `404 Not Found`: Book not found, or page does not belong to this book

---

### POST /api/books/:id/comments

Creates a new comment on a book. Supports threaded comments via `parentCommentId`, and can be scoped to a specific page and/or paragraph via `pageId` and `paragraphNumber`.

When `pageId` is provided it must belong to the book. When `paragraphNumber` is provided, `pageId` is required. Replies (`parentCommentId`) must live in the same page/paragraph scope as the parent comment.

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

```json
{
  "content": "Loved this page!",
  "pageId": "page456"
}
```

```json
{
  "content": "This paragraph was intense",
  "pageId": "page456",
  "paragraphNumber": 3
}
```

**Parameters:**
- `content` (string, required): Comment content (max 5000 chars)
- `parentCommentId` (string, optional): Parent comment ID for replies
- `pageId` (string, optional): Page ID when commenting on a specific page
- `paragraphNumber` (number, optional): 1-based paragraph number when commenting on a paragraph (requires `pageId`)

**Response (201 Created):**
```json
{
  "comment": {
    "id": "comment123",
    "userId": "user456",
    "name": "John Doe",
    "imageUrl": "https://example.com/avatar.jpg",
    "bookId": "book123",
    "pageId": null,
    "paragraphNumber": null,
    "parentCommentId": null,
    "content": "This story is amazing!",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid content, `paragraphNumber` without `pageId`, or `paragraphNumber` not a positive integer
- `404 Not Found`: Book not found, page not found, parent comment not found
- `403 Forbidden`: Parent comment belongs to a different book/page/paragraph

---

### POST /api/books/:id/pages/:pageId/comments

Creates a new comment on a specific page of a book. Supports threaded replies (via `parentCommentId`) and paragraph-level scoping via `paragraphNumber`. The `pageId` in the path is authoritative; any `pageId` in the body is ignored.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID
- `pageId` (string, required): Page ID

**Request Body:**
```json
{
  "content": "Loved this page!"
}
```

```json
{
  "content": "This paragraph was intense",
  "paragraphNumber": 3
}
```

**Parameters:**
- `content` (string, required): Comment content (max 5000 chars)
- `parentCommentId` (string, optional): Parent comment ID for replies
- `paragraphNumber` (number, optional): 1-based paragraph number within the page

**Response (201 Created):** Same shape as `POST /api/books/:id/comments` (with `pageId` set from the path).

**Error Responses:**
- `400 Bad Request`: Invalid content, or `paragraphNumber` not a positive integer
- `404 Not Found`: Book not found, page not found, parent comment not found
- `403 Forbidden`: Parent comment belongs to a different book/page/paragraph

---

### POST /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments

Creates a new comment on a specific paragraph of a page. Supports threaded replies (via `parentCommentId`). The `pageId` and `paragraphNumber` in the path are authoritative.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID
- `pageId` (string, required): Page ID
- `paragraphNumber` (number, required): 1-based paragraph number

**Request Body:**
```json
{
  "content": "This paragraph was intense"
}
```

**Parameters:**
- `content` (string, required): Comment content (max 5000 chars)
- `parentCommentId` (string, optional): Parent comment ID for replies

**Response (201 Created):** Same shape as `POST /api/books/:id/comments` (with `pageId` and `paragraphNumber` set from the path).

**Error Responses:**
- `400 Bad Request`: Invalid content, or `paragraphNumber` not a positive integer
- `404 Not Found`: Book not found, page not found, parent comment not found
- `403 Forbidden`: Parent comment belongs to a different book/page/paragraph

---

### PUT /api/books/comments/:id

Updates a comment. Only the original author can update their own comments.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Comment ID

**Request Body:**
```json
{
  "content": "Updated comment content"
}
```

**Parameters:**
- `content` (string, required): Updated comment content (max 5000 chars)

**Response (200 OK):**
```json
{
  "comment": {
    "id": "comment123",
    "userId": "user456",
    "bookId": "book123",
    "pageId": "page456",
    "paragraphNumber": 3,
    "parentCommentId": null,
    "content": "Updated comment content",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Content is required
- `403 Forbidden`: Not the comment author
- `404 Not Found`: Comment not found

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

## Book Testimonials

User-submitted testimonials (ratings + written feedback) for books. These live in the dedicated `bookTestimonials` table and are curated separately from the social-mention ingestion pipeline.

**Author fields:** Every testimonial response includes the author's public profile fields, joined from the `users` table — exactly like book comments:

- `name` (string): The author's display name.
- `imageUrl` (string | null): The author's avatar URL (null if the user has no avatar or was deleted).

**Status lifecycle:** New testimonials default to `pending`. Only `approved` testimonials are visible to the public. Editing a testimonial resets it back to `pending` and clears its `featured` flag so it can be re-curated by an admin.

**Visibility rules:**
- Public (`optionalAuth`) list/get endpoints return only `approved` testimonials.
- The book owner or the testimonial author may view any status.
- `featured` (boolean) can be used to surface curated highlights; pass `?featured=true` to the list endpoint.

**List pagination:** Both list endpoints (`GET /api/books/testimonials` and `GET /api/books/:identifier/testimonials`) support cursor-free page/limit pagination and return a wrapped `{ testimonials: [...], pagination }` shape — identical to the book comments endpoints. Use the `page` and `limit` query params for lazy loading and check `pagination.hasNext` to decide whether to fetch the next page.

### GET /api/books/testimonials

Returns the authenticated user's own testimonials across all books. Supports pagination for lazy loading (returns the same wrapped shape as book comments).

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `page` (number, optional): 1-based page (default: 1)
- `limit` (number, optional): Testimonials per page (default: 20, max: configured maximum)

**Response (200 OK):**
```json
{
  "testimonials": [
    {
      "id": "uuid",
      "userId": "uuid",
      "bookId": "uuid",
      "name": "John Doe",
      "imageUrl": "https://example.com/avatar.jpg",
      "rating": 5,
      "content": "Couldn't put it down.",
      "status": "approved",
      "featured": false,
      "createdAt": "2026-07-19T12:00:00.000Z",
      "updatedAt": "2026-07-19T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 1,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `401 Unauthorized`: Missing or invalid authentication

### GET /api/books/:identifier/testimonials

Lists testimonials for a specific book. Public viewers see only `approved` testimonials; the book owner sees all statuses. Supports pagination for lazy loading (returns the same wrapped shape as book comments).

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or ID

**Query Parameters:**
- `page` (number, optional): 1-based page (default: 1)
- `limit` (number, optional): Testimonials per page (default: 20, max: configured maximum)
- `featured` (string, optional): When `"true"`, only featured testimonials are returned

**Response (200 OK):**
```json
{
  "testimonials": [
    {
      "id": "uuid",
      "userId": "uuid",
      "bookId": "uuid",
      "name": "Jane Doe",
      "imageUrl": "https://example.com/avatar2.jpg",
      "rating": 4,
      "content": "A gripping psychological thriller.",
      "status": "approved",
      "featured": true,
      "createdAt": "2026-07-18T09:30:00.000Z",
      "updatedAt": "2026-07-18T09:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 1,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `404 Not Found`: Book not found

### POST /api/books/:identifier/testimonials

Creates a testimonial for a book. New testimonials are `pending` and not featured until curated.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or ID

**Request Body:**
```json
{
  "rating": 5,
  "content": "One of the best twist endings I've read."
}
```

**Field Rules:**
- `content` (string, required): Non-empty, at most 5000 characters
- `rating` (number, optional): Integer between 1 and 5

**Response (201 Created):**
```json
{
  "testimonial": {
      "id": "uuid",
      "userId": "uuid",
      "bookId": "uuid",
      "name": "John Doe",
      "imageUrl": "https://example.com/avatar.jpg",
      "rating": 5,
      "content": "One of the best twist endings I've read.",
    "status": "pending",
    "featured": false,
    "createdAt": "2026-07-19T12:00:00.000Z",
    "updatedAt": "2026-07-19T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing/empty `content`, or `rating` out of range
- `401 Unauthorized`: Missing or invalid authentication
- `404 Not Found`: Book not found

### GET /api/books/:identifier/testimonials/:id

Retrieves a single testimonial. Owners of the testimonial or the book may view any status; other viewers may only view `approved` testimonials.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or ID
- `id` (string, required): Testimonial ID

**Response (200 OK):**
```json
{
  "testimonial": {
      "id": "uuid",
      "userId": "uuid",
      "bookId": "uuid",
      "name": "Jane Doe",
      "imageUrl": "https://example.com/avatar2.jpg",
      "rating": 4,
      "content": "A gripping psychological thriller.",
      "status": "approved",
      "featured": true,
      "createdAt": "2026-07-18T09:30:00.000Z",
      "updatedAt": "2026-07-18T09:30:00.000Z"
  }
}
```

**Error Responses:**
- `404 Not Found`: Book or testimonial not found (or testimonial not `approved` for non-privileged viewers)

### PATCH /api/books/:identifier/testimonials/:id

Updates a testimonial. Only the testimonial author may update it. Editing resets `status` to `pending` and clears `featured`.

**Authentication:** Required (via `requireAuth`, owner only)

**Path Parameters:**
- `identifier` (string, required): Book slug or ID
- `id` (string, required): Testimonial ID

**Request Body (all fields optional):**
```json
{
  "rating": 5,
  "content": "Updated thoughts after a re-read."
}
```

**Field Rules:**
- `content` (string, optional): Non-empty, at most 5000 characters
- `rating` (number, optional): Integer between 1 and 5

**Response (200 OK):**
```json
{
  "testimonial": {
      "id": "uuid",
      "userId": "uuid",
      "bookId": "uuid",
      "name": "John Doe",
      "imageUrl": "https://example.com/avatar.jpg",
      "rating": 5,
      "content": "Updated thoughts after a re-read.",
    "status": "pending",
    "featured": false,
    "createdAt": "2026-07-18T09:30:00.000Z",
    "updatedAt": "2026-07-19T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid `content` or `rating`
- `403 Forbidden`: Not the testimonial author
- `404 Not Found`: Book or testimonial not found

### DELETE /api/books/:identifier/testimonials/:id

Deletes a testimonial. Only the testimonial author may delete it.

**Authentication:** Required (via `requireAuth`, owner only)

**Path Parameters:**
- `identifier` (string, required): Book slug or ID
- `id` (string, required): Testimonial ID

**Response (200 OK):**
```json
{
  "message": "Testimonial deleted successfully"
}
```

**Error Responses:**
- `403 Forbidden`: Not the testimonial author
- `404 Not Found`: Book or testimonial not found

---

## Exploration

### GET /api/books/explore

Retrieves books for exploration or user's own creations. Supports both authenticated and unauthenticated users. Includes search, filtering, and pagination capabilities.

**Authentication:** Optional (via `optionalAuth`)

**Query Parameters:**
- `page` (number, optional): Page number for pagination (default: 1)
- `limit` (number, optional): Number of books per page (default: 20)
- `search` (string, optional): Search query for title, hook, summary, keywords
- `language` (string, optional): Filter by language code (e.g., "en", "es")
- `tags` (string, optional): Comma-separated tags for filtering (e.g., "thriller,mystery,horror"). Books matching ANY tag will be included (OR logic)
- `ageRange` (string, optional): Filter by main character age range (format: n-m, e.g. 18-30)
- `sortBy` (string, optional): Field to sort by (default: newest). Options: newest, popular, trending, top-picks, originals, reads, recommendations, creations, favorites
- `sortOrder` (string, optional): Sort direction (default: desc)
- `lastUpdated` (string, optional): Filter by last update time: anytime|today|this-week|this-month|this-year
- `status` (string, optional): Filter by comma-separated statuses (only applies with `sortBy=creations`). Values: active, draft, archived. E.g., "active,draft"
- `mode` (string, optional): Filter by book creation mode (story format). Values: `novel`, `interactive`, `multiverse`. E.g., "multiverse"
- `profileUserId` (string, optional): User ID to scope books to — used with `sortBy=creations`, `sortBy=reads`, or `sortBy=favorites` to view another user's authored/read/favorited books. When set, authentication is not required for those sort options. Cache is skipped when `profileUserId` is used.
- `userId` (string, optional): Alias for `profileUserId`. When set, filters books by the given user's authorship (works with any `sortBy`, not just `creations`).

**Shared Implementation:**
- Uses same filter building helpers as GET /api/books (buildSearchCondition, buildTagsFilterCondition, combineFilterConditions)
- Consistent query structure and pagination pattern
- Same enriched book data format with author info and engagement metrics
- Unified caching strategy with TTL based on sort option

**Behavior by `sortBy`:**
- `creations`: Shows the authenticated user's own books (requires auth). Use `status` query param to filter by book status — `status=draft` includes pending, generating, failed, and cancelled generations. Check each book's `generationStatus` via `GET /api/books/:bookId/status` to see its exact state.
- `reads`: Shows books the authenticated user has read, sorted by `lastReadAt` (requires auth unless `profileUserId` is set).
- `favorites`: Shows books the authenticated user has favorited/saved (requires auth unless `profileUserId` is set).
- `recommendations` / `for-you`: Always require authentication — not scoped by `profileUserId`.
- All other sort options: Show published books only (optional auth, status filter ignored).

**`profileUserId` / `userId` behavior:**
- When `profileUserId` is set with `sortBy=creations`, shows books authored by that user (no auth required). Equivalent to filtering by `books.userId`.
- When `profileUserId` is set with `sortBy=reads`, shows books read by that user (no auth required).
- When `profileUserId` is set with `sortBy=favorites`, shows books favorited by that user (no auth required).
- `userId` acts as a generic author filter that works with any `sortBy`.

**Example — View another user's creations:**
```
GET /api/books/explore?sortBy=creations&profileUserId=user456
```

**Example — View another user's reads:**
```
GET /api/books/explore?sortBy=reads&profileUserId=user456
```

**Example — View another user's favorites:**
```
GET /api/books/explore?sortBy=favorites&profileUserId=user456
```

**Example — Find all draft books (cancelled, failed, pending):**
```
GET /api/books/explore?sortBy=creations&status=draft&page=1&limit=20
```

**Example — Filter published books by mode:**
```
GET /api/books/explore?mode=multiverse&sortBy=trending&page=1&limit=20
```

**Example — Combine mode filter with other filters:**
```
GET /api/books/explore?mode=interactive&language=en&ageRange=18-30&tags=thriller,mystery&sortBy=newest
```

**Response (200 OK) — Published books (explore):**
```json
{
  "books": [
    {
      "id": "book123",
      "title": "The Whispering Halls",
      "hook": "Sarah never believed in ghosts until she found the diary",
      "summary": "A psychological thriller about a librarian...",
      "imageUrl": "https://example.com/cover.jpg",
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
        "imageUrl": "https://example.com/avatar.jpg"
      },
      "stats": {
        "likesCount": 42,
        "readCount": 156,
        "commentsCount": 25,
        "testimonialsCount": 7,
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

### POST /api/books/workflow-webhook

Internal webhook for GitHub Actions workflow to notify completion/failure of async book creation. Secured by `INTERNAL_SECRET` header.

**Authentication:** Internal (via `x-internal-secret` header)

**Headers:**
- `x-internal-secret` (string, required): Internal secret for webhook authentication

**Request Body:**
```json
{
  "bookId": "01912345-6789-1234-5678-123456789012",
  "status": "completed",
  "error": null,
  "step": "completed"
}
```

**Response (200 OK):**
```json
{
  "ok": true
}
```

**Error Responses:**
- `403 Forbidden`: Invalid or missing internal secret

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

All endpoints follow consistent error response formats. Most errors use the `handleApiError` utility which includes `success: false`:

**Standard Error Response:**
```json
{
  "error": "Error message description"
}
```

**Validation Error Response:**
```json
{
  "error": "Validation error message"
}
```

**Not Found Error Response:**
```json
{
  "error": "Resource not found"
}
```

**Forbidden Error Response:**
```json
{
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
  "ending" jsonb,
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

### v2.12.0 (2026-08-02)
- **Added `testimonialsCount` to `BookStats`** — `books.testimonials_count` denormalized column counted from `book_testimonials` and maintained by a database trigger (`AFTER INSERT OR DELETE ON book_testimonials`), mirroring `commentsCount`. The field is now returned in the `stats` object of enriched book responses (`GET /api/books/:identifier`, explore, similar books, user library).

### v2.11.0 (2026-07-16)
- **Fully documented all Books API routes** — added complete documentation for every endpoint missing from the spec:
  - **Book Management**: `GET /api/books` (user library), `GET /api/books/generations/active`, `PATCH /:id/visibility`, `PATCH /:id/archive`, `POST /:identifier/purchase`
  - **Book Reading**: `POST /:identifier/:pageId/confirm-visit`, `GET /:identifier/branches`, `POST /:identifier/:pageId/actions/hint`
  - **Comments**: `GET /api/books/comments` (user's own), `PUT /api/books/comments/:id`
  - **Social Interactions**: `POST /:identifier/:pageId/share`, `GET /share/:username/:bookSlug/:pageId`
  - **Custom Actions**: `POST /:identifier/:pageId/custom-actions/preview`, `POST /:identifier/:pageId/custom-actions/submit`
  - **Psychological Features**: `GET /:identifier/psychological-profile`, `GET /:identifier/locked-paths`
- **Rewrote overview JSDoc** in `books.ts` to enumerate all 30+ routes grouped by category
- **Updated Table of Contents** to include all newly documented sections with anchor links

### v2.10.0 (2026-07-16)
- **Added `PATCH /api/books/favorites/rename-collection`** — renames a collection across all of the authenticated user's favorites. Updates every row in `user_favorites` matching `oldCollection` to `newCollection`. Returns the count of affected rows.

### v2.9.0 (2026-07-14)
- **Updated `PUT /api/books/:id`** — now accepts `mc` (full MC object with avatar image upload) and `ending` (author-edited ending JSONB) fields alongside existing metadata
- **MC avatar upload** — `mc.imageUrl` triggers upload to ImageKit's `book-characters` folder; response includes `mcAvatarUploaded` boolean. Upload is persisted to `uploaded_images` table with `type: 'mc'` for audit and cron-based cleanup
- **Ending column** — added `ending: jsonb` column to `books` table; accepts `Ending` type with `text`, `type`, `outline`, and `changeNote`
- **Text field sanitisation** — `title`, `hook`, `summary` are now sanitised via `sanitizeBookTextField` (XSS stripping, double-quote normalisation); empty-string values are treated as "not provided" (field retained)
- **Keyword sanitisation** — `keywords` are sanitised via `sanitizeKeywords` before storage
- **Ending type** — added `Ending` type definition to the documentation with `text`, `type`, `outline`, and `changeNote` fields

### v2.8.0 (2026-07-08)
- **Cancel is now retryable**: `POST /api/books/:bookId/cancel` preserves the draft book row instead of deleting it. Cancelled generations remain in the user's library with a "cancelled" badge and can be retried via `POST /api/books/:bookId/retry`.
- **Retry accepts cancelled**: `POST /api/books/:bookId/retry` now accepts `cancelled` generations alongside `failed`. Credits are re-consumed atomically since the original deduction was refunded on cancellation.

### v2.7.0 (2026-07-06)
- Added `POST /api/books/:bookId/cancel` — cancels a pending/failed async book generation, refunds credits on a pro-rata basis, and deletes the draft book row
- Added `POST /api/books/:bookId/retry` — retries a failed async book generation by resetting `generationStatus` to `pending`, clearing error state, and re-dispatching the GitHub Actions workflow
- No additional credit consumption on retry (original deduction is preserved)

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
- Cache is skipped when `profileUserId` or `userId` query param is used (always fetches fresh data)

---

## Rate Limiting

Rate limits are enforced on a per-user basis to prevent abuse:

- GET endpoints: 100 requests per minute
- POST/PUT/DELETE endpoints: 50 requests per minute
- SSE streaming endpoint: 5 concurrent connections per user

---

## Version History

### v1.5.0 (2026-07-21)
- Added `profileUserId` and `userId` query params to GET /api/books/explore for viewing another user's creations, reads, and favorites
- Updated `sortBy=creations`, `sortBy=reads`, `sortBy=favorites` to work without auth when `profileUserId` is set
- Added `favorites` to the documented `sortBy` options list
- Cache is skipped when `profileUserId` or `userId` is used to ensure fresh data for profile views

### v1.4.0 (2026-05-05)
- Added lastUpdated query parameter to GET /api/books for time-based filtering (anytime|today|this-week|this-month|this-year)
- Created shared filter building helpers in book-controller.ts (buildTimeFilterCondition, buildLanguageFilterCondition, buildSearchCondition, buildTagsFilterCondition, combineFilterConditions)
- Refactored GET /api/books to use shared filter helpers for DRY code
- Refactored GET /api/books/explore to use shared filter helpers for consistency
- Updated pagination utils to support lastUpdated and language parameters
- Added 'transactions' to ResourceName type for payments API consistency
- Unified query building logic across book list endpoints for maintainability

### v1.3.0 (2026-04-24)
- Added `EnrichedBookSession` type definition (previously referenced but undocumented)
- Replaced the numeric-max `furthestPage*` cursor with a **branch-aware active-tip frontier** (`frontierPageId`, `frontierPageNumber`, `frontierAncestorIds`). The frontier advances on forward progress or a different branch and is preserved on back-navigation — correct for interactive/multiverse branching stories.
- `setActiveSession` now applies the frontier rule (touched page's `actionsHistory` pageIds + own id) on every session update, and the `POST /.../:pageId/touch` heartbeat routes through it as the single source of truth
- `frontierPageNumber` is documented as a **display hint only** (not for comment gating); `lastPageId` remains the resume target
- Updated `GET /api/books/:identifier` example to show a populated `session` object with the frontier fields
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
