# Users API Documentation

## Overview

The Users API provides endpoints for managing user profiles, social interactions (likes, favorites, comments, follows), and user discovery. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Base URL:** `/user` for authenticated user operations, `/users` for public user operations

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies. Public endpoints allow guest access for user profile viewing.

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ user: {...} }`, `{ likes: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ user: {...} }`, `{ like: {...} }`)
- PUT endpoints: Return updated resources with 200 status (e.g., `{ user: {...} }`)
- DELETE endpoints: Return simple messages or operation metadata (e.g., `{ message: "..." }`)

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [User Profile Management](#user-profile-management)
   - [Get Authenticated User Profile](#get-user)
   - [Get User Profile by Identifier](#get-usersidentifier)
   - [Create/Replace User Profile](#post-user)
   - [Update User Profile](#put-user)
   - [Delete User Profile](#delete-user)
3. [Likes](#likes)
   - [Like Target](#post-userlikes)
   - [Unlike Target](#delete-userlikes)
   - [Get User Likes](#get-userlikes)
4. [Favorites](#favorites)
   - [Add Book to Favorites](#post-userfavorites)
   - [Remove Book from Favorites](#delete-userfavorites)
   - [Get User Favorites](#get-userfavorites)
5. [Comments](#comments)
   - [Create Comment](#post-usercomments)
   - [Update Comment](#put-usercommentscommentid)
   - [Delete Comment](#delete-usercommentscommentid)
   - [Get User Comments](#get-usercomments)
6. [Follows](#follows)
   - [Follow User](#post-usersidfollow)
   - [Unfollow User](#delete-usersidfollow)
   - [Get User Followers](#get-usersidfollowers)
   - [Get User Following](#get-usersidfollowing)
   - [Get Authenticated User's Followers](#get-userfollowers)
   - [Get Authenticated User's Following](#get-userfollowing)
7. [Daily Check-in](#daily-check-in)
   - [Get Check-in Status](#get-usercheckinstatus)
   - [Perform Daily Check-in](#post-usercheckin)
8. [Error Handling](#error-handling)
9. [HTTP Headers](#http-headers)
10. [Caching Strategy](#caching-strategy)
11. [Rate Limiting](#rate-limiting)
12. [Authentication](#authentication)
13. [Database Schema](#database-schema)
14. [Testing](#testing)
15. [Changelog](#changelog)

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

### CheckInStatus

Daily check-in status and history.

```typescript
interface CheckInStatus {
  canCheckIn: boolean;       // Whether user can check-in today
  lastCheckInDate: string | null;  // Last check-in date (YYYY-MM-DD) or null
  totalCheckIns: number;     // Total number of check-ins
  totalCreditsClaimed: number;     // Total credits claimed from check-ins
  recentCheckIns: CheckInRecord[];  // Recent check-in history (last 30 days)
}
```

### CheckInRecord

Individual check-in record.

```typescript
interface CheckInRecord {
  checkInDate: string;       // Check-in date (YYYY-MM-DD)
  creditsClaimed: number;    // Credits claimed for this check-in
  createdAt: string;         // Check-in creation timestamp (ISO 8601)
}
```

### CheckInResult

Result of performing daily check-in.

```typescript
interface CheckInResult {
  success: boolean;          // Whether check-in was successful
  creditsAwarded: number;   // Number of credits awarded (30 or 0 if already checked in)
  checkInDate: string;       // Check-in date in YYYY-MM-DD format
  message: string;           // Status message
}
```

### PaginationMeta

Pagination metadata for list endpoints.

```typescript
interface PaginationMeta {
  page: number;              // Current page number (1-based)
  limit: number;             // Number of items per page
  total: number;             // Total number of items
  totalPages: number;        // Total number of pages
  hasNext: boolean;          // Whether there is a next page
  hasPrevious: boolean;      // Whether there is a previous page
}
```

---

## User Profile Management

### GET /user

Retrieves the authenticated user's profile information with engagement statistics (books count, reads count, likes, favorites, followers).

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (200 OK):**
```json
{
  "user": {
    "id": "user123",
    "username": "john-doe",
    "name": "John Doe",
    "email": "john@example.com",
    "bio": "Psychological thriller enthusiast",
    "image": "https://ik.imagekit.io/abc123/profile.jpg",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T10:30:00.000Z",
    "stats": {
      "booksCount": 10,
      "readsCount": 150,
      "likedBooksCount": 25,
      "savedBooksCount": 8,
      "followersCount": 42,
      "likesReceived": 156
    }
  }
}
```

**Error Responses:**
- `404 Not Found`: User profile not found

---

### GET /users/:identifier

Fetch user profile by identifier (UUID or username). Industry standard implementation that accepts both UUID and username in a single endpoint. Backend resolves UUID-to-username server-side.

**Authentication:** Optional (via no middleware - public access)

**Path Parameters:**
- `identifier` (string, required): User UUID or username

**Response (200 OK):**
```json
{
  "user": {
    "id": "uuid",
    "username": "john-doe",
    "name": "John Doe",
    "bio": "User bio",
    "image": "https://...",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z",
    "stats": {
      "booksCount": 10,
      "readsCount": 150,
      "likedBooksCount": 25,
      "savedBooksCount": 8,
      "followersCount": 42,
      "likesReceived": 156
    }
  }
}
```

**Error Responses:**
- `404 Not Found`: User profile not found

---

### POST /user

Creates a new user profile or fully replaces an existing user's profile. Uses upsert operation to handle both creation and replacement scenarios.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "name": "John Doe",
  "gender": "male"
}
```

**Parameters:**
- `name` (string, optional): User's display name
- `gender` (string, optional): User's gender (e.g., "male", "female", "other")

**Response (201 Created):**
```json
{
  "user": {
    "userId": "user123",
    "name": "John Doe",
    "gender": "male",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  }
}
```

---

### PUT /user

Partially updates the authenticated user's profile. Only provided fields are updated, existing fields remain unchanged. Supports multiple image upload methods: URL, base64, or multipart file.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)
- `Content-Type`: multipart/form-data for file uploads or application/json

**Request Body (JSON):**
```json
{
  "name": "John Doe",
  "bio": "Psychological thriller enthusiast",
  "gender": "male",
  "imageUrl": "https://example.com/new-avatar.jpg"
}
```

**Or multipart/form-data:**
- `imageFile` (file, optional): Profile image file
- `name` (string, optional): Updated name
- `bio` (string, optional): Updated bio
- `gender` (string, optional): Updated gender
- `imageUrl` (string, optional): Profile image URL

**Response (200 OK):**
```json
{
  "user": {
    "userId": "user123",
    "name": "John Doe",
    "bio": "Psychological thriller enthusiast",
    "gender": "male",
    "image": "https://ik.imagekit.io/abc123/user-user123-profile.jpg",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  },
  "imageUploaded": true,
  "uploadSource": "file",
  "oldImageQueuedForDeletion": false
}
```

**Error Responses:**
- `400 Bad Request`: Invalid image upload
- `404 Not Found`: User profile not found

---

### DELETE /user

Deletes the authenticated user's profile and all associated data from the system. This operation is irreversible and removes all user data including profile information, favorites, likes, comments, reading sessions, and device registrations.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (200 OK):**
```json
{
  "message": "User account deleted successfully",
  "deletedRecords": {
    "userProfile": 1,
    "userFavorites": 8,
    "userLikes": 15,
    "userSessions": 42,
    "userDevices": 2,
    "userComments": 5
  },
  "imageQueuedForDeletion": true
}
```

**Error Responses:**
- `404 Not Found`: User profile not found

---

## Likes

### POST /user/likes

Like a book, comment, or another user. Uses upsert operation to handle both creation and idempotent likes.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "targetType": "book",
  "targetId": "book456"
}
```

**Parameters:**
- `targetType` (string, required): Type of target ("book" | "comment" | "user")
- `targetId` (string, required): ID of the target to like

**Response (201 Created):**
```json
{
  "like": {
    "userId": "user123",
    "targetType": "book",
    "targetId": "book456",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid target type, missing target ID

---

### DELETE /user/likes

Unlike a book, comment, or another user.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `targetType` (string, required): Type of target ("book" | "comment" | "user")
- `targetId` (string, required): ID of the target to unlike

**Response (200 OK):**
```json
{
  "message": "Like removed successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid target type, missing target ID
- `404 Not Found`: Like not found

---

### GET /user/likes

Get all likes for the authenticated user, optionally filtered by target type.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `targetType` (string, optional): Filter by target type ("book" | "comment" | "user")
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "likes": [
    {
      "userId": "user123",
      "targetType": "book",
      "targetId": "book456",
      "createdAt": "2023-01-01T00:00:00.000Z"
    },
    {
      "userId": "user123",
      "targetType": "comment",
      "targetId": "comment789",
      "createdAt": "2023-01-02T00:00:00.000Z"
    }
  ]
}
```

---

## Favorites

### POST /user/favorites

Add a book to user favorites (to read later). Uses upsert operation to handle both creation and idempotent favorites.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "bookId": "book456"
}
```

**Parameters:**
- `bookId` (string, required): ID of the book to favorite

**Response (201 Created):**
```json
{
  "favorite": {
    "userId": "user123",
    "bookId": "book456",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing book ID

---

### DELETE /user/favorites

Remove a book from user favorites.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `bookId` (string, required): ID of the book to remove from favorites

**Response (200 OK):**
```json
{
  "message": "Book removed from favorites successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Missing book ID
- `404 Not Found`: Favorite not found

---

### GET /user/favorites

Get all favorite books for the authenticated user.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "favorites": [
    {
      "userId": "user123",
      "bookId": "book456",
      "createdAt": "2023-01-01T00:00:00.000Z"
    },
    {
      "userId": "user123",
      "bookId": "book789",
      "createdAt": "2023-01-02T00:00:00.000Z"
    }
  ]
}
```

---

## Comments

### POST /user/comments

Create a comment on a book or reply to another comment.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "bookId": "book456",
  "parentCommentId": "comment789",
  "content": "This story is amazing!"
}
```

**Parameters:**
- `bookId` (string, required): ID of the book to comment on
- `parentCommentId` (string, optional): ID of parent comment (for replies)
- `content` (string, required): Comment content (max 5000 chars)

**Response (201 Created):**
```json
{
  "comment": {
    "id": "comment123",
    "userId": "user123",
    "bookId": "book456",
    "parentCommentId": null,
    "content": "This story is amazing!",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing book ID, missing content

---

### PUT /user/comments/:commentId

Update an existing comment (only by the original author).

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Path Parameters:**
- `commentId` (string, required): ID of the comment to update

**Request Body:**
```json
{
  "content": "Updated comment content"
}
```

**Parameters:**
- `content` (string, required): Updated comment content

**Response (200 OK):**
```json
{
  "comment": {
    "id": "comment123",
    "userId": "user123",
    "bookId": "book456",
    "parentCommentId": null,
    "content": "Updated comment content",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing content
- `403 Forbidden`: Not the comment author
- `404 Not Found`: Comment not found

---

### DELETE /user/comments/:commentId

Delete a comment (only by the original author).

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Path Parameters:**
- `commentId` (string, required): ID of the comment to delete

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

### GET /user/comments

Get all comments by the authenticated user, optionally filtered by book.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

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
      "userId": "user123",
      "bookId": "book456",
      "parentCommentId": null,
      "content": "This story is amazing!",
      "createdAt": "2023-01-01T00:00:00.000Z",
      "updatedAt": "2023-01-01T00:00:00.000Z"
    }
  ]
}
```

---

## Follows

### POST /users/:id/follow

Follow a user. Uses upsert operation to handle both creation and idempotent follows.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Path Parameters:**
- `id` (string, required): ID of the user to follow

**Response (201 Created):**
```json
{
  "follow": {
    "followerId": "user123",
    "followingId": "user456",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Cannot follow yourself
- `404 Not Found`: User not found

---

### DELETE /users/:id/follow

Unfollow a user.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Path Parameters:**
- `id` (string, required): ID of the user to unfollow

**Response (200 OK):**
```json
{
  "message": "User unfollowed successfully"
}
```

**Error Responses:**
- `404 Not Found`: Follow relationship not found

---

### GET /users/:id/followers

Get all followers of a specific user.

**Authentication:** Optional (public access)

**Path Parameters:**
- `id` (string, required): ID of the user

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "followers": [
    {
      "userId": "user123",
      "name": "John Doe",
      "username": "john-doe",
      "image": "https://example.com/avatar.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    },
    {
      "userId": "user789",
      "name": "Jane Smith",
      "username": "jane-smith",
      "image": "https://example.com/avatar2.jpg",
      "followedAt": "2023-01-02T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `404 Not Found`: User not found

---

### GET /users/:id/following

Get all users that a specific user is following.

**Authentication:** Optional (public access)

**Path Parameters:**
- `id` (string, required): ID of the user

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "following": [
    {
      "userId": "user789",
      "name": "Jane Smith",
      "username": "jane-smith",
      "image": "https://example.com/avatar2.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    },
    {
      "userId": "user456",
      "name": "Bob Johnson",
      "username": "bob-johnson",
      "image": "https://example.com/avatar3.jpg",
      "followedAt": "2023-01-02T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalCount": 50,
    "totalPages": 5,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `404 Not Found`: User not found

---

### GET /user/followers

Get all followers of the authenticated user.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "followers": [
    {
      "userId": "user123",
      "name": "John Doe",
      "username": "john-doe",
      "image": "https://example.com/avatar.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

### GET /user/following

Get all users that the authenticated user is following.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "following": [
    {
      "userId": "user789",
      "name": "Jane Smith",
      "username": "jane-smith",
      "image": "https://example.com/avatar2.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalCount": 50,
    "totalPages": 5,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

## Daily Check-in

### GET /user/checkin/status

Checks if the authenticated user can perform daily check-in today. Returns check-in status, last check-in date, and total check-in history.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (200 OK):**
```json
{
  "canCheckIn": true,
  "lastCheckInDate": "2026-05-03",
  "totalCheckIns": 5,
  "totalCreditsClaimed": 150,
  "recentCheckIns": [
    {
      "checkInDate": "2026-05-03",
      "creditsClaimed": 30,
      "createdAt": "2026-05-03T00:00:00.000Z"
    }
  ]
}
```

**Response (already checked in):**
```json
{
  "canCheckIn": false,
  "lastCheckInDate": "2026-05-04",
  "totalCheckIns": 6,
  "totalCreditsClaimed": 180,
  "recentCheckIns": [
    {
      "checkInDate": "2026-05-04",
      "creditsClaimed": 30,
      "createdAt": "2026-05-04T00:00:00.000Z"
    }
  ]
}
```

**Behavior:**
- Uses UTC date for daily reset (midnight UTC)
- Returns last 30 days of check-in history
- Includes total statistics for user engagement
- Checks if user can check-in today based on UTC date

---

### POST /user/checkin

Performs daily check-in and awards free credits to the authenticated user. Each check-in awards 30 free credits (configurable via `DAILY_CHECKIN_CREDITS`). Users can only check-in once per UTC day.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (201 Created - successful check-in):**
```json
{
  "success": true,
  "creditsAwarded": 30,
  "checkInDate": "2026-05-04",
  "message": "Successfully claimed 30 daily credits"
}
```

**Response (400 Bad Request - already checked in):**
```json
{
  "success": false,
  "creditsAwarded": 0,
  "checkInDate": "2026-05-04",
  "message": "Already checked in today"
}
```

**Behavior:**
- Creates check-in record with UTC date
- Awards 30 credits to user account (configurable)
- Uses database transaction for atomicity
- Prevents duplicate check-ins with unique constraint
- Records credit transaction with context "daily_checkin"
- Invalidates user profile cache (credits changed)

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
  - `private, max-age=60, stale-while-revalidate=30` for authenticated user data
  - `public, max-age=60, stale-while-revalidate=30` for public user profiles

---

## Caching Strategy

The API implements multi-level caching for performance:
- **Redis caching**: User profiles, user stats
- **HTTP caching**: Public user profiles support CDN caching with Cache-Control headers
- **Cache invalidation**: Automatic invalidation on profile updates, likes, favorites, follows

**Cache TTLs:**
- User profile: 5 minutes
- User stats: 5 minutes

---

## Rate Limiting

Rate limits are enforced on a per-user basis to prevent abuse:

- GET endpoints: 100 requests per minute
- POST/PUT/DELETE endpoints: 50 requests per minute

---

## Authentication

Most endpoints require authentication via NextAuth JWT cookies. The middleware automatically verifies the JWT and extracts user information.

**Middleware Types:**
- `requireAuth`: Requires valid authentication (returns 401 if not authenticated)
- No middleware: Public access (for user profile viewing)

---

## Database Schema

### Users Table
```sql
CREATE TABLE "users" (
  "user_id" uuid PRIMARY KEY,
  "name" text,
  "username" text UNIQUE,
  "email" text UNIQUE,
  "password_hash" text,
  "pen_name" text,
  "bio" text,
  "gender" text,
  "image" text,
  "image_id" text,
  "last_active" timestamp with time zone DEFAULT now() NOT NULL,
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

### User Follows Table
```sql
CREATE TABLE "user_follows" (
  "follower_id" uuid NOT NULL,
  "following_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("follower_id", "following_id")
);
```

### User Check-ins Table
```sql
CREATE TABLE "user_checkins" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid REFERENCES users(id) ON DELETE cascade NOT NULL,
  "check_in_date" text NOT NULL, -- YYYY-MM-DD format (UTC)
  "credits_claimed" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("user_id", "check_in_date")
);
```

---

## Testing

### Example cURL Commands

**Get user profile:**
```bash
curl https://api.twistloom.com/user \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get user by identifier:**
```bash
curl https://api.twistloom.com/users/john-doe
```

**Like a book:**
```bash
curl -X POST https://api.twistloom.com/user/likes \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "targetType": "book",
    "targetId": "book456"
  }'
```

**Add to favorites:**
```bash
curl -X POST https://api.twistloom.com/user/favorites \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "bookId": "book456"
  }'
```

**Follow a user:**
```bash
curl -X POST https://api.twistloom.com/users/user456/follow \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get user's followers:**
```bash
curl https://api.twistloom.com/users/user456/followers?limit=10
```

**Get user following:**
```bash
curl https://api.twistloom.com/user/following?limit=10 \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get check-in status:**
```bash
curl https://api.twistloom.com/user/checkin/status \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Perform daily check-in:**
```bash
curl -X POST https://api.twistloom.com/user/checkin \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

---

## Changelog

### v2.1.0 (2026-05-04)
- Added daily check-in system with 30 free credits per day
- Added GET /user/checkin/status endpoint to check check-in eligibility
- Added POST /user/checkin endpoint to perform daily check-in and claim credits
- Added CheckInStatus, CheckInRecord, and CheckInResult type definitions
- Added user_checkins table schema for tracking daily check-ins
- Added addCredits function to credits service for credit additions
- UTC-based daily reset system (midnight UTC)
- Configurable daily credits via DAILY_CHECKIN_CREDITS constant
- Transaction-safe credit addition with row locking
- Unique constraint to prevent duplicate check-ins per day
- Full audit trail of all check-ins with timestamps

### v2.0.0 (2024-04-24)
- Consolidated API documentation from BACKEND_USER_API_SPECIFICATION.md
- Added comprehensive Type Definitions section with TypeScript interfaces
- Added HTTP Headers section with request/response header documentation
- Added Caching Strategy section with Redis and HTTP caching details
- Updated Rate Limiting section with specific rate limits per endpoint type
- Added Response Pattern section explaining industry-standard API patterns
- Fixed pagination response field name from "totalCount" to "total" to match actual implementation
- Enhanced error handling documentation with HTTP status codes
- Maintained all existing endpoints and functionality
- Aligned documentation with actual canonical route implementation in src/routes/user.ts

### v1.1.0 (2023-04-23)
- Added GET /users/:id/followers endpoint
- Added GET /users/:id/following endpoint
- Added GET /user/followers endpoint
- Added GET /user/following endpoint
- Enhanced documentation with comprehensive API reference

### v1.0.0 (2023-01-01)
- Initial user API implementation
- User profile CRUD operations
- Likes, favorites, comments management
- Follow/unfollow functionality
