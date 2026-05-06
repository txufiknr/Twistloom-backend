/**
 * Payments Routes Module
 * 
 * Provides endpoints for Stripe checkout sessions, credit purchases, and transaction history.
 * Integrates with Stripe for payment processing and tracks all credit-related transactions.
 * 
 * Architecture Features:
 * - Stripe checkout session creation
 * - Credit pack configuration management
 * - Transaction tracking and history
 * - Webhook handling for payment confirmation
 * - Daily reward bonus tracking
 * - Usage and purchase transaction management
 * 
 * Endpoints:
 * - GET /payments/credit-packs - Get available credit packs
 * - POST /payments/create-checkout-session - Create Stripe checkout session
 * - POST /payments/stripe/webhook - Handle Stripe webhook events
 * - POST /payments/consume-credits - Consume credits for usage
 * - GET /payments/transactions - Get user transaction history
 */

import type { Request, Response } from "express";
import { Router } from "express";
import Stripe from "stripe";
import { eq, sql, and, desc } from "drizzle-orm";
import { createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { requireAuth } from "../middleware/nextauth.js";
import { checkRateLimitByIP } from "../middleware/rate-limit.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications } from "../db/schema.js";
import { CREDIT_PACKS, type CreditCostKey, CREDIT_COSTS } from "../config/credits.js";
import { type TransactionType } from "../types/credits.js";
import { getErrorMessage, handleApiError } from "../utils/error.js";
import { checkRateLimit, checkIdempotency, storeIdempotencyResult, constructSafeUrl, setIdempotencyProcessing } from "../utils/redis.js";
import { consumeCredits, getCreditCost } from "../services/credits.js";
import { CREDIT_ERRORS } from "../config/errors.js";

/**
 * Helper function to check if error is insufficient credits
 */
function isInsufficientCreditsError(error: unknown): boolean {
  return getErrorMessage(error).includes(CREDIT_ERRORS.INSUFFICIENT_CREDITS_PATTERN);
}

/**
 * Helper function to handle insufficient credits errors consistently
 * Optimized to reduce database load by using simple error response
 */
async function handleInsufficientCreditsError(
  res: Response,
  costKey: string
): Promise<void> {
  const cost = getCreditCost(costKey as CreditCostKey);
  
  // Return simple error without additional database query
  // The frontend can fetch current balance if needed
  res.status(402).json({
    error: CREDIT_ERRORS.INSUFFICIENT_CREDITS,
    required: cost,
    available: null, // Frontend can fetch if needed
  });
}

const router = Router();

/**
 * GET /payments/credit-packs
 * 
 * Returns the list of available credit packs for purchase.
 * This endpoint allows the frontend to fetch the current credit pack configuration
 * without hardcoding it in the frontend.
 * 
 * Response (Success - 200):
 * [
 *   {
 *     id: string;
 *     title: string;
 *     tagline: string;
 *     description: string;
 *     credits: number;
 *     priceUSD: number;
 *     priceId: string;
 *     productId: string;
 *     highlight: boolean;
 *     badge: string | null;
 *     valueTag: string;
 *     color: "gray" | "blue" | "purple" | "green" | "yellow" | "red";
 *   }
 * ]
 * 
 * Security:
 * - No authentication required (public pricing information)
 * - Returns safe data only (no sensitive configuration)
 * 
 * @example
 * ```typescript
 * const res = await fetch('/api/payments/credit-packs');
 * const creditPacks = await res.json();
 * 
 * // Display credit packs to users
 * creditPacks.forEach(pack => {
 *   console.log(`${pack.title}: $${pack.priceUSD} (${pack.credits} credits)`);
 * });
 * ```
 */
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

/**
 * POST /payments/create-checkout-session
 * 
 * Creates a Stripe checkout session for purchasing credit packs.
 * 
 * Request Body:
 * {
 *   packId: string; // Credit pack ID (e.g., "observer", "investigator", "mastermind")
 *   returnUrl?: string; // Optional current page URL for refresh-less UX (e.g., "https://app.com/books/slug/pageId")
 *   successPath?: string; // Optional custom success path (fallback if returnUrl not provided, default: "/dashboard?success=true")
 *   cancelPath?: string; // Optional custom cancel path (fallback if returnUrl not provided, default: "/pricing")
 * }
 * 
 * Response:
 * {
 *   url: string; // Stripe checkout URL to redirect user to
 * }
 * 
 * Error Response:
 * {
 *   error: string; // Error message
 * }
 * 
 * Security:
 * - Requires authentication
 * - Rate limited: 1 session per 10 seconds per user
 * - Validates URLs to prevent open redirects
 * - Uses idempotency key to prevent duplicate sessions
 * 
 * Refresh-Less UX:
 * - When returnUrl is provided, backend appends ?payment=success or ?payment=cancel
 * - Frontend can detect this param and invalidate queries to update credits
 * - User returns to the same page after payment (no navigation away)
 * 
 * @example
 * ```typescript
 * // Basic usage (legacy behavior - redirects to dashboard)
 * const res = await fetch('/api/payments/create-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ packId: 'investigator' }),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * 
 * // Refresh-less UX (recommended - returns to same page)
 * const currentUrl = window.location.href; // e.g., "https://app.com/books/hush-frequency/pageId"
 * const res = await fetch('/api/payments/create-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     packId: 'investigator',
 *     returnUrl: currentUrl,
 *   }),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * // User returns to: currentUrl + "?payment=success"
 * // Frontend detects param and invalidates queries to update credits
 * 
 * // Legacy custom URLs (fallback)
 * const res = await fetch('/api/payments/create-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     packId: 'investigator',
 *     successPath: '/payment/success?from=pricing',
 *     cancelPath: '/payment/cancel?from=pricing'
 *   }),
 * });
 * ```
 */
router.post("/create-checkout-session", requireAuth, async (req: Request, res: Response) => {
  try {
    const { packId, successPath, cancelPath, returnUrl } = req.body;

    // Validate input
    if (!packId) {
      return res.status(400).json({ error: "Credit pack ID is required" });
    }

    // Get user from middleware
    const user = req.user!;
    const userId = user.id;

    // Rate limiting: Prevent duplicate session spam (1 session per 10 seconds per user)
    const rateLimitResult = await checkRateLimit(`checkout-session-${userId}`, {
      maxRequests: 1,
      windowSeconds: 10,
    });
    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        error: "Too many checkout session attempts. Please wait a few seconds before trying again."
      });
    }

    // Validate and construct URLs (security: prevent open redirects)
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return res.status(500).json({ error: "Frontend URL not configured" });
    }

    // For refresh-less UX: use returnUrl to return user to same page
    // If returnUrl is provided, append payment status params for frontend detection
    // If not provided, fall back to successPath/cancelPath or defaults
    let successUrl: string;
    let cancelUrl: string;

    if (returnUrl) {
      // Remove any existing query params from returnUrl and append payment status
      const baseUrlObj = new URL(returnUrl, baseUrl);
      baseUrlObj.searchParams.set('payment', 'success');
      successUrl = baseUrlObj.toString();
      
      const cancelUrlObj = new URL(returnUrl, baseUrl);
      cancelUrlObj.searchParams.set('payment', 'cancel');
      cancelUrl = cancelUrlObj.toString();
    } else {
      // Legacy behavior: use successPath/cancelPath or defaults
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?success=true');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }

    // Find the credit pack
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      return res.status(404).json({ error: "Credit pack not found" });
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Create Stripe checkout session with idempotency key
    // Prevents duplicate sessions from network retries or double-clicks
    const idempotencyKey = `checkout-${userId}-${packId}-${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: user.email,
      line_items: [
        {
          price: pack.priceId,
          // price_data: {
          //   currency: "usd",
          //   product_data: {
          //     name: pack.title,
          //     description: pack.description,
          //   },
          //   unit_amount: Math.round(pack.priceUSD * 100), // Convert to cents
          // },
          quantity: 1,
        },
      ],
      metadata: {
        userId,
        packId: pack.id,
        credits: pack.credits.toString(),
      },
      client_reference_id: userId, // Backup to metadata for user binding
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, {
      idempotencyKey, // Prevents duplicate session creation
    });

    res.json({ url: session.url });
  } catch (error) {
    handleApiError(res, "Failed to create checkout session", error);
  }
});

/**
 * POST /payments/stripe/webhook
 * 
 * Handles Stripe webhook events for payment processing.
 * Processes checkout.session.completed events to add credits and create transactions.
 * 
 * Endpoint: https://twistloom-backend.vercel.app/api/payments/stripe/webhook
 * Events:
 * - checkout.session.completed
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - charge.refunded
 * 
 * Headers:
 * - stripe-signature: Stripe signature for webhook verification
 * 
 * Request Body:
 * - Raw Stripe event data
 * 
 * Response (Success - 200):
 * {
 *   received: true;
 * }
 * 
 * Response (Error - 400):
 * {
 *   error: string; // Error message
 * }
 * 
 * Response (Error - 429):
 * {
 *   error: string; // Rate limit exceeded
 * }
 * 
 * Security:
 * - Rate limited to prevent webhook abuse (100 requests per 15 minutes per IP)
 * - Verifies Stripe signature using webhook secret
 * - Validates payment amounts to prevent price manipulation
 * - Processes events in database transaction
 * - Logs errors for debugging
 * 
 * @example
 * // Stripe will automatically send events to this endpoint
 * // when configured in the Stripe dashboard
 */
router.post("/stripe/webhook", async (req: Request, res: Response) => {
  // Apply IP-based rate limiting for webhook security (100 requests per 15 minutes)
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
      // Use BigInt to prevent integer overflow with large numbers
      // Formula: (refundAmount / originalAmount) * originalCredits
      // Convert to cents and use BigInt for safe arithmetic
      const refundCents = Math.round(refundAmount * 100);
      const originalCents = Math.round(transaction.amountUsd! * 100);
      
      // Use BigInt for intermediate calculation to prevent overflow
      // (refundCents * credits) could exceed Number.MAX_SAFE_INTEGER
      const creditsToDeduct = Number(
        (BigInt(refundCents) * BigInt(transaction.credits)) / BigInt(originalCents)
      );

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

/**
 * POST /payments/consume-credits
 * 
 * Consumes credits from user account for usage (AI generation, etc.).
 * Uses the centralized consumeCredits service for atomic operations with idempotency support.
 * 
 * Request Body:
 * {
 *   costKey: string; // Credit cost key from CREDIT_COSTS (e.g., "STORY_GENERATION")
 *   idempotencyKey?: string; // Optional idempotency key to prevent double charging
 *   context?: string; // Additional context for the transaction (e.g., "book_creation")
 *   metadata?: object; // Optional metadata for the transaction
 * }
 * 
 * Response (Success - 200):
 * {
 *   success: true;
 *   creditsConsumed: number;
 *   remainingCredits: number;
 * }
 * 
 * Response (Error - 400):
 * {
 *   error: string; // Error message
 * }
 * 
 * Response (Error - 402):
 * {
 *   error: "Not enough credits";
 *   required: number; // Credits needed
 *   available: number; // Credits available
 * }
 * 
 * Response (Error - 409):
 * {
 *   error: "Duplicate request";
 *   message: string; // Idempotency key already used
 * }
 * 
 * Response (Error - 429):
 * {
 *   error: string; // Rate limit exceeded
 * }
 * 
 * Security:
 * - Requires authentication
 * - Uses database transaction with row lock for atomic operations
 * - Validates credit balance before consumption
 * - Creates usage transaction record
 * - Logs user activity for analytics and security monitoring
 * - Idempotency key support to prevent double charging
 * - Rate limiting: 60 requests per minute per user
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const res = await fetch('/api/payments/consume-credits', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ costKey: 'STORY_GENERATION' }),
 * });
 * const { success, remainingCredits } = await res.json();
 * 
 * // With idempotency key (recommended for retry logic)
 * const res = await fetch('/api/payments/consume-credits', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     costKey: 'STORY_GENERATION',
 *     idempotencyKey: 'user123-book456-gen1',
 *     context: 'book_creation',
 *     metadata: { bookId: 'book456' }
 *   }),
 * });
 * ```
 */
router.post("/consume-credits", requireAuth, async (req: Request, res: Response) => {
  try {
    const { costKey, idempotencyKey, context, metadata } = req.body;
    
    // Validate input
    if (!costKey || typeof costKey !== 'string') {
      return res.status(400).json({ error: "Valid costKey is required" });
    }

    // Validate metadata is object if provided
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) {
      return res.status(400).json({ error: "Metadata must be an object" });
    }

    // Validate costKey exists in CREDIT_COSTS
    const validCostKeys: CreditCostKey[] = Object.keys(
      CREDIT_COSTS
    ) as CreditCostKey[];
    
    if (!validCostKeys.includes(costKey as CreditCostKey)) {
      return res.status(400).json({ error: `Invalid costKey: ${costKey}` });
    }

    const userId = req.user!.id;

    // Rate limiting: Prevent abuse (60 requests per minute per user)
    const rateLimitResult = await checkRateLimit(`credit-consume-${userId}`, {
      maxRequests: 60,
      windowSeconds: 60,
    });
    if (!rateLimitResult.allowed) {
      return res.status(429).json({ 
        error: "Too many credit consumption attempts. Please wait before trying again." 
      });
    }

    // Idempotency check: Prevent double charging on retries
    let processingCleanup: (() => Promise<void>) | null = null;
    
    if (idempotencyKey) {
      // First, try to set processing flag to prevent race condition
      const processing = await setIdempotencyProcessing({
        key: idempotencyKey,
        prefix: 'credit-consume',
        ttl: 300,
      });
      
      if (!processing.set) {
        // Another request is already processing this idempotency key
        console.log(`[credits] 🔄 Request already processing for idempotencyKey: ${idempotencyKey}`);
        return res.status(409).json({
          error: "Request already in progress",
          message: "This request is already being processed",
        });
      }
      
      // Store cleanup function
      processingCleanup = processing.cleanup;

      // Check for existing completed result
      const idempotencyResult = await checkIdempotency<{
        success: boolean;
        creditsConsumed: number;
        remainingCredits: number;
      }>({
        key: idempotencyKey,
        prefix: 'credit-consume',
        ttl: 300,
      });
      
      if (idempotencyResult.isDuplicate && idempotencyResult.cachedResult) {
        console.log(`[credits] 🔄 Duplicate request detected with idempotencyKey: ${idempotencyKey}`);
        await processingCleanup(); // Clean up processing flag
        return res.status(409).json({
          error: "Duplicate request",
          message: "This request has already been processed",
          ...(idempotencyResult.cachedResult as Record<string, unknown>),
        });
      }
    }

    try {
      // Consume credits using the service function
      const creditResult = await consumeCredits(userId, costKey as CreditCostKey, {
        context,
        metadata
      });

      // Store idempotency result if key provided (TTL: 5 minutes)
      // This ensures idempotency even if the operation fails
      if (idempotencyKey) {
        const result = {
          success: true,
          creditsConsumed: getCreditCost(costKey as CreditCostKey),
          remainingCredits: creditResult.remainingCredits
        };
        await storeIdempotencyResult(
          { key: idempotencyKey, prefix: 'credit-consume', ttl: 300 },
          result
        );
      }

      const response = {
        success: true,
        creditsConsumed: getCreditCost(costKey as CreditCostKey),
        remainingCredits: creditResult.remainingCredits,
      };

      console.log(`[credits] 🎯 Consumed ${response.creditsConsumed} credits from user ${userId} (remaining: ${response.remainingCredits}) for action ${costKey}`);
      
      // Clean up processing flag on success
      if (processingCleanup) {
        await processingCleanup();
      }
      
      res.json(response);
    } catch (error) {
      // Check if error is insufficient credits
      if (isInsufficientCreditsError(error)) {
        // Clean up processing flag on error
        if (processingCleanup) {
          await processingCleanup();
        }
        
        await handleInsufficientCreditsError(res, costKey);
        return;
      }
      
      // Clean up processing flag on error
      if (processingCleanup) {
        await processingCleanup();
      }
      
      handleApiError(res, "Failed to consume credits", error);
    }
  } catch (error) {
    // Check if error is insufficient credits
    if (isInsufficientCreditsError(error)) {
      await handleInsufficientCreditsError(res, req.body.costKey);
      return;
    }
    
    handleApiError(res, "Failed to consume credits", error);
  }
});

/**
 * GET /payments/transactions
 * 
 * Retrieves the authenticated user's complete transaction history including:
 * - Credit purchases (from Stripe payments)
 * - Credit usage (story generation, actions)
 * - Daily check-in rewards
 * - Refunds
 * 
 * @route GET /payments/transactions
 * @description Get user's complete transaction history
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {number} [limit] - Maximum number of transactions (default: 50)
 * @query {number} [offset] - Pagination offset (default: 0)
 * @query {string} [type] - Filter by transaction type (purchase|usage|refund|reward)
 * @query {string} [startDate] - Filter transactions from date (YYYY-MM-DD)
 * @query {string} [endDate] - Filter transactions to date (YYYY-MM-DD)
 * 
 * @returns {Object} Transaction history response
 * @returns {Array} transactions - Array of transaction records
 * @returns {Object} pagination - Pagination metadata
 * @returns {Object} summary - Transaction summary statistics
 * 
 * @example
 * // Request
 * GET /payments/transactions?limit=20&type=reward
 * 
 * // Response
 * {
 *   "transactions": [
 *     {
 *       "id": "txn123",
 *       "type": "reward",
 *       "credits": 30,
 *       "amountUsd": null,
 *       "context": "daily_checkin",
 *       "metadata": {"checkInDate": "2026-05-04"},
 *       "createdAt": "2026-05-04T00:00:00.000Z"
 *     },
 *     {
 *       "id": "txn456",
 *       "type": "purchase",
 *       "credits": 150,
 *       "amountUsd": 7.99,
 *       "context": "credit_pack_purchase",
 *       "metadata": {"packId": "investigator"},
 *       "createdAt": "2026-05-03T14:30:00.000Z"
 *     }
 *   ],
 *   "pagination": {
 *     "page": 1,
 *     "limit": 20,
 *     "total": 45,
 *     "totalPages": 3,
 *     "hasNext": true,
 *     "hasPrevious": false
 *   },
 *   "summary": {
 *     "totalCreditsPurchased": 500,
 *     "totalCreditsUsed": 350,
 *     "totalCreditsRewarded": 180,
 *     "totalAmountSpent": 29.97,
 *     "currentBalance": 330
 *   }
 * }
 */
router.get("/transactions", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { 
      limit = "50", 
      offset = "0", 
      type, 
      startDate, 
      endDate 
    } = req.query;

    // Build base query conditions
    const conditions = [eq(transactions.userId, userId)];
    
    // Add type filter if provided
    if (type && ["purchase", "usage", "refund", "reward"].includes(type as string)) {
      conditions.push(eq(transactions.type, type as TransactionType));
    }
    
    // Add date filters if provided
    if (startDate) {
      conditions.push(sql`${transactions.createdAt} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${transactions.createdAt} <= ${endDate}`);
    }

    // Get total count for pagination
    const countResult = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(...conditions));
    const totalCount = countResult[0].count;

    // Get transactions with pagination
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const userTransactions = await dbRead
      .select({
        id: transactions.id,
        type: transactions.type,
        credits: transactions.credits,
        amountUsd: transactions.amountUsd,
        context: transactions.context,
        metadata: transactions.metadata,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    // Parse metadata JSON for frontend
    const formattedTransactions = userTransactions.map(tx => ({
      ...tx,
      metadata: tx.metadata ? JSON.parse(tx.metadata as string) : null,
    }));

    // Calculate summary statistics
    const summary = await dbRead
      .select({
        totalCreditsPurchased: sql<number>`SUM(CASE WHEN ${transactions.type} = 'purchase' THEN ${transactions.credits} ELSE 0 END)`,
        totalCreditsUsed: sql<number>`SUM(CASE WHEN ${transactions.type} = 'usage' THEN ABS(${transactions.credits}) ELSE 0 END)`,
        totalCreditsRewarded: sql<number>`SUM(CASE WHEN ${transactions.type} = 'reward' THEN ${transactions.credits} ELSE 0 END)`,
        totalAmountSpent: sql<number>`SUM(CASE WHEN ${transactions.type} = 'purchase' THEN ${transactions.amountUsd} ELSE 0 END)`,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .limit(1);

    // Get current user balance
    const userBalance = await dbRead
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    const transactionSummary = {
      totalCreditsPurchased: summary[0]?.totalCreditsPurchased || 0,
      totalCreditsUsed: summary[0]?.totalCreditsUsed || 0,
      totalCreditsRewarded: summary[0]?.totalCreditsRewarded || 0,
      totalAmountSpent: summary[0]?.totalAmountSpent || 0,
      currentBalance: userBalance[0]?.credits || 0,
    };

    const paginatedResponse = createPaginatedResponse(formattedTransactions, pagination, 'transactions');
    
    res.json({
      ...paginatedResponse,
      summary: transactionSummary,
    });
  } catch (error) {
    handleApiError(res, "Failed to fetch transaction history", error);
  }
});

export default router;
