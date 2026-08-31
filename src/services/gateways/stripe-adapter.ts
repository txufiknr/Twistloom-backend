/**
 * Stripe PaymentGatewayAdapter implementation.
 *
 * Encapsulates all Stripe SDK interactions so route handlers never import
 * the Stripe SDK directly. Webhook event handlers live in
 * `stripe-webhook-handlers.ts`.
 */

import { PAYMENT_GATEWAY } from "../../types/payment.js";
import { getStripe } from "../../utils/stripe.js";
import type {
  PaymentGatewayAdapter,
  CreditPackCheckoutParams,
  SubscriptionCheckoutParams,
  TrialCheckoutParams,
  PortalParams,
  CheckoutResult,
} from "../../types/payment-gateway-adapter.js";

// ── Adapter ─────────────────────────────────────────────────────────────────

export class StripeAdapter implements PaymentGatewayAdapter {
  readonly gateway = PAYMENT_GATEWAY.stripe;
  readonly supportsTrials = true;
  readonly supportsPortal = true;

  async createCreditPackCheckout(params: CreditPackCheckoutParams): Promise<CheckoutResult> {
    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: params.email,
      line_items: [{ price: params.priceId, quantity: 1 }],
      metadata: {
        userId: params.userId,
        packId: params.packId,
        credits: params.credits.toString(),
      },
      client_reference_id: params.userId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return {
      url: session.url!,
      sessionId: session.id,
      gateway: PAYMENT_GATEWAY.stripe,
    };
  }

  async createSubscriptionCheckout(params: SubscriptionCheckoutParams): Promise<CheckoutResult> {
    let customerId = params.customerId;
    let customerCreated = false;

    // Auto-create Stripe customer if not provided
    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: params.email,
        metadata: { userId: params.userId },
      });
      customerId = customer.id;
      customerCreated = true;
    }

    if (!params.priceId) {
      throw new Error("VIP subscription priceId not configured");
    }

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: params.priceId, quantity: 1 }],
      metadata: { userId: params.userId, subscriptionType: "vip", isTrial: "false" },
      client_reference_id: params.userId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      subscription_data: { metadata: { userId: params.userId, isTrial: "false" } },
    });

    return {
      url: session.url!,
      sessionId: session.id,
      gateway: PAYMENT_GATEWAY.stripe,
      ...(customerCreated ? { customerId } : {}),
    };
  }

  async createTrialCheckout(params: TrialCheckoutParams): Promise<CheckoutResult> {
    let customerId = params.customerId;
    let customerCreated = false;

    // Auto-create Stripe customer if not provided
    if (!customerId) {
      const customer = await getStripe().customers.create({
        email: params.email,
        metadata: { userId: params.userId },
      });
      customerId = customer.id;
      customerCreated = true;
    }

    if (!params.priceId) {
      throw new Error("VIP subscription priceId not configured");
    }

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: params.priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: params.trialPeriodDays,
        trial_settings: { end_behavior: { missing_payment_method: params.trialEndBehavior ?? "pause" } },
        metadata: { userId: params.userId, isTrial: "true" },
      },
      payment_method_collection: "always",
      metadata: { userId: params.userId, subscriptionType: "vip", isTrial: "true" },
      client_reference_id: params.userId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return {
      url: session.url!,
      sessionId: session.id,
      gateway: PAYMENT_GATEWAY.stripe,
      ...(customerCreated ? { customerId } : {}),
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await getStripe().subscriptions.update(providerSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async createPortalSession(params: PortalParams): Promise<{ url: string }> {
    const session = await getStripe().billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return { url: session.url };
  }
}
