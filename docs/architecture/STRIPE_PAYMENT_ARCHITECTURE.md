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

### 🔄 Alternative Approaches Considered

#### Option A: Pre-created Stripe Products (Dashboard)
- **Status**: ❌ Not Implemented
- **Reason**: Using dynamic `price_data` for flexibility
- **Note**: Could migrate to pre-created products for better Stripe dashboard management

#### Option B: Auto-create via Script
- **Status**: ❌ Not Implemented
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
  successPath?: string; // Optional custom success path (relative, starts with /)
  cancelPath?: string; // Optional custom cancel path (relative, starts with /)
}
```

**Example Request**:
```json
{
  "packId": "investigator",
  "successPath": "/payment/success?from=pricing",
  "cancelPath": "/payment/cancel?from=pricing"
}
```

**Response (Success - 200)**:
```typescript
{
  url: string; // Stripe checkout URL
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
  const { packId, successPath, cancelPath } = req.body;
  
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
        price_data: {
          currency: "usd",
          product_data: {
            name: `${pack.title} (${pack.credits} Credits)`,
            description: pack.description,
          },
          unit_amount: Math.round(pack.priceUSD * 100), // Convert to cents
        },
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

  res.json({ url: session.url });
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
const { url } = await res.json();
window.location.href = url;

// With custom URLs
const res = await fetch('/api/payments/create-checkout-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    packId: 'investigator',
    successPath: '/payment/success?from=pricing',
    cancelPath: '/payment/cancel?from=pricing'
  }),
});
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
  amount: number; // Amount of credits to consume (positive number)
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
  error: "Not enough credits";
  required: number; // Credits needed
  available: number; // Credits available
}
```

**Implementation**:
```typescript
router.post("/consume-credits", requireAuth, async (req: Request, res: Response) => {
  const { amount } = req.body;
  
  // Validate input
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: "Valid amount is required (positive number)" });
  }

  const userId = req.user!.id;

  // Get current user credits
  const userResult = await dbWrite
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!userResult || userResult.length === 0) {
    return res.status(400).json({ error: "User not found" });
  }

  const currentCredits = userResult[0].credits;

  // Check if user has enough credits
  if (currentCredits < amount) {
    return res.status(402).json({
      error: "Not enough credits",
      required: amount,
      available: currentCredits,
    });
  }

  // Update user credits (decrement)
  const updateResult = await dbWrite
    .update(users)
    .set({ 
      credits: sql`${users.credits} - ${amount}` 
    })
    .where(eq(users.userId, userId))
    .returning({ credits: users.credits });

  // Create usage transaction record
  try {
    await dbWrite.insert(transactions).values({
      userId,
      type: "usage",
      credits: -amount, // Negative for usage
    });
  } catch (transactionError) {
    console.error("[stripe] ❌ Failed to create usage transaction record:", getErrorMessage(transactionError));
    console.warn(`[stripe] ⚠️ Credits consumed from user ${userId} but transaction record failed`);
  }

  const result = {
    success: true,
    creditsConsumed: amount,
    remainingCredits: updateResult[0].credits,
  };

  res.json(result);
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

  const { url } = await res.json();
  
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
  body: JSON.stringify({ amount: 5 }),
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
