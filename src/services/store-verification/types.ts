/**
 * Store purchase verification contracts.
 *
 * Shared by the Google Play and Apple StoreKit verifiers and by the grant
 * orchestrators in `grant.ts`. One adapter serves two product types (VIP
 * entitlement and store credit packs) because the roadmap assigns a single
 * owner for store verification.
 *
 * Every verifier returns an outcome instead of throwing for a business
 * negative: a rejected purchase, an awaiting-approval purchase and an
 * unconfigured store are three different answers, and only the last one may
 * become an HTTP 503. Throw only for a programming/runtime error.
 */

import type { StoreVerificationPlatform } from "../../config/store-verification.js";

/** What kind of product a purchase proof refers to (routing, not storage). */
export type StoreProductKind = "subscription" | "consumable";

/**
 * Outcome of asking a store whether a purchase proof is real.
 *
 * - `verified` — the store vouches for the purchase; entitlement/grant follows.
 * - `pending` — awaiting payment, Ask to Buy or parental approval; grant nothing,
 *   the client should finish later.
 * - `denied` — the store says the purchase is not valid for this user/product.
 * - `unavailable` — the store cannot be consulted (disabled or missing
 *   credentials); the route answers 503, never a grant and never a denial.
 */
export type StoreVerificationOutcome =
  | { kind: "verified"; receipt: StoreReceipt }
  | { kind: "pending"; reason: string }
  | { kind: "denied"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * A store-confirmed purchase, normalized across Play and App Store.
 *
 * Everything here came from the store's own API — never from the client. The
 * client supplies only lookup keys (`productId`, `transactionId`) plus an
 * optional `signedTransaction` hint that no verifier reads.
 */
export interface StoreReceipt {
  platform: StoreVerificationPlatform;
  kind: StoreProductKind;
  /** Product id as reported by the store, after the route's registry match. */
  productId: string;
  /**
   * Stable id for this purchase chain — used as `providerSubscriptionId`.
   * Play: the purchase token (constant across renewals). Apple: the original
   * transaction id (constant across renewals).
   */
  purchaseKey: string;
  /**
   * Store id for this individual transaction/order when exposed
   * (Play `orderId`, Apple `transactionId`); `null` when the store omits it.
   */
  orderId: string | null;
  /** Start of the current entitled period, when the store reports one. */
  entitlementStart: Date | null;
  /** Authoritative end of the current entitled period (Apple `expiresDate`). */
  entitlementEnd: Date | null;
  autoRenewing: boolean;
  /** `false` for expired/on-hold/revoked purchases. */
  entitled: boolean;
  /** Store's own state word, kept verbatim for audit correlation. */
  state: string;
  /** `PRODUCTION`/`SANDBOX` (Play) or `Production`/`Sandbox` (Apple). */
  environment: string | null;
  /** Non-identifying facts worth persisting on the grant record. */
  metadata: Record<string, string | number | boolean>;
}

/** Lookup keys a client sends to prove a purchase. */
export interface StoreVerifyInput {
  platform: StoreVerificationPlatform;
  kind: StoreProductKind;
  /** Server-registered product id the client claims to have bought. */
  productId: string;
  /** Play purchase token, or Apple transaction id. */
  transactionId: string;
  /** StoreKit signed transaction (JWS) — an extra hint that no verifier reads. */
  signedTransaction?: string | null;
}

/** The function shape the route calls and tests replace. */
export type StoreVerifier = (input: StoreVerifyInput) => Promise<StoreVerificationOutcome>;
