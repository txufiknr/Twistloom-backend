/**
 * Payment utility helpers for gateway validation, normalization, and currency formatting.
 */

import {
  paymentGateways,
  PAYMENT_GATEWAY,
  isPaymentGateway,
  type PaymentGateway,
} from "../types/payment.js";
import {
  STRIPE_MONTHLY_PRICE_USD,
  XENDIT_MONTHLY_PRICE_IDR,
  VIP_SUBSCRIPTION,
} from "../config/subscription.js";

export { paymentGateways, PAYMENT_GATEWAY, isPaymentGateway, type PaymentGateway };

/**
 * Validates and normalizes an unknown gateway parameter (e.g. from query/body parameters).
 * Returns the typed `PaymentGateway` or `null` if invalid or not specified.
 *
 * @param value - Unknown input string from request query or payload
 * @returns Validated `PaymentGateway` or `null`
 *
 * @example
 * ```typescript
 * const gateway = parsePaymentGateway(c.req.query("gateway"));
 * if (gateway) {
 *   conditions.push(eq(transactions.gateway, gateway));
 * }
 * ```
 */
export function parsePaymentGateway(value: unknown): PaymentGateway | null {
  if (typeof value === "string" && isPaymentGateway(value)) {
    return value;
  }
  return null;
}

/**
 * Formats a payment amount with its localized currency symbol.
 * - Stripe (USD): `amountCents` is in cents (e.g., 999 -> "$9.99")
 * - Xendit (IDR): `amountCents` is stored as whole Rupiah (e.g., 150000 -> "Rp150.000")
 *
 * @param amountCents - Numeric amount from DB or payload
 * @param gateway - Gateway identifier ('stripe' | 'xendit')
 * @returns Formatted string with currency prefix
 */
export function formatPaymentAmount(amountCents: number | null | undefined, gateway: PaymentGateway): string {
  const amount = Number(amountCents ?? 0);
  if (gateway === PAYMENT_GATEWAY.xendit) {
    return `Rp${amount.toLocaleString("id-ID")}`;
  }
  return `$${(amount / 100).toFixed(2)}`;
}

/**
 * Returns the standard ISO 4217 currency code for a given gateway.
 *
 * @param gateway - Gateway identifier ('stripe' | 'xendit')
 * @returns 'IDR' for Xendit, 'USD' for Stripe
 */
export function getGatewayCurrency(gateway: PaymentGateway): "USD" | "IDR" {
  return gateway === PAYMENT_GATEWAY.xendit ? "IDR" : "USD";
}

/**
 * Returns formatted VIP subscription plan name with pricing for a given gateway.
 *
 * @param gateway - Gateway identifier ('stripe' | 'xendit')
 * @returns Formatted plan name string, e.g. "Twistloom VIP ($9.99/mo)" or "Twistloom VIP (Rp 150.000/bln)"
 */
export function getSubscriptionPlanName(gateway: PaymentGateway): string {
  if (gateway === PAYMENT_GATEWAY.xendit) {
    return `${VIP_SUBSCRIPTION.name} (Rp ${XENDIT_MONTHLY_PRICE_IDR.toLocaleString("id-ID")}/bln)`;
  }
  return `${VIP_SUBSCRIPTION.name} ($${STRIPE_MONTHLY_PRICE_USD.toFixed(2)}/mo)`;
}
