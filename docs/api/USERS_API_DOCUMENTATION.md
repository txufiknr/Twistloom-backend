# Users API Documentation

## Overview

The Users API provides endpoints for managing user profiles, social interactions (likes, favorites, comments, follows), daily check-ins, reading progress, achievements, and user discovery. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Base URL:** `/api/user` for authenticated user operations, `/api/users` for public user operations

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies (`requireAuth`). Some read-only endpoints use `optionalAuth` (returns data for authenticated users, empty/null for guests). Public profile viewing requires no auth.

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ user: {...} }`, `{ likes: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ like: {...} }`, `{ comment: {...} }`)
- PUT endpoints: Return updated resources with 200 status (e.g., `{ user: {...} }`, `{ comment: {...} }`)
- DELETE endpoints: Return simple confirmation messages (e.g., `{ message: "..." }`)

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [User Profile Management](#user-profile-management)
   - [Get Authenticated User Profile](#get-user)
   - [Get User Profile by Identifier](#get-usersidentifier)
   - [Complete Onboarding](#post-user)
   - [Update User Profile](#put-user)
   - [Delete User Profile](#delete-user)
3. [Likes](#likes)
   - [Like Target](#post-userlikes)
   - [Unlike Target](#delete-userlikes)
   - [Get User Likes](#get-userlikes)
4. [Favorites](#favorites)
   - [Add Book to Favorites](#post-userfavorites)
   - [Remove Book from Favorites](#delete-userfavorites)
   - [Get User Collections](#get-usercollections)
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
    - [VIP Double Claim](#post-usercheckindouble)
 8. [Referral System](#referral-system)
    - [Set Referrer](#post-userreferrer)
 9. [Activity Logs](#activity-logs)
    - [Get User Activity Logs](#get-useractivity-logs)
 10. [Reading Progress](#reading-progress)
     - [Get Story Progress](#get-userprogress)
 11. [Achievements](#achievements)
     - [Get Achievements](#get-userachievements)
     - [Get Unnotified Achievements](#get-userachievementsunnotified)
     - [Acknowledge Achievement](#post-userachievementsacknowledge)
12. [Error Handling](#error-handling)
13. [HTTP Headers](#http-headers)
14. [Caching Strategy](#caching-strategy)
15. [Authentication](#authentication)
16. [Database Schema](#database-schema)
17. [Testing](#testing)
18. [Changelog](#changelog)

---

## Type Definitions

### User

User profile information returned by the API.

```typescript
interface User {
  id: string;                          // User's unique identifier (UUID)
  username: string;                     // User's unique username
  email: string;                       // User's email address
  name: string;                        // User's display name
  bio?: string | null;                 // User's bio/description
  gender?: string | null;              // User's gender ("male" | "female" | "unknown")
  imageUrl?: string | null;            // User's profile image URL
  credits: number;                     // Available credits
  isNewUser: boolean;                  // Onboarding completed flag
  lastActive: string;                  // Last activity timestamp (ISO 8601)
  subscription: {                      // Subscription information
    tier: string | null;               // User tier
    vipExpiresAt: string | null;       // VIP expiration timestamp
  };
  stats: UserStats;                    // Engagement statistics
  createdAt: string;                   // Account creation timestamp (ISO 8601)
  updatedAt: string;                   // Last update timestamp (ISO 8601)
}
```

### UserStats

User statistics for profile display.

```typescript
interface UserStats {
  booksCount: number;          // (Deprecated - use booksGenerated)
  readsCount: number;          // Number of reading sessions
  likedBooksCount: number;     // Number of books user liked
  savedBooksCount: number;     // Number of books saved to favorites
  followersCount: number;      // Number of followers
  likesReceived: number;       // Total likes received on user's books
  accountDaysOld: number;      // Days since account creation
  emailVerified: string | null; // Email verification timestamp (ISO 8601)
  havePurchased: boolean;      // Whether user has made purchases
  booksGenerated: number;      // Number of books generated
  booksCompleted: number;      // Number of books completed
  pagesRead: number;           // Number of pages read
  pagesGenerated: number;      // Number of pages generated (AI)
  branchesOpened: number;      // Number of branches explored
  topupCredits: number;        // Total credits topped up
  referredUsers: number;       // Number of referred users
  activeCheckinStreak: number; // Current consecutive check-in streak
  maxCheckinStreak: number;    // Longest check-in streak
  customActionsWritten: number; // Number of custom actions authored
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
  collection?: string | null; // Collection name (optional)
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

### FollowerUser / FollowingUser

User profile in follow lists.

```typescript
interface FollowUser {
  userId: string;            // User ID
  name: string | null;       // Display name
  username: string | null;   // Username
  imageUrl: string | null;   // Profile image URL
  followedAt: string;        // When the follow was created (ISO 8601)
}
```

### UserAchievement

Achievement badge with progress toward unlocking.

```typescript
interface UserAchievement {
  id: string;                // Achievement identifier (e.g., "gen_50")
  title: string;             // Display title
  description: string;       // Achievement description
  badgeImageUrl: string;     // Badge icon URL
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';  // Badge tier
  currentProgress: number;   // Current user metric value
  threshold: number;         // Value needed to unlock
  progressPercent: number;   // Progress as percentage (0-100)
  isUnlocked: boolean;       // Whether the badge has been earned
  unlockedAt: string | null; // When the badge was unlocked (ISO 8601)
  isNotified: boolean;       // Whether user has seen the notification
}
```

### CheckInStatus

Daily check-in status and history.

```typescript
interface CheckInStatus {
  eligible: boolean;          // Whether user can check-in today
  lastCheckIn: string | null; // Last check-in date (YYYY-MM-DD) or null
  streak: number;             // Current consecutive check-in streak
  totalCheckIns: number;      // Total number of check-ins
  creditsClaimed: number;     // Total credits claimed from check-ins
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
  creditsAwarded: number;    // Number of credits awarded (30 or 0)
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
  totalCount: number;        // Total number of items
  totalPages: number;        // Total number of pages
  hasNext: boolean;          // Whether there is a next page
  hasPrevious: boolean;      // Whether there is a previous page
}
```

### ActivityLog

User activity log record.

```typescript
interface ActivityLog {
  id: string;                // Log entry ID
  userId: string;            // User who performed the action
  activityType: string;      // Activity type (e.g., "liked", "commented")
  targetType?: string | null; // Target type (e.g., "book", "comment", "user")
  targetId?: string | null;  // ID of the target entity
  metadata?: Record<string, unknown> | null; // Additional context data
  ipAddress?: string | null; // User's IP address
  userAgent?: string | null; // Browser/app user agent
  platform?: string | null;  // Platform ("android", "ios", "web")
  appVersion?: string | null;// App version
  createdAt: string;         // Log creation timestamp (ISO 8601)
}
```

### StoryProgress

User's current reading progress with full branch context (returned by GET /user/progress).

```typescript
interface StoryProgress {
  book: EnrichedBookData | null;
  page: UserStoryPage | null;
  state: StoryState | null;
  session: UserSession | null;
  branchPath: BranchPath | null;
  branchStats: BranchStats | null;
  siblings: PersistedStoryPage[];
}
```

---

## User Profile Management

### GET /user

Retrieves the authenticated user's full enriched profile with engagement statistics.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "user": {
    "id": "user-uuid",
    "username": "johndoe",
    "email": "john@example.com",
    "name": "John Doe",
    "bio": "Psychological thriller enthusiast",
    "gender": "male",
    "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null,
      "vipExpiresAt": null
    },
    "stats": {
      "readsCount": 150,
      "likedBooksCount": 25,
      "savedBooksCount": 8,
      "likesReceived": 156,
      "accountDaysOld": 380,
      "emailVerified": "2024-01-01T00:00:00.000Z",
      "havePurchased": true,
      "booksGenerated": 5,
      "booksCompleted": 12,
      "pagesRead": 350,
      "pagesGenerated": 80,
      "branchesOpened": 15,
      "topupCredits": 200,
      "referredUsers": 3,
      "followersCount": 42,
      "activeCheckinStreak": 5,
      "maxCheckinStreak": 12,
      "customActionsWritten": 2
    },
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

**Error Responses:**
- `404 Not Found`: User profile not found

---

### GET /users/:identifier

Fetch user profile by identifier (UUID or username). Industry standard implementation (Twitter/X, Instagram, GitHub) that accepts both UUID and username in a single endpoint.

**Authentication:** Not required (public — no middleware)

**Path Parameters:**
- `identifier` (string, required): User UUID or username

**Response (200 OK):**
```json
{
  "user": {
    "id": "user-uuid",
    "username": "johndoe",
    "name": "John Doe",
    "email": "john@example.com",
    "bio": "User bio",
    "gender": "male",
    "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null,
      "vipExpiresAt": null
    },
    "stats": {
      "readsCount": 150,
      "likedBooksCount": 25,
      "savedBooksCount": 8,
      "likesReceived": 156,
      "accountDaysOld": 380,
      "emailVerified": "2024-01-01T00:00:00.000Z",
      "havePurchased": false,
      "booksGenerated": 5,
      "booksCompleted": 12,
      "pagesRead": 350,
      "pagesGenerated": 80,
      "branchesOpened": 15,
      "topupCredits": 200,
      "referredUsers": 3,
      "followersCount": 42,
      "activeCheckinStreak": 3,
      "maxCheckinStreak": 10,
      "customActionsWritten": 1
    },
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

**Cache:** HTTP `Cache-Control: public, max-age=60, stale-while-revalidate=30`

**Error Responses:**
- `404 Not Found`: User profile not found

---

### POST /user

Completes the onboarding flow for a new user. Sets `isNewUser` to `false`. Should be called exactly once, after the onboarding wizard is submitted.

All fields are optional. If omitted, existing auto-generated values (username derived from name/email, empty bio, etc.) are kept.

This is NOT a general-purpose create/replace endpoint — it only works for users with `isNewUser = true`.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "name": "John Doe",
  "gender": "male",
  "referrer": "referrer-username-or-id"
}
```

**Parameters:**
- `name` (string, optional): User's display name
- `gender` (string, optional): User's gender ("male", "female", "unknown")
- `referrer` (string, optional): Referrer username or user ID

**Response (200 OK):**
```json
{
  "message": "Onboarding complete",
  "isNewUser": false,
  "username": "johndoe"
}
```

**Error Responses:**
- `400 Bad Request`: Onboarding already completed (isNewUser is false)
- `404 Not Found`: User profile not found

---

### PUT /user

Partially updates the authenticated user's profile. Only provided fields are updated; existing fields remain unchanged. Supports image upload via URL, base64, or multipart file.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)
- `Content-Type`: `multipart/form-data` for file uploads or `application/json`

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

**Response (200 OK):**
```json
{
  "success": true,
  "user": {
    "id": "user-uuid",
    "username": "johndoe",
    "email": "john@example.com",
    "name": "John Doe",
    "bio": "Psychological thriller enthusiast",
    "gender": "male",
    "imageUrl": "https://ik.imagekit.io/abc123/user-user123-profile.jpg",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null,
      "vipExpiresAt": null
    },
    "stats": {
      "readsCount": 150,
      "likedBooksCount": 25,
      "savedBooksCount": 8,
      "likesReceived": 156,
      "accountDaysOld": 380,
      "emailVerified": "2024-01-01T00:00:00.000Z",
      "havePurchased": true,
      "booksGenerated": 5,
      "booksCompleted": 12,
      "pagesRead": 350,
      "pagesGenerated": 80,
      "branchesOpened": 15,
      "topupCredits": 200,
      "referredUsers": 3,
      "followersCount": 42,
      "activeCheckinStreak": 5,
      "maxCheckinStreak": 12,
      "customActionsWritten": 2
    },
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: At least one valid field must be provided

---

### DELETE /user

Deletes the authenticated user's profile and all associated data from the system. This operation is irreversible and removes all user data including profile information, favorites, likes, comments, reading sessions, and device registrations.

Books created by the user are preserved (userId set to null) to maintain content availability.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (200 OK):**
```json
{
  "message": "User account deleted successfully"
}
```

**Error Responses:**
- `404 Not Found`: User profile not found

---

## Likes

### POST /user/likes

Like a book, comment, or another user. Uses upsert (onConflictDoNothing) to handle idempotent likes.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "targetType": "book",
  "targetId": "book-uuid"
}
```

**Parameters:**
- `targetType` (string, required): Type of target (`"book"` | `"comment"` | `"user"`)
- `targetId` (string, required): ID of the target to like

**Response (201 Created):**
```json
{
  "like": {
    "userId": "user-uuid",
    "targetType": "book",
    "targetId": "book-uuid",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Cache Invalidation:** When liking a book, invalidates explore cache, user books cache, and user profile cache.

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
- `targetType` (string, required): Type of target (`"book"` | `"comment"` | `"user"`)
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

**Query Parameters:**
- `targetType` (string, optional): Filter by target type (`"book"` | `"comment"` | `"user"`)
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "likes": [
    {
      "userId": "user-uuid",
      "targetType": "book",
      "targetId": "book-uuid",
      "createdAt": "2023-01-01T00:00:00.000Z"
    },
    {
      "userId": "user-uuid",
      "targetType": "comment",
      "targetId": "comment-uuid",
      "createdAt": "2023-01-02T00:00:00.000Z"
    }
  ]
}
```

---

## Favorites

### POST /user/favorites

Add a book to the authenticated user's favorites (read later list). Uses upsert (onConflictDoNothing) to handle idempotent favorites.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "bookId": "book-uuid"
}
```

**Parameters:**
- `bookId` (string, required): ID of the book to favorite

**Response (201 Created):**
```json
{
  "favorite": {
    "userId": "user-uuid",
    "bookId": "book-uuid",
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

### GET /user/collections

Get all distinct collection names for the authenticated user's favorite books, sorted alphabetically.

**Authentication:** Optional (`optionalAuth` — returns `[]` for guests)

**Response (200 OK):**
```json
{
  "collections": [
    { "name": "Favorites", "totalBooks": 8 },
    { "name": "Psychological Thrillers", "totalBooks": 3 },
    { "name": "To Read Later", "totalBooks": 12 }
  ]
}
```

**Behavior:**
- Returns distinct collection names with book counts from `user_favorites` table
- Filters out null collection values
- Sorted alphabetically by collection name

---

## Comments

### POST /user/comments

Create a comment on a book or reply to another comment. Content is sanitized before storage.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "bookId": "book-uuid",
  "parentCommentId": "comment-uuid",
  "content": "This story is amazing!"
}
```

**Parameters:**
- `bookId` (string, required): ID of the book to comment on
- `parentCommentId` (string, optional): ID of parent comment (for replies)
- `content` (string, required): Comment content

**Response (201 Created):**
```json
{
  "comment": {
    "id": "comment-uuid",
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "parentCommentId": null,
    "content": "This story is amazing!",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Cache Invalidation:** Invalidates explore cache for top-level comments (commentsCount changes).

**Error Responses:**
- `400 Bad Request`: Missing book ID, missing or empty content

---

### PUT /user/comments/:commentId

Update an existing comment (only by the original author). Content is sanitized before storage.

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
    "id": "comment-uuid",
    "userId": "user-uuid",
    "bookId": "book-uuid",
    "parentCommentId": null,
    "content": "Updated comment content",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-15T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing or empty content
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

**Cache Invalidation:** Invalidates explore cache for top-level comments.

**Error Responses:**
- `403 Forbidden`: Not the comment author
- `404 Not Found`: Comment not found

---

### GET /user/comments

Get all comments by the authenticated user, optionally filtered by book.

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
      "id": "comment-uuid",
      "userId": "user-uuid",
      "bookId": "book-uuid",
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

Follow a user. Uses upsert (onConflictDoNothing) to handle idempotent follows.

**Authentication:** Required (via `requireAuth`)

**Head��ers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Path Parameters:**
- `id` (string, required): ID of the user to follow

**Response (201 Created):**
```json
{
  "follow": {
    "followerId": "user-uuid",
    "followingId": "user-uuid",
    "createdAt": "2023-01-01T00:00:00.000Z"
  }
}
```

**Cache Invalidation:** Invalidates profile cache for the followed user (followersCount changed).

**Error Responses:**
- `400 Bad Request`: Cannot follow yourself
- `404 Not Found`: User not found

---

### DELETE /users/:id/follow

Unfollow a user.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `id` (string, required): ID of the user to unfollow

**Response (200 OK):**
```json
{
  "message": "User unfollowed successfully"
}
```

**Cache Invalidation:** Invalidates profile cache for the unfollowed user.

**Error Responses:**
- `404 Not Found`: Follow relationship not found

---

### GET /users/:id/followers

Get all followers of a specific user, with user profile info and pagination.

**Authentication:** Not required (public — no middleware)

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
      "userId": "user-uuid",
      "name": "John Doe",
      "username": "johndoe",
      "imageUrl": "https://example.com/avatar.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalCount": 100,
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

Get all users that a specific user is following, with user profile info and pagination.

**Authentication:** Not required (public — no middleware)

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
      "userId": "user-uuid",
      "name": "Jane Smith",
      "username": "jane-smith",
      "imageUrl": "https://example.com/avatar2.jpg",
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

**Error Responses:**
- `404 Not Found`: User not found

---

### GET /user/followers

Get all followers of the authenticated user, with user profile info and pagination.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "followers": [
    {
      "userId": "user-uuid",
      "name": "John Doe",
      "username": "johndoe",
      "imageUrl": "https://example.com/avatar.jpg",
      "followedAt": "2023-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalCount": 100,
    "totalPages": 10,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

### GET /user/following

Get all users that the authenticated user is following, with user profile info and pagination.

**Authentication:** Required (via `requireAuth`)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "following": [
    {
      "userId": "user-uuid",
      "name": "Jane Smith",
      "username": "jane-smith",
      "imageUrl": "https://example.com/avatar2.jpg",
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

Checks if the authenticated user can perform daily check-in today. Returns check-in status, last check-in date, streak, and recent history.

**Authentication:** Optional (`optionalAuth` — returns empty state for guests)

**Response (200 OK — can check-in):**
```json
{
  "eligible": true,
  "lastCheckIn": "2026-05-03",
  "streak": 5,
  "totalCheckIns": 12,
  "creditsClaimed": 360,
  "recentCheckIns": [
    {
      "checkInDate": "2026-05-03",
      "creditsClaimed": 30,
      "createdAt": "2026-05-03T00:00:00.000Z"
    }
  ]
}
```

**Response (200 OK — already checked in):**
```json
{
  "eligible": false,
  "lastCheckIn": "2026-05-04",
  "streak": 6,
  "totalCheckIns": 13,
  "creditsClaimed": 390,
  "recentCheckIns": [
    {
      "checkInDate": "2026-05-04",
      "creditsClaimed": 30,
      "createdAt": "2026-05-04T00:00:00.000Z"
    }
  ]
}
```

**Response (200 OK — guest/unauthenticated):**
```json
{
  "eligible": false,
  "lastCheckIn": null,
  "streak": 0,
  "totalCheckIns": 0,
  "creditsClaimed": 0,
  "recentCheckIns": []
}
```

---

### POST /user/checkin

Performs daily check-in and awards free credits to the authenticated user. Each check-in awards 30 credits (configurable via `DAILY_CHECKIN_BONUS`). Users can only check-in once per UTC day.

**Authentication:** Required (via `requireAuth`)

**Response (201 Created — successful):**
```json
{
  "success": true,
  "creditsAwarded": 30,
  "checkInDate": "2026-05-04",
  "message": "Successfully claimed 30 daily credits"
}
```

**Response (400 Bad Request — already checked in):**
```json
{
  "success": false,
  "creditsAwarded": 0,
  "checkInDate": "2026-05-04",
  "message": "Already checked in today"
}
```

---

### POST /user/checkin/double

VIP-only double claim that awards 2x the daily check-in credits. Can be claimed in addition to the regular check-in on the same day. Requires VIP subscription tier; returns 403 if the user is not VIP.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Response (201 Created — successful):**
```json
{
  "success": true,
  "creditsAwarded": 30,
  "checkInDate": "2026-05-04",
  "message": "Successfully claimed 30 VIP 2x daily credits"
}
```

**Response (403 Forbidden — not VIP):**
```json
{
  "success": false,
  "creditsAwarded": 0,
  "currentStreak": 0,
  "totalCreditsClaimed": 0,
  "checkInDate": "2026-05-04",
  "message": "VIP 2x claim is only available to VIP subscribers"
}
```

---

## Referral System

### POST /user/referrer

Sets the referrer for the authenticated user by username. Only allowed for new users (`isNewUser = true`). After setting referrer, `isNewUser` is set to `false`.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "username": "johndoe"
}
```

**Parameters:**
- `username` (string, required): Username of the referrer

**Response (200 OK — success):**
```json
{
  "success": true,
  "referrerId": "referrer-uuid",
  "message": "Referrer set successfully"
}
```

**Response (200 OK — not new user):**
```json
{
  "success": false,
  "error": "Referrer can only be set for new users"
}
```

---

## Activity Logs

### GET /user/activity-logs

Get activity logs for the authenticated user with optional filtering by activity type and target type.

**Authentication:** Optional (`optionalAuth` — returns `[]` for guests)

**Query Parameters:**
- `activityType` (string, optional): Filter by activity type (e.g., `"liked"`, `"commented"`, `"followed"`)
- `targetType` (string, optional): Filter by target type (e.g., `"book"`, `"comment"`, `"user"`)
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "logs": [
    {
      "id": "log-uuid",
      "userId": "user-uuid",
      "activityType": "liked",
      "targetType": "book",
      "targetId": "book-uuid",
      "metadata": null,
      "ipAddress": "192.168.1.1",
      "userAgent": "Mozilla/5.0...",
      "platform": "android",
      "appVersion": "1.0.0",
      "createdAt": "2023-01-01T00:00:00.000Z"
    }
  ]
}
```

**Activity Types:**
- `onboarding_complete`: User completed onboarding
- `liked`: User liked a book, comment, or user
- `commented`: User commented on a book
- `followed`: User followed another user
- `favorited`: User favorited a book

---

## Reading Progress

### GET /user/progress

Returns the authenticated user's current reading progress with full branch context. All top-level fields are nullable — a user with no active session receives the `null` shape shown below rather than an error.

**Authentication:** Optional (`optionalAuth` — returns all-null for guests)

**Response (200 OK — active session):**
```json
{
  "book": {
    "id": "book-uuid",
    "title": "The Lost Kingdom",
    "language": "en",
    "totalPages": 24,
    "stats": { "readCount": 312, "likesCount": 87 }
  },
  "page": {
    "id": "page-uuid",
    "page": 7,
    "text": "The gate creaks open…",
    "actions": [
      { "text": "Step inside.", "type": "brave" },
      { "text": "Turn back.", "type": "cautious" }
    ]
  },
  "state": {
    "actionsHistory": [],
    "plotFlags": [],
    "contextHistory": "The MC followed a stranger…"
  },
  "session": {
    "bookId": "book-uuid",
    "pageId": "page-uuid",
    "previousPageId": "previous-page-uuid",
    "status": "active"
  },
  "branchPath": {
    "depth": 7,
    "pages": [
      { "id": "page1id", "page": 1, "branchId": "main" },
      { "id": "page7id", "page": 7, "branchId": "branch-a3f" }
    ]
  },
  "branchStats": {
    "totalBranches": 3,
    "branchingFactor": 1.4
  },
  "siblings": [
    { "id": "page7alt1", "page": 7, "branchId": "branch-b9c", "text": "She ran instead…" }
  ]
}
```

**Response (200 OK — no active session):**
```json
{
  "book": null,
  "page": null,
  "state": null,
  "session": null,
  "branchPath": null,
  "branchStats": null,
  "siblings": []
}
```

---

## Achievements

### GET /user/achievements

Returns the authenticated user's achievements/badges with progress calculations.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "success": true,
  "badges": [
    {
      "id": "gen_50",
      "title": "Storyteller",
      "description": "Generate 50 books",
      "badgeImageUrl": "https://example.com/badges/gen_50.png",
      "tier": "gold",
      "currentProgress": 50,
      "threshold": 50,
      "progressPercent": 100,
      "isUnlocked": true,
      "unlockedAt": "2026-05-01T00:00:00.000Z",
      "isNotified": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "totalCount": 36,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

---

### GET /user/achievements/unnotified

Ultra-fast endpoint to check, award, and return newly unlocked badges. Designed to be called by the frontend immediately after taking actions. Evaluates counters against the registry and inserts new achievements if thresholds are met, then returns only badges the user hasn't seen yet.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK — new badges found):**
```json
{
  "success": true,
  "badges": [
    {
      "id": "gen_50",
      "title": "Storyteller",
      "description": "Generate 50 books",
      "badgeImageUrl": "https://example.com/badges/gen_50.png",
      "tier": "gold",
      "currentProgress": 50,
      "threshold": 50,
      "progressPercent": 100,
      "isUnlocked": true,
      "unlockedAt": null,
      "isNotified": false
    }
  ]
}
```

**Response (200 OK — no new badges):**
```json
{
  "success": true,
  "badges": []
}
```

---

### POST /user/achievements/acknowledge

Marks achievement notifications as viewed/acknowledged by the authenticated user after the frontend displays the notification toast.

**Authentication:** Required (via `requireAuth`)

**Request Body:**
```json
{
  "achievementIds": ["gen_50", "read_100"]
}
```

**Parameters:**
- `achievementIds` (string[], required): Array of achievement IDs to acknowledge

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Badges flagged as viewed"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid payload — achievementIds must be a non-empty array

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
  "error": "You can only edit your own comments"
}
```

**HTTP Status Codes:**
- `200 OK`: Successful GET, PUT, or DELETE request
- `201 Created`: Successful POST request
- `400 Bad Request`: Invalid request data
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Permission denied (not the resource owner)
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

- `Cache-Control`: Varies by endpoint
  - `private` for authenticated user data
  - `public, max-age=60, stale-while-revalidate=30` for public user profiles (`GET /users/:identifier`)

---

## Caching Strategy

The API implements multi-level caching for performance:
- **In-memory caching**: User profiles via `withCache()` utility using configurable TTL
- **HTTP caching**: Public user profiles support CDN/edge caching with Cache-Control headers
- **Cache invalidation**: Automatic invalidation on profile updates, likes, favorites, follows, and check-ins

**Cache TTLs:**
- User profile: 5 minutes (configurable via `CACHE_TTL.USER_PROFILE`)

**Invalidation Triggers:**
- Profile update (PUT /user): Invalidates `user:{userId}:profile`
- Onboarding (POST /user): Invalidates profile cache
- Like/unlike (book target): Invalidates explore cache, user books cache, and profile cache
- Favorite/unfavorite: Invalidates profile cache (savedBooksCount)
- Follow/unfollow: Invalidates profile cache for the target user (followersCount)
- Daily check-in: Invalidates profile cache (credits changed)

---

## Authentication

Endpoints use three middleware types:

- `requireAuth`: Requires valid authentication — returns 401 if not authenticated
- `optionalAuth`: Attaches user info if cookie is present, continues silently for guests
- No middleware: Public access (user profile viewing, follower lists)

---

## Database Schema

### Users Table
```sql
CREATE TABLE "users" (
  "user_id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "username" text NOT NULL UNIQUE,
  "email" text NOT NULL UNIQUE,
  "password_hash" text,
  "pen_name" text,
  "bio" text,
  "gender" text,
  "image_url" text,
  "image_id" text,
  "stripe_customer_id" text UNIQUE,
  "credits" integer DEFAULT 50 NOT NULL, -- First-time user bonus
  "tier" text,
  "is_new_user" boolean DEFAULT true NOT NULL,
  "referrer_id" uuid,
  "subscription_id" uuid,
  "vip_expires_at" timestamp with time zone,
  "token_version" integer DEFAULT 0 NOT NULL,
  "last_active" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

### User Likes Table
```sql
CREATE TABLE "user_likes" (
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "target_type" text NOT NULL, -- "book" | "comment" | "user"
  "target_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "target_type", "target_id")
);
```

### User Favorites Table
```sql
CREATE TABLE "user_favorites" (
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "book_id" uuid NOT NULL REFERENCES books(id) ON DELETE cascade,
  "collection" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "book_id")
);
```

### User Comments Table
```sql
CREATE TABLE "user_comments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "book_id" uuid NOT NULL REFERENCES books(id) ON DELETE cascade,
  "page_id" uuid REFERENCES pages(id) ON DELETE cascade,
  "parent_comment_id" uuid,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

### User Follows Table
```sql
CREATE TABLE "user_follows" (
  "follower_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "following_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("follower_id", "following_id")
);
```

### User Check-ins Table
```sql
CREATE TABLE "user_checkins" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "check_in_date" text NOT NULL, -- YYYY-MM-DD format (UTC)
  "credits_claimed" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("user_id", "check_in_date")
);
```

### User Activity Logs Table
```sql
CREATE TABLE "user_activity_logs" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "activity_type" text NOT NULL,
  "target_type" text,
  "target_id" uuid,
  "metadata" jsonb,
  "ip_address" text,
  "user_agent" text,
  "platform" text,
  "app_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

**Indexes:**
- `user_activity_logs_user_idx`: (user_id, created_at DESC)
- `user_activity_logs_type_idx`: (activity_type)
- `user_activity_logs_target_idx`: (target_type, target_id)
- `user_activity_logs_created_idx`: (created_at DESC)

---

## Testing

### Example cURL Commands

**Get authenticated user profile:**
```bash
curl https://api.twistloom.com/api/user \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get user by identifier:**
```bash
curl https://api.twistloom.com/api/users/johndoe
```

**Like a book:**
```bash
curl -X POST https://api.twistloom.com/api/user/likes \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "targetType": "book",
    "targetId": "book-uuid"
  }'
```

**Add to favorites:**
```bash
curl -X POST https://api.twistloom.com/api/user/favorites \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "bookId": "book-uuid"
  }'
```

**Follow a user:**
```bash
curl -X POST https://api.twistloom.com/api/users/user-uuid/follow \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get user's followers:**
```bash
curl https://api.twistloom.com/api/users/user-uuid/followers?limit=10
```

**Get authenticated user's following:**
```bash
curl https://api.twistloom.com/api/user/following?limit=10 \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get check-in status:**
```bash
curl https://api.twistloom.com/api/user/checkin/status \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Perform daily check-in:**
```bash
curl -X POST https://api.twistloom.com/api/user/checkin \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**VIP double claim:**
```bash
curl -X POST https://api.twistloom.com/api/user/checkin/double \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Set referrer:**
```bash
curl -X POST https://api.twistloom.com/api/user/referrer \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "username": "johndoe"
  }'
```

**Get story progress:**
```bash
curl https://api.twistloom.com/api/user/progress \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get achievements:**
```bash
curl https://api.twistloom.com/api/user/achievements \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get unnotified achievements:**
```bash
curl https://api.twistloom.com/api/user/achievements/unnotified \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Get activity logs:**
```bash
curl "https://api.twistloom.com/api/user/activity-logs?activityType=liked&limit=10" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

---

## Changelog

### v3.1.0 (2026-07-04)
- Added POST /user/checkin/double endpoint (VIP 2x daily check-in claim)
- Added GET /user/achievements/unnotified endpoint (check, award, and return new badges)
- Fixed GET /user/collections response shape to show `{name, totalBooks}` objects (not flat strings)
- Fixed PaginationMeta type: `total` → `totalCount` across all response examples

### v3.0.0 (2026-06-29)
- Added GET /user/achievements endpoint (achievements/badges listing)
- Added POST /user/achievements/acknowledge endpoint (mark badges as viewed)
- Added GET /user/progress endpoint (reading progress with branch context)
- Added POST /user/referrer endpoint (set referrer by username)
- Fixed POST /user description from "Create/Replace" to "Complete Onboarding"
- Fixed response field names: `image` → `imageUrl` throughout
- Fixed DELETE /user response to match actual output (no deletedRecords / imageQueuedForDeletion)
- Fixed auth middleware annotations: GET /user/collections, GET /user/checkin/status, GET /user/activity-logs use `optionalAuth`
- Expanded UserStats type definition with all engagement fields
- Added subscription object to User type
- Updated database schema to reflect actual Drizzle ORM schema
- Removed GET /user/favorites (not implemented — favorites listing is handled elsewhere)

### v2.1.0 (2026-05-04)
- Added daily check-in system with 30 free credits per day
- Added GET /user/checkin/status endpoint to check check-in eligibility
- Added POST /user/checkin endpoint to perform daily check-in and claim credits
- Added CheckInStatus, CheckInRecord, and CheckInResult type definitions
- UTC-based daily reset system (midnight UTC)
- Configurable daily credits via DAILY_CHECKIN_CREDITS constant
- Transaction-safe credit addition with row locking
- Unique constraint to prevent duplicate check-ins per day

### v2.0.0 (2024-04-24)
- Consolidated API documentation from BACKEND_USER_API_SPECIFICATION.md
- Added comprehensive Type Definitions section with TypeScript interfaces
- Added HTTP Headers section with request/response header documentation
- Added Caching Strategy section with caching details
- Updated Rate Limiting section with specific rate limits per endpoint type
- Added Response Pattern section explaining industry-standard API patterns
- Fixed pagination response field name from "total" to "totalCount" to match actual implementation
- Enhanced error handling documentation with HTTP status codes

### v1.1.0 (2023-04-23)
- Added GET /users/:id/followers endpoint
- Added GET /users/:id/following endpoint
- Added GET /user/followers endpoint
- Added GET /user/following endpoint

### v1.0.0 (2023-01-01)
- Initial user API implementation
- User profile CRUD operations
- Likes, favorites, comments management
- Follow/unfollow functionality
