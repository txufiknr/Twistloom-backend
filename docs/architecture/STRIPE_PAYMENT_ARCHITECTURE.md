# Stripe Payment Architecture & Best Practices

## Overview

This document outlines the complete Stripe payment system architecture, including Vercel+Neon PostgreSQL best practices, safe transaction implementation with neon-http, and comprehensive error handling.

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
- **Database**: Neon PostgreSQL with neon-http driver
- **ORM**: Drizzle ORM
- **Payment**: Stripe API

---

## 🔧 Environment Configuration

### Backend Environment Variables

```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_CREDITS_SMALL=price_observer
STRIPE_PRICE_ID_CREDITS_MEDIUM=price_investigator  
STRIPE_PRICE_ID_CREDITS_LARGE=price_mastermind

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

### 1. Raw Body Required (Next.js API Routes)

**Problem**: Stripe webhook WILL FAIL if body is parsed.

**Solution**: Configure Next.js API routes to disable body parsing.

```javascript
// next.config.js
export const config = {
  api: {
    bodyParser: false,
  },
};
```

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
  type TEXT NOT NULL CHECK (type IN ('purchase', 'usage')),
  credits INTEGER NOT NULL,
  amount_usd REAL,
  payment_intent_id TEXT UNIQUE, -- Stripe payment intent for idempotency
  stripe_event_id TEXT UNIQUE NOT NULL, -- Stripe event ID for webhook idempotency
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes
CREATE INDEX transactions_user_idx ON transactions(user_id);
CREATE INDEX transactions_type_idx ON transactions(type);
CREATE INDEX transactions_created_idx ON transactions(created_at DESC);
CREATE UNIQUE INDEX transactions_payment_intent_unique ON transactions(payment_intent_id);
CREATE UNIQUE INDEX transactions_stripe_event_unique ON transactions(stripe_event_id);
```

### Processed Events Table

```sql
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY, -- Stripe event ID
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Index for cleanup queries
CREATE INDEX processed_events_processed_at_idx ON processed_events(processed_at DESC);
```

---

## 🔄 Safe Transaction Implementation (neon-http)

### "Event First" Pattern

Since neon-http doesn't support interactive transactions, we use the "Event First" pattern:

#### Step A: Track Event First
```typescript
// Try to insert event ID into processed_events table
try {
  await dbWrite.insert(processedEvents).values({
    eventId: stripeEventId,
  });
} catch (insertError) {
  // If insert fails due to unique constraint, event was already processed
  console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
  return res.json({ received: true, duplicate: true });
}
```

#### Step B: Process Payment
```typescript
// Event not processed before, proceed with payment processing
const updateResult = await dbWrite
  .update(users)
  .set({ 
    credits: sql`${users.credits} + ${creditsAmount}` 
  })
  .where(eq(users.userId, userId))
  .returning({ credits: users.credits });

// Create transaction record
try {
  await dbWrite.insert(transactions).values({
    userId,
    type: "purchase",
    credits: creditsAmount,
    amountUsd,
    paymentIntentId,
    stripeEventId,
  });
} catch (transactionError) {
  console.error("[stripe] ❌ Failed to create transaction record:", getErrorMessage(transactionError));
  // Log for manual reconciliation but don't fail webhook
  console.warn(`Credits added to user ${userId} but transaction record failed for payment ${session.id}`);
}
```

### Recovery & Cleanup

#### Background Cron Job
```typescript
export async function cleanupOrphanedProcessedEvents(): Promise<{
  eventsProcessed: number;
  transactionsRecovered: number;
  eventsCleaned: number;
}> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  
  // Find processed events from last 10 minutes without corresponding successful transactions
  const orphanedEvents = await dbWrite
    .select({
      eventId: processedEvents.eventId,
      processedAt: processedEvents.processedAt,
    })
    .from(processedEvents)
    .leftJoin(
      transactions,
      eq(processedEvents.eventId, transactions.stripeEventId)
    )
    .where(
      and(
        eq(processedEvents.processedAt, tenMinutesAgo),
        sql`${transactions.stripeEventId} IS NULL` // No corresponding transaction
      )
    )
    .orderBy(desc(processedEvents.processedAt))
    .limit(50); // Process up to 50 orphaned events per run

  // Process each orphaned event
  for (const orphanedEvent of orphanedEvents) {
    eventsProcessed++;
    
    try {
      if (orphanedEvent.eventId.startsWith('evt_')) {
        // For webhook events, we can't recover transaction without additional data
        console.log(`[cleanup] 🗑️ Removing orphaned webhook event: ${orphanedEvent.eventId}`);
        await dbWrite
          .delete(processedEvents)
          .where(eq(processedEvents.eventId, orphanedEvent.eventId));
        eventsCleaned++;
      } else {
        console.log(`[cleanup] ⚠️ Found orphaned event but cannot recover: ${orphanedEvent.eventId}`);
        eventsCleaned++;
      }
    } catch (error) {
      console.error(`[cleanup] ❌ Failed to process orphaned event ${orphanedEvent.eventId}:`, getErrorMessage(error));
    }
  }

  return {
    eventsProcessed,
    transactionsRecovered,
    eventsCleaned,
  };
}
```

---

## 🛣️ API Endpoints

### POST /api/payments/create-checkout-session

Creates Stripe checkout session for purchasing credit packs.

**Request Body**:
```typescript
{
  packId: string; // Credit pack ID ("observer", "investigator", "mastermind")
}
```

**Response**:
```typescript
{
  url: string; // Stripe checkout URL
}
```

**Implementation**:
```typescript
router.post("/create-checkout-session", requireAuth, async (req: Request, res: Response) => {
  const { packId } = req.body;
  
  // Find the credit pack by ID (server-side validation)
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) {
    return res.status(404).json({ error: "Credit pack not found" });
  }

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: user.email,
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
      userId,
      packId: pack.id,
      credits: pack.credits.toString(),
    },
    success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/pricing`,
  });

  res.json({ url: session.url });
});
```

### POST /api/payments/stripe/webhook

Handles Stripe webhook events for payment processing.

**Headers**:
- `stripe-signature`: Stripe signature for webhook verification

**Events Handled**:
- `checkout.session.completed`: Payment successful

**Implementation**:
```typescript
router.post("/stripe/webhook", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"];
  
  // Verify webhook signature
  const event = stripe.webhooks.constructEvent(
    req.body,
    sig,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  // Handle checkout session completed events
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const stripeEventId = event.id;
    const paymentIntentId = session.payment_intent as string;
    
    // Step A: Try to insert event ID into processed_events table
    try {
      await dbWrite.insert(processedEvents).values({
        eventId: stripeEventId,
      });
    } catch (insertError) {
      console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
      return res.json({ received: true, duplicate: true });
    }

    // Step B: Event not processed before, proceed with payment processing
    const userId = session.metadata?.userId;
    const credits = session.metadata?.credits;
    
    if (!userId || !credits) {
      console.error("[stripe] ❌ Missing metadata in checkout session:", session.id);
      return res.status(400).json({ error: "Invalid session metadata" });
    }

    const creditsAmount = Number(credits);
    const amountUsd = session.amount_total ? session.amount_total / 100 : undefined;

    // Update user credits first
    const creditUpdateResult = await dbWrite
      .update(users)
      .set({ 
        credits: sql`${users.credits} + ${creditsAmount}` 
      })
      .where(eq(users.userId, userId))
      .returning({ credits: users.credits });

    if (!creditUpdateResult || creditUpdateResult.length === 0) {
      console.error("[stripe] ❌ Failed to update user credits - user not found:", userId);
      return res.status(400).json({ error: "User not found" });
    }

    // Create transaction record
    try {
      await dbWrite.insert(transactions).values({
        userId,
        type: "purchase",
        credits: creditsAmount,
        amountUsd,
        paymentIntentId,
        stripeEventId,
      });
    } catch (transactionError) {
      console.error("[stripe] ❌ Failed to create transaction record for payment ${session.id}:", getErrorMessage(transactionError));
      console.warn(`[stripe] ⚠️ Transaction record failed for payment ${session.id}`);
    }

    console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${creditUpdateResult[0].credits}) for payment ${session.id}`);
  }

  res.json({ received: true });
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
- **HTTPS only**: Webhooks only work with HTTPS endpoints
- **Rate limiting**: Consider rate limiting webhook endpoints
- **Idempotency**: Store and check `event.id` before processing

### API Security
- **Authentication**: All payment endpoints require authentication
- **Input validation**: Validate all inputs server-side
- **Price lookup**: Never trust frontend price, always lookup by ID
- **Credit validation**: Check user balance before consumption

### Data Protection
- **PII compliance**: Store minimal necessary user data
- **Transaction logging**: Complete audit trail for all operations
- **Error handling**: Graceful degradation with proper logging

---

## 📊 Monitoring & Logging

### Key Metrics
- **Webhook success rate**: Percentage of successful webhook deliveries
- **Payment processing time**: Time from webhook to credit allocation
- **Credit consumption rate**: Credits used per user per time period
- **Error rates**: Types and frequency of payment failures
- **Recovery effectiveness**: Success rate of orphaned event cleanup

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
- [ ] Regular cleanup of processed_events table
- [ ] Monitor credit consumption patterns

---

## 🔧 Troubleshooting

### Common Issues

#### Webhook Not Received
1. Check Stripe dashboard webhook configuration
2. Verify webhook URL is accessible
3. Check server logs for signature verification errors

#### Duplicate Credits
1. Check processed_events table for duplicates
2. Verify idempotency logic implementation
3. Review webhook retry patterns

#### Payment Failures
1. Check Stripe secret key configuration
2. Verify payment method configuration
3. Review error logs for specific failure reasons

#### Credit Allocation Issues
1. Check user existence before credit updates
2. Verify transaction record creation
3. Review database connection and query performance

---

## 📚 Additional Resources

- [Stripe Documentation](https://stripe.com/docs)
- [Neon Database Guide](https://neon.tech/docs)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Vercel Deployment Guide](https://vercel.com/docs)
- [Next.js API Routes](https://nextjs.org/docs/api-routes/introduction)

---

*Last updated: April 29, 2026*
