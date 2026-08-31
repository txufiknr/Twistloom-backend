/**
 * Payment gateway registry.
 *
 * Centralizes gateway adapter lookup. Route handlers call
 * `getGatewayAdapter(gateway)` instead of inline if/else dispatch.
 *
 * @example
 * ```typescript
 * import { getGatewayAdapter } from "../services/gateways/registry.js";
 *
 * const adapter = getGatewayAdapter(gateway);
 * const result = await adapter.createCreditPackCheckout(params);
 * ```
 */

import { PAYMENT_GATEWAY, type PaymentGateway } from "../../types/payment.js";
import type { PaymentGatewayAdapter } from "../../types/payment-gateway-adapter.js";
import { StripeAdapter } from "./stripe-adapter.js";
import { XenditAdapter } from "./xendit-adapter.js";

const adapters = new Map<PaymentGateway, PaymentGatewayAdapter>();

/**
 * Returns the adapter for the given gateway.
 * @throws if no adapter is registered for the gateway
 */
export function getGatewayAdapter(gateway: PaymentGateway): PaymentGatewayAdapter {
  const adapter = adapters.get(gateway);
  if (!adapter) {
    throw new Error(`No payment gateway adapter registered for: ${gateway}`);
  }
  return adapter;
}

/**
 * Initializes all gateway adapters. Called once at server startup.
 */
export function initGatewayAdapters(): void {
  adapters.set(PAYMENT_GATEWAY.stripe, new StripeAdapter());
  adapters.set(PAYMENT_GATEWAY.xendit, new XenditAdapter());
  console.log(`[gateways] ✅ Initialized adapters: ${[...adapters.keys()].join(", ")}`);
}
