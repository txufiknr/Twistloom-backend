# Stripe Payment Architecture & Best Practices

## Overview

This document outlines the complete Stripe payment system architecture, including Vercel+Neon PostgreSQL best practices, safe transaction implementation with neon-serverless (WebSocket driver), and comprehensive security features.

---

## ✅ Implementation Status

This section tracks which architecture recommendations have been implemented in the codebase.

### ✅ Implemented Features

#### 1. Stripe Checkout (Prebuilt Form)
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` - `POST /payments/create-checkout-session`
- **Details**: Uses Stripe Checkout Sessions with prebuilt payment UI
- **Benefits**: Fast implementation, handles payment UI/validation, mobile optimized, high conversion rate

#### 2. Secure Metadata for User Binding
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 115-119
- **Details**: 
  - Binds purchase to user via `metadata.userId` from authenticated session
  - Never trusts frontend userId directly
  - Uses `req.user!.id` from NextAuth middleware
- **Backup**: Added `client_reference_id: userId` as additional backup (line 120)

#### 3. Credit Pack Configuration
- **Status**: ✅ Implemented
- **Location**: `src/config/credits.ts`
- **Details**: 
  - Three credit packs: Observer (50), Investigator (150), Mastermind (500)
  - Server-side price validation prevents manipulation
  - Dynamic price_data creation (not using pre-created Stripe products)

#### 4. Webhook as Source of Truth
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` - `POST /payments/stripe/webhook`
- **Details**:
  - Handles `checkout.session.completed` for credit allocation
  - Handles `payment_intent.succeeded` for monitoring
  - Handles `payment_intent.payment_failed` for debugging
  - Handles `charge.refunded` for credit deduction
  - Idempotency via `stripeEventId` within database transactions

#### 5. Database Transaction System
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 258-327
- **Details**:
  - Atomic credit updates and transaction record creation
  - Prevents orphaned data via transaction rollback
  - Idempotency check within transaction

#### 6. Raw Body Middleware for Webhook
- **Status**: ✅ Implemented
- **Location**: `src/app.ts` lines 15-17
- **Details**:
  - `express.raw({ type: "application/json" })` applied to webhook route only
  - Applied BEFORE `express.json()` to preserve signature integrity
  - Critical for Stripe webhook signature verification

#### 7. Rate Limiting
- **Status**: ✅ Implemented
- **Location**: 
  - Webhook: `src/routes/payments.ts` lines 177-181 (IP-based, 100 req/15min)
  - Checkout: `src/routes/payments.ts` lines 87-101 (User-based, 1 session/10sec)
- **Details**:
  - Prevents webhook abuse via IP rate limiting
  - Prevents duplicate session spam via user rate limiting
  - Uses Redis for distributed rate limiting

#### 8. Price Validation
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 241-255
- **Details**:
  - Server-side validation of payment amount against expected pack price
  - Prevents price manipulation attacks
  - Logs security incidents for monitoring

#### 9. Webhook Delivery Tracking
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 207-213, 319-326, 402-416
- **Details**:
  - Tracks webhook delivery status (success/failed/retrying)
  - Logs error messages for debugging
  - Enables monitoring and reconciliation

#### 10. User Notifications
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 305-317, 380-391
- **Details**:
  - Automatic notifications for successful payments
  - Automatic notifications for refunds
  - Includes transaction details in notification data

#### 11. Atomic Credit Consumption with Refunds
- **Status**: ✅ Implemented
- **Location**: `src/services/credits.ts`
- **Details**:
  - `executeWithCredits()` - Atomic credit consumption with operation execution
  - `refundCredits()` - Idempotent refund with retry logic
  - Correlation ID for idempotent refunds
  - Automatic refund if operation fails
  - Transaction parameter for full atomicity (optional)

#### 12. Internal User Credit Skip
- **Status**: ✅ Implemented
- **Location**: `src/services/credits.ts` lines 68-78
- **Details**:
  - Automatically skips credit consumption for system user (cron jobs)
  - Checks `userId === process.env.SYSTEM_USER_ID`
  - Returns dummy transaction ID for consistency
  - Prevents charging internal operations

### 🔄 Alternative Approaches Considered

#### Option A: Pre-created Stripe Products (Dashboard)
- **Status**: ✅ Implemented
- **Reason**: Using dynamic `price_data` for flexibility
- **Note**: Could migrate to pre-created products for better Stripe dashboard management

#### Option B: Auto-create via Script
- **Status**: ⏩ Not Intended
- **Reason**: Dynamic creation sufficient for current needs
- **Note**: Could implement seed script for product management

### 📋 Pro Tips Implementation Status

#### ✅ client_reference_id Added
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` line 120
- **Details**: Added as backup to metadata for user binding

#### ✅ Rate Limiting for Duplicate Sessions
- **Status**: ✅ Implemented
- **Location**: `src/routes/payments.ts` lines 87-101
- **Details**: 1 session per 10 seconds per user via Redis

#### ⏳ Loading State (Frontend)
- **Status**: ⏳ Frontend Implementation Required
- **Note**: Backend ready, frontend should add "Redirecting to secure checkout..." state

#### ⏳ Success Page Credit Refresh (Frontend)
- **Status**: ⏳ Frontend Implementation Required
- **Note**: Backend ready, frontend should call `/api/me` on success page to refresh credits

---

## 🏗️ System Architecture

### Frontend (Next.js)
```
Frontend (Next.js)
   ↓
Backend (Express)
   ↓
Stripe Checkout
   ↓
Webhook
   ↓
DB (credits updated)
   ↓
User spends credits via API
```

### Backend Environment
- **Runtime**: Vercel Serverless Functions
- **Database**: Neon PostgreSQL with neon-serverless driver (WebSocket)
- **ORM**: Drizzle ORM
- **Payment**: Stripe API

---

## 💳 End-to-End Payment Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    USER INITIATES PURCHASE                             │
│  Location: Frontend (Next.js)                                           │
│  Action: User clicks "Buy Credits" button                              │
│                                                                          │
│  User sees credit packs fetched from:                                   │
│  GET /api/payments/credit-packs                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Frontend calls API       │
                    │  POST /api/payments/      │
                    │  create-checkout-session   │
                    │  Body: { packId,          │
                    │         successPath?,     │
                    │         cancelPath? }     │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  CREATE CHECKOUT SESSION                                │
│  Location: src/routes/payments.ts:139                                  │
│  Purpose: Create Stripe checkout session with security validation        │
│                                                                          │
│  Security checks performed:                                              │
│  - Authentication required (requireAuth)                                │
│  - Rate limiting (1 session/10sec per user)                            │
│  - Credit pack validation                                                │
│  - URL validation (prevent open redirects)                              │
│  - Idempotency key generation                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate credit pack     │
                    │  Find pack by ID in       │
                    │  CREDIT_PACKS config      │
                    │  Return 404 if not found  │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Apply rate limiting      │
                    │  Redis key:               │
                    │  checkout-session-{userId} │
                    │  TTL: 10 seconds          │
                    │  Return 429 if exceeded   │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate URLs            │
                    │  constructSafeUrl()       │
                    │  - Only relative paths     │
                    │  - No protocols allowed    │
                    │  - Fallback to defaults   │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Create Stripe session     │
                    │  stripe.checkout.sessions. │
                    │  create()                 │
                    │  - Pre-created priceId    │
                    │  - Metadata: userId       │
                    │  - client_reference_id    │
                    │  - Custom success/cancel  │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Return checkout URL      │
                    │  Response: { url, sessionId }│
                    │  Frontend redirects user  │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    STRIPE CHECKOUT PROCESS                              │
│  Location: Stripe Hosted Page                                           │
│  Purpose: User completes payment on Stripe's secure page                │
│                                                                          │
│  User interactions:                                                      │
│  - Enters payment details                                                │
│  - Completes 3DS/SCA if required                                        │
│  - Confirms payment                                                     │
│                                                                          │
│  Stripe processes payment and sends webhook                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Stripe sends webhook     │
                    │  POST /api/payments/      │
                    │  stripe/webhook           │
                    │  Headers: stripe-signature│
                    │  Body: Raw JSON event     │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    WEBHOOK PROCESSING                                    │
│  Location: src/routes/payments.ts:400                                   │
│  Purpose: Process Stripe events and update user credits                 │
│                                                                          │
│  Security checks performed:                                              │
│  - IP-based rate limiting (100 req/15min)                              │
│  - Stripe signature verification                                         │
│  - Raw body preservation for signature                                   │
│  - Webhook delivery tracking                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Verify signature         │
                    │  stripe.webhooks.         │
                    │  constructEvent()         │
                    │  Uses STRIPE_WEBHOOK_     │
                    │  SECRET env var           │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Track webhook delivery   │
                    │  Insert webhookDeliveries │
                    │  table entry             │
                    │  Status: 'retrying'       │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Process event types      │
                    │  - checkout.session.      │
                    │    completed              │
                    │  - payment_intent.        │
                    │    succeeded              │
                    │  - payment_intent.        │
                    │    payment_failed         │
                    │  - charge.refunded        │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CREDIT ALLOCATION                                     │
│  Location: src/routes/payments.ts:298                                  │
│  Purpose: Add credits to user account and record transaction            │
│                                                                          │
│  Database operations (in transaction):                                   │
│  1. Check for existing transaction (idempotency)                       │
│  2. Update user credits                                                 │
│  3. Create transaction record                                           │
│  4. Create user notification                                             │
│  5. Update webhook delivery status                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Begin DB transaction     │
                    │  dbWrite.transaction()    │
                    │  Atomic operations only    │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Idempotency check         │
                    │  Find existing transaction  │
                    │  with stripeEventId        │
                    │  Skip if already processed │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate payment amount   │
                    │  Compare session amount    │
                    │  with expected pack price  │
                    │  Log security violation     │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Update user credits       │
                    │  users.credits += credits  │
                    │  From pack.credits config  │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Create transaction       │
                    │  transactions table       │
                    │  Type: 'purchase'          │
                    │  Amount: pack.priceUSD    │
                    │  Credits: pack.credits    │
                    │  stripeEventId recorded   │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Create notification       │
                    │  userNotifications table   │
                    │  Title: "Payment Successful"│
                    │  Includes transaction data │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Commit transaction       │
                    │  All or nothing rollback  │
                    │  Update webhook status    │
                    │  to 'success'             │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Respond to Stripe        │
                    │  res.json({ received: true }) │
                    │  Fast response (Vercel)   │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    USER RETURNS TO APP                                   │
│  Location: Frontend (Next.js)                                           │
│  Purpose: User sees success page and updated credit balance             │
│                                                                          │
│  User flow:                                                             │
│  1. Stripe redirects to success_url                                     │
│  2. Frontend shows success page                                         │
│  3. Frontend fetches updated user profile                               │
│  4. User sees new credit balance                                       │
│                                                                          │
│  Recommended frontend actions:                                           │
│  - GET /user to refresh user data (includes credits)                    │
│  - Show success notification                                            │
│  - Update UI with new credit balance                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Flow Summary

### **Key Decision Points**

1. **Pre-created Prices (Now Active)**
   - ✅ Uses `pack.priceId` for Stripe prices
   - ✅ Full Stripe dashboard visibility
   - ✅ Revenue analytics and reporting
   - ✅ Price history tracking

2. **Security Layers**
   - **Authentication**: `requireAuth` middleware
   - **Rate Limiting**: Redis-based (IP + user)
   - **URL Validation**: Prevents open redirects
   - **Signature Verification**: Stripe webhook security
   - **Idempotency**: Database transaction safety

3. **Error Handling**
   - **429**: Rate limit exceeded
   - **400**: Invalid input
   - **404**: Credit pack not found
   - **500**: Server/Stripe errors

### **Performance Optimizations**

1. **Vercel Serverless**
   - Fast webhook response (`res.json({ received: true })`)
   - Processing happens after response

2. **Database Transactions**
   - Atomic operations prevent partial updates
   - Rollback on errors

3. **Caching Strategy**
   - Redis for rate limiting
   - Future: Cache credit packs config

### **Monitoring & Debugging**

1. **Webhook Tracking**
   - `webhookDeliveries` table logs all events
   - Status tracking (success/failed/retrying)

2. **Transaction Logging**
   - Complete audit trail in `transactions` table
   - Links to Stripe events via `stripeEventId`

3. **Security Logging**
   - Price validation violations logged
   - Rate limit violations tracked

---

## 🔧 Environment Configuration

### Backend Environment Variables

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Database
DATABASE_URL=postgresql://primary...
DATABASE_READ_URL=postgres://replica...
DATABASE_LOGGING=false

# Frontend URL
FRONTEND_URL=https://yourapp.com
```

### Backend Installation

```bash
pnpm add stripe
```

---

## 🎯 Credit Pack Configuration

### Available Credit Packs

```typescript
export const CREDIT_PACKS = [
  {
    id: "observer",
    title: "🕵️ The Observer",
    tagline: "You watch… but rarely interfere.",
    description: "Perfect for first-time readers. Explore branching paths and test how your decisions shape the story.",
    credits: 50,
    priceUSD: 2.99,
    priceId: "price_observer", // Stripe Price ID
    highlight: false,
    badge: null,
    valueTag: "~10-12 choices",
    color: "gray",
  },
  {
    id: "investigator", 
    title: "🔍 The Investigator",
    tagline: "You follow the clues. Carefully.",
    description: "Dig deeper into the mystery. Enough credits to influence key decisions and unlock hidden paths.",
    credits: 150,
    priceUSD: 7.99,
    priceId: "price_investigator",
    highlight: true,
    badge: "🔥 Most Popular",
    valueTag: "~30-40 choices",
    color: "blue",
  },
  {
    id: "mastermind",
    title: "🧠 The Mastermind",
    tagline: "You don't follow the story. You control it.",
    description: "Take full control of the narrative. Craft custom actions, explore alternate endings, and bend the story to your will.",
    credits: 500,
    priceUSD: 19.99,
    priceId: "price_mastermind",
    highlight: false,
    badge: "💎 Best Value", 
    valueTag: "~120+ choices",
    color: "purple",
  },
];
```

---

## 🔐 Vercel + Stripe Best Practices

### 1. Raw Body Required (Express)

**Problem**: Stripe webhook WILL FAIL if body is parsed.

**Solution**: Configure Express to use raw body middleware for webhook route ONLY.

```javascript
// app.ts
// CRITICAL: Raw body middleware for Stripe webhook MUST come before express.json()
// Stripe requires raw body for webhook signature verification
app.use("/api/payments/stripe/webhook", express.raw({ type: "application/json" }));

// Configure middleware
app.use(express.json({ limit: "1mb" })); // Parse JSON payloads
```

### Common Mistakes (Avoid These)

❌ Using express.json() globally before webhook route
app.use(express.json()) // ❌ breaks webhook if applied before webhook route

👉 Stripe signature will fail because body is already parsed

✅ Fix

Apply raw middleware BEFORE express.json() for webhook route only:

app.use("/api/payments/stripe/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "1mb" })); // Apply after webhook route

### 2. Idempotency (Avoid Double Credits)

**Problem**: Stripe may retry webhook.

**Solution**: Store `event.id` and ignore duplicates.

```typescript
// Check for idempotency using Stripe event.id (best practice)
const stripeEventId = event.id;

// Check if this webhook event was already processed using event.id
const existingTransaction = await dbWrite
  .select()
  .from(transactions)
  .where(eq(transactions.stripeEventId, stripeEventId))
  .limit(1);

if (existingTransaction.length > 0) {
  console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
  return res.json({ received: true, duplicate: true });
}
```

### 3. Don't Trust Frontend Price

**❌ Never**: `credits = req.body.credits`

**✅ Always**: `credits = priceId → lookup`

```typescript
// Find the credit pack by ID (server-side validation)
const pack = CREDIT_PACKS.find((p) => p.id === packId);
if (!pack) {
  return res.status(404).json({ error: "Credit pack not found" });
}
```

---

## 💳 Credit System Architecture

### Atomic Credit Consumption with Refunds

The credit system provides atomic operations for credit consumption with automatic refunds on failure.

#### executeWithCredits Pattern

**Purpose**: Execute an operation atomically with credit consumption, with automatic refund if the operation fails.

**Usage**:
```typescript
const { result, correlationId, transactionId } = await executeWithCredits(
  userId,
  "STORY_GENERATION",
  async (tx) => {
    // Execute operation within transaction
    await tx.insert(books).values(bookData);
    return bookId;
  },
  {
    context: "book_creation_async",
    metadata: { theme: theme.trim(), bookId }
  }
);
```

**Benefits**:
- Atomic credit consumption and operation execution
- Automatic refund if operation fails
- Correlation ID for idempotent refunds
- Transaction parameter for full atomicity (optional)

**Transaction Limitation**:
- For full atomicity, the operation callback MUST use the provided `tx` parameter
- If the operation performs DB operations outside the transaction, partial success scenarios can occur
- Current limitation: `initializeBook()` does not yet support transaction parameter
- This is acceptable for async book creation (primary flow bypasses this limitation)

#### refundCredits Pattern

**Purpose**: Idempotent credit refund with retry logic.

**Usage**:
```typescript
await refundCredits(userId, "STORY_GENERATION", {
  context: "book_creation_async_failed",
  metadata: { bookId, theme: theme.trim() },
  correlationId // Use correlation ID from executeWithCredits for idempotency
});
```

**Benefits**:
- Idempotent via correlation ID (prevents duplicate refunds)
- Retry mechanism with exponential backoff (3 retries, 1s base delay)
- Detailed error logging for manual review
- Audit trail via correlation ID

#### Internal User Credit Skip

**Purpose**: Automatically skip credit consumption for internal system user (cron jobs, etc.).

**Implementation**:
```typescript
const isInternal = userId === process.env.SYSTEM_USER_ID;
if (isInternal) {
  console.log(`[consumeCredits] ⚡ Skipping credit consumption for internal user: ${userId}`);
  return {
    remainingCredits: 0,
    transactionId: generateId(),
  };
}
```

**Benefits**:
- Prevents charging internal operations (cron jobs, system tasks)
- Consistent API (returns same structure)
- Logs skip for monitoring

---

## 🗄️ Database Schema

### Transactions Table

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund')),
  credits INTEGER NOT NULL,
  amount_usd REAL,
  payment_intent_id TEXT UNIQUE,
  stripe_event_id TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX transactions_user_idx ON transactions(user_id);
CREATE INDEX transactions_type_idx ON transactions(type);
CREATE INDEX transactions_created_idx ON transactions(created_at DESC);
CREATE UNIQUE INDEX transactions_payment_intent_unique ON transactions(payment_intent_id);
CREATE UNIQUE INDEX transactions_stripe_event_unique ON transactions(stripe_event_id);
```

### Webhook Deliveries Table

```sql
CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  delivered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'retrying' CHECK (status IN ('success', 'failed', 'retrying')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX webhook_deliveries_event_idx ON webhook_deliveries(event_id);
CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries(status);
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries(created_at DESC);
CREATE UNIQUE INDEX webhook_deliveries_event_unique ON webhook_deliveries(event_id);
```

### User Notifications Table

```sql
CREATE TABLE user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX user_notifications_user_idx ON user_notifications(user_id, created_at DESC);
CREATE INDEX user_notifications_unread_idx ON user_notifications(user_id, read);
CREATE INDEX user_notifications_type_idx ON user_notifications(type);
CREATE INDEX user_notifications_created_idx ON user_notifications(created_at DESC);
```

---

## 🔄 Safe Transaction Implementation (neon-serverless)

### Transaction-Based Pattern

With neon-serverless (WebSocket driver), we use proper database transactions for atomic operations:

```typescript
// Use database transaction for atomic credit update and transaction record creation
await dbWrite.transaction(async (tx) => {
  // Check for idempotency using Stripe event.id (best practice)
  const existingTransaction = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.stripeEventId, stripeEventId))
    .limit(1);

  if (existingTransaction.length > 0) {
    console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
    return res.json({ received: true, duplicate: true });
  }

  // Update user credits
  const updateResult = await tx
    .update(users)
    .set({ 
      credits: sql`${users.credits} + ${creditsAmount}` 
    })
    .where(eq(users.userId, userId))
    .returning({ credits: users.credits });

  if (!updateResult || updateResult.length === 0) {
    console.error("[stripe] ❌ Failed to update user credits - user not found:", userId);
    throw new Error("User not found");
  }

  // Create transaction record
  await tx.insert(transactions).values({
    userId,
    type: "purchase",
    credits: creditsAmount,
    amountUsd,
    paymentIntentId,
    stripeEventId,
  });

  console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${updateResult[0].credits}) for payment ${session.id}`);
});
```

### Key Benefits
- **Atomic operations**: Credit update and transaction record creation happen together
- **No orphaned data**: Transaction rollback on failure prevents partial updates
- **Simpler code**: No need for separate event tracking table or cleanup jobs
- **Better reliability**: Transaction guarantees consistency

---

## 💸 Credit Consumption Architecture

### Overview

Credit consumption is the process of deducting credits from a user's account when they perform actions like story generation, custom actions, or time travel. This is a critical operation that must be implemented with strict security measures to prevent abuse and ensure accuracy.

### Core Principles

1. **Atomic Transactions**: All credit operations must be atomic to prevent race conditions
2. **Server-Side Validation**: Never trust client-side credit calculations
3. **Idempotency**: Prevent double charging on network retries
4. **Rate Limiting**: Protect against abuse with Redis-based rate limiting
5. **Activity Logging**: Complete audit trail for security and analytics
6. **Error Handling**: Graceful handling of insufficient credits and edge cases

### Implementation Status

#### ✅ Implemented Features

1. **Atomic Credit Deduction with Row Locks**
   - **Status**: ✅ Implemented
   - **Location**: `src/services/credits.ts` - `consumeCredits()` function
   - **Details**:
     - Uses PostgreSQL `FOR UPDATE` row locking
     - Atomic transaction with credit check and deduction
     - Transaction record creation in same transaction
     - Prevents race conditions and double spending

2. **User Activity Logging**
   - **Status**: ✅ Implemented
   - **Location**: `src/services/credits.ts` - integrated with `logUserActivity()`
   - **Details**:
     - Logs all credit consumption events
     - Captures context, metadata, and user details
     - Enables security analytics and fraud detection
     - Non-blocking (errors don't affect credit consumption)

3. **Idempotency Key Support**
   - **Status**: ✅ Implemented
   - **Location**: `src/routes/payments.ts` - `POST /payments/consume-credits`
   - **Details**:
     - Optional idempotency key in request body
     - Redis-based duplicate detection (5-minute TTL)
     - Returns cached result for duplicate requests
     - Prevents double charging on retries

4. **Rate Limiting**
   - **Status**: ✅ Implemented
   - **Location**: `src/routes/payments.ts` - `POST /payments/consume-credits`
   - **Details**:
     - 60 requests per minute per user
     - Redis-based rate limiting
     - Automatic expiration (60-second window)
     - Protects against abuse and API spam

5. **Server-Side Cost Validation**
   - **Status**: ✅ Implemented
   - **Location**: `src/config/credits.ts` - `CREDIT_COSTS` configuration
   - **Details**:
     - All costs defined server-side
     - Type-safe cost key validation
     - Prevents client-side cost manipulation
     - Centralized cost management

6. **Centralized Service Function**
   - **Status**: ✅ Implemented
   - **Location**: `src/services/credits.ts` - `consumeCredits()`, `hasSufficientCredits()`, `addCredits()`
   - **Details**:
     - Single source of truth for credit operations
     - Reusable across all endpoints
     - Consistent error handling
     - Easy to test and maintain

### Credit Consumption Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    USER INITIATES ACTION                                 │
│  Location: Frontend (Next.js)                                           │
│  Action: User clicks "Generate Story" button                            │
│                                                                          │
│  Frontend generates idempotency key: "story-{timestamp}-{theme}"       │
│  Frontend calls API: POST /api/payments/consume-credits                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Rate Limiting Check      │
                    │  Redis key:               │
                    │  credit-consume-{userId}  │
                    │  Limit: 60 req/min       │
                    │  Return 429 if exceeded   │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Idempotency Check        │
                    │  Redis key:               │
                    │  credit-consume-{key}    │
                    │  Return 409 if duplicate │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Validate costKey         │
                    │  Check against CREDIT_COSTS│
                    │  Return 400 if invalid    │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CREDIT CONSUMPTION SERVICE                           │
│  Location: src/services/credits.ts - consumeCredits()                  │
│                                                                          │
│  Database Operations (in transaction):                                   │
│  1. Lock user row with FOR UPDATE                                       │
│  2. Check if user has sufficient credits                                │
│  3. Deduct credits atomically                                            │
│  4. Create transaction record                                            │
│  5. Log user activity (outside transaction)                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Begin DB transaction     │
                    │  dbWrite.transaction()    │
                    │  Atomic operations only    │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Lock user row            │
                    │  SELECT ... FOR UPDATE    │
                    │  Prevents concurrent      │
                    │  modifications            │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Check credit balance     │
                    │  currentCredits >= cost ?  │
                    │  Throw error if insufficient│
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Deduct credits           │
                    │  credits = credits - cost  │
                    │  Atomic SQL operation      │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Create transaction       │
                    │  transactions table       │
                    │  Type: 'usage'            │
                    │  Credits: -cost           │
                    │  Context & metadata       │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Commit transaction       │
                    │  All or nothing rollback  │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Log user activity        │
                    │  userActivityLogs table   │
                    │  Non-blocking operation   │
                    │  For analytics & security │
                    └───────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │  Store idempotency result │
                    │  Redis key with 5min TTL  │
                    │  For duplicate detection  │
                    └───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    RETURN RESPONSE TO FRONTEND                           │
│                                                                          │
│  Response (Success - 200):                                               │
│  {                                                                       │
│    success: true,                                                        │
│    creditsConsumed: 5,                                                   │
│    remainingCredits: 145                                                 │
│  }                                                                       │
│                                                                          │
│  Response (Error - 402):                                                 │
│  {                                                                       │
│    error: "Not enough credits",                                          │
│    required: 5,                                                          │
│    available: 3                                                           │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Anti-Abuse Measures

#### 1. Server-Side Cost Validation

**❌ Wrong Approach** (Client-side cost):
```typescript
// Frontend sends cost directly
const res = await fetch('/api/consume', {
  body: JSON.stringify({ cost: 5 }) // ❌ Easily manipulated
});
```

**✅ Correct Approach** (Server-side cost):
```typescript
// Frontend sends cost key only
const res = await fetch('/api/payments/consume-credits', {
  body: JSON.stringify({ costKey: 'STORY_GENERATION' }) // ✅ Server validates
});

// Backend validates
const cost = CREDIT_COSTS[costKey]; // Server-side lookup
if (cost <= 0) throw new Error('Invalid cost');
```

#### 2. Idempotency Keys

**Purpose**: Prevent double charging on network retries or double-clicks

**Implementation**:
```typescript
// Frontend generates unique key
const idempotencyKey = `story-${Date.now()}-${bookId}`;

// Backend checks Redis
const existing = await redis.get(`credit-consume-${idempotencyKey}`);
if (existing) {
  return res.status(409).json({ ...JSON.parse(existing) });
}

// Store result after success
await redis.set(`credit-consume-${idempotencyKey}`, JSON.stringify(result), { ex: 300 });
```

**Best Practices**:
- Use format: `{action}-{timestamp}-{entityId}`
- Include enough context to make keys unique
- Set appropriate TTL (5 minutes recommended)
- Return cached result for duplicates

#### 3. Rate Limiting

**Purpose**: Prevent API abuse and spam

**Implementation**:
```typescript
// Redis-based rate limiting
const rateLimitKey = `credit-consume-${userId}`;
const requestCount = await redis.incr(rateLimitKey);

if (requestCount === 1) {
  await redis.expire(rateLimitKey, 60); // 60-second window
}

if (requestCount > 60) {
  return res.status(429).json({ error: 'Too many requests' });
}
```

**Rate Limits**:
- Credit consumption: 60 requests/minute per user
- Checkout sessions: 1 request/10 seconds per user
- Webhooks: 100 requests/15 minutes per IP

#### 4. Activity Logging

**Purpose**: Complete audit trail for security and analytics

**Implementation**:
```typescript
await logUserActivity({
  userId,
  activityType: 'credits_consumed',
  targetType: 'credit_action',
  targetId: null,
  metadata: {
    costKey,
    creditsConsumed: cost,
    context: options.context,
    ...options.metadata
  }
});
```

**Logged Data**:
- User ID
- Activity type (credits_consumed)
- Cost key and amount
- Context (e.g., book_creation)
- Metadata (e.g., bookId, theme)
- Timestamp
- IP address (if available)
- User agent (if available)

### Common Mistakes to Avoid

#### ❌ Naive Credit Deduction (Race Condition)
```typescript
// WRONG: No transaction, no lock
const user = await getUser(userId);
user.credits -= 5;
await updateUser(user);
// 👉 Race condition: Two requests can read same balance
```

#### ✅ Atomic Transaction with Row Lock
```typescript
// CORRECT: Transaction with row lock
await dbWrite.transaction(async (tx) => {
  const user = await tx
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .for('update') // 🔒 Row lock
    .limit(1);
  
  if (user[0].credits < cost) {
    throw new Error('Insufficient credits');
  }
  
  await tx.update(users)
    .set({ credits: sql`${users.credits} - ${cost}` })
    .where(eq(users.userId, userId));
  
  await tx.insert(transactions).values({
    userId,
    type: 'usage',
    credits: -cost,
    // ...
  });
});
```

#### ❌ Client-Side Cost Calculation
```typescript
// WRONG: Trust frontend cost
const cost = req.body.cost; // ❌ User can send any value
await deductCredits(userId, cost);
```

#### ✅ Server-Side Cost Validation
```typescript
// CORRECT: Server-side cost lookup
const costKey = req.body.costKey;
const cost = CREDIT_COSTS[costKey]; // ✅ Server validates
await deductCredits(userId, cost);
```

#### ❌ No Transaction Record
```typescript
// WRONG: No audit trail
await updateCredits(userId, -5);
// 👉 Can't debug issues, can't handle refunds
```

#### ✅ Complete Transaction Logging
```typescript
// CORRECT: Full audit trail
await dbWrite.transaction(async (tx) => {
  await tx.update(users).set({ credits: newBalance });
  await tx.insert(transactions).values({
    userId,
    type: 'usage',
    credits: -5,
    context: 'book_creation',
    metadata: { bookId: 'abc123' },
    createdAt: new Date()
  });
});
```

### Error Handling

#### Insufficient Credits (402)
```typescript
if (currentCredits < cost) {
  return res.status(402).json({
    error: "Not enough credits",
    required: cost,
    available: currentCredits,
  });
}
```

#### Duplicate Request (409)
```typescript
if (existingResult) {
  return res.status(409).json({
    error: "Duplicate request",
    message: "This request has already been processed",
    ...JSON.parse(existingResult)
  });
}
```

#### Rate Limited (429)
```typescript
if (requestCount > 60) {
  return res.status(429).json({
    error: "Too many credit consumption attempts. Please wait before trying again."
  });
}
```

#### Invalid Input (400)
```typescript
if (!validCostKeys.includes(costKey)) {
  return res.status(400).json({
    error: `Invalid costKey: ${costKey}`
  });
}
```

### Testing Checklist

- [ ] Atomic transaction prevents race conditions
- [ ] Row lock prevents concurrent modifications
- [ ] Insufficient credits error displays correctly
- [ ] Idempotency key prevents double charging
- [ ] Rate limiting prevents abuse
- [ ] Activity logging captures all events
- [ ] Transaction record created for all operations
- [ ] Error handling covers all edge cases
- [ ] Server-side cost validation works
- [ ] Redis operations handle failures gracefully

### Monitoring & Alerting

#### Key Metrics to Monitor
- Credit consumption rate per user
- Failed credit consumption attempts
- Rate limit violations
- Duplicate request rate
- Transaction record creation rate
- Activity logging success rate

#### Alert Thresholds
- >100 failed credit consumptions per hour
- >50 rate limit violations per hour
- >20 duplicate requests per hour
- Transaction record creation failures
- Activity logging failures

---

## 🛣️ API Endpoints

### GET /api/payments/credit-packs

Returns the list of available credit packs for purchase. This endpoint allows the frontend to fetch the current credit pack configuration without hardcoding it in the frontend.

**Authentication**: None (public pricing information)

**Response (Success - 200)**:
```typescript
[
  {
    id: string;
    title: string;
    tagline: string;
    description: string;
    credits: number;
    priceUSD: number;
    priceId: string;
    productId: string;
    highlight: boolean;
    badge: string | null;
    valueTag: string;
    color: "gray" | "blue" | "purple" | "green" | "yellow" | "red";
  }
]
```

**Implementation**:
```typescript
router.get("/credit-packs", async (req: Request, res: Response) => {
  try {
    // Return credit packs configuration
    // Note: This is public information (pricing) so no auth required
    const safeCreditPacks = CREDIT_PACKS.map(pack => ({
      id: pack.id,
      title: pack.title,
      tagline: pack.tagline,
      description: pack.description,
      credits: pack.credits,
      priceUSD: pack.priceUSD,
      priceId: pack.priceId,
      productId: pack.productId,
      highlight: pack.highlight,
      badge: pack.badge,
      valueTag: pack.valueTag,
      color: pack.color,
    }));

    res.json(safeCreditPacks);
  } catch (error) {
    handleApiError(res, "Failed to fetch credit packs", error);
  }
});
```

**Frontend Usage Example**:
```typescript
const res = await fetch('/api/payments/credit-packs');
const creditPacks = await res.json();

// Display credit packs to users
creditPacks.forEach(pack => {
  console.log(`${pack.title}: $${pack.priceUSD} (${pack.credits} credits)`);
});
```

---

### POST /api/payments/create-checkout-session

Creates Stripe checkout session for purchasing credit packs with customizable success/cancel URLs.

**Authentication**: Required (via `requireAuth`)

**Request Body**:
```typescript
{
  packId: string; // Credit pack ID ("observer", "investigator", "mastermind")
  returnUrl?: string; // Optional current page URL for refresh-less UX (e.g., "https://app.com/books/slug/pageId")
  successPath?: string; // Optional custom success path (fallback if returnUrl not provided)
  cancelPath?: string; // Optional custom cancel path (fallback if returnUrl not provided)
}
```

**Example Request**:
```json
{
  "packId": "investigator",
  "returnUrl": "https://app.com/books/hush-frequency/page-42"
}
```

**Response (Success - 200)**:
```typescript
{
  url: string;       // Stripe checkout URL
  sessionId: string; // Stripe session ID
}
```

**Response (Error - 400)**:
```typescript
{
  error: string; // Error message for invalid input
}
```

**Response (Error - 404)**:
```typescript
{
  error: string; // Credit pack not found
}
```

**Response (Error - 429)**:
```typescript
{
  error: string; // Rate limit exceeded
}
```

**Security Features**:
- **URL Validation**: Only relative paths allowed (must start with /)
- **Open Redirect Prevention**: Absolute URLs and protocols rejected
- **Fallback URLs**: Invalid paths use defaults (/dashboard?success=true and /pricing)
- **Rate Limiting**: 1 session per 10 seconds per user via Redis

**Implementation**:
```typescript
router.post("/create-checkout-session", requireAuth, async (req: Request, res: Response) => {
  const { packId, successPath, cancelPath, returnUrl } = req.body;
  
  // Validate input
  if (!packId) {
    return res.status(400).json({ error: "Credit pack ID is required" });
  }

  // Find the credit pack by ID (server-side validation)
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) {
    return res.status(404).json({ error: "Credit pack not found" });
  }

  // Validate and construct URLs (security: prevent open redirects)
  const baseUrl = process.env.FRONTEND_URL;
  if (!baseUrl) {
    return res.status(500).json({ error: "Frontend URL not configured" });
  }

  // Helper function to validate and construct safe URLs
  const constructSafeUrl = (path: string | undefined, defaultPath: string): string => {
    if (!path) {
      return `${baseUrl}${defaultPath}`;
    }
    
    // Security validation: prevent open redirects
    // Only allow relative paths starting with / and no protocol
    if (path.startsWith('/') && !path.includes('//') && !path.includes('http')) {
      return `${baseUrl}${path}`;
    }
    
    // If invalid, use default
    return `${baseUrl}${defaultPath}`;
  };

  const successUrl = constructSafeUrl(successPath, '/dashboard?success=true');
  const cancelUrl = constructSafeUrl(cancelPath, '/pricing');

  // Generate idempotency key
  const idempotencyKey = `checkout-${req.user!.id}-${packId}-${Date.now()}`;

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: req.user!.email,
    line_items: [
      {
        price: pack.priceId,
        // price_data: {
        //   currency: "usd",
        //   product_data: {
        //     name: `${pack.title} (${pack.credits} Credits)`,
        //     description: pack.description,
        //   },
        //   unit_amount: Math.round(pack.priceUSD * 100), // Convert to cents
        // },
        quantity: 1,
      },
    ],
    metadata: {
      userId: req.user!.id,
      packId: pack.id,
      credits: pack.credits.toString(),
    },
    client_reference_id: req.user!.id, // Backup to metadata for user binding
    success_url: successUrl,
    cancel_url: cancelUrl,
  }, {
    idempotencyKey,
  });

  res.json({ url: session.url, sessionId: session.id });
});
```

**Frontend Usage Examples**:

```typescript
// Basic usage (default URLs)
const res = await fetch('/api/payments/create-checkout-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ packId: 'investigator' }),
});
const { url, sessionId } = await res.json();
window.location.href = url;

// With returnUrl (refresh-less UX - recommended)
const currentUrl = window.location.href;
const res = await fetch('/api/payments/create-checkout-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    packId: 'investigator',
    returnUrl: currentUrl,
  }),
});
const { url, sessionId } = await res.json();
window.location.href = url;
```

### POST /api/payments/stripe/webhook

Handles Stripe webhook events for payment processing.

**Headers**:
- `stripe-signature`: Stripe signature for webhook verification

**Events Handled**:
- `checkout.session.completed`: Payment successful (adds credits)
- `payment_intent.succeeded`: Payment intent succeeded (logging only)
- `payment_intent.payment_failed`: Payment intent failed (logging only)
- `charge.refunded`: Payment refunded (deducts credits)

**Implementation**:
```typescript
router.post("/stripe/webhook", async (req: Request, res: Response) => {
  // Apply IP-based rate limiting for webhook security
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimitByIP(ip)) {
    return res.status(429).json({ error: 'Too many webhook requests from this IP' });
  }
  
  // Track webhook delivery
  let webhookDeliveryId: string | null = null;
  
  try {
    const sig = req.headers["stripe-signature"];
    
    if (!sig) {
      return res.status(400).json({ error: "Missing Stripe signature" });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ error: "Webhook secret not configured" });
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Verify webhook signature
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    // Create webhook delivery tracking record
    const deliveryRecord = await dbWrite.insert(webhookDeliveries).values({
      eventId: event.id,
      eventType: event.type,
      status: 'retrying',
    }).returning();
    webhookDeliveryId = deliveryRecord[0].id;

    // Handle different event types
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Check for idempotency using Stripe event.id (best practice)
      const stripeEventId = event.id;
      const paymentIntentId = session.payment_intent as string;
      
      if (!paymentIntentId) {
        console.error("[stripe] ❌ Missing payment_intent_id in session:", session.id);
        return res.status(400).json({ error: "Missing payment intent" });
      }

      // Extract metadata
      const userId = session.metadata?.userId;
      const credits = session.metadata?.credits;
      const packId = session.metadata?.packId;
      
      if (!userId || !credits || !packId) {
        console.error("[stripe] ❌ Missing metadata in checkout session:", session.id);
        return res.status(400).json({ error: "Invalid session metadata" });
      }

      const creditsAmount = Number(credits);
      const amountUsd = session.amount_total ? session.amount_total / 100 : undefined;

      // Validate payment amount matches expected credit pack price (security check)
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      if (!pack) {
        console.error("[stripe] ❌ Invalid pack ID in session metadata:", packId);
        return res.status(400).json({ error: "Invalid credit pack" });
      }

      const expectedAmount = Math.round(pack.priceUSD * 100); // Convert to cents
      const actualAmount = session.amount_total;

      if (actualAmount !== expectedAmount) {
        console.error(`[stripe] ❌ Amount mismatch: expected ${expectedAmount}, got ${actualAmount} for pack ${packId}`);
        console.error(`[stripe] 🚨 Security incident: Price manipulation attempt detected for session ${session.id}`);
        return res.status(400).json({ error: "Amount validation failed" });
      }

      // Use database transaction for atomic credit update and transaction record creation
      await dbWrite.transaction(async (tx) => {
        // Check for idempotency using Stripe event.id (best practice)
        const existingTransaction = await tx
          .select()
          .from(transactions)
          .where(eq(transactions.stripeEventId, stripeEventId))
          .limit(1);

        if (existingTransaction.length > 0) {
          console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
          // Update webhook delivery status as success (duplicate but processed)
          await dbWrite.update(webhookDeliveries)
            .set({ 
              status: 'success', 
              processedAt: new Date(),
              updatedAt: new Date()
            })
            .where(eq(webhookDeliveries.id, webhookDeliveryId!));
          return res.json({ received: true, duplicate: true });
        }

        // Update user credits
        const updateResult = await tx
          .update(users)
          .set({ 
            credits: sql`${users.credits} + ${creditsAmount}` 
          })
          .where(eq(users.userId, userId))
          .returning({ credits: users.credits });

        if (!updateResult || updateResult.length === 0) {
          console.error("[stripe] ❌ Failed to update user credits - user not found:", userId);
          throw new Error("User not found");
        }

        // Create transaction record
        await tx.insert(transactions).values({
          userId,
          type: "purchase",
          credits: creditsAmount,
          amountUsd,
          paymentIntentId,
          stripeEventId,
        });

        console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${updateResult[0].credits}) for payment ${session.id}`);
        
        // Create success notification for user
        await tx.insert(userNotifications).values({
          userId,
          type: 'payment_success',
          title: 'Payment Successful',
          message: `Your purchase of ${creditsAmount} credits was successful`,
          data: {
            credits: creditsAmount,
            amount: amountUsd,
            paymentIntentId,
            packId,
          },
        });
        
        // Update webhook delivery status as success
        await dbWrite.update(webhookDeliveries)
          .set({ 
            status: 'success', 
            processedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(webhookDeliveries.id, webhookDeliveryId!));
      });
    } else if (event.type === "payment_intent.succeeded") {
      // Log payment intent success for monitoring
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      console.log(`[stripe] ✅ Payment intent succeeded: ${paymentIntent.id} (amount: ${paymentIntent.amount / 100} USD)`);
      
      // Note: Credits are added via checkout.session.completed event
      // This event is logged for monitoring and analytics purposes
    } else if (event.type === "payment_intent.payment_failed") {
      // Log payment intent failure for monitoring
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const lastPaymentError = paymentIntent.last_payment_error;
      
      console.error(`[stripe] ❌ Payment intent failed: ${paymentIntent.id}`);
      console.error(`[stripe] ❌ Error: ${lastPaymentError?.message || 'Unknown error'}`);
      console.error(`[stripe] ❌ Type: ${lastPaymentError?.type || 'Unknown type'}`);
      
      // Note: No action needed - user will see error in Stripe checkout
      // This event is logged for monitoring and debugging
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = charge.payment_intent as string;
      
      if (!paymentIntentId) {
        console.error('[stripe] ❌ Missing payment_intent_id in charge:', charge.id);
        return res.status(400).json({ error: 'Missing payment intent' });
      }
      
      // Find the original transaction
      const originalTransaction = await dbRead
        .select()
        .from(transactions)
        .where(eq(transactions.paymentIntentId, paymentIntentId))
        .limit(1);
      
      if (!originalTransaction.length) {
        console.error('[stripe] ❌ Original transaction not found for refund:', paymentIntentId);
        return res.status(404).json({ error: 'Original transaction not found' });
      }
      
      const transaction = originalTransaction[0];
      const refundAmount = charge.amount_refunded ? charge.amount_refunded / 100 : 0;
      
      // Calculate credits to deduct (proportional to refund amount)
      const creditsToDeduct = Math.floor((refundAmount / transaction.amountUsd!) * transaction.credits);
      
      if (creditsToDeduct > 0) {
        await dbWrite.transaction(async (tx) => {
          // Deduct credits from user
          const updateResult = await tx
            .update(users)
            .set({ 
              credits: sql`${users.credits} - ${creditsToDeduct}`
            })
            .where(eq(users.userId, transaction.userId))
            .returning({ credits: users.credits });
          
          if (!updateResult || updateResult.length === 0) {
            throw new Error('User not found for refund');
          }
          
          // Create refund transaction record
          await tx.insert(transactions).values({
            userId: transaction.userId,
            type: 'refund',
            credits: -creditsToDeduct, // Negative for refund
            amountUsd: -refundAmount, // Negative for refund
            paymentIntentId,
            stripeEventId: event.id,
          });
          
          // Create refund notification for user
          await tx.insert(userNotifications).values({
            userId: transaction.userId,
            type: 'refund',
            title: 'Refund Processed',
            message: `${creditsToDeduct} credits have been deducted from your account due to a refund`,
            data: {
              creditsDeducted: creditsToDeduct,
              refundAmount,
              originalPaymentId: paymentIntentId,
            },
          });
          
          console.log(`[stripe] 🔄 Refunded ${creditsToDeduct} credits from user ${transaction.userId} (new balance: ${updateResult[0].credits})`);
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[stripe] ❌ Webhook error:', getErrorMessage(error));
    
    // Update webhook delivery status as failed
    if (webhookDeliveryId) {
      try {
        await dbWrite.update(webhookDeliveries)
          .set({ 
            status: 'failed', 
            errorMessage: getErrorMessage(error),
            processedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(webhookDeliveries.id, webhookDeliveryId));
      } catch (updateError) {
        console.error('[stripe] ❌ Failed to update webhook delivery status:', getErrorMessage(updateError));
      }
    }
    
    handleApiError(res, 'Failed to process webhook', error);
  }
});
```

### POST /api/payments/consume-credits

Consumes credits from user account for usage (AI generation, etc.).

**Request Body**:
```typescript
{
  costKey: string; // Credit cost key from CREDIT_COSTS (e.g., "STORY_GENERATION")
  idempotencyKey?: string; // Optional idempotency key to prevent double charging
  context?: string; // Additional context for the transaction (e.g., "book_creation")
  metadata?: object; // Optional metadata for the transaction
}
```

**Response (Success - 200)**:
```typescript
{
  success: true;
  creditsConsumed: number;
  remainingCredits: number;
}
```

**Response (Error - 402)**:
```typescript
{
  error: string; // Error message with required credits
  required: number; // Credits needed
}
```

**Implementation**:
```typescript
router.post("/consume-credits", requireAuth, async (req: Request, res: Response) => {
  try {
    const { costKey, idempotencyKey, context, metadata } = req.body;
    if (!costKey || typeof costKey !== 'string') return handleValidationError(res, "Valid costKey is required");
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) return handleValidationError(res, "Metadata must be an object");

    const validCostKeys = Object.keys(CREDIT_COSTS);
    if (!validCostKeys.includes(costKey)) return handleValidationError(res, `Invalid costKey: ${costKey}`);

    const userId = req.userId!;

    // Rate limiting: 60 requests per minute per user
    const rateLimitResult = await checkRateLimit(`credit-consume-${userId}`, { maxRequests: 60, windowSeconds: 60 });
    if (!rateLimitResult.allowed) return handleRateLimitError(res, "Too many credit consumption attempts.");

    let processingCleanup: (() => Promise<void>) | null = null;

    // Idempotency check
    if (idempotencyKey) {
      const processing = await setIdempotencyProcessing({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      if (!processing.set) return handleConflictError(res, "Request already in progress");
      processingCleanup = processing.cleanup;

      const idempotencyResult = await checkIdempotency({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      if (idempotencyResult.isDuplicate && idempotencyResult.cachedResult) {
        await processingCleanup();
        return res.status(409).json({ error: "Duplicate request", message: "This request has already been processed", ...idempotencyResult.cachedResult });
      }
    }

    try {
      const creditResult = await consumeCredits(userId, costKey, { context, metadata, req });

      if (idempotencyKey) {
        await storeIdempotencyResult(
          { key: idempotencyKey, prefix: 'credit-consume', ttl: 300 },
          { success: true, creditsConsumed: CREDIT_COSTS[costKey], remainingCredits: creditResult.remainingCredits }
        );
      }

      if (processingCleanup) await processingCleanup();
      res.json({ success: true, creditsConsumed: CREDIT_COSTS[costKey], remainingCredits: creditResult.remainingCredits });
    } catch (error) {
      if (processingCleanup) await processingCleanup();
      if (isInsufficientCreditsError(error)) return handleInsufficientCreditsError(res, costKey);
      handleApiError(res, "Failed to consume credits", error);
    }
  } catch (error) {
    if (isInsufficientCreditsError(error)) return handleInsufficientCreditsError(res, req.body.costKey);
    handleApiError(res, "Failed to consume credits", error);
  }
});
```

---

## 🎯 Frontend Implementation

### Buy Credits Function

```typescript
async function buyCredits(packId: string) {
  const res = await fetch("/api/payments/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packId }),
  });

  if (!res.ok) {
    throw new Error("Failed to create checkout session");
  }

  const { url, sessionId } = await res.json();
  
  // Redirect to Stripe checkout
  window.location.href = url;
}
```

### Usage Example

```typescript
// Consume credits for AI generation
const response = await fetch("/api/payments/consume-credits", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ costKey: "STORY_GENERATION" }),
});

const { success, remainingCredits } = await response.json();

if (success) {
  console.log(`Credits consumed successfully. Remaining: ${remainingCredits}`);
  // Proceed with AI generation
} else {
  console.log("Insufficient credits");
  // Show upgrade prompt
}
```

---

## 🔒️ Security Considerations

### Webhook Security
- **Signature verification**: Always verify Stripe webhook signature
- **Raw body middleware**: Use `express.raw()` for webhook route to preserve signature integrity
- **HTTPS only**: Webhooks only work with HTTPS endpoints
- **Rate limiting**: IP-based rate limiting (100 requests per 15 minutes per IP)
- **Idempotency**: Check for existing transaction with matching `stripeEventId` within transaction
- **Transaction isolation**: Use database transactions to prevent race conditions

### API Security
- **Authentication**: All payment endpoints require authentication
- **Input validation**: Validate all inputs server-side
- **Price lookup**: Never trust frontend price, always lookup by ID
- **Credit validation**: Check user balance before consumption

### Data Protection
- **PII compliance**: Store minimal necessary user data
- **Transaction logging**: Complete audit trail for all operations
- **Error handling**: Graceful degradation with proper logging

### Payment Security
- **Amount validation**: Validate paid amount matches expected credit pack prices
- **Price manipulation prevention**: Server-side price validation prevents tampering
- **Idempotency keys**: Prevent duplicate checkout sessions from retries/double-clicks

### Monitoring & Tracking
- **Webhook delivery tracking**: Monitor webhook delivery status (success/failed/retrying)
- **Error logging**: Capture and log webhook processing errors
- **User notifications**: Automatic notifications for payments and refunds
- **Transaction audit trail**: Complete audit trail for all payment operations

---

## 📊 Monitoring & Logging

### Key Metrics
- **Webhook success rate**: Percentage of successful webhook deliveries
- **Payment processing time**: Time from webhook to credit allocation
- **Credit consumption rate**: Credits used per user per time period
- **Error rates**: Types and frequency of payment failures
- **Transaction success rate**: Percentage of successful database transactions

### Log Format
```typescript
console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${newBalance}) for payment ${sessionId}`);
console.log(`[stripe] 🎯 Consumed ${amount} credits from user ${userId} (remaining: ${remaining})`);
console.log(`[stripe] 🔄 Duplicate webhook event detected: ${eventId}`);
console.log(`[stripe] ❌ Webhook error:`, error);
```

---

## 🚀 Future Enhancements

### Hybrid Model (Subscription)
```typescript
// Monthly credit subscription
subscription = monthly credits
extra purchases = top-up

// Bonus system for higher conversion
first purchase → +20 credits
daily login → +1 credit
```

### Scarcity Messaging
```typescript
// When user runs out of credits
"⚠️ Some paths may close without enough credits"
```

### Contextual Upsell
```typescript
// When user runs out during critical story moment
"You're one choice away from uncovering the truth…"
```

### Dynamic Pricing (Later)
```typescript
// Harder stories cost more credits
harder stories → higher credit cost
premium endings → higher cost
```

---

## 🔐 Future Enhancements & TODOs (Safety & Best Practices)

### High Priority Security Enhancements

#### TODO: Implement Credit Balance Limits
```typescript
// Add maximum credit balance to prevent abuse
const MAX_CREDIT_BALANCE = 10000;

const newBalance = currentCredits + creditsAmount;
if (newBalance > MAX_CREDIT_BALANCE) {
  console.warn(`[stripe] ⚠️ Credit balance exceeds limit: ${newBalance}`);
  // Either cap the balance or require manual review
}
```

#### TODO: Add Suspicious Activity Detection
```typescript
// Monitor for unusual patterns:
// - Rapid credit purchases
// - Multiple payment failures
// - Unusual credit consumption rates
// - IP-based anomaly detection

interface SuspiciousActivity {
  type: 'rapid_purchases' | 'payment_failures' | 'unusual_consumption';
  userId: string;
  timestamp: Date;
  details: Record<string, any>;
}
```

### Medium Priority Improvements

#### TODO: Add Payment Method Restrictions
```typescript
// Restrict payment methods to reduce fraud risk
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'], // Only allow cards
  // Consider adding: 'apple_pay', 'google_pay' with additional verification
});
```

### Low Priority Enhancements

#### TODO: Implement Credit Expiration
```typescript
// Add expiration to purchased credits (e.g., 1 year)
// Encourages regular usage and prevents hoarding
interface CreditExpiration {
  transactionId: string;
  expiresAt: Date;
  creditsExpired: number;
}
```

#### TODO: Add Tax Calculation Support
```typescript
// Integrate Stripe Tax for automatic tax calculation
const session = await stripe.checkout.sessions.create({
  automatic_tax: { enabled: true },
  // ... other config
});
```

#### TODO: Implement Multi-Currency Support
```typescript
// Allow purchases in different currencies
// Store conversion rates and handle currency-specific pricing
interface CurrencyConfig {
  currency: string;
  priceId: string;
  priceLocal: number;
}
```

### Operational Improvements

#### TODO: Add Payment Analytics Dashboard
```typescript
// Track metrics:
// - Conversion rate (checkout started → completed)
// - Average time to first purchase
// - Credit pack popularity
// - Revenue per user
// - Churn rate
```

#### TODO: Implement Automated Reconciliation
```typescript
// Daily job to reconcile Stripe payments with database transactions
// Identify discrepancies and alert for manual review
export async function reconcilePayments(): Promise<ReconciliationReport> {
  // Fetch recent charges from Stripe API
  // Compare with transactions table
  // Report any mismatches
}
```

#### TODO: Add Webhook Retry Queue
```typescript
// Implement a queue for failed webhook processing
// Use Bull or similar for reliable retry with exponential backoff
interface WebhookRetryJob {
  eventId: string;
  eventType: string;
  attemptCount: number;
  nextRetryAt: Date;
  payload: any;
}
```

#### TODO: Implement Customer Portal
```typescript
// Add Stripe Customer Portal for users to:
// - View purchase history
// - Manage payment methods
// - Download invoices
// - Request refunds
const portalSession = await stripe.billingPortal.sessions.create({
  customer: customerId,
  return_url: `${process.env.FRONTEND_URL}/settings/billing`,
});
```

---

## 📝 Deployment Checklist

### Environment Setup
- [ ] Configure Stripe environment variables
- [ ] Set up webhook endpoints in Stripe dashboard
- [ ] Test webhook delivery with Stripe CLI
- [ ] Configure credit pack prices in Stripe
- [ ] Set up database migrations

### Testing
- [ ] Test checkout session creation
- [ ] Test successful payment flow
- [ ] Test webhook processing
- [ ] Test credit consumption
- [ ] Test error scenarios

### Production
- [ ] Enable webhook retry in Stripe
- [ ] Set up monitoring for payment failures
- [ ] Configure alerting for high-value transactions
- [ ] Monitor credit consumption patterns
- [ ] Set up database transaction monitoring

---

## 🔧 Troubleshooting

### Common Issues

#### Webhook Not Received
1. Check Stripe dashboard webhook configuration
2. Verify webhook URL is accessible
3. Check server logs for signature verification errors

#### Duplicate Credits
1. Check transactions table for duplicate stripeEventId
2. Verify idempotency logic implementation within transaction
3. Review webhook retry patterns

#### Payment Failures
1. Check Stripe secret key configuration
2. Verify payment method configuration
3. Review error logs for specific failure reasons

#### Credit Allocation Issues
1. Check user existence before credit updates
2. Verify transaction atomicity and rollback behavior
3. Review database connection and query performance
4. Check transaction timeout settings for serverless environment

---

## 📚 Additional Resources

- [Stripe Documentation](https://stripe.com/docs)
- [Neon Database Guide](https://neon.tech/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Vercel Deployment Guide](https://vercel.com/docs)
- [Next.js API Routes](https://nextjs.org/docs/api-routes/introduction)

---

*Last updated: April 29, 2026 (Updated for neon-serverless transaction-based approach)*
