# Payments API Documentation

## Overview

The Payments API provides endpoints for multi-gateway checkout (Stripe + Xendit credit packs), VIP subscriptions (Stripe), transaction history, and credit management. The database is **gateway-agnostic**; webhooks write the same columns with a `gateway` discriminator.

**Base URL:** `/api/payments`

**Gateways:**
| Gateway | Credit packs | VIP subscription | Notes |
|---------|--------------|------------------|--------|
| `stripe` | ✅ USD Checkout | ✅ | Default |
| `xendit` | ✅ IDR Invoice | ❌ v1 (Phase 2b later) | Requires `XENDIT_ENABLED=true` |

**Authentication:** Most endpoints require NextAuth JWT cookies. Pricing endpoints are public. Webhooks use provider signatures/tokens (not user auth).

**Return URL contract (gateway-agnostic):**
- Credit packs: `?payment=success` / `?payment=cancel`
- Subscriptions: `?subscription=success` / `?subscription=cancel`

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Credit Packs](#credit-packs)
   - [Get Available Credit Packs](#get-paymentscredit-packs)
3. [Subscription Plans](#subscription-plans)
   - [Get Subscription Plans](#get-paymentssubscription-plans)
   - [Create Subscription Checkout](#post-paymentscreate-subscription-checkout)
   - [Create Trial Checkout](#post-paymentscreate-trial-checkout-session)
   - [Check Trial Eligibility](#get-paymentssubscriptiontrial-eligibility)
   - [Get Subscription Status](#get-paymentssubscription)
   - [Cancel Subscription](#post-paymentssubscriptioncancel)
   - [Open Customer Portal](#get-paymentssubscriptionportal)
4. [Checkout Sessions](#checkout-sessions)
   - [Create Checkout Session](#post-paymentscreate-checkout-session)
5. [Webhooks](#webhooks)
   - [Handle Stripe Webhook](#post-paymentsstripewebhook)
   - [Handle Xendit Webhook](#post-paymentsxenditwebhook)
6. [Credit Management](#credit-management)
   - [Consume Credits](#post-paymentsconsume-credits)
7. [Transaction History](#transaction-history)
   - [Get Transaction History](#get-paymentstransactions)
8. [Error Handling](#error-handling)
9. [HTTP Headers](#http-headers)
10. [Rate Limiting](#rate-limiting)
11. [Authentication](#authentication)
12. [Database Schema](#database-schema)
13. [Testing](#testing)
14. [Changelog](#changelog)

---

## Type Definitions

### PaymentGateway

```typescript
type PaymentGateway = "stripe" | "xendit";
// Source: src/types/payment.ts — PAYMENT_GATEWAY.stripe | PAYMENT_GATEWAY.xendit
```

### CreditPack

Response shape depends on `?gateway=` (fields omitted when not applicable).

```typescript
interface CreditPack {
  id: string;
  title: string;
  tagline: string;
  description: string;
  credits: number;
  badge: string | null;
  color: "gray" | "blue" | "purple" | "green" | "yellow" | "red";
  gateway: PaymentGateway;
  currency: "USD" | "IDR";
  // Stripe (gateway=stripe)
  priceUSD?: number;
  priceId?: string;
  productId?: string;
  // Xendit (gateway=xendit)
  priceIdr?: number | null;
}
```

### Transaction

```typescript
interface Transaction {
  id: string;
  type: "purchase" | "usage" | "refund" | "reward";
  credits: number;
  gateway: PaymentGateway;
  amountCents: number | null;   // USD cents (Stripe) or whole IDR (Xendit packs)
  amountUsd: number | null;     // amountCents/100 when gateway=stripe
  amountIdr: number | null;     // amountCents when gateway=xendit
  context: string | null;
  metadata: object | null;
  providerPaymentId: string | null;
  providerEventId: string | null;
  createdAt: string;
}
```

### CheckoutUrlResponse

```typescript
interface CheckoutUrlResponse {
  url: string;                 // Hosted checkout URL (Stripe Checkout or Xendit Invoice)
  sessionId: string;           // Stripe session id or Xendit invoice id
  gateway: PaymentGateway;
}
```

**Usage:**
```typescript
const { url, sessionId, gateway } = await response.json();
console.debug('[checkout]', gateway, sessionId);
window.location.href = url;
```

### TransactionSummary

```typescript
interface TransactionSummary {
  totalCreditsPurchased: number;
  totalCreditsUsed: number;
  totalCreditsRewarded: number;
  totalAmountSpent: number;        // Mixed-currency aggregate — prefer per-row amountUsd/amountIdr for display
  currentBalance: number;
}
```

### PaginationMeta

```typescript
interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
```

### SubscriptionPlan

```typescript
interface SubscriptionPlan {
  id: string;
  name: string;
  description: string;
  monthlyCredits: number;
  checkInMultiplier: number;
  benefits: string[];
  gateway: PaymentGateway;
  currency: "USD" | "IDR";
  available: boolean;              // false for Xendit until Phase 2b
  message?: string;                // e.g. why unavailable
  // Stripe
  priceUSD?: number;
  priceId?: string;
  productId?: string;
  // Xendit (stub)
  priceIdr?: number;
}
```

### UserSubscription

```typescript
interface UserSubscription {
  id: string;
  gateway: PaymentGateway;
  providerSubscriptionId: string;  // was stripeSubscriptionId
  status: "active" | "canceled" | "past_due" | "unpaid" | "trialing" | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  monthlyCredits: number;
  isTrial: boolean;
  trialEnd: string | null;
}
```

---

## Credit Packs

### GET /payments/credit-packs

Returns credit packs for the selected payment gateway.

**Authentication:** None (public)

**Query:**
| Param | Default | Description |
|-------|---------|-------------|
| `gateway` | `stripe` | `stripe` \| `xendit` |

**Response (200 OK) — Stripe:**
```json
[
  {
    "id": "observer",
    "title": "Observer",
    "tagline": "You watch… but rarely interfere.",
    "description": "Step into the dark without committing...",
    "credits": 50,
    "priceUSD": 2.99,
    "priceId": "price_...",
    "productId": "prod_...",
    "currency": "USD",
    "gateway": "stripe",
    "badge": null,
    "color": "gray"
  }
]
```

**Response (200 OK) — Xendit (`?gateway=xendit`):**
```json
[
  {
    "id": "observer",
    "title": "Observer",
    "tagline": "You watch… but rarely interfere.",
    "description": "Step into the dark without committing...",
    "credits": 50,
    "priceIdr": 45000,
    "currency": "IDR",
    "gateway": "xendit",
    "badge": null,
    "color": "gray"
  }
]
```

**Errors:**
- `400` — invalid `gateway`, or Xendit requested while `XENDIT_ENABLED` is not `true`

---

## Subscription Plans

### GET /payments/subscription-plans

Returns VIP plan metadata for the selected gateway.

**Authentication:** None (public)

**Query:**
| Param | Default | Description |
|-------|---------|-------------|
| `gateway` | `stripe` | `stripe` \| `xendit` |

**Response (200 OK) — Stripe:**
```json
{
  "plans": [
    {
      "id": "vip_monthly",
      "name": "Twistloom VIP",
      "description": "Monthly VIP membership with exclusive benefits",
      "priceUSD": 9.99,
      "priceId": "price_...",
      "productId": "prod_...",
      "currency": "USD",
      "gateway": "stripe",
      "available": true,
      "monthlyCredits": 200,
      "checkInMultiplier": 2,
      "benefits": ["VIP badge", "2x check-in bonus", "+200 monthly credits"]
    }
  ]
}
```

**Response (200 OK) — Xendit:** plan stub with `available: false` and `priceIdr` (checkout not implemented yet).

**Behavior:**
- Returns safe data only (prices, descriptions, benefits)
- No authentication required

---

### POST /payments/create-subscription-checkout

Creates a VIP subscription checkout. **v1 supports Stripe only.** Pass `gateway: "xendit"` to get a clear validation error until Phase 2b.

**Authentication:** Required

**Request Body:**
```json
{
  "gateway": "stripe",
  "returnUrl": "https://app.twistloom.com/dashboard",
  "successPath": "/dashboard?subscription=success",
  "cancelPath": "/pricing"
}
```

**Response (200 OK):**
```json
{
  "url": "https://checkout.stripe.com/pay/cs_1234567890",
  "sessionId": "cs_1234567890",
  "gateway": "stripe"
}
```

**Error Responses:**
- **400 Bad Request**: User already has active subscription, invalid gateway, or `gateway: xendit` (not available yet)
- **401 Unauthorized**: Authentication required
- **429 Too Many Requests**: Rate limit exceeded (1 request per 10 seconds per user)
- **500 Internal Server Error**: Stripe API error or VIP subscription not configured

**Behavior:**
- Optional `gateway` (default `stripe`); Xendit VIP rejected until Phase 2b
- Checks if user already has an active subscription
- Creates or retrieves provider customer ID (`users.customer_id`)
- Creates Stripe checkout session in subscription mode
- Supports refresh-less UX with returnUrl parameter
- Rate limited to prevent duplicate session creation
- Webhook handles subscription activation and credit allocation

**Optional Enhancements:**
- Add subscription cancellation endpoint for immediate cancellation
- Add subscription update payment method endpoint
- Implement subscription pause/resume functionality

---

### POST /payments/create-trial-checkout-session

Creates a Stripe Checkout session for the VIP free trial. This is a separate endpoint (not a param on `create-subscription-checkout`) because trial and non-trial checkout have different validation paths.

**Authentication:** Required (via `requireAuth` — wrapped with `wrapAsync` for async error safety)

**Request Body:**
```json
{
  "returnUrl": "https://app.twistloom.com/dashboard",
  "successPath": "/dashboard?subscription=success",
  "cancelPath": "/pricing"
}
```

**Response (200 OK):**
```json
{
  "url": "https://checkout.stripe.com/pay/cs_1234567890",
  "sessionId": "cs_1234567890"
}
```

**Error Responses:**
- **400 Bad Request**: Trials disabled (`VIP_TRIAL.enabled` is false), user not eligible, or invalid returnUrl
- **401 Unauthorized**: Authentication required
- **429 Too Many Requests**: Rate limit exceeded (1 request per 10 seconds per user)
- **500 Internal Server Error**: Can be caused by:
  - Express 4.x async rejection in `requireAuth` middleware (now guarded by `wrapAsync`)
  - Missing `FRONTEND_URL` or `VIP_SUBSCRIPTION.priceId` environment variable
  - Stripe API error when creating customer or checkout session
  - Database query failure in `isTrialEligible()`

**Behavior:**
- Server-side eligibility re-check via `isTrialEligible()` (defense in depth — never trust the frontend gate alone)
- Rate-limited: 1 session per 10 seconds per user
- `metadata.isTrial: "true"` set on both the session and `subscription_data.metadata`
- Reuses the same `?subscription=success` / `?subscription=cancel` redirect contract as regular subscription checkout
- `payment_method_collection: "always"` — card required upfront (LinkedIn-style)

**Debugging:**
The handler has 11 strategic `[trial-checkout]` console.log checkpoints covering every gate. Check stdout (not stderr) to trace exactly where a failure occurs:

```
[trial-checkout] ▶️ Entered handler
[trial-checkout] userId=abc123
[trial-checkout] 🔒 Checking rate limit for trial-checkout-abc123
[trial-checkout] ✅ Rate limit passed
[trial-checkout] 🔧 VIP_TRIAL.enabled=true
[trial-checkout] 🔍 Checking trial eligibility for userId=abc123
[trial-checkout] ✅ Trial eligible=true
[trial-checkout] 🔗 Checking FRONTEND_URL
[trial-checkout] ✅ FRONTEND_URL=https://app.twistloom.com
[trial-checkout] 🔗 Processing returnUrl=...
[trial-checkout] ✅ URLs: success=..., cancel=...
[trial-checkout] 🔧 Checking VIP_SUBSCRIPTION.priceId
[trial-checkout] ✅ VIP_SUBSCRIPTION.priceId=price_xxx
[trial-checkout] 📡 Querying user's stripeCustomerId
[trial-checkout] 📡 User lookup: stripeCustomerId=null (will create)
[trial-checkout] 🏦 Creating new Stripe customer for userId=abc123
[trial-checkout] ✅ Stripe customer created: id=cus_xxx
[trial-checkout] 💳 Creating Stripe checkout session...
[trial-checkout] 💳 trial_period_days=30, endBehavior=cancel
[trial-checkout] ✅ Stripe session created: id=cs_xxx, url=https://checkout.stripe.com/...
[trial-checkout] ❌ CAUGHT ERROR: Error: ...
```

---

### GET /payments/subscription/trial-eligibility

Checks whether the current user is eligible for the VIP free trial. This is a UX convenience gate — the backend independently re-checks eligibility at checkout-session creation (server-side security boundary).

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "eligible": true
}
```

**Error Responses:**
- **401 Unauthorized**: Authentication required
- **500 Internal Server Error**: Database query failure

**Behavior:**
- Returns `{ eligible: true }` if the user has never used a trial (`users.vipTrialUsedAt IS NULL`) AND has no active VIP subscription
- Returns `{ eligible: false }` if either condition fails
- One-trial-per-user enforced here and at checkout creation

---

### GET /payments/subscription

Returns the authenticated user's current subscription status.

**Authentication:** Optional (via `optionalAuth`) — returns `{ hasActiveSubscription: false }` for guests

**Response (200 OK) - Active Subscription:**
```json
{
  "hasActiveSubscription": true,
  "subscription": {
    "id": "uuid-...",
    "gateway": "stripe",
    "providerSubscriptionId": "sub_1234567890",
    "status": "active",
    "currentPeriodStart": "2026-05-23T00:00:00.000Z",
    "currentPeriodEnd": "2026-06-23T00:00:00.000Z",
    "cancelAtPeriodEnd": false,
    "monthlyCredits": 200,
    "isTrial": false,
    "trialEnd": null
  }
}
```

**Response (200 OK) - No Subscription:**
```json
{
  "hasActiveSubscription": false,
  "subscription": null
}
```

**Error Responses:**
- **401 Unauthorized**: Authentication required
- **500 Internal Server Error**: Database error

**Behavior:**
- Checks if user has active VIP subscription
- Returns subscription details if active
- Returns null subscription if no active subscription or guest

**Optional Enhancements:**
- Add subscription history endpoint to show past subscriptions
- Add proration preview for plan changes

---

### GET /payments/subscription/portal

Creates a Stripe Customer Portal session for subscription management. This allows users to manage their subscription (update payment method, cancel immediately, etc.) through Stripe's hosted portal.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `returnUrl` (optional): URL to redirect to after portal session (default: dashboard)

**Response (200 OK):**
```json
{
  "url": "https://billing.stripe.com/session/1234567890"
}
```

**Error Responses:**
- **404 Not Found**: No subscription found
- **401 Unauthorized**: Authentication required
- **500 Internal Server Error**: Stripe API error

**Behavior:**
- Creates Stripe Customer Portal session
- Redirects user to Stripe's hosted management portal
- User can update payment method, cancel immediately, etc.
- Returns to specified returnUrl after portal session

**Optional Enhancements:**
- Configure portal features to limit user actions
- Add subscription update endpoint for programmatic changes

---

### POST /payments/subscription/cancel

Cancels the authenticated user's active subscription at the period end (not immediately).

**Authentication:** Required (via `requireAuth`)

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Subscription will be canceled at period end"
}
```

**Error Responses:**
- **401 Unauthorized**: Authentication required
- **404 Not Found**: No active subscription found
- **500 Internal Server Error**: Stripe API error

**Behavior:**
- Sets `cancel_at_period_end = true` on Stripe subscription
- Updates local database record
- User retains access until the end of the current billing period
- For immediate cancellation, use the Stripe Customer Portal

---

## Checkout Sessions

### POST /payments/create-checkout-session

Creates a one-time credit pack checkout via **Stripe Checkout** or **Xendit Invoice**.

**Authentication:** Required

**Request Body:**
```json
{
  "packId": "investigator",
  "gateway": "stripe",
  "returnUrl": "https://app.twistloom.com/books/hush-frequency/pageId"
}
```

Parameters:
- `packId` (required): `"observer"` | `"investigator"` | `"mastermind"`
- `gateway` (optional, default `stripe`): `stripe` | `xendit`
- `returnUrl` (optional): Backend appends `?payment=success` / `?payment=cancel`
- `successPath` / `cancelPath` (optional, legacy)

**Response (200 OK):**
```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_...",
  "gateway": "stripe"
}
```

Xendit example: `url` is Xendit `invoice_url`, `sessionId` is invoice id, `gateway: "xendit"`.

**Errors:** `400` invalid gateway / Xendit disabled · `401` · `404` pack · `429` · `500`

**Behavior:**
- Rate limit: 1 request / 10s / user
- Stripe: Checkout Session with pack `priceId`
- Xendit: Invoice API (`POST /v2/invoices`), credits awarded on webhook
- Same return URL contract for both gateways

---

## Webhooks

### POST /payments/stripe/webhook

Stripe-signed webhook for payments and subscriptions.

**Auth:** `stripe-signature` header · **Env:** `STRIPE_WEBHOOK_SECRET`

**Response:** `{ "received": true }` (or `{ "received": true, "duplicate": true }`)

**Handled events:**
- `checkout.session.completed` (mode=payment) — credit pack purchase
- `charge.refunded` — claw back credits
- `customer.subscription.created|updated|deleted`
- `invoice.payment_succeeded` (renewals only, `billing_reason=subscription_cycle`)
- `invoice.payment_failed` → `past_due`
- `customer.subscription.trial_will_end`

Writes `gateway: "stripe"` on all DB rows.

---

### POST /payments/xendit/webhook

Xendit Invoice callbacks (credit packs v1).

**Auth:** header `x-callback-token` must equal `XENDIT_WEBHOOK_TOKEN`  
**Gate:** `XENDIT_ENABLED=true`  
**URL to configure in Xendit Dashboard:** `https://<backend>/api/payments/xendit/webhook`

**Response:** `{ "received": true }` or `{ "received": true, "duplicate": true }`

**Behavior:**
- On paid/settled invoice → award pack credits + optional first-purchase bonus
- Idempotent via `(gateway, provider_event_id)` / delivery tracking
- Non-paid statuses are acknowledged without awarding

---

## Credit Management

### POST /payments/consume-credits

Consumes credits from the authenticated user's account for usage (story generation, actions, etc.).

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "costKey": "STORY_GENERATION",
  "idempotencyKey": "story-gen-book123-abc",
  "context": "book_creation",
  "metadata": {
    "bookId": "book_123",
    "theme": "Mystery Detective"
  }
}
```

Parameters:
- `costKey` (required): Credit cost key from CREDIT_COSTS config (e.g., `"STORY_GENERATION"`, `"CHOOSE_OTHER_ACTION"`)
- `idempotencyKey` (optional): Unique key to prevent double charging on retries
- `context` (optional): Human-readable context for the transaction record
- `metadata` (optional): Arbitrary metadata persisted alongside the transaction

**Response (200 OK):**
```json
{
  "success": true,
  "creditsConsumed": 5,
  "remainingCredits": 145
}
```

**Error Responses:**
- **400 Bad Request**: Invalid costKey or user not found
- **401 Unauthorized**: Authentication required
- **402 Payment Required**: Insufficient credits
```json
{
  "error": "Insufficient credits. Requires 5 credits.",
  "required": 5
}
```
- **409 Conflict**: Duplicate request (idempotency key already used)
- **429 Too Many Requests**: Rate limit exceeded (60 req/min per user)

**Behavior:**
- Validates costKey against CREDIT_COSTS configuration
- Uses database transaction with row lock for atomic operations
- Validates credit balance before consumption
- Creates usage transaction record
- Logs user activity for analytics and security monitoring
- Idempotency key support to prevent double charging
- Rate limiting: 60 requests per minute per user
- Skips credit consumption for internal system user (cron jobs)

---

## Transaction History

### GET /payments/transactions

Retrieves the authenticated user's complete transaction history including credit purchases, usage, daily check-in rewards, and refunds.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Query Parameters:**
- `limit` (number, optional): Maximum number of results (default: 50)
- `offset` (number, optional): Pagination offset (default: 0)
- `type` (string, optional): Filter by transaction type (purchase|usage|refund|reward)
- `startDate` (string, optional): Filter transactions from date (YYYY-MM-DD)
- `endDate` (string, optional): Filter transactions to date (YYYY-MM-DD)

**Response (200 OK):**
```json
{
  "transactions": [
    {
      "id": "txn_123",
      "type": "reward",
      "credits": 30,
      "amountUsd": null,
      "context": "daily_checkin",
      "metadata": {
        "checkInDate": "2026-05-04"
      },
      "createdAt": "2026-05-04T00:00:00.000Z"
    },
    {
      "id": "txn_456",
      "type": "purchase",
      "credits": 150,
      "amountUsd": 7.99,
      "context": "credit_pack_purchase",
      "metadata": {
        "packId": "investigator"
      },
      "createdAt": "2026-05-03T14:30:00.000Z"
    },
    {
      "id": "txn_789",
      "type": "usage",
      "credits": -5,
      "amountUsd": null,
      "context": "book_creation",
      "metadata": {
        "bookId": "book_abc123"
      },
      "createdAt": "2026-05-03T15:45:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  },
  "summary": {
    "totalCreditsPurchased": 500,
    "totalCreditsUsed": 350,
    "totalCreditsRewarded": 180,
    "totalAmountSpent": 29.97,
    "currentBalance": 330
  }
}
```

**Behavior:**
- Returns transactions in reverse chronological order (newest first)
- Supports filtering by transaction type and date range
- Includes pagination metadata for large result sets
- Provides summary statistics for user's credit activity
- Parses metadata JSON for frontend consumption

**Transaction Types:**
- **purchase**: Credits bought via Stripe payment
- **usage**: Credits consumed for story generation/actions
- **reward**: Free credits from daily check-in or promotions
- **refund**: Credits refunded to user

---

## Error Handling

All endpoints follow consistent error response formats:

**Standard Error Response:**
```json
{
  "error": "Error message description"
}
```

**Validation Error Response (400):**
```json
{
  "error": "Invalid input"
}
```

**Insufficient Credits Error (402):**
```json
{
  "error": "Insufficient credits. Requires 5 credits.",
  "required": 5
}
```

**Authentication Error (401):**
```json
{
  "success": false,
  "error": "Authentication required"
}
```

---

## HTTP Headers

### Request Headers

**Required for authenticated endpoints:**
- `Cookie`: NextAuth session token (automatically sent by browser)

**Optional headers for analytics:**
- `X-App-Version`: Application version (e.g., "1.0.0")
- `X-Platform`: Client platform (android/ios/web)

**Webhook-specific headers:**
- `stripe-signature`: Stripe webhook signature verification

### Response Headers

**Standard headers:**
- `Content-Type`: application/json
- `Cache-Control`: Configured per endpoint

**CORS headers:**
- `Access-Control-Allow-Origin`: Configured for frontend domain
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE
- `Access-Control-Allow-Headers`: Content-Type, Authorization

---

## Rate Limiting

Different endpoints have different rate limits to prevent abuse:

**Public endpoints:**
- `GET /payments/credit-packs`: 100 requests per minute per IP
- `GET /payments/subscription-plans`: 100 requests per minute per IP

**Authenticated endpoints:**
- `POST /payments/create-checkout-session`: 1 request per 10 seconds per user
- `POST /payments/create-subscription-checkout`: 1 request per 10 seconds per user
- `POST /payments/create-trial-checkout-session`: 1 request per 10 seconds per user
- `POST /payments/consume-credits`: 60 requests per minute per user
- `GET /payments/transactions`: 30 requests per minute per user
- `GET /payments/subscription`: 30 requests per minute per user
- `GET /payments/subscription/trial-eligibility`: 30 requests per minute per user
- `POST /payments/subscription/cancel`: 10 requests per minute per user
- `GET /payments/subscription/portal`: 30 requests per minute per user

**Webhook endpoint:**
- `POST /payments/stripe/webhook`: 300 requests per minute global (Stripe only — shared Redis key)

Rate limiting is implemented using Redis with IP-based and user-based keys.

---

## Authentication

Most endpoints require authentication via NextAuth JWT cookies:

**Authentication Flow:**
1. User logs in via NextAuth (Google OAuth or Email/Password)
2. NextAuth sets session cookie
3. API middleware validates session cookie
4. User ID extracted from session for database operations

**Authentication Required:**
- `POST /payments/create-checkout-session`
- `POST /payments/create-subscription-checkout`
- `POST /payments/consume-credits`
- `GET /payments/transactions`
- `POST /payments/subscription/cancel`
- `GET /payments/subscription/portal`

**Optional Authentication (different response for guests):**
- `GET /payments/subscription` — returns `{ hasActiveSubscription: false }` for unauthenticated users

**Public Endpoints:**
- `GET /payments/credit-packs` (pricing information)
- `GET /payments/subscription-plans` (pricing information)
- `POST /payments/stripe/webhook` (Stripe signature verification)

---

## Database Schema

### Users Table (Credits & VIP Columns)
```sql
-- customer_id: Stripe cus_xxx or Xendit customer id (was stripe_customer_id)
CREATE TABLE "users" (
  "user_id" uuid PRIMARY KEY,
  "credits" integer NOT NULL,
  "tier" text,
  "subscription_id" uuid,
  "vip_expires_at" timestamptz,
  "vip_trial_used_at" timestamptz,
  "customer_id" text UNIQUE,
  ...
);
```

### Transactions Table
```sql
CREATE TABLE "transactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL,
  "type" text NOT NULL,
  "credits" integer NOT NULL,
  "amount_cents" integer,           -- USD cents (Stripe) or whole IDR (Xendit packs)
  "context" text,
  "metadata" jsonb,
  "gateway" text NOT NULL DEFAULT 'stripe',
  "provider_payment_id" text,       -- was payment_intent_id
  "provider_event_id" text,         -- was stripe_event_id
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, provider_payment_id),
  UNIQUE (gateway, provider_event_id)
);
```

### Subscriptions Table
```sql
CREATE TABLE "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL,
  "gateway" text NOT NULL DEFAULT 'stripe',
  "provider_subscription_id" text NOT NULL,  -- was stripe_subscription_id
  "provider_customer_id" text NOT NULL,
  "provider_price_id" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamptz,
  "is_trial" boolean NOT NULL DEFAULT false,
  "trial_end" timestamptz,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, provider_subscription_id)
);
```

### Subscription Transactions Table
```sql
CREATE TABLE "subscription_transactions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "subscription_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "type" text NOT NULL,
  "credits_allocated" integer NOT NULL,
  "gateway" text NOT NULL DEFAULT 'stripe',
  "provider_invoice_id" text,       -- was stripe_invoice_id
  "provider_event_id" text,         -- was stripe_event_id
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, provider_invoice_id),
  UNIQUE (gateway, provider_event_id)
);
```

### Webhook Deliveries Table
```sql
CREATE TABLE "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "gateway" text NOT NULL DEFAULT 'stripe',
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "delivered_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "status" text NOT NULL DEFAULT 'retrying',
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_id)
);
```

### User Notifications Table
```sql
CREATE TABLE "user_notifications" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "user_id" uuid NOT NULL REFERENCES users(user_id) ON DELETE cascade,
  "type" text NOT NULL, -- 'payment_success', 'refund', 'trial_ending_soon', 'first_purchase_bonus'
  "title" text NOT NULL,
  "message" text NOT NULL,
  "data" jsonb,
  "read" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

---

## Testing

### Example cURL Commands

**Get available credit packs:**
```bash
curl "https://api.twistloom.com/api/payments/credit-packs?gateway=stripe"
curl "https://api.twistloom.com/api/payments/credit-packs?gateway=xendit"
```

**Create checkout session (Stripe or Xendit):**
```bash
curl -X POST https://api.twistloom.com/api/payments/create-checkout-session \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "packId": "investigator",
    "gateway": "stripe",
    "returnUrl": "https://app.twistloom.com/books/my-story/page-1"
  }'
```

**Consume credits:**
```bash
curl -X POST https://api.twistloom.com/payments/consume-credits \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "costKey": "STORY_GENERATION",
    "idempotencyKey": "story-gen-book123",
    "context": "book_creation",
    "metadata": {"bookId": "book_123"}
  }'
```

**Get transaction history:**
```bash
curl "https://api.twistloom.com/payments/transactions?limit=20&type=reward" \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN"
```

---

## Changelog

### v2.0.0 (2026-07-24) — Gateway-agnostic + Xendit credit packs
- **Schema (Drizzle):** renamed Stripe-specific columns → `gateway` + `provider_*`; unique constraints scoped by gateway
- **Type:** `PaymentGateway` / `PAYMENT_GATEWAY` in `src/types/payment.ts`
- **Credit packs:** `GET /credit-packs?gateway=`, `POST /create-checkout-session` body `{ gateway }`
- **Xendit:** Invoice checkout + `POST /xendit/webhook` (`x-callback-token`); env `XENDIT_*`
- **Subscriptions:** `providerSubscriptionId` in GET `/subscription`; plans endpoint gateway-aware; VIP still Stripe-only
- **Transactions API:** `amountUsd` / `amountIdr` by gateway; `awardCredits` writes provider IDs
- **Docs:** architecture §14; this API doc updated
- **Pending:** run `pnpm db:generate` + migrate before deploy

### v1.6.0 (2026-07-14)
- **Async error hardening**: Added `wrapAsync()` utility in `src/utils/error.ts` to catch promise rejections from async Express middleware (Express 4.x does not handle these natively). Applied to `POST /payments/create-trial-checkout-session` — both `requireAuth` and the handler itself are wrapped.
- **Debug logging**: `handleApiError()` now writes to both stdout (`console.log`) and stderr (`console.error`) so error output is visible regardless of which stream the operator is watching.
- **11-step trace**: `POST /payments/create-trial-checkout-session` now logs every gate (rate limit, eligibility, URL validation, Stripe customer lookup, Stripe session creation) with `[trial-checkout]` tags.
- **Documentation**: Added missing `POST /payments/create-trial-checkout-session` and `GET /payments/subscription/trial-eligibility` API sections with full error response details and debugging guidance.

### v1.5.0 (2026-07-12)
- Migrated `transactions.amount_usd` (real) → `transactions.amount_cents` (integer) for Stripe-compatible precision
- API response `amountUsd` is now computed as `amountCents / 100` (no frontend contract change)
- Fixed `POST /payments/subscription/cancel` to join via `users.subscriptionId` (canonical pattern)
- Added `isTrial: "false"` metadata to regular `create-subscription-checkout` for Stripe symmetry
- Added migration `0021_rustic_echo` for the schema change

### v1.4.0 (2026-07-12)
- Added VIP free trial implementation with one-trial-per-user permanent lockout
- Added `POST /payments/create-trial-checkout-session` endpoint for trial checkout
- Added `GET /payments/subscription/trial-eligibility` endpoint for eligibility checks
- Added `customer.subscription.trial_will_end` webhook handler for trial-ending notifications
- Added `subscriptionTransactions` table to track subscription lifecycle events separately
- Added trial analytics snapshot on trial expiry (records remaining credits)
- Fixed `users.subscriptionId` canonical pointer pattern in subscription queries
- Fixed subscription cancel endpoint to use correct join pattern
- Updated documentation to reflect full payment schema and rate limiting

### v1.3.0 (2026-05-24)
- Fixed Stripe customer ID naming inconsistency across database tables
- Changed subscriptions table from `stripeCustomerId` to `stripeCustomerId` for consistency
- Added `stripeCustomerId` to AuthUser type for type safety
- Added runtime validation type guards for Stripe webhook handlers
- Fixed invoice.payment_failed handler to use correct subscription period end
- Replaced hardcoded status strings with typed values in subscription service
- Added POST /payments/create-subscription-checkout endpoint for VIP subscriptions
- Added GET /payments/subscription endpoint for subscription status retrieval
- Updated subscription documentation with current endpoint signatures
- Added @future-enhancements JSDoc comments to subscription endpoints

### v1.2.0 (2026-05-23)
- Added subscription management endpoints for VIP membership
- Implemented GET /payments/subscription-plans for fetching subscription plans
- Implemented POST /payments/create-subscription-checkout for subscription checkout
- Implemented GET /payments/subscription for fetching user subscription status
- Implemented POST /payments/subscription/cancel for canceling subscriptions
- Implemented GET /payments/subscription/portal for Stripe Customer Portal access
- Added subscription webhook handlers (customer.subscription.*, invoice.payment_*)
- Added SubscriptionPlan and SubscriptionStatus type definitions
- Updated webhook documentation to include subscription events

### v1.1.0 (2026-05-06)
- Enhanced credit consumption with idempotency key support
- Added user activity logging for credit consumption
- Implemented rate limiting on credit consumption endpoint (60 req/min per user)
- Refactored consume-credits route to use centralized service function
- Added server-side validation for credit cost keys
- Improved error handling with detailed insufficient credits response

### v1.0.0 (2026-05-04)
- Initial payments API implementation
- Stripe checkout session creation
- Credit pack configuration management
- Transaction tracking and history
- Webhook handling for payment confirmation
- Daily reward bonus tracking
- Usage and purchase transaction management
- Comprehensive transaction history endpoint
- Support for all transaction types: purchase, usage, refund, reward
- Pagination and filtering for transaction history
- Transaction summary statistics
- Type-safe transaction handling with shared types

### Key Features
- **Credit Purchases**: Integration with Stripe for secure payment processing
- **Transaction Tracking**: Complete audit trail of all credit movements
- **Daily Rewards**: Automatic tracking of daily check-in bonuses
- **Usage Monitoring**: Detailed tracking of credit consumption
- **Historical Analysis**: Rich transaction history with filtering and pagination
- **Real-time Balance**: Accurate credit balance tracking
- **Webhook Processing**: Reliable payment confirmation handling
- **Type Safety**: Shared TypeScript types across the system
- **Idempotency**: Prevent double charging with idempotency keys
- **Rate Limiting**: Protection against abuse with Redis-based rate limiting
- **Activity Logging**: Complete audit trail for security and analytics

---

## Future Enhancements

This section outlines planned enhancements for the subscription and payments system. These are optional improvements that can be implemented based on business needs and priorities.

### Subscription Management Enhancements

#### 1. Subscription Cancellation Endpoint
**Priority:** High  
**Description:** Add an endpoint for immediate subscription cancellation (not just cancel at period end)

```typescript
POST /payments/subscription/cancel-immediately
```

**Benefits:**
- Users can cancel immediately without waiting for period end
- Pro-rated refunds can be processed
- Better user control over subscription

**Implementation Considerations:**
- Handle proration calculations
- Process refunds via Stripe API
- Update VIP tier immediately
- Send cancellation notification

---

#### 2. Subscription Update Payment Method
**Priority:** Medium  
**Description:** Add endpoint to update subscription payment method without using Customer Portal

```typescript
POST /payments/subscription/update-payment-method
{
  "paymentMethodId": "pm_1234567890"
}
```

**Benefits:**
- Custom UI for payment method updates
- Better integration with app design
- Can add payment method validation

**Implementation Considerations:**
- Validate payment method before updating
- Handle 3D Secure authentication
- Update Stripe subscription directly
- Send confirmation notification

---

#### 3. Subscription Pause/Resume
**Priority:** Medium  
**Description:** Implement subscription pause/resume functionality for temporary breaks

```typescript
POST /payments/subscription/pause
{
  "resumeAt": "2026-07-01" // Optional resume date
}

POST /payments/subscription/resume
```

**Benefits:**
- Users can pause subscription temporarily
- Retain customers who need breaks
- Flexible subscription management

**Implementation Considerations:**
- Use Stripe's pause_collection feature
- Handle billing during pause period
- Resume notifications
- Credit allocation during pause

---

#### 4. Subscription Upgrade/Downgrade
**Priority:** High  
**Description:** Add endpoint for changing subscription plans with proration

```typescript
POST /payments/subscription/change-plan
{
  "newPriceId": "price_new_plan",
  "prorationBehavior": "create_prorations" | "none"
}
```

**Benefits:**
- Users can upgrade/downgrade plans
- Pro-rated billing adjustments
- Flexible plan options

**Implementation Considerations:**
- Calculate proration amounts
- Handle immediate charges for upgrades
- Credit adjustments for downgrades
- Plan change notifications

---

#### 5. Proration Preview
**Priority:** Medium  
**Description:** Add endpoint to preview proration costs before plan changes

```typescript
GET /payments/subscription/proration-preview?newPriceId=price_new_plan
```

**Benefits:**
- Users see costs before changing plans
- Transparent billing
- Better user experience

**Implementation Considerations:**
- Use Stripe's invoice preview API
- Display proration breakdown
- Show effective dates
- Handle tax calculations

---

### Webhook Enhancements

#### 6. Webhook Retry Logic
**Priority:** High  
**Description:** Implement automatic retry logic for failed webhook deliveries

**Benefits:**
- Improved reliability
- Automatic recovery from transient failures
- Better data consistency

**Implementation Considerations:**
- Exponential backoff strategy
- Maximum retry attempts
- Dead letter queue for permanent failures
- Monitoring and alerting

---

#### 7. Webhook Delivery Monitoring
**Priority:** Medium  
**Description:** Add monitoring dashboard for webhook delivery status

**Benefits:**
- Visibility into webhook processing
- Troubleshooting failed deliveries
- Performance monitoring

**Implementation Considerations:**
- Track delivery status in database
- Success/failure metrics
- Retry attempt tracking
- Error aggregation

---

### API Optimization

#### 8. Stripe Expand Parameter
**Priority:** Low  
**Description:** Use Stripe's expand parameter to reduce API calls

**Benefits:**
- Fewer API requests
- Faster response times
- Reduced latency

**Implementation Considerations:**
- Expand subscription items in webhook handlers
- Expand customer details
- Batch related data fetches
- Cache expanded responses

---

### Analytics & Reporting

#### 9. Subscription History Endpoint
**Priority:** Medium  
**Description:** Add endpoint to retrieve user's subscription history

```typescript
GET /payments/subscription/history
```

**Benefits:**
- Users can see past subscriptions
- Audit trail for compliance
- Analytics on subscription patterns

**Implementation Considerations:**
- Include status changes
- Show billing periods
- Display cancellation reasons
- Pagination for large histories

---

#### 10. Usage Analytics
**Priority:** Low  
**Description:** Add analytics for subscription benefit usage

**Benefits:**
- Track VIP feature usage
- Measure subscription value
- Inform product decisions

**Implementation Considerations:**
- Track credit usage patterns
- Monitor check-in bonus usage
- Feature adoption metrics
- ROI calculations

---

### Security Enhancements

#### 11. Customer Portal Configuration
**Priority:** Medium  
**Description:** Configure Stripe Customer Portal to limit user actions

**Benefits:**
- Prevent unwanted subscription changes
- Control user permissions
- Enforce business rules

**Implementation Considerations:**
- Disable immediate cancellation
- Limit plan changes
- Control payment method updates
- Custom portal features

---

### Priority Summary

**High Priority (Implement Soon):**
1. Subscription cancellation endpoint
2. Subscription upgrade/downgrade
3. Webhook retry logic

**Medium Priority (Implement When Needed):**
1. Subscription update payment method
2. Subscription pause/resume
3. Proration preview
4. Webhook delivery monitoring
5. Subscription history endpoint
6. Customer portal configuration

**Low Priority (Nice to Have):**
1. Stripe expand parameter optimization
2. Usage analytics

---

## Frontend Implementation Guide

This section provides a comprehensive guide for implementing the payments and credits system in your frontend application.

### Prerequisites

- Next.js or similar frontend framework
- Authentication system (NextAuth recommended)
- State management (React Context, Redux, or Zustand)
- Error handling utilities

### Credit Cost Configuration

The backend defines credit costs for various actions. These should be mirrored in your frontend for UI display:

```typescript
// src/config/credits.ts
export const CREDIT_COSTS = {
  STORY_GENERATION: 5,
  CHOOSE_OTHER_ACTION: 2,
  CUSTOM_ACTION: 5,
  TIME_TRAVEL_PER_PAGE: 5,
  UNLOCK_ALTERNATE_ENDING: 10,
} as const;

export type CreditCostKey = keyof typeof CREDIT_COSTS;
```

### Credit Balance Display

Display user credit balance prominently in the UI:

```typescript
// src/components/CreditBalance.tsx
import { useUser } from '@/hooks/useUser';

export function CreditBalance() {
  const { user } = useUser();
  
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">Credits:</span>
      <span className="text-lg font-bold text-blue-600">
        {user?.credits ?? 0}
      </span>
    </div>
  );
}
```

### Credit Pack Display

Fetch and display available credit packs:

```typescript
// src/components/CreditPacks.tsx
import { useEffect, useState } from 'react';

interface CreditPack {
  id: string;
  title: string;
  tagline: string;
  description: string;
  credits: number;
  priceUSD: number;
  priceId: string;
  highlight: boolean;
  badge: string | null;
  valueTag: string;
  color: string;
}

export function CreditPacks() {
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPacks() {
      try {
        const res = await fetch('/api/payments/credit-packs');
        const data = await res.json();
        setPacks(data);
      } catch (error) {
        console.error('Failed to fetch credit packs:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchPacks();
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {packs.map((pack) => (
        <CreditPackCard key={pack.id} pack={pack} currentUrl={window.location.href} />
      ))}
    </div>
  );
}

function CreditPackCard({ pack, currentUrl }: { pack: CreditPack; currentUrl?: string }) {
  const handlePurchase = async () => {
    try {
      const res = await fetch('/api/payments/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packId: pack.id,
          returnUrl: currentUrl || window.location.href, // Return to current page after payment
        }),
      });
      const { url, sessionId } = await res.json();
      window.location.href = url;
    } catch (error) {
      console.error('Failed to create checkout session:', error);
    }
  };

  return (
    <div className={`border rounded-lg p-6 ${pack.highlight ? 'border-blue-500 shadow-lg' : ''}`}>
      {pack.badge && (
        <span className="text-xs font-bold bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
          {pack.badge}
        </span>
      )}
      <h3 className="text-xl font-bold mt-2">{pack.title}</h3>
      <p className="text-sm text-gray-600">{pack.tagline}</p>
      <p className="text-gray-700 mt-2">{pack.description}</p>
      <div className="mt-4">
        <span className="text-2xl font-bold">${pack.priceUSD}</span>
        <span className="text-sm text-gray-500 ml-2">{pack.credits} credits</span>
      </div>
      <p className="text-xs text-gray-400 mt-1">{pack.valueTag}</p>
      <button
        onClick={handlePurchase}
        className="mt-4 w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
      >
        Purchase
      </button>
    </div>
  );
}
```

### Refresh-Less UX Pattern

The recommended approach for a seamless payment experience is to use the "refresh-less UX" pattern, where users return to the same page after payment without a full page reload.

#### How It Works

1. **User Context Preservation**: Pass the current page URL as `returnUrl` when creating checkout session
2. **Payment Status Detection**: Backend appends `?payment=success` or `?payment=cancel` to the return URL
3. **Query Invalidation**: Frontend detects the query param and invalidates TanStack Query cache
4. **Seamless Experience**: User stays on the same page with updated credits

#### Backend Implementation

The backend now supports an optional `returnUrl` parameter:

```typescript
// Request body with returnUrl
{
  packId: 'investigator',
  returnUrl: 'https://twistloom-web.vercel.app/books/hush-frequency/019df7bf-2692-73e9-902b-0670ade943a5'
}

// Backend constructs:
// success_url: '.../books/hush-frequency/...?payment=success'
// cancel_url: '.../books/hush-frequency/...?payment=cancel'
```

#### Frontend Implementation with TanStack Query

```typescript
// src/hooks/usePaymentStatus.ts
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Hook to detect payment status and refresh user data
 * Call this in your layout or page component to handle payment returns
 */
export function usePaymentStatus() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  useEffect(() => {
    const paymentStatus = searchParams.get('payment');

    if (paymentStatus === 'success') {
      // Invalidate user queries to refresh credit balance
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['credits'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });

      // Clean up URL param (optional, but recommended for UX)
      const url = new URL(window.location.href);
      url.searchParams.delete('payment');
      window.history.replaceState({}, '', url.toString());

      // Optional: Show success toast
      // toast.success('Payment successful! Credits added.');
    } else if (paymentStatus === 'cancel') {
      // Clean up URL param
      const url = new URL(window.location.href);
      url.searchParams.delete('payment');
      window.history.replaceState({}, '', url.toString());

      // Optional: Show cancel toast
      // toast.info('Payment cancelled.');
    }
  }, [searchParams, queryClient]);
}
```

#### Complete Reader Page Example

**Intended Flow:**
User on: /books/hush-frequency/019df7bf-2692-73e9-902b-0670ade943a5
↓ Click "Top up" → Modal appears
↓ Buy "Observer Package"
↓ Stripe payment
↓ Returns to: /books/hush-frequency/019df7bf-2692-73e9-902b-0670ade943a5?payment=success
↓ Frontend detects param → invalidates queries
↓ Credits updated (2 → 52) without full page reload
↓ User can choose another action

```typescript
// src/app/books/[slug]/[pageId]/page.tsx
'use client';

import { usePaymentStatus } from '@/hooks/usePaymentStatus';
import { useQuery } from '@tanstack/react-query';
import { CreditPacks } from '@/components/CreditPacks';

export default function ReaderPage({ params }: { params: { slug: string; pageId: string } }) {
  // Detect and handle payment status
  usePaymentStatus();

  // Fetch user data with TanStack Query
  const { data: user } = useQuery({
    queryKey: ['user'],
    queryFn: () => fetch('/api/user').then(res => res.json()),
  });

  const currentUrl = typeof window !== 'undefined' 
    ? window.location.href 
    : `https://twistloom-web.vercel.app/books/${params.slug}/${params.pageId}`;

  return (
    <div>
      {/* Reader UI */}
      <h1>Reading: {params.slug}</h1>
      
      {/* Credit balance display */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Credits:</span>
        <span className="text-lg font-bold text-blue-600">
          {user?.credits ?? 0}
        </span>
        <button
          onClick={() => setShowCreditModal(true)}
          className="text-sm text-blue-500 hover:underline"
        >
          (Top up)
        </button>
      </div>

      {/* Credit purchase modal */}
      {showCreditModal && (
        <div className="modal">
          <CreditPacks currentUrl={currentUrl} />
        </div>
      )}
    </div>
  );
}
```

#### Why This Pattern?

**Benefits:**
- ✅ User stays in reading context (no navigation away from book)
- ✅ No full page reload (feels seamless)
- ✅ Credits update instantly via query invalidation
- ✅ Works with any page (reader, dashboard, etc.)
- ✅ Webhook-based credit granting (secure, not frontend-dependent)

**Security:**
- ✅ Credits are granted via webhook, not frontend
- ✅ Query param only triggers UI refresh, not credit allocation
- ✅ Backend validates all operations

**Fallback:**
- If `returnUrl` is not provided, backend uses legacy behavior (`/dashboard?success=true`)

**Key points:**
- ✅ Credits granted via webhook (secure, not frontend-dependent)
- ✅ Query param only triggers UI refresh, not credit allocation
- ✅ User stays in reading context (no navigation away)
- ✅ Works with TanStack Query invalidation for seamless UX

### Credit Consumption

Consume credits for user actions with proper error handling and idempotency:

```typescript
// src/hooks/useCredits.ts
import { useState, useCallback } from 'react';

interface ConsumeCreditsOptions {
  costKey: string;
  idempotencyKey?: string;
  context?: string;
  metadata?: Record<string, unknown>;
}

interface ConsumeCreditsResult {
  success: boolean;
  creditsConsumed: number;
  remainingCredits: number;
}

export function useCredits() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consumeCredits = useCallback(async (
    options: ConsumeCreditsOptions
  ): Promise<ConsumeCreditsResult | null> => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/payments/consume-credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        const errorData = await res.json();
        
        if (res.status === 402) {
          // Insufficient credits
          throw new Error(
            `Not enough credits. Required: ${errorData.required}, Available: ${errorData.available}`
          );
        } else if (res.status === 409) {
          // Duplicate request (idempotency)
          console.log('Duplicate request detected, returning cached result');
          return errorData;
        } else if (res.status === 429) {
          // Rate limited
          throw new Error('Too many requests. Please wait before trying again.');
        } else {
          throw new Error(errorData.error || 'Failed to consume credits');
        }
      }

      const data = await res.json();
      return data;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      console.error('Failed to consume credits:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { consumeCredits, loading, error };
}
```

### Story Generation Example

Implement credit consumption for story generation:

```typescript
// src/components/StoryGenerator.tsx
import { useState } from 'react';
import { useCredits } from '@/hooks/useCredits';

export function StoryGenerator() {
  const [generating, setGenerating] = useState(false);
  const { consumeCredits, loading: creditsLoading, error: creditsError } = useCredits();

  const handleGenerateStory = async (theme: string) => {
    setGenerating(true);
    
    // Generate idempotency key for this specific generation
    const idempotencyKey = `story-${Date.now()}-${theme.slice(0, 10)}`;
    
    // Consume credits first
    const result = await consumeCredits({
      costKey: 'STORY_GENERATION',
      idempotencyKey,
      context: 'book_creation',
      metadata: { theme },
    });

    if (!result) {
      setGenerating(false);
      return; // Error already set by useCredits hook
    }

    try {
      // Proceed with story generation
      const storyRes = await fetch('/api/books/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      const story = await storyRes.json();
      
      // Update UI with generated story
      console.log('Story generated:', story);
    } catch (error) {
      console.error('Failed to generate story:', error);
      // Consider refunding credits if generation fails
      // (Implement refund logic if needed)
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      {creditsError && (
        <div className="bg-red-100 text-red-700 p-3 rounded mb-4">
          {creditsError}
        </div>
      )}
      
      <button
        onClick={() => handleGenerateStory('mystery')}
        disabled={generating || creditsLoading}
        className="bg-purple-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {generating ? 'Generating...' : 'Generate Mystery Story (5 credits)'}
      </button>
    </div>
  );
}
```

### Transaction History Display

Display user's transaction history:

```typescript
// src/components/TransactionHistory.tsx
import { useEffect, useState } from 'react';

interface Transaction {
  id: string;
  type: 'purchase' | 'usage' | 'refund' | 'reward';
  credits: number;
  amountUsd: number | null;
  context: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface TransactionSummary {
  totalCreditsPurchased: number;
  totalCreditsUsed: number;
  totalCreditsRewarded: number;
  totalAmountSpent: number;
  currentBalance: number;
}

export function TransactionHistory() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchHistory() {
      try {
        const res = await fetch('/api/payments/transactions?limit=20');
        const data = await res.json();
        setTransactions(data.transactions);
        setSummary(data.summary);
      } catch (error) {
        console.error('Failed to fetch transaction history:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
      {summary && (
        <div className="bg-gray-50 p-4 rounded-lg">
          <h3 className="font-bold mb-2">Credit Summary</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600">Current Balance:</span>
              <span className="font-bold ml-2">{summary.currentBalance}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Purchased:</span>
              <span className="font-bold ml-2 text-green-600">+{summary.totalCreditsPurchased}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Used:</span>
              <span className="font-bold ml-2 text-red-600">-{summary.totalCreditsUsed}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Rewarded:</span>
              <span className="font-bold ml-2 text-blue-600">+{summary.totalCreditsRewarded}</span>
            </div>
            <div>
              <span className="text-gray-600">Total Spent:</span>
              <span className="font-bold ml-2">${summary.totalAmountSpent.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}

      <div>
        <h3 className="font-bold mb-4">Recent Transactions</h3>
        <div className="space-y-2">
          {transactions.map((tx) => (
            <TransactionItem key={tx.id} transaction={tx} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TransactionItem({ transaction }: { transaction: Transaction }) {
  const isPositive = transaction.credits > 0;
  const colorClass = isPositive ? 'text-green-600' : 'text-red-600';
  const sign = isPositive ? '+' : '';

  const typeLabels = {
    purchase: 'Purchase',
    usage: 'Usage',
    refund: 'Refund',
    reward: 'Reward',
  };

  return (
    <div className="flex items-center justify-between p-3 bg-white border rounded">
      <div>
        <div className="font-medium">{typeLabels[transaction.type]}</div>
        {transaction.context && (
          <div className="text-sm text-gray-500">{transaction.context}</div>
        )}
        <div className="text-xs text-gray-400">
          {new Date(transaction.createdAt).toLocaleString()}
        </div>
      </div>
      <div className={`font-bold ${colorClass}`}>
        {sign}{transaction.credits}
      </div>
    </div>
  );
}
```

### Success Page Handling

Handle Stripe checkout success and refresh user data:

```typescript
// src/app/payment/success/page.tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function PaymentSuccessPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function refreshUserData() {
      try {
        // Refresh user data to get updated credit balance
        await fetch('/api/user', { method: 'GET' });
        // Or refresh your user context/state
      } catch (error) {
        console.error('Failed to refresh user data:', error);
      } finally {
        setLoading(false);
      }
    }
    refreshUserData();
  }, []);

  if (loading) {
    return <div>Processing payment...</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md">
        <div className="text-center">
          <div className="text-green-500 text-6xl mb-4">✓</div>
          <h1 className="text-2xl font-bold mb-2">Payment Successful!</h1>
          <p className="text-gray-600 mb-6">
            Your credits have been added to your account.
          </p>
          <button
            onClick={() => router.push('/dashboard')}
            className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700"
          >
            Continue to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Error Handling Best Practices

1. **Always check credit balance before expensive operations**
2. **Use idempotency keys for retry logic**
3. **Display clear error messages for insufficient credits**
4. **Show loading states during credit consumption**
5. **Refresh user data after successful credit operations**
6. **Handle rate limiting gracefully with retry logic**
7. **Log errors for debugging**

### Security Considerations

1. **Never trust client-side credit calculations**
2. **Always use server-side credit consumption**
3. **Validate all inputs before sending to API**
4. **Use HTTPS for all API calls**
5. **Implement proper authentication**
6. **Handle sensitive data securely**
7. **Never expose API keys or secrets**

### Testing Checklist

- [ ] Credit pack display loads correctly
- [ ] Checkout session creation works
- [ ] Stripe redirect flow completes
- [ ] Credits are added after successful payment
- [ ] Credit consumption works with valid balance
- [ ] Insufficient credits error displays correctly
- [ ] Idempotency prevents double charging
- [ ] Rate limiting prevents abuse
- [ ] Transaction history displays correctly
- [ ] User balance updates in real-time
- [ ] Error handling works for all edge cases
