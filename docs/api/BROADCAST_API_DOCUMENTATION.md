# Broadcast (📣 Megaphone) API Documentation

## Overview

The Broadcast API powers Twistloom's global, all-ages-visible **📣 Megaphone** banner. A user who owns a 📣 Megaphone consumable (purchased with credits) can send a short plain-text message that every client displays for a few seconds. Messages pass a deterministic security gate plus an AI moderation pass before they are scheduled into a single-live-slot FIFO queue.

Key design properties:

- **Credits buy items, items send broadcasts.** A broadcast never costs credits directly — it spends one 📣 Megaphone from `user_inventory`. Purchasing a Megaphone costs credits (registry-defined, 100).
- **Scarce & rate-limited.** Per-user cooldown, a global spacing interval, a short max length (140), and a bounded pending queue keep the banner usable.
- **Fail-closed moderation.** Rejected messages never consume the item (no refund logic needed — nothing was spent).
- **Public read, authenticated write.** Anyone can poll the live banner; only owners can preview/purchase/submit.

**Base URL:** `/api/broadcasts`

**Authentication:** Read endpoints (`/current`, `/stream`) are public. Write endpoints (`/me`, `/purchase`, `/preview`, `/`, `/:id/report`) require the `requireAuth` JWT middleware.

**Architecture Docs:**
- [Broadcast Architecture](../architecture/BROADCAST_ARCHITECTURE.md)
- [Consumable Items Architecture](../architecture/CONSUMABLE_ITEMS_ARCHITECTURE.md)

---

## Table of Contents

1. [Public Banner](#public-banner)
   - [Get Current Broadcast](#get-apibroadcastscurrent)
   - [Stream Current Broadcast (SSE)](#get-apibroadcastsstream)
2. [Owner State](#owner-state)
   - [Get My Broadcast State](#get-apibroadcastsme)
3. [Purchasing](#purchasing)
   - [Purchase Megaphone](#post-apibroadcastspurchase)
4. [Composing](#composing)
   - [Preview Broadcast](#post-apibroadcastspreview)
   - [Submit Broadcast](#post-apibroadcasts)
5. [Reporting](#reporting)
   - [Report Broadcast](#post-apibroadcastsidreport)
6. [Rate Limits](#rate-limits)
7. [Error Codes](#error-codes)

---

## Public Banner

### GET /api/broadcasts/current

Returns the single live broadcast (or `null` when the banner is empty). Intended for the global banner poll. Safe to call unauthenticated.

**Authentication:** Not required (public)

**Rate Limiting:** Standard public read limits; the response is Redis-cached for `BROADCAST_CURRENT_CACHE_TTL_SECONDS` (3s) server-side, so polling is cheap.

**Response:** `200 OK`

```json
{
  "broadcast": {
    "id": "bc_0194f2d1…",
    "userId": "user_0194…",
    "username": "whispering_mara",
    "message": "Just published my first Multiverse story — would love feedback! 📚",
    "source": "user",
    "containsSpoiler": false,
    "startsAt": "2026-08-29T12:00:00.000Z",
    "expiresAt": "2026-08-29T12:00:08.000Z"
  }
}
```

When nothing is live:

```json
{ "broadcast": null }
```

**Notes:**
- A broadcast is "live" when `status = 'queued'` and `startsAt <= now < expiresAt`.
- `username` is the broadcaster's handle (joined from `users`); no other PII is returned.
- Stale `queued` rows are lazily expired to `expired` on each read.

---

### GET /api/broadcasts/stream

Server-Sent Events stream of the live broadcast. Emits a `broadcast` event whenever the current message changes (or `null` when the banner is empty). Alternative to polling `/current`. Public.

**Authentication:** Not required (public)

**Headers:** `Content-Type: text/event-stream; charset=utf-8` (set automatically by Hono `streamSSE`).

**Event format:**

```
event: broadcast
data: {"broadcast":{"id":"bc_0194…","userId":"user_0194…","username":"whispering_mara","message":"…","source":"user","containsSpoiler":false,"startsAt":"…","expiresAt":"…"}}

event: broadcast
data: {"broadcast":null}
```

The client receives the current state immediately on connect, then an event whenever the live broadcast changes. The stream self-terminates if the client disconnects (the upstream `AbortSignal` is honoured).

---

## Owner State

### GET /api/broadcasts/me

Composer-gating state for the authenticated user: remaining Megaphones, seconds left on the per-user cooldown, and whether the global queue is full.

**Authentication:** Required (`requireAuth`)

**Response:** `200 OK`

```json
{
  "megaphones": 3,
  "cooldownRemainingSeconds": 0,
  "queueFull": false
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `megaphones` | number | 📣 Megaphones owned in `user_inventory` |
| `cooldownRemainingSeconds` | number | Seconds until this user may broadcast again (`0` = ready) |
| `queueFull` | boolean | `true` when the global pending queue is at `BROADCAST_MAX_PENDING` |

---

## Purchasing

### POST /api/broadcasts/purchase

Buys **one 📣 Megaphone** consumable. Charges the registry-defined credit price (`src/config/consumables.ts`, 100 credits) atomically via `executeWithCredits` and increments the user's `user_inventory` inside the same transaction. Broadcasting later only spends the item — never credits.

**Authentication:** Required (`requireAuth`)

**Rate Limiting:** `BROADCAST_PURCHASE_RATE_LIMIT` — 10 requests / 60s (IP + user).

**Request Body:** None required. (The endpoint always buys the 📣 Megaphone; the item type is fixed for this route.)

**Response:** `200 OK`

```json
{ "megaphones": 4 }
```

`megaphones` is the new owned balance after purchase.

**Errors:**
- `403` if the user is banned (`users.bannedAt` set).
- Standard credit errors (`402`/`insufficient_credits`) if the balance is too low — returned by `executeWithCredits`.
- In free-demo mode the credit charge resolves to `0` (no balance deducted).

---

## Composing

### POST /api/broadcasts/preview

Validates and AI-moderates a draft message **without spending a Megaphone**. Returns the outcome so the composer can warn the user before they commit.

**Authentication:** Required (`requireAuth`)

**Rate Limiting:** `BROADCAST_PREVIEW_RATE_LIMIT` — 20 requests / 60s. (Free, but bounded — a rejected-preview loop is a free AI-moderation amplification vector.)

**Request Body:**

```json
{ "message": "My horror one-shot drops tonight 👀" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `message` | string | yes | Raw text; sanitized/validated server-side. Max `BROADCAST_MAX_LENGTH` (140) chars after sanitization. |

**Response:** `200 OK`

Approve:

```json
{
  "outcome": "approve",
  "preview": { "message": "My horror one-shot drops tonight 👀" }
}
```

Reject:

```json
{
  "outcome": "reject",
  "rejectionReason": "spam",
  "message": "Promotional or spam content can't be broadcast."
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `outcome` | `"approve" \| "reject"` | Moderation decision |
| `rejectionReason` | string | Present only on reject (harassment/sexual/hate/scam/spam/self_harm/illegal/injection/policy/other) |
| `message` | string | User-safe message shown on reject (never the internal reasons) |
| `preview.message` | string | Sanitized text that would be broadcast (approve only) |

**Errors:**
- `400` validation failure (empty / too long / invalid characters / injection pattern).
- `403` if the user is banned.

---

### POST /api/broadcasts

Submits a broadcast. Runs Gate 1 (deterministic) + ban check + Gate 2 (AI moderation); only on approval is a 📣 Megaphone consumed and the message scheduled into the global queue. A rejected message costs the user nothing.

**Authentication:** Required (`requireAuth`)

**Rate Limiting:** `BROADCAST_SUBMIT_RATE_LIMIT` — 10 requests / 60s.

**Request Body:**

```json
{
  "message": "Just finished the Library of Ashes rewrite — thanks to everyone who voted! 📚",
  "containsSpoiler": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `message` | string | yes | Raw text; sanitized/validated server-side. Length `BROADCAST_MIN_LENGTH`–`BROADCAST_MAX_LENGTH` (3–140). |
| `containsSpoiler` | boolean | no | User-declared spoiler flag (default `false`). |

**Response:** `201 Created`

```json
{
  "id": "bc_0194f2d1…",
  "message": "Just finished the Library of Ashes rewrite — thanks to everyone who voted! 📚",
  "containsSpoiler": false,
  "queuePosition": 1,
  "startsAt": "2026-08-29T12:00:00.000Z",
  "expiresAt": "2026-08-29T12:00:08.000Z",
  "megaphonesRemaining": 2
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Broadcast row id |
| `message` | string | Sanitized stored message |
| `containsSpoiler` | boolean | Echoed spoiler flag |
| `queuePosition` | number | 1-based position in the broadcast queue (`1` = next to go live) |
| `startsAt` | string | ISO-8601 — when this message becomes visible |
| `expiresAt` | string | ISO-8601 — when it stops being visible |
| `megaphonesRemaining` | number | 📣 Megaphones left after this spend |

**Errors:** see [Error Codes](#error-codes). Notably `400 no_megaphone` when the user owns none, `429` on cooldown/queue-full, `400 rejected` with `rejectionReason` on moderation failure.

---

## Reporting

### POST /api/broadcasts/:id/report

One-tap abuse report for a broadcast. Idempotent per `(broadcast, reporter)` — a duplicate report resolves to the existing row and returns `"reported": false`.

**Authentication:** Required (`requireAuth`)

**Request Body:**

```json
{ "reason": "harassment" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `reason` | string | yes | Short reason; truncated to 60 chars server-side |

**Response:** `200 OK`

```json
{ "reported": true }
```

`reported` is `true` when a new report was created, `false` when one already existed for this `(broadcast, reporter)` pair.

**Errors:**
- `404` if the broadcast id does not exist (foreign-key violation).

---

## Rate Limits

| Endpoint | Config | Limit | Rationale |
|----------|--------|-------|-----------|
| `POST /api/broadcasts/purchase` | `BROADCAST_PURCHASE_RATE_LIMIT` | 10 / 60s | Credit-gated; bounds purchase hammering |
| `POST /api/broadcasts/preview` | `BROADCAST_PREVIEW_RATE_LIMIT` | 20 / 60s | Free AI-moderation call; bounded abuse |
| `POST /api/broadcasts` | `BROADCAST_SUBMIT_RATE_LIMIT` | 10 / 60s | Charged consumable + per-call moderation |

All three are Upstash Redis sliding-window limits and **fail open** (allow on Redis outage). Limits are defined in `src/config/ai-rate-limits.ts`.

---

## Error Codes

Submit/preview map a tagged `BroadcastSubmitError` to HTTP status. The client should treat the `error` string as user-facing.

| Code | HTTP | Trigger |
|------|------|---------|
| `validation` | `400` | Empty / too short / too long / invalid characters / injection pattern (Gate 1) |
| `forbidden` | `403` | User is banned (`users.bannedAt`) |
| `no_megaphone` | `400` | User owns no 📣 Megaphone (purchase first) |
| `cooldown` | `429` (`Retry-After`) | Per-user cooldown active; body includes seconds remaining |
| `queue_full` | `429` | Global pending queue at `BROADCAST_MAX_PENDING` |
| `rejected` | `400` | AI moderation rejected; response includes `rejectionReason` |
| `not_found` | `404` | Report targets a non-existent broadcast id |

Example rejected response:

```json
{ "error": "Promotional or spam content can't be broadcast.", "rejectionReason": "spam" }
```

Example cooldown response (headers include `Retry-After: 212`):

```json
{ "error": "You can broadcast again in 212 seconds." }
```

---

## Implementation Reference

- Route handler: [`src/routes/broadcasts.ts`](../../src/routes/broadcasts.ts)
- Service: [`src/services/broadcast.ts`](../../src/services/broadcast.ts)
- Tuning: [`src/config/broadcast.ts`](../../src/config/broadcast.ts)
- Rate limits: [`src/config/ai-rate-limits.ts`](../../src/config/ai-rate-limits.ts)
- Consumables registry: [`src/config/consumables.ts`](../../src/config/consumables.ts)
- Schema: [`src/db/schema.ts`](../../src/db/schema.ts) (`broadcasts`, `broadcast_reports`, `user_inventory`)
- Types: [`src/types/broadcast.ts`](../../src/types/broadcast.ts)
