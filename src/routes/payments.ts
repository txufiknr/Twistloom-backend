/**
 * Payments Routes Module (Hono)
 *
 * Checkout sessions, credit packs, subscriptions, and webhooks for all
 * payment gateways. DB is gateway-agnostic; routes delegate to gateway
 * adapters via `getGatewayAdapter()`.
 */

import { Hono, type Context } from "hono";
import type Stripe from "stripe";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import { createPaginatedResponse, calculatePaginationMeta } from "../utils/pagination.js";
import { requireAuth, optionalAuth } from "../middleware/nextauth.js";
import { dbRead, dbWrite } from "../db/client.js";
import { users, transactions, webhookDeliveries, subscriptions } from "../db/schema.js";
import { CREDIT_PACKS, type CreditCostKey, CREDIT_COSTS } from "../config/credits.js";
import type { TransactionType } from "../types/credits.js";
import { getErrorMessage, cApiError, cConflictError, cNotFoundError, cValidationError, cRateLimitError } from "../utils/error.js";
import { checkRateLimit, checkIdempotency, storeIdempotencyResult, constructSafeUrl, setIdempotencyProcessing } from "../utils/redis.js";
import { consumeCredits, getCreditCost } from "../services/credits.js";
import { CREDIT_ERRORS, isInsufficientCreditsError } from "../config/errors.js";
import { isUniqueConstraintError } from "../utils/retry.js";
import { hasActiveVipSubscription, isTrialEligible } from "../services/subscription.js";
import type { AuthUser } from "../types/express.js";
import { VIP_BENEFITS, VIP_SUBSCRIPTION, VIP_TRIAL } from "../config/subscription.js";
import { getXenditPackPriceIdr, XENDIT_CONFIG } from "../config/xendit.js";
import {
  verifyXenditCallbackToken,
  type XenditInvoice,
  type XenditRecurringPlan,
  type XenditCycleSucceededPayload,
  type XenditCycleFailedPayload,
  type XenditPlanDeactivatedPayload,
} from "../utils/xendit.js";
import {
  finalizeXenditWebhookDelivery,
  handleXenditCycleSucceeded,
  handleXenditCycleFailed,
  handleXenditInvoicePaid,
  handleXenditThanksInvoicePaid,
  handleXenditPlanActivated,
  handleXenditPlanDeactivated,
  trackXenditWebhookDelivery,
} from "../services/xendit.js";
import { getGatewayAdapter, initGatewayAdapters } from "../services/gateways/registry.js";
import {
  handleSubscriptionCreated as stripeSubCreated,
  handleSubscriptionUpdated as stripeSubUpdated,
  handleSubscriptionDeleted as stripeSubDeleted,
  handleInvoicePaymentSucceeded as stripeInvoiceSucceeded,
  handleInvoicePaymentFailed as stripeInvoiceFailed,
  handleTrialWillEndEvent as stripeTrialWillEnd,
  handleCheckoutSessionCompleted as stripeCheckoutCompleted,
  handleChargeRefunded as stripeChargeRefunded,
} from "../services/gateways/stripe-webhook-handlers.js";
import type { AppEnv } from "../hono/env.js";
import { getClientIp } from "../hono/express-shim.js";
import { PAYMENT_GATEWAY, parsePaymentGateway as parseGateway } from "../utils/payment.js";

// Initialize gateway adapters at module load
initGatewayAdapters();

/**
 * Builds success/cancel URLs from user-provided returnUrl or fallback paths.
 * Validates returnUrl origin against FRONTEND_URL to prevent open redirects.
 *
 * @param returnUrl - User-provided return URL (optional)
 * @param successPath - Path to use when returnUrl is not provided
 * @param cancelPath - Path to use when returnUrl is not provided
 * @param baseUrl - FRONTEND_URL env var
 * @param paramKey - Query parameter key ('payment' for credit packs, 'subscription' for VIP)
 * @returns Validated success and cancel URLs
 */
function buildReturnUrls(
  returnUrl: string | undefined,
  successPath: string | undefined,
  cancelPath: string | undefined,
  baseUrl: string,
  paramKey: 'payment' | 'subscription',
): { successUrl: string; cancelUrl: string } {
  if (returnUrl) {
    try {
      const returnUrlObj = new URL(returnUrl, baseUrl);
      const baseUrlObj = new URL(baseUrl);
      if (returnUrlObj.origin !== baseUrlObj.origin) {
        throw new Error("Cross-origin returnUrl not allowed");
      }
      const successUrl = new URL(returnUrl, baseUrl);
      successUrl.searchParams.set(paramKey, 'success');
      const cancelUrl = new URL(returnUrl, baseUrl);
      cancelUrl.searchParams.set(paramKey, 'cancel');
      return { successUrl: successUrl.toString(), cancelUrl: cancelUrl.toString() };
    } catch {
      // Invalid returnUrl — fall back to defaults
    }
  }
  return {
    successUrl: constructSafeUrl(successPath, baseUrl, `/dashboard?${paramKey}=success`),
    cancelUrl: constructSafeUrl(cancelPath, baseUrl, `/pricing?${paramKey}=cancel`),
  };
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

function requireUser(c: Context<AppEnv>): AuthUser {
  const user = c.get("user");
  if (!user) {
    throw new Error("Unauthorized: user context is missing");
  }
  return user;
}

function requireUserId(c: Context<AppEnv>): string {
  const userId = c.get("userId") ?? c.get("user")?.id;
  if (!userId) {
    throw new Error("Unauthorized: user id is missing");
  }
  return userId;
}

const router = new Hono<AppEnv>();

// Stripe webhook handlers are imported from `stripe-webhook-handlers.ts`
// and aliased above (stripeSubCreated, stripeSubUpdated, etc.).

/**
 * GET /credit-packs
 *
 * Returns available credit packs for purchase. Optional `gateway` query selects
 * currency/pricing (`stripe` = USD, `xendit` = IDR).
 *
 * @route GET /api/payments/credit-packs
 * @query {string} [gateway=stripe] - `stripe` | `xendit`
 * @returns {Object[]} Credit packs with gateway-aware pricing fields
 */
router.get("/credit-packs", async (c) => {
  try {
    const rawGateway = c.req.query("gateway");
    const gatewayParam = parseGateway(rawGateway || PAYMENT_GATEWAY.stripe);
    if (!gatewayParam) return cValidationError(c, "Invalid gateway (use stripe or xendit)");

    if (gatewayParam === PAYMENT_GATEWAY.xendit) {
      if (!XENDIT_CONFIG.enabled) {
        console.warn(`[credit-packs] ⚠️ Xendit gateway is not enabled — returning 400`);
        return cValidationError(c, "Xendit gateway is not enabled");
      }
      const packs = CREDIT_PACKS.map((pack) => ({
        id: pack.id,
        title: pack.title,
        tagline: pack.tagline,
        description: pack.description,
        credits: pack.credits,
        priceIdr: getXenditPackPriceIdr(pack.id),
        currency: "IDR" as const,
        gateway: PAYMENT_GATEWAY.xendit,
        badge: pack.badge,
        color: pack.color,
      }));
      return c.json(packs);
    }

    const packs = CREDIT_PACKS.map((pack) => ({
      id: pack.id,
      title: pack.title,
      tagline: pack.tagline,
      description: pack.description,
      credits: pack.credits,
      priceUSD: pack.priceUSD,
      priceId: pack.priceId,
      productId: pack.productId,
      currency: "USD" as const,
      gateway: PAYMENT_GATEWAY.stripe,
      badge: pack.badge,
      color: pack.color,
    }));
    return c.json(packs);
  } catch (error) {
    return cApiError(c, "Failed to fetch credit packs", error);
  }
});

/**
 * POST /create-checkout-session
 *
 * Creates a one-time credit pack checkout via Stripe Checkout or Xendit Invoice.
 * Validates the pack ID, enforces a 10-second rate limit per user, constructs
 * safe return URLs (with origin validation for `returnUrl`), and returns the
 * hosted checkout URL.
 *
 * @route POST /api/payments/create-checkout-session
 * @auth required
 * @body {string} packId - ID of the credit pack to purchase
 * @body {string} [gateway=stripe] - `stripe` | `xendit`
 * @body {string} [successPath] - Fallback success redirect path
 * @body {string} [cancelPath] - Fallback cancel redirect path
 * @body {string} [returnUrl] - Fully-qualified return URL (cross-origin rejected)
 * @returns {{ url: string, sessionId: string, gateway: string }} Hosted checkout URL
 */
router.post("/create-checkout-session", requireAuth, async (c) => {
  try {
    const { packId, successPath, cancelPath, returnUrl, gateway: gatewayBody } = c.get("body");
    if (!packId) return cValidationError(c, "Credit pack ID is required");

    const gateway = parseGateway(gatewayBody ?? PAYMENT_GATEWAY.stripe);
    if (!gateway) return cValidationError(c, "Invalid gateway (use stripe or xendit)");

    const user = requireUser(c);
    const { id: userId, email } = user;

    const rateLimitResult = await checkRateLimit(`checkout-session-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    const { successUrl, cancelUrl } = buildReturnUrls(returnUrl, successPath, cancelPath, baseUrl, 'payment');

    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) return cNotFoundError(c, "Credit pack not found");

    const adapter = getGatewayAdapter(gateway);
    const result = await adapter.createCreditPackCheckout({
      userId,
      email,
      name: user.name,
      packId: pack.id,
      priceId: pack.priceId,
      priceAmount: pack.priceUSD,
      credits: pack.credits,
      successUrl,
      cancelUrl,
    });

    return c.json({ url: result.url, sessionId: result.sessionId, gateway });
  } catch (error) {
    return cApiError(c, "Failed to create checkout session", error);
  }
});

/**
 * POST /create-subscription-checkout
 *
 * Creates a VIP subscription checkout. v1 supports Stripe only; `gateway: xendit`
 * is rejected until Phase 2b. Accepts optional `gateway` for forward-compatible clients.
 *
 * @route POST /api/payments/create-subscription-checkout
 * @auth required
 * @body {string} [gateway=stripe] - `stripe` | `xendit` (xendit not available yet)
 * @body {string} [successPath] - Fallback success redirect path
 * @body {string} [cancelPath] - Fallback cancel redirect path
 * @body {string} [returnUrl] - Fully-qualified return URL (cross-origin rejected)
 * @returns {{ url: string, sessionId: string, gateway: string }} Hosted checkout URL
 */
router.post("/create-subscription-checkout", requireAuth, async (c) => {
  try {
    const { successPath, cancelPath, returnUrl, gateway: gatewayBody } = c.get("body");

    const gateway = parseGateway(gatewayBody ?? PAYMENT_GATEWAY.stripe);
    if (!gateway) return cValidationError(c, "Invalid gateway (use stripe or xendit)");

    const userProfile = requireUser(c);
    const userId = userProfile.id;

    const rateLimitResult = await checkRateLimit(`subscription-checkout-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    const hasActiveSub = await hasActiveVipSubscription(userId);
    if (hasActiveSub) return cValidationError(c, "You already have an active VIP subscription");

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) return cApiError(c, "Frontend URL not configured");

    const { successUrl, cancelUrl } = buildReturnUrls(returnUrl, successPath, cancelPath, baseUrl, 'subscription');

    // Resolve Stripe customer ID for subscription gateways that need it
    let customerId: string | undefined;
    if (gateway === PAYMENT_GATEWAY.stripe) {
      if (!VIP_SUBSCRIPTION.priceId) return cApiError(c, "VIP subscription not configured");
      const [user] = await dbRead.select({ customerId: users.customerId, email: users.email }).from(users).where(eq(users.userId, userId)).limit(1);
      customerId = user?.customerId ?? undefined;
    }

    const adapter = getGatewayAdapter(gateway);
    const result = await adapter.createSubscriptionCheckout({
      userId,
      email: userProfile.email,
      name: userProfile.name,
      customerId,
      priceId: VIP_SUBSCRIPTION.priceId,
      successUrl,
      cancelUrl,
    });

    // Persist auto-created customer ID for future use
    if (result.customerId && !customerId) {
      await dbWrite.update(users).set({ customerId: result.customerId }).where(eq(users.userId, userId));
    }

    return c.json({ url: result.url, sessionId: result.sessionId, gateway });
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
    const userId = requireUserId(c);
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
  try {
    const { successPath, cancelPath, returnUrl } = c.get("body");
    const user = requireUser(c);
    const userId = user.id;

    const rateLimitResult = await checkRateLimit(`trial-checkout-${userId}`, { maxRequests: 1, windowSeconds: 10 });
    if (!rateLimitResult.allowed) {
      return cRateLimitError(c, "Too many checkout session attempts. Please wait a few seconds before trying again.");
    }

    if (!VIP_TRIAL.enabled) {
      return cValidationError(c, "Trials are not currently available");
    }

    const eligible = await isTrialEligible(userId);
    if (!eligible) {
      return cValidationError(c, "Trial not available for this account");
    }

    const baseUrl = process.env.FRONTEND_URL;
    if (!baseUrl) {
      return cApiError(c, "Frontend URL not configured");
    }

    const { successUrl, cancelUrl } = buildReturnUrls(returnUrl, successPath, cancelPath, baseUrl, 'subscription');

    if (!VIP_SUBSCRIPTION.priceId) {
      return cApiError(c, "VIP subscription not configured");
    }

    // Resolve Stripe customer ID
    const [dbUser] = await dbRead.select({ customerId: users.customerId, email: users.email }).from(users).where(eq(users.userId, userId)).limit(1);
    const customerId = dbUser?.customerId ?? undefined;

    const adapter = getGatewayAdapter(PAYMENT_GATEWAY.stripe);
    if (!adapter.createTrialCheckout) {
      return cApiError(c, "Trial checkout not supported for this gateway");
    }

    const result = await adapter.createTrialCheckout({
      userId,
      email: user.email,
      name: user.name,
      customerId,
      priceId: VIP_SUBSCRIPTION.priceId,
      trialPeriodDays: VIP_TRIAL.trialPeriodDays,
      trialEndBehavior: VIP_TRIAL.endBehavior,
      successUrl,
      cancelUrl,
    });

    // Persist auto-created customer ID for future use
    if (result.customerId && !customerId) {
      await dbWrite.update(users).set({ customerId: result.customerId }).where(eq(users.userId, userId));
    }

    return c.json({ url: result.url, sessionId: result.sessionId });
  } catch (error) {
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
        gateway: subscriptions.gateway,
        providerSubscriptionId: subscriptions.providerSubscriptionId,
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
        gateway: sub.gateway,
        providerSubscriptionId: sub.providerSubscriptionId,
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
    const { getStripe } = await import("../utils/stripe.js");
    const event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);

    const existingDelivery = await dbRead.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.gateway, PAYMENT_GATEWAY.stripe), eq(webhookDeliveries.eventId, event.id))).limit(1);
    if (existingDelivery.length > 0 && existingDelivery[0].status === 'success') {
      console.log(`[stripe] 🔄 Webhook already processed successfully: ${event.id}`);
      return c.json({ received: true, duplicate: true });
    }

    if (existingDelivery.length === 0) {
      try {
        const [deliveryRecord] = await dbWrite.insert(webhookDeliveries).values({
          gateway: PAYMENT_GATEWAY.stripe,
          eventId: event.id,
          eventType: event.type,
          status: 'retrying',
        }).returning();
        webhookDeliveryId = deliveryRecord.id;
      } catch (insertError) {
        if (isUniqueConstraintError(insertError)) {
          const [dupRecord] = await dbRead.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.gateway, PAYMENT_GATEWAY.stripe), eq(webhookDeliveries.eventId, event.id))).limit(1);
          webhookDeliveryId = dupRecord?.id ?? null;
          console.log(`[stripe] 🔄 Concurrent delivery race resolved at webhookDelivery INSERT: ${event.id}`);
        } else {
          throw insertError;
        }
      }
    } else {
      webhookDeliveryId = existingDelivery[0].id;
    }

    if (event.type === "checkout.session.completed" && (event.data.object as Stripe.Checkout.Session).mode === "payment") {
      const result = await stripeCheckoutCompleted(event, webhookDeliveryId);
      if (result.duplicate) {
        if (webhookDeliveryId) {
          await dbWrite.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return c.json({ received: true, duplicate: true });
      }
    } else if (event.type === "charge.refunded") {
      const result = await stripeChargeRefunded(event, webhookDeliveryId);
      if (result.duplicate) {
        if (webhookDeliveryId) {
          await dbWrite.update(webhookDeliveries).set({ status: 'success', processedAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, webhookDeliveryId)).catch(console.error);
        }
        return c.json({ received: true, duplicate: true });
      }
    } else {
      if (event.type === "customer.subscription.created") await stripeSubCreated(event);
      else if (event.type === "customer.subscription.updated") await stripeSubUpdated(event);
      else if (event.type === "customer.subscription.deleted") await stripeSubDeleted(event);
      else if (event.type === "customer.subscription.trial_will_end") await stripeTrialWillEnd(event);
      else if (event.type === "invoice.payment_succeeded") await stripeInvoiceSucceeded(event);
      else if (event.type === "invoice.payment_failed") await stripeInvoiceFailed(event);

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
 * POST /xendit/webhook
 *
 * Receives Xendit Invoice callbacks. Verifies `x-callback-token`, tracks delivery
 * for idempotency, and awards credits on paid invoices.
 *
 * Configure callback URL in Xendit Dashboard → Settings → Callbacks:
 * `https://<backend>/api/payments/xendit/webhook`
 *
 * @route POST /api/payments/xendit/webhook
 * @returns {{ received: boolean, duplicate?: boolean }}
 */
router.post("/xendit/webhook", async (c) => {
  let webhookDeliveryId: string | null = null;

  try {
    if (!XENDIT_CONFIG.enabled) {
      return cValidationError(c, "Xendit gateway is not enabled");
    }

    const callbackToken = c.req.header("x-callback-token");
    if (!verifyXenditCallbackToken(callbackToken)) {
      return c.json({ error: "Invalid callback token" }, 401);
    }

    const webhookRateLimit = await checkRateLimit("xendit-webhook-global", {
      maxRequests: 120,
      windowSeconds: 60,
    });
    if (!webhookRateLimit.allowed) {
      return cRateLimitError(c, "Webhook rate limit exceeded");
    }

    const body = (await c.req.json()) as Record<string, unknown>;

    // Invoice callbacks usually POST the invoice object; some products wrap event name.
    // Recurring callbacks have an `event` field (e.g. "recurring.plan.activation").
    const eventType =
      typeof body.event === "string"
        ? body.event
        : typeof body.status === "string"
          ? `invoice.${body.status.toLowerCase()}`
          : "invoice.callback";

    const eventId =
      (typeof body.id === "string" && body.id) ||
      (typeof body.external_id === "string" && body.external_id) ||
      `xendit-${Date.now()}`;

    const tracked = await trackXenditWebhookDelivery(eventId, eventType);
    webhookDeliveryId = tracked.deliveryId;

    if (tracked.alreadySuccess) {
      console.log(`[xendit] 🔄 Webhook already processed successfully: ${eventId}`);
      return c.json({ received: true, duplicate: true });
    }

    const rawStatus = typeof body.status === "string" ? body.status : "";
    const status = rawStatus.toUpperCase();
    const isPaid =
      eventType === "invoice.paid" ||
      status === "PAID" ||
      status === "SETTLED";

    if (isPaid) {
      const invoice = body as XenditInvoice;
      const externalId = typeof invoice.external_id === "string" ? invoice.external_id : "";
      const meta = (invoice.metadata as Record<string, unknown>) || {};
      const isThanks = externalId.startsWith("thanks-") || meta.type === "thanks";

      const result = isThanks
        ? await handleXenditThanksInvoicePaid(invoice, eventId)
        : await handleXenditInvoicePaid(invoice, eventId);

      await finalizeXenditWebhookDelivery(webhookDeliveryId, "success");
      return c.json({ received: true, duplicate: result.duplicate });
    }

    // ── Recurring subscription events ────────────────────────────────
    try {
      switch (eventType) {
        case "recurring.plan.activation": {
          await handleXenditPlanActivated(body as XenditRecurringPlan, eventId);
          break;
        }
        case "recurring.cycle.succeeded": {
          await handleXenditCycleSucceeded(body as XenditCycleSucceededPayload, eventId);
          break;
        }
        case "recurring.cycle.failed": {
          await handleXenditCycleFailed(body as XenditCycleFailedPayload, eventId);
          break;
        }
        case "recurring.plan.deactivation": {
          await handleXenditPlanDeactivated(body as XenditPlanDeactivatedPayload, eventId);
          break;
        }
        default: {
          // Non-paid statuses (PENDING, EXPIRED, etc.) or unhandled recurring events — ack
          console.log(`[xendit] ℹ️ Unhandled event: ${eventType}`);
        }
      }
    } catch (err) {
      console.error(`[xendit] ❌ Error processing event ${eventType}:`, err);
      await finalizeXenditWebhookDelivery(webhookDeliveryId, "failed", getErrorMessage(err));
      return cApiError(c, `Failed to process ${eventType}`, err);
    }

    await finalizeXenditWebhookDelivery(webhookDeliveryId, "success");
    return c.json({ received: true });
  } catch (error) {
    if (webhookDeliveryId) {
      await finalizeXenditWebhookDelivery(
        webhookDeliveryId,
        "failed",
        getErrorMessage(error)
      ).catch(console.error);
    }
    return cApiError(c, "Failed to process Xendit webhook", error);
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
    const { costKey, idempotencyKey, context, metadata } = c.get("body") ?? {};
    if (!costKey || typeof costKey !== 'string') return cValidationError(c, "Valid costKey is required");
    if (metadata && typeof metadata !== 'object' && !Array.isArray(metadata)) return cValidationError(c, "Metadata must be an object");

    const validCostKeys: CreditCostKey[] = Object.keys(CREDIT_COSTS) as CreditCostKey[];
    if (!validCostKeys.includes(costKey as CreditCostKey)) return cValidationError(c, `Invalid costKey: ${costKey}`);

    const userId = requireUserId(c);

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
    const userId = requireUserId(c);
    const { limit = "50", offset = "0", type, startDate, endDate } = c.req.query();

    const conditions = [eq(transactions.userId, userId)];
    const transactionTypes: TransactionType[] = ["purchase", "usage", "refund", "reward", "first_purchase_bonus"];
    if (type && transactionTypes.includes(type as TransactionType)) conditions.push(eq(transactions.type, type as TransactionType));
    if (startDate) conditions.push(sql`${transactions.createdAt} >= ${startDate}`);
    if (endDate) conditions.push(sql`${transactions.createdAt} <= ${endDate}`);

    const countResult = await dbRead.select({ count: sql<number>`count(*)::int` }).from(transactions).where(and(...conditions));
    const totalCount = countResult[0].count;

    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(offset) || 0, 0);
    const page = Math.floor(offsetNum / limitNum) + 1;

    const userTransactions = await dbRead.select().from(transactions).where(and(...conditions)).orderBy(desc(transactions.createdAt)).limit(limitNum).offset(offsetNum);
    // Stripe stores USD cents in amountCents; Xendit credit packs store whole IDR in amountCents.
    const formattedTransactions = userTransactions.map((tx) => {
      const isXendit = tx.gateway === PAYMENT_GATEWAY.xendit;
      return {
        ...tx,
        amountUsd: !isXendit && tx.amountCents != null ? tx.amountCents / 100 : null,
        amountIdr: isXendit && tx.amountCents != null ? tx.amountCents : null,
      };
    });

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
 * Returns VIP plan metadata. Optional `gateway` selects currency (Stripe USD today;
 * Xendit IDR reserved for Phase 2b and marked `available: false`).
 *
 * @route GET /api/payments/subscription-plans
 * @query {string} [gateway=stripe] - `stripe` | `xendit`
 * @returns {{ plans: Array<{ currency, gateway, benefits, available?, ... }> }}
 */
router.get("/subscription-plans", async (c) => {
  try {
    const gatewayParam = parseGateway(c.req.query("gateway") || PAYMENT_GATEWAY.stripe);
    if (!gatewayParam) return cValidationError(c, "Invalid gateway (use stripe or xendit)");

    const benefits = [
      "VIP badge",
      "2x check-in bonus",
      `+${VIP_BENEFITS.monthlyCredits} monthly credits`,
    ];

    if (gatewayParam === PAYMENT_GATEWAY.xendit) {
      if (!XENDIT_CONFIG.enabled) {
        return cValidationError(c, "Xendit gateway is not enabled");
      }
      return c.json({
        plans: [
          {
            id: VIP_SUBSCRIPTION.id,
            name: VIP_SUBSCRIPTION.name,
            description: VIP_SUBSCRIPTION.description,
            priceIdr: XENDIT_CONFIG.subscription.amountIdr,
            currency: "IDR" as const,
            gateway: PAYMENT_GATEWAY.xendit,
            monthlyCredits: VIP_SUBSCRIPTION.monthlyCredits,
            checkInMultiplier: VIP_SUBSCRIPTION.checkInMultiplier,
            benefits,
            available: true,
          },
        ],
      });
    }

    return c.json({
      plans: [
        {
          id: VIP_SUBSCRIPTION.id,
          name: VIP_SUBSCRIPTION.name,
          description: VIP_SUBSCRIPTION.description,
          priceUSD: VIP_SUBSCRIPTION.priceUSD,
          monthlyCredits: VIP_SUBSCRIPTION.monthlyCredits,
          checkInMultiplier: VIP_SUBSCRIPTION.checkInMultiplier,
          currency: "USD" as const,
          gateway: PAYMENT_GATEWAY.stripe,
          benefits,
          available: true,
        },
      ],
    });
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
    const userId = requireUserId(c);
    const subscription = await dbRead
      .select({
        id: subscriptions.id,
        gateway: subscriptions.gateway,
        providerSubscriptionId: subscriptions.providerSubscriptionId,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .innerJoin(users, eq(users.subscriptionId, subscriptions.id))
      .where(and(eq(users.userId, userId), inArray(subscriptions.status, ['active', 'trialing'])))
      .limit(1);

    if (subscription.length === 0) return cNotFoundError(c, "No active subscription found");

    const sub = subscription[0];
    const adapter = getGatewayAdapter(sub.gateway);
    await adapter.cancelSubscription(sub.providerSubscriptionId);
    await dbWrite.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, sub.id));
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
    const userId = requireUserId(c);
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
    const subscription = await dbRead.select({ providerCustomerId: subscriptions.providerCustomerId }).from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.createdAt)).limit(1);
    if (subscription.length > 0 && subscription[0].providerCustomerId) {
      customerId = subscription[0].providerCustomerId;
    } else {
      const [user] = await dbRead.select({ customerId: users.customerId }).from(users).where(eq(users.userId, userId)).limit(1);
      customerId = user?.customerId ?? null;
    }

    if (!customerId) return cNotFoundError(c, "No subscription found");

    const adapter = getGatewayAdapter(PAYMENT_GATEWAY.stripe);
    if (!adapter.supportsPortal || !adapter.createPortalSession) {
      return cApiError(c, "Portal not supported for this gateway");
    }
    const result = await adapter.createPortalSession({ customerId, returnUrl });
    return c.json({ url: result.url });
  } catch (error) {
    return cApiError(c, "Failed to create portal session", error);
  }
});

// ── Voucher Redemption ───────────────────────────────────────────────────────

/**
 * POST /payments/vouchers/redeem
 *
 * Redeem a credit voucher code. Rate-limited, idempotent, single-use.
 */
router.post("/vouchers/redeem", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Unauthorized", null, 401);

    const body = c.get("body") as { code?: string; idempotencyKey?: string };
    if (!body?.code || !body?.idempotencyKey) {
      return cValidationError(c, "code and idempotencyKey are required");
    }

    const { redeemVoucher } = await import("../services/voucher.js");
    const result = await redeemVoucher(userId, body.code, body.idempotencyKey);
    return c.json(result);
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (err.code) {
      return cApiError(c, err.message || "Failed to redeem voucher", { code: err.code }, 422);
    }
    return cApiError(c, "Failed to redeem voucher", error);
  }
});

export default router;
