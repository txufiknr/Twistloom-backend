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

**Authentication:** The catalog (`GET /`) is public. Purchasing (`POST /purchase`) requires `requireAuth`.

**Related docs:**
- [Consumable Items Architecture](../architecture/CONSUMABLE_ITEMS_ARCHITECTURE.md)
- [User Inventory (read owned counts)](../api/USERS_API_DOCUMENTATION.md#get-userinventory) (`GET /api/user/inventory`)
- [Broadcast API](../api/BROADCAST_API_DOCUMENTATION.md) (spends 📣 Megaphones)

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Consumables Catalog](#consumables-catalog)
   - [Get Consumables Catalog](#get-apiconsumables)
3. [Purchasing](#purchasing)
   - [Purchase Consumable](#post-apiconsumablespurchase)
4. [Rate Limits](#rate-limits)
5. [Error Codes](#error-codes)
6. [Implementation Reference](#implementation-reference)

---

## Type Definitions

```typescript
type InventoryItemType = "megaphone"; // extensible union — add new items here

interface ConsumableItemDefinition {
  type: InventoryItemType;        // stable inventory key; must match InventoryItemType
  name: string;                   // display name (emoji-friendly)
  description: string;            // user-facing description
  creditsPrice: number;           // credit cost for ONE unit (SSOT)
  available: boolean;             // purchasable now?
  icon?: string;                  // optional glyph
  maxPerUser?: number;            // optional per-user purchase cap
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

## Rate Limits

| Endpoint | Config | Limit | Rationale |
|----------|--------|-------|-----------|
| `POST /api/consumables/purchase` | `CONSUMABLE_PURCHASE_RATE_LIMIT` | 10 / 60s | Credit-gated; bounds purchase hammering and credit-check churn |

Defined in `src/config/ai-rate-limits.ts`. Upstash Redis sliding-window limit, **fail open** (allows on Redis outage).

---

## Error Codes

All endpoints return the standard envelope `{ "error": "Human-readable message" }`.

| HTTP | Trigger |
|------|---------|
| `400` | Validation failure: missing/unknown `itemType`, item not `available`, or `maxPerUser` reached |
| `402` | Insufficient credits (from `executeWithCredits`) |
| `403` | User is banned |
| `429` | Rate-limit exceeded (`Retry-After` header present) |
| `500` | Server fault |

---

## Implementation Reference

- Route handler: [`src/routes/consumables.ts`](../../src/routes/consumables.ts)
- Service: [`src/services/broadcast.ts`](../../src/services/broadcast.ts) — `purchaseConsumable`, `getUserItemCount`
- Registry (SSOT): [`src/config/consumables.ts`](../../src/config/consumables.ts) — `CONSUMABLES_REGISTRY`, `getConsumable`
- Rate limits: [`src/config/ai-rate-limits.ts`](../../src/config/ai-rate-limits.ts) — `CONSUMABLE_PURCHASE_RATE_LIMIT`
- Credits: [`src/services/credits.ts`](../../src/services/credits.ts) — `executeWithCredits`
- Schema: [`src/db/schema.ts`](../../src/db/schema.ts) — `user_inventory`
- Types: [`src/types/broadcast.ts`](../../src/types/broadcast.ts) — `InventoryItemType`
