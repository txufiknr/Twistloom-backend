# Users API Documentation

## Overview

The Users API provides endpoints for managing user profiles, social interactions (likes, favorites, comments, follows), daily check-ins, reading progress, achievements, platform-wide testimonials, and user discovery. All endpoints follow industry-standard public API patterns used by major platforms (Twitter/X, GitHub, Instagram, LinkedIn).

**Base URL:** All endpoints live under `/api/user`. Authenticated user operations sit directly under it (e.g. `/api/user/checkin`). Public / user-facing operations sit under the nested `/api/user/users/...` sub-path (e.g. `/api/user/users/:identifier`, `/api/user/users/top-creators`). Note there is no separate `/api/users` mount — the `/users/...` routes in this document resolve to `/api/user/users/...`.

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies (`requireAuth`). Some read-only endpoints use `optionalAuth` (returns data for authenticated users, empty/null for guests). Public endpoints require no auth.

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
3. [Creator Discovery](#creator-discovery)
   - [Get Top Creators (This Week)](#get-users-top-creators)
4. [Likes](#likes)
   - [Like Target](#post-userlikes)
   - [Unlike Target](#delete-userlikes)
   - [Get User Likes](#get-userlikes)
5. [Favorites](#favorites)
   - [Add Book to Favorites](#post-userfavorites)
   - [Remove Book from Favorites](#delete-userfavorites)
   - [Get User Collections](#get-usercollections)
6. [Comments](#comments)
   - [Create Comment](#post-usercomments)
   - [Update Comment](#put-usercommentscommentid)
   - [Delete Comment](#delete-usercommentscommentid)
   - [Get User Comments](#get-usercomments)
7. [Follows](#follows)
   - [Follow User](#post-usersidfollow)
   - [Unfollow User](#delete-usersidfollow)
   - [Get User Followers](#get-usersidfollowers)
   - [Get User Following](#get-usersidfollowing)
   - [Get Authenticated User's Followers](#get-userfollowers)
   - [Get Authenticated User's Following](#get-userfollowing)
 8. [Daily Check-in](#daily-check-in)
    - [Get Check-in Status](#get-usercheckinstatus)
    - [Perform Daily Check-in](#post-usercheckin)
    - [VIP Double Claim](#post-usercheckindouble)
  9. [Referral System](#referral-system)
     - [Set Referrer (via POST /user — complete onboarding)](#setting-referrer-via-post-user--complete-onboarding)
     - [POST /user/referrer (DEPRECATED)](#post-userreferrer-deprecated)
 10. [Activity Logs](#activity-logs)
     - [Get User Activity Logs](#get-useractivity-logs)
 11. [Reading Progress](#reading-progress)
     - [Get Story Progress](#get-userprogress)
 12. [Achievements](#achievements)
      - [Get Achievements](#get-userachievements)
      - [Get Unnotified Achievements](#get-userachievementsunnotified)
      - [Acknowledge Achievement](#post-userachievementsacknowledge)
      - [Get User Public Achievements](#get-usersidachievements)
  13. [Quests (The Prologue)](#quests-the-prologue)
      - [Get Quest Log](#get-userquests)
      - [Re-Check Quest Completion](#post-userquestsrecheck)
      - [Claim All Quest Rewards](#post-userquestsclaim-all)
      - [Claim Quest Reward](#post-userquestsquestidclaim)
 14. [User Feedback](#user-feedback)
      - [Submit Feedback](#post-userfeedbacks)
 15. [Beta Tester Program](#beta-tester-program)
      - [Join Beta Tester Program](#post-userbeta-tester)
 16. [Platform Testimonials](#platform-testimonials)
      - [Submit Platform Testimonial](#post-userplatform-testimonials)
      - [Get Own Platform Testimonials](#get-userplatform-testimonials)
      - [Update Own Platform Testimonial](#patch-userplatform-testimonialsid)
      - [Delete Own Platform Testimonial](#delete-userplatform-testimonialsid)
 17. [Error Handling](#error-handling)
 18. [HTTP Headers](#http-headers)
 19. [Caching Strategy](#caching-strategy)
 20. [Authentication](#authentication)
 21. [Database Schema](#database-schema)
 22. [Testing](#testing)
 23. [Changelog](#changelog)

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
  avatarFrame?: string | null;         // Achievement tier key rendered as an avatar frame ("bronze" | "silver" | "gold" | "platinum", null = no frame)
  credits: number;                     // Available credits
  isNewUser: boolean;                  // Onboarding completed flag
  lastActive: string;                  // Last activity timestamp (ISO 8601)
  linkedMethods?: string[];            // Linked auth methods: ["credentials", "google"]
  subscription: {                      // Subscription information (SSOT for VIP gating)
    tier: string | null;               // User's tier — the authoritative VIP gate field
  };
  isFollowing?: boolean;               // Whether the requesting user follows this user (only present for public profile endpoint GET /users/:identifier when viewer is authenticated)
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
  avatarFrame?: string | null;  // Achievement tier key rendered as an avatar frame (null = no frame)
  followedAt: string;        // When the follow was created (ISO 8601)
}
```

### TopCreator

Creator entry returned by the "Creators writing this week" homepage section (GET /users/top-creators).

```typescript
interface TopCreator {
  userId: string;              // Creator's unique identifier (UUID)
  name: string;                // Creator's display name
  username: string;            // Creator's username
  imageUrl: string | null;     // Creator's profile image URL
  avatarFrame?: string | null;     // Achievement tier key rendered as an avatar frame (null = no frame)
  booksCreated: number;        // Number of public books created in the last 7 days
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

### UserQuest

A single quest in the quest log ("The Prologue") with its per-user state. Title/description are API-provided strings from the backend `QUEST_REGISTRY` (mirroring achievements); the frontend renders them directly.

```typescript
interface UserQuest {
  id: string;                // Quest identifier (e.g., "qs_01_2")
  chapterId: string;         // Chapter the quest belongs to (e.g., "ch1")
  title: string;             // Display title
  description: string;       // One-line "why" description
  rewardCredits: number;     // Credit payout on claim
  currentProgress: number;   // Current detector value (0 for binary/profile)
  threshold: number;         // Value needed to complete (0 = non-quantitative)
  progressPercent: number;   // Progress as percentage (0-100)
  status: 'in_progress' | 'completed' | 'claimed';  // Quest lifecycle state
  completedAt: string | null;// When the quest was detected complete (ISO 8601)
  claimedAt: string | null;  // When the reward was claimed (ISO 8601)
  enabled: boolean;          // Whether the quest is shown (false = hidden)
}
```

### QuestsSummary

Aggregated summary of the quest log, used to derive the nav badge.

```typescript
interface QuestsSummary {
  completed: number;         // Number of quests not yet claimed
  claimable: number;         // Number of quests currently claimable
  totalReward: number;       // Sum of rewardCredits across all returned quests
  unclaimedReward: number;   // Sum of rewardCredits for claimable quests
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

### Feedback

User feedback submission record.

```typescript
interface Feedback {
  id: string;                      // Feedback unique identifier
  userId: string;                  // User who submitted the feedback
  category: 'feedback' | 'bug_report' | 'feature_request' | 'other';  // Feedback category
  message: string;                 // Feedback message content
  imageId?: string | null;         // ImageKit file ID for screenshot (optional)
  imageUrl?: string | null;        // ImageKit URL for screenshot (optional)
  status: 'idle' | 'submitting' | 'success' | 'error';  // Submission status
  createdAt: string;               // Feedback creation timestamp (ISO 8601)
  updatedAt: string;               // Last update timestamp (ISO 8601)
}
```

### PlatformTestimonial

User-submitted, platform-wide testimonial (beta testers only). Unlike `bookTestimonials` (scoped to a single book), this relates to the Twistloom platform itself.

```typescript
interface PlatformTestimonial {
  id: string;                       // Testimonial unique identifier (UUID)
  userId: string;                   // User who submitted the testimonial
  rating: number | null;            // Optional star rating (1–5)
  content: string;                  // Testimonial message content
  status: 'pending' | 'approved' | 'rejected';  // Admin curation lifecycle
  featured: boolean;                // Whether it's featured on the public wall
  createdAt: string;                // Testimonial creation timestamp (ISO 8601)
  updatedAt: string;                // Last update timestamp (ISO 8601)
}
```

---

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
    "avatarFrame": "gold",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null
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

**Authentication:** Optional (via `optionalAuth`) — returns `isFollowing` when viewer is authenticated

**Path Parameters:**
- `identifier` (string, required): User UUID or username

**Response (200 OK) — Authenticated viewer:**
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
    "avatarFrame": "gold",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null
    },
    "isFollowing": true,
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

**Response (200 OK) — Guest viewer:**
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
    "avatarFrame": "gold",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "subscription": {
      "tier": null
    },
    "isFollowing": false,
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

**Cache:** HTTP `Cache-Control: public, max-age=60, stale-while-revalidate=30` (cache is skipped when viewer is authenticated to ensure fresh `isFollowing` data)

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
  "referrer": "johndoe"
}
```

**Parameters:**
- `name` (string, optional): User's display name
- `gender` (string, optional): User's gender ("male", "female", "unknown")
- `referrer` (string, optional): Referrer **username** — only applied if the user is new (`isNewUser === true`), has no referrer set, and the referrer's email is verified. See [Referral System](#referral-system).

> **Note:** Referrer attribution is also accepted at signup via `POST /auth/signup` (see AUTH_API_DOCUMENTATION.md). This endpoint is the canonical fallback for completing attribution during onboarding.

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
  "imageUrl": "https://example.com/new-avatar.jpg",
  "avatarFrame": "gold"
}
```

**Parameters:**
- `name` (string, optional): Updated name
- `bio` (string, optional): Updated bio
- `gender` (string, optional): Updated gender
- `imageUrl` (string, optional): Profile image URL or base64 data
- `avatarFrame` (string, optional): Achievement tier key rendered as an avatar frame (`bronze` | `silver` | `gold` | `platinum`); `null`/empty clears it

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
    "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
    "avatarFrame": "gold",
    "credits": 500,
    "isNewUser": false,
    "lastActive": "2024-01-15T10:30:00.000Z",
    "linkedMethods": ["credentials", "google"],
    "subscription": {
      "tier": null
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

## Creator Discovery

### GET /users/top-creators

Returns the users who created the most books in the last 7 days. Powers the "Creators writing this week" section on the homepage.

Only books with `status = 'active'` and `visibility = 'public'` are counted, so the ranking reflects creators actively publishing stories visible to the community — not private drafts or archived books. Results are ordered by `booksCreated` descending and capped by `limit`.

**Authentication:** Not required (public — no middleware)

**Query Parameters:**
- `limit` (number, optional): Maximum number of creators to return (default: `10`, clamped to `1–50`)

**Response (200 OK):**
```json
{
  "creators": [
    {
      "userId": "user-uuid",
      "name": "John Doe",
      "username": "johndoe",
      "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
      "avatarFrame": "gold",
      "booksCreated": 3
    },
    {
      "userId": "user-uuid-2",
      "name": "Jane Smith",
      "username": "jane-smith",
      "imageUrl": "https://ik.imagekit.io/abc123/profile2.jpg",
      "avatarFrame": null,
      "booksCreated": 2
    }
  ]
}
```

**Cache:** HTTP `Cache-Control: public, max-age=1800, stale-while-revalidate=300` (30-minute in-memory TTL via `CACHE_KEYS.TOP_CREATORS(limit)`)

**Behavior:**
- Queries `users` joined to `books` where `books.created_at >= now() - 7 days`
- Counts only `status = 'active'` and `visibility = 'public'` books, grouped by user
- Returns an empty `creators` array if no user published books this week

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
      "avatarFrame": "gold",
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
      "avatarFrame": null,
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
      "avatarFrame": "gold",
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
      "avatarFrame": null,
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

The referral system allows new users to attribute their signup to an existing user (referrer). Both the referrer and the new user receive a referral bonus.

**How referral attribution works (current implementation):**
- Referrers are looked up **by username** (case-insensitive, sanitized server-side).
- **The referrer's email must be verified** to be eligible. Unverified accounts cannot be a referrer — they are rejected exactly like a nonexistent username, and attribution silently no-ops. This is intentional (prevents throwaway-account abuse).
- Attribution is **best-effort and non-blocking**: an invalid/unverified referrer never blocks signup or onboarding and never raises an error.
- The credit payout for both parties is deferred until the referred user verifies their email (`POST /auth/verify-email`). Linking the `referrer_id` alone does not pay anything.

### Setting Referrer (via POST /user — complete onboarding)

The canonical endpoint for setting a referrer on an existing account. Attribution also happens at signup time via `POST /auth/signup`; this endpoint is the fallback for flows that reach onboarding without a referrer attached.

Only takes effect for users who are still new (`isNewUser === true`) and don't already have a referrer set.

**Authentication:** Required (via `requireAuth`)

**Request Body:**
```json
{
  "referrer": "johndoe"
}
```

**Parameters:**
- `referrer` (string, optional): Referrer **username** — silently ignored if user is not new, already has a referrer, or the referrer's email is not verified

**Behavior:**
- Checks the user is a new user (`isNewUser === true`) and has no existing `referrerId`
- Looks up the referrer by username and checks the referrer's email is verified
- Sets `referrerId` on the user (attribution only — no credits paid yet)
- Credits are awarded to both parties later, when the referred user verifies their email via `POST /auth/verify-email`
- Silently no-ops (no error) if the conditions are not met

**Not accepted by `PUT /user`:** Referrer attribution is **not** supported on `PUT /user` (profile updates). Any `referrer` field sent to `PUT /user` is rejected/ignored.

### POST /user/referrer (DEPRECATED)

**This endpoint is deprecated.** Use `POST /user` with a `referrer` field (complete onboarding) instead.

Calling this endpoint returns HTTP `410 Gone`:

```json
{
  "error": "This endpoint is deprecated. Use POST /user with a \"referrer\" field instead."
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

### GET /users/:id/achievements

Returns a public user's achievements/badges for profile display. Unlike `GET /user/achievements`, this endpoint requires no authentication and returns only unlocked badges for the specified user.

**Authentication:** Not required (public)

**Path Parameters:**
- `id` (string, required): User ID (UUID)

**Query Parameters:**
- `page` (number, optional): Page number for pagination (default: 1)
- `limit` (number, optional): Number of badges per page (default: 50)

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
      "isNotified": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "totalCount": 12,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

**Error Responses:**
- `404 Not Found`: User not found

---

## Quests (The Prologue)

The Prologue is a chaptered, gamified onboarding quest log. Quests are defined
in the backend `QUEST_REGISTRY` (mirroring `ACHIEVEMENT_REGISTRY`) and their
completion is **detected** from real platform activity — never manual
checkboxes. Every completed quest pays a claimable credit reward.

- Completion is evaluated **on read**: `GET /user/quests` records newly-met
  goals before returning (idempotent — already-completed/claimed quests are
  never re-written).
- Only `enabled: true` registry quests are returned; future/unshipped chapters
  (e.g. Pen-dependent rows flagged `dependsOn`) stay hidden.
- Rewards are paid via the existing `addCredits` service with
  `context: 'quest_reward'`, so `transactions` and activity logs attribute the
  source.

### GET /user/quests

Returns the authenticated user's quest log — every enabled quest with its
current progress, status, and reward — plus a summary used to derive the
"N claimable" nav badge.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "success": true,
  "quests": [
    {
      "id": "qs_01_1",
      "chapterId": "ch1",
      "title": "Complete your profile",
      "description": "Who you are makes your stories yours.",
      "rewardCredits": 10,
      "currentProgress": 1,
      "threshold": 1,
      "progressPercent": 100,
      "status": "completed",
      "completedAt": "2026-08-06T00:00:00.000Z",
      "claimedAt": null,
      "enabled": true
    },
    {
      "id": "qs_01_2",
      "chapterId": "ch1",
      "title": "Create your first story with Spark",
      "description": "Feel the magic in thirty seconds.",
      "rewardCredits": 15,
      "currentProgress": 1,
      "threshold": 1,
      "progressPercent": 100,
      "status": "in_progress",
      "completedAt": null,
      "claimedAt": null,
      "enabled": true
    }
  ],
  "summary": {
    "completed": 1,
    "claimable": 1,
    "totalReward": 385,
    "unclaimedReward": 10
  }
}
```

**Notes:**
- `summary.completed` and `summary.claimable` count quests with
  `status === 'completed'` (not yet claimed); the nav badge renders
  `summary.claimable`.
- `summary.totalReward` is the sum of `rewardCredits` across **returned**
  (enabled) quests.

**Error Responses:**
- `500 Internal Server Error`: Failed to fetch the quest log

---

### POST /user/quests/recheck

Explicitly re-evaluates all quests against the user's live data and returns the
ids of any quests newly marked `completed`. Call after events that don't move
`user_counters` (e.g. favoriting a book, following a user, finishing a branch)
when you want the quest log to update without waiting for the next read.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "success": true,
  "newlyCompleted": ["qs_01_6", "qs_05_7"]
}
```

**Notes:**
- `newlyCompleted` lists quest ids whose status flipped to `completed` during
  this call. Empty array means nothing new was met.

**Error Responses:**
- `500 Internal Server Error`: Failed to re-check quests

---

### POST /user/quests/:questId/claim

Atomically claims a completed quest's credit reward and pays the credits via
`addCredits` in the same transaction. The claim is idempotent: a guarded
`UPDATE ... WHERE status = 'completed'` ensures a concurrent double-claim
affects zero rows and returns `already_claimed` instead of paying twice.

**Authentication:** Required (via `requireAuth`)

**Path Parameters:**
- `questId` (string, required): Registry quest id (e.g. `qs_01_2`)

**Response (200 OK — claimed):**
```json
{
  "success": true,
  "questId": "qs_01_2",
  "status": "claimed",
  "creditsAwarded": 15,
  "newBalance": 345
}
```

**Response (400 Bad Request — not yet completed):**
```json
{
  "success": false,
  "questId": "qs_01_4",
  "status": "not_completed",
  "creditsAwarded": 0,
  "newBalance": 330
}
```

**Response (409 Conflict — already claimed):**
```json
{
  "success": false,
  "questId": "qs_01_2",
  "status": "already_claimed",
  "creditsAwarded": 0,
  "newBalance": 345
}
```

**Error Responses:**
- `404 Not Found`: Quest id does not exist in the registry (or is disabled)
- `400 Bad Request`: Quest exists but is not yet completed (`not_completed`)
- `409 Conflict`: Quest reward was already claimed (`already_claimed`)
- `500 Internal Server Error`: Failed to claim the quest reward

**Notes:**
- On success the user's profile cache is invalidated so `CreditsChip` /
  `useUser` reflect the new balance, and a `quest_reward_claimed` activity log
  entry is recorded.

---

### POST /user/quests/claim-all

Atomically claims EVERY currently-completed quest in a single transaction —
the aggregate "Claim all rewards" action in The Prologue. Payout is the sum of
the registry rewards for the claimed quests, applied via **one** `addCredits`
call, so the user gets a single balance bump. Idempotent: with nothing
claimable it returns `status: 'none_claimable'` and no rows are written.

**Authentication:** Required (via `requireAuth`)

**Response (200 OK — claimed):**
```json
{
  "success": true,
  "status": "claimed",
  "claimedCount": 3,
  "creditsAwarded": 45,
  "newBalance": 390
}
```

**Response (200 OK — nothing to claim):**
```json
{
  "success": true,
  "status": "none_claimable",
  "claimedCount": 0,
  "creditsAwarded": 0,
  "newBalance": 390
}
```

**Error Responses:**
- `500 Internal Server Error`: Failed to claim quest rewards

**Notes:**
- On success the user's profile cache is invalidated so `CreditsChip` /
  `useUser` reflect the new aggregate balance, and a single
  `quest_reward_claimed` activity log entry records the batch (`metadata:
  { creditsAwarded, questCount }`).

---

## User Feedback

### POST /user/feedbacks

Submit user feedback with optional screenshot attachment. Screenshots (base64 data URLs) are uploaded to ImageKit and stored in the `uploaded_images` table before the feedback record is created.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "category": "bug_report",
  "message": "The app crashes when I try to open book settings",
  "imageUrl": "data:image/png;base64,iVBORw0KGgo..."
}
```

**Parameters:**
- `category` (string, required): Feedback category (`"feedback"` | `"bug_report"` | `"feature_request"` | `"other"`)
- `message` (string, required): Feedback message content
- `imageUrl` (string, optional): Base64 data URL of screenshot image

**Response (201 Created):**
```json
{
  "feedback": {
    "id": "fb-uuid",
    "userId": "user-uuid",
    "category": "bug_report",
    "message": "The app crashes when I try to open book settings",
    "imageId": "ik_file_id",
    "imageUrl": "https://ik.imagekit.io/...",
    "status": "success",
    "createdAt": "2026-07-10T00:00:00.000Z",
    "updatedAt": "2026-07-10T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid category or missing message

---

## Beta Tester Program

### POST /user/beta-tester

Joins the authenticated user to the beta tester program and awards a one-time credit bonus (`BETA_TESTER_REWARD_CREDITS` = 500).

The join and the reward are atomic (single transaction): the flag claim is an `UPDATE ... WHERE is_beta_tester = false`, so a user can only join — and be rewarded — exactly once, even under concurrent requests. A second attempt returns HTTP `409` with `creditsAwarded: 0`.

**Authentication:** Required (via `requireAuth`)

**Request Body:** None

**Response (201 Created — first join):**
```json
{
  "success": true,
  "message": "Welcome to the beta tester program! 500 credits added",
  "isBetaTester": true,
  "creditsAwarded": 500,
  "credits": 550
}
```

**Response (409 Conflict — already joined):**
```json
{
  "success": false,
  "message": "You are already a beta tester",
  "isBetaTester": true,
  "creditsAwarded": 0,
  "credits": 550
}
```

**Parameters (response):**
- `success` (boolean): Whether the join was newly processed
- `message` (string): Status message
- `isBetaTester` (boolean): Always `true` after this call
- `creditsAwarded` (number): Credits added (500 on first join, 0 if already joined)
- `credits` (number): New credit balance

**Behavior:**
- Logs a `beta_tester_joined` activity entry on first join
- Invalidates the user profile cache and updates the user's last activity timestamp

---

## Platform Testimonials

Platform-wide testimonials are first-party endorsements about the Twistloom
platform itself (as opposed to `bookTestimonials`, which are scoped to a single
book). All CRUD endpoints are **restricted to beta testers** — the backend reads
the generated `users.is_beta_tester` column (SSOT derived from
`beta_tester_joined_at`) and returns `403 Forbidden` for non-beta-testers.

A user can hold **at most one active testimonial** at a time, enforced by a
partial unique index on `user_id` (excluding `rejected` rows, so a rejected
submission can be re-submitted). Submissions start in `pending` and appear
publicly only after admin approval; `status`/`featured` are admin-only fields.

### POST /user/platform-testimonials

Submits a platform-wide testimonial. `content` is required (max 1000 chars); an
optional star `rating` (1–5) may be included.

**Authentication:** Required + **beta tester** (`requireAuth` + isBetaTester)

**Request Body:**
```json
{
  "content": "Twistloom changed the way I think about interactive fiction.",
  "rating": 5
}
```

**Parameters:**
- `content` (string, required): Testimonial message (trimmed, ≤ 1000 characters)
- `rating` (number, optional): Star rating, clamped to an integer between 1 and 5

**Response (201 Created):**
```json
{
  "success": true,
  "testimonial": {
    "id": "uuid",
    "userId": "user-uuid",
    "rating": 5,
    "content": "Twistloom changed the way I think about interactive fiction.",
    "status": "pending",
    "featured": false,
    "createdAt": "2026-08-10T00:00:00.000Z",
    "updatedAt": "2026-08-10T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Missing/empty content, content too long, or invalid rating
- `403 Forbidden`: Not a beta tester
- `409 Conflict`: Already has an active platform testimonial

---

### GET /user/platform-testimonials

Returns the authenticated beta tester's own platform testimonials, newest
first. Own submissions are visible regardless of curation status so the author
can track a pending/approved/rejected submission.

**Authentication:** Required + **beta tester** (`requireAuth` + isBetaTester)

**Response (200 OK):**
```json
{
  "success": true,
  "testimonials": [
    {
      "id": "uuid",
      "userId": "user-uuid",
      "rating": 5,
      "content": "Twistloom changed the way I think about interactive fiction.",
      "status": "approved",
      "featured": true,
      "createdAt": "2026-08-10T00:00:00.000Z",
      "updatedAt": "2026-08-11T00:00:00.000Z"
    }
  ]
}
```

**Error Responses:**
- `403 Forbidden`: Not a beta tester

---

### PATCH /user/platform-testimonials/:id

Updates the authenticated beta tester's own platform testimonial. Only
`content` and/or `rating` are updatable; `status`/`featured` are admin-only.
Partial update semantics — omitted fields keep their current value. Editing an
already-approved submission returns it to `pending` for re-review.

**Authentication:** Required + **beta tester** (`requireAuth` + isBetaTester)

**Path Parameters:**
- `id` (string, required): The testimonial's UUID

**Request Body:**
```json
{
  "content": "Updated testimonial text."
}
```

**Parameters:**
- `content` (string, optional): New testimonial message (≤ 1000 characters)
- `rating` (number|null, optional): New star rating (1–5) or `null` to clear it

**Response (200 OK):**
```json
{
  "success": true,
  "testimonial": {
    "id": "uuid",
    "userId": "user-uuid",
    "rating": 5,
    "content": "Updated testimonial text.",
    "status": "pending",
    "featured": false,
    "createdAt": "2026-08-10T00:00:00.000Z",
    "updatedAt": "2026-08-12T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request`: No updatable field provided, invalid content/rating
- `403 Forbidden`: Not a beta tester
- `404 Not Found`: Testimonial not found (or belongs to another user)

---

### DELETE /user/platform-testimonials/:id

Deletes the authenticated beta tester's own platform testimonial.

**Authentication:** Required + **beta tester** (`requireAuth` + isBetaTester)

**Path Parameters:**
- `id` (string, required): The testimonial's UUID

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Platform testimonial deleted"
}
```

**Error Responses:**
- `403 Forbidden`: Not a beta tester
- `404 Not Found`: Testimonial not found (or belongs to another user)

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
  - `public, max-age=60, stale-while-revalidate=30` for public user profiles (`GET /users/:identifier`) — cache is only applied for guest viewers; skipped when authenticated
  - `public, max-age=1800, stale-while-revalidate=300` for top creators (`GET /users/top-creators`)

---

## Caching Strategy

The API implements multi-level caching for performance:
- **In-memory caching**: User profiles via `withCache()` utility using configurable TTL
- **HTTP caching**: Public user profiles support CDN/edge caching with Cache-Control headers
- **Cache invalidation**: Automatic invalidation on profile updates, likes, favorites, follows, and check-ins

**Cache TTLs:**
- User profile: 5 minutes (configurable via `CACHE_TTL.USER_PROFILE`)
- Top creators (`GET /users/top-creators`): 30 minutes (via `CACHE_TTL.THIRTY_MINUTES`, keyed by `users:top-creators:{limit}`)

**Notes:**
- `GET /users/:identifier` now uses `optionalAuth` (was no middleware). When the viewer is authenticated, the cache is skipped to return fresh `isFollowing` data.
- `GET /users/:id/achievements` is not cached (always fetches fresh).
- `GET /users/top-creators` is cached server-side (30 min) plus CDN/edge (Cache-Control). The weekly window changes slowly, so a 30-minute TTL is safe. It is not actively invalidated on book creation — new creators appear within the TTL window.

**Invalidation Triggers:**
- Profile update (PUT /user): Invalidates `user:{userId}:profile`
- Onboarding (POST /user): Invalidates profile cache
- Like/unlike (book target): Invalidates explore cache, user books cache, and profile cache
- Favorite/unfavorite: Invalidates profile cache (savedBooksCount)
- Follow/unfollow: Invalidates profile cache (followersCount)
- Daily check-in: Invalidates profile cache (credits changed)
- Quest reward claim (`POST /user/quests/:questId/claim`): Invalidates profile cache (credits changed)
- `GET /user/quests` is `requireAuth` per-user data that changes on real activity — it uses the React Query `staleTime` on the client and is **not** HTTP-cached.

---

## Authentication

Endpoints use three middleware types:

- `requireAuth`: Requires valid authentication — returns 401 if not authenticated
- `optionalAuth`: Attaches user info if cookie is present, continues silently for guests
- No middleware: Public access (follower lists, public achievements)

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

### User Feedbacks Table
```sql
CREATE TABLE "user_feedbacks" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "category" text NOT NULL, -- "feedback" | "bug_report" | "feature_request" | "other"
  "message" text NOT NULL,
  "image_id" text,
  "image_url" text,
  "status" text NOT NULL DEFAULT 'idle', -- "idle" | "submitting" | "success" | "error"
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

**Indexes:**
- `user_feedbacks_user_idx`: (user_id)
- `user_feedbacks_category_idx`: (category)
- `user_feedbacks_created_idx`: (created_at DESC)

---

### User Quests Table
```sql
CREATE TABLE "user_quests" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "quest_id" text NOT NULL, -- links to QUEST_REGISTRY ids (e.g. "qs_01_2")
  "status" text NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'completed' | 'claimed'
  "completed_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("user_id", "quest_id")
);
```

**Indexes:**
- `user_quests_user_quest_unique`: (user_id, quest_id)
- `user_quests_user_idx`: (user_id)
- `user_quests_status_idx`: (status)

---

### Platform Testimonials Table
```sql
CREATE TABLE "platform_testimonials" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "rating" integer,
  "content" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending', -- "pending" | "approved" | "rejected"
  "featured" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

**Indexes:**
- `platform_testimonials_status_idx`: (status)
- `platform_testimonials_featured_idx`: (featured, created_at DESC)
- `platform_testimonials_user_idx`: (user_id, created_at DESC)
- `platform_testimonials_user_active_unique` (partial unique): (user_id) WHERE status <> 'rejected' — enforces one active testimonial per beta tester

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

**Get top creators this week (homepage "Creators writing this week" section):**
```bash
curl "https://api.twistloom.com/api/user/users/top-creators?limit=10"
```

**Get quest log ("The Prologue"):**
```bash
curl https://api.twistloom.com/api/user/quests \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Re-check quest completion (after non-counter events like favoriting/following):**
```bash
curl -X POST https://api.twistloom.com/api/user/quests/recheck \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Claim a quest reward:**
```bash
curl -X POST https://api.twistloom.com/api/user/quests/qs_01_2/claim \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
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

**Set referrer (via complete onboarding):**
```bash
curl -X POST https://api.twistloom.com/api/user \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "referrer": "johndoe"
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

**Submit feedback (text only):**
```bash
curl -X POST https://api.twistloom.com/api/user/feedbacks \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "category": "bug_report",
    "message": "The app crashes when I open book settings"
  }'
```

**Submit feedback (with screenshot):**
```bash
curl -X POST https://api.twistloom.com/api/user/feedbacks \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "category": "bug_report",
    "message": "UI broken on editor screen",
    "imageUrl": "data:image/png;base64,iVBORw0KGgo..."
  }'
```

**Submit a platform testimonial (beta testers only):**
```bash
curl -X POST https://api.twistloom.com/api/user/platform-testimonials \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{
    "content": "Twistloom changed the way I think about interactive fiction.",
    "rating": 5
  }'
```

**Get own platform testimonials (beta testers only):**
```bash
curl https://api.twistloom.com/api/user/platform-testimonials \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

**Update own platform testimonial (beta testers only):**
```bash
curl -X PATCH https://api.twistloom.com/api/user/platform-testimonials/uuid \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -d '{ "content": "Updated testimonial text." }'
```

**Delete own platform testimonial (beta testers only):**
```bash
curl -X DELETE https://api.twistloom.com/api/user/platform-testimonials/uuid \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

---

## Changelog

### v3.10.0 (2026-08-12)
- Added `avatarFrame` to the `User`, `FollowUser`, and `TopCreator` type definitions — the user's achievement tier key (`bronze` | `silver` | `gold` | `platinum`) rendered as an avatar frame; `null`/absent when the user has no frame
- `avatarFrame` is now returned on every user profile payload: `GET /user`, `GET /users/:identifier`, `GET /users/top-creators`, and all four follow-list endpoints (`GET /users/:id/followers`, `GET /users/:id/following`, `GET /user/followers`, `GET /user/following`)
- `PUT /user` now accepts an optional `avatarFrame` request parameter (string tier key, or `null`/empty to clear); updated request-body example
- All user-profile response examples updated to include the field

### v3.9.0 (2026-08-10)
- Added the Platform Testimonials section with four endpoints — all restricted to **beta testers** (the backend reads the generated `users.is_beta_tester` column and returns `403 Forbidden` otherwise):
  - `POST /user/platform-testimonials` — submits a platform-wide testimonial (`content` required ≤ 1000 chars, optional `rating` 1–5); returns `409 Conflict` if the user already has an active testimonial
  - `GET /user/platform-testimonials` — lists the user's own testimonials, newest first (all statuses visible to the author)
  - `PATCH /user/platform-testimonials/:id` — updates own testimonial (`content`, `rating`); editing returns it to `pending` for re-review
  - `DELETE /user/platform-testimonials/:id` — deletes own testimonial
- Added `PlatformTestimonial` type definition (`id`, `userId`, `rating`, `content`, `status`, `featured`, `createdAt`, `updatedAt`)
- Added the `platform_testimonials` database table with a partial unique index enforcing one active submission per beta tester (rejected rows excluded so a user can re-submit)
- Added cURL examples and a database schema entry

### v3.8.0 (2026-08-08)
- Added `POST /user/quests/claim-all` — atomically claims **every completed quest** in one transaction, pays a single aggregate balance via `addCredits` (sum of the claimed quests' registry rewards), and records one `quest_reward` batch activity log. Idempotent: with nothing claimable it returns `{ status: 'none_claimable', claimedCount: 0, creditsAwarded: 0 }` and performs no writes. Invalidates the profile cache on success for the `CreditsChip`/`useUser` refresh.

### v3.7.0 (2026-08-06)
- Added the Quests ("The Prologue") section with three endpoints:
  - `GET /user/quests` — returns the full quest log (enabled quests only) plus a `summary` (`completed`, `claimable`, `totalReward`, `unclaimedReward`) powering the nav badge
  - `POST /user/quests/recheck` — explicitly re-evaluates all quests and returns newly-completed quest ids
  - `POST /user/quests/:questId/claim` — atomically claims a completed quest's credit reward (`200` claimed, `400` not-completed, `409` already-claimed, `404` unknown/disabled quest)
- Added `UserQuest` and `QuestsSummary` type definitions, documenting the `QuestStatus` lifecycle (`in_progress` → `completed` → `claimed`)
- Quest completion is detected from real platform activity (evaluate-on-read against `user_counters` and derived aggregates); rewards pay via `addCredits` with `context: 'quest_reward'` inside the claim transaction, invalidating the profile cache afterwards

### v3.6.0 (2026-08-06)
- Added `POST /user/beta-tester` documentation — joins the authenticated user to the beta tester program, awarding a one-time 500 credit bonus
- Atomic first-join claim (`UPDATE ... WHERE is_beta_tester = false`); returns 201 on first join and 409 with `creditsAwarded: 0` on repeat attempts
- Added Beta Tester Program section, response parameters, and behavior notes (activity log, profile cache invalidation)

### v3.5.0 (2026-08-05)
- Added `GET /users/top-creators` public endpoint — returns the users who created the most public books (`status='active'`, `visibility='public'`) in the last 7 days, powers the homepage "Creators writing this week" section
- Added `TopCreator` type definition (`userId`, `name`, `username`, `imageUrl`, `booksCreated`)
- Accepts optional `limit` query param (default: 10, clamped to 1–50); results ordered by `booksCreated` desc
- Added Creator Discovery section, HTTP Cache-Control docs, cURL example, and caching strategy entry (30-min server TTL keyed by `users:top-creators:{limit}`)

### v3.4.1 (2026-08-05)
- **Docs correction:** referrer attribution is set via `POST /user` (complete onboarding) or `POST /auth/signup` — **not** via `PUT /user`. Updated the Referral System section, `POST /user` parameters, `PUT /user` parameters, cURL example, and deprecation message accordingly.
- Clarified referral eligibility: the referrer's email must be verified, and credit payout is deferred until the referred user verifies their email.

### v3.4.0 (2026-07-21)
- Changed `GET /users/:identifier` auth from no middleware to `optionalAuth` — returns `isFollowing` field when viewer is authenticated
- Added `isFollowing` field to `User` type (optional boolean)
- Added `GET /users/:id/achievements` public endpoint for viewing another user's unlocked badges
- Updated caching: cache is skipped for `GET /users/:identifier` when viewer is authenticated
- Updated authentication section: `GET /users/:identifier` moved to `optionalAuth`

### v3.3.0 (2026-07-10)
- Added POST /user/feedbacks endpoint (submit user feedback with optional screenshot)
- Added Feedback type definition (`category`, `message`, `imageId`, `imageUrl`, `status`)
- Added `feedback_screenshot` type to UploadedImageType enum
- Added `user_feedbacks` database table with indexes on user_id, category, created_at
- Updated API documentation with User Feedback section

### v3.2.0 (2026-07-04)
- Added `referrer` field support to PUT /user — sets referrer for new users without a referrer
- Deprecated POST /user/referrer — returns 410 Gone
- Updated documentation to reflect PUT /user as the canonical way to set a referrer

> **Correction (see v3.4.1):** the `referrer` field on `PUT /user` was later found to be inert/rejected. The canonical paths are `POST /auth/signup` and `POST /user` (complete onboarding).

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
