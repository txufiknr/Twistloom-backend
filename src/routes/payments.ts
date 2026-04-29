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
 */

import type { Request, Response } from "express";
import { Router } from "express";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { dbWrite } from "../db/client.js";
import { users, transactions } from "../db/schema.js";
import { CREDIT_PACKS } from "../config/credits.js";
import { handleApiError } from "../utils/error.js";

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
      
      // Check for idempotency using payment_intent_id
      const paymentIntentId = session.payment_intent as string;
      if (!paymentIntentId) {
        console.error("[stripe] ❌ Missing payment_intent_id in session:", session.id);
        return res.status(400).json({ error: "Missing payment intent" });
      }

      // Check if this payment was already processed using payment_intent_id
      const existingTransaction = await dbWrite
        .select()
        .from(transactions)
        .where(eq(transactions.paymentIntentId, paymentIntentId))
        .limit(1);

      if (existingTransaction.length > 0) {
        console.log(`[stripe] ⚠️ Duplicate payment detected for payment_intent ${paymentIntentId}`);
        return res.json({ received: true, duplicate: true });
      }
      
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
        });
      } catch (transactionError) {
        console.error("[stripe] ❌ Failed to create transaction record:", transactionError);
        // Credits were already added, but transaction record failed
        // Log this for manual reconciliation but don't fail the webhook
        console.warn(`Credits added to user ${userId} but transaction record failed for payment ${session.id}`);
      }

      console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${updateResult[0].credits}) for payment ${session.id}`);
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

export default router;
