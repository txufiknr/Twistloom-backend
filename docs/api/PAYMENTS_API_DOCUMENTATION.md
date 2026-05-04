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
3. [Checkout Sessions](#checkout-sessions)
   - [Create Checkout Session](#post-paymentscreate-checkout-session)
4. [Webhooks](#webhooks)
   - [Handle Stripe Webhook](#post-paymentsstripewebhook)
5. [Credit Management](#credit-management)
   - [Consume Credits](#post-paymentsconsume-credits)
6. [Transaction History](#transaction-history)
   - [Get Transaction History](#get-paymentstransactions)
7. [Error Handling](#error-handling)
8. [HTTP Headers](#http-headers)
9. [Rate Limiting](#rate-limiting)
10. [Authentication](#authentication)
11. [Database Schema](#database-schema)
12. [Testing](#testing)
13. [Changelog](#changelog)

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
  highlight: boolean;        // Whether to highlight this pack as recommended
  badge: string | null;      // Optional badge text (e.g., "Most Popular")
  valueTag: string;          // Approximate number of choices/uses
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

### CheckoutSession

Stripe checkout session information.

```typescript
interface CheckoutSession {
  id: string;                // Session ID
  url: string;               // Checkout URL for user
  priceId: string;           // Stripe Price ID
  credits: number;           // Credits to be awarded
  amountUsd: number;          // Price in USD
}
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

---

## Credit Packs

### GET /payments/credit-packs

Returns the list of available credit packs for purchase. This endpoint allows the frontend to fetch the current credit pack configuration without hardcoding it in the frontend.

**Authentication:** None (public pricing information)

**Response (200 OK):**
```json
[
  {
    "id": "starter",
    "title": "Starter Pack",
    "tagline": "Perfect for getting started",
    "description": "Get 100 credits to explore and create your first stories",
    "credits": 100,
    "priceUSD": 4.99,
    "priceId": "price_1234567890",
    "productId": "prod_1234567890",
    "highlight": false,
    "badge": null,
    "valueTag": "~20 stories",
    "color": "gray"
  },
  {
    "id": "investigator",
    "title": "Investigator Pack",
    "tagline": "Most popular choice",
    "description": "150 credits for extended story exploration and multiple book creation",
    "credits": 150,
    "priceUSD": 7.99,
    "priceId": "price_2345678901",
    "productId": "prod_2345678901",
    "highlight": true,
    "badge": "Most Popular",
    "valueTag": "~30 stories",
    "color": "blue"
  }
]
```

**Behavior:**
- Returns safe data only (no sensitive configuration)
- Includes all credit packs configured in the system
- Pricing is public information, no authentication required

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
  "priceId": "price_1234567890",
  "successUrl": "https://app.twistloom.com/success",
  "cancelUrl": "https://app.twistloom.com/cancel"
}
```

**Response (201 Created):**
```json
{
  "session": {
    "id": "cs_1234567890",
    "url": "https://checkout.stripe.com/pay/cs_1234567890",
    "priceId": "price_1234567890",
    "credits": 150,
    "amountUsd": 7.99
  }
}
```

**Error Responses:**
- **400 Bad Request**: Invalid price ID or user not found
- **401 Unauthorized**: Authentication required
- **500 Internal Server Error**: Stripe API error

**Behavior:**
- Validates price ID against available credit packs
- Creates Stripe checkout session with metadata
- Includes user ID and credit pack information in session metadata
- Returns secure checkout URL for payment completion
- Webhook handles credit allocation after successful payment

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
- **payment_intent.succeeded**: Payment confirmation
- **payment_intent.payment_failed**: Payment failure

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
  "amount": 5,
  "context": "book_creation",
  "metadata": {
    "bookId": "book_123",
    "theme": "Mystery Detective"
  }
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "creditsConsumed": 5,
  "remainingCredits": 145
}
```

**Error Responses:**
- **400 Bad Request**: Invalid amount or user not found
- **401 Unauthorized**: Authentication required
- **402 Payment Required**: Insufficient credits
```json
{
  "error": "Not enough credits",
  "required": 5,
  "available": 3
}
```

**Behavior:**
- Validates user has sufficient credits
- Atomically decrements credit balance
- Creates usage transaction record
- Returns updated credit balance
- Handles transaction record failures gracefully

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
  "success": false,
  "error": "Not enough credits",
  "required": 5,
  "available": 3
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

**Authenticated endpoints:**
- `POST /payments/create-checkout-session`: 10 requests per minute per user
- `POST /payments/consume-credits`: 60 requests per minute per user
- `GET /payments/transactions`: 30 requests per minute per user

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
- `POST /payments/consume-credits`
- `GET /payments/transactions`

**Public Endpoints:**
- `GET /payments/credit-packs` (pricing information)
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
    "priceId": "price_1234567890",
    "successUrl": "https://app.twistloom.com/success",
    "cancelUrl": "https://app.twistloom.com/cancel"
  }'
```

**Consume credits:**
```bash
curl -X POST https://api.twistloom.com/payments/consume-credits \
  -H "Cookie: next-auth.session-token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 5,
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
