# Subscription Hybrid Model Implementation Roadmap

## Overview

This document outlines the comprehensive implementation plan for adding a monthly subscription model to complement the existing one-time credit pack purchase system. The hybrid model will allow users to subscribe to VIP status with recurring benefits while maintaining the flexibility of one-time credit purchases.

**Current State**: One-time credit pack purchases only (Observer, Investigator, Mastermind)
**Target State**: Hybrid model with monthly VIP subscription + one-time credit packs

---

## Table of Contents

1. [Requirements Summary](#requirements-summary)
2. [Current System Analysis](#current-system-analysis)
3. [Architecture Overview](#architecture-overview)
4. [Database Schema Changes](#database-schema-changes)
5. [Stripe Integration](#stripe-integration)
6. [Backend API Changes](#backend-api-changes)
7. [Business Logic Changes](#business-logic-changes)
8. [Cron Jobs & Scheduled Tasks](#cron-jobs--scheduled-tasks)
9. [Frontend Integration](#frontend-integration)
10. [Testing Strategy](#testing-strategy)
11. [Migration Plan](#migration-plan)
12. [Rollback Plan](#rollback-plan)

---

## Requirements Summary

### VIP Subscription Benefits

Users with active VIP subscriptions receive:

1. **VIP Badge**: Visual indicator in user profile and comments
2. **Dual Check-in Bonus**: 
   - Regular claim: +5 credits (days 1-6), +20 credits (day 7) - available to all users
   - VIP 2x claim: +10 credits (days 1-6), +40 credits (day 7) - only available to VIP/subscribed users
   - Total for VIP users: +15 credits (days 1-6), +60 credits (day 7) when both buttons are clicked
3. **Monthly Credits**: +50 credits automatically added on subscription activation and each renewal

### Subscription Model

- **Monthly recurring billing** via Stripe
- **Automatic credit allocation** on activation and renewal
- **Graceful degradation**: VIP benefits only active when subscription is current
- **Cancellation handling**: Benefits continue until billing period ends

---

## Current System Analysis

### Payment Architecture

**One-time Purchase Flow:**
```
User → Checkout Session → Stripe Payment → Webhook → Credit Allocation
```

**Current Implementation:**
- Stripe Checkout Sessions with prebuilt UI
- Credit packs: Observer (50/$2.99), Investigator (150/$7.99), Mastermind (500/$19.99)
- Webhook-based credit allocation via `checkout.session.completed`
- Idempotency via `stripeEventId` in transactions table
- Security: Price validation, rate limiting, signature verification

**Key Files:**
- `src/routes/payments.ts` - Checkout session creation, webhook handling
- `src/services/credits.ts` - Credit consumption, allocation, refunds
- `src/config/credits.ts` - Credit pack configuration, costs
- `src/db/schema.ts` - Database schema (users, transactions, userCheckins)

### Database Schema

**Relevant Tables:**

```sql
-- Users table (has tier field)
users (
  user_id UUID PRIMARY KEY,
  tier TEXT CHECK (tier IN ('standard', 'vip')),
  credits INTEGER DEFAULT 50,
  stripe_customer_id TEXT UNIQUE,
  ...
)

-- Transactions table
transactions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type TEXT CHECK (type IN ('purchase', 'usage', 'refund', 'reward')),
  credits INTEGER NOT NULL,
  amount_usd REAL,
  payment_intent_id TEXT UNIQUE,
  stripe_event_id TEXT UNIQUE,
  ...
)

-- Check-ins table
user_checkins (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  check_in_date DATE NOT NULL,
  credits_claimed INTEGER NOT NULL,
  UNIQUE(user_id, check_in_date)
)
```

### Check-in System

**Current Logic:**
- 7-day consecutive streak cycle
- Days 1-6: 5 credits each
- Day 7: 20 credits (big bonus)
- Transaction-based atomicity
- Implemented in `src/services/user.ts`

**Key Functions:**
- `performDailyCheckIn()` - Handles check-in and credit allocation
- `getCheckInStatus()` - Returns check-in status and history
- `checkCanCheckIn()` - Validates if user can check-in today

---

## Architecture Overview

### Hybrid Payment Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     USER PAYMENT OPTIONS                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ONE-TIME PURCHASES          MONTHLY SUBSCRIPTION               │
│  ┌─────────────────┐          ┌─────────────────┐              │
│  │ Credit Packs    │          │ VIP Subscription │              │
│  │ - Observer      │          │ - $9.99/month   │              │
│  │ - Investigator  │          │ - +50 credits   │              │
│  │ - Mastermind    │          │ - 2x check-in   │              │
│  └─────────────────┘          │ - VIP badge     │              │
│                                └─────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    STRIPE PAYMENT PROCESSING                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  One-time: Checkout Session → Payment → Webhook → Credits       │
│  Subscription: Checkout Session → Subscription → Webhooks →     │
│                  (created, updated, deleted) → Credits + Tier     │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BENEFIT ALLOCATION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Check-in System:                                               │
│  - All users can claim regular bonus (+5/+20)                    │
│  - VIP users can claim additional 2x bonus (+10/+40)             │
│  - Total for VIP: +15 (days 1-6), +60 (day 7)                    │
│                                                                 │
│  Monthly Credit Allocation:                                     │
│  - Cron job runs daily                                          │
│  - Check for active subscriptions due for renewal               │
│  - Add 50 credits + create transaction                          │
│  - Update subscription record                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Subscription Activation:**
```
1. User subscribes via Stripe Checkout
2. Stripe sends `customer.subscription.created` webhook
3. Backend:
   - Creates subscription record
   - Sets user tier to 'vip'
   - Adds 50 initial credits
   - Creates transaction record
   - Sends notification
```

**Monthly Renewal:**
```
1. Stripe processes recurring payment
2. Stripe sends `invoice.payment_succeeded` webhook
3. Backend:
   - Updates subscription record (renews_until)
   - Adds 50 credits
   - Creates transaction record
   - Sends notification
```

**Cancellation:**
```
1. User cancels via Stripe Customer Portal
2. Stripe sends `customer.subscription.deleted` webhook
3. Backend:
   - Updates subscription status to 'cancelled'
   - Keeps VIP benefits until period end
   - Schedules tier downgrade to 'standard'
```

**Check-in with VIP:**
```
1. User performs daily check-in
2. Backend checks user tier
3. Regular claim: allocates base bonus (+5/+20) for all users
4. VIP 2x claim: allocates additional bonus (+10/+40) for VIP users only
5. Records transaction for each claim
```

---

## Database Schema Changes

### New Tables

#### 1. Subscriptions Table

Track active user subscriptions and their status.

```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid', 'trialing')),
  current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions(current_period_end);
CREATE INDEX subscriptions_stripe_subscription_idx ON subscriptions(stripe_subscription_id);
```

**Drizzle Schema:**
```typescript
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").unique().notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("subscriptions_user_idx").on(t.userId),
    index("subscriptions_status_idx").on(t.status),
    index("subscriptions_period_end_idx").on(t.currentPeriodEnd),
    unique("subscriptions_stripe_subscription_unique").on(t.stripeSubscriptionId),
  ]
);
```

#### 2. Subscription Transactions Table

Track subscription-related credit allocations separately from regular transactions.

```sql
CREATE TABLE subscription_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('activation', 'renewal', 'cancellation')),
  credits_allocated INTEGER NOT NULL,
  stripe_invoice_id TEXT UNIQUE,
  stripe_event_id TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX subscription_transactions_subscription_idx ON subscription_transactions(subscription_id);
CREATE INDEX subscription_transactions_user_idx ON subscription_transactions(user_id);
CREATE INDEX subscription_transactions_type_idx ON subscription_transactions(type);
CREATE INDEX subscription_transactions_invoice_idx ON subscription_transactions(stripe_invoice_id);
```

**Drizzle Schema:**
```typescript
export const subscriptionTransactions = pgTable(
  "subscription_transactions",
  {
    id: id(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "cascade" }).notNull(),
    userId: userId().references(() => users.userId, { onDelete: "cascade" }).notNull(),
    type: text("type").$type<SubscriptionTransactionType>().notNull(),
    creditsAllocated: integer("credits_allocated").notNull(),
    stripeInvoiceId: text("stripe_invoice_id").unique(),
    stripeEventId: text("stripe_event_id").unique(),
    createdAt,
  },
  (t) => [
    index("subscription_transactions_subscription_idx").on(t.subscriptionId),
    index("subscription_transactions_user_idx").on(t.userId),
    index("subscription_transactions_type_idx").on(t.type),
    unique("subscription_transactions_invoice_unique").on(t.stripeInvoiceId),
  ]
);
```

### Modified Tables

#### Users Table Updates

Add subscription-related fields to users table.

```sql
-- Add columns to existing users table
ALTER TABLE users 
ADD COLUMN subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
ADD COLUMN vip_expires_at TIMESTAMP WITH TIME ZONE;

-- Index for VIP expiration queries
CREATE INDEX users_vip_expires_idx ON users(vip_expires_at) WHERE vip_expires_at IS NOT NULL;
```

**Drizzle Schema Update:**
```typescript
export const users = pgTable(
  "users",
  {
    // ... existing fields
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    vipExpiresAt: timestamp("vip_expires_at", { withTimezone: true }),
    // ... existing fields
  },
  (t) => [
    // ... existing indexes
    index("users_vip_expires_idx").on(t.vipExpiresAt).where(sql`${t.vipExpiresAt} IS NOT NULL`),
  ]
);
```

### Type Definitions

Add new types to `src/types/credits.ts`:

```typescript
export type SubscriptionStatus = 
  | 'active' 
  | 'past_due' 
  | 'canceled' 
  | 'unpaid' 
  | 'trialing';

export type SubscriptionTransactionType = 
  | 'activation' 
  | 'renewal' 
  | 'cancellation';

export interface Subscription {
  id: string;
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionTransaction {
  id: string;
  subscriptionId: string;
  userId: string;
  type: SubscriptionTransactionType;
  creditsAllocated: number;
  stripeInvoiceId: string | null;
  stripeEventId: string | null;
  createdAt: Date;
}

export interface SubscriptionConfig {
  id: string;
  name: string;
  description: string;
  priceUSD: number;
  priceId: string;
  productId: string;
  monthlyCredits: number;
  checkInMultiplier: number;
}
```

---

## Stripe Integration

### Stripe Product & Price Configuration

Create VIP subscription product in Stripe Dashboard:

**Product Details:**
- **Name**: Twistloom VIP Subscription
- **Description**: Monthly VIP membership with exclusive benefits
- **Price**: $9.99/month
- **Currency**: USD

**Environment Variables:**
```bash
# Add to .env.local
STRIPE_VIP_PRICE_ID=price_XXXXXXXXXXXXXXXX
STRIPE_VIP_PRODUCT_ID=prod_XXXXXXXXXXXXXXXX
VIP_MONTHLY_CREDITS=50
VIP_CHECKIN_MULTIPLIER=2
```

### Configuration File

Update `src/config/credits.ts`:

```typescript
/**
 * VIP Subscription Configuration
 */
export const VIP_SUBSCRIPTION: SubscriptionConfig = {
  id: "vip_monthly",
  name: "Twistloom VIP",
  description: "Monthly VIP membership with exclusive benefits",
  priceUSD: 9.99,
  priceId: process.env.STRIPE_VIP_PRICE_ID || "",
  productId: process.env.STRIPE_VIP_PRODUCT_ID || "",
  monthlyCredits: 50,
  checkInMultiplier: 2,
};

/**
 * VIP Benefits Configuration
 */
export const VIP_BENEFITS = {
  monthlyCredits: parseInt(process.env.VIP_MONTHLY_CREDITS || "50"),
  checkInMultiplier: parseInt(process.env.VIP_CHECKIN_MULTIPLIER || "2"),
} as const;
```

### Stripe Webhook Events

Handle additional webhook events for subscriptions:

**New Events to Handle:**
1. `customer.subscription.created` - New subscription created
2. `customer.subscription.updated` - Subscription updated (plan change, etc.)
3. `customer.subscription.deleted` - Subscription canceled
4. `invoice.payment_succeeded` - Monthly payment succeeded
5. `invoice.payment_failed` - Monthly payment failed
6. `invoice.upcoming` - Invoice upcoming (notification)

---

## Backend API Changes

### New Endpoints

#### 1. GET /payments/subscription-plans

Return available subscription plans.

```typescript
/**
 * GET /payments/subscription-plans
 * 
 * Returns available subscription plans for purchase.
 * 
 * Response (200 OK):
 * {
 *   plans: [
 *     {
 *       id: "vip_monthly",
 *       name: "Twistloom VIP",
 *       description: "Monthly VIP membership",
 *       priceUSD: 9.99,
 *       priceId: "price_...",
 *       monthlyCredits: 50,
 *       checkInMultiplier: 2,
 *       benefits: ["VIP badge", "2x check-in bonus", "+50 monthly credits"]
 *     }
 *   ]
 * }
 */
router.get("/subscription-plans", async (req: Request, res: Response) => {
  res.json({
    plans: [VIP_SUBSCRIPTION]
  });
});
```

#### 2. POST /payments/create-subscription-session

Create Stripe checkout session for subscription.

```typescript
/**
 * POST /payments/create-subscription-session
 * 
 * Creates a Stripe checkout session for VIP subscription.
 * 
 * Request Body:
 * {
 *   planId: string; // "vip_monthly"
 *   successUrl?: string;
 *   cancelUrl?: string;
 * }
 * 
 * Response (201 Created):
 * {
 *   url: string; // Stripe checkout URL
 * }
 */
router.post("/create-subscription-session", requireAuth, async (req: Request, res: Response) => {
  const { planId, successUrl, cancelUrl } = req.body;
  const userId = req.user!.id;

  // Validate plan
  if (planId !== VIP_SUBSCRIPTION.id) {
    return res.status(404).json({ error: "Subscription plan not found" });
  }

  // Check if user already has active subscription
  const existingSubscription = await dbRead
    .select()
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, userId),
      eq(subscriptions.status, 'active')
    ))
    .limit(1);

  if (existingSubscription.length > 0) {
    return res.status(400).json({ 
      error: "User already has an active subscription" 
    });
  }

  // Create or retrieve Stripe customer
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  let customerId = req.user!.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: req.user!.email,
      metadata: { userId }
    });
    customerId = customer.id;
    
    // Update user with stripeCustomerId
    await dbWrite
      .update(users)
      .set({ stripeCustomerId: customerId })
      .where(eq(users.userId, userId));
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer: customerId,
    line_items: [{
      price: VIP_SUBSCRIPTION.priceId,
      quantity: 1,
    }],
    metadata: {
      userId,
      planId,
    },
    client_reference_id: userId,
    success_url: successUrl || `${process.env.FRONTEND_URL}/dashboard?subscription=success`,
    cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/pricing?subscription=canceled`,
  });

  res.json({ url: session.url });
});
```

#### 3. GET /payments/subscription

Get user's current subscription status.

```typescript
/**
 * GET /payments/subscription
 * 
 * Returns user's current subscription status.
 * 
 * Response (200 OK):
 * {
 *   subscription: {
 *     id: string;
 *     status: "active" | "canceled" | null;
 *     currentPeriodEnd: string;
 *     cancelAtPeriodEnd: boolean;
 *     monthlyCredits: number;
 *   } | null
 * }
 */
router.get("/subscription", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const subscription = await dbRead
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (subscription.length === 0) {
    return res.json({ subscription: null });
  }

  const sub = subscription[0];
  res.json({
    subscription: {
      id: sub.id,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      monthlyCredits: VIP_BENEFITS.monthlyCredits,
    }
  });
});
```

#### 4. POST /payments/subscription/cancel

Cancel user's subscription (cancel at period end).

```typescript
/**
 * POST /payments/subscription/cancel
 * 
 * Cancels user's subscription at the end of the current billing period.
 * 
 * Response (200 OK):
 * {
 *   success: true,
 *   message: "Subscription will be canceled at period end"
 * }
 */
router.post("/subscription/cancel", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const subscription = await dbRead
    .select()
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, userId),
      eq(subscriptions.status, 'active')
    ))
    .limit(1);

  if (subscription.length === 0) {
    return res.status(404).json({ error: "No active subscription found" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  
  // Cancel subscription at period end
  await stripe.subscriptions.update(subscription[0].stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  // Update database
  await dbWrite
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, subscription[0].id));

  res.json({
    success: true,
    message: "Subscription will be canceled at period end"
  });
});
```

#### 5. GET /payments/subscription/portal

Create Stripe Customer Portal session for subscription management.

```typescript
/**
 * GET /payments/subscription/portal
 * 
 * Creates a Stripe Customer Portal session for subscription management.
 * 
 * Response (200 OK):
 * {
 *   url: string; // Stripe Customer Portal URL
 * }
 */
router.get("/subscription/portal", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const returnUrl = req.query.returnUrl as string || `${process.env.FRONTEND_URL}/dashboard`;

  const subscription = await dbRead
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (subscription.length === 0 || !subscription[0].stripeCustomerId) {
    return res.status(404).json({ error: "No subscription found" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription[0].stripeCustomerId,
    return_url: returnUrl,
  });

  res.json({ url: session.url });
});
```

### Modified Endpoints

#### Update Webhook Handler

Extend `POST /payments/stripe/webhook` to handle subscription events.

```typescript
// Add to existing webhook handler in src/routes/payments.ts

if (event.type === "customer.subscription.created") {
  await handleSubscriptionCreated(event);
} else if (event.type === "customer.subscription.updated") {
  await handleSubscriptionUpdated(event);
} else if (event.type === "customer.subscription.deleted") {
  await handleSubscriptionDeleted(event);
} else if (event.type === "invoice.payment_succeeded") {
  await handleInvoicePaymentSucceeded(event);
} else if (event.type === "invoice.payment_failed") {
  await handleInvoicePaymentFailed(event);
}
```

---

## Business Logic Changes

### Subscription Service

Create new service file `src/services/subscription.ts`:

```typescript
/**
 * Subscription Service Module
 * 
 * Handles subscription lifecycle, credit allocation, and tier management.
 */

import { dbWrite, dbRead } from "../db/client.js";
import { subscriptions, subscriptionTransactions, users, transactions } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { addCredits } from "./credits.js";
import { VIP_BENEFITS } from "../config/credits.js";
import type { SubscriptionStatus, SubscriptionTransactionType } from "../types/credits.js";

/**
 * Creates a new subscription record and allocates initial credits
 */
export async function createSubscription(params: {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Create subscription record
    const [subscription] = await tx.insert(subscriptions).values({
      userId: params.userId,
      stripeSubscriptionId: params.stripeSubscriptionId,
      stripeCustomerId: params.stripeCustomerId,
      stripePriceId: params.stripePriceId,
      status: 'active',
      currentPeriodStart: params.currentPeriodStart,
      currentPeriodEnd: params.currentPeriodEnd,
    }).returning();

    // Set user tier to VIP
    await tx.update(users)
      .set({ 
        tier: 'vip',
        subscriptionId: subscription.id,
        vipExpiresAt: params.currentPeriodEnd,
      })
      .where(eq(users.userId, params.userId));

    // Allocate initial monthly credits
    await addCredits(params.userId, VIP_BENEFITS.monthlyCredits, {
      context: "subscription_activation",
      metadata: { subscriptionId: subscription.id },
      tx
    });

    // Create subscription transaction record
    await tx.insert(subscriptionTransactions).values({
      subscriptionId: subscription.id,
      userId: params.userId,
      type: 'activation',
      creditsAllocated: VIP_BENEFITS.monthlyCredits,
    });
  });
}

/**
 * Updates subscription status and period
 */
export async function updateSubscription(params: {
  stripeSubscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  await dbWrite
    .update(subscriptions)
    .set({
      status: params.status,
      currentPeriodEnd: params.currentPeriodEnd,
      cancelAtPeriodEnd: params.cancelAtPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId));
}

/**
 * Handles subscription renewal - allocates monthly credits
 */
export async function renewSubscription(params: {
  stripeSubscriptionId: string;
  stripeInvoiceId: string;
  currentPeriodEnd: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Get subscription
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId))
      .limit(1);

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Update subscription period
    await tx.update(subscriptions)
      .set({
        currentPeriodEnd: params.currentPeriodEnd,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));

    // Update user VIP expiration
    await tx.update(users)
      .set({ vipExpiresAt: params.currentPeriodEnd })
      .where(eq(users.userId, subscription.userId));

    // Allocate monthly credits
    await addCredits(subscription.userId, VIP_BENEFITS.monthlyCredits, {
      context: "subscription_renewal",
      metadata: { subscriptionId: subscription.id },
      tx
    });

    // Create subscription transaction record
    await tx.insert(subscriptionTransactions).values({
      subscriptionId: subscription.id,
      userId: subscription.userId,
      type: 'renewal',
      creditsAllocated: VIP_BENEFITS.monthlyCredits,
      stripeInvoiceId: params.stripeInvoiceId,
    });
  });
}

/**
 * Handles subscription cancellation - schedules tier downgrade
 */
export async function cancelSubscription(params: {
  stripeSubscriptionId: string;
  canceledAt: Date;
}): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    // Get subscription
    const [subscription] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, params.stripeSubscriptionId))
      .limit(1);

    if (!subscription) {
      throw new Error("Subscription not found");
    }

    // Update subscription status
    await tx.update(subscriptions)
      .set({
        status: 'canceled',
        canceledAt: params.canceledAt,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));

    // Note: User tier remains 'vip' until currentPeriodEnd
    // This will be handled by the cron job
  });
}

/**
 * Checks if user has active VIP subscription
 */
export async function hasActiveVipSubscription(userId: string): Promise<boolean> {
  const user = await dbRead
    .select({ tier: users.tier, vipExpiresAt: users.vipExpiresAt })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (user.length === 0) return false;

  const userData = user[0];
  
  // Check if user is VIP and subscription hasn't expired
  if (userData.tier !== 'vip') return false;
  if (!userData.vipExpiresAt) return false;
  
  return new Date(userData.vipExpiresAt) > new Date();
}

/**
 * Downgrades user from VIP to standard (called by cron job)
 */
export async function downgradeUserFromVip(userId: string): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    await tx.update(users)
      .set({ 
        tier: 'standard',
        vipExpiresAt: null,
        subscriptionId: null,
      })
      .where(eq(users.userId, userId));
  });
}
```

### Modified Check-in Logic

Update `src/services/user.ts` to support dual claim system:

```typescript
// Add new parameter to performDailyCheckIn function
export async function performDailyCheckIn(
  userId: string,
  options: { claimType: 'regular' | 'vip_2x' } = { claimType: 'regular' }
) {
  // ... existing validation logic ...

  // Get user tier
  const userResult = await tx
    .select({ tier: users.tier })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  const isVip = userResult.length > 0 && userResult[0].tier === 'vip';

  // Validate claim type
  if (options.claimType === 'vip_2x' && !isVip) {
    throw new Error("VIP 2x claim is only available to VIP subscribers");
  }

  // Calculate base bonus
  const baseBonus = nextIndex === DAILY_CHECKIN_DAYS ? DAILY_CHECKIN_BIG_BONUS : DAILY_CHECKIN_BONUS;
  
  // Apply multiplier based on claim type
  const creditsToAward = options.claimType === 'vip_2x' 
    ? baseBonus * VIP_BENEFITS.checkInMultiplier 
    : baseBonus;

  // Rest of the logic remains the same...
}
```

Also update `getCheckInStatus` to include VIP status and both claim amounts in response:

```typescript
// In getCheckInStatus function

const userResult = await dbRead
  .select({ tier: users.tier })
  .from(users)
  .where(eq(users.userId, userId))
  .limit(1);

const isVip = userResult.length > 0 && userResult[0].tier === 'vip';

// Calculate next claim amounts
let regularClaimAmount = 0;
let vipClaimAmount = 0;
if (canCheckInStatus.canCheckIn) {
  const nextIndex = Math.min(streakExcludingToday + 1, DAILY_CHECKIN_DAYS);
  const baseAmount = nextIndex === DAILY_CHECKIN_DAYS ? DAILY_CHECKIN_BIG_BONUS : DAILY_CHECKIN_BONUS;
  regularClaimAmount = baseAmount;
  vipClaimAmount = baseAmount * VIP_BENEFITS.checkInMultiplier;
}

return {
  // ... existing fields
  isVip,
  regularClaimAmount,
  vipClaimAmount: isVip ? vipClaimAmount : 0,
};
```

### Webhook Handlers

Create webhook handler functions in `src/routes/payments.ts`:

```typescript
/**
 * Handles customer.subscription.created webhook event
 */
async function handleSubscriptionCreated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.error("[subscription] ❌ Missing userId in subscription metadata");
    return;
  }

  const priceId = subscription.items.data[0].price.id;

  await createSubscription({
    userId,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer as string,
    stripePriceId: priceId,
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
  });

  console.log(`[subscription] ✅ Created subscription for user ${userId}`);
}

/**
 * Handles customer.subscription.updated webhook event
 */
async function handleSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;

  await updateSubscription({
    stripeSubscriptionId: subscription.id,
    status: subscription.status as SubscriptionStatus,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

  console.log(`[subscription] 🔄 Updated subscription ${subscription.id}`);
}

/**
 * Handles customer.subscription.deleted webhook event
 */
async function handleSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;

  await cancelSubscription({
    stripeSubscriptionId: subscription.id,
    canceledAt: new Date(subscription.canceled_at * 1000),
  });

  console.log(`[subscription] ❌ Canceled subscription ${subscription.id}`);
}

/**
 * Handles invoice.payment_succeeded webhook event
 */
async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = invoice.subscription as string;
  const invoiceId = invoice.id;

  if (!subscriptionId) {
    console.error("[subscription] ❌ Missing subscriptionId in invoice");
    return;
  }

  const subscription = await dbRead
    .select({ currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (subscription.length === 0) {
    console.error("[subscription] ❌ Subscription not found for invoice");
    return;
  }

  await renewSubscription({
    stripeSubscriptionId: subscriptionId,
    stripeInvoiceId: invoiceId,
    currentPeriodEnd: new Date(subscription[0].currentPeriodEnd),
  });

  console.log(`[subscription] 💳 Renewed subscription ${subscriptionId}`);
}

/**
 * Handles invoice.payment_failed webhook event
 */
async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = invoice.subscription as string;

  if (!subscriptionId) return;

  // Update subscription status to past_due
  await updateSubscription({
    stripeSubscriptionId: subscriptionId,
    status: 'past_due',
    currentPeriodEnd: new Date(invoice.period_end * 1000),
  });

  console.log(`[subscription] ❌ Payment failed for subscription ${subscriptionId}`);
}
```

---

## Cron Jobs & Scheduled Tasks

### VIP Expiration Check Job

Create a cron job to check for expired VIP subscriptions and downgrade users.

**File**: `src/cron/check-vip-expiration.ts`

```typescript
/**
 * VIP Expiration Check Cron Job
 * 
 * Runs daily to check for expired VIP subscriptions and downgrade users to standard tier.
 * This ensures users only receive VIP benefits while their subscription is active.
 */

import { dbWrite, dbRead } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq, and, lt, sql } from "drizzle-orm";
import { downgradeUserFromVip } from "../services/subscription.js";

/**
 * Checks for expired VIP subscriptions and downgrades users
 */
export async function checkVipExpiration() {
  console.log("[vip-expiration] 🔍 Checking for expired VIP subscriptions...");

  const now = new Date();

  // Find users with VIP tier that have expired
  const expiredUsers = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(and(
      eq(users.tier, 'vip'),
      sql`${users.vipExpiresAt} IS NOT NULL`,
      lt(users.vipExpiresAt, now)
    ));

  if (expiredUsers.length === 0) {
    console.log("[vip-expiration] ✨ No expired VIP subscriptions found");
    return;
  }

  console.log(`[vip-expiration] ⚠️ Found ${expiredUsers.length} expired VIP subscriptions`);

  // Downgrade each expired user
  for (const user of expiredUsers) {
    try {
      await downgradeUserFromVip(user.userId);
      console.log(`[vip-expiration] ✅ Downgraded user ${user.userId} from VIP to standard`);
    } catch (error) {
      console.error(`[vip-expiration] ❌ Failed to downgrade user ${user.userId}:`, error);
    }
  }

  console.log(`[vip-expiration] ✅ Completed VIP expiration check`);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  checkVipExpiration()
    .then(() => {
      console.log("[vip-expiration] ✅ Job completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("[vip-expiration] ❌ Job failed:", error);
      process.exit(1);
    });
}
```

**Add to package.json scripts:**
```json
{
  "scripts": {
    "dev:cron:vip-expiration": "tsx src/cron/check-vip-expiration.ts",
    "start:cron:vip-expiration": "node dist/cron/check-vip-expiration.js"
  }
}
```

**Schedule**: Run daily at midnight UTC via GitHub Actions or Vercel Cron Jobs.

### GitHub Workflow

Create `.github/workflows/vip-expiration.yml`:

```yaml
name: VIP Expiration Check

on:
  schedule:
    - cron: '0 0 * * *' # Daily at midnight UTC
  workflow_dispatch:

jobs:
  check-vip-expiration:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build TypeScript
        run: pnpm build

      - name: Run VIP expiration check
        run: pnpm start:cron:vip-expiration
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
```

---

## Frontend Integration

### API Integration

#### 1. Fetch Subscription Plans

```typescript
// GET /api/payments/subscription-plans
const response = await fetch('/api/payments/subscription-plans');
const { plans } = await response.json();
```

#### 2. Create Subscription Session

```typescript
// POST /api/payments/create-subscription-session
const response = await fetch('/api/payments/create-subscription-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    planId: 'vip_monthly',
    successUrl: window.location.href + '?subscription=success',
    cancelUrl: window.location.href + '?subscription=canceled'
  }),
});
const { url } = await response.json();
window.location.href = url;
```

#### 3. Get Subscription Status

```typescript
// GET /api/payments/subscription
const response = await fetch('/api/payments/subscription');
const { subscription } = await response.json();
```

#### 4. Cancel Subscription

```typescript
// POST /api/payments/subscription/cancel
const response = await fetch('/api/payments/subscription/cancel', {
  method: 'POST',
});
const { success, message } = await response.json();
```

#### 5. Open Customer Portal

```typescript
// GET /api/payments/subscription/portal
const response = await fetch('/api/payments/subscription/portal?returnUrl=/dashboard');
const { url } = await response.json();
window.location.href = url;
```

### UI Components

#### Subscription Pricing Card

```typescript
// src/components/SubscriptionCard.tsx
interface SubscriptionCardProps {
  plan: SubscriptionConfig;
  currentSubscription?: Subscription | null;
}

export function SubscriptionCard({ plan, currentSubscription }: SubscriptionCardProps) {
  const isSubscribed = currentSubscription?.status === 'active';

  return (
    <div className="border rounded-lg p-6 bg-gradient-to-br from-purple-50 to-blue-50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold">{plan.name}</h3>
        {isSubscribed && (
          <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-sm">
            Active
          </span>
        )}
      </div>
      
      <p className="text-gray-600 mb-4">{plan.description}</p>
      
      <div className="mb-4">
        <span className="text-3xl font-bold">${plan.priceUSD}</span>
        <span className="text-gray-500">/month</span>
      </div>

      <ul className="space-y-2 mb-6">
        <li className="flex items-center">
          <span className="text-green-500 mr-2">✓</span>
          VIP badge on profile
        </li>
        <li className="flex items-center">
          <span className="text-green-500 mr-2">✓</span>
          {plan.checkInMultiplier}x daily check-in bonus (separate claim button)
        </li>
        <li className="flex items-center">
          <span className="text-green-500 mr-2">✓</span>
          +{plan.monthlyCredits} credits monthly
        </li>
      </ul>

      {!isSubscribed ? (
        <button
          onClick={handleSubscribe}
          className="w-full bg-purple-600 text-white py-2 rounded hover:bg-purple-700 transition"
        >
          Subscribe Now
        </button>
      ) : (
        <button
          onClick={handleManage}
          className="w-full bg-gray-200 text-gray-800 py-2 rounded hover:bg-gray-300 transition"
        >
          Manage Subscription
        </button>
      )}
    </div>
  );
}
```

#### VIP Badge Component

```typescript
// src/components/VIPBadge.tsx
interface VIPBadgeProps {
  userId: string;
  isVip: boolean;
}

export function VIPBadge({ isVip }: VIPBadgeProps) {
  if (!isVip) return null;

  return (
    <span className="inline-flex items-center px-2 py-1 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-bold">
      👑 VIP
    </span>
  );
}
```

#### Updated Check-in Component

```typescript
// src/components/CheckInButton.tsx
export function CheckInButton() {
  const { data: user } = useUser();
  const { data: checkInStatus } = useCheckInStatus();
  const isVip = user?.tier === 'vip';

  return (
    <div>
      {checkInStatus?.canCheckIn ? (
        <div className="flex gap-2">
          {/* Regular claim button - available to all users */}
          <button onClick={() => handleCheckIn('regular')}>
            Claim {checkInStatus.regularClaimAmount} Credits
          </button>
          
          {/* VIP 2x claim button - only available to VIP users */}
          {isVip && (
            <button 
              onClick={() => handleCheckIn('vip_2x')}
              className="bg-purple-600 text-white"
            >
              Claim {checkInStatus.vipClaimAmount} Credits (VIP 2x Bonus!)
            </button>
          )}
        </div>
      ) : (
        <p>Already checked in today</p>
      )}
    </div>
  );
}
```

### User Profile Updates

Add VIP badge and subscription status to user profile:

```typescript
// src/app/user/[username]/page.tsx
export default function UserProfile({ params }: { params: { username: string } }) {
  const { data: user } = useUser(params.username);

  return (
    <div>
      <div className="flex items-center gap-2">
        <h1>{user.name}</h1>
        <VIPBadge isVip={user.tier === 'vip'} />
      </div>
      
      {user.subscription && (
        <div className="mt-4 p-4 bg-purple-50 rounded">
          <h3>VIP Member</h3>
          <p>Status: {user.subscription.status}</p>
          <p>Renews: {new Date(user.subscription.currentPeriodEnd).toLocaleDateString()}</p>
        </div>
      )}
    </div>
  );
}
```

---

## Testing Strategy

### Unit Tests

**Subscription Service Tests:**
```typescript
// tests/subscription.test.ts
describe('Subscription Service', () => {
  describe('createSubscription', () => {
    it('should create subscription and allocate credits', async () => {
      const result = await createSubscription({
        userId: 'test-user-id',
        stripeSubscriptionId: 'sub_test',
        stripeCustomerId: 'cus_test',
        stripePriceId: 'price_test',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      // Verify user tier is VIP
      // Verify credits allocated
      // Verify subscription record created
    });
  });

  describe('hasActiveVipSubscription', () => {
    it('should return true for active VIP user', async () => {
      const isActive = await hasActiveVipSubscription('vip-user-id');
      expect(isActive).toBe(true);
    });

    it('should return false for standard user', async () => {
      const isActive = await hasActiveVipSubscription('standard-user-id');
      expect(isActive).toBe(false);
    });

    it('should return false for expired VIP user', async () => {
      const isActive = await hasActiveVipSubscription('expired-vip-user-id');
      expect(isActive).toBe(false);
    });
  });
});
```

**Check-in Logic Tests:**
```typescript
// tests/checkin-vip.test.ts
describe('Check-in with VIP', () => {
  it('should apply 3x multiplier for VIP users', async () => {
    const result = await performDailyCheckIn('vip-user-id');
    expect(result.creditsAwarded).toBe(15); // 5 * 3
  });

  it('should apply 3x multiplier for VIP users on day 7', async () => {
    // Set up 6-day streak
    // Perform check-in on day 7
    const result = await performDailyCheckIn('vip-user-id');
    expect(result.creditsAwarded).toBe(60); // 20 * 3
  });
});
```

### Integration Tests

**Webhook Handler Tests:**
```typescript
// tests/webhook-subscription.test.ts
describe('Subscription Webhooks', () => {
  it('should handle subscription.created event', async () => {
    const event = createMockStripeEvent('customer.subscription.created', {
      metadata: { userId: 'test-user-id' },
      // ... other subscription data
    });

    await handleSubscriptionCreated(event);

    // Verify subscription created
    // Verify user tier updated
    // Verify credits allocated
  });

  it('should handle invoice.payment_succeeded event', async () => {
    const event = createMockStripeEvent('invoice.payment_succeeded', {
      subscription: 'sub_test',
      id: 'in_test',
    });

    await handleInvoicePaymentSucceeded(event);

    // Verify credits allocated
    // Verify subscription period updated
  });
});
```

### End-to-End Tests

**Subscription Flow Test:**
```typescript
// tests/e2e/subscription-flow.test.ts
describe('Subscription E2E Flow', () => {
  it('should complete full subscription lifecycle', async () => {
    // 1. User subscribes
    const session = await createSubscriptionSession('vip_monthly');
    expect(session.url).toBeDefined();

    // 2. Simulate Stripe webhook
    await simulateWebhook('customer.subscription.created', {
      userId: testUserId,
    });

    // 3. Verify user is VIP
    const user = await getUser(testUserId);
    expect(user.tier).toBe('vip');

    // 4. Verify credits allocated
    expect(user.credits).toBe(initialCredits + 50);

    // 5. Perform check-in
    const checkInResult = await performDailyCheckIn(testUserId);
    expect(checkInResult.creditsAwarded).toBe(15); // 5 * 3

    // 6. Simulate monthly renewal
    await simulateWebhook('invoice.payment_succeeded', {
      subscription: subscriptionId,
    });

    // 7. Verify additional credits allocated
    const userAfterRenewal = await getUser(testUserId);
    expect(userAfterRenewal.credits).toBe(user.credits + 50);

    // 8. Cancel subscription
    await cancelSubscription(subscriptionId);

    // 9. Verify cancel_at_period_end set
    const subscription = await getSubscription(subscriptionId);
    expect(subscription.cancelAtPeriodEnd).toBe(true);

    // 10. Simulate period end
    await runVipExpirationCron();

    // 11. Verify user downgraded
    const userAfterDowngrade = await getUser(testUserId);
    expect(userAfterDowngrade.tier).toBe('standard');
  });
});
```

---

## Migration Plan

### Phase 1: Database Schema Migration

**Steps:**
1. Create migration file for new tables
2. Run migration in development environment
3. Test with sample data
4. Run migration in production

**Migration File:**
```sql
-- migrations/XXXX_add_subscription_tables.sql

-- Create subscriptions table
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid', 'trialing')),
  current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX subscriptions_user_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions(current_period_end);
CREATE UNIQUE INDEX subscriptions_stripe_subscription_unique ON subscriptions(stripe_subscription_id);

-- Create subscription_transactions table
CREATE TABLE subscription_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('activation', 'renewal', 'cancellation')),
  credits_allocated INTEGER NOT NULL,
  stripe_invoice_id TEXT UNIQUE,
  stripe_event_id TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX subscription_transactions_subscription_idx ON subscription_transactions(subscription_id);
CREATE INDEX subscription_transactions_user_idx ON subscription_transactions(user_id);
CREATE INDEX subscription_transactions_type_idx ON subscription_transactions(type);
CREATE UNIQUE INDEX subscription_transactions_invoice_unique ON subscription_transactions(stripe_invoice_id);

-- Add columns to users table
ALTER TABLE users 
ADD COLUMN subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
ADD COLUMN vip_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX users_vip_expires_idx ON users(vip_expires_at) WHERE vip_expires_at IS NOT NULL;
```

**Run Migration:**
```bash
pnpm db:generate
pnpm db:migrate
```

### Phase 2: Backend Implementation

**Steps:**
1. Implement subscription service
2. Add new API endpoints
3. Update webhook handlers
4. Modify check-in logic
5. Add VIP expiration cron job
6. Write unit tests
7. Write integration tests

**Order:**
1. Database schema (Phase 1)
2. Subscription service
3. Webhook handlers
4. API endpoints
5. Check-in logic modification
6. Cron job
7. Tests

### Phase 3: Stripe Configuration

**Steps:**
1. Create VIP product in Stripe Dashboard
2. Create monthly price ($9.99)
3. Add price ID to environment variables
4. Configure webhook endpoints in Stripe
5. Test webhook delivery

**Stripe Dashboard Setup:**
1. Go to Products → Add product
2. Name: "Twistloom VIP"
3. Description: "Monthly VIP membership"
4. Price: $9.99/month
5. Copy price ID to `.env.local`

**Webhook Configuration:**
1. Go to Developers → Webhooks
2. Add endpoint: `https://twistloom-backend.vercel.app/api/payments/stripe/webhook`
3. Select events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`

### Phase 4: Frontend Implementation

**Steps:**
1. Add API integration functions
2. Create subscription pricing card component
3. Create VIP badge component
4. Update check-in component
5. Update user profile page
6. Add subscription management UI
7. Test end-to-end flow

### Phase 5: Testing & QA

**Steps:**
1. Unit tests (backend)
2. Integration tests (webhooks)
3. End-to-end tests (full flow)
4. Manual testing (Stripe test mode)
5. Load testing (webhook handling)
6. Security audit (price validation, idempotency)

### Phase 6: Production Deployment

**Steps:**
1. Deploy database migration to production
2. Deploy backend code
3. Update environment variables
4. Configure Stripe production webhooks
5. Deploy frontend code
6. Monitor initial subscriptions
7. Set up alerts for failures

---

## Rollback Plan

### Database Rollback

**If issues arise, revert database changes:**

```sql
-- Drop new tables
DROP TABLE IF EXISTS subscription_transactions CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;

-- Remove columns from users table
ALTER TABLE users 
DROP COLUMN IF EXISTS subscription_id,
DROP COLUMN IF EXISTS vip_expires_at;

DROP INDEX IF EXISTS users_vip_expires_idx;
```

**Create rollback migration:**
```bash
pnpm db:generate  # Will create rollback migration
```

### Code Rollback

**Git Strategy:**
1. Create feature branch: `feature/subscription-hybrid-model`
2. Implement changes in small commits
3. If issues arise, revert to previous stable commit
4. Hotfix branch if needed: `hotfix/subscription-fix`

### Stripe Rollback

**If Stripe integration fails:**
1. Disable webhook endpoints in Stripe Dashboard
2. Cancel any test subscriptions
3. Remove product/price if needed
4. Re-enable after fix

### Monitoring Rollback

**Key Metrics to Monitor:**
- Subscription creation rate
- Webhook failure rate
- Credit allocation errors
- VIP expiration job failures
- User complaints about missing benefits

**Rollback Triggers:**
- Webhook failure rate > 5%
- Credit allocation errors > 1%
- VIP expiration job fails for > 24 hours
- User reports of missing VIP benefits

---

## Success Metrics

### Business Metrics

- **Subscription Conversion Rate**: % of users who subscribe after viewing pricing
- **Subscription Retention Rate**: % of subscribers who renew after first month
- **ARPU (Average Revenue Per User)**: Increase in revenue per user
- **VIP Engagement**: Check-in rate for VIP users vs standard users

### Technical Metrics

- **Webhook Success Rate**: > 99.5%
- **Credit Allocation Accuracy**: 100% (no missing or duplicate allocations)
- **VIP Expiration Job Success**: 100% (no failed downgrades)
- **API Response Time**: < 200ms for subscription endpoints

### User Experience Metrics

- **Subscription Setup Time**: < 2 minutes from click to activation
- **Credit Allocation Latency**: < 30 seconds from webhook to credit allocation
- **VIP Badge Visibility**: 100% of VIP users see badge in profile
- **Check-in Bonus Accuracy**: 100% of VIP users receive 3x bonus

---

## Timeline Estimate

### Development Time

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Database Schema | 1 day | None |
| Phase 2: Backend Implementation | 5 days | Phase 1 |
| Phase 3: Stripe Configuration | 1 day | None (can run in parallel) |
| Phase 4: Frontend Implementation | 3 days | Phase 2 |
| Phase 5: Testing & QA | 3 days | Phase 2, 4 |
| Phase 6: Production Deployment | 1 day | Phase 5 |
| **Total** | **14 days** | |

### Buffer Time

Add 3-5 days buffer for unexpected issues: **17-19 days total**

---

## Risks & Mitigations

### Risk 1: Stripe Webhook Failures

**Risk**: Webhooks may fail due to network issues, signature verification errors, or downtime.

**Mitigation**:
- Implement webhook delivery tracking (already exists)
- Add retry logic with exponential backoff
- Monitor webhook delivery status
- Set up alerts for webhook failures
- Manual reconciliation script for missed events

### Risk 2: Credit Allocation Errors

**Risk**: Credits may be allocated incorrectly (missing, duplicate, wrong amount).

**Mitigation**:
- Use database transactions for atomicity
- Implement idempotency via `stripeEventId`
- Add comprehensive logging
- Create reconciliation script to audit allocations
- Monitor transaction records for anomalies

### Risk 3: VIP Expiration Job Failures

**Risk**: Cron job may fail, leaving users with VIP benefits after subscription expires.

**Mitigation**:
- Add error handling and retry logic
- Monitor job execution logs
- Set up alerts for job failures
- Create manual script to fix expired VIP users
- Consider job queue (e.g., BullMQ) for reliability

### Risk 4: User Confusion on Cancellation

**Risk**: Users may expect immediate cancellation instead of end-of-period.

**Mitigation**:
- Clear UI messaging: "Cancel at end of billing period"
- Show exact date when benefits will end
- Email notification on cancellation
- FAQ section explaining cancellation policy

### Risk 5: Price Manipulation Attacks

**Risk**: Attackers may attempt to manipulate subscription prices.

**Mitigation**:
- Server-side price validation (already implemented for credit packs)
- Use pre-created Stripe prices (not dynamic)
- Never trust frontend price data
- Log suspicious attempts
- Monitor for price anomalies

---

## Future Enhancements

### Potential Future Features

1. **Annual Subscription**: Offer discounted annual plan ($99/year vs $9.99/month)
2. **Tiered Subscriptions**: Multiple VIP tiers (Silver, Gold, Platinum) with different benefits
3. **Trial Period**: Free 7-day trial for new subscribers
4. **Referral Program**: Free subscription months for referring new users
5. **Bundle Discounts**: Discount for subscribing + purchasing credit packs
6. **Usage Analytics**: Track VIP vs standard user engagement metrics
7. **Dynamic Pricing**: Adjust subscription price based on user engagement
8. **Gift Subscriptions**: Allow users to gift subscriptions to others

### Technical Improvements

1. **Job Queue**: Replace cron jobs with BullMQ for better reliability
2. **Real-time Updates**: Use WebSockets for real-time subscription status updates
3. **Analytics Dashboard**: Admin dashboard for subscription metrics
4. **Automated Reconciliation**: Daily script to reconcile Stripe vs database
5. **Webhook Replay**: Ability to replay failed webhooks from admin panel

---

## Conclusion

This roadmap provides a comprehensive plan for implementing a hybrid subscription model that complements the existing one-time credit pack system. The implementation follows best practices for:

- **Security**: Price validation, idempotency, signature verification
- **Reliability**: Database transactions, webhook tracking, error handling
- **Scalability**: Efficient database queries, cron jobs for background tasks
- **User Experience**: Clear UI messaging, graceful degradation, smooth transitions

The phased approach allows for incremental development and testing, reducing risk and ensuring a stable production deployment. The rollback plan provides a safety net in case of issues, and the monitoring strategy ensures ongoing reliability.

**Next Steps:**
1. Review and approve this roadmap
2. Set up Stripe product and pricing
3. Begin Phase 1: Database schema migration
4. Proceed with backend implementation
5. Coordinate with frontend team for UI integration
6. Execute testing plan
7. Deploy to production

