/**
 * Payment gateway identifiers used across checkout, webhooks, and DB rows.
 *
 * Stripe handles international card checkout + VIP subscriptions.
 * Xendit handles Indonesia local methods (credit packs v1; subscriptions later).
 * Google Play and Apple App Store are **store** gateways: they carry purchases
 * that are verified server-side (`src/services/store-verification/`) instead of
 * created through a hosted checkout, so they deliberately have no
 * {@link PaymentGatewayAdapter}.
 */
export const paymentGateways = ["stripe", "xendit", "google_play", "app_store"] as const;

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
 * Gateways that are created through a hosted checkout session (Stripe/Xendit).
 *
 * Store gateways are excluded: they are entered only through a verified store
 * purchase, so `getGatewayAdapter` must never be called for them.
 */
export const hostedGateways = ["stripe", "xendit"] as const satisfies readonly PaymentGateway[];

/**
 * Gateways reached through a store purchase verified server-side instead of a
 * hosted checkout session (see `src/services/store-verification/`).
 */
export const storeGateways = ["google_play", "app_store"] as const satisfies readonly PaymentGateway[];

/** A gateway sold through hosted checkout (Stripe/Xendit). */
export type HostedGateway = (typeof hostedGateways)[number];

/** A gateway sold through a verified store purchase (Play/App Store). */
export type StoreGateway = (typeof storeGateways)[number];

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
  google_play: "google_play",
  app_store: "app_store",
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

/**
 * Type guard for the checkout-capable gateways (see {@link hostedGateways}).
 *
 * @param value - Unknown value (e.g. a row's `gateway` column)
 * @returns `true` when a {@link PaymentGatewayAdapter} can serve this gateway
 */
export function isHostedGateway(value: unknown): value is (typeof hostedGateways)[number] {
  return typeof value === "string" && (hostedGateways as readonly string[]).includes(value);
}

/**
 * Type guard for the store-verified gateways (see {@link storeGateways}).
 *
 * @param value - Unknown value (e.g. a row's `gateway` column)
 * @returns `true` when this gateway is entered through a verified store purchase
 */
export function isStoreGateway(value: unknown): value is (typeof storeGateways)[number] {
  return typeof value === "string" && (storeGateways as readonly string[]).includes(value);
}
