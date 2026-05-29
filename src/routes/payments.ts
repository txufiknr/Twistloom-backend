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
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { checkRateLimitByIP } from "../middleware/rate-limit.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications, subscriptions } from "../db/schema.js";
import { CREDIT_PACKS, type CreditCostKey, CREDIT_COSTS, FIRST_PURCHASE_BONUS } from "../config/credits.js";
import type { TransactionType } from "../types/credits.js";
import { getErrorMessage, handleApiError, handleConflictError, handleNotFoundError, handleRateLimitError, handleValidationError } from "../utils/error.js";
import { checkRateLimit, checkIdempotency, storeIdempotencyResult, constructSafeUrl, setIdempotencyProcessing } from "../utils/redis.js";
import { consumeCredits, getCreditCost, awardCredits } from "../services/credits.js";
import { CREDIT_ERRORS, isInsufficientCreditsError } from "../config/errors.js";
import { createSubscription, updateSubscription, renewSubscription, cancelSubscription, hasActiveVipSubscription } from "../services/subscription.js";
import { VIP_BENEFITS, VIP_SUBSCRIPTION } from "../config/subscription.js";

/**
 * Extended Stripe Subscription interface with properties that exist in the API
 * but are missing from the TypeScript definition
 * 
 * These properties are returned by Stripe's API but not included in the TypeScript definitions,
 * so we extend the interface to include them for type safety.
 */
interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  current_period_start: number;
  current_period_end: number;
}

/**
 * Extended Stripe Invoice interface with properties that exist in the API
 * but are missing from the TypeScript definition
 * 
 * The subscription property exists in the API but is nested under parent.subscription_details
 * in the TypeScript definition, so we extend the interface for direct access.
 */
interface StripeInvoiceWithSubscription extends Stripe.Invoice {
  subscription?: string;
}

/**
 * Type guard to validate Stripe subscription object has required period properties
 * 
 * @param obj - Object to validate
 * @returns True if object is a valid subscription with period properties
 */
function isSubscriptionWithPeriods(obj: any): obj is StripeSubscriptionWithPeriods {
  return obj && 
         typeof obj.current_period_start === 'number' && 
         typeof obj.current_period_end === 'number';
}

/**
 * Type guard to validate Stripe invoice object has subscription property
 * 
 * @param obj - Object to validate
 * @returns True if object is a valid invoice with subscription property
 */
function isInvoiceWithSubscription(obj: any): obj is StripeInvoiceWithSubscription {
  return obj && typeof obj.subscription === 'string';
}

/**
 * Helper function to handle insufficient credits errors consistently
 * Optimized to reduce database load by using simple error response
 */
export function handleInsufficientCreditsError(
  res: Response,
  costKey: string,
  error?: unknown
) {
  const requiredCredits = getCreditCost(costKey as CreditCostKey);
  
  // Return simple error without additional database query
  // The frontend can fetch current balance if needed
  res.status(402).json({
    error: getErrorMessage(error, `${CREDIT_ERRORS.INSUFFICIENT_CREDITS}. Requires ${requiredCredits} credits.`),
    required: requiredCredits,
  });
}

const router = Router();

/**
 * Handles customer.subscription.created webhook event
 */
async function handleSubscriptionCreated(event: Stripe.Event) {
  const subscription = event.data.object;
  
  // Validate subscription has required properties
  if (!isSubscriptionWithPeriods(subscription)) {
    return console.error("[subscription] ❌ Invalid subscription object: missing period properties");
  }
  
  const userId = subscription.metadata?.userId;
  if (!userId) {
    return console.error("[subscription] ❌ Missing userId in subscription metadata");
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
  const subscription = event.data.object;
  
  // Validate subscription has required properties
  if (!isSubscriptionWithPeriods(subscription)) {
    return console.error("[subscription] ❌ Invalid subscription object: missing period properties");
  }

  await updateSubscription({
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
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
    canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : new Date(),
  });

  console.log(`[subscription] ❌ Canceled subscription ${subscription.id}`);
}

/**
 * Handles invoice.payment_succeeded webhook event
 */
async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object;
  
  // Validate invoice has subscription property
  if (!isInvoiceWithSubscription(invoice)) {
    return console.error("[subscription] ❌ Invalid invoice object: missing subscription property");
  }
  
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) {
    return console.error("[subscription] ❌ Missing subscriptionId in invoice");
  }

  const subscription = await dbRead
    .select({ currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (subscription.length === 0) {
    return console.error("[subscription] ❌ Subscription not found for invoice");
  }

  await renewSubscription({
    stripeSubscriptionId: subscriptionId,
    stripeInvoiceId: invoice.id,
    currentPeriodEnd: new Date(subscription[0].currentPeriodEnd),
  });

  console.log(`[subscription] 💳 Renewed subscription ${subscriptionId}`);
}

/**
 * Handles invoice.payment_failed webhook event
 */
async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object;
  
  // Validate invoice has subscription property
  if (!isInvoiceWithSubscription(invoice)) {
    return console.error("[subscription] ❌ Invalid invoice object: missing subscription property");
  }
  
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  // Fetch subscription to get correct period end
  const subscription = await dbRead
    .select({ currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (subscription.length === 0) {
    return console.error("[subscription] ❌ Subscription not found for invoice payment failed");
  }

  // Update subscription status to past_due
  await updateSubscription({
    stripeSubscriptionId: subscriptionId,
    status: 'past_due',
    currentPeriodEnd: new Date(subscription[0].currentPeriodEnd),
  });

  console.log(`[subscription] ❌ Payment failed for subscription ${subscriptionId}`);
}

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
      badge: pack.badge,
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
    if (!packId) return handleValidationError(res, "Credit pack ID is required");

    // Get user from middleware
    const user = req.user!;
    const { id: userId, email } = user;

    // Rate limiting: Prevent duplicate session spam (1 session per 10 seconds per user)
    const rateLimitResult = await checkRateLimit(`checkout-session-${userId}`, {
      maxRequests: 1,
      windowSeconds: 10,
    });
    if (!rateLimitResult.allowed) {
      return handleRateLimitError(res, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    // Validate and construct URLs (security: prevent open redirects)
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return handleApiError(res, "Frontend URL not configured");
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
      return handleNotFoundError(res, "Credit pack not found");
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Create Stripe checkout session with idempotency key
    // Prevents duplicate sessions from network retries or double-clicks
    const idempotencyKey = `checkout-${userId}-${packId}-${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email,
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
 * POST /payments/create-subscription-checkout
 * 
 * Creates a Stripe checkout session for VIP subscription.
 * 
 * Request Body:
 * {
 *   returnUrl?: string; // Optional current page URL for refresh-less UX
 *   successPath?: string; // Optional custom success path (default: "/dashboard?subscription=success")
 *   cancelPath?: string; // Optional custom cancel path (default: "/pricing")
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
 * - Checks for existing active subscription before creating new one
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const res = await fetch('/api/payments/create-subscription-checkout', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({}),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * 
 * // With custom return URL
 * const currentUrl = window.location.href;
 * const res = await fetch('/api/payments/create-subscription-checkout', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ returnUrl: currentUrl }),
 * });
 * ```
 * 
 * @future-enhancements
 * - Add subscription cancellation endpoint for immediate cancellation
 * - Add subscription update payment method endpoint
 * - Implement subscription pause/resume functionality
 * - Add subscription upgrade/downgrade endpoint for plan changes
 * - Add proration preview for plan changes
 */
router.post("/create-subscription-checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    const { successPath, cancelPath, returnUrl } = req.body;

    // Get user from middleware
    const user = req.user!;
    const userId = user.id;

    // Check if user already has active subscription
    const hasActiveSub = await hasActiveVipSubscription(userId);
    if (hasActiveSub) {
      return handleValidationError(res, "You already have an active VIP subscription");
    }

    // Rate limiting: Prevent duplicate session spam (1 session per 10 seconds per user)
    const rateLimitResult = await checkRateLimit(`subscription-checkout-${userId}`, {
      maxRequests: 1,
      windowSeconds: 10,
    });
    if (!rateLimitResult.allowed) {
      return handleRateLimitError(res, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    // Validate and construct URLs (security: prevent open redirects)
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return handleApiError(res, "Frontend URL not configured");
    }

    // For refresh-less UX: use returnUrl to return user to same page
    let successUrl: string;
    let cancelUrl: string;

    if (returnUrl) {
      const baseUrlObj = new URL(returnUrl, baseUrl);
      baseUrlObj.searchParams.set('subscription', 'success');
      successUrl = baseUrlObj.toString();
      
      const cancelUrlObj = new URL(returnUrl, baseUrl);
      cancelUrlObj.searchParams.set('subscription', 'cancel');
      cancelUrl = cancelUrlObj.toString();
    } else {
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Validate VIP subscription configuration
    if (!VIP_SUBSCRIPTION.priceId) {
      return handleApiError(res, "VIP subscription not configured");
    }

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId },
      });
      customerId = customer.id;
      
      // Update user with Stripe customer ID
      await dbWrite.update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.userId, userId));
    }

    // Create Stripe checkout session with idempotency key
    const idempotencyKey = `subscription-checkout-${userId}-${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: VIP_SUBSCRIPTION.priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId,
        subscriptionType: 'vip',
      },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: {
          userId,
        },
      },
    }, {
      idempotencyKey,
    });

    res.json({ url: session.url });
  } catch (error) {
    handleApiError(res, "Failed to create subscription checkout session", error);
  }
});

/**
 * GET /payments/subscription
 * 
 * Returns the user's VIP subscription status and details.
 * 
 * Response (Success - 200):
 * {
 *   hasActiveSubscription: boolean;
 *   subscription?: {
 *     id: string;
 *     status: string;
 *     currentPeriodStart: string;
 *     currentPeriodEnd: string;
 *     cancelAtPeriodEnd: boolean;
 *   };
 *   vipExpiresAt?: string;
 * }
 * 
 * Security:
 * - Requires authentication
 * 
 * @example
 * ```typescript
 * const res = await fetch('/api/payments/subscription');
 * const data = await res.json();
 * if (data.hasActiveSubscription) {
 *   console.log('VIP expires:', data.vipExpiresAt);
 * }
 * ```
 * 
 * @future-enhancements
 * - Add subscription history endpoint to show past subscriptions
 * - Add proration preview for plan changes
 * - Add usage analytics for subscription benefits
 */
router.get("/subscription", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.json({ hasActiveSubscription: false });
    }

    // Check if user has active VIP subscription
    const hasActiveSub = await hasActiveVipSubscription(userId);
    if (!hasActiveSub) {
      return res.json({ hasActiveSubscription: false });
    }

    // Get subscription details
    const subscription = await dbRead
      .select({
        id: subscriptions.id,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        status: subscriptions.status,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        vipExpiresAt: users.vipExpiresAt,
      })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.userId))
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (subscription.length === 0) {
      return res.json({ hasActiveSubscription: false });
    }

    const sub = subscription[0];
    res.json({
      hasActiveSubscription: true,
      subscription: {
        id: sub.id,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      },
      vipExpiresAt: sub.vipExpiresAt?.toISOString(),
    });
  } catch (error) {
    handleApiError(res, "Failed to fetch subscription details", error);
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
    return handleRateLimitError(res, 'Too many webhook requests from this IP');
  }
  
  // Track webhook delivery
  let webhookDeliveryId: string | null = null;
  
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return handleValidationError(res, "Missing Stripe signature");

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return handleApiError(res, "Webhook secret not configured");
    }

    // Initialize Stripe
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Verify webhook signature
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      webhookSecret
    );
    
    // Create webhook delivery tracking record
    const [deliveryRecord] = await dbWrite.insert(webhookDeliveries).values({
      eventId: event.id,
      eventType: event.type,
      status: 'retrying',
    }).returning();

    webhookDeliveryId = deliveryRecord.id;

    // Handle different event types
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Check for idempotency using Stripe event.id (best practice)
      const stripeEventId = event.id;
      const paymentIntentId = session.payment_intent as string;
      
      if (!paymentIntentId) {
        console.error("[stripe] ❌ Missing payment_intent_id in session:", session.id);
        return handleValidationError(res, "Missing payment intent");
      }

      // Extract metadata
      const userId = session.metadata?.userId;
      const credits = session.metadata?.credits;
      const packId = session.metadata?.packId;
      
      if (!userId || !credits || !packId) {
        console.error("[stripe] ❌ Missing metadata in checkout session:", session.id);
        return handleValidationError(res, "Invalid session metadata");
      }

      const creditsAmount = Number(credits);
      const amountUsd = session.amount_total ? session.amount_total / 100 : undefined;

      // Validate payment amount matches expected credit pack price (security check)
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      if (!pack) {
        console.error("[stripe] ❌ Invalid pack ID in session metadata:", packId);
        return handleValidationError(res, "Invalid credit pack");
      }

      const expectedAmount = Math.round(pack.priceUSD * 100); // Convert to cents
      const actualAmount = session.amount_total;

      if (actualAmount !== expectedAmount) {
        console.error(`[stripe] 🚨 AMOUNT MISMATCH for session ${session.id}: expected ${expectedAmount}, got ${actualAmount} for pack ${packId}`);
        return handleValidationError(res, "Amount validation failed");
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

        // Determine whether this is the user's first purchase
        const priorPurchase = await tx
          .select()
          .from(transactions)
          .where(and(eq(transactions.userId, userId), eq(transactions.type, 'purchase')))
          .limit(1);
        const isFirstPurchase = priorPurchase.length === 0;

        // Award credits using the helper function (includes transaction record and notification)
        const newBalance = await awardCredits(userId, creditsAmount, {
          type: "purchase",
          notificationType: "payment_success",
          notificationTitle: "Payment Successful",
          notificationMessage: `Your purchase of ${creditsAmount} credits (${pack.title}) was successful`,
          notificationData: {
            amount: amountUsd,
            paymentIntentId,
            packId,
          },
          metadata: {
            paymentIntentId,
            stripeEventId,
            amountUsd,
            packId
          },
          tx
        });

        console.log(`[stripe] 💰 Added ${creditsAmount} credits to user ${userId} (new balance: ${newBalance}) for payment ${session.id}`);

        // Award first-purchase bonus if applicable
        if (isFirstPurchase && FIRST_PURCHASE_BONUS > 0) {
          try {
            await awardCredits(userId, FIRST_PURCHASE_BONUS, {
              type: 'reward',
              notificationType: 'first_purchase_bonus',
              notificationTitle: 'First Purchase Bonus',
              notificationMessage: `You received ${FIRST_PURCHASE_BONUS} credits for your first purchase`,
              notificationData: { amount: amountUsd, packId, paymentIntentId },
              metadata: { stripeEventId, paymentIntentId, packId },
              tx
            });
            console.log(`[stripe] 🎁 Awarded first-purchase bonus (${FIRST_PURCHASE_BONUS} credits) to user ${userId}`);
          } catch (err) {
            console.error(`[stripe] ❌ Failed to award first-purchase bonus to user ${userId}:`, err);
            // Do not re-throw — we still want webhook to succeed; bonus can be retried separately if needed
          }
        }

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
      const amountUsd = paymentIntent.amount ? paymentIntent.amount / 100 : undefined;
      console.log(`[stripe] ✅ Payment intent succeeded: ${paymentIntent.id} (amount: ${amountUsd} USD)`);
      
      // Note: Credits are added via checkout.session.completed event
      // This event is logged for monitoring and analytics purposes
    } else if (event.type === "payment_intent.payment_failed") {
      // Log payment intent failure for monitoring
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const amountUsd = paymentIntent.amount ? paymentIntent.amount / 100 : undefined;
      const lastPaymentError = paymentIntent.last_payment_error;
      
      console.error(`[stripe] ❌ Payment intent failed:`, {
        id: paymentIntent.id,
        amountUsd,
        lastPaymentError,
      });
      
      // Note: No action needed - user will see error in Stripe checkout
      // This event is logged for monitoring and debugging
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = charge.payment_intent as string;
      
      if (!paymentIntentId) {
        console.error('[stripe] ❌ Missing payment_intent_id in charge:', charge.id);
        return handleValidationError(res, 'Missing payment intent');
      }
      
      // Find the original transaction
      const originalTransaction = await dbRead
        .select()
        .from(transactions)
        .where(eq(transactions.paymentIntentId, paymentIntentId))
        .limit(1);
      
      if (!originalTransaction.length) {
        console.error('[stripe] ❌ Original transaction not found for refund:', paymentIntentId);
        return handleNotFoundError(res, 'Original transaction not found');
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
    } else if (event.type === "customer.subscription.created") {
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
 * Enhancement opportunity:
 * - Using the same idempotent refund pattern (as with `executeWithCredits` and `refundCredits` functions) if needed
 * - Consistent error handling
 * - But it should remain a simple credit consumption endpoint
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
      return handleValidationError(res, "Valid costKey is required");
    }

    // Validate metadata is object if provided
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) {
      return handleValidationError(res, "Metadata must be an object");
    }

    // Validate costKey exists in CREDIT_COSTS
    const validCostKeys: CreditCostKey[] = Object.keys(
      CREDIT_COSTS
    ) as CreditCostKey[];
    
    if (!validCostKeys.includes(costKey as CreditCostKey)) {
      return handleValidationError(res, `Invalid costKey: ${costKey}`);
    }

    const userId = req.user!.id;

    // Rate limiting: Prevent abuse (60 requests per minute per user)
    const rateLimitResult = await checkRateLimit(`credit-consume-${userId}`, {
      maxRequests: 60,
      windowSeconds: 60,
    });
    if (!rateLimitResult.allowed) {
      return handleRateLimitError(res, "Too many credit consumption attempts. Please wait before trying again.");
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
        return handleConflictError(res, "Request already in progress");
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
        
        return handleInsufficientCreditsError(res, costKey);
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
      return handleInsufficientCreditsError(res, req.body.costKey);
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
    const transactionTypes: TransactionType[] = ["purchase", "usage", "refund", "reward"];
    if (type && transactionTypes.includes(type as TransactionType)) {
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
  try {
    const plan = {
      ...VIP_SUBSCRIPTION,
      benefits: ["VIP badge", "2x check-in bonus", "+50 monthly credits"],
    };
    res.json({ plans: [plan] });
  } catch (error) {
    handleApiError(res, "Failed to fetch subscription plans", error);
  }
});

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
  try {
    const { planId, successUrl, cancelUrl } = req.body;
    const userId = req.user!.id;

    // Validate plan
    if (planId !== VIP_SUBSCRIPTION.id) {
      return handleNotFoundError(res, "Subscription plan not found");
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
      return handleConflictError(res, "User already has an active subscription");
    }

    // Create or retrieve Stripe customer
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    
    // Get user from database to check for existing stripeCustomerId
    const userRecord = await dbRead
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    
    let customerId = userRecord[0]?.stripeCustomerId;

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
  } catch (error) {
    handleApiError(res, "Failed to create subscription session", error);
  }
});

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
router.get("/subscription", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    
    // Return null response for unauthenticated users (handles auth timing race conditions)
    if (!userId) {
      return res.json({ subscription: null });
    }

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
  } catch (error) {
    handleApiError(res, "Failed to fetch subscription status", error);
  }
});

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
  try {
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
      return handleNotFoundError(res, "No active subscription found");
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
  } catch (error) {
    handleApiError(res, "Failed to cancel subscription", error);
  }
});

/**
 * GET /payments/subscription/portal
 * 
 * Creates a Stripe Customer Portal session for subscription management.
 * 
 * Response (200 OK):
 * {
 *   url: string; // Stripe Customer Portal URL
 * }
 * 
 * @future-enhancements
 * - Configure portal features to limit user actions
 * - Add subscription update endpoint for programmatic changes
 * - Add webhook retry logic for failed deliveries
 * - Use Stripe's expand parameter to reduce API calls
 */
router.get("/subscription/portal", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const returnUrl = req.query.returnUrl as string || `${process.env.FRONTEND_URL}/dashboard`;

    const subscription = await dbRead
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    if (subscription.length === 0 || !subscription[0].stripeCustomerId) {
      return handleNotFoundError(res, "No subscription found");
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription[0].stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    handleApiError(res, "Failed to create portal session", error);
  }
});

export default router;
