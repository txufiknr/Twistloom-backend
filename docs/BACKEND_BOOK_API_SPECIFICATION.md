# Backend Book API Specification

## Overview

This document specifies the complete Book API for the Twistloom backend. All endpoints follow a simplified internal API pattern for consistency.

**Response Pattern:**
- GET endpoints (single resource): Return resource wrapped in `{ data }` (e.g., `{ data: {...} }`)
- GET endpoints (collections): Return resources wrapped in `{ items }` (e.g., `{ items: [...] }`)
- GET endpoints (pagination): Return `{ items, pagination }`
- POST endpoints: Return created resource with 201 status wrapped in `{ data }` (e.g., `{ data: {...} }`)
- PUT endpoints: Return updated resource with 200 status wrapped in `{ data }` (e.g., `{ data: {...} }`)
- DELETE endpoints: Return simple messages or operation metadata (e.g., `{ message: "..." }`)

**Authentication:**
Most endpoints require authentication via NextAuth session cookies. Public endpoints are explicitly marked.

---

## Type Definitions

### Book

Book information with enriched fields.

```typescript
interface Book {
  id: string;                  // Book's unique identifier (UUID)
  title: string;               // Book title
  hook?: string;               // Hook/description
  description?: string;        // Full description
  theme?: string;              // Story theme
  coverImage?: string;         // Cover image URL
  userId: string;              // Author's user ID
  author?: {
    id: string;
    name?: string;
    username?: string;
    image?: string;
  };
  status: 'active' | 'draft' | 'archived';
  totalPages?: number;         // Total pages in book
  createdAt: string;           // Creation timestamp (ISO 8601)
  updatedAt: string;           // Last update timestamp (ISO 8601)
}
```

### Page

Story page with actions and metadata.

```typescript
interface Page {
  id: string;                  // Page's unique identifier
  bookId: string;              // Book ID
  branchId: string;            // Branch identifier
  page: number;                // Page number
  content: string;             // Page content
  actions: Action[];           // Available actions
  createdAt: string;           // Creation timestamp (ISO 8601)
  updatedAt: string;           // Last update timestamp (ISO 8601)
}

interface Action {
  id: string;
  text: string;
  nextBranchId?: string;
  nextPage?: number;
  isUserAction: boolean;
}
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
  createdAt: string;           // Creation timestamp (ISO 8601)
  updatedAt: string;           // Last update timestamp (ISO 8601)
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

---

## Endpoints

### POST /books

Create a new book with AI-generated story.

**Authentication:** Guest or authenticated (guestOrAuthMiddleware)

**Request Body:**
```json
{
  "theme": "space adventure",
  "mcCandidate": "Maya",
  "generateCoverImage": true
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "data": {
    "book": {
      "id": "uuid",
      "title": "The Lost Colony",
      "hook": "A mysterious signal from Mars...",
      "theme": "space adventure",
      "coverImage": "https://...",
      "userId": "user-uuid",
      "author": {
        "id": "user-uuid",
        "name": "John Doe",
        "username": "johndoe",
        "image": "https://..."
      },
      "status": "active",
      "totalPages": 50,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    },
    "firstPage": {
      "id": "page-uuid",
      "bookId": "book-uuid",
      "branchId": "main",
      "page": 1,
      "content": "...",
      "actions": [...]
    },
    "initialState": {
      "mc": {
        "name": "Maya",
        "age": 19,
        "gender": "female",
        "bio": "A skeptic with a habit of lying to herself..."
      }
    },
    "session": {
      "id": "session-uuid",
      "userId": "user-uuid",
      "bookId": "book-uuid",
      "pageId": "page-uuid",
      "status": "active",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

---

### POST /books/insert

Insert a book into the database (admin/internal use).

**Authentication:** Required

**Request Body:**
```json
{
  "title": "The Lost Colony",
  "theme": "space adventure",
  "hook": "A mysterious signal from Mars...",
  "description": "Full description..."
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "title": "The Lost Colony",
    "theme": "space adventure",
    "userId": "user-uuid",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### GET /books/prompt

Generates a creative book creation prompt using AI streaming.

**Authentication:** Optional (optionalAuth)

**Request Body:**
```json
{
  "theme": "space adventure",
  "mcCandidate": "Maya"
}
```

**Response:** Server-Sent Events (SSE) stream

**Event Stream Format:**
```
event: chunk
data: {"type":"chunk","content":" mysterious online community","done":false}

event: end
data: {"type":"end","provider":"gemini","model":"gemini-2.5-flash"}
```

---

### GET /books

Get authenticated user's books with pagination.

**Authentication:** Required

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Items per page (default: 20)
- `search` (string, optional): Search query
- `sortBy` (string, optional): Sort field (default: updatedAt)
- `sortOrder` (string, optional): Sort direction (default: desc)

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "title": "The Lost Colony",
      "hook": "A mysterious signal from Mars...",
      "coverImage": "https://...",
      "status": "active",
      "totalPages": 50,
      "lastReadAt": "2024-01-01T00:00:00.000Z",
      "lastPage": "page-uuid"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 45,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

### PUT /books/:id

Update book information.

**Authentication:** Required

**Request Body:**
```json
{
  "title": "Updated Title",
  "hook": "Updated hook",
  "description": "Updated description",
  "imageUrl": "https://example.com/image.jpg"
}
```

**Multipart Form Data (for file upload):**
```
Content-Type: multipart/form-data

imageFile: <file>
title: Updated Title
hook: Updated hook
```

**Response:**
```json
{
  "data": {
    "id": "uuid",
    "title": "Updated Title",
    "hook": "Updated hook",
    "description": "Updated description",
    "coverImage": "https://...",
    "coverImageId": "imagekit-file-id",
    "updatedAt": "2024-01-01T12:00:00.000Z"
  },
  "imageUploaded": true,
  "uploadSource": "file",
  "oldImageQueuedForDeletion": false
}
```

**Metadata Fields:**
- `imageUploaded`: Boolean indicating if image was uploaded
- `uploadSource`: Upload method used (`"file"`, `"base64"`, `"url"`, or `null`)
- `oldImageQueuedForDeletion`: Boolean indicating if old image was queued for deletion

---

### POST /books/:identifier/generate

Generate a new page for a book based on user action.

**Authentication:** Required

**Path Parameters:**
- `identifier` (string): Book slug or UUID

**Request Body:**
```json
{
  "actionText": "Investigate the signal",
  "currentPageId": "page-uuid",
  "branchId": "main"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "data": {
    "id": "new-page-uuid",
    "bookId": "book-uuid",
    "branchId": "branch-uuid",
    "page": 2,
    "content": "The signal grows stronger as you approach...",
    "actions": [
      {
        "id": "action-uuid",
        "text": "Continue investigating",
        "nextBranchId": "branch-uuid",
        "nextPage": 3,
        "isUserAction": true
      }
    ],
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "currentPage": "new-page-uuid"
}
```

---

### GET /books/:identifier/:branchId/:page

Get a specific page within a branch of a book.

**Authentication:** Optional (optionalAuth)

**Path Parameters:**
- `identifier` (string): Book slug or UUID
- `branchId` (string): Branch identifier
- `page` (number): Page number

**Response:**
```json
{
  "data": {
    "id": "page-uuid",
    "bookId": "book-uuid",
    "branchId": "main",
    "page": 1,
    "content": "The signal begins...",
    "actions": [
      {
        "id": "action-uuid",
        "text": "Investigate",
        "nextBranchId": "branch-uuid",
        "nextPage": 2,
        "isUserAction": true
      }
    ],
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "bookId": "book-uuid",
  "bookTitle": "The Lost Colony",
  "bookSlug": "the-lost-colony"
}
```

---

### POST /books/:id/sessions

Create or update a reading session for the book.

**Authentication:** Required

**Path Parameters:**
- `id` (string): Book ID

**Request Body:**
```json
{
  "pageId": "page-uuid"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "data": {
    "id": "session-uuid",
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "pageId": "page-uuid",
    "previousPageId": "previous-page-uuid",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "bookId": "book-uuid",
  "bookTitle": "The Lost Colony",
  "bookSlug": "the-lost-colony"
}
```

---

### GET /books/explore

Get all published books for exploration (public endpoint).

**Authentication:** Optional (optionalAuth)

**Query Parameters:**
- `page` (number, optional): Page number (default: 1)
- `limit` (number, optional): Items per page (default: 20)
- `search` (string, optional): Search query for title, summary, keywords
- `sortBy` (string, optional): Sort field (default: updatedAt)
- `sortOrder` (string, optional): Sort direction (default: desc)

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "title": "The Lost Colony",
      "hook": "A mysterious signal from Mars...",
      "coverImage": "https://...",
      "likesCount": 150,
      "commentsCount": 25,
      "status": "active",
      "totalPages": 50,
      "author": {
        "id": "user-uuid",
        "name": "John Doe",
        "username": "johndoe",
        "image": "https://..."
      },
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

### DELETE /books/:id

Delete a book and all associated data.

**Authentication:** Required

**Path Parameters:**
- `id` (string): Book ID

**Response:**
```json
{
  "message": "Book deleted successfully",
  "bookId": "book-uuid",
  "imageQueuedForDeletion": true
}
```

---

## Error Responses

All endpoints use standard HTTP status codes for errors:

- `400 Bad Request`: Invalid request data
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Permission denied
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server error

**Error Response Format:**
```json
{
  "success": false,
  "error": "Error message describing the issue"
}
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

### v1.0.0 (2024-04-22)
- Initial API specification
- Implemented simplified internal API response pattern
- Single item responses use `{ data }`
- Collection responses use `{ items }`
- Pagination responses use `{ items, pagination }`
- Updated all book-related endpoints to follow new pattern
- Frontend updated to handle new response format
