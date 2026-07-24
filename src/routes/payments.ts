/**
 * Payments Routes Module (Hono)
 *
 * Provides endpoints for Stripe checkout sessions, credit purchases, and transaction history.
 * Integrates with Stripe for payment processing and tracks all credit-related transactions.
 */

import { Hono, type Context } from "hono";
import type Stripe from "stripe";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, userNotifications, subscriptions } from "../db/schema.js";
import { CREDIT_PACKS, type CreditCostKey, CREDIT_COSTS, FIRST_PURCHASE_BONUS } from "../config/credits.js";
import type { TransactionType } from "../types/credits.js";
import { getErrorMessage, cApiError, cConflictError, cNotFoundError, cValidationError, cRateLimitError } from "../utils/error.js";
import { checkRateLimit, checkIdempotency, storeIdempotencyResult, constructSafeUrl, setIdempotencyProcessing } from "../utils/redis.js";
import { consumeCredits, getCreditCost, awardCredits } from "../services/credits.js";
import { CREDIT_ERRORS, isInsufficientCreditsError } from "../config/errors.js";
import { createSubscription, updateSubscription, renewSubscription, cancelSubscription, hasActiveVipSubscription, isTrialEligible, handleTrialWillEnd } from "../services/subscription.js";
import { VIP_BENEFITS, VIP_SUBSCRIPTION, VIP_TRIAL } from "../config/subscription.js";
import { getStripe } from "../utils/stripe.js";
import type { AppEnv } from "../hono/env.js";
import { getClientIp } from "../hono/express-shim.js";

/**
 * Extended Stripe Subscription interface with properties that exist in the API
 * but are missing from the TypeScript definition (stripe@22.2.0).
 *
 * The Stripe SDK's `Subscription` type omits `current_period_start` and
 * `current_period_end` as top-level fields. This interface restores them
 * for type-safe access in webhook handlers.
 */
interface StripeSubscriptionWithPeriods extends Stripe.Subscription {
  /** Unix timestamp (seconds) of the current billing period start */
  current_period_start: number;
  /** Unix timestamp (seconds) of the current billing period end */
  current_period_end: number;
}

/**
 * Extended Stripe Invoice interface with properties that exist in the API
 * but are missing from the TypeScript definition (stripe@22.2.0).
 *
 * `subscription` is a top-level field in Stripe's raw Invoice JSON response,
 * but the SDK's Invoice type only exposes it through `parent.subscription_details`.
 * This extended interface makes it accessible directly without `any`.
 */
interface StripeInvoiceWithSubscription extends Stripe.Invoice {
  /** Subscription ID or expanded Subscription object (raw API field) */
  subscription?: string | Stripe.Subscription;
}

/**
 * Type guard that validates a Stripe subscription object contains the required
 * period properties (`current_period_start`, `current_period_end`) missing from
 * the base SDK type.
 *
 * @param obj - The raw event data object from a Stripe webhook
 * @returns `true` if the object has valid numeric period properties
 *
 * @example
 * ```typescript
 * const sub = event.data.object;
 * if (!isSubscriptionWithPeriods(sub)) {
 *   return console.error("Invalid subscription object");
 * }
 * // sub is now typed as StripeSubscriptionWithPeriods
 * ```
 */
function isSubscriptionWithPeriods(obj: any): obj is StripeSubscriptionWithPeriods {
  return obj &&
         typeof obj.current_period_start === 'number' &&
         typeof obj.current_period_end === 'number';
}

/**
 * Returns a 402 response for insufficient-credits errors with the required
 * credit amount, ensuring a consistent error shape across all endpoints.
 *
 * @param res - Hono response context
 * @param costKey - The credit cost key that was attempted
 * @param error - Optional original error for contextual message fallback
 * @returns 402 JSON response with `error` and `required` fields
 *
 * @example
 * ```typescript
 * if (isInsufficientCreditsError(error)) {
 *   return handleInsufficientCreditsError(c, costKey);
 * }
 * ```
 */
export function handleInsufficientCreditsError(
  res: Context,
  costKey: string,
  error?: unknown
) {
  const requiredCredits = getCreditCost(costKey as CreditCostKey);
  return res.json({
    error: getErrorMessage(error, `${CREDIT_ERRORS.INSUFFICIENT_CREDITS}. Requires ${requiredCredits} credits.`),
    required: requiredCredits,
  }, 402);
}

const router = new Hono<AppEnv>();

/**
 * Detects a Postgres unique-constraint violation by checking for SQLSTATE 23505.
 * Used to handle concurrent webhook delivery races where duplicate INSERTs may
 * collide on the same `stripeEventId` or `eventId`.
 *
 * @param error - The error object thrown by a database operation
 * @returns `true` if the error is a Postgres unique violation
 *
 * @example
 * ```typescript
 * try { await dbWrite.insert(...).values(...); }
 * catch (err) {
 *   if (isUniqueViolation(err)) {
 *     // concurrent duplicate
 *   }
 * }
 * ```
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * Handles `customer.subscription.created` webhook events from Stripe.
 *
 * Validates the subscription object shape, extracts userId from metadata,
 * resolves price ID from the first line item, and persists the subscription
 * via {@link createSubscription}. Supports both regular and trial subscriptions.
 *
 * @param event - The Stripe webhook event. `event.data.object` is expected to
 *                include `current_period_start` and `current_period_end`.
 *
 * @example
 * ```typescript
 * // Dispatched from webhook handler:
 * if (event.type === "customer.subscription.created") {
 *   await handleSubscriptionCreated(event);
 * }
 * ```
 */
async function handleSubscriptionCreated(event: Stripe.Event) {
  const subscription = event.data.object;
  if (!isSubscriptionWithPeriods(subscription)) {
    return console.error("[subscription] ❌ Invalid subscription object: missing period properties");
  }
  const userId = subscription.metadata?.userId;
  if (!userId) {
    return console.error("[subscription] ❌ Missing userId in subscription metadata");
  }
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
    stripeEventId: event.id,
  });
  console.log(`[subscription] ✅ Created subscription for user ${userId}${isTrial ? " (trial)" : ""}`);
}

/**
 * Handles `customer.subscription.updated` webhook events from Stripe.
 *
 * Updates the local subscription record's status, period end, and
 * cancel-at-period-end flag. Used to sync status changes (e.g. active → past_due)
 * and billing anchor shifts.
 *
 * @param event - The Stripe webhook event. `event.data.object` must include
 *                `current_period_start` and `current_period_end`.
 *
 * @example
 * ```typescript
 * if (event.type === "customer.subscription.updated") {
 *   await handleSubscriptionUpdated(event);
 * }
 * ```
 */
async function handleSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object;
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
 * Handles `customer.subscription.deleted` webhook events from Stripe.
 *
 * Cancels the local subscription record, recording the cancellation timestamp.
 * This fires when a subscription ends (either immediately or at period end
 * after `cancel_at_period_end` was set).
 *
 * @param event - The Stripe webhook event. `event.data.object` is cast to
 *                `Stripe.Subscription` (no extended properties needed).
 *
 * @example
 * ```typescript
 * if (event.type === "customer.subscription.deleted") {
 *   await handleSubscriptionDeleted(event);
 * }
 * ```
 */
async function handleSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  await cancelSubscription({
    stripeSubscriptionId: subscription.id,
    canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : new Date(),
    stripeEventId: event.id,
  });
  console.log(`[subscription] ❌ Canceled subscription ${subscription.id}`);
}

/**
 * Handles `invoice.payment_succeeded` webhook events from Stripe.
 *
 * Extracts the subscription ID from the invoice (via the raw API `subscription`
 * field or `parent.subscription_details.subscription`), filters to
 * `billing_reason === 'subscription_cycle'` only (skipping trials, prorations,
 * and invoice corrections), and renews the subscription via {@link renewSubscription}.
 *
 * @param event - The Stripe webhook event. `event.data.object` is cast to
 *                {@link StripeInvoiceWithSubscription} for type-safe access to
 *                the raw `subscription` field.
 *
 * @example
 * ```typescript
 * if (event.type === "invoice.payment_succeeded") {
 *   await handleInvoicePaymentSucceeded(event);
 * }
 * ```
 */
async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  const invoice = event.data.object as StripeInvoiceWithSubscription;
  const rawSubscription = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof rawSubscription === 'object' ? rawSubscription?.id : rawSubscription;
  if (!subscriptionId) {
    return console.error("[subscription] ❌ Missing subscriptionId in invoice");
  }
  if (invoice.billing_reason !== 'subscription_cycle') {
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
    stripeEventId: event.id,
  });
  console.log(`[subscription] 💳 Renewed subscription ${subscriptionId}`);
}

/**
 * Handles `invoice.payment_failed` webhook events from Stripe.
 *
 * Extracts the subscription ID from the invoice's `parent.subscription_details`,
 * then updates the local subscription status to `past_due` so downstream
 * logic (e.g. dunning emails, access revocation) can react.
 *
 * @param event - The Stripe webhook event with a failed invoice
 *
 * @example
 * ```typescript
 * if (event.type === "invoice.payment_failed") {
 *   await handleInvoicePaymentFailed(event);
 * }
 * ```
 */
async function handleInvoicePaymentFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionData = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof subscriptionData === 'string' ? subscriptionData : subscriptionData?.id;
  if (!subscriptionId) return;
  await updateSubscription({
    stripeSubscriptionId: subscriptionId,
    status: 'past_due',
  });
  console.log(`[subscription] ❌ Payment failed for subscription ${subscriptionId}`);
}

/**
 * Handles `customer.subscription.trial_will_end` webhook events from Stripe.
 *
 * Delegates to {@link handleTrialWillEnd} which handles trial-expiry notifications
 * (e.g. sending reminders). Stripe fires this 3 days before the trial ends.
 *
 * @param event - The Stripe webhook event. `event.data.object` is cast to
 *                `Stripe.Subscription`.
 *
 * @example
 * ```typescript
 * if (event.type === "customer.subscription.trial_will_end") {
 *   await handleTrialWillEndEvent(event);
 * }
 * ```
 */
async function handleTrialWillEndEvent(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription;
  await handleTrialWillEnd(subscription.id);
  console.log(`[subscription] ⏰ Trial ending soon for subscription ${subscription.id}`);
}

/**
 * GET /credit-packs
 *
 * Returns the list of available credit packs for purchase. Strips internal
 * fields (e.g. Stripe API keys) and exposes only frontend-safe metadata.
 *
 * @route GET /api/payments/credit-packs
 * @returns {Object[]} Array of credit packs with id, title, credits, priceUSD, etc.
 *
 * @example
 * ```typescript
 * // Response:
 * [{ id: "basic", title: "Basic Pack", credits: 100, priceUSD: 9.99, ... }]
 * ```
 */
router.get("/credit-packs", async (c) => {
  try {
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
    return c.json(safeCreditPacks);
  } catch (error) {
    return cApiError(c, "Failed to fetch credit packs", error);
  }
});

/**
 * POST /create-checkout-session
 *
 * Creates a Stripe Checkout Session for a one-time credit pack purchase.
 * Validates the pack ID, enforces a 10-second rate limit per user, constructs
 * safe return URLs (with origin validation for `returnUrl`), and returns the
 * checkout URL to the frontend.
 *
 * @route POST /api/payments/create-checkout-session
 * @auth required
 * @body {string} packId - ID of the credit pack to purchase
 * @body {string} [successPath] - Fallback success redirect path
 * @body {string} [cancelPath] - Fallback cancel redirect path
 * @body {string} [returnUrl] - Fully-qualified return URL (cross-origin rejected)
 * @returns {{ url: string, sessionId: string }} Stripe Checkout Session URL
 *
 * @example
 * ```typescript
 * // Request body: { packId: "premium_1000", returnUrl: "https://app.example.com/pricing" }
 * // Response: { url: "https://checkout.stripe.com/...", sessionId: "cs_test_..." }
 * ```
 */
router.post("/create-checkout-session", requireAuth, async (c) => {
  try {
    const { packId, successPath, cancelPath, returnUrl } = c.get("body");
    if (!packId) return cValidationError(c, "Credit pack ID is required");
    const user = c.get("user")!;
    const { id: userId, email } = user;

    const rateLimitResult = await checkRateLimit(`checkout-session-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    let successUrl: string;
    let cancelUrl: string;

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
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?success=true');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }

    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) return cNotFoundError(c, "Credit pack not found");

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email,
      line_items: [{ price: pack.priceId, quantity: 1 }],
      metadata: { userId, packId: pack.id, credits: pack.credits.toString() },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    return cApiError(c, "Failed to create checkout session", error);
  }
});

/**
 * POST /create-subscription-checkout
 *
 * Creates a Stripe Checkout Session for a recurring VIP subscription.
 * Verifies the user does not already have an active subscription, creates a
 * Stripe customer if none exists, and configures the session in `subscription`
 * mode with the VIP price ID. Enforces a 10-second rate limit.
 *
 * @route POST /api/payments/create-subscription-checkout
 * @auth required
 * @body {string} [successPath] - Fallback success redirect path
 * @body {string} [cancelPath] - Fallback cancel redirect path
 * @body {string} [returnUrl] - Fully-qualified return URL (cross-origin rejected)
 * @returns {{ url: string, sessionId: string }} Stripe Checkout Session URL
 *
 * @example
 * ```typescript
 * // Response: { url: "https://checkout.stripe.com/...", sessionId: "cs_test_..." }
 * ```
 */
router.post("/create-subscription-checkout", requireAuth, async (c) => {
  try {
    const { successPath, cancelPath, returnUrl } = c.get("body");
    const userId = c.get("user")!.id;

    const rateLimitResult = await checkRateLimit(`subscription-checkout-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    const hasActiveSub = await hasActiveVipSubscription(userId);
    if (hasActiveSub) return cValidationError(c, "You already have an active VIP subscription");

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    let successUrl: string;
    let cancelUrl: string;

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

    if (!VIP_SUBSCRIPTION.priceId) return cApiError(c, "VIP subscription not configured");

    const [user] = await dbRead.select({ stripeCustomerId: users.stripeCustomerId, email: users.email }).from(users).where(eq(users.userId, userId)).limit(1);
    let customerId = user?.stripeCustomerId;
    const userEmail = user?.email;

    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: userEmail ?? c.get("user")!.email,
        metadata: { userId },
      });
      customerId = customer.id;
      await dbWrite.update(users).set({ stripeCustomerId: customerId }).where(eq(users.userId, userId));
    }

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: VIP_SUBSCRIPTION.priceId, quantity: 1 }],
      metadata: { userId, subscriptionType: 'vip', isTrial: "false" },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: { metadata: { userId, isTrial: "false" } },
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    return cApiError(c, "Failed to create subscription checkout session", error);
  }
});

/**
 * GET /subscription/trial-eligibility
 *
 * Checks whether the authenticated user is eligible for a free trial
 * based on past subscription and trial history.
 *
 * @route GET /api/payments/subscription/trial-eligibility
 * @auth required
 * @returns {{ eligible: boolean }} Whether the user can start a trial
 *
 * @example
 * ```typescript
 * // Response: { eligible: true }
 * ```
 */
router.get("/subscription/trial-eligibility", requireAuth, async (c) => {
  try {
    const userId = c.get("user")!.id;
    const eligible = await isTrialEligible(userId);
    return c.json({ eligible });
  } catch (error) {
    return cApiError(c, "Failed to check trial eligibility", error);
  }
});

/**
 * POST /create-trial-checkout-session
 *
 * Creates a Stripe Checkout Session for a free-trial VIP subscription.
 * Validates that trials are globally enabled, the user is eligible, and
 * enforces a 10-second rate limit. Creates a Stripe customer if needed
 * and configures the session with `trial_period_days` and
 * `trial_settings.end_behavior`.
 *
 * @route POST /api/payments/create-trial-checkout-session
 * @auth required
 * @body {string} [successPath] - Fallback success redirect path
 * @body {string} [cancelPath] - Fallback cancel redirect path
 * @body {string} [returnUrl] - Fully-qualified return URL (cross-origin rejected)
 * @returns {{ url: string, sessionId: string }} Stripe Checkout Session URL
 *
 * @example
 * ```typescript
 * // Response: { url: "https://checkout.stripe.com/...", sessionId: "cs_test_..." }
 * ```
 */
router.post("/create-trial-checkout-session", requireAuth, async (c) => {
  const LOG_TAG = '[trial-checkout]';
  try {
    console.log(`${LOG_TAG} ▶️ Entered handler`);
    const { successPath, cancelPath, returnUrl } = c.get("body");
    const userId = c.get("user")!.id;
    console.log(`${LOG_TAG} userId=${userId}`);

    console.log(`${LOG_TAG} 🔒 Checking rate limit for trial-checkout-${userId}`);
    const rateLimitResult = await checkRateLimit(`trial-checkout-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      console.log(`${LOG_TAG} ⛔ Rate limited`);
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }
    console.log(`${LOG_TAG} ✅ Rate limit passed`);

    console.log(`${LOG_TAG} 🔧 VIP_TRIAL.enabled=${VIP_TRIAL.enabled}`);
    if (!VIP_TRIAL.enabled) {
      console.log(`${LOG_TAG} ⛔ Trials disabled via VIP_TRIAL.enabled`);
      return cValidationError(c, "Trials are not currently available");
    }

    console.log(`${LOG_TAG} 🔍 Checking trial eligibility for userId=${userId}`);
    const eligible = await isTrialEligible(userId);
    console.log(`${LOG_TAG} ✅ Trial eligible=${eligible}`);
    if (!eligible) {
      console.log(`${LOG_TAG} ⛔ Not eligible for trial`);
      return cValidationError(c, "Trial not available for this account");
    }

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      console.log(`${LOG_TAG} ❌ FRONTEND_URL not configured`);
      return cApiError(c, "Frontend URL not configured");
    }
    console.log(`${LOG_TAG} ✅ FRONTEND_URL=${baseUrl}`);

    let successUrl: string;
    let cancelUrl: string;

    if (returnUrl) {
      console.log(`${LOG_TAG} 🔗 Processing returnUrl=${returnUrl}`);
      try {
        const returnUrlObj = new URL(returnUrl, baseUrl);
        const baseUrlObj = new URL(baseUrl);
        if (returnUrlObj.origin !== baseUrlObj.origin) {
          console.log(`${LOG_TAG} ❌ Cross-origin returnUrl rejected`);
          throw new Error("Cross-origin returnUrl not allowed");
        }
        returnUrlObj.searchParams.set('subscription', 'success');
        successUrl = returnUrlObj.toString();
        returnUrlObj.searchParams.set('subscription', 'cancel');
        cancelUrl = returnUrlObj.toString();
      } catch {
        console.log(`${LOG_TAG} ⚠️ returnUrl parsing failed, falling back to defaults`);
        successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
        cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
      }
    } else {
      successUrl = constructSafeUrl(successPath, baseUrl, '/dashboard?subscription=success');
      cancelUrl = constructSafeUrl(cancelPath, baseUrl, '/pricing');
    }
    console.log(`${LOG_TAG} ✅ URLs: success=${successUrl}, cancel=${cancelUrl}`);

    console.log(`${LOG_TAG} 🔧 Checking VIP_SUBSCRIPTION.priceId`);
    if (!VIP_SUBSCRIPTION.priceId) {
      console.log(`${LOG_TAG} ❌ VIP_SUBSCRIPTION.priceId is not configured`);
      return cApiError(c, "VIP subscription not configured");
    }
    console.log(`${LOG_TAG} ✅ VIP_SUBSCRIPTION.priceId=${VIP_SUBSCRIPTION.priceId}`);

    const [user] = await dbRead.select({ stripeCustomerId: users.stripeCustomerId, email: users.email }).from(users).where(eq(users.userId, userId)).limit(1);
    let customerId = user?.stripeCustomerId;
    const userEmail = user?.email;
    console.log(`${LOG_TAG} 📡 User lookup: stripeCustomerId=${customerId || 'null (will create)'}, email=${userEmail}`);

    if (!customerId) {
      console.log(`${LOG_TAG} 🏦 Creating new Stripe customer for userId=${userId}`);
      const customer = await getStripe().customers.create({
        email: userEmail ?? c.get("user")!.email,
        metadata: { userId },
      });
      customerId = customer.id;
      console.log(`${LOG_TAG} ✅ Stripe customer created: id=${customerId}`);
      await dbWrite.update(users).set({ stripeCustomerId: customerId }).where(eq(users.userId, userId));
      console.log(`${LOG_TAG} ✅ User updated with stripeCustomerId`);
    }

    console.log(`${LOG_TAG} 💳 Creating Stripe checkout session...`);
    console.log(`${LOG_TAG} 💳 trial_period_days=${VIP_TRIAL.trialPeriodDays}, endBehavior=${VIP_TRIAL.endBehavior}`);
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: VIP_SUBSCRIPTION.priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: VIP_TRIAL.trialPeriodDays,
        trial_settings: { end_behavior: { missing_payment_method: VIP_TRIAL.endBehavior } },
        metadata: { userId, isTrial: "true" },
      },
      payment_method_collection: "always",
      metadata: { userId, subscriptionType: 'vip', isTrial: "true" },
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    console.log(`${LOG_TAG} ✅ Stripe session created: id=${session.id}, url=${session.url}`);
    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.log(`[trial-checkout] ❌ CAUGHT ERROR:`, error);
    return cApiError(c, "Failed to create trial checkout session", error);
  }
});

/**
 * GET /subscription
 *
 * Returns the authenticated user's active subscription details (if any).
 * Joins `subscriptions` with `users` to fetch the current subscription record.
 * Only returns data for `active` or `trialing` statuses. If the user is not
 * authenticated, returns a null subscription (no error).
 *
 * @route GET /api/payments/subscription
 * @auth optional
 * @returns {{ hasActiveSubscription: boolean, subscription: Object|null }}
 *
 * @example
 * ```typescript
 * // Response (authenticated, active):
 * { hasActiveSubscription: true, subscription: { id: 1, status: "active", ... } }
 * // Response (no auth or no active sub):
 * { hasActiveSubscription: false, subscription: null }
 * ```
 */
router.get("/subscription", optionalAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({ hasActiveSubscription: false, subscription: null });
    }

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
      })
      .from(users)
      .innerJoin(subscriptions, eq(subscriptions.id, users.subscriptionId))
      .where(eq(users.userId, userId))
      .limit(1);

    const activeStatuses: string[] = ['active', 'trialing'];
    if (subscription.length === 0 || !activeStatuses.includes(subscription[0].status)) {
      return c.json({ hasActiveSubscription: false, subscription: null });
    }

    const sub = subscription[0];
    return c.json({
      hasActiveSubscription: true,
      subscription: {
        id: sub.id,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        status: sub.status,
        currentPeriodStart: sub.currentPeriodStart.toISOString(),
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        monthlyCredits: VIP_BENEFITS.monthlyCredits,
        isTrial: sub.isTrial,
        trialEnd: sub.trialEnd?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return cApiError(c, "Failed to fetch subscription details", error);
  }
});

/**
 * POST /stripe/webhook
 *
 * Main Stripe webhook endpoint. Verifies the signature, deduplicates via
 * `webhookDeliveries` table, and dispatches to typed handler functions:
 *
 * - `checkout.session.completed` (payment mode) → awards purchased credits + optional first-purchase bonus
 * - `charge.refunded` → prorates credit clawback
 * - `customer.subscription.created` → persists new subscription
 * - `customer.subscription.updated` → syncs subscription status
 * - `customer.subscription.deleted` → marks subscription canceled
 * - `customer.subscription.trial_will_end` → triggers trial-end notification
 * - `invoice.payment_succeeded` → renews subscription, grants monthly credits
 * - `invoice.payment_failed` → marks subscription past_due
 *
 * Applies a global rate limit of 300 requests per 60 seconds.
 *
 * @route POST /api/payments/stripe/webhook
 * @returns {{ received: boolean, duplicate?: boolean }}
 *
 * @example
 * ```typescript
 * // Response: { received: true }
 * // Duplicate: { received: true, duplicate: true }
 * ```
 */
router.post("/stripe/webhook", async (c) => {
  const webhookRateLimit = await checkRateLimit('stripe-webhook-global', { maxRequests: 300, windowSeconds: 60 });
  if (!webhookRateLimit.allowed) {
    return cRateLimitError(c, 'Too many webhook requests');
  }

  let webhookDeliveryId: string | null = null;

  try {
    const sig = c.req.header("stripe-signature");
    if (!sig) return cValidationError(c, "Missing Stripe signature");

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return cApiError(c, "Webhook secret not configured");

    const rawBody = await c.req.text();
    const event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);

    const existingDelivery = await dbRead.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event.id)).limit(1);
    if (existingDelivery.length > 0 && existingDelivery[0].status === 'success') {
      console.log(`[stripe] 🔄 Webhook already processed successfully: ${event.id}`);
      return c.json({ received: true, duplicate: true });
    }

    if (existingDelivery.length === 0) {
      try {
        const [deliveryRecord] = await dbWrite.insert(webhookDeliveries).values({
          eventId: event.id,
          eventType: event.type,
          status: 'retrying',
        }).returning();
        webhookDeliveryId = deliveryRecord.id;
      } catch (insertError) {
        if (isUniqueViolation(insertError)) {
          const [dupRecord] = await dbRead.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event.id)).limit(1);
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

    if (event.type === "checkout.session.completed" && (event.data.object as Stripe.Checkout.Session).mode === "payment") {
      const session = event.data.object as Stripe.Checkout.Session;
      const stripeEventId = event.id;
      const paymentIntentId = session.payment_intent as string;
      if (!paymentIntentId) return cValidationError(c, "Missing payment intent");

      const userId = session.metadata?.userId;
      const credits = session.metadata?.credits;
      const packId = session.metadata?.packId;
      if (!userId || !credits || !packId) return cValidationError(c, "Invalid session metadata");

      const creditsAmount = Number(credits);
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      if (!pack) return cValidationError(c, "Invalid credit pack");
      if (session.amount_total !== Math.round(pack.priceUSD * 100)) {
        return cValidationError(c, "Amount validation failed");
      }

      try {
        await dbWrite.transaction(async (tx) => {
          const existingTransaction = await tx.select().from(transactions).where(eq(transactions.stripeEventId, stripeEventId)).limit(1);
          if (existingTransaction.length > 0) {
            isDuplicateTx = true;
            return;
          }
          const priorPurchase = await tx.select().from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.type, 'purchase'))).limit(1);
          await awardCredits(userId, creditsAmount, {
            type: "purchase",
            notificationType: "payment_success",
            notificationTitle: "Payment Successful",
            notificationMessage: `Your purchase of ${creditsAmount} credits (${pack.title}) was successful`,
            notificationData: { amountCents: session.amount_total, paymentIntentId, packId },
            metadata: { paymentIntentId, stripeEventId, amountCents: session.amount_total, packId },
            amountCents: session.amount_total ?? undefined,
            context: 'credit_pack_purchase',
            paymentIntentId,
            stripeEventId,
            tx,
          });
          if (priorPurchase.length === 0 && FIRST_PURCHASE_BONUS > 0) {
            try {
              await awardCredits(userId, FIRST_PURCHASE_BONUS, {
                type: 'reward',
                notificationType: 'first_purchase_bonus',
                notificationTitle: 'First Purchase Bonus',
                notificationMessage: `You received ${FIRST_PURCHASE_BONUS} credits for your first purchase`,
                notificationData: { amountCents: session.amount_total, packId, paymentIntentId },
                metadata: { stripeEventId, paymentIntentId, packId },
                tx,
              });
              console.log(`[stripe] 🎁 Awarded first-purchase bonus (${FIRST_PURCHASE_BONUS} credits) to user ${userId}`);
            } catch (err) {
              console.error(`[stripe] ❌ Failed to award first-purchase bonus to user ${userId}:`, err);
            }
          }
          await tx.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId!));
        });
      } catch (txError) {
        if (isUniqueViolation(txError)) {
          console.log(`[stripe] 🔄 Concurrent duplicate delivery detected via unique constraint: ${stripeEventId}`);
          isDuplicateTx = true;
        } else {
          throw txError;
        }
      }

      if (isDuplicateTx) {
        if (webhookDeliveryId) {
          await dbWrite.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return c.json({ received: true, duplicate: true });
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = charge.payment_intent as string;
      const stripeEventId = event.id;
      if (!paymentIntentId) return cValidationError(c, 'Missing payment intent');

      try {
        await dbWrite.transaction(async (tx) => {
          const existingRefund = await tx.select().from(transactions).where(eq(transactions.stripeEventId, stripeEventId)).limit(1);
          if (existingRefund.length > 0) {
            isDuplicateTx = true;
            return;
          }
          const originalTransaction = await tx.select().from(transactions).where(eq(transactions.paymentIntentId, paymentIntentId)).limit(1);
          if (!originalTransaction.length) {
            console.warn(`[stripe] ⚠️ charge.refunded for paymentIntent ${paymentIntentId} has no matching credit-pack transaction — likely a subscription charge. Skipping credit clawback.`);
            await tx.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId!));
            return;
          }
          const transaction = originalTransaction[0];
          const refundCents = charge.amount_refunded ?? 0;
          const originalCents = transaction.amountCents!;
          const creditsToDeduct = Number((BigInt(refundCents) * BigInt(transaction.credits)) / BigInt(originalCents));
          if (creditsToDeduct > 0) {
            await tx.update(users).set({ credits: sql`GREATEST(0, ${users.credits} - ${creditsToDeduct})` }).where(eq(users.userId, transaction.userId));
            await tx.insert(transactions).values({
              userId: transaction.userId,
              type: 'refund',
              credits: -creditsToDeduct,
              amountCents: -refundCents,
              paymentIntentId,
              stripeEventId: event.id,
            });
            await tx.insert(userNotifications).values({
              userId: transaction.userId,
              type: 'refund',
              title: 'Refund Processed',
              message: `${creditsToDeduct} credits have been deducted from your account due to a refund`,
              data: { creditsDeducted: creditsToDeduct, refundCents, refundAmount: refundCents / 100, originalPaymentId: paymentIntentId },
            });
          }
          await tx.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId!));
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
          await dbWrite.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return c.json({ received: true, duplicate: true });
      }
    } else {
      if (event.type === "customer.subscription.created") await handleSubscriptionCreated(event);
      else if (event.type === "customer.subscription.updated") await handleSubscriptionUpdated(event);
      else if (event.type === "customer.subscription.deleted") await handleSubscriptionDeleted(event);
      else if (event.type === "customer.subscription.trial_will_end") await handleTrialWillEndEvent(event);
      else if (event.type === "invoice.payment_succeeded") await handleInvoicePaymentSucceeded(event);
      else if (event.type === "invoice.payment_failed") await handleInvoicePaymentFailed(event);

      if (webhookDeliveryId) {
        await dbWrite.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId));
      }
    }

    return c.json({ received: true });
  } catch (error) {
    if (webhookDeliveryId) {
      await dbWrite.update(webhookDeliveries).set({ status: 'failed', errorMessage: getErrorMessage(error), processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
    }
    return cApiError(c, 'Failed to process webhook', error);
  }
});

/**
 * POST /consume-credits
 *
 * Consumes credits from the authenticated user's balance for a paid action.
 * Supports idempotency keys to prevent duplicate charges. Validates the
 * `costKey` against the configured `CREDIT_COSTS` map. Applies a rate limit
 * of 60 requests per 60 seconds per user.
 *
 * @route POST /api/payments/consume-credits
 * @auth required
 * @body {string} costKey - The credit cost key (must exist in CREDIT_COSTS)
 * @body {string} [idempotencyKey] - Unique key to prevent duplicate consumption
 * @body {string} [context] - Context string for the credit usage record
 * @body {Object} [metadata] - Arbitrary metadata attached to the transaction
 * @returns {{ success: boolean, creditsConsumed: number, remainingCredits: number }}
 *
 * @example
 * ```typescript
 * // Request: { costKey: "image_generation", idempotencyKey: "uuid-123" }
 * // Response: { success: true, creditsConsumed: 10, remainingCredits: 90 }
 * ```
 */
router.post("/consume-credits", requireAuth, async (c) => {
  try {
    const { costKey, idempotencyKey, context, metadata } = c.get("body");
    if (!costKey || typeof costKey !== 'string') return cValidationError(c, "Valid costKey is required");
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) return cValidationError(c, "Metadata must be an object");

    const validCostKeys: CreditCostKey[] = Object.keys(CREDIT_COSTS) as CreditCostKey[];
    if (!validCostKeys.includes(costKey as CreditCostKey)) return cValidationError(c, `Invalid costKey: ${costKey}`);

    const userId = c.get("userId")!;

    const rateLimitResult = await checkRateLimit(`credit-consume-${userId}`, { maxRequests: 60, windowSeconds: 60 });
    if (!rateLimitResult.allowed) return cRateLimitError(c, "Too many credit consumption attempts.");

    let processingCleanup: (() => Promise<void>) | null = null;

    if (idempotencyKey) {
      const processing = await setIdempotencyProcessing({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      if (!processing.set) return cConflictError(c, "Request already in progress");
      processingCleanup = processing.cleanup;
      const idempotencyResult = await checkIdempotency<any>({ key: idempotencyKey, prefix: 'credit-consume', ttl: 300 });
      if (idempotencyResult.isDuplicate && idempotencyResult.cachedResult) {
        await processingCleanup();
        c.status(409);
        return c.json({ error: "Duplicate request", message: "This request has already been processed", ...idempotencyResult.cachedResult });
      }
    }

    try {
      const creditResult = await consumeCredits(userId, costKey as CreditCostKey, { context, metadata, req: { ip: getClientIp(c), get: (h: string) => c.req.header(h) } });
      if (idempotencyKey) {
        await storeIdempotencyResult(
          { key: idempotencyKey, prefix: 'credit-consume', ttl: 300 },
          { success: true, creditsConsumed: getCreditCost(costKey as CreditCostKey), remainingCredits: creditResult.remainingCredits }
        );
      }
      if (processingCleanup) await processingCleanup();
      return c.json({ success: true, creditsConsumed: getCreditCost(costKey as CreditCostKey), remainingCredits: creditResult.remainingCredits });
    } catch (error) {
      if (processingCleanup) await processingCleanup();
      if (isInsufficientCreditsError(error)) return handleInsufficientCreditsError(c, costKey);
      return cApiError(c, "Failed to consume credits", error);
    }
  } catch (error) {
    if (isInsufficientCreditsError(error)) return handleInsufficientCreditsError(c, c.get("body")?.costKey);
    return cApiError(c, "Failed to consume credits", error);
  }
});

/**
 * GET /transactions
 *
 * Returns the authenticated user's transaction history with pagination,
 * optional type/date filtering, and a summary aggregating totals.
 *
 * Filters: `type` (purchase|usage|refund|reward), `startDate`, `endDate`.
 * Pagination: `limit` (default 50) and `offset` (default 0).
 *
 * @route GET /api/payments/transactions
 * @auth required
 * @query {string} [limit=50] - Maximum number of transactions per page
 * @query {string} [offset=0] - Pagination offset
 * @query {string} [type] - Filter by transaction type
 * @query {string} [startDate] - Filter by start date (ISO string)
 * @query {string} [endDate] - Filter by end date (ISO string)
 * @returns {Object} Paginated response with `transactions` array and `summary`
 *
 * @example
 * ```typescript
 * // Response:
 * {
 *   transactions: [{ id: 1, type: "purchase", credits: 100, ... }],
 *   pagination: { page: 1, limit: 50, total: 1 },
 *   summary: { totalCreditsPurchased: 100, currentBalance: 200, ... }
 * }
 * ```
 */
router.get("/transactions", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const { limit = "50", offset = "0", type, startDate, endDate } = c.req.query();

    const conditions = [eq(transactions.userId, userId)];
    const transactionTypes: TransactionType[] = ["purchase", "usage", "refund", "reward"];
    if (type && transactionTypes.includes(type as TransactionType)) conditions.push(eq(transactions.type, type as TransactionType));
    if (startDate) conditions.push(sql`${transactions.createdAt} >= ${startDate}`);
    if (endDate) conditions.push(sql`${transactions.createdAt} <= ${endDate}`);

    const countResult = await dbRead.select({ count: sql<number>`count(*)::int` }).from(transactions).where(and(...conditions));
    const totalCount = countResult[0].count;

    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const userTransactions = await dbRead.select().from(transactions).where(and(...conditions)).orderBy(desc(transactions.createdAt)).limit(limitNum).offset(offsetNum);
    const formattedTransactions = userTransactions.map(tx => ({ ...tx, amountUsd: tx.amountCents != null ? tx.amountCents / 100 : null }));

    const summary = await dbRead
      .select({
        totalCreditsPurchased: sql<number>`SUM(CASE WHEN ${transactions.type} = 'purchase' THEN ${transactions.credits} ELSE 0 END)`,
        totalCreditsUsed: sql<number>`SUM(CASE WHEN ${transactions.type} = 'usage' THEN ABS(${transactions.credits}) ELSE 0 END)`,
        totalCreditsRewarded: sql<number>`SUM(CASE WHEN ${transactions.type} = 'reward' THEN ${transactions.credits} ELSE 0 END)`,
        totalAmountSpent: sql<number>`SUM(CASE WHEN ${transactions.type} = 'purchase' THEN ${transactions.amountCents} ELSE 0 END) / 100.0`,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .limit(1);

    const userBalance = await dbRead.select({ credits: users.credits }).from(users).where(eq(users.userId, userId)).limit(1);
    const pagination = calculatePaginationMeta(page, limitNum, totalCount);

    return c.json({
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
    return cApiError(c, "Failed to fetch transaction history", error);
  }
});

/**
 * GET /subscription-plans
 *
 * Returns the available subscription plan(s) with their benefits.
 * Currently exposes a single VIP plan configured via `VIP_SUBSCRIPTION`.
 *
 * @route GET /api/payments/subscription-plans
 * @returns {{ plans: Array<{ priceId: string, benefits: string[], ... }> }}
 *
 * @example
 * ```typescript
 * // Response: { plans: [{ priceId: "price_xxx", benefits: ["VIP badge", ...] }] }
 * ```
 */
router.get("/subscription-plans", async (c) => {
  try {
    return c.json({ plans: [{ ...VIP_SUBSCRIPTION, benefits: ["VIP badge", "2x check-in bonus", `+${VIP_BENEFITS.monthlyCredits} monthly credits`] }] });
  } catch (error) {
    return cApiError(c, "Failed to fetch subscription plans", error);
  }
});

/**
 * POST /subscription/cancel
 *
 * Cancels an active or trialing VIP subscription at period end.
 * Updates Stripe (sets `cancel_at_period_end`) and syncs the local database.
 * Does NOT immediately revoke access — the subscription remains active until
 * the current period ends.
 *
 * @route POST /api/payments/subscription/cancel
 * @auth required
 * @returns {{ success: boolean, message: string }}
 *
 * @example
 * ```typescript
 * // Response: { success: true, message: "Subscription will be canceled at period end" }
 * ```
 */
router.post("/subscription/cancel", requireAuth, async (c) => {
  try {
    const userId = c.get("user")!.id;
    const subscription = await dbRead
      .select({ id: subscriptions.id, stripeSubscriptionId: subscriptions.stripeSubscriptionId, status: subscriptions.status })
      .from(subscriptions)
      .innerJoin(users, eq(users.subscriptionId, subscriptions.id))
      .where(and(eq(users.userId, userId), inArray(subscriptions.status, ['active', 'trialing'])))
      .limit(1);

    if (subscription.length === 0) return cNotFoundError(c, "No active subscription found");

    await getStripe().subscriptions.update(subscription[0].stripeSubscriptionId, { cancel_at_period_end: true });
    await dbWrite.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, subscription[0].id));
    return c.json({ success: true, message: "Subscription will be canceled at period end" });
  } catch (error) {
    return cApiError(c, "Failed to cancel subscription", error);
  }
});

/**
 * GET /subscription/portal
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * subscription (upgrade, cancel, update payment method) directly in Stripe's
 * hosted UI. Looks up the Stripe customer ID from the subscription table
 * first, falling back to the user record.
 *
 * @route GET /api/payments/subscription/portal
 * @auth required
 * @query {string} [returnUrl] - Custom return URL after portal (must be same origin)
 * @returns {{ url: string }} Stripe Customer Portal URL
 *
 * @example
 * ```typescript
 * // Response: { url: "https://billing.stripe.com/..." }
 * ```
 */
router.get("/subscription/portal", requireAuth, async (c) => {
  try {
    const userId = c.get("user")!.id;
    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    const rawReturnUrl = c.req.query("returnUrl");
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
        return cValidationError(c, "Invalid returnUrl");
      }
    }

    let customerId: string | null = null;
    const subscription = await dbRead.select({ stripeCustomerId: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    if (subscription.length > 0 && subscription[0].stripeCustomerId) {
      customerId = subscription[0].stripeCustomerId;
    } else {
      const [user] = await dbRead.select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.userId, userId)).limit(1);
      customerId = user?.stripeCustomerId ?? null;
    }

    if (!customerId) return cNotFoundError(c, "No subscription found");

    const session = await getStripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return c.json({ url: session.url });
  } catch (error) {
    return cApiError(c, "Failed to create portal session", error);
  }
});

export default router;
