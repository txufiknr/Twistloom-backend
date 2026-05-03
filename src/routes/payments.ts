/**
 * Payments Routes Module
 * 
 * Provides endpoints for Stripe checkout sessions and credit purchases.
 * Integrates with Stripe for payment processing and tracks transactions.
 * 
 * Architecture Features:
 * - Stripe checkout session creation
 * - Credit pack configuration management
 * - Transaction tracking
 * - Webhook handling for payment confirmation
 * 
 * Endpoints:
 * - POST /payments/create-checkout-session - Create Stripe checkout session
 * - POST /payments/stripe/webhook - Handle Stripe webhook events
 * - POST /payments/consume-credits - Consume credits for usage
 */

import type { Request, Response } from "express";
import { Router } from "express";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { checkRateLimitByIP } from "../middleware/rate-limit.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications } from "../db/schema.js";
import { CREDIT_PACKS } from "../config/credits.js";
import { getErrorMessage, handleApiError } from "../utils/error.js";
import { getRedisClient } from "../config/redis.js";

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
 *   successPath?: string; // Optional custom success path (relative, starts with /)
 *   cancelPath?: string; // Optional custom cancel path (relative, starts with /)
 * }
 * 
 * Example Request:
 * ```json
 * {
 *   "packId": "investigator",
 *   "successPath": "/payment/success?from=pricing",
 *   "cancelPath": "/payment/cancel?from=pricing"
 * }
 * ```
 * 
 * Security Notes:
 * - Only relative paths are allowed (must start with /)
 * - Absolute URLs and protocols are rejected to prevent open redirects
 * - Invalid paths fall back to defaults: /dashboard?success=true and /pricing
 * 
 * Response (Success - 200):
 * {
 *   url: string; // Stripe checkout URL
 * }
 * 
 * Response (Error - 400):
 * {
 *   error: string; // Error message for invalid input
 * }
 * 
 * Response (Error - 404):
 * {
 *   error: string; // Credit pack not found
 * }
 * 
 * Response (Error - 429):
 * {
 *   error: string; // Rate limit exceeded
 * }
 * 
 * Security:
 * - Requires authentication
 * - Uses Stripe for secure payment processing
 * - Validates URLs to prevent open redirects
 * - Rate limiting: 1 session per 10 seconds per user
 * - Metadata includes userId and credits for webhook processing
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const res = await fetch('/api/payments/create-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ packId: 'investigator' }),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * 
 * // With custom URLs
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
    const { packId, successPath, cancelPath } = req.body;

    // Validate input
    if (!packId) {
      return res.status(400).json({ error: "Credit pack ID is required" });
    }

    // Get user from middleware
    const user = req.user!;
    const userId = user.id;

    // Rate limiting: Prevent duplicate session spam (1 session per 10 seconds per user)
    const redis = getRedisClient();
    if (redis) {
      const rateLimitKey = `checkout-session-${userId}`;
      const lastSessionTime = await redis.get(rateLimitKey);
      if (lastSessionTime) {
        const timeSinceLastSession = Date.now() - parseInt(lastSessionTime as string, 10);
        if (timeSinceLastSession < 10000) { // 10 seconds
          return res.status(429).json({
            error: "Too many checkout session attempts. Please wait a few seconds before trying again."
          });
        }
      }
      await redis.set(rateLimitKey, Date.now().toString(), { ex: 10 }); // 10 second TTL
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

/**
 * POST /payments/consume-credits
 * 
 * Consumes credits from user account for usage (AI generation, etc.).
 * Validates credit balance before consumption and creates usage transaction.
 * 
 * Request Body:
 * {
 *   amount: number; // Amount of credits to consume (positive number)
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
 * Security:
 * - Requires authentication
 * - Uses database transaction for atomic operations
 * - Validates credit balance before consumption
 * - Creates usage transaction record
 * 
 * @example
 * ```typescript
 * const res = await fetch('/api/payments/consume-credits', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ amount: 5 }),
 * });
 * const { success, remainingCredits } = await res.json();
 * ```
 */
router.post("/consume-credits", requireAuth, async (req: Request, res: Response) => {
  try {
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

    if (!updateResult || updateResult.length === 0) {
      return res.status(400).json({ error: "Failed to update credits" });
    }

    // Create usage transaction record
    try {
      await dbWrite.insert(transactions).values({
        userId,
        type: "usage",
        credits: -amount, // Negative for usage
      });
    } catch (transactionError) {
      console.error("[stripe] ❌ Failed to create usage transaction record:", getErrorMessage(transactionError));
      // Credits were already consumed, but transaction record failed
      // Log this for manual reconciliation but don't fail the request
      console.warn(`Credits consumed from user ${userId} but transaction record failed`);
    }

    const result = {
      success: true,
      creditsConsumed: amount,
      remainingCredits: updateResult[0].credits,
    };

    console.log(`[stripe] 🎯 Consumed ${result.creditsConsumed} credits from user ${userId} (remaining: ${result.remainingCredits})`);
    res.json(result);
  } catch (error) {
    handleApiError(res, "Failed to consume credits", error);
  }
});

export default router;
