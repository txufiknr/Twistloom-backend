/**
 * Xendit PaymentGatewayAdapter implementation.
 *
 * Wraps the existing Xendit service functions in the adapter interface.
 * Most Xendit business logic already lives in `services/xendit.ts`;
 * this adapter provides the unified contract.
 */

import { PAYMENT_GATEWAY } from "../../types/payment.js";
import {
  createXenditCreditPackCheckout as _createCreditPackCheckout,
  createXenditSubscriptionCheckout as _createSubscriptionCheckout,
  cancelXenditSubscription as _cancelSubscription,
} from "../xendit.js";
import { isXenditConfigured } from "../../utils/xendit.js";
import type {
  PaymentGatewayAdapter,
  CreditPackCheckoutParams,
  SubscriptionCheckoutParams,
  CheckoutResult,
} from "../../types/payment-gateway-adapter.js";

export class XenditAdapter implements PaymentGatewayAdapter {
  readonly gateway = PAYMENT_GATEWAY.xendit;
  readonly supportsTrials = false;
  readonly supportsPortal = false;

  async createCreditPackCheckout(params: CreditPackCheckoutParams): Promise<CheckoutResult> {
    if (!isXenditConfigured()) {
      throw new Error("Xendit gateway is not enabled or configured");
    }
    return _createCreditPackCheckout({
      userId: params.userId,
      email: params.email,
      name: params.name,
      packId: params.packId,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    });
  }

  async createSubscriptionCheckout(params: SubscriptionCheckoutParams): Promise<CheckoutResult> {
    if (!isXenditConfigured()) {
      throw new Error("Xendit gateway is not enabled or configured");
    }
    return _createSubscriptionCheckout({
      userId: params.userId,
      email: params.email,
      name: params.name,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    });
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await _cancelSubscription(providerSubscriptionId);
  }
}
