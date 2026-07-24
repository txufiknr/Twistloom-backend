/**
 * Payment gateway identifiers used across checkout, webhooks, and DB rows.
 *
 * Stripe handles international card checkout + VIP subscriptions.
 * Xendit handles Indonesia local methods (credit packs v1; subscriptions later).
 */
export const paymentGateways = ["stripe", "xendit"] as const;

/**
 * Supported payment gateways.
 *
 * @example
 * ```typescript
 * const gateway: PaymentGateway = "stripe";
 * ```
 */
export type PaymentGateway = (typeof paymentGateways)[number];

/**
 * Named constants for each {@link PaymentGateway} (prefer over raw string literals).
 *
 * @example
 * ```typescript
 * gateway: PAYMENT_GATEWAY.stripe
 * ```
 */
export const PAYMENT_GATEWAY = {
  stripe: "stripe",
  xendit: "xendit",
} as const satisfies Record<PaymentGateway, PaymentGateway>;

/**
 * Type guard for {@link PaymentGateway}.
 *
 * @param value - Unknown value (e.g. query/body string)
 * @returns `true` when value is a known gateway
 */
export function isPaymentGateway(value: unknown): value is PaymentGateway {
  return typeof value === "string" && (paymentGateways as readonly string[]).includes(value);
}
