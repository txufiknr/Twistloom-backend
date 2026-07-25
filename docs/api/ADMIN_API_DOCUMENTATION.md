# Admin API Documentation

## Overview

The Admin API provides privileged, system-level endpoints for debugging, system
health checks, content curation, and platform management. All mutation and read
endpoints described here require authentication via NextAuth JWT.

**Base URL:** `/api/admin`

**Authentication model (two tiers):**
- **`requireAdmin`** — the user must be authenticated **and** present in the
  `admin_users` table (or match `SYSTEM_USER_ID`). Used for day-to-day curation
  and management.
- **`requireSuperAdmin`** — the user must be authenticated **and** match
  `process.env.SYSTEM_USER_ID`. Used for privileged operations: managing other
  admins and sending email announcements.

**Architecture:**
- `requireAuth` attaches `c.set("userId", ...)` from the NextAuth session.
- `requireAdmin` checks `admin_users` table + falls back to `SYSTEM_USER_ID`.
- `requireSuperAdmin` compares only against `process.env.SYSTEM_USER_ID`.
- All handlers are wrapped with `wrapAsync` so promise rejections route to the
  central error handler instead of crashing the process.

---

## Table of Contents

1. [System](#system)
   - [System Health](#get-apiaadmin-systemhealth)
2. [Story Debugging](#story-debugging)
   - [Reconstruction Debug](#get-apiaadminbooksbookidreconstructionpageid)
3. [Social Mentions (Admin)](#social-mentions-admin)
   - [List Mentions](#get-apiaadminsocial-mentions)
   - [Get Mention](#get-apiaadminsocial-mentionsid)
   - [Create Mention](#post-apiaadminsocial-mentions)
   - [Update Mention](#patch-apiaadminsocial-mentionsid)
   - [Delete Mention](#delete-apiaadminsocial-mentionsid)
   - [Bulk Update Status](#post-apiaadminsocial-mentionsbulk-status)
4. [Book Testimonials (Admin)](#book-testimonials-admin)
   - [List Testimonials](#get-apiaadmintestimonials)
   - [Update Testimonial](#patch-apiaadmintestimonialsid)
   - [Bulk Update Testimonial Status](#post-apiaadmintestimonialsbulk-status)
5. [Admin Users (Super Admin)](#admin-users-super-admin)
   - [List Admins](#get-apiaadminadmins)
   - [Create Admin](#post-apiaadminadmins)
   - [Delete Admin](#delete-apiaadminadminsuserid)
6. [Usage Chart](#usage-chart)
   - [Get Usage Chart Data](#get-apiaadminusagechart)
7. [Email Announcements (Super Admin)](#email-announcements-super-admin)
   - [Send Announcement](#post-apiaadminemailannouncements)
8. [User Feedbacks](#user-feedbacks)
   - [List Feedbacks](#get-apiaadminfeedbacks)
   - [Update Feedback Status](#patch-apiaadminfeedbacksid)
9. [Books (Admin)](#books-admin)
   - [List Books](#get-apiaadminbooks)
10. [Platform Users](#platform-users)
    - [List Users](#get-apiaadminusers)
11. [Social Mentions (Public)](#social-mentions-public)
    - [Public Wall](#get-apisocial-mentions)
    - [Public Single Mention](#get-apisocial-mentionsid)

---

## System

### GET /api/admin/system/health

Returns basic system health metrics for monitoring. This endpoint requires
authentication but **not** admin privileges (any valid session can call it).

**Authentication:** `requireAuth`

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2026-07-19T12:00:00.000Z",
  "services": {
    "database": "connected",
    "snapshots": "active",
    "reconstruction": "functional"
  },
  "metrics": {
    "uptime": 12345.67,
    "memoryUsage": {
      "rss": 12345678,
      "heapTotal": 9876543,
      "heapUsed": 5432198,
      "external": 123456
    },
    "nodeVersion": "v22.0.0"
  }
}
```

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `500 Internal Server Error`: Server error

---

## Story Debugging

### GET /api/admin/books/:bookId/reconstruction/:pageId

Debug endpoint to test the story-state reconstruction pipeline for a specific
page. Forces a fresh reconstruction (no cache) and validates the path. Used to
diagnose branch traversal and snapshot consistency.

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId`  | UUID | Book identifier |
| `pageId`  | UUID | Page identifier to reconstruct |

**Response (200 OK):**
```json
{
  "bookId": "book-uuid",
  "pageId": "page-uuid",
  "reconstruction": {
    "storyState": { },
    "method": "reconstruct",
    "deltasApplied": 5,
    "pathValid": true,
    "durationMs": 42
  }
}
```

**Error Responses:**
- `400 Bad Request`: `bookId` and `pageId` are required
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `500 Internal Server Error`: Reconstruction failed

---

## Social Mentions

The social-mentions subsystem powers the public "readers are talking about
Twistloom" wall. Raw items are ingested by the weekly cron as `pending`, then
curated here. The public homepage should only display rows where
`status = 'approved'` **and** `featured = true`.

### Data Model

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Primary key (`uuidv7()`) |
| `platform` | string | `reddit`, `hackernews`, `github`, `bluesky`, or a hostname |
| `author` | string | Author handle |
| `authorAvatar` | string \| null | Avatar URL when available |
| `title` | string \| null | Post title or synthesized label |
| `content` | string | Normalized post body (HTML stripped) |
| `url` | string | Canonical source URL (unique) |
| `score` | integer | Platform engagement (upvotes/likes) |
| `sentimentScore` | real | `-1.0`..`1.0` |
| `relevanceScore` | real | Local heuristic priority score |
| `status` | enum | `pending` \| `approved` \| `rejected` |
| `featured` | boolean | Elevated to the homepage wall by an admin |
| `publishedAt` | timestamptz \| null | Original post time |
| `relatedBookId` | UUID \| null | Linked book (D4) |
| `relatedPageId` | UUID \| null | Linked page within book (D4) |
| `relatedBookSource` | string \| null | `"auto"` \| `"admin"` |
| `createdAt` / `updatedAt` | timestamptz | Bookkeeping |

### GET /api/admin/social-mentions

Lists social mentions for the curation queue. Supports filtering by status,
platform, and linked state, plus pagination. Ordered by `relevanceScore` DESC
then `publishedAt` DESC so the best candidates surface first.

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter  | Type    | Description |
|-----------|---------|-------------|
| `status`  | string  | Optional: `pending` \| `approved` \| `rejected` |
| `platform` | string | Optional, e.g. `reddit` \| `hackernews` \| `github` \| `bluesky` |
| `linked`  | string  | Optional: `"true"` \| `"false"` \| `"auto"` \| `"admin"` |
| `limit`   | integer | Max rows (default `50`, max `200`) |
| `offset`  | integer | Rows to skip (default `0`) |

**Response (200 OK):**
```json
{
  "total": 137,
  "limit": 50,
  "offset": 0,
  "mentions": [
    {
      "id": "0194f2d1-...",
      "platform": "reddit",
      "author": "u/bookworm",
      "authorAvatar": null,
      "title": "Twistloom generated the best thriller I've read",
      "content": "I've tried AI Dungeon and NovelAI, but Twistloom...",
      "url": "https://www.reddit.com/r/...",
      "score": 236,
      "sentimentScore": 0.8,
      "relevanceScore": 95,
      "status": "pending",
      "featured": false,
      "publishedAt": "2026-07-15T09:30:00.000Z",
      "createdAt": "2026-07-19T06:00:00.000Z",
      "updatedAt": "2026-07-19T06:00:00.000Z"
    }
  ]
}
```

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `500 Internal Server Error`: Server error

### GET /api/admin/social-mentions/:id

Retrieves a single social mention by id.

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Response (200 OK):** A single mention object (same shape as in the list).

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `404 Not Found`: Mention not found
  ```json
  { "error": "Social mention not found" }
  ```
- `500 Internal Server Error`: Server error

### POST /api/admin/social-mentions

Manually creates a curated mention (e.g. pasted from X, a blog review, or a
user submission). Flows through the same curation queue as auto-ingested items.
Deduplicated by `url` — re-submitting an existing URL returns `400`.

**Authentication:** `requireAuth` + `requireAdmin`

**Request Body:**
```json
{
  "platform": "x",
  "author": "@johndoe",
  "content": "Twistloom made me cry at 3am.",
  "url": "https://x.com/johndoe/status/123",
  "title": "Best thriller ever",
  "authorAvatar": "https://...",
  "score": 143,
  "sentimentScore": 0.9,
  "relevanceScore": 88,
  "status": "pending",
  "featured": false,
  "publishedAt": "2026-07-10T12:00:00.000Z",
  "relatedBookUrl": "https://twistloom.com/books/slug",
  "relatedBookId": "book-uuid",
  "relatedPageId": "page-uuid"
}
```

**Response (201 Created):** The created mention object.

**Error Responses:**
- `400 Bad Request`: Missing required fields (`platform`, `author`, `content`, `url`)
- `400 Bad Request`: Invalid `status` value
- `400 Bad Request`: URL already exists (dedup)
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `500 Internal Server Error`: Server error

### PATCH /api/admin/social-mentions/:id

Updates curation fields of a mention. Supports direct book linkage via
`relatedBookId`, `relatedPageId`, or a Twistloom product URL via `relatedBookUrl`.

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Request Body (all fields optional):**
```json
{
  "status": "approved",
  "featured": true,
  "relevanceScore": 95,
  "sentimentScore": 0.8,
  "title": "Edited title",
  "content": "Edited body",
  "relatedBookId": "book-uuid",
  "relatedPageId": "page-uuid",
  "relatedBookUrl": "https://twistloom.com/books/slug",
  "clearRelatedBook": false
}
```

**Response (200 OK):** The updated mention object.

**Error Responses:**
- `400 Bad Request`: Invalid `status` value
- `400 Bad Request`: `relatedBookUrl` is not a valid Twistloom URL
- `400 Bad Request`: `relatedBookId` does not match an existing book
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `404 Not Found`: Mention not found
- `500 Internal Server Error`: Server error

**Curation Pattern:**
To publish on the homepage, set both `status: "approved"` and `featured: true`.
`status = "rejected"` removes it from consideration without deleting the row.

### DELETE /api/admin/social-mentions/:id

Permanently deletes a single mention (e.g. spam outside the approve/reject flow).

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Response (200 OK):**
```json
{
  "success": true,
  "id": "0194f2d1-..."
}
```

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `404 Not Found`: Mention not found
- `500 Internal Server Error`: Server error

### POST /api/admin/social-mentions/bulk-status

Bulk-updates the `status` of multiple mentions in one request (e.g. approve or
reject a whole page of the queue). Only the `status` field is mutated.

**Authentication:** `requireAuth` + `requireAdmin`

**Request Body:**
```json
{
  "ids": ["0194f2d1-...", "0194f2d2-..."],
  "status": "approved"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "updated": 2
}
```

**Error Responses:**
- `400 Bad Request`: `ids` must be a non-empty array
- `400 Bad Request`: Invalid `status` value
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not an admin user
- `500 Internal Server Error`: Server error

---

## Book Testimonials (Admin)

Curate user-submitted book testimonials. Moderation fields: `status` and
`featured`.

### GET /api/admin/testimonials

Lists all book testimonials. Supports filtering by status and pagination.

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter | Type    | Description |
|-----------|---------|-------------|
| `status`  | string  | Optional: `pending` \| `approved` \| `rejected` |
| `limit`   | integer | Max rows (default `50`, max `200`) |
| `offset`  | integer | Rows to skip (default `0`) |

**Response (200 OK):**
```json
{
  "total": 42,
  "limit": 50,
  "offset": 0,
  "testimonials": [
    {
      "id": "0194f2d1-...",
      "bookId": "book-uuid",
      "userId": "user-uuid",
      "author": "Reader",
      "content": "An incredible experience.",
      "rating": 5,
      "status": "pending",
      "featured": false,
      "createdAt": "2026-07-19T06:00:00.000Z",
      "updatedAt": "2026-07-19T06:00:00.000Z"
    }
  ]
}
```

### PATCH /api/admin/testimonials/:id

Updates moderation fields of a testimonial.

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Testimonial identifier |

**Request Body (all fields optional):**
```json
{
  "status": "approved",
  "featured": true
}
```

**Response (200 OK):** The updated testimonial object.

### POST /api/admin/testimonials/bulk-status

Bulk-updates the status of multiple testimonials.

**Authentication:** `requireAuth` + `requireAdmin`

**Request Body:**
```json
{
  "ids": ["id-1", "id-2"],
  "status": "approved"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "updated": 2
}
```

---

## Admin Users (Super Admin)

Manage which users have access to the admin panel. Requires `requireSuperAdmin`.

### GET /api/admin/admins

Lists all admin users. Returns the `admin_users` table rows.

**Authentication:** `requireAuth` + `requireSuperAdmin`

**Response (200 OK):**
```json
{
  "admins": [
    {
      "userId": "user-uuid",
      "email": "admin@example.com",
      "invitedBy": "super-admin-uuid",
      "createdAt": "2026-07-01T00:00:00.000Z"
    }
  ]
}
```

### POST /api/admin/admins

Invites a new admin user. Provide either `userId` (UUID) or `email`.

**Authentication:** `requireAuth` + `requireSuperAdmin`

**Request Body:**
```json
{
  "userId": "user-uuid",
  "email": "user@example.com"
}
```

**Response (201 Created):** The created admin user row.

**Error Responses:**
- `400 Bad Request`: Neither `userId` nor `email` provided
- `400 Bad Request`: User is already an admin
- `403 Forbidden`: Not the super admin

### DELETE /api/admin/admins/:userId

Removes an admin user by their user ID.

**Authentication:** `requireAuth` + `requireSuperAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `userId` | UUID | User identifier to remove |

**Response (200 OK):**
```json
{
  "success": true,
  "userId": "user-uuid"
}
```

**Error Responses:**
- `404 Not Found`: Admin not found

---

## Usage Chart

### GET /api/admin/usage/chart

Returns aggregated AI usage data for charting. Supports date range, provider
filter, and granularity (data is stored per-day; week/month granularity is
computed client-side).

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter  | Type   | Description |
|-----------|--------|-------------|
| `from`    | string | Start date (ISO, default: 30 days ago) |
| `to`      | string | End date (ISO, default: today) |
| `provider`| string | Optional provider filter (e.g. `"openai"`, `"anthropic"`) |

**Response (200 OK):**
```json
{
  "from": "2026-06-19T00:00:00.000Z",
  "to": "2026-07-19T00:00:00.000Z",
  "records": [
    {
      "id": "0194f2d1-...",
      "date": "2026-07-19",
      "provider": "openai",
      "model": "gpt-4o",
      "tokensIn": 15000,
      "tokensOut": 3200,
      "costUsd": 0.042,
      "requestCount": 12,
      "latencyAvgMs": 850
    }
  ]
}
```

---

## Email Announcements (Super Admin)

### POST /api/admin/email/announcements

Sends a product announcement email to all opted-in users
(`emailPreferences.productAnnouncements === true`). Supports a dry-run mode to
preview recipient count before sending.

**Authentication:** `requireAuth` + `requireSuperAdmin`

**Request Body:**
```json
{
  "title": "New feature: co-author mode",
  "bodyHtml": "<h1>We're excited to announce...</h1><p>...</p>",
  "cta": {
    "url": "https://twistloom.com/coauthor",
    "text": "Try it now"
  },
  "dryRun": false
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "title": "New feature: co-author mode",
  "recipientCount": 1240,
  "sent": 1240,
  "failed": 0
}
```

When `dryRun: true`:
```json
{
  "dryRun": true,
  "recipientCount": 1240,
  "title": "New feature: co-author mode"
}
```

**Error Responses:**
- `400 Bad Request`: `title` is required
- `400 Bad Request`: `bodyHtml` is required
- `403 Forbidden`: Not the super admin

---

## User Feedbacks

### GET /api/admin/feedbacks

Lists user-submitted feedbacks. Supports filtering by status and category, plus
pagination. Joins with the `users` table to include user name/email.

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter  | Type    | Description |
|-----------|---------|-------------|
| `status`  | string  | Optional: `idle` \| `submitting` \| `success` \| `error` |
| `category`| string  | Optional: `feedback` \| `bug_report` \| `feature_request` \| `other` |
| `limit`   | integer | Max rows (default `50`, max `200`) |
| `offset`  | integer | Rows to skip (default `0`) |

**Response (200 OK):**
```json
{
  "total": 24,
  "limit": 50,
  "offset": 0,
  "feedbacks": [
    {
      "id": "0194f2d1-...",
      "userId": "user-uuid",
      "category": "bug_report",
      "message": "The branching UI crashes when...",
      "status": "idle",
      "imageUrl": null,
      "createdAt": "2026-07-19T06:00:00.000Z",
      "updatedAt": "2026-07-19T06:00:00.000Z",
      "userName": "John Doe",
      "userEmail": "john@example.com"
    }
  ]
}
```

### PATCH /api/admin/feedbacks/:id

Updates the status of a user feedback (e.g. mark as resolved).

**Authentication:** `requireAuth` + `requireAdmin`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Feedback identifier |

**Request Body:**
```json
{
  "status": "success"
}
```

**Response (200 OK):** The updated feedback row.

**Error Responses:**
- `400 Bad Request`: Invalid `status` value
- `404 Not Found`: Feedback not found

---

## Books (Admin)

### GET /api/admin/books

Lists original books with key metrics. Supports pagination and title/slug search.

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter  | Type    | Description |
|-----------|---------|-------------|
| `search`  | string  | Optional search term (matches title or slug) |
| `limit`   | integer | Max rows (default `50`, max `200`) |
| `offset`  | integer | Rows to skip (default `0`) |

**Response (200 OK):**
```json
{
  "total": 18,
  "limit": 50,
  "offset": 0,
  "books": [
    {
      "id": "book-uuid",
      "title": "Echoes of Tomorrow",
      "slug": "echoes-of-tomorrow",
      "status": "active",
      "visibility": "public",
      "isOriginal": true,
      "language": "en",
      "readCount": 1240,
      "totalPages": 42,
      "branchesCount": 8,
      "likesCount": 89,
      "createdAt": "2026-06-01T00:00:00.000Z",
      "updatedAt": "2026-07-19T00:00:00.000Z"
    }
  ]
}
```

---

## Platform Users

### GET /api/admin/users

Lists platform users for management. Supports search (name, email, username)
and pagination.

**Authentication:** `requireAuth` + `requireAdmin`

**Query Parameters:**
| Parameter  | Type    | Description |
|-----------|---------|-------------|
| `search`  | string  | Optional search term (matches name, email, or username) |
| `limit`   | integer | Max rows (default `50`, max `200`) |
| `offset`  | integer | Rows to skip (default `0`) |

**Response (200 OK):**
```json
{
  "total": 5430,
  "limit": 50,
  "offset": 0,
  "users": [
    {
      "userId": "user-uuid",
      "name": "John Doe",
      "username": "johndoe",
      "email": "john@example.com",
      "tier": "hobbyist",
      "credits": 1400.0,
      "isNewUser": false,
      "lastActive": "2026-07-18T14:30:00.000Z",
      "createdAt": "2026-01-15T00:00:00.000Z"
    }
  ]
}
```

---

## Social Mentions (Public)

The curated social-proof wall is served by a **separate, unauthenticated** router
mounted at `/api/social-mentions` (see `src/routes/social-mentions.ts`). These
endpoints power the public homepage and require **no auth**. They return only
items where `status = 'approved'` **and** `featured = true`.

The wall unifies two streams:
- `social` — third-party posts scraped by the ingestion cron (`socialMentions`)
- `user` — first-party reader testimonials (`bookTestimonials`, submitted after
  finishing a book)

Each returned row is tagged with a `source` field (`"social"` | `"user"`) so the
frontend can render the appropriate card style.

### GET /api/social-mentions

Lists the featured social-proof wall. Use the `source` query param to scope the
result (default `all`). Within each stream, ordering follows the same curation
priority as the admin queue; the combined result is ordered by `relevanceScore`
DESC then `createdAt` DESC.

**Authentication:** None (public)

**Query Parameters:**
| Parameter | Type    | Description |
|-----------|---------|-------------|
| `source`  | string  | Stream scope: `all` (default) \| `social` \| `user` |
| `page`    | integer | 1-based page (default `1`) — enables lazy loading |
| `limit`   | integer | Max rows per page (default `20`, max `100`) |

**Response (200 OK):** (unchanged — see existing section in prior doc version for full shape)

**Error Responses:**
- `500 Internal Server Error`: Server error

### GET /api/social-mentions/:id

Public single-item lookup for the wall. Same visibility rules (approved +
featured), across both streams.

**Authentication:** None (public)

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Item identifier (social mention or testimonial) |

**Error Responses:**
- `404 Not Found`: Item not found or not public (not approved+featured)
- `500 Internal Server Error`: Server error

---

## Security Architecture

### Authorization Model

- **`requireAuth`**: validates the NextAuth JWT cookie, attaches `c.set("userId", ...)`.
- **`requireAdmin`**: checks `admin_users` table for the authenticated user; also
  falls back to `process.env.SYSTEM_USER_ID` for backward compatibility. Any
  mismatch → `403 Forbidden`.
- **`requireSuperAdmin`**: compares `req.userId` to `process.env.SYSTEM_USER_ID`
  (the original single fixed admin). No DB fallback.
- This is defense-in-depth on top of `requireAuth`. The `admin_users` table
  allows multiple admins without sharing a single user account.

### Required Environment Variables

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `SYSTEM_USER_ID` | UUID of the super admin that authorizes super-admin routes | Your DB `users.id` for the super admin account |
| `DATABASE_URL` | Write DB connection used by all admin routes | [Neon Console](https://console.neon.tech) |
| `DATABASE_READ_URL` | Read DB connection (falls back to `DATABASE_URL`) | Same as `DATABASE_URL` |
| `AUTH_SECRET` | NextAuth session signing required by `requireAuth` | `openssl rand -base64 32` |

For the full variable/API-key table (including `BRAVE_SEARCH_API_KEY` and GitHub
Actions secrets), see [Social Mentions Architecture → Environment Variables & API Keys](../architecture/SOCIAL_MENTIONS_ARCHITECTURE.md#environment-variables--api-keys).

### Error Format

All errors follow a consistent shape:
```json
{
  "error": "Human-readable message"
}
```

In development mode, additional `details` may be included.

### Rate Limiting

No dedicated rate limiting is applied to admin endpoints — they are intended for
low-frequency, single-operator use behind authentication + authorization.

---

## Testing Examples

### Approve and feature a mention for the homepage
```bash
curl -X PATCH http://localhost:3000/api/admin/social-mentions/0194f2d1-xxxx \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "approved", "featured": true }'
```

### List the pending queue
```bash
curl -X GET "http://localhost:3000/api/admin/social-mentions?status=pending&limit=20" \
  -H "Cookie: next-auth.session-token=..."
```

### Bulk-reject a batch
```bash
curl -X POST http://localhost:3000/api/admin/social-mentions/bulk-status \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{ "ids": ["id-1", "id-2"], "status": "rejected" }'
```

### Manually create a curated mention
```bash
curl -X POST http://localhost:3000/api/admin/social-mentions \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "x",
    "author": "@reader",
    "content": "Twistloom surprised me with its ending.",
    "url": "https://x.com/reader/status/999"
  }'
```

### Testimonial management
```bash
curl -X PATCH http://localhost:3000/api/admin/testimonials/id-1 \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "approved", "featured": true }'
```

### Admin user management (super admin only)
```bash
# List admins
curl http://localhost:3000/api/admin/admins \
  -H "Cookie: next-auth.session-token=<super-admin>"

# Add admin
curl -X POST http://localhost:3000/api/admin/admins \
  -H "Cookie: next-auth.session-token=<super-admin>" \
  -H "Content-Type: application/json" \
  -d '{ "email": "newadmin@example.com" }'

# Remove admin
curl -X DELETE http://localhost:3000/api/admin/admins/user-uuid \
  -H "Cookie: next-auth.session-token=<super-admin>"
```

### Usage chart
```bash
curl "http://localhost:3000/api/admin/usage/chart?from=2026-06-01&to=2026-07-19&provider=openai" \
  -H "Cookie: next-auth.session-token=..."
```

### Send announcement (super admin only)
```bash
curl -X POST http://localhost:3000/api/admin/email/announcements \
  -H "Cookie: next-auth.session-token=<super-admin>" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Test", "bodyHtml": "<p>Hello</p>", "dryRun": true }'
```

### Non-admin rejection (expected 403)
```bash
curl -X PATCH http://localhost:3000/api/admin/social-mentions/0194f2d1-xxxx \
  -H "Cookie: next-auth.session-token=<non-admin>" \
  -H "Content-Type: application/json" \
  -d '{ "featured": true }'
# → 403 { "error": "Forbidden: admin access required" }
```

---

## Related Documentation

- [Social Mentions Architecture](../architecture/SOCIAL_MENTIONS_ARCHITECTURE.md) — ingestion pipeline, schema, scheduling
- [Social Testimony Ingestion (Roadmap)](../roadmap/SOCIAL_TESTIMONY_INGESTION_CHATGPT.md) — original design discussion
