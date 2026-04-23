# Books API Documentation

## Overview

The Books API provides endpoints for managing psychological thriller books, including creation, reading, social interactions (likes, favorites, comments), and exploration. All endpoints support both authenticated users and guest users where applicable.

**Base URL:** `/api/books`

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies. Guest users can access read-only endpoints and create books (guest data migrates on login).

---

## Table of Contents

1. [Book Management](#book-management)
   - [Create Book](#post-apibooks)
   - [Create Book with SSE](#post-apibooksstream)
   - [Get User's Books](#get-apibooks)
   - [Get Book by ID](#get-apibooksidentifier)
   - [Update Book](#put-apibooksid)
   - [Delete Book](#delete-apibooksid)
2. [Book Reading](#book-reading)
   - [Generate New Pages](#post-apibooksidentifiergenerate)
   - [Get Specific Page](#get-apibooksidentifierbranchidpage)
   - [Start Reading Session](#post-apibooksidsessions)
3. [Social Interactions](#social-interactions)
   - [Like Book](#post-apibooksidlike)
   - [Unlike Book](#delete-apibooksidlike)
   - [Favorite Book](#post-apibooksidfavorite)
   - [Unfavorite Book](#delete-apibooksidfavorite)
4. [Comments](#comments)
   - [Get Book Comments](#get-apibooksidcomments)
   - [Create Comment](#post-apibooksidcomments)
   - [Delete Comment](#delete-apicommentsid)
5. [Exploration](#exploration)
   - [Explore Books](#get-apibooksexplore)
   - [Get Book Stats](#get-apibooksstats)
6. [Utilities](#utilities)
   - [Generate Book Prompt](#get-apibooksprompt)
   - [Insert Book (Test)](#post-apibooksinsert)

---

## Book Management

### POST /api/books

Creates a new psychological thriller book with AI-generated content. Accepts a story theme and optional main character details. The AI generates the book's title, hook, summary, first page, and initial story state.

**Authentication:** Guest or Authenticated (via `guestOrAuthMiddleware`)

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
    "slug": "the-whispering-halls",
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
- `401 Unauthorized`: Authentication required (if auth enforced)
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

**Authentication:** Guest or Authenticated (via `guestOrAuthMiddleware`)

**Request Body:** Same as `POST /api/books`

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

event: finalizing_start
data: {}

event: complete
data: {"book":{...},"firstPage":{...},...}

event: error
data: {"error":"Theme validation failed"}
```

**Response:** SSE stream (text/event-stream)

---

### GET /api/books

Retrieves all books for the authenticated user. Returns paginated list with metadata and reading progress. Supports search and sorting.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Items per page (default: 10)
- `search` (string, optional): Search query for title, hook, summary
- `sortBy` (string, optional): Field to sort by (default: updatedAt)
- `sortOrder` (string, optional): Sort direction (asc/desc, default: desc)

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
      "isLiked": true,
      "isRead": true,
      "lastReadAt": "2023-01-15T10:30:00.000Z",
      "lastPage": "page789",
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

### POST /api/books/:identifier/generate

Generates new story pages based on user actions or continuation. Accepts action text string which is matched against current page actions to get the full Action object.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7

**Request Body:**
```json
{
  "actionText": "Investigate the noise",
  "currentPageId": "page456",
  "branchId": "main"
}
```

**Parameters:**
- `actionText` (string, required): Action text to match
- `currentPageId` (string, optional): Current page ID for validation
- `branchId` (string, optional): Current branch ID for validation

**Response (201 Created):**
```json
{
  "page": {
    "id": "page789",
    "page": 2,
    "text": "The noise came from behind the bookshelf...",
    "mood": "tense",
    "place": "library",
    "timeOfDay": "night",
    "actions": [
      {
        "text": "Open the bookshelf",
        "type": "explore",
        "hint": {
          "text": "A hidden passage awaits",
          "type": "dark_discovery"
        },
        "navigation": {
          "bookId": "book123",
          "branchId": "main",
          "page": 3
        }
      }
    ],
    "createdAt": "2023-01-01T00:01:00.000Z"
  },
  "currentPage": "page789"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid actionText, validation failed
- `403 Forbidden`: Not the book owner
- `404 Not Found`: Book not found

---

### GET /api/books/:identifier/:branchId/:page

Retrieves a specific page within a branch of a book. Accepts both slug and UUID v7 as identifier.

**Authentication:** Optional (via `optionalAuth`)

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `branchId` (string, required): Branch identifier (e.g., "main", "abc123")
- `page` (number, required): Page number within the branch

**Response (200 OK):**
```json
{
  "page": {
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
        },
        "navigation": {
          "bookId": "book123",
          "branchId": "main",
          "page": 2
        }
      }
    ],
    "createdAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls",
    "slug": "the-whispering-halls",
    "totalPages": 120
  }
}
```

**Error Responses:**
- `404 Not Found`: Book or page not found

---

### POST /api/books/:id/sessions

Creates or updates a reading session for the book. Tracks reading progress and manages active sessions.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): Book ID

**Request Body:**
```json
{
  "pageId": "page456"
}
```

**Parameters:**
- `pageId` (string, required): Current page ID in reading session

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
- `400 Bad Request`: Missing pageId, no active session found (if validating)
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
    "totalCount": 42,
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

### DELETE /api/comments/:id

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

Retrieves all published books for exploration. Supports both guest and authenticated users. Includes search, filtering, and pagination capabilities.

**Authentication:** Optional (via `optionalAuth`)

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Books per page (default: 20)
- `search` (string, optional): Search query for title, summary, keywords
- `sortBy` (string, optional): Sort option: popular, newest, trending, top-picks (default: newest)

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

---

## Rate Limiting

Most endpoints are rate-limited to prevent abuse:
- **Authenticated endpoints**: User-based rate limiting via Upstash Redis
- **Unauthenticated endpoints**: IP-based rate limiting via LRU cache (5 attempts/minute default)
- **Book creation**: Limited to prevent spam
- **Comment creation**: Limited to prevent spam

---

## Caching

The API implements multi-level caching for performance:
- **Redis caching**: User books, explore page 1, user profiles
- **HTTP caching**: Explore endpoint supports CDN caching with Cache-Control headers
- **Cache invalidation**: Automatic invalidation on book updates, likes, favorites, comments

**Cache TTLs:**
- User books: 5 minutes
- Explore page 1: 1 minute
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
  "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active',
  "mc" jsonb NOT NULL,
  "likes_count" integer DEFAULT 0 NOT NULL,
  "read_count" integer DEFAULT 0 NOT NULL,
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

**Like a book:**
```bash
curl -X POST https://api.twistloom.com/api/books/book123/like \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Favorite a book:**
```bash
curl -X POST https://api.twistloom.com/api/books/book123/favorite \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Create a comment:**
```bash
curl -X POST https://api.twistloom.com/api/books/book123/comments \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "content": "This story is amazing!"
  }'
```

---

## Changelog

### v1.0.0 (2023-01-01)
- Initial book API implementation
- Book CRUD operations
- Page generation and reading
- Session management
- Explore endpoint with search and filtering

### v1.1.0 (2023-04-23)
- Added like/unlike book endpoints
- Added favorite/unfavorite book endpoints
- Added comment CRUD endpoints
- Enhanced documentation with comprehensive API reference
