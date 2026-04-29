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
import { dbWrite } from "../db/client.js";
import { users, transactions, processedEvents } from "../db/schema.js";
import { CREDIT_PACKS } from "../config/credits.js";
import { getErrorMessage, handleApiError } from "../utils/error.js";

const router = Router();

/**
 * POST /payments/create-checkout-session
 * 
 * Creates a Stripe checkout session for purchasing credit packs.
 * 
 * Request Body:
 * {
 *   packId: string; // Credit pack ID (e.g., "observer", "investigator", "mastermind")
 * }
 * 
 * Response (Success - 200):
 * {
 *   url: string; // Stripe checkout URL
 * }
 * 
 * Response (Error - 400):
 * {
 *   error: string; // Error message
 * }
 * 
 * Response (Error - 404):
 * {
 *   error: string; // Credit pack not found
 * }
 * 
 * Security:
 * - Requires authentication
 * - Uses Stripe for secure payment processing
 * - Metadata includes userId and credits for webhook processing
 * 
 * @example
 * ```typescript
 * const res = await fetch('/api/payments/create-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ packId: 'investigator' }),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * ```
 */
router.post("/create-checkout-session", requireAuth, async (req: Request, res: Response) => {
  try {
    const { packId } = req.body;

    // Validate input
    if (!packId) {
      return res.status(400).json({ error: "Credit pack ID is required" });
    }

    // Find the credit pack
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      return res.status(404).json({ error: "Credit pack not found" });
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Get user from middleware
    const user = req.user!;
    const userId = user.id;

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
 * Security:
 * - Verifies Stripe signature using webhook secret
 * - Processes events in database transaction
 * - Logs errors for debugging
 * 
 * @example
 * // Stripe will automatically send events to this endpoint
 * // when configured in the Stripe dashboard
 */
router.post("/stripe/webhook", async (req: Request, res: Response) => {
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

    // Handle checkout session completed events
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Check for idempotency using Stripe event.id (best practice)
      const stripeEventId = event.id;
      const paymentIntentId = session.payment_intent as string;
      
      if (!paymentIntentId) {
        console.error("[stripe] ❌ Missing payment_intent_id in session:", session.id);
        return res.status(400).json({ error: "Missing payment intent" });
      }

      // Step A: Try to insert event ID into processed_events table
      try {
        await dbWrite.insert(processedEvents).values({
          eventId: stripeEventId,
        });
      } catch (insertError) {
        // If insert fails due to unique constraint, event was already processed
        console.log(`[stripe] 🔄 Duplicate webhook event detected: ${stripeEventId}`);
        return res.json({ received: true, duplicate: true });
      }

      // Step B: Event not processed before, proceed with payment processing
      
      // Extract metadata
      const userId = session.metadata?.userId;
      const credits = session.metadata?.credits;
      
      if (!userId || !credits) {
        console.error("[stripe] ❌ Missing metadata in checkout session:", session.id);
        return res.status(400).json({ error: "Invalid session metadata" });
      }

      const creditsAmount = Number(credits);
      const amountUsd = session.amount_total ? session.amount_total / 100 : undefined;

      // Update user credits first
      const updateResult = await dbWrite
        .update(users)
        .set({ 
          credits: sql`${users.credits} + ${creditsAmount}` 
        })
        .where(eq(users.userId, userId))
        .returning({ credits: users.credits });

      if (!updateResult || updateResult.length === 0) {
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
        // Log this for manual reconciliation but don't fail webhook
        console.warn(`[stripe] ⚠️ Transaction record failed for payment ${session.id}`);
        return res.json({ received: true });
      }

      // Update user credits
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

      console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${creditUpdateResult[0].credits}) for payment ${session.id}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error("[stripe] ❌ Webhook error:", error);
    
    // Return 400 for signature verification errors, 500 for others
    const isSignatureError = error instanceof Error && 
      (error.message.includes("signature") || error.message.includes("webhook"));
    
    const statusCode = isSignatureError ? 400 : 500;
    const message = isSignatureError ? "Invalid webhook signature" : "Webhook processing failed";
    
    return res.status(statusCode).json({ error: message });
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
      console.error("[stripe] ❌ Failed to create usage transaction record:", transactionError);
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
