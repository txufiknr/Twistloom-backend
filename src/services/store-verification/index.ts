/**
 * Store purchase verification — dispatch and product registry.
 *
 * Routes call {@link verifyStorePurchase} with lookup keys only. Which store
 * answers is decided by the request's `platform`; which product the proof is
 * allowed to be for is decided by {@link resolveStoreProduct}, the server-side
 * registry. Nothing about the purchase itself is taken on the client's word.
 *
 * The store's own write (`:acknowledge` / `:consume`) is a separate step,
 * {@link finalizeStorePurchase}, which runs only after the grant has
 * committed — verification stays read-only.
 *
 * `setStoreVerifierForTesting` / `setStoreFinalizerForTesting` are the single
 * seam tests use to replace the network-backed calls — there is no fixture or
 * mock gateway hiding anywhere else in this directory.
 */

import { PAYMENT_GATEWAY, type PaymentGateway } from "../../types/payment.js";
import { CREDIT_PACKS } from "../../config/credits.js";
import { VIP_SUBSCRIPTION } from "../../config/subscription.js";
import type { StoreVerificationPlatform } from "../../config/store-verification.js";
import { verifyAppStore } from "./app-store.js";
import { verifyGooglePlay, finalizeGooglePlayPurchase, resetGooglePlayAuth } from "./google-play.js";
import { resetAppStoreAuth } from "./app-store.js";
import type { StoreProductKind, StoreReceipt, StoreVerificationOutcome, StoreVerifier, StoreVerifyInput } from "./types.js";

export type {
  StoreProductKind,
  StoreReceipt,
  StoreVerificationOutcome,
  StoreVerifyInput,
  StoreVerifier,
} from "./types.js";

/** What a claimed product id turned out to be, once matched server-side. */
export type ResolvedStoreProduct =
  | { kind: "subscription"; productId: string }
  | {
      kind: "consumable";
      productId: string;
      packId: string;
      title: string;
      credits: number;
      priceUSD: number;
    };

/**
 * Resolves a client-supplied product id against the server's own catalogue.
 *
 * Returns `null` for anything unknown — an unregistered product id is refused
 * before any store is contacted, so a client cannot name a pack it did not buy.
 *
 * @param productId - Product id from the purchase proof
 */
export function resolveStoreProduct(productId: unknown): ResolvedStoreProduct | null {
  if (typeof productId !== "string" || productId.length === 0) return null;
  if (productId === VIP_SUBSCRIPTION.id) {
    return { kind: "subscription", productId };
  }
  const pack = CREDIT_PACKS.find((candidate) => candidate.storeProductId === productId);
  if (pack) {
    return {
      kind: "consumable",
      productId,
      packId: pack.id,
      title: pack.title,
      credits: pack.credits,
      priceUSD: pack.priceUSD,
    };
  }
  return null;
}

/**
 * Maps a store platform onto the gateway column its rows are written with.
 *
 * @param platform - Verified store platform
 */
export function storeGatewayFor(platform: StoreVerificationPlatform): PaymentGateway {
  return platform === "google_play" ? PAYMENT_GATEWAY.google_play : PAYMENT_GATEWAY.app_store;
}

/**
 * Product kind the verifier must apply for a registered product.
 *
 * @param resolved - Result of {@link resolveStoreProduct}
 */
export function storeProductKind(resolved: ResolvedStoreProduct): StoreProductKind {
  return resolved.kind;
}

let verifierOverride: StoreVerifier | null = null;
let finalizerOverride: ((receipt: StoreReceipt) => Promise<boolean>) | null = null;

/**
 * Replaces the network-backed verifiers (tests only).
 *
 * Pass `null` to restore the real dispatch. Callers should `addTearDown` the
 * reset so a later test cannot inherit a stale fake.
 *
 * @param verifier - Fake verifier, or `null`
 */
export function setStoreVerifierForTesting(verifier: StoreVerifier | null): void {
  verifierOverride = verifier;
}

/**
 * Replaces the post-grant finalizer (tests only).
 *
 * Pass `null` to restore the real dispatch. Same leak rule as
 * {@link setStoreVerifierForTesting}.
 *
 * @param finalizer - Fake finalizer, or `null`
 */
export function setStoreFinalizerForTesting(
  finalizer: ((receipt: StoreReceipt) => Promise<boolean>) | null,
): void {
  finalizerOverride = finalizer;
}

/** Restores the real dispatches **and** drops cached store credentials. */
export function resetStoreVerifiers(): void {
  verifierOverride = null;
  finalizerOverride = null;
  resetGooglePlayAuth();
  resetAppStoreAuth();
}

/**
 * Asks the named store whether a purchase proof is real.
 *
 * @param input - Lookup keys from the client plus the server-decided product kind
 * @returns `verified`/`pending`/`denied`/`unavailable`; never throws for a
 * business negative
 */
export async function verifyStorePurchase(input: StoreVerifyInput): Promise<StoreVerificationOutcome> {
  if (verifierOverride) return verifierOverride(input);
  return input.platform === "google_play" ? verifyGooglePlay(input) : verifyAppStore(input);
}

/**
 * Applies the store's terminal write for a purchase whose grant **has
 * already committed**, and only ever after that commit.
 *
 * The full invariant is `verify` (read) → `grant` (Postgres) → `finalize`
 * (store write). Verification itself stays read-only so a Play/App Store write
 * can never outlive a grant this server refused to make.
 *
 * Platform split is deliberate rather than symmetric:
 * - **Google Play** can finish server-side — `:consume` for credit packs
 *   (makes them re-buyable), `:acknowledge` for subscriptions.
 * - **Apple** cannot: StoreKit 1 finish is device-only and the App Store
 *   Server API exposes no finish endpoint, so this is a no-op and the client
 *   owns that half. The invariant is symmetric; the mechanism is not.
 *
 * Never throws — a failed finalize leaves a committed grant intact and is
 * retried by replaying the verify, which is idempotent.
 *
 * @param receipt - Receipt returned by {@link verifyStorePurchase}
 * @returns `true` when the purchase is in its terminal state (or cannot be moved)
 */
export async function finalizeStorePurchase(receipt: StoreReceipt): Promise<boolean> {
  try {
    if (finalizerOverride) return await finalizerOverride(receipt);
    if (receipt.platform !== "google_play") return true;
    return await finalizeGooglePlayPurchase(receipt);
  } catch (error) {
    console.warn("[store-verification] finalize failed:", error);
    return false;
  }
}
