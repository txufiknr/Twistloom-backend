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
- Validates costKey against CREDIT_COSTS configuration
- Uses database transaction with row lock for atomic operations
- Validates credit balance before consumption
- Creates usage transaction record
- Logs user activity for analytics and security monitoring
- Idempotency key support to prevent double charging
- Rate limiting: 60 requests per minute per user
- Skips credit consumption for internal system user (cron jobs)

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
      const { url } = await res.json();
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
