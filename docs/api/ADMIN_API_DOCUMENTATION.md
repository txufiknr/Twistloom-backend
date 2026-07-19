# Admin API Documentation

## Overview

The Admin API provides privileged, system-level endpoints for debugging, system
health checks, and curation of the social-proof mention wall. All mutation and
read endpoints described here (except the public health check) require the
requester to be the **system admin user**, identified by `process.env.SYSTEM_USER_ID`.

**Base URL:** `/api/admin`

**Authentication:**
- Most endpoints require `requireAuth` (NextAuth JWT cookie) **and** `requireSystemAdmin`.
- Any authenticated non-admin request is rejected with `403 Forbidden`.
- The system admin is a single fixed user; there is no role/permission table.

**Architecture:**
- `requireAuth` attaches `req.userId` from the NextAuth session.
- `requireSystemAdmin` compares `req.userId` against `process.env.SYSTEM_USER_ID`.
- All handlers are wrapped with `wrapAsync` so promise rejections route to the
  central error handler instead of crashing the process.

---

## Table of Contents

1. [System](#system)
   - [System Health](#get-apiaadminsystemhealth)
2. [Story Debugging](#story-debugging)
   - [Reconstruction Debug](#get-apiaadminbooksbookidreconstructionpageid)
3. [Social Mentions (Admin)](#social-mentions-admin)
   - [List Mentions](#get-apiaadminsocial-mentions)
   - [Get Mention](#get-apiaadminsocial-mentionsid)
   - [Create Mention](#post-apiaadminsocial-mentions)
   - [Update Mention](#patch-apiaadminsocial-mentionsid)
   - [Delete Mention](#delete-apiaadminsocial-mentionsid)
   - [Bulk Update Status](#post-apiaadminsocial-mentionsbulk-status)
4. [Social Mentions (Public)](#social-mentions-public)
   - [Public Wall](#get-apisocial-mentions)
   - [Public Single Mention](#get-apisocial-mentionsid)

---

## System

### GET /api/admin/system/health

Returns basic system health metrics for monitoring. This endpoint requires
authentication but **not** system-admin privileges (any valid session can call it).

**Authentication:** Required (`requireAuth`)

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

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `bookId` | UUID | Book identifier |
| `pageId` | UUID | Page identifier to reconstruct |

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
- `403 Forbidden`: Not the system admin user
- `500 Internal Server Error`: Reconstruction failed

**Database Operations:**
1. Loads the page via `getPageFromDB(pageId)`
2. Loads the book via `getBookFromDB(bookId)`
3. Reconstructs state via `reconstructStoryState()` with `useCache: false`, `validatePath: true`

---

## Social Mentions

The social-mentions subsystem powers the public "readers are talking about
Twistloom" wall. Raw items are ingested by the weekly cron (see
[`SOCIAL_MENTIONS_ARCHITECTURE.md`](../architecture/SOCIAL_MENTIONS_ARCHITECTURE.md))
as `pending`, then curated here. The public homepage should only display rows
where `status = 'approved'` **and** `featured = true`.

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
| `createdAt` / `updatedAt` | timestamptz | Bookkeeping |

### GET /api/admin/social-mentions

Lists social mentions for the curation queue. Supports filtering by status and
platform, plus pagination. Ordered by `relevanceScore` DESC then `publishedAt`
DESC so the best candidates surface first.

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Optional filter: `pending` \| `approved` \| `rejected` |
| `platform` | string | Optional filter, e.g. `reddit` \| `hackernews` \| `github` \| `bluesky` |
| `limit` | integer | Max rows (default `50`, max `200`) |
| `offset` | integer | Rows to skip (default `0`) |

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
- `403 Forbidden`: Not the system admin user
- `500 Internal Server Error`: Server error

### GET /api/admin/social-mentions/:id

Retrieves a single social mention by id.

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Response (200 OK):** A single mention object (same shape as in the list).

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not the system admin user
- `404 Not Found`: Mention not found
  ```json
  { "error": "Social mention not found" }
  ```
- `500 Internal Server Error`: Server error

### POST /api/admin/social-mentions

Manually creates a curated mention (e.g. pasted from X, a blog review, or a
user submission). Flows through the same curation queue as auto-ingested items.
Deduplicated by `url` — re-submitting an existing URL returns `400`.

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

**Request Body:**
```json
{
  "platform": "x",                 // required, e.g. "x" | "reddit" | "blog"
  "author": "@johndoe",            // required
  "content": "Twistloom made me cry at 3am.", // required
  "url": "https://x.com/johndoe/status/123", // required (unique)
  "title": "Best thriller ever",   // optional
  "authorAvatar": "https://...",   // optional
  "score": 143,                    // optional (default 0)
  "sentimentScore": 0.9,           // optional (default 0)
  "relevanceScore": 88,            // optional (default 0)
  "status": "pending",             // optional (default "pending")
  "featured": false,               // optional (default false)
  "publishedAt": "2026-07-10T12:00:00.000Z" // optional ISO timestamp
}
```

**Response (201 Created):** The created mention object.

**Error Responses:**
- `400 Bad Request`: Missing required fields (`platform`, `author`, `content`, `url`)
  ```json
  { "error": "Missing required fields: platform, author, content, and url are required" }
  ```
- `400 Bad Request`: Invalid `status` value
  ```json
  { "error": "Invalid status. Must be 'pending', 'approved', or 'rejected'" }
  ```
- `400 Bad Request`: URL already exists (dedup)
  ```json
  { "error": "A social mention with this URL already exists" }
  ```
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not the system admin user
- `500 Internal Server Error`: Server error

### PATCH /api/admin/social-mentions/:id

Updates curation fields of a mention. Only the listed fields are mutable; any
omitted field is left unchanged.

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Request Body (all fields optional):**
```json
{
  "status": "approved",     // "pending" | "approved" | "rejected"
  "featured": true,         // elevate to homepage wall
  "relevanceScore": 95,     // override computed score
  "sentimentScore": 0.8,    // override computed sentiment
  "title": "Edited title",  // admin-edited display title
  "content": "Edited body"  // admin-edited display content
}
```

**Response (200 OK):** The updated mention object.

**Error Responses:**
- `400 Bad Request`: Invalid `status` value
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not the system admin user
- `404 Not Found`: Mention not found
  ```json
  { "error": "Social mention not found" }
  ```
- `500 Internal Server Error`: Server error

**Curation Pattern:**
To publish on the homepage, set both `status: "approved"` and `featured: true`.
`status = "rejected"` removes it from consideration without deleting the row.

### DELETE /api/admin/social-mentions/:id

Permanently deletes a single mention (e.g. spam outside the approve/reject flow).

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

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
- `403 Forbidden`: Not the system admin user
- `404 Not Found`: Mention not found
  ```json
  { "error": "Social mention not found" }
  ```
- `500 Internal Server Error`: Server error

### POST /api/admin/social-mentions/bulk-status

Bulk-updates the `status` of multiple mentions in one request (e.g. approve or
reject a whole page of the queue). Only the `status` field is mutated.

**Authentication:** Required (`requireAuth` + `requireSystemAdmin`)

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
  ```json
  { "error": "ids must be a non-empty array" }
  ```
- `400 Bad Request`: Invalid `status` value
  ```json
  { "error": "Invalid status. Must be 'pending', 'approved', or 'rejected'" }
  ```
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Not the system admin user
- `500 Internal Server Error`: Server error

**Note:** Only string ids are applied; invalid/empty entries in the array are
silently filtered. `updated` reflects the number of rows actually changed.

---

## Social Mentions (Public)

The curated social-proof wall is served by a **separate, unauthenticated** router
mounted at `/api/social-mentions` (see `src/routes/social-mentions.ts`). These
endpoints power the public homepage and require **no auth**. They return only
mentions where `status = 'approved'` **and** `featured = true`.

### GET /api/social-mentions

Lists the featured social-proof wall. Ordered by `relevanceScore` DESC then
`publishedAt` DESC (equivalent to the curated SQL `WHERE featured = true ORDER BY
relevance_score DESC`).

**Authentication:** None (public)

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Max rows (default `20`, max `100`) |

**Response (200 OK):**
```json
{
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
      "status": "approved",
      "featured": true,
      "publishedAt": "2026-07-15T09:30:00.000Z",
      "createdAt": "2026-07-19T06:00:00.000Z",
      "updatedAt": "2026-07-19T06:00:00.000Z"
    }
  ]
}
```

**Error Responses:**
- `500 Internal Server Error`: Server error

**Caching:** Intended to be cached on the client via ISR / `unstable_cache`; the
query is read-only and cheap.

### GET /api/social-mentions/:id

Public single-mention lookup for the wall. Same visibility rules (approved +
featured only).

**Authentication:** None (public)

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Social mention identifier |

**Response (200 OK):** A single mention object (same shape as in the list).

**Error Responses:**
- `404 Not Found`: Mention not found or not public (not approved+featured)
  ```json
  { "error": "Social mention not found" }
  ```
- `500 Internal Server Error`: Server error

---

## Security Architecture

### Authorization Model

- **`requireAuth`**: validates the NextAuth JWT cookie and attaches `req.userId`.
- **`requireSystemAdmin`**: compares `req.userId` to `process.env.SYSTEM_USER_ID`
  (a single fixed admin user). Any mismatch → `403 Forbidden`.
- This is defense-in-depth on top of `requireAuth`; there is no RBAC/roles table.

### Required Environment Variables

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `SYSTEM_USER_ID` | UUID of the admin user that authorizes every `/admin` route | Your DB `users.id` for the admin account |
| `DATABASE_URL` | Write DB connection used by the social-mentions routes | [Neon Console](https://console.neon.tech) |
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
low-frequency, single-operator use behind authentication + admin authorization.

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
