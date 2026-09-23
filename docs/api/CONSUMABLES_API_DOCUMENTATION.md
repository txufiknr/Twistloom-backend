# Consumables API Documentation

**Status: This is the Single Source of Truth (SSOT) for purchasing credit-bought, inventory-backed consumable items** (e.g. the 📣 Megaphone). All item purchases — regardless of which feature later spends the item — go through `POST /api/consumables/purchase`. Feature-specific purchase aliases (such as the old `POST /api/broadcasts/purchase`) have been removed.

---

## Overview

Twistloom models every purchasable, credit-bought consumable through a single generic pipeline:

- **Credits buy items, features spend items.** Purchasing debits `creditsPrice` credits (registry-defined) via `executeWithCredits` and increments the user's `user_inventory` row. Spending the item later (e.g. broadcasting) only decrements inventory — credits are never charged again.
- **Registry-driven.** Every item's `creditsPrice`, `name`, `description`, `available` flag, and optional `maxPerUser` cap live in `CONSUMABLES_REGISTRY` (`src/config/consumables.ts`) — the authoritative source. Adding a new item means adding one registry entry (and extending `InventoryItemType`), nothing else.
- **Atomic & safe.** `executeWithCredits` holds a row lock on `users.credits`; if the inventory write fails, credits are auto-refunded. Banned users (`users.bannedAt`) cannot purchase.
- **Per-user inventory.** Owned counts live in `user_inventory` (one row per `(user, itemType)`). Read them via `GET /api/user/inventory`.

**Base URL:** `/api/consumables`

**Authentication:** The catalog (`GET /`) is public. Everything that spends or reads inventory — purchasing (`POST /purchase`), Danger Sight (`/danger-sight/*`), divergence (`POST /divergence-check`), and anchors (`/anchors`) — requires `requireAuth`.

**Related docs:**
- [Consumable Items Architecture](../architecture/CONSUMABLE_ITEMS_ARCHITECTURE.md) — §5.3.4 for the Danger Sight mechanism
- [User Inventory (read owned counts)](../api/USERS_API_DOCUMENTATION.md#get-userinventory) (`GET /api/user/inventory`)
- [Broadcast API](../api/BROADCAST_API_DOCUMENTATION.md) (spends 📣 Megaphones)
- [Hazardous Action Risk Architecture](../../../Twistloom-web/docs/architecture/HAZARDOUS_ACTION_RISK_ARCHITECTURE.md) — frontend badge gating driven by the Danger Sight window

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Consumables Catalog](#consumables-catalog)
   - [Get Consumables Catalog](#get-apiconsumables)
3. [Purchasing](#purchasing)
   - [Purchase Consumable](#post-apiconsumablespurchase)
4. [Danger Sight](#danger-sight)
   - [Activate Danger Sight](#post-apiconsumablesdanger-sightactivate)
   - [Danger Sight Status](#get-apiconsumablesdanger-sightstatus)
5. [Rate Limits](#rate-limits)
6. [Error Codes](#error-codes)
7. [Implementation Reference](#implementation-reference)

---

## Type Definitions

```typescript
type InventoryItemType =
  | "megaphone"
  | "item_divergence_compass"
  | "item_memory_anchor"
  | "item_resonance_prism"
  | "item_danger_sight"
  | "item_curator_quill"
  | "cyber_grid"
  | "gothic_bramble"
  | "astral_void"
  | "ancient_runes"; // extensible union — add new items here

interface ConsumableItemDefinition {
  type: InventoryItemType;        // stable inventory key; must match InventoryItemType
  name: string;                   // display name (emoji-friendly)
  description: string;            // user-facing description
  creditsPrice: number;           // credit cost for ONE unit (SSOT)
  available: boolean;             // purchasable now?
  icon?: string;                  // optional glyph
  maxPerUser?: number;            // optional per-user purchase cap
  accountBound?: boolean;         // non-transferable / bound to account
  category?: "broadcast" | "exploration" | "vault" | "tribute"; // store & inventory tab filter
}

interface DangerSightStatus {
  fromPage: number | null; // 1-based window start, null if never activated
  toPage: number | null;   // 1-based window end (fromPage + 14)
}
```

---

## Consumables Catalog

### GET /api/consumables

Public catalog of every registered consumable, in registry display order. Clients render the shop from this response; the `available` flag hides disabled items. Credit prices shown are registry defaults (demo users still pay `0` at purchase time, handled upstream by `getCreditCostForUser`).

**Authentication:** None

**Response:** `200 OK`

```json
{
  "items": [
    {
      "type": "megaphone",
      "name": "📣 Megaphone",
      "description": "Broadcast a short message to every reader for a few seconds. Runs AI moderation before it goes live.",
      "creditsPrice": 100,
      "available": true,
      "icon": "📣"
    }
  ]
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `items` | `ConsumableItemDefinition[]` | One entry per registry item, in display order |

---

## Purchasing

### POST /api/consumables/purchase

Buys **ONE unit** of the requested item. Charges the registry-defined credit price atomically via `executeWithCredits` and increments `user_inventory`. If the inventory write fails, `executeWithCredits` auto-refunds the credits. Unknown or unavailable items cost nothing.

**Authentication:** Required (`requireAuth`)

**Rate Limiting:** `CONSUMABLE_PURCHASE_RATE_LIMIT` — 10 requests / 60s (per user, Upstash Redis sliding-window, **fail open**).

**Request Body:**

```json
{ "itemType": "megaphone" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `itemType` | string | yes | Registry key for the item to buy; must exist in `CONSUMABLES_REGISTRY` |

**Response:** `200 OK`

```json
{ "itemType": "megaphone", "quantity": 4 }
```

| Field | Type | Meaning |
|-------|------|---------|
| `itemType` | string | Echoed inventory key |
| `quantity` | number | User's new owned count for that item after purchase |

**Errors:**
- `400` validation — `itemType` missing/unknown, the item is not `available`, or the `maxPerUser` cap is already reached (reads current `user_inventory` count before charging).
- `402` / `insufficient_credits` — credit balance too low (returned by `executeWithCredits`).
- `403` — user is banned (`users.bannedAt` set); purchase is rejected before any charge.
- `429` — rate-limit exceeded (`Retry-After` header set).

**Behavior:**
- Validates `itemType` against the registry **before** any credit charge.
- Respects `available` and `maxPerUser` guards (current owned count read from `user_inventory`).
- On success returns the user's new owned quantity for that item.
- In free-demo mode the credit charge resolves to `0` (no balance deducted), but inventory is still incremented.

**Example: buying a second Megaphone**

```bash
curl -X POST https://api.twistloom.com/api/consumables/purchase \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "itemType": "megaphone" }'
```

```json
{ "itemType": "megaphone", "quantity": 2 }
```

---

## Danger Sight

The 👁️ Danger Sight is a reader-context consumable: it must be activated from inside a specific book page, and it grants a **15-page positional window** (no wall-clock timer). Stock lives in `user_inventory`; the active window lives in `user_sessions.danger_sight_from_page`.

- Duration SSOT: `DANGER_SIGHT_DURATION_PAGES = 15` (`src/config/consumables.ts`).
- Window: `[fromPage, fromPage + DANGER_SIGHT_DURATION_PAGES - 1]` for the activated book.
- The server derives `fromPage` from `pageId` — clients never send a page number.
- No stacking (one window per `(user, book)`); no decrement — expiry is positional and derived at read time.

### POST /api/consumables/danger-sight/activate

Activates (or re-activates) Danger Sight for a book at a starting page. Spends one lens from inventory.

**Authentication:** Required (`requireAuth`)

**Rate Limiting:** inline `rateLimit({ windowSeconds: 60, maxRequests: 10, prefix: "danger-sight-activate" })` — 10 requests / 60s per user (Upstash Redis sliding-window, **fail open**).

**Request Body:**

```json
{ "bookId": "3f2a…", "pageId": "8c1d…" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `bookId` | string (uuid) | yes | Target book; must have a `user_sessions` row (reader context) |
| `pageId` | string (uuid) | yes | Current page; start page resolved server-side from `pages.page` |

**Response:** `200 OK`

```json
{ "fromPage": 12, "toPage": 26, "remainingItems": 2 }
```

| Field | Type | Meaning |
|-------|------|---------|
| `fromPage` | number | 1-based start page of the window |
| `toPage` | number | 1-based end page of the window (`fromPage + 14`) |
| `remainingItems` | number | Owned lenses after the spend |

**Errors:**
- `400` validation — `bookId`/`pageId` missing or **malformed uuid** (rejected before any query), or `ConsumableError consumables.noneLeft` (no lenses in stock; body includes `code`).
- `404` — `ConsumableError consumables.pageNotFound` (body includes `code`): well-formed `pageId` that does not exist within `bookId` — deleted page, a page from another book, or a nonexistent `bookId`.
- `409` — `ConsumableError consumables.alreadyActive` (body includes `code`): the current window still covers the requested start page (no stacking). A start page **past** the window is re-claimable (positional lazy expiry); a lost `INSERT … ON CONFLICT DO NOTHING` race reads the same.
- `500` — server fault only.
- `401` — not authenticated.

### GET /api/consumables/danger-sight/status

Reads the stored window for a book. Pure read — the range comes back **as stored**, even past `toPage`; clients derive `isActive`/`pagesRemaining` from their current page number against `[fromPage, toPage]` (non-null never implies active).

**Authentication:** Required (`requireAuth`)

**Query:** `bookId` (required, uuid)

**Response:** `200 OK`

```json
{ "fromPage": 12, "toPage": 26 }
```

| Field | Type | Meaning |
|-------|------|---------|
| `fromPage` | number \| null | Window start **as stored**; `null` only when no window is stored (never activated / no session row) |
| `toPage` | number \| null | Window end (`fromPage + 14`) **as stored**; `null` only when no window is stored |

**⚠️ Non-null ≠ active.** The range is returned exactly as stored, even when the requesting reader's current page is already past `toPage` (positionally expired) — this endpoint does not receive or know the current page. Clients **must** derive activity:

```ts
isActive = fromPage !== null && current >= fromPage && current <= toPage;
pagesRemaining = isActive ? toPage - current + 1 : 0;
```

Example: `{"fromPage":12,"toPage":26}` viewed from page **40** ⇒ **inactive** (but still returned non-null). Both fields are `null` together only when no window is stored.

**Errors:**
- `400` — `bookId` missing from the query string, or **malformed uuid**.
- `401` — not authenticated.

---

## Rate Limits

| Endpoint | Config | Limit | Rationale |
|----------|--------|-------|-----------|
| `POST /api/consumables/purchase` | `CONSUMABLE_PURCHASE_RATE_LIMIT` | 10 / 60s | Credit-gated; bounds purchase hammering and credit-check churn |
| `POST /api/consumables/danger-sight/activate` | inline (`prefix: "danger-sight-activate"`) | 10 / 60s | Spends inventory; bounds activation hammering |
| `POST /api/consumables/divergence-check` | inline (`prefix: "divergence-check"`) | 20 / 60s | Spends inventory; bounds scan hammering |
| `POST /api/consumables/anchors` | inline (`prefix: "drop-anchor"`) | 20 / 60s | Spends inventory; bounds anchor-drop hammering |

Defined in `src/config/ai-rate-limits.ts` (plus the inline configs above). Upstash Redis sliding-window limit, **fail open** (allows on Redis outage). `GET /anchors` and `DELETE /anchors/:anchorId` are unrated reads/writes on already-owned rows.

---

## Error Codes

All endpoints return the standard envelope `{ "error": "Human-readable message" }`. Spend/activation failures additionally carry a **`code`** field — the i18n key suffix the client resolves under `consumables.errors` (the English `error` string is a dev-facing fallback only).

| HTTP | Trigger |
|------|---------|
| `400` | Validation failure: missing/unknown `itemType`, item not `available`, or `maxPerUser` reached; missing or **malformed-uuid** params on Danger Sight / divergence / anchors (`bookId`, `pageId`, `anchorId` — rejected via `isValidUuid` before any query); **`consumables.noneLeft`** — out of stock on any inventory spend (divergence compass, anchor drop, Resonance Prism, Curator's Quill, Easter Egg crack, Danger Sight race). 📣 Megaphone out-of-stock is the namespace exception: surfaced as `broadcast.noMegaphone` (also 400) from `/api/broadcasts`. |
| `401` | Not authenticated (all non-catalog endpoints) |
| `402` | Insufficient credits (from `executeWithCredits`) |
| `403` | User is banned |
| `404` | `consumables.pageNotFound` — well-formed `pageId` not found within `bookId` (Danger Sight activate, divergence check) |
| `409` | `consumables.alreadyActive` — Danger Sight window still covers the requested start page, or activation race lost |
| `429` | Rate-limit exceeded (`Retry-After` header present) |
| `500` | Server fault **only** — malformed uuids and out-of-stock are 4xx client-fault codes, never 500 |

---

## Implementation Reference

- Route handler: [`src/routes/consumables.ts`](../../src/routes/consumables.ts) — purchase, divergence-check, anchors (POST/GET/DELETE, all uuid-guarded), Danger Sight activate/status
- Service: [`src/services/consumables.ts`](../../src/services/consumables.ts) — `purchaseConsumable`, `getUserItemCount`, `deductUserItem` (throws `ConsumableError consumables.noneLeft` on out-of-stock), `activateDangerSight`, `getDangerSightStatus`, `ConsumableError`, `CONSUMABLE_ERROR_CODES` (`alreadyActive`, `noneLeft`, `pageNotFound`), shared route mapper `cConsumableError` (exhaustive `Record<ConsumableErrorCode, 400|404|409>`)
- Other spend routes wired to `cConsumableError`: [`src/routes/easter-eggs.ts`](../../src/routes/easter-eggs.ts) (prism activate, egg crack), [`src/routes/books.ts`](../../src/routes/books.ts) (quill testimonial); 📣 Megaphone converts `noneLeft` → `broadcast.noMegaphone` inside [`src/services/broadcast.ts`](../../src/services/broadcast.ts)
- Registry (SSOT): [`src/config/consumables.ts`](../../src/config/consumables.ts) — `CONSUMABLES_REGISTRY`, `getConsumable`, `DANGER_SIGHT_DURATION_PAGES`
- Rate limits: [`src/config/ai-rate-limits.ts`](../../src/config/ai-rate-limits.ts) — `CONSUMABLE_PURCHASE_RATE_LIMIT`
- Credits: [`src/services/credits.ts`](../../src/services/credits.ts) — `executeWithCredits`
- Schema: [`src/db/schema.ts`](../../src/db/schema.ts) — `user_inventory`, `user_sessions.danger_sight_from_page` (migration `drizzle/0099_wealthy_gamma_corps.sql` applied 2026-09-23; `user_consumable_effects` dropped)
- Types: [`src/types/consumable.ts`](../../src/types/consumable.ts) — `InventoryItemType`, `ConsumableItemDefinition`
