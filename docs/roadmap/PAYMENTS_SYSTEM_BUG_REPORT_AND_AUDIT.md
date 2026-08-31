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
| 3.5 | Type-link credit pack configs | ✅ (Keep As-Is) |
| 3.6 | Consolidate `isUniqueViolation` | ✅ |
| 2.2 | Rate limit for Xendit subscription | ✅ |

### Phase 3 — Financial integrity

| # | Issue | Status |
|---|-------|--------|
| 1.3 | `awardCredits()` row lock | ✅ |
| 3.1 | `refundCreditsIdempotent()` TOCTOU | ✅ |
| 3.2 | Gateway filter on subscription lookups | ✅ |
| 3.4 | `amountCents` semantics for Xendit | ⏩ (Keep As-Is) |
| 2.5 | Subscription event idempotency | ✅ |
| 3.7 | `refundCreditsIdempotent()` exact JSONB match | ✅ |
| 3.8 | Xendit first-purchase bonus alignment | ✅ |

### Phase 4 — Polish

| # | Issue | Status |
|---|-------|--------|
| 3.3 | `isTrialEligible()` gateway gate | ✅ |
| 4.1 | Missing `updatedAt` in `awardCredits()` | ✅ |
| 4.3 | `any` param in type guard | ✅ |
| 4.4 | Silent bonus failure swallowing | ✅ |
| 4.5 | `c.get("user")!` assertions | ✅ |
| 4.6 | Debug logging on public endpoint | ✅ |
| 4.7 | `as unknown as` casts | ✅ |
| 4.8 | Dynamic import in handler | ✅ |
| 4.9 | Inconsistent `dbRead`/`dbWrite` | ✅ |
| 2.6 | `isDuplicateTx` shared mutation | ✅ |
| 5.4 | Rate limit middleware extraction | ⏩ (Keep As-Is) |

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

### 2.5 Subscription webhook events not deduplicated in-route ✅

**File:** `src/routes/payments.ts:1162-1171`  
**Severity:** High — double-processing risk  
**Impact:** If `handleSubscriptionCreated` throws after partial DB write, a re-delivery will re-process

The `checkout.session.completed` and `charge.refunded` handlers have in-transaction idempotency checks. But `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`, and `trial_will_end` are dispatched without any idempotency check in the route handler.

**Resolution:** Service-layer idempotency is already handled: `createSubscription` catches `isUniqueViolation` on `(gateway, providerSubscriptionId)`, `renewSubscription` catches `isUniqueViolation` on `(gateway, providerInvoiceId)`, and `cancelSubscription`/`updateSubscription`/`handleTrialWillEnd` are inherently idempotent (SET status = X). The webhook delivery table deduplicates at the route level.

---

### 2.6 `isDuplicateTx` shared across branches + unsafe mutation ✅

**File:** `src/routes/payments.ts:1003, 1027-1028, 1064-1068`  
**Severity:** High — fragile pattern  
**Impact:** `isDuplicateTx` is declared at line 1003, then mutated inside `checkout.session.completed` and `charge.refunded` blocks. While currently mutually exclusive (else-if), this is fragile for future refactors.

**Resolution:** Already fixed during Gateway Adapter Pattern refactoring. `handleCheckoutSessionCompleted` and `handleChargeRefunded` are now separate functions in `src/services/gateways/stripe-webhook-handlers.ts`, each with their own function-scoped `let isDuplicateTx = false`.

---

## 3. Medium-severity issues

### 3.1 `refundCreditsIdempotent()` TOCTOU race ✅

**File:** `src/services/credits.ts:393-416`  
**Severity:** Medium — double refund risk  
**Impact:** Two concurrent redelivered webhooks can both pass the idempotency check, then both call `addCredits()`

The idempotency check (SELECT for existing refund) runs *before* `addCredits()` opens its own transaction. The function uses `LIKE` on JSONB metadata to find existing refunds, which is not guarded by any unique constraint.

**Fix:** Wrapped the idempotency check and `addCredits()` call inside a single `dbWrite.transaction`, passing `tx` to `addCredits` so both the check and the credit addition are atomic. Also changed the zero-amount early return to use `dbRead` for consistency.

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

### 3.4 `amountCents` stores IDR, not USD cents ⏩ (Keep As-Is)

**File:** `src/services/xendit.ts:316`, `src/routes/payments.ts:860`  
**Severity:** Medium — data semantics  
**Status:** **Intentional by Design / Deliberate Trade-off**  
**Reason to Keep As-Is:**
1. **Zero Schema Fragmentation:** Keeping a single generic integer column (`amountCents`) avoids fracturing the `transactions` table schema with gateway-specific columns (`amount_usd_cents`, `amount_idr`, etc.) as regional payment providers are added.
2. **Avoids Destructive DB Migrations:** Changing column semantics or renaming `amountCents` requires migrating production databases and altering all historical transaction queries.
3. **Route-Level Dual-Currency Mapping:** The API already handles this correctly via dual-currency mapping on `GET /transactions` (`amountUsd` for Stripe, `amountIdr` for Xendit).

---

### 3.5 Pack IDs synchronized across configs ✅ (Keep As-Is)

**Files:** `src/config/credits.ts:308-345` + `src/config/xendit.ts:13`  
**Severity:** Medium — maintainability  
**Status:** **Completed via Type-Linking**  
**Resolution:** Derived `XenditCreditPackId = (typeof CREDIT_PACKS)[number]["id"]` for compile-time alignment without tight configuration coupling.  
**Reason to Keep As-Is:**
1. **Gateway Isolation:** Keeps `XENDIT_CONFIG` modular and independent from core credit pack definitions so disabling or enabling gateways has zero blast radius.
2. **Distinct Lifecycles:** USD packs map to Stripe product/price catalog IDs; Xendit amounts are dynamic IDR integers.

---

### 3.6 `isUniqueViolation()` consolidated ✅

**Files:** `src/services/subscription.ts`, `src/services/xendit.ts`, `src/routes/payments.ts`, `src/services/thanks.ts`, `src/services/gateways/stripe-webhook-handlers.ts`  
**Severity:** Medium — DRY  
**Impact:** Replaced all local/ad-hoc unique constraint checks with `isUniqueConstraintError` from `src/utils/retry.ts` which robustly walks error cause chains.

---

### 3.7 `refundCreditsIdempotent()` exact JSONB lookup ✅

**File:** `src/services/credits.ts:403`  
**Severity:** Medium — performance  
**Status:** **Completed**  
**Resolution:** Replaced full-text `LIKE '%{correlationId}%'` scan with exact PostgreSQL JSONB key matching `metadata->>'correlationId' = ${correlationId}`.

---

### 3.8 First-purchase bonus atomic alignment (Xendit) ✅

**File:** `src/services/xendit.ts:366-384`  
**Severity:** Medium — edge case  
**Impact:** Aligned with Stripe pattern — checks for existing `first_purchase_bonus` transaction inside the main transaction, removing dead query code and ensuring atomicity and retries on unique violation.

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
| 4.3 | `any` param in type guard | `stripe-webhook-handlers.ts:32` | `isSubscriptionWithPeriods` uses `unknown` with type guards | ✅ |
| 4.4 | Silent bonus failure swallowing | `payments.ts:1058-1060` | First-purchase bonus failure logged but not retried | ✅ |
| 4.5 | `c.get("user")!` assertions | `payments.ts` | Replaced non-null assertions with `requireUser()` / `requireUserId()` helpers | ✅ |
| 4.6 | Debug logging on public endpoint | `payments.ts:166,174` | Removed `console.log` on `GET /credit-packs` | ✅ |
| 4.7 | `as unknown as` casts | `payments.ts:705-725` | Replaced double casts with dedicated Xendit webhook payload interfaces | ✅ |
| 4.8 | Dynamic import in handler | `xendit.ts:173` | `updateSubscription` should be statically imported | ✅ |
| 4.9 | Inconsistent `dbRead`/`dbWrite` | `credits.ts:318 vs 383` | `refundCredits` uses `dbRead`, `refundCreditsIdempotent` uses `dbWrite` for same zero-amount read | ✅ |

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

### 5.2 Type-linked credit pack config (Medium priority) ✅ (Keep As-Is)

**Current:** Derived `XenditCreditPackId = (typeof CREDIT_PACKS)[number]["id"]` for compile-time synchronization while maintaining modular separation between Stripe (`config/credits.ts`) and Xendit (`config/xendit.ts`).

**Reason to Keep As-Is:** Avoids tightly coupling gateway configs while ensuring zero compile-time configuration drift.

### 5.3 Shared `isUniqueViolation` (Low priority) ✅

**Current:** Replaced local copies with `isUniqueConstraintError` from `src/utils/retry.ts` across all payments, webhook, and tipping services.

**Effort:** ~15 minutes  
**Impact:** Consistent error handling, better error chain walking

### 5.4 Extract gateway-agnostic rate limit middleware (Low priority) ⏩ (Keep As-Is)

**Current:** Rate limit checks are called explicitly inline via `checkRateLimit()` in route handlers.

**Reason to Keep As-Is:**
1. **Explicit Operational Visibility:** Keeps rate limit keys, limits, and messages visible directly in route handlers.
2. **DDoS Defense:** Webhook endpoints throttle before body parsing and signature checking.
3. **Fail-Open Reliability:** Inline `checkRateLimit` handles Redis outages gracefully.

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
| 3.5 | Type-link credit pack configs | 10 min | None | ✅ (Keep As-Is) |
| 3.6 | Consolidate `isUniqueViolation` | 15 min | Low | ✅ |
| 2.2 | Add rate limit for Xendit subscription path | 15 min | None | ✅ |
| 2.6 | Scope `isDuplicateTx` per handler | 5 min | None | ✅ |

### Phase 3 — Financial integrity (3-4 hours)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 1.3 | Add row lock to `awardCredits()` | 30 min | Medium | ✅ |
| 3.1 | Fix `refundCreditsIdempotent()` TOCTOU race | 1 hr | Medium | ✅ |
| 3.2 | Add gateway filter to subscription lookups | 30 min | Low | ✅ |
| 3.4 | Dual-currency `amountCents` semantics | — | Medium | ⏩ (Keep As-Is) |
| 2.5 | Document/add subscription event idempotency | 1 hr | Low | ✅ |
| 3.7 | `refundCreditsIdempotent()` exact JSONB match | 5 min | None | ✅ |
| 3.8 | Fix Xendit first-purchase bonus | 15 min | Low | ✅ |

### Phase 4 — Polish (ongoing)

| # | Issue | Effort | Risk | Status |
|---|-------|--------|------|--------|
| 3.3 | Add gateway gate to `isTrialEligible()` | 15 min | None | ✅ |
| 4.3 | Use `unknown` in type guard | 5 min | None | ✅ |
| 4.5 | Add `requireUser()` / `requireUserId()` helpers | 10 min | None | ✅ |
| 4.6 | Remove debug logging on public endpoints | 5 min | None | ✅ |
| 4.7 | Type Xendit webhook payloads (remove `as unknown as`) | 10 min | None | ✅ |
| 4.1-4.9 | Low-severity cleanup | 1 hr total | None | ✅ |
| 5.4 | Extract rate limit middleware | — | Low | ⏩ (Keep As-Is) |

---

*Audited files: `src/routes/payments.ts` (1659 lines), `src/services/credits.ts` (661 lines), `src/services/subscription.ts` (551 lines), `src/services/xendit.ts` (473 lines), `src/config/credits.ts` (345 lines), `src/config/xendit.ts` (156 lines), `src/config/subscription.ts` (64 lines), `src/types/credits.ts` (66 lines), `src/types/payment.ts` (40 lines)*
