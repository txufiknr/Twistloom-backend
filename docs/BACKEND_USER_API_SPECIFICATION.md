# Backend User API Specification

## Overview

This document specifies the complete User API for the Twistloom backend. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ user: {...} }`, `{ likes: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ user: {...} }`, `{ like: {...} }`)
- PUT endpoints: Return updated resources with 200 status (e.g., `{ user: {...} }`)
- DELETE endpoints: Return simple messages or operation metadata (e.g., `{ message: "..." }`)

**Authentication:**
Most endpoints require authentication via NextAuth session cookies. Public endpoints are explicitly marked.

---

## Type Definitions

### UserStats

User statistics for profile display.

```typescript
interface UserStats {
  booksCount: number;        // Number of books created by user
  readsCount: number;        // Number of reading sessions
  likedBooksCount: number;   // Number of books user liked
  savedBooksCount: number;   // Number of books saved to favorites
  followersCount: number;    // Number of followers
  likesReceived: number;     // Total likes received on user's books
}
```

### User

User profile information.

```typescript
interface User {
  id: string;                // User's unique identifier (UUID)
  email?: string | null;     // User's email address
  username?: string | null;  // User's unique username
  name?: string | null;      // User's display name
  bio?: string | null;       // User's bio/description
  image?: string | null;     // User's profile image URL
  isGuest?: boolean;         // Whether user is a guest
  stats?: UserStats;         // User statistics
  createdAt?: string;        // Account creation timestamp (ISO 8601)
  updatedAt?: string;        // Last update timestamp (ISO 8601)
}
```

### Like

User like record.

```typescript
interface Like {
  userId: string;            // User who created the like
  targetType: 'book' | 'comment' | 'user';  // Type of target
  targetId: string;          // ID of the liked item
  createdAt: string;         // Like creation timestamp (ISO 8601)
}
```

### Favorite

User favorite record.

```typescript
interface Favorite {
  userId: string;            // User who created the favorite
  bookId: string;            // ID of the favorited book
  createdAt: string;         // Favorite creation timestamp (ISO 8601)
}
```

### Comment

User comment record.

```typescript
interface Comment {
  id: string;                // Comment's unique identifier
  userId: string;            // User who created the comment
  bookId: string;            // ID of the book
  parentCommentId?: string;   // ID of parent comment (for replies)
  content: string;           // Comment content
  createdAt: string;         // Comment creation timestamp (ISO 8601)
  updatedAt: string;         // Last update timestamp (ISO 8601)
}
```

### Follow

User follow relationship.

```typescript
interface Follow {
  followerId: string;        // User who is following
  followingId: string;       // User being followed
  createdAt: string;         // Follow creation timestamp (ISO 8601)
}
```

---

## Endpoints

### GET /user

Get the authenticated user's profile with engagement statistics.

**Authentication:** Required

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "username": "john-doe",
    "name": "John Doe",
    "email": "john@example.com",
    "bio": "User bio",
    "image": "https://...",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "stats": {
      "booksCount": 10,
      "readsCount": 25,
      "likedBooksCount": 50,
      "savedBooksCount": 15,
      "followersCount": 100,
      "likesReceived": 500
    }
  }
}
```

---

### GET /users/:identifier

Get user profile by UUID or username (public endpoint).

**Authentication:** Not required

**Path Parameters:**
- `identifier` (string): User's UUID or username

**Behavior:**
- Validates if identifier is a valid UUID format
- If UUID: fetches user by UUID (server-side UUID-to-username resolution)
- If username: fetches user by username
- Returns user data with username for canonical URL

**Industry Standard:**
Major platforms (Twitter/X, Instagram, GitHub, LinkedIn) handle UUID-to-username resolution entirely on the backend with a single endpoint accepting both formats.

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "username": "john-doe",
    "name": "John Doe",
    "bio": "User bio",
    "image": "https://...",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "stats": {
      "booksCount": 10,
      "readsCount": 25,
      "likedBooksCount": 50,
      "savedBooksCount": 15,
      "followersCount": 100,
      "likesReceived": 500
    }
  }
}
```

**Example Requests:**
```
GET /users/123e4567-e89b-12d3-a456-426614174000
GET /users/john-doe
```

---

### POST /user

Create or fully replace user profile (upsert operation).

**Authentication:** Required

**Request Body:**
```json
{
  "name": "John Doe",
  "gender": "male"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "user": {
    "userId": "uuid",
    "name": "John Doe",
    "gender": "male",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### PUT /user

Partially update user profile. Only provided fields are updated.

**Authentication:** Required

**Request Body:**
```json
{
  "name": "John Doe",
  "bio": "User bio",
  "gender": "male",
  "imageUrl": "https://example.com/image.jpg"
}
```

**Multipart Form Data (for file upload):**
```
Content-Type: multipart/form-data

imageFile: <file>
name: John Doe
bio: User bio
```

**Response:**
```json
{
  "user": {
    "userId": "uuid",
    "name": "John Doe",
    "bio": "User bio",
    "gender": "male",
    "image": "https://...",
    "imageId": "imagekit-file-id",
    "createdAt": "2024-01-01T00:00:00.000Z",
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

### DELETE /user

Delete user profile and all associated data.

**Authentication:** Required

**Response:**
```json
{
  "message": "User account deleted successfully",
  "deletedRecords": {
    "userProfile": 1,
    "userFavorites": 15,
    "userLikes": 50,
    "userSessions": 25,
    "userDevices": 3,
    "userComments": 10
  },
  "imageQueuedForDeletion": true
}
```

---

### POST /user/likes

Like a target item (book, comment, or user).

**Authentication:** Required

**Request Body:**
```json
{
  "targetType": "book",
  "targetId": "book-uuid"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "like": {
    "userId": "user-uuid",
    "targetType": "book",
    "targetId": "book-uuid",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### DELETE /user/likes

Unlike a target item.

**Authentication:** Required

**Request Body:**
```json
{
  "targetType": "book",
  "targetId": "book-uuid"
}
```

**Response:**
```json
{
  "message": "Like removed successfully"
}
```

---

### GET /user/likes

Get user's likes with pagination.

**Authentication:** Required

**Query Parameters:**
- `limit` (number, optional): Number of items to return (default: 20)
- `offset` (number, optional): Number of items to skip (default: 0)
- `targetType` (string, optional): Filter by target type (`"book"`, `"comment"`, `"user"`)

**Response:**
```json
{
  "likes": [
    {
      "userId": "user-uuid",
      "targetType": "book",
      "targetId": "book-uuid",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /user/favorites

Add a book to favorites.

**Authentication:** Required

**Request Body:**
```json
{
  "bookId": "book-uuid"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "favorite": {
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### DELETE /user/favorites

Remove a book from favorites.

**Authentication:** Required

**Request Body:**
```json
{
  "bookId": "book-uuid"
}
```

**Response:**
```json
{
  "message": "Book removed from favorites successfully"
}
```

---

### GET /user/favorites

Get user's favorite books with pagination.

**Authentication:** Required

**Query Parameters:**
- `limit` (number, optional): Number of items to return (default: 20)
- `offset` (number, optional): Number of items to skip (default: 0)

**Response:**
```json
{
  "favorites": [
    {
      "userId": "user-uuid",
      "bookId": "book-uuid",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /user/comments

Create a comment on a book.

**Authentication:** Required

**Request Body:**
```json
{
  "bookId": "book-uuid",
  "content": "This story is amazing!",
  "parentCommentId": "comment-uuid"
}
```

**Response Status:** 201 Created

**Response:**
```json
{
  "comment": {
    "id": "comment-uuid",
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "parentCommentId": "comment-uuid",
    "content": "This story is amazing!",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### PUT /user/comments/:commentId

Update an existing comment (only by the original author).

**Authentication:** Required

**Request Body:**
```json
{
  "content": "Updated comment content"
}
```

**Response:**
```json
{
  "comment": {
    "id": "comment-uuid",
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "parentCommentId": "comment-uuid",
    "content": "Updated comment content",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### DELETE /user/comments/:commentId

Delete a comment (only by the original author).

**Authentication:** Required

**Response:**
```json
{
  "message": "Comment deleted successfully"
}
```

---

### GET /user/comments

Get user's comments with pagination.

**Authentication:** Required

**Query Parameters:**
- `limit` (number, optional): Number of items to return (default: 20)
- `offset` (number, optional): Number of items to skip (default: 0)
- `bookId` (string, optional): Filter comments by book ID

**Response:**
```json
{
  "comments": [
    {
      "id": "comment-uuid",
      "userId": "user-uuid",
      "bookId": "book-uuid",
      "parentCommentId": "comment-uuid",
      "content": "This story is amazing!",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /users/:id/follow

Follow a user.

**Authentication:** Required

**Path Parameters:**
- `id` (string): ID of the user to follow

**Response Status:** 201 Created

**Response:**
```json
{
  "follow": {
    "followerId": "user-uuid",
    "followingId": "target-user-uuid",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Behavior:**
- Prevents self-following
- Uses idempotent operation (returns existing follow if already following)
- Invalidates user profile cache for the followed user (followersCount changes)

---

### DELETE /users/:id/follow

Unfollow a user.

**Authentication:** Required

**Path Parameters:**
- `id` (string): ID of the user to unfollow

**Response:**
```json
{
  "message": "User unfollowed successfully"
}
```

**Behavior:**
- Invalidates user profile cache for the unfollowed user (followersCount changes)

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
  - `private, max-age=60, stale-while-revalidate=30` for authenticated user data
  - `public, max-age=60, stale-while-revalidate=30` for public user profiles

---

## Caching Strategy

- User profile data is cached with TTL of 60 seconds
- Cache is invalidated on profile updates, follows/unfollows, likes, and favorites
- Public user profiles use CDN/edge caching with stale-while-revalidate

---

## Rate Limiting

Rate limits are enforced on a per-user basis to prevent abuse:

- GET endpoints: 100 requests per minute
- POST/PUT/DELETE endpoints: 50 requests per minute

---

## Version History

### v1.0.0 (2024-04-22)
- Initial API specification
- Added UserStats with comprehensive engagement metrics
- Implemented follow/unfollow functionality
- Added bio field to user profiles
- Implemented GET /users/:identifier that accepts both UUID and username
- Updated all user-related endpoints to respond with direct resource objects or collections, removing `success` and `data` wrappers
- Maintained consistent error handling and cache invalidation
- Followed industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn)
- Response pattern: Single items use resource-specific keys (e.g., `{ user }`, `{ like }`), collections use resource-specific keys (e.g., `{ likes }`, `{ favorites }`)
