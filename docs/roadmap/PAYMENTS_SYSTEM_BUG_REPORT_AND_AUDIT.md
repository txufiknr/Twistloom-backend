# Payments System — Bug Report & Code Audit

**Scope:** `src/routes/payments.ts`, `src/services/credits.ts`, `src/services/subscription.ts`, `src/services/xendit.ts`, `src/config/credits.ts`, `src/config/xendit.ts`, `src/config/subscription.ts`  
**Date:** August 2026  
**Auditor:** AI Agent (opencode)  
**Companion doc:** [PAYMENTS_ARCHITECTURE_BACKEND.md](../architecture/PAYMENTS_ARCHITECTURE_BACKEND.md)

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| ◻️ | Not started |
| ⏳ | In progress |
| ✅ | Completed |
| ⏩ | Deferred / won't fix in this pass |

---

## At-a-glance summary

### Phase 1 — Quick wins

| # | Issue | Status |
|---|-------|--------|
| 1.2 | `parseInt` NaN pagination bypass | ✅ |
| 1.1 | BigInt refund truncation | ✅ |
| 2.3 | `subscription-plans` config leak | ✅ |
| 2.4 | `webhookDeliveryId!` null assertion | ✅ |
| 3.9 | PII logging in trial checkout | ✅ |
| 4.2 | `catch (error: any)` → `unknown` | ✅ |

### Phase 2 — DRY/SSOT

| # | Issue | Status |
|---|-------|--------|
| 2.1 | Extract `buildReturnUrls()` helper | ✅ |
| 3.5 | Unify credit pack config | ⏩ |
| 3.6 | Consolidate `isUniqueViolation` | ⏩ |
| 2.2 | Rate limit for Xendit subscription | ✅ |

### Phase 3 — Financial integrity

| # | Issue | Status |
|---|-------|--------|
| 1.3 | `awardCredits()` row lock | ✅ |
| 3.1 | `refundCreditsIdempotent()` TOCTOU | ⏩ |
| 3.2 | Gateway filter on subscription lookups | ✅ |
| 3.4 | `amountCents` semantics for Xendit | ⏩ |
| 2.5 | Subscription event idempotency | ⏩ |

### Phase 4 — Polish

| # | Issue | Status |
|---|-------|--------|
| 3.3 | `isTrialEligible()` gateway gate | ✅ |
| 4.1 | Missing `updatedAt` in `awardCredits()` | ✅ |
| 4.3 | `any` param in type guard | ⏩ |
| 4.4 | Silent bonus failure swallowing | ⏩ |
| 4.5 | `c.get("user")!` assertions | ⏩ |
| 4.6 | Debug logging on public endpoint | ⏩ |
| 4.7 | `as unknown as` casts | ⏩ |
| 4.8 | Dynamic import in handler | ✅ |
| 4.9 | Inconsistent `dbRead`/`dbWrite` | ⏩ |
| 2.6 | `isDuplicateTx` shared mutation | ⏩ |
| 5.4 | Rate limit middleware extraction | ⏩ |

---

## Executive summary

The gateway-agnostic payment system (Stripe + Xendit) is architecturally sound — the `PaymentGateway` type system, composite unique constraints, and service-layer abstraction are well designed. However, the audit uncovered **3 critical bugs**, **6 high-severity issues**, and **9 medium-severity issues** across the routes and services layers. The most impactful are:

1. **BigInt truncation in refund math** — micro-refunds claw back 0 credits (financial integrity gap)
2. **Pagination NaN bypass** — unvalidated `parseInt` allows DoS via unlimited row fetch
3. **`awardCredits()` missing row lock** — concurrent awards can produce incorrect balances
4. **URL construction duplicated 4×** — biggest DRY win in the codebase

This document catalogs every issue with exact line numbers, reproduction conditions, severity, and recommended fixes.

---

## Table of contents

1. [Critical issues](#1-critical-issues)
2. [High-severity issues](#2-high-severity-issues)
3. [Medium-severity issues](#3-medium-severity-issues)
4. [Low-severity issues](#4-low-severity-issues)
5. [DRY/SSOT improvement opportunities](#5-dryssot-improvement-opportunities)
6. [Recommended fix priority](#6-recommended-fix-priority)

---

## 1. Critical issues

### 1.1 BigInt truncation in refund credit calculation ✅

**File:** `src/routes/payments.ts:1101-1103`  
**Severity:** Critical — financial integrity  
**Impact:** Partial refunds under ~$0.04 claw back zero credits

```typescript
const creditsToDeduct = Number(
  (BigInt(refundCents) * BigInt(transaction.credits)) / BigInt(originalCents)
);
```

BigInt division truncates toward zero. For a $0.01 refund on a $19.99 pack (500 credits):
- `BigInt(1) * BigInt(500) / BigInt(1999)` = `BigInt(0)` — zero credits clawed back

**Reproduction:** Refund $0.01 on any pack → 0 credits deducted.

**Fix:** Ceiling division:
```typescript
const creditsToDeduct = Number(
  (BigInt(refundCents) * BigInt(transaction.credits) + BigInt(originalCents - 1n)) / BigInt(originalCents)
);
```

---

### 1.2 `parseInt` NaN pagination bypass ✅

**File:** `src/routes/payments.ts:1422-1423`  
**Severity:** Critical — security (DoS)  
**Impact:** Attacker can bypass pagination or trigger `NaN` queries

```typescript
const limitNum = parseInt(limit);
const offsetNum = parseInt(offset);
```

`parseInt("abc")` returns `NaN`. `Math.floor(NaN / NaN) + 1` = `NaN`. Drizzle/Neon may interpret `NaN` as no limit, returning all rows.

**Reproduction:** `GET /transactions?limit=abc` or `GET /transactions?limit=999999999`

**Fix:**
```typescript
const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
const offsetNum = Math.max(parseInt(offset) || 0, 0);
```

---

### 1.3 `awardCredits()` missing row lock (race condition) ✅

**File:** `src/services/credits.ts:620-626`  
**Severity:** High → Critical under concurrent load  
**Impact:** Two concurrent awards can produce incorrect final balance

`awardCredits()` updates `users.credits` with a bare `UPDATE ... + amount` without `SELECT ... FOR UPDATE`:

```typescript
const updateResult = await tx
  .update(users)
  .set({ credits: sql`${users.credits} + ${creditsAmount}` })
  .where(eq(users.userId, userId))
  .returning({ credits: users.credits });
```

Compare with `addCredits()` (line 239-243) and `consumeCreditsInTransaction()` (line 132-137), which both correctly use `.for('update')`.

**Reproduction:** Two concurrent `awardCredits()` calls (e.g., webhook redelivery + manual admin award) → final balance may be incorrect.

**Fix:** Add `.for('update')` lock:
```typescript
const [user] = await tx.select({ credits: users.credits }).from(users)
  .where(eq(users.userId, userId)).for('update').limit(1);
if (!user) throw new Error('User not found');
// then use user.credits + creditsAmount for the update
```

---

## 2. High-severity issues

### 2.1 URL construction duplicated 4× (DRY violation) ✅

**Files:** `src/routes/payments.ts:513-531, 603-621, 647-665, 786-807`  
**Severity:** High — maintainability  
**Impact:** 4 nearly-identical copies of returnUrl/successUrl/cancelUrl construction with origin validation

Each copy differs only in the query param name (`payment` vs `subscription`). This is the biggest DRY win in the payments code.

**Fix:** Extract a helper:
```typescript
function buildReturnUrls(
  returnUrl: string | undefined,
  successPath: string | undefined,
  cancelPath: string | undefined,
  baseUrl: string,
  paramKey: 'payment' | 'subscription',
): { successUrl: string; cancelUrl: string }
```

---

### 2.2 Xendit subscription checkouts not rate-limited ✅

**File:** `src/routes/payments.ts:592-633`  
**Severity:** High — security  
**Impact:** Xendit subscription checkout path bypasses rate limiting

The rate limit check (line 633) is placed **after** the Xendit early return (line 630). Xendit subscription checkouts are never rate-limited.

**Reproduction:** Spam `POST /create-subscription-checkout` with `gateway: "xendit"` → no throttling.

**Fix:** Move the rate limit check before the gateway branch, or add a separate rate limit for the Xendit path.

---

### 2.3 `subscription-plans` leaks full config object ✅

**File:** `src/routes/payments.ts:1509-1519`  
**Severity:** High — information leak  
**Impact:** Internal config fields (e.g., `priceId`, `productId`) exposed to client

```typescript
return c.json({
  plans: [{ ...VIP_SUBSCRIPTION, ... }]
});
```

Spreads the entire `VIP_SUBSCRIPTION` config object into the response. If it ever includes internal fields, they'll be exposed.

**Fix:** Explicitly pick only needed fields:
```typescript
return c.json({
  plans: [{
    id: VIP_SUBSCRIPTION.id,
    name: VIP_SUBSCRIPTION.name,
    priceUSD: VIP_SUBSCRIPTION.priceUSD,
    monthlyCredits: VIP_SUBSCRIPTION.monthlyCredits,
    currency: "USD" as const,
    gateway: PAYMENT_GATEWAY.stripe,
    benefits,
    available: true,
  }],
});
```

---

### 2.4 `webhookDeliveryId!` unsafe non-null assertion ✅

**Files:** `src/routes/payments.ts:1062, 1097, 1124`  
**Severity:** High — runtime crash  
**Impact:** If webhook delivery INSERT fails for a non-unique reason, `webhookDeliveryId` is `null` and `webhookDeliveryId!` throws a runtime error

**Fix:** Guard with null check:
```typescript
if (webhookDeliveryId) {
  await dbWrite.update(webhookDeliveries)
    .set({ status: 'success' })
    .where(eq(webhookDeliveries.id, webhookDeliveryId));
}
```

---

### 2.5 Subscription webhook events not deduplicated in-route ⏩

**File:** `src/routes/payments.ts:1162-1171`  
**Severity:** High — double-processing risk  
**Impact:** If `handleSubscriptionCreated` throws after partial DB write, a re-delivery will re-process

The `checkout.session.completed` and `charge.refunded` handlers have in-transaction idempotency checks. But `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`, and `trial_will_end` are dispatched without any idempotency check in the route handler.

**Mitigation:** The `subscriptions` table's unique constraint on `(gateway, providerSubscriptionId)` and `subscriptionTransactions`'s `(gateway, providerInvoiceId)` provide backstop protection. However, this relies on the service functions catching `isUniqueViolation` correctly.

**Fix:** Add a transaction-level idempotency check for subscription events, or document the reliance on DB constraints.

---

### 2.6 `isDuplicateTx` shared across branches + unsafe mutation ◻️

**File:** `src/routes/payments.ts:1003, 1027-1028, 1064-1068`  
**Severity:** High — fragile pattern  
**Impact:** `isDuplicateTx` is declared at line 1003, then mutated inside `checkout.session.completed` and `charge.refunded` blocks. While currently mutually exclusive (else-if), this is fragile for future refactors.

**Fix:** Scope `isDuplicateTx` inside each branch, or use separate variables.

---

## 3. Medium-severity issues

### 3.1 `refundCreditsIdempotent()` TOCTOU race ⏩

**File:** `src/services/credits.ts:393-416`  
**Severity:** Medium — double refund risk  
**Impact:** Two concurrent redelivered webhooks can both pass the idempotency check, then both call `addCredits()`

The idempotency check (SELECT for existing refund) runs *before* `addCredits()` opens its own transaction. The function uses `LIKE` on JSONB metadata to find existing refunds, which is not guarded by any unique constraint.

**Fix:** Move the idempotency check and the `addCredits` call into the same transaction, or pass `providerEventId` to the refund transaction so the existing `(gateway, providerEventId)` unique constraint can enforce idempotency.

---

### 3.2 `providerSubscriptionId` lookups without gateway filter ✅

**File:** `src/services/subscription.ts:199, 234, 337, 523`  
**Severity:** Medium — correctness  
**Impact:** If Stripe and Xendit ever issued overlapping IDs, a Xendit webhook could mutate a Stripe subscription record

`updateSubscription()`, `renewSubscription()`, `cancelSubscription()`, and `handleTrialWillEnd()` all look up subscriptions by `providerSubscriptionId` alone without filtering by `gateway`.

**Current safety:** Stripe uses `sub_xxx` format, Xendit uses alphanumeric plan IDs — no collision risk today.

**Fix:** Add `gateway` to every `WHERE` clause. All callers already pass `gateway` — it just isn't used in the query.

---

### 3.3 `isTrialEligible()` doesn't gate on gateway ✅

**File:** `src/services/subscription.ts:470-488`  
**Severity:** Medium — UX  
**Impact:** Frontend could show "Start Free Trial" to an Indonesian user (Xendit doesn't support trials)

**Fix:** Add `gateway` parameter and return `false` for non-Stripe gateways.

---

### 3.4 `amountCents` stores IDR, not USD cents ⏩

**File:** `src/services/xendit.ts:327`  
**Severity:** Medium — data semantics  
**Impact:** Analytics interpreting `amountCents` as USD will be wrong for Xendit purchases

```typescript
const amountCents = paidAmount; // paidAmount is IDR whole rupiah
```

**Fix:** Either compute USD-equivalent: `Math.round(paidAmount / XENDIT_CONFIG.usdToIdrRate * 100)`, or store `null` and use `metadata.amountIdr` as the authoritative source.

---

### 3.5 SSOT violation: pack IDs duplicated across configs ◻️

**Files:** `src/config/credits.ts:308-345` + `src/config/xendit.ts:38-54`  
**Severity:** Medium — maintainability  
**Impact:** Adding a pack to `CREDIT_PACKS` but forgetting `XENDIT_CONFIG.creditPacks` causes runtime failure

`CREDIT_PACKS` has Stripe prices; `XENDIT_CONFIG.creditPacks` has IDR prices. The `id` values must match but there's no compile-time check. `XenditCreditPackId` is a manually maintained union type.

**Fix:** Extend `CreditPack` to include optional `xenditPriceIdr`, or create a unified pricing map keyed by `(gateway, packId)`.

---

### 3.6 `isUniqueViolation()` duplicated 3× ◻️

**Files:** `src/services/subscription.ts:51`, `src/services/xendit.ts:275`, `src/routes/payments.ts:145`  
**Severity:** Medium — DRY  
**Impact:** Three identical implementations; `retry.ts` already has a more robust `isUniqueConstraintError()` that walks error cause chains

**Fix:** Delete all three local copies and use `isUniqueConstraintError` from `retry.ts`.

---

### 3.7 `refundCreditsIdempotent()` uses `LIKE` on JSONB metadata ◻️

**File:** `src/services/credits.ts:400`  
**Severity:** Medium — performance  
**Impact:** O(n) full-table-text scan that can't use indexes

```sql
transactions.metadata::text LIKE '%{correlationId}%'
```

Also fragile — a `correlationId` value could appear as a substring of unrelated metadata.

**Fix:** Pass `providerEventId` to the refund transaction so the existing unique constraint can enforce idempotency without the `LIKE` scan.

---

### 3.8 First-purchase bonus lost on main purchase rollback ◻️

**File:** `src/services/xendit.ts:371-389`  
**Severity:** Medium — edge case  
**Impact:** If main purchase unique violation triggers rollback, bonus is also rolled back and not retried

The first-purchase bonus check (`priorPurchase.length === 0`) is inside the transaction. If `awardCredits` for the bonus succeeds but the main purchase row hits a unique violation, the bonus is rolled back. On the next webhook delivery, the bonus might not be retried if the main purchase already exists.

**Fix:** Ensure the bonus check runs in a separate transaction after the main purchase commits, or accept the narrow window.

---

### 3.9 Excessive PII logging in trial checkout ✅

**File:** `src/routes/payments.ts:749-857`  
**Severity:** Medium — security/compliance  
**Impact:** ~20 `console.log` calls with emojis, userId, customerId, session URLs, and price IDs in production

**Fix:** Remove or gate behind `NODE_ENV === 'development'`.

---

## 4. Low-severity issues

| # | Issue | File:Line | Description | Status |
|---|-------|-----------|-------------|--------|
| 4.1 | Missing `updatedAt` in `awardCredits()` | `credits.ts:622` | `UPDATE users` doesn't set `updatedAt`, unlike `addCredits()` and `consumeCreditsInTransaction()` | ✅ |
| 4.2 | `catch (error: any)` | `payments.ts:1650` | Bypasses type checking; should use `unknown` with type guard | ✅ |
| 4.3 | `any` param in type guard | `payments.ts:91` | `isSubscriptionWithPeriods(obj: any)` defeats type safety; use `unknown` | ◻️ |
| 4.4 | Silent bonus failure swallowing | `payments.ts:1058-1060` | First-purchase bonus failure logged but not retried | ◻️ |
| 4.5 | `c.get("user")!` assertions | `payments.ts:499,589,675,751` | Non-null assertions on auth; add `requireUser()` helper | ◻️ |
| 4.6 | Debug logging on public endpoint | `payments.ts:430,438` | `console.log` on every `GET /credit-packs` request | ◻️ |
| 4.7 | `as unknown as` casts | `payments.ts:1263-1279` | Xendit webhook handler bypasses type system | ⏩ |
| 4.8 | Dynamic import in handler | `xendit.ts:173` | `updateSubscription` should be statically imported | ✅ |
| 4.9 | Inconsistent `dbRead`/`dbWrite` | `credits.ts:318 vs 383` | `refundCredits` uses `dbRead`, `refundCreditsIdempotent` uses `dbWrite` for same zero-amount read | ◻️ |

---

## 5. DRY/SSOT improvement opportunities

### 5.1 URL construction extraction (High priority) ✅

**Current:** 4 nearly-identical copies in `payments.ts` (lines 513-531, 603-621, 647-665, 786-807)

**Proposed:** Extract `buildReturnUrls()` helper that handles:
- Origin validation against `FRONTEND_URL`
- Query param setting (`payment` vs `subscription`)
- Fallback to `constructSafeUrl()`

**Effort:** ~30 minutes  
**Impact:** Removes ~80 lines of duplicated code

### 5.2 Unified credit pack config (Medium priority) ◻️

**Current:** Stripe prices in `config/credits.ts`, IDR prices in `config/xendit.ts`, pack IDs manually synchronized

**Proposed:** Extend `CreditPack` type to include optional `xenditPriceIdr?: number`. Single source of truth for all pack metadata.

**Effort:** ~1 hour  
**Impact:** Eliminates SSOT violation, prevents runtime failures from config drift

### 5.3 Shared `isUniqueViolation` (Low priority) ◻️

**Current:** 3 identical implementations + 1 more robust version in `retry.ts`

**Proposed:** Delete local copies, use `isUniqueConstraintError` from `retry.ts`

**Effort:** ~15 minutes  
**Impact:** Consistent error handling, better error chain walking

### 5.4 Extract gateway-agnostic rate limit middleware (Low priority) ◻️

**Current:** Rate limit checks scattered across route handlers with inconsistent keys

**Proposed:** Create a `rateLimitByUser(key, opts)` and `rateLimitGlobal(key, opts)` middleware

**Effort:** ~30 minutes  
**Impact:** Consistent rate limiting, easier to audit

---

## 6. Recommended fix priority

### Phase 1 — Quick wins (1-2 hours)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 1.2 | Fix `parseInt` pagination (clamp + NaN guard) | 5 min | None | ✅ |
| 1.1 | Fix BigInt refund ceiling division | 10 min | Low | ✅ |
| 2.3 | Fix `subscription-plans` config leak (explicit field pick) | 10 min | None | ✅ |
| 2.4 | Fix `webhookDeliveryId!` null guard | 10 min | None | ✅ |
| 3.9 | Remove PII logging in trial checkout | 15 min | None | ✅ |
| 4.2 | Fix `catch (error: any)` to `unknown` | 5 min | None | ✅ |

### Phase 2 — DRY/SSOT (2-3 hours)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 2.1 | Extract `buildReturnUrls()` helper | 30 min | Low | ✅ |
| 3.5 | Unify credit pack config | 1 hr | Medium | ⏩ |
| 3.6 | Consolidate `isUniqueViolation` | 15 min | Low | ⏩ |
| 2.2 | Add rate limit for Xendit subscription path | 15 min | None | ✅ |

### Phase 3 — Financial integrity (3-4 hours)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 1.3 | Add row lock to `awardCredits()` | 30 min | Medium | ✅ |
| 3.1 | Fix `refundCreditsIdempotent()` TOCTOU race | 1 hr | Medium | ⏩ |
| 3.2 | Add gateway filter to subscription lookups | 30 min | Low | ✅ |
| 3.4 | Fix `amountCents` semantics for Xendit | 30 min | Medium | ⏩ |
| 2.5 | Document/add subscription event idempotency | 1 hr | Low | ⏩ |

### Phase 4 — Polish (ongoing)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 3.3 | Add gateway gate to `isTrialEligible()` | 15 min | None | ✅ |
| 4.1-4.9 | Low-severity cleanup | 1 hr total | None | ⏩ |
| 5.4 | Extract rate limit middleware | 30 min | Low | ⏩ |

---

*Audited files: `src/routes/payments.ts` (1659 lines), `src/services/credits.ts` (661 lines), `src/services/subscription.ts` (551 lines), `src/services/xendit.ts` (473 lines), `src/config/credits.ts` (345 lines), `src/config/xendit.ts` (156 lines), `src/config/subscription.ts` (64 lines), `src/types/credits.ts` (66 lines), `src/types/payment.ts` (40 lines)*
