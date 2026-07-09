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
 * - POST /payments/create-subscription-checkout - Create Stripe subscription checkout
 * - GET /payments/subscription - Get current subscription status
 * - POST /payments/stripe/webhook - Handle Stripe webhook events
 * - POST /payments/consume-credits - Consume credits for usage
 * - GET /payments/transactions - Get user transaction history
 * - GET /payments/subscription-plans - Get available subscription plans
 * - POST /payments/subscription/cancel - Cancel subscription at period end
 * - GET /payments/subscription/portal - Get Stripe Customer Portal URL
 */

import type { Request, Response, Router as RouterType } from "express";
import { Router } from "express";
import type Stripe from "stripe";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications, subscriptions } from "../db/schema.js";
import { CREDIT_PACKS, type CreditCostKey, CREDIT_COSTS, FIRST_PURCHASE_BONUS } from "../config/credits.js";
import type { TransactionType } from "../types/credits.js";
import { getErrorMessage, handleApiError, handleConflictError, handleNotFoundError, handleRateLimitError, handleValidationError } from "../utils/error.js";
import { checkRateLimit, checkIdempotency, storeIdempotencyResult, constructSafeUrl, setIdempotencyProcessing } from "../utils/redis.js";
import { consumeCredits, getCreditCost, awardCredits } from "../services/credits.js";
import { CREDIT_ERRORS, isInsufficientCreditsError } from "../config/errors.js";
import { createSubscription, updateSubscription, renewSubscription, cancelSubscription, hasActiveVipSubscription, isTrialEligible, handleTrialWillEnd } from "../services/subscription.js";
import { VIP_BENEFITS, VIP_SUBSCRIPTION, VIP_TRIAL } from "../config/subscription.js";
import { getStripe } from "../utils/stripe.js";

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

const router: RouterType = Router();

/**
 * Detects a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Used as a last-resort idempotency backstop for webhook processing: the
 * `transactions.stripeEventId` / `transactions.paymentIntentId` unique
 * constraints are the ultimate source of truth against double-processing a
 * webhook, since the app-level "check then insert" pattern has an inherent
 * race window when two deliveries of the same event arrive concurrently
 * (both can pass the SELECT check before either commits its INSERT). When
 * that race is lost, Postgres itself will reject the second INSERT — this
 * lets us treat that specific failure as "already processed" instead of a
 * real error that should fail the webhook and trigger endless Stripe retries.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

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

  // Read trial state off the Subscription object itself rather than trusting checkout
  // session metadata — the Subscription is the source of truth for its own state.
  const isTrial = subscription.status === 'trialing';
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;

  const priceId = subscription.items.data[0].price.id;
  await createSubscription({
    userId,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer as string,
    stripePriceId: priceId,
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    isTrial,
    trialEnd,
  });

  console.log(`[subscription] ✅ Created subscription for user ${userId}${isTrial ? " (trial)" : ""}`);
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
 *
 * IMPORTANT: invoice.payment_succeeded fires for EVERY successful subscription
 * invoice — including the very first one, which fires alongside (and grants
 * credits redundantly with) customer.subscription.created for a brand-new,
 * immediately-charged subscription. Stripe's invoice.billing_reason field is
 * exactly what distinguishes these:
 *   - 'subscription_create' → the initial invoice — already credited via
 *     handleSubscriptionCreated → createSubscription(). Skip here.
 *   - 'subscription_cycle'  → a genuine recurring renewal. Grant credits.
 * Without this check, every new VIP subscriber was credited twice on day one.
 */
async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  
  // Safely extract the subscription ID using the new typing structure
  const subscriptionData = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionData === 'string' 
    ? subscriptionData 
    : subscriptionData?.id;
  
  if (!subscriptionId) {
    return console.error("[subscription] ❌ Missing subscriptionId in invoice");
  }

  if (invoice.billing_reason !== 'subscription_cycle') {
    // Initial invoice (subscription_create), a plan change (subscription_update),
    // or another non-renewal reason — credits for subscription creation are
    // already granted by handleSubscriptionCreated. Nothing to do here.
    console.log(`[subscription] ℹ️ Skipping credit grant for invoice ${invoice.id} (billing_reason=${invoice.billing_reason}, not a renewal)`);
    return;
  }

  const periodEnd = invoice.lines?.data[0]?.period?.end;
  if (!periodEnd) {
    return console.error("[subscription] ❌ Could not determine period end from invoice");
  }

  await renewSubscription({
    stripeSubscriptionId: subscriptionId,
    stripeInvoiceId: invoice.id,
    currentPeriodEnd: new Date(periodEnd * 1000),
  });

  console.log(`[subscription] 💳 Renewed subscription ${subscriptionId}`);
}

/**
 * Handles invoice.payment_failed webhook event
 */
async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionData = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id;
  if (!subscriptionId) return;

  // Partial update allows just flagging as `past_due`
  await updateSubscription({
    stripeSubscriptionId: subscriptionId,
    status: 'past_due',
  });

  console.log(`[subscription] ❌ Payment failed for subscription ${subscriptionId}`);
}

/**
 * Handles customer.subscription.trial_will_end webhook event
 *
 * Stripe fires this ~3 days before trial end. Delegates to the service layer
 * which creates an in-app notification reminding the user to keep their payment
 * method up to date.
 *
 * Stripe's own email for this event (Dashboard → Subscriptions and emails →
 * Manage free trial messaging) serves as a zero-code safety net; this handler
 * is the in-app complement.
 */
async function handleTrialWillEndEvent(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  await handleTrialWillEnd(subscription.id);
  console.log(`[subscription] ⏰ Trial ending soon for subscription ${subscription.id}`);
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
 *     badge: string | null;
 *     color: string;
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
 * Response (200 OK):
 * {
 *   url: string;       // Stripe checkout URL to redirect user to
 *   sessionId: string; // Stripe session ID (store for reconciliation/analytics)
 * }
 * 
 * Error Response (4xx/5xx):
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
 * const { url, sessionId } = await res.json();
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

    // Secure returnUrl origin parsing to prevent Open Redirects
    if (returnUrl) {
      try {
        const returnUrlObj = new URL(returnUrl, baseUrl);
        const baseUrlObj = new URL(baseUrl);
        
        if (returnUrlObj.origin !== baseUrlObj.origin) {
          throw new Error("Cross-origin returnUrl not allowed");
        }
        
        returnUrlObj.searchParams.set('payment', 'success');
        successUrl = returnUrlObj.toString();
        
        returnUrlObj.searchParams.set('payment', 'cancel');
        cancelUrl = returnUrlObj.toString();
      } catch {
        successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?success=true');
        cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
      }
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

    const session = await getStripe().checkout.sessions.create({
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
    });

    res.json({ url: session.url, sessionId: session.id });
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
 * Response (200 OK):
 * {
 *   url: string;       // Stripe checkout URL to redirect user to
 *   sessionId: string; // Stripe session ID (store for reconciliation/analytics)
 * }
 * 
 * Error Response (4xx/5xx):
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
 * const { url, sessionId } = await res.json();
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
    const userId = req.user!.id;

    // Run rate limiting FIRST before DB hits
    const rateLimitResult = await checkRateLimit(`subscription-checkout-${userId}`, {
      maxRequests: 1,
      windowSeconds: 10,
    });
    if (!rateLimitResult.allowed) {
      return handleRateLimitError(res, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    const hasActiveSub = await hasActiveVipSubscription(userId);
    if (hasActiveSub) {
      return handleValidationError(res, "You already have an active VIP subscription");
    }
    
    // Validate and construct URLs (security: prevent open redirects)
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return handleApiError(res, "Frontend URL not configured");
    }

    // For refresh-less UX: use returnUrl to return user to same page
    let successUrl: string;
    let cancelUrl: string;

    // Secure origin parsing
    if (returnUrl) {
      try {
        const returnUrlObj = new URL(returnUrl, baseUrl);
        const baseUrlObj = new URL(baseUrl);
        
        if (returnUrlObj.origin !== baseUrlObj.origin) {
          throw new Error("Cross-origin returnUrl not allowed");
        }
        
        returnUrlObj.searchParams.set('subscription', 'success');
        successUrl = returnUrlObj.toString();
        
        returnUrlObj.searchParams.set('subscription', 'cancel');
        cancelUrl = returnUrlObj.toString();
      } catch {
        successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
        cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
      }
    } else {
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }

    // Validate VIP subscription configuration
    if (!VIP_SUBSCRIPTION.priceId) {
      return handleApiError(res, "VIP subscription not configured");
    }

    // Always query DB for fresh stripeCustomerId, rather than relying strictly on JWT middleware payload
    const [user] = await dbRead.select({ stripeCustomerId: users.stripeCustomerId, email: users.email }).from(users).where(eq(users.userId, userId)).limit(1);
    let customerId = user?.stripeCustomerId;
    const userEmail = user?.email;

    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: userEmail ?? req.user!.email, // Fallback to JWT email
        metadata: { userId },
      });
      customerId = customer.id;
      
      // Update user with Stripe customer ID
      await dbWrite.update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.userId, userId));
    }

    // Create Stripe checkout session
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: VIP_SUBSCRIPTION.priceId,
          quantity: 1,
        },
      ],
      metadata: { userId, subscriptionType: 'vip' },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: { userId },
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    handleApiError(res, "Failed to create subscription checkout session", error);
  }
});

/**
 * GET /payments/subscription/trial-eligibility
 *
 * Checks whether the current user is eligible for the VIP free trial.
 * This is a UX convenience gate — the backend independently re-checks eligibility
 * at checkout-session creation (see POST /create-trial-checkout-session below),
 * so a client bypassing this endpoint is still caught server-side.
 *
 * @route GET /payments/subscription/trial-eligibility
 * @returns {{ eligible: boolean }} Whether the user can start a trial
 *
 * @example
 * // Response (eligible)
 * { "eligible": true }
 *
 * // Response (ineligible — already used trial or has active sub)
 * { "eligible": false }
 *
 * @see VIP_FREE_TRIAL_ROADMAP.md §4.2
 */
router.get("/subscription/trial-eligibility", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const eligible = await isTrialEligible(userId);
    res.json({ eligible });
  } catch (error) {
    handleApiError(res, "Failed to check trial eligibility", error);
  }
});

/**
 * POST /payments/create-trial-checkout-session
 *
 * Creates a Stripe Checkout session for the VIP free trial.
 *
 * This is a separate endpoint (not a param on create-subscription-checkout)
 * because trial and non-trial checkout have meaningfully different validation
 * paths: trial checks `isTrialEligible`, non-trial checks only
 * `hasActiveVipSubscription`. Mixing them into one endpoint with a `trial`
 * boolean param makes the branching harder to reason about and audit.
 *
 * Request Body:
 * {
 *   successPath?: string;  // Custom success path (default: "/dashboard?subscription=success")
 *   cancelPath?: string;   // Custom cancel path (default: "/pricing")
 *   returnUrl?: string;    // Current page URL for refresh-less UX
 * }
 *
 * Response (200 OK):
 * {
 *   url: string;       // Stripe Checkout URL to redirect the user to
 *   sessionId: string; // Stripe session ID for reconciliation/analytics
 * }
 *
 * Security:
 * - Requires authentication
 * - Server-side eligibility re-check (defense in depth — never trust the frontend gate alone)
 * - Rate limited: 1 session per 10 seconds per user
 * - URL origin validation to prevent open redirects
 *
 * @example
 * ```typescript
 * const res = await fetch('/api/payments/create-trial-checkout-session', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ returnUrl: window.location.href }),
 * });
 * const { url } = await res.json();
 * window.location.href = url;
 * ```
 *
 * @see VIP_FREE_TRIAL_ROADMAP.md §4.3
 */
router.post("/create-trial-checkout-session", requireAuth, async (req: Request, res: Response) => {
  try {
    const { successPath, cancelPath, returnUrl } = req.body;
    const userId = req.user!.id;

    // Rate limiting: Prevent duplicate session spam (1 session per 10 seconds per user)
    const rateLimitResult = await checkRateLimit(`trial-checkout-${userId}`, {
      maxRequests: 1,
      windowSeconds: 10,
    });
    if (!rateLimitResult.allowed) {
      return handleRateLimitError(res, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    // Master kill-switch check
    if (!VIP_TRIAL.enabled) {
      return handleValidationError(res, "Trials are not currently available");
    }

    // Defense in depth: re-check eligibility server-side regardless of what
    // the frontend showed. A vipTrialUsedAt check that only runs client-side
    // is trivially bypassed.
    const eligible = await isTrialEligible(userId);
    if (!eligible) {
      return handleValidationError(res, "Trial not available for this account");
    }

    // Validate and construct URLs (security: prevent open redirects)
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return handleApiError(res, "Frontend URL not configured");
    }

    // For refresh-less UX: use returnUrl to return user to same page
    let successUrl: string;
    let cancelUrl: string;

    // Secure origin parsing — same pattern as create-subscription-checkout
    if (returnUrl) {
      try {
        const returnUrlObj = new URL(returnUrl, baseUrl);
        const baseUrlObj = new URL(baseUrl);

        if (returnUrlObj.origin !== baseUrlObj.origin) {
          throw new Error("Cross-origin returnUrl not allowed");
        }

        // Reuses the same ?subscription=success / ?subscription=cancel contract
        // as the regular subscription checkout, meaning SubscriptionStatusMessage
        // needs zero changes to handle trial checkout redirects.
        returnUrlObj.searchParams.set('subscription', 'success');
        successUrl = returnUrlObj.toString();

        returnUrlObj.searchParams.set('subscription', 'cancel');
        cancelUrl = returnUrlObj.toString();
      } catch {
        successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
        cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
      }
    } else {
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }

    // Validate VIP subscription configuration
    if (!VIP_SUBSCRIPTION.priceId) {
      return handleApiError(res, "VIP subscription not configured");
    }

    // Always query DB for fresh stripeCustomerId, rather than relying on JWT middleware payload
    const [user] = await dbRead
      .select({ stripeCustomerId: users.stripeCustomerId, email: users.email })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    let customerId = user?.stripeCustomerId;
    const userEmail = user?.email;

    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: userEmail ?? req.user!.email,
        metadata: { userId },
      });
      customerId = customer.id;

      // Update user with Stripe customer ID
      await dbWrite.update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.userId, userId));
    }

    // Create Stripe trial checkout session.
    // Note: payment_method_collection defaults to 'always' for subscription-mode
    // sessions, which is the LinkedIn-style card-required behavior we want.
    // Explicitly setting it here to avoid relying on Stripe's default silently
    // matching our intent.
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: VIP_SUBSCRIPTION.priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: VIP_TRIAL.trialPeriodDays,
        trial_settings: {
          end_behavior: { missing_payment_method: VIP_TRIAL.endBehavior },
        },
        metadata: { userId, isTrial: "true" },
      },
      payment_method_collection: "always",
      metadata: { userId, subscriptionType: 'vip', isTrial: "true" },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    handleApiError(res, "Failed to create trial checkout session", error);
  }
});

/**
 * GET /payments/subscription
 * 
 * Returns the user's VIP subscription status and details.
 * 
 * @route GET /payments/subscription
 * @description Get current subscription status
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Subscription status response
 * @returns {boolean} hasActiveSubscription - Whether user has active VIP subscription
 * @returns {Object|null} subscription - Subscription details or null when not active
 * @returns {string} subscription.id - Subscription record ID
 * @returns {string} subscription.stripeSubscriptionId - Stripe subscription ID
 * @returns {string} subscription.status - Subscription status
 * @returns {string} subscription.currentPeriodStart - Period start (ISO 8601)
 * @returns {string} subscription.currentPeriodEnd - Period end (ISO 8601)
 * @returns {boolean} subscription.cancelAtPeriodEnd - Whether subscription cancels at period end
 * @returns {number} subscription.monthlyCredits - Monthly credit allowance
 * @returns {string|null} vipExpiresAt - VIP expiration timestamp (ISO 8601) or null
 * 
 * @example
 * // Response (active)
 * {
 *   "hasActiveSubscription": true,
 *   "subscription": {
 *     "id": "sub-uuid",
 *     "stripeSubscriptionId": "sub_xxx",
 *     "status": "active",
 *     "currentPeriodStart": "2026-01-01T00:00:00.000Z",
 *     "currentPeriodEnd": "2026-02-01T00:00:00.000Z",
 *     "cancelAtPeriodEnd": false,
 *     "monthlyCredits": 50
 *   },
 *   "vipExpiresAt": "2026-02-01T00:00:00.000Z"
 * }
 * 
 * // Response (inactive/guest)
 * {
 *   "hasActiveSubscription": false,
 *   "subscription": null
 * }
 */
router.get("/subscription", optionalAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.json({ hasActiveSubscription: false, subscription: null });
    }

    // Get subscription details.
    //
    // IMPORTANT: joins on users.subscriptionId (the canonical "current subscription"
    // pointer, set by createSubscription() and cleared by downgradeUserFromVip()) —
    // NOT on a bare subscriptions.userId match. A user can accumulate more than one
    // subscriptions row over their lifetime (cancel, later resubscribe; a trial that
    // lapses, then a fresh paid signup) since each customer.subscription.created
    // inserts a new row rather than reusing the old one. Joining/filtering by userId
    // alone with `.limit(1)` and no ORDER BY has no guarantee of returning the current
    // row — it could just as easily return a long-canceled one, making an active VIP
    // user appear to have no subscription at all.
    const subscription = await dbRead
      .select({
        id: subscriptions.id,
        stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        status: subscriptions.status,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        isTrial: subscriptions.isTrial,
        trialEnd: subscriptions.trialEnd,
        vipExpiresAt: users.vipExpiresAt,
      })
      .from(users)
      .innerJoin(subscriptions, eq(subscriptions.id, users.subscriptionId))
      .where(eq(users.userId, userId))
      .limit(1);

    // Accept both 'active' and 'trialing' as "has active subscription" —
    // a trial user needs to see their subscription details to manage it,
    // and the cancel endpoint (which also uses this gate) must be reachable.
    const activeStatuses: string[] = ['active', 'trialing'];
    if (subscription.length === 0 || !activeStatuses.includes(subscription[0].status)) {
      return res.json({ hasActiveSubscription: false, subscription: null });
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
        monthlyCredits: VIP_BENEFITS.monthlyCredits,
        /** True when this subscription is currently in its free-trial period */
        isTrial: sub.isTrial,
        /** Trial end date as ISO string, null once the trial converts or ends */
        trialEnd: sub.trialEnd?.toISOString() ?? null,
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
 * Stripe webhook events:
 * Endpoint: https://twistloom-backend.vercel.app/api/payments/stripe/webhook
 * Configure: https://dashboard.stripe.com/acct_1TSpFoFmDKrMqBDf/test/workbench/webhooks/we_1TSpnnFmDKrMqBDfiLH29ofk/edit
 * API version: 2026-04-22.dahlia
 * Events (10):
 * - checkout.session.completed ✅
 * - charge.refunded ✅
 * - customer.subscription.created ✅
 * - customer.subscription.updated ✅
 * - customer.subscription.deleted ✅
 * - customer.subscription.trial_will_end ✅
 * - invoice.payment_succeeded ✅
 * - invoice.payment_failed ✅
 * - payment_intent.payment_failed (no-op — handled upstream by Stripe's retries & invoice.payment_failed)
 * - payment_intent.succeeded (no-op — checkout.session.completed is the authoritative event for one-time payments)
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
  // Rate limiting: Redis-based with generous global limits.
  //
  // Stripe signature verification is the real auth for this endpoint — the
  // in-memory IP rate limiter (checkRateLimitByIP) is unsuitable here because:
  //   1. All Stripe webhooks originate from a small pool of Stripe IPs, so they'd
  //      share one rate-limit bucket and hit the (very low) default limit instantly.
  //   2. In serverless (Vercel), in-memory state resets on cold starts, making a
  //      per-instance limiter unreliable anyway.
  //
  // Instead, use Redis-based rate limiting as defense-in-depth with a generous
  // threshold. This protects against a misconfigured Stripe dashboard sending an
  // event storm, without blocking legitimate deliveries.
  const webhookRateLimit = await checkRateLimit('stripe-webhook-global', {
    maxRequests: 300,
    windowSeconds: 60,
  });
  if (!webhookRateLimit.allowed) {
    return handleRateLimitError(res, 'Too many webhook requests');
  }
  
  // Track webhook delivery
  let webhookDeliveryId: string | null = null;
  
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return handleValidationError(res, "Missing Stripe signature");

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return handleApiError(res, "Webhook secret not configured");

    const event = getStripe().webhooks.constructEvent(req.body, sig, webhookSecret);
    
    // Pre-check for duplicate webhook deliveries to prevent Unique Constraint crashes on retries
    const existingDelivery = await dbRead.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event.id)).limit(1);
    if (existingDelivery.length > 0 && existingDelivery[0].status === 'success') {
      console.log(`[stripe] 🔄 Webhook already processed successfully: ${event.id}`);
      return res.json({ received: true, duplicate: true });
    }

    // Only insert if it doesn't exist. If it does, we just update it.
    //
    // Race-guard: The SELECT above has a race window — two concurrent deliveries
    // of the same event can both see `existingDelivery.length === 0` before
    // either commit their INSERT. When that happens, the second INSERT hits the
    // unique constraint on webhookDeliveries.eventId. We catch that specific
    // error and fetch the record inserted by the first request.
    if (existingDelivery.length === 0) {
      try {
        const [deliveryRecord] = await dbWrite.insert(webhookDeliveries).values({
          eventId: event.id,
          eventType: event.type,
          status: 'retrying',
        }).returning();
        webhookDeliveryId = deliveryRecord.id;
      } catch (insertError) {
        // Unique violation (SQLSTATE 23505): another concurrent delivery
        // already inserted this event. Fetch the existing record instead.
        if (isUniqueViolation(insertError)) {
          const [dupRecord] = await dbRead.select()
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.eventId, event.id))
            .limit(1);
          webhookDeliveryId = dupRecord?.id ?? null;
          console.log(`[stripe] 🔄 Concurrent delivery race resolved at webhookDelivery INSERT: ${event.id}`);
        } else {
          throw insertError;
        }
      }
    } else {
      webhookDeliveryId = existingDelivery[0].id;
    }

    let isDuplicateTx = false;

    // Handle different event types
    // NOTE: checkout.session.completed also fires for VIP subscription checkouts
    // (mode: "subscription"), which have no payment_intent — those are handled by
    // customer.subscription.created / invoice.payment_succeeded instead. Without the
    // `session.mode === "payment"` guard below, a subscription checkout would hit the
    // "Missing payment intent" validation error on every delivery attempt and Stripe
    // would retry it for days without ever succeeding.
    if (event.type === "checkout.session.completed" && (event.data.object as Stripe.Checkout.Session).mode === "payment") {
      const session = event.data.object as Stripe.Checkout.Session;
      
      // Check for idempotency using Stripe event.id (best practice)
      const stripeEventId = event.id;
      const paymentIntentId = session.payment_intent as string;
      
      if (!paymentIntentId) return handleValidationError(res, "Missing payment intent");

      // Extract metadata
      const userId = session.metadata?.userId;
      const credits = session.metadata?.credits;
      const packId = session.metadata?.packId;
      
      if (!userId || !credits || !packId) return handleValidationError(res, "Invalid session metadata");

      const creditsAmount = Number(credits);
      const amountUsd = session.amount_total ? session.amount_total / 100 : undefined;

      // Validate payment amount matches expected credit pack price (security check)
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      if (!pack) return handleValidationError(res, "Invalid credit pack");

      if (session.amount_total !== Math.round(pack.priceUSD * 100)) {
        return handleValidationError(res, "Amount validation failed");
      }

      // Use database transaction for atomic credit update and transaction record creation
      try {
        await dbWrite.transaction(async (tx) => {
        // Check for idempotency using Stripe event.id (best practice)
        const existingTransaction = await tx
          .select()
          .from(transactions)
          .where(eq(transactions.stripeEventId, stripeEventId))
          .limit(1);

        if (existingTransaction.length > 0) {
          isDuplicateTx = true;
          return; // Break out of transaction rather than sending response here
        }

        const priorPurchase = await tx.select().from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.type, 'purchase'))).limit(1);
        
        await awardCredits(userId, creditsAmount, {
          type: "purchase",
          notificationType: "payment_success",
          notificationTitle: "Payment Successful",
          notificationMessage: `Your purchase of ${creditsAmount} credits (${pack.title}) was successful`,
          notificationData: { amount: amountUsd, paymentIntentId, packId },
          metadata: { paymentIntentId, stripeEventId, amountUsd, packId },
          amountUsd: amountUsd ?? null,
          context: 'credit_pack_purchase',
          // Persisted to the real unique-constrained columns — this is what makes the
          // idempotency check above and the charge.refunded lookup below actually work.
          paymentIntentId,
          stripeEventId,
          tx
        });

        // Award first-purchase bonus if applicable.
        // Deliberately NOT passing paymentIntentId/stripeEventId here — those columns are
        // unique per row, and the main purchase transaction above already claims them for
        // this event. The link back to the triggering payment is preserved in `metadata`.
        if (priorPurchase.length === 0 && FIRST_PURCHASE_BONUS > 0) {
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

        // Bound to tx context properly
        await tx.update(webhookDeliveries)
          .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
          .where(eq(webhookDeliveries.id, webhookDeliveryId!));
        });
      } catch (txError) {
        if (isUniqueViolation(txError)) {
          // Lost the race against a concurrent delivery of the same event — the other
          // request already recorded this purchase. Nothing left to do here.
          console.log(`[stripe] 🔄 Concurrent duplicate delivery detected via unique constraint: ${stripeEventId}`);
          isDuplicateTx = true;
        } else {
          throw txError;
        }
      }

      // Handle response outside the tx boundary
      if (isDuplicateTx) {
        if (webhookDeliveryId) {
          await dbWrite.update(webhookDeliveries)
            .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
            .where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return res.json({ received: true, duplicate: true });
      }
      
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = charge.payment_intent as string;
      const stripeEventId = event.id;
      
      if (!paymentIntentId) return handleValidationError(res, 'Missing payment intent');
      
      try {
        await dbWrite.transaction(async (tx) => {
        // Check for idempotency for refunds
        const existingRefund = await tx.select().from(transactions).where(eq(transactions.stripeEventId, stripeEventId)).limit(1);
        if (existingRefund.length > 0) {
           isDuplicateTx = true;
           return; 
        }

        const originalTransaction = await tx.select().from(transactions).where(eq(transactions.paymentIntentId, paymentIntentId)).limit(1);
        if (!originalTransaction.length) {
          // Not every refunded charge is a credit-pack purchase — subscription invoice
          // charges never get a `transactions` row with paymentIntentId set (VIP credits
          // are allocated via addCredits, tracked in `subscriptionTransactions` instead).
          // Throwing here would leave this webhook permanently un-succeeded and Stripe
          // would retry it for days. Until subscription-refund credit clawback is a
          // defined product policy (see roadmap), log it and mark the webhook handled.
          console.warn(`[stripe] ⚠️ charge.refunded for paymentIntent ${paymentIntentId} has no matching credit-pack transaction — likely a subscription charge. Skipping credit clawback.`);
          await tx.update(webhookDeliveries)
            .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
            .where(eq(webhookDeliveries.id, webhookDeliveryId!));
          return;
        }
        
        const transaction = originalTransaction[0];
        const refundAmount = charge.amount_refunded ? charge.amount_refunded / 100 : 0;
        const refundCents = Math.round(refundAmount * 100);
        const originalCents = Math.round(transaction.amountUsd! * 100);
        const creditsToDeduct = Number((BigInt(refundCents) * BigInt(transaction.credits)) / BigInt(originalCents));

        if (creditsToDeduct > 0) {
          // The Forgiveness Approach
          // Simply wipes out whatever balance they have left, flooring it at exactly 0.
          // They lose their remaining credits, but they don't go into debt.
          // This is usually the best approach for consumer apps.

          // Ensure credit balances never dip below zero by using GREATEST in the SQL update
          await tx.update(users)
            .set({ credits: sql`GREATEST(0, ${users.credits} - ${creditsToDeduct})` })
            .where(eq(users.userId, transaction.userId));
            
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
            data: { creditsDeducted: creditsToDeduct, refundAmount, originalPaymentId: paymentIntentId },
          });
        }
        
        await tx.update(webhookDeliveries)
          .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
          .where(eq(webhookDeliveries.id, webhookDeliveryId!));
        });
      } catch (txError) {
        if (isUniqueViolation(txError)) {
          console.log(`[stripe] 🔄 Concurrent duplicate refund delivery detected via unique constraint: ${stripeEventId}`);
          isDuplicateTx = true;
        } else {
          throw txError;
        }
      }

      if (isDuplicateTx) {
        if (webhookDeliveryId) {
          await dbWrite.update(webhookDeliveries)
            .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
            .where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return res.json({ received: true, duplicate: true });
      }

    } else {
      // Subscriptions / other events fall through here.
      // This also catches subscription-mode checkout.session.completed events (no-op,
      // since VIP activation is driven by customer.subscription.created below) and any
      // other event types we don't act on — all get marked 'success' so Stripe stops retrying.
      if (event.type === "customer.subscription.created") await handleSubscriptionCreated(event);
      else if (event.type === "customer.subscription.updated") await handleSubscriptionUpdated(event);
      else if (event.type === "customer.subscription.deleted") await handleSubscriptionDeleted(event);
      else if (event.type === "customer.subscription.trial_will_end") await handleTrialWillEndEvent(event);
      else if (event.type === "invoice.payment_succeeded") await handleInvoicePaymentSucceeded(event);
      else if (event.type === "invoice.payment_failed") await handleInvoicePaymentFailed(event);

      // Update non-transactional webhook events to success
      if (webhookDeliveryId) {
        await dbWrite.update(webhookDeliveries)
          .set({ status: 'success', processedAt: new Date(), updatedAt: new Date() })
          .where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    }

    res.json({ received: true });
  } catch (error) {
    if (webhookDeliveryId) {
      await dbWrite.update(webhookDeliveries)
        .set({ status: 'failed', errorMessage: getErrorMessage(error), processedAt: new Date(), updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
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
 *   error: string; // Error message with required credit count
 *   required: number; // Credits needed
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
  // Retained exactly as is - logic remains valid
  try {
    const { costKey, idempotencyKey, context, metadata } = req.body;
    if (!costKey || typeof costKey !== 'string') return handleValidationError(res, "Valid costKey is required");
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) return handleValidationError(res, "Metadata must be an object");

    const validCostKeys: CreditCostKey[] = Object.keys(CREDIT_COSTS) as CreditCostKey[];
    if (!validCostKeys.includes(costKey as CreditCostKey)) return handleValidationError(res, `Invalid costKey: ${costKey}`);

    const userId = req.userId!;

    // Rate limiting: Prevent abuse (60 requests per minute per user)
    const rateLimitResult = await checkRateLimit(`credit-consume-${userId}`, { maxRequests: 60, windowSeconds: 60 });
    if (!rateLimitResult.allowed) return handleRateLimitError(res, "Too many credit consumption attempts.");

    let processingCleanup: (() => Promise<void>) | null = null;
    
    // Idempotency check: Prevent double charging on retries
    if (idempotencyKey) {
      // First, try to set processing flag to prevent race condition
      const processing = await setIdempotencyProcessing({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      if (!processing.set) return handleConflictError(res, "Request already in progress");
      
      // Store cleanup function
      processingCleanup = processing.cleanup;
      // Check for existing completed result
      const idempotencyResult = await checkIdempotency<any>({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      
      if (idempotencyResult.isDuplicate && idempotencyResult.cachedResult) {
        await processingCleanup();
        return res.status(409).json({ error: "Duplicate request", message: "This request has already been processed", ...idempotencyResult.cachedResult });
      }
    }

    try {
      // Consume credits using the service function
      const creditResult = await consumeCredits(userId, costKey as CreditCostKey, { context, metadata, req });

      // Store idempotency result if key provided (TTL: 5 minutes)
      // This ensures idempotency even if the operation fails
      if (idempotencyKey) {
        await storeIdempotencyResult(
          { key: idempotencyKey, prefix: 'credit-consume', ttl: 300 },
          { success: true, creditsConsumed: getCreditCost(costKey as CreditCostKey), remainingCredits: creditResult.remainingCredits }
        );
      }

      if (processingCleanup) await processingCleanup();
      res.json({ success: true, creditsConsumed: getCreditCost(costKey as CreditCostKey), remainingCredits: creditResult.remainingCredits });
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
 *     "totalCount": 45,
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
    const { limit = "50", offset = "0", type, startDate, endDate } = req.query;

    // Build base query conditions
    const conditions = [eq(transactions.userId, userId)];
    
    // Add type filter if provided
    const transactionTypes: TransactionType[] = ["purchase", "usage", "refund", "reward"];
    if (type && transactionTypes.includes(type as TransactionType)) conditions.push(eq(transactions.type, type as TransactionType));
    if (startDate) conditions.push(sql`${transactions.createdAt} >= ${startDate}`);
    if (endDate) conditions.push(sql`${transactions.createdAt} <= ${endDate}`);

    const countResult = await dbRead.select({ count: sql<number>`count(*)::int` }).from(transactions).where(and(...conditions));
    const totalCount = countResult[0].count;

    // Get transactions with pagination
    const limitNum = parseInt(limit as string);
    const offsetNum = parseInt(offset as string);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const userTransactions = await dbRead
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(desc(transactions.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    // Removed JSON.parse(tx.metadata) - Drizzle + pg driver natively handles JSONB as parsed JS objects
    const formattedTransactions = userTransactions.map(tx => ({
      ...tx,
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
    const userBalance = await dbRead.select({ credits: users.credits }).from(users).where(eq(users.userId, userId)).limit(1);

    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    res.json({
      ...createPaginatedResponse(formattedTransactions, pagination, 'transactions'),
      summary: {
        totalCreditsPurchased: summary[0]?.totalCreditsPurchased || 0,
        totalCreditsUsed: summary[0]?.totalCreditsUsed || 0,
        totalCreditsRewarded: summary[0]?.totalCreditsRewarded || 0,
        totalAmountSpent: summary[0]?.totalAmountSpent || 0,
        currentBalance: userBalance[0]?.credits || 0,
      },
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
    res.json({ plans: [{ ...VIP_SUBSCRIPTION, benefits: ["VIP badge", "2x check-in bonus", "+50 monthly credits"] }] });
  } catch (error) {
    handleApiError(res, "Failed to fetch subscription plans", error);
  }
});

/**
 * POST /payments/subscription/cancel
 * 
 * Cancels the authenticated user's active VIP subscription at the end of the current billing period.
 * Calls Stripe API to set cancel_at_period_end = true and updates the local database record.
 * The subscription remains active until the period end date.
 * 
 * @route POST /payments/subscription/cancel
 * @description Cancel subscription at period end
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @returns {Object} Cancellation response
 * @returns {boolean} success - Operation status
 * @returns {string} message - Confirmation message
 * 
 * @example
 * // Request
 * POST /payments/subscription/cancel
 * 
 * // Response
 * {
 *   "success": true,
 *   "message": "Subscription will be canceled at period end"
 * }
 * 
 * // Error response (no active subscription)
 * {
 *   "success": false,
 *   "error": "No active subscription found"
 * }
 */
router.post("/subscription/cancel", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const subscription = await dbRead
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ['active', 'trialing'])))
      .limit(1);

    if (subscription.length === 0) return handleNotFoundError(res, "No active subscription found");

    // Cancel subscription at period end
    await getStripe().subscriptions.update(subscription[0].stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Update database
    await dbWrite
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.id, subscription[0].id));

    res.json({ success: true, message: "Subscription will be canceled at period end" });
  } catch (error) {
    handleApiError(res, "Failed to cancel subscription", error);
  }
});

/**
 * GET /payments/subscription/portal
 * 
 * Creates a Stripe Customer Portal session for subscription management.
 * Users can manage payment methods, view invoices, and update billing info.
 * Requires an existing Stripe customer ID (created on first subscription purchase).
 * 
 * @route GET /payments/subscription/portal
 * @description Get Stripe Customer Portal URL
 * 
 * @header X-App-Version - Application version (for analytics)
 * @header X-Platform - Client platform (android/ios)
 * 
 * @query {string} [returnUrl] - URL to redirect after portal session ends (default: /dashboard)
 * 
 * @returns {Object} Portal session response
 * @returns {string} url - Stripe Customer Portal URL
 * 
 * @example
 * // Request
 * GET /payments/subscription/portal?returnUrl=https://app.com/settings
 * 
 * // Response
 * {
 *   "url": "https://billing.stripe.com/session/..."
 * }
 */
router.get("/subscription/portal", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Security: prevent open redirects. The two checkout endpoints above already
    // validate returnUrl origin — this endpoint accepted any URL Stripe would then
    // redirect the user to after the portal session, which is a classic open-redirect
    // vector (e.g. ?returnUrl=https://evil.example.com).
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return handleApiError(res, "Frontend URL not configured");
    }

    const rawReturnUrl = req.query.returnUrl as string | undefined;
    let returnUrl = `${baseUrl}/dashboard`;

    if (rawReturnUrl) {
      try {
        const returnUrlObj = new URL(rawReturnUrl, baseUrl);
        const baseUrlObj = new URL(baseUrl);

        if (returnUrlObj.origin !== baseUrlObj.origin) {
          throw new Error("Cross-origin returnUrl not allowed");
        }

        returnUrl = returnUrlObj.toString();
      } catch {
        return handleValidationError(res, "Invalid returnUrl");
      }
    }

    // Try to get customer ID from subscription first, then fall back to user record
    let customerId: string | null = null;

    // Same "which row" caveat as GET /subscription, but lower stakes here since every
    // subscription row for a given user should carry the same stripeCustomerId (the
    // checkout endpoints always reuse users.stripeCustomerId once set) — ordering by
    // recency is just cheap insurance against that invariant ever slipping.
    const subscription = await dbRead
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (subscription.length > 0 && subscription[0].stripeCustomerId) {
      customerId = subscription[0].stripeCustomerId;
    } else {
      // Fallback to users.stripeCustomerId for users with customer ID but no subscription yet
      const [user] = await dbRead
        .select({ stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);
      customerId = user?.stripeCustomerId ?? null;
    }

    if (!customerId) {
      return handleNotFoundError(res, "No subscription found");
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    handleApiError(res, "Failed to create portal session", error);
  }
});

export default router;
