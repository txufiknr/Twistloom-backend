# Payments API Documentation

## Overview

The Payments API provides endpoints for Stripe checkout sessions, credit purchases, transaction history, and credit management. It integrates with Stripe for payment processing and tracks all credit-related transactions including purchases, usage, daily rewards, and refunds.

**Base URL:** `/payments`

**Authentication:** Most endpoints require authentication via NextAuth JWT cookies. Public endpoints allow access to pricing information.

**Response Pattern:**
- GET endpoints: Return resources directly wrapped in descriptive keys (e.g., `{ creditPacks: [...] }`, `{ transactions: [...] }`)
- POST endpoints: Return created resources with 201 status (e.g., `{ session: {...} }`, `{ result: {...} }`)
- Error responses: Follow consistent error format with status codes and messages

---

## Table of Contents

1. [Type Definitions](#type-definitions)
2. [Credit Packs](#credit-packs)
   - [Get Available Credit Packs](#get-paymentcredit-packs)
3. [Subscription Plans](#subscription-plans)
   - [Get Subscription Plans](#get-paymentssubscription-plans)
   - [Create Subscription Checkout](#post-paymentscreate-subscription-checkout)
   - [Get Subscription Status](#get-paymentssubscription)
   - [Cancel Subscription](#post-paymentssubscriptioncancel)
   - [Open Customer Portal](#get-paymentssubscriptionportal)
4. [Checkout Sessions](#checkout-sessions)
   - [Create Checkout Session](#post-paymentscreate-checkout-session)
5. [Webhooks](#webhooks)
   - [Handle Stripe Webhook](#post-paymentsstripewebhook)
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

### CreditPack

Credit pack configuration for purchase options.

```typescript
interface CreditPack {
  id: string;                // Unique identifier for the credit pack
  title: string;             // Display title shown to users
  tagline: string;           // Short tagline for marketing
  description: string;       // Detailed description of what the pack offers
  credits: number;           // Number of credits included in this pack
  priceUSD: number;          // Price in USD
  priceId: string;           // Stripe Price ID for checkout
  productId: string;         // Stripe Product ID for reference
  badge: string | null;      // Optional badge text (e.g., "🔥 Most Popular")
  color: "gray" | "blue" | "purple" | "green" | "yellow" | "red"; // Color theme for UI display
}
```

### Transaction

Credit transaction record.

```typescript
interface Transaction {
  id: string;                // Transaction's unique identifier
  type: "purchase" | "usage" | "refund" | "reward"; // Transaction type
  credits: number;           // Number of credits (positive for addition, negative for usage)
  amountUsd: number | null;  // USD amount (null for usage/reward transactions)
  context: string | null;    // Additional context (e.g., "book_creation", "daily_checkin")
  metadata: object | null;   // Additional metadata as JSON
  createdAt: string;         // Transaction creation timestamp (ISO 8601)
}
```

### CheckoutUrlResponse

Stripe checkout session response returned after creating a checkout session.
Per Stripe best practices, the `sessionId` should be stored client-side for reconciliation,
analytics, and potential retry flows.

```typescript
interface CheckoutUrlResponse {
  url: string;               // Stripe Checkout URL to redirect the user to
  sessionId: string;         // Stripe session ID for reconciliation/analytics
}
```

**Usage:**
```typescript
const { url, sessionId } = await response.json();
console.debug('[checkout] session created', sessionId);
window.location.href = url;
```

### TransactionSummary

Transaction summary statistics.

```typescript
interface TransactionSummary {
  totalCreditsPurchased: number;  // Total credits purchased
  totalCreditsUsed: number;        // Total credits consumed
  totalCreditsRewarded: number;    // Total credits from rewards
  totalAmountSpent: number;        // Total USD spent on purchases
  currentBalance: number;          // Current user credit balance
}
```

### PaginationMeta

Pagination metadata for list endpoints.

```typescript
interface PaginationMeta {
  page: number;              // Current page number (1-based)
  limit: number;             // Number of items per page
  total: number;             // Total number of items
  totalPages: number;        // Total number of pages
  hasNext: boolean;          // Whether there is a next page
  hasPrevious: boolean;      // Whether there is a previous page
}
```

### SubscriptionPlan

Subscription plan configuration for VIP membership.

```typescript
interface SubscriptionPlan {
  id: string;                // Unique identifier for the plan
  name: string;              // Display name shown to users
  description: string;       // Detailed description of the plan
  priceUSD: number;          // Monthly price in USD
  priceId: string;           // Stripe Price ID for checkout
  productId: string;         // Stripe Product ID for reference
  monthlyCredits: number;    // Monthly credits allocated
  checkInMultiplier: number; // Multiplier for daily check-in bonus
  benefits: string[];        // Array of benefit descriptions
}
```

### SubscriptionStatus

User's current subscription status.

```typescript
interface SubscriptionStatus {
  id: string;                         // Subscription ID
  stripeSubscriptionId: string;       // Stripe subscription ID
  status: "active" | "canceled" | "past_due" | "unpaid" | "trialing" | null;
  currentPeriodStart: string;          // Start of current billing period (ISO 8601)
  currentPeriodEnd: string;            // End of current billing period (ISO 8601)
  cancelAtPeriodEnd: boolean;          // Whether subscription cancels at period end
  monthlyCredits: number;             // Monthly credits allocated
}
```

---

## Credit Packs

### GET /payments/credit-packs

Returns the list of available credit packs for purchase. This endpoint allows the frontend to fetch the current credit pack configuration without hardcoding it in the frontend.

**Authentication:** None (public pricing information)

**Response (200 OK):**
```json
[
  {
    "id": "observer",
    "title": "Observer",
    "tagline": "You watch… but rarely interfere.",
    "description": "Step into the dark without committing. Enough to trace a few threads and sense what waits beneath the surface.",
    "credits": 50,
    "priceUSD": 2.99,
    "priceId": "price_1TSq8CFmDKrMqBDfv8hHK8hi",
    "productId": "prod_URjbG0HYUqTKjj",
    "badge": null,
    "color": "gray"
  },
  {
    "id": "investigator",
    "title": "Investigator",
    "tagline": "You follow the clues. Carefully.",
    "description": "Follow the evidence deeper. Shape pivotal moments, reveal what others miss, and craft your own story moves.",
    "credits": 150,
    "priceUSD": 7.99,
    "priceId": "price_1TSqEFFmDKrMqBDfJNv4Rhvi",
    "productId": "prod_URjhcMuRg9MAl7",
    "badge": "🔥 Most Popular",
    "color": "blue"
  },
  {
    "id": "mastermind",
    "title": "Mastermind",
    "tagline": "You don't follow the story. You control it.",
    "description": "The story bends to you. Forge custom choices, pursue alternate endings, and leave your mark on every chapter.",
    "credits": 500,
    "priceUSD": 19.99,
    "priceId": "price_1TSqEpFmDKrMqBDfhrwd9wOn",
    "productId": "prod_URjiSAzuitp1le",
    "badge": "💎 Best Value",
    "color": "purple"
  }
]
```

**Behavior:**
- Returns safe data only (no sensitive configuration)
- Includes all credit packs configured in the system
- Pricing is public information, no authentication required

---

## Subscription Plans

### GET /payments/subscription-plans

Returns the available subscription plans for purchase.

**Authentication:** None (public pricing information)

**Response (200 OK):**
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
      "monthlyCredits": 50,
      "checkInMultiplier": 2,
      "benefits": [
        "VIP badge",
        "2x check-in bonus",
        "+50 monthly credits"
      ]
    }
  ]
}
```

**Behavior:**
- Returns safe data only (prices, descriptions, benefits)
- No authentication required

---

### POST /payments/create-subscription-checkout

Creates a Stripe checkout session for VIP subscription. The user is redirected to Stripe's secure checkout page to complete the subscription.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

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
- **400 Bad Request**: User already has active subscription
- **401 Unauthorized**: Authentication required
- **429 Too Many Requests**: Rate limit exceeded (1 request per 10 seconds per user)
- **500 Internal Server Error**: Stripe API error or VIP subscription not configured

**Behavior:**
- Checks if user already has an active subscription
- Creates or retrieves Stripe customer ID
- Creates Stripe checkout session in subscription mode
- Supports refresh-less UX with returnUrl parameter
- Rate limited to prevent duplicate session creation
- Uses idempotency key to prevent duplicate sessions
- Webhook handles subscription activation and credit allocation

**Optional Enhancements:**
- Add subscription cancellation endpoint for immediate cancellation
- Add subscription update payment method endpoint
- Implement subscription pause/resume functionality

---

### GET /payments/subscription

Returns the authenticated user's current subscription status.

**Authentication:** Optional (via `optionalAuth`) — returns `{ hasActiveSubscription: false }` for guests

**Response (200 OK) - Active Subscription:**
```json
{
  "hasActiveSubscription": true,
  "subscription": {
    "id": "sub_1234567890",
    "stripeSubscriptionId": "sub_1234567890",
    "status": "active",
    "currentPeriodStart": "2026-05-23T00:00:00.000Z",
    "currentPeriodEnd": "2026-06-23T00:00:00.000Z",
    "cancelAtPeriodEnd": false
  },
  "vipExpiresAt": "2026-06-23T00:00:00.000Z"
}
```

**Response (200 OK) - No Subscription:**
```json
{
  "hasActiveSubscription": false
}
```

**Error Responses:**
- **401 Unauthorized**: Authentication required
- **500 Internal Server Error**: Database error

**Behavior:**
- Checks if user has active VIP subscription
- Returns subscription details if active
- Returns VIP expiration date
- Returns null if no subscription exists

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

Creates a Stripe checkout session for purchasing credits. The user is redirected to Stripe's secure checkout page to complete the payment.

**Authentication:** Required (via `requireAuth`)

**Headers:**
- `X-App-Version`: Application version (for analytics)
- `X-Platform`: Client platform (android/ios)

**Request Body:**
```json
{
  "packId": "investigator",
  "returnUrl": "https://app.twistloom.com/books/hush-frequency/pageId"
}
```

Parameters:
- `packId` (required): Credit pack ID (e.g., `"observer"`, `"investigator"`, `"mastermind"`)
- `returnUrl` (optional): Current page URL for refresh-less UX. Backend appends `?payment=success` or `?payment=cancel` automatically.
- `successPath` (optional, legacy): Custom success path (relative, e.g., `/dashboard?success=true`)
- `cancelPath` (optional, legacy): Custom cancel path (relative, e.g., `/pricing`)

**Response (200 OK):**
```json
{
  "url": "https://checkout.stripe.com/pay/cs_1234567890",
  "sessionId": "cs_1234567890"
}
```

**Error Responses:**
- **400 Bad Request**: Invalid pack ID or user not found
- **401 Unauthorized**: Authentication required
- **404 Not Found**: Credit pack not found
- **429 Too Many Requests**: Rate limit exceeded
- **500 Internal Server Error**: Stripe API error

**Behavior:**
- Validates packId against CREDIT_PACKS configuration
- Validates URLs to prevent open redirects
- Creates Stripe checkout session with pre-created price ID
- Supports refresh-less UX with returnUrl parameter (preferred — backend auto-appends payment status params)
- Rate limited to prevent duplicate session creation (1 session per 10 seconds per user)
- Uses rate limiting for abuse prevention
- Webhook handles credit allocation on successful payment

---

## Webhooks

### POST /payments/stripe/webhook

Handles Stripe webhook events for payment confirmation and other Stripe events. This endpoint is called by Stripe to notify the application of payment status changes.

**Authentication:** None (Stripe signature verification)

**Headers:**
- `stripe-signature`: Stripe webhook signature for verification

**Request Body:** Stripe webhook event payload

**Response (200 OK):**
```json
{
  "received": true
}
```

**Handled Events:**
- **checkout.session.completed**: Successful payment - credits are awarded
- **charge.refunded**: Charge refunded - credits deducted
- **customer.subscription.created**: New subscription created
- **customer.subscription.updated**: Subscription updated
- **customer.subscription.deleted**: Subscription canceled
- **invoice.payment_succeeded**: Invoice paid - monthly credits allocated
- **invoice.payment_failed**: Invoice payment failed

**Behavior:**
- Verifies Stripe signature for security
- Processes completed checkout sessions to award credits
- Creates transaction records for purchases
- Updates user credit balance
- Handles payment failures gracefully

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
  "success": false,
  "error": "Error message description"
}
```

**Validation Error Response (400):**
```json
{
  "success": false,
  "error": "Invalid input",
  "details": {
    "field": "priceId",
    "message": "Invalid price ID"
  }
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
- `POST /payments/consume-credits`: 60 requests per minute per user
- `GET /payments/transactions`: 30 requests per minute per user
- `GET /payments/subscription`: 30 requests per minute per user
- `POST /payments/subscription/cancel`: 10 requests per minute per user
- `GET /payments/subscription/portal`: 30 requests per minute per user

**Webhook endpoint:**
- `POST /payments/stripe/webhook`: 1000 requests per minute per IP (Stripe only)

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

### Transactions Table
```sql
CREATE TABLE "transactions" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid REFERENCES users(id) ON DELETE cascade NOT NULL,
  "type" text NOT NULL, -- "purchase" | "usage" | "refund" | "reward"
  "credits" integer NOT NULL,
  "amount_usd" real,
  "context" text, -- Additional context for usage transactions
  "metadata" jsonb, -- Additional metadata for the transaction
  "payment_intent_id" text UNIQUE, -- Stripe payment intent for idempotency
  "stripe_event_id" text UNIQUE, -- Stripe event ID for webhook idempotency
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

### Users Table (Credits Column)
```sql
CREATE TABLE "users" (
  "user_id" uuid PRIMARY KEY,
  -- ... other user fields
  "credits" integer DEFAULT 0 NOT NULL,
  -- ... other user fields
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

---

## Testing

### Example cURL Commands

**Get available credit packs:**
```bash
curl https://api.twistloom.com/payments/credit-packs
```

**Create checkout session:**
```bash
curl -X POST https://api.twistloom.com/payments/create-checkout-session \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "packId": "investigator",
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
