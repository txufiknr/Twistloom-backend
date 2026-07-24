import Stripe from "stripe";
import { requireEnv } from "./env.js";

let stripe: Stripe | null = null;

/**
 * Get Stripe instance (singleton)
 * Singleton Stripe instance prevents memory bloat from instantiating on every request
 * @returns Stripe instance
 */
export function getStripe(): Stripe {
  return stripe || (stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
  }));
}