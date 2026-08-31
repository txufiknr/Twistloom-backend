/**
 * Gateway-agnostic adapter interface for payment providers.
 *
 * Each payment gateway (Stripe, Xendit, Razorpay, etc.) implements this
 * contract. Route handlers call adapter methods instead of inline SDK calls,
 * making it trivial to add or remove gateways.
 *
 * @see docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md for the full
 *      gateway adapter pattern rationale.
 */

import type { PaymentGateway } from "./payment.js";

// ── Checkout Parameters ─────────────────────────────────────────────────────

export interface CreditPackCheckoutParams {
  userId: string;
  email: string;
  name?: string;
  packId: string;
  /** Provider-specific price ID (e.g. Stripe `price_xxx`) */
  priceId: string;
  /** Pack price in the gateway's native currency (USD for Stripe, IDR for Xendit) */
  priceAmount: number;
  credits: number;
  successUrl: string;
  cancelUrl: string;
}

export interface SubscriptionCheckoutParams {
  userId: string;
  email: string;
  name?: string;
  /** Existing provider customer ID (if already created) */
  customerId?: string;
  /** Provider-specific price ID (e.g. Stripe `price_xxx`) */
  priceId?: string;
  metadata?: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface TrialCheckoutParams {
  userId: string;
  email: string;
  name?: string;
  /** Existing provider customer ID (if already created) */
  customerId?: string;
  /** Provider-specific price ID */
  priceId?: string;
  trialPeriodDays: number;
  trialEndBehavior?: string;
  metadata?: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalParams {
  customerId: string;
  returnUrl: string;
}

// ── Return Types ────────────────────────────────────────────────────────────

export interface CheckoutResult {
  url: string;
  sessionId: string;
  gateway: PaymentGateway;
  /** If the adapter auto-created a customer, return the ID so the route can persist it */
  customerId?: string;
}

// ── Adapter Interface ───────────────────────────────────────────────────────

export interface PaymentGatewayAdapter {
  /** Gateway identifier matching `PaymentGateway` type */
  readonly gateway: PaymentGateway;

  // ── Checkout ────────────────────────────────────────────────────────────

  /** Create a one-time credit pack checkout session */
  createCreditPackCheckout(params: CreditPackCheckoutParams): Promise<CheckoutResult>;

  /** Create a recurring subscription checkout session */
  createSubscriptionCheckout(params: SubscriptionCheckoutParams): Promise<CheckoutResult>;

  /** Create a free trial subscription checkout (optional — not all gateways support trials) */
  createTrialCheckout?(params: TrialCheckoutParams): Promise<CheckoutResult>;

  // ── Subscription Management ─────────────────────────────────────────────

  /** Cancel a subscription at period end */
  cancelSubscription(providerSubscriptionId: string): Promise<void>;

  /** Create a customer portal session for self-service management (optional) */
  createPortalSession?(params: PortalParams): Promise<{ url: string }>;

  // ── Webhook Handling ────────────────────────────────────────────────────

  // ── Capability Flags ────────────────────────────────────────────────────

  /** Whether this gateway supports free trials */
  readonly supportsTrials: boolean;

  /** Whether this gateway offers a customer self-service portal */
  readonly supportsPortal: boolean;
}
