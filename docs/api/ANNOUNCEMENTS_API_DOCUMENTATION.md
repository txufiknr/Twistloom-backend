# Announcements API Documentation

## Overview

The Announcements API is the read side of Twistloom's platform announcement system: an admin authors an announcement **once**, and it is surfaced on three channels:

1. **Broadcast banner** — the site-wide 📣 chip, via the linked `broadcasts` row. Public endpoint: `GET /api/broadcasts/current` (see the [Broadcast API](./BROADCAST_API_DOCUMENTATION.md)).
2. **Notification center** — the pinned section above the personal notification list, plus the 0/1 unseen badge contribution. Authenticated endpoints on this page.
3. **Email blast** — an explicit admin action per record: `POST /api/admin/announcements/:id/email` (see the [Admin API](./ADMIN_API_DOCUMENTATION.md)).

Key design properties:

- **Cap-1 active.** At most one announcement may be `scheduled` or `active` at any time, enforced race-proof by the partial unique index `announcements_one_published_unique` indexing constant expression `((1))` across `WHERE status IN ('scheduled', 'active')`. A second publish fails with `announcements.anotherActiveExists` (409).
- **O(1) per-user state.** "Seen" is one nullable column (`users.last_seen_announcement_id`) pointing at the single live announcement — no per-user fan-out, no `announcement_reads` table, no O(N) writes at publish/end.
- **Announcements are a parallel collection.** They are never rows in `user_notifications`; the notification-center section fetches them from `/api/announcements` directly.
- **Redis caching.** The live announcement row is cached in Redis at `announcement:live` (TTL 30s) and automatically invalidated on every draft update, publish, revocation, or deletion mutation.
- **User endpoints are strictly read-only.** Lifecycle sweeps (`scheduled → active → ended`) run on admin write paths only; user reads filter by time, so the hot path never writes.

**Base URL:** `/api/announcements`

**Authentication:** `GET /api/announcements` and `GET /api/announcements/history` use `optionalAuth` and are accessible to both authenticated users and guests. `POST /api/announcements/:id/seen` requires `requireAuth`.

**Design docs:**
- [Broadcast Architecture](../architecture/BROADCAST_ARCHITECTURE.md)
- `ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP.md` (frontend repo) — full design record

---

## Table of Contents

1. [Visibility & Access Matrix](#visibility--access-matrix)
2. [Pagination](#pagination)
3. [Endpoints](#endpoints)
   - [Get Active Announcement](#get-apiannouncements)
   - [Get Announcement History](#get-apiannouncementshistory)
   - [Mark Announcement Seen](#post-apiannouncementsidseen)
4. [Notification Envelope Integration (badge)](#notification-envelope-integration-badge)
5. [Frontend Integration](#frontend-integration)
6. [Error Codes](#error-codes)

---

## Visibility & Access Matrix

**There is no per-announcement public/private targeting.** Every published announcement is platform-wide: the same single active record is returned to every caller. The `kind` field (`maintenance` | `feature` | `promo` | `incident`) is a **content category, not an access-control field**, and `severity` is only visual urgency. Neither gates who can see an announcement.

The only visibility split is **per channel**:

| Surface | Endpoint | Who sees it |
|---------|----------|-------------|
| Site-wide banner chip (BroadcastBanner) | `GET /api/broadcasts/current` | **Everyone — including guests** (public, unauthenticated) |
| Notification-center pinned section + unseen dot | `GET /api/announcements` | **Everyone — including guests** (`optionalAuth`; `unseen` is false for guests, personalized for auth users) |
| Announcements-tab history list | `GET /api/announcements/history` | **Everyone — including guests** (`optionalAuth`) — same rows for everyone (no per-user filtering) |
| Bell badge contribution (0/1) | `GET /api/notifications/unread-count` | **Authenticated users only** (`requireAuth`) |
| Email | `POST /api/admin/announcements/:id/email` | Opted-in users (`emailPreferences.productAnnouncements`), sent by superadmin action |

So, concretely:

- **Guests do see announcements** — through the public banner channel (`GET /api/broadcasts/current`), the active announcement lookup (`GET /api/announcements`), and the announcement history tab/feed (`GET /api/announcements/history`).
- **Logged-in users see the same announcement with personalized state** — the banner chip plus the pinned notification-center section with the cross-device unseen dot (guests have no identity, so their unseen flag is simply `false`, but they can browse the full publish history).
- **Draft, scheduled (not yet started), and ended rows are never exposed to anyone but admins** — with one deliberate exception: *ended* rows remain readable through `GET /api/announcements/history` (the announcement history tab), which returns published rows whose window has started. They drop off `GET /announcements` immediately.

---

## Pagination

**The active-announcement endpoint does not support pagination — by design, and it never will while the cap-1 invariant holds.** `GET /api/announcements` returns a **single object** (`{ announcement, unseen }`), not a list: there is at most one live announcement, so there is nothing to page. It accepts no `page`/`limit` parameters.

The **history endpoint** (the Announcements tab of the notification center) is a real list and uses the standard page-number pagination shared with every other user-facing list (`books`, `comments`, …): `page` (1-based, default 1) + `limit` (1–100, default 20), responding with a `pagination` meta block.

| Endpoint | Pagination |
|----------|-----------|
| `GET /api/announcements` (this doc) | **None** — single active announcement (cap-1) |
| `GET /api/announcements/history` (this doc) | `page` (1-based, default 1) + `limit` (1–100, default 20) → `pagination` meta — publish history, newest first |
| `GET /api/notifications` | `limit` (1–50, default 20) + `offset` — personal notification rows only; announcements are not among them |
| `GET /api/admin/announcements` (Admin API) | `limit` (1–100, default 20) + `offset`, plus `status` / `kind` filters — admin history table |

---

## Endpoints

### GET /api/announcements

Returns the single active announcement for the current user, together with the per-user unseen flag. When nothing is live (or the window has elapsed), returns `{ "announcement": null, "unseen": false }` — drafts and ended rows are never exposed.

**Authentication:** Optional (`optionalAuth`) — available to both authenticated users and guests (guests receive `unseen: false`).

**Query parameters:** none.

**Response:** `200 OK` — an announcement is live:

```json
{
  "announcement": {
    "id": "0198f1c2-9a4e-7c3b-8f21-4d5e6a7b8c9d",
    "kind": "maintenance",
    "severity": "warning",
    "title": "Scheduled maintenance tonight",
    "body": "Twistloom will be read-only between 22:00–23:00 WIB while we upgrade the generator cluster.",
    "cta": { "url": "/status", "text": "View status" },
    "createdAt": "2026-10-12T08:15:00.000Z"
  },
  "unseen": true
}
```

No announcement is live:

```json
{ "announcement": null, "unseen": false }
```

**Field reference (`announcement`):**

| Field | Type | Notes |
|-------|------|-------|
| `id` | string (uuid) | Announcement id — pass to `POST /:id/seen` |
| `kind` | string | `maintenance` \| `feature` \| `promo` \| `incident` |
| `severity` | string | `info` \| `warning` \| `critical` — drives banner/panel tint |
| `title` | string | Plain text, ≤ 200 chars |
| `body` | string | Plain text (newlines preserved), ≤ 2000 chars |
| `cta` | `{ url, text } \| null` | Optional deep link; `url` is an absolute http(s) URL or an internal path starting with `/`; `text` ≤ 80 chars |
| `createdAt` | string (ISO 8601) | Authoring time (not publish time) |

**Field reference (envelope):**

| Field | Type | Notes |
|-------|------|-------|
| `announcement` | object \| null | The live announcement; `null` when none |
| `unseen` | boolean | `true` when an announcement is live and `users.last_seen_announcement_id` does not point at it. Always `false` when `announcement` is `null` |

**Notes:**
- The query is two indexed point lookups (cap-1 partial index + user PK) — safe to poll; the web client polls with a 60s `staleTime`.
- `unseen` is cross-device: seeing the announcement on desktop clears it on mobile too (it lives on the `users` row, not in localStorage).

---

### GET /api/announcements/history

Page-number paginated history of every published, started announcement — newest first by effective start (`COALESCE(starts_at, created_at)`). This is the data behind the **Announcements tab** of the notification center: the live announcement plus everything that has ended. Cap-1 limits only the *live* slot; history depth is bounded purely by how many announcements have been published.

Visibility filter (read-only — lifecycle sweeps never run here): `status != 'draft'` AND (`starts_at` is null OR `starts_at <= now`). A `scheduled` row whose start time has already arrived (not yet promoted by an admin write) is returned with its stored status; the client renders any non-`ended` started row as "Active".

**Authentication:** Optional (`optionalAuth`) — available to both authenticated users and guests.

**Query parameters:**

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `page` | integer ≥ 1 | 1 | 1-based page number |
| `limit` | integer 1–100 | 20 | Page size (clamped server-side) |

**Response:** `200 OK`

```json
{
  "announcements": [
    {
      "id": "0198f1c2-9a4e-7c3b-8f21-4d5e6a7b8c9d",
      "kind": "maintenance",
      "severity": "warning",
      "title": "Scheduled maintenance tonight",
      "body": "Twistloom will be read-only between 22:00–23:00 WIB while we upgrade the generator cluster.",
      "cta": { "url": "/status", "text": "View status" },
      "createdAt": "2026-10-12T08:15:00.000Z",
      "status": "active",
      "startsAt": "2026-10-12T21:30:00.000Z",
      "expiresAt": "2026-10-12T23:00:00.000Z"
    },
    {
      "id": "0198e0a1-4b2d-4c5e-9f80-1a2b3c4d5e6f",
      "kind": "feature",
      "severity": "info",
      "title": "Multiverse drafts are here",
      "body": "Branch any story into parallel timelines from the reader toolbar.",
      "cta": null,
      "createdAt": "2026-09-28T10:00:00.000Z",
      "status": "ended",
      "startsAt": "2026-09-28T12:00:00.000Z",
      "expiresAt": "2026-10-05T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalCount": 2,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

**Item fields:** the [GET /api/announcements field reference](#get-apiannouncements) plus three lifecycle fields:

| Field | Type | Notes |
|-------|------|-------|
| `status` | string | `scheduled` \| `active` \| `ended` (stored value; `draft` never appears) |
| `startsAt` | string (ISO 8601) \| null | Window start; `null` means live from publish |
| `expiresAt` | string (ISO 8601) \| null | Window end; `null` means no scheduled expiry |

**Notes:**
- Strictly read-only (AGENTS-grade hot path): no sweeps, no writes, per-user state untouched. Open the *active* row's detail in the web client to clear the dot (`POST /:id/seen`) — history itself never marks anything seen.
- One indexed list query + one count query, both filtered by time; safe behind the 60s `staleTime` of the client's infinite query.
- No authentication required; guests and logged-in users receive the same list.

---

### POST /api/announcements/:id/seen

Marks the announcement as seen for the current user — an idempotent, tiny `UPDATE` on the caller's own `users` row re-pointing `last_seen_announcement_id`. Repeating the call is harmless.

**Authentication:** Required (`requireAuth`)

**Path parameters:**

| Parameter | Type | Notes |
|-----------|------|-------|
| `id` | string (uuid) | Announcement id; invalid uuids are rejected before hitting the service |

**Request body:** none.

**Response:** `200 OK`

```json
{ "success": true }
```

**Error Responses:**
- `400 Bad Request` — code `announcements.validation`: `id` is not a valid uuid
- `401 Unauthorized` — not authenticated
- `404 Not Found` — code `announcements.notFound`: no announcement with this id (the web client ignores failures here and re-syncs from the cache)

---

## Notification Envelope Integration (badge)

The bell badge does **not** call `/api/announcements` — the 0/1 unseen contribution is folded server-side into the existing notification envelopes, so every badge call-site stays a single number:

### GET /api/notifications

Personal notification list (paginated) — additive field:

```json
{
  "items": [ /* ... */ ],
  "total": 42,
  "unreadCount": 7,
  "announcementUnread": 1
}
```

### GET /api/notifications/unread-count

```json
{ "count": 7, "announcementUnread": 1 }
```

- `unreadCount` / `count` = personal unread rows + `announcementUnread` (which is `0` or `1` under cap-1) — composed **on the server** so the list header and the FAB badge can never disagree.
- `announcementUnread` is additive; existing clients that ignore it keep working against the composed total.
- `POST /api/notifications/read-all` also points `last_seen_announcement_id` at the active announcement, so "Mark all as read" fully clears the badge (otherwise it would stick at +1).

---

## Frontend Integration

How the web app fetches and renders announcements (Twistloom-web):

| Concern | Code |
|---------|------|
| Typed service | `src/lib/services/announcements-api.ts` — `AnnouncementsApi.getActive(signal)`, `getHistory(page, limit, signal)`, `markSeen(id)` (3-tier pattern: hooks → service → `ApiClient` at `/api/backend`) |
| Query hooks | `src/lib/hooks/query/useAnnouncements.ts` — `useActiveAnnouncement` (`announcementsKeys.active()`, `staleTime` 60s, gated on `isAuthReady && isLoggedIn`, `retry: false`), `useAnnouncementHistory` (infinite query, `pageNextParam` + `initialPageParam: 1`), `useMarkAnnouncementSeen` (optimistic `unseen: false`, then invalidates both notification envelopes) |
| Pinned section | `src/components/notifications/NotificationAnnouncements.tsx`, mounted above `NotificationList` in `src/components/ui/UtilityFab.tsx` |
| History tab + detail | `NotificationAnnouncementsHistory.tsx` (explicit "Load more" button, unread dot on the active row only) and `AnnouncementDetailPanel.tsx` (in-panel detail view with back button) — wired in the notification-center tab strip in `UtilityFab.tsx` |
| Badge | `useUnreadNotificationCount` / `useNotifications` — unchanged shapes; they read the composed `count` / `unreadCount` |
| Banner channel | `useBroadcastCurrent` + `src/components/layout/BroadcastBanner.tsx` (severity tint map + inline CTA for `announcementId` rows) |

Guest behavior: guests can read the active announcement (`GET /api/announcements` with `unseen: false`) and history (`GET /api/announcements/history`); the banner renders from the public `/api/broadcasts/current` poll.

---

## Error Codes

Errors use the standard envelope; `code` is self-describing (`<namespace>.<key>`) and is translated client-side to `announcements.errors.<key>` in `messages/en.json` / `messages/id.json`.

| Code | HTTP | Meaning |
|------|------|---------|
| `announcements.validation` | 400 | Invalid uuid in path, or invalid input on write endpoints |
| `announcements.notFound` | 404 | No announcement for the given id |

Admin-only codes (returned by `/api/admin/announcements/*`, documented in the [Admin API](./ADMIN_API_DOCUMENTATION.md)):

| Code | HTTP | Meaning |
|------|------|---------|
| `announcements.anotherActiveExists` | 409 | Cap-1 invariant — another announcement is already scheduled/active |
| `announcements.locked` | 409 | Edit or delete attempted on an active/ended announcement (only drafts can be deleted) |
| `announcements.notPublishable` | 400 | Publish/end attempted from a state that does not allow it |
| `announcements.emailAlreadySent` | 409 | Email blast was already dispatched for this announcement (pass `force=true` to re-send) |
