/**
 * Google Play Developer API purchase verifier.
 *
 * Endpoints (both current, non-deprecated):
 * - Subscriptions: `purchases.subscriptionsv2.get` — token-only lookup that
 *   returns state, expiry and auto-renew for the whole subscription chain.
 *   Product binding is enforced on our side by the store product registry:
 *   there is exactly one subscription product (`vip_monthly`), so an unbound
 *   token cannot be presented for anything else.
 * - Consumables: `purchases.products.get` — the productId is part of the path,
 *   so Play itself rejects a token bought under a different pack.
 *
 * Response contract (audit F1): `subscriptionsv2.get` answers
 * `SubscriptionPurchaseV2`, which carries the current period per
 * `lineItems[].expiryTime` and auto-renew per
 * `lineItems[].autoRenewingPlan.autoRenewEnabled`; it has no root-level
 * `expiryTime`/`autoRenewing`. A verifier that reads the root fields reports no
 * period, and "no period" must deny — so the wrong field names deny every real
 * purchase. Recorded-shaped fixtures pin this in
 * `tests/store-verification-parsers.test.ts`.
 *
 * Purchase mutation is deliberately **not** part of verification. A verifier is
 * a read (`purchases.subscriptionsv2.get` / `purchases.products.get`) that
 * answers facts; `:acknowledge` and `:consume` are writes that belong to
 * {@link finalizeGooglePlayPurchase}, which the route calls only *after* its
 * grant has committed. Acknowledging first would void Play's three-day
 * auto-refund safety net for a purchase our own transaction may still reject —
 * the worst of both orders.
 *
 * Credentials come from `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON[_PATH]` and never
 * leave the server.
 */

import { GoogleAuth, type JWTInput } from "google-auth-library";
import { STORE_VERIFICATION_CONFIG, storeVerificationReady } from "../../config/store-verification.js";
import type { StoreReceipt, StoreVerificationOutcome, StoreVerifier } from "./types.js";

/**
 * Subscription states Play reports while the user still owns the period.
 *
 * `ON_HOLD` (payment on hold), `PAUSED` and `EXPIRED` are deliberately not
 * entitled; `CANCELED` means the user turned off auto-renew and still owns the
 * period they already paid for, so it stays entitled until `lineItems[].expiryTime`
 * passes — the expiry check in `verifySubscription` enforces that.
 */
const ENTITLED_STATES = new Set(["ACTIVE", "IN_GRACE_PERIOD", "CANCELED"]);

/** Play `purchaseState` value for a completed purchase. */
const PRODUCT_STATE_PURCHASED = "PURCHASE_STATE_PURCHASED";
/** Play `purchaseState` value for an unfinished purchase. */
const PRODUCT_STATE_PENDING = "PURCHASE_STATE_PENDING";
/** Play `purchaseState` value for an order Play later reversed. */
const PRODUCT_STATE_CANCELED = "PURCHASE_STATE_CANCELED";
/** Play `purchaseState` value when Play sent a shape this parser does not know. */
const PRODUCT_STATE_UNKNOWN = "PURCHASE_STATE_UNKNOWN";

/**
 * Folds `ProductPurchase.purchaseState` onto the prefixed `PURCHASE_STATE_*` form.
 *
 * The v1 resource documents this field as an **integer** (`0` Purchased, `1`
 * Canceled, `2` Pending), while the v2-style enum spells it
 * `PURCHASE_STATE_PURCHASED`. Matching only one spelling silently denies every
 * purchase that arrives in the other, so both are folded onto one canonical
 * value before the entitlement check runs.
 *
 * @param value - Raw `ProductPurchase.purchaseState`
 * @returns Canonical `PURCHASE_STATE_*` value
 */
function normalizeProductPurchaseState(value: unknown): string {
  if (typeof value === "number") {
    if (value === 0) return PRODUCT_STATE_PURCHASED;
    if (value === 1) return PRODUCT_STATE_CANCELED;
    if (value === 2) return PRODUCT_STATE_PENDING;
    return PRODUCT_STATE_UNKNOWN;
  }
  if (typeof value !== "string" || value.length === 0) return PRODUCT_STATE_UNKNOWN;
  const bare = value.toUpperCase().replace(/^PURCHASE_STATE_/, "");
  if (bare === "PURCHASED") return PRODUCT_STATE_PURCHASED;
  if (bare === "PENDING") return PRODUCT_STATE_PENDING;
  if (bare === "CANCELED" || bare === "CANCELLED") return PRODUCT_STATE_CANCELED;
  return PRODUCT_STATE_UNKNOWN;
}

/**
 * Reads `acknowledgementState` as a boolean across both Play spellings.
 *
 * `purchases.subscriptionsv2` reports the enum (`ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`)
 * and `purchases.products` reports the integer (`1`). Storing a single `0 | 1`
 * shape in receipt metadata keeps the finalize pre-check uniform.
 *
 * @param value - Raw `acknowledgementState` from either resource
 */
function isAcknowledged(value: unknown): boolean {
  if (value === 1) return true;
  if (typeof value !== "string") return false;
  return value.toUpperCase().replace(/^ACKNOWLEDGEMENT_STATE_/, "") === "ACKNOWLEDGED";
}

/**
 * Cached service-account client keyed by the configured credentials.
 *
 * Rebuilt whenever credentials change so tests (and an operator's restart)
 * never observe another configuration's token.
 */
let cachedAuth: { key: string; auth: GoogleAuth } | null = null;

/** Drops the cached Google client (used when credentials change in tests). */
export function resetGooglePlayAuth(): void {
  cachedAuth = null;
}

async function getAccessToken(): Promise<string | null> {
  const cfg = STORE_VERIFICATION_CONFIG.googlePlay;
  const credentialsRaw = cfg.serviceAccountJson
    ? cfg.serviceAccountJson
    : await readFileIfConfigured(cfg.serviceAccountJsonPath);
  if (!credentialsRaw) return null;

  if (!cachedAuth || cachedAuth.key !== credentialsRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentialsRaw);
    } catch {
      console.warn("[store-verification] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON");
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      console.warn("[store-verification] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not a service-account object");
      return null;
    }
    cachedAuth = { key: credentialsRaw, auth: new GoogleAuth({ credentials: parsed as JWTInput, scopes: [cfg.scope] }) };
  }

  const token = await cachedAuth.auth.getAccessToken();
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function readFileIfConfigured(path: string): Promise<string | null> {
  if (!path) return null;
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(path, "utf8");
  } catch (error) {
    console.warn("[store-verification] cannot read GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH:", error);
    return null;
  }
}

/**
 * Calls an Android Publisher endpoint.
 *
 * 400/404 mean "Play does not accept this token/product pair", which is a
 * denial rather than a server fault. 401/403 mean our own credentials are
 * wrong, which must surface as "unavailable".
 */
async function playRequest(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const url = `${STORE_VERIFICATION_CONFIG.googlePlay.apiBaseUrl}/${path}${
    path.includes("?") ? "&" : "?"
  }access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, init);
  if (response.status === 400 || response.status === 404) {
    await response.text();
    return { ok: false, status: response.status };
  }
  if (response.status === 401 || response.status === 403) {
    await response.text();
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Play API ${response.status}: ${body.slice(0, 300)}`);
  }
  const text = await response.text();
  // `:acknowledge` and `:consume` answer 204 with no body; `JSON.parse("")`
  // would throw and misreport a succeeded write as a failed one.
  if (text.trim().length === 0) return { ok: true, body: null };
  return { ok: true, body: JSON.parse(text) as unknown };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Classifies a non-2xx Play answer as a purchase decision or a credential fault.
 *
 * 400/404 are Play refusing this token/product pair (a denial). 401/403 mean
 * our own service account is wrong, which must never read as "this purchase is
 * invalid" — that would tell an honest customer their real purchase was
 * rejected (audit F7).
 */
function outcomeForRejection(status: number): StoreVerificationOutcome {
  if (status === 401 || status === 403) {
    return { kind: "unavailable", reason: "google_play_credentials" };
  }
  return { kind: "denied", reason: `play_token_rejected_${status}` };
}

/**
 * Picks the line item the verified product belongs to.
 *
 * `SubscriptionPurchaseV2` keeps the current period's expiry and auto-renew
 * plan per line item; there is no root-level `expiryTime`/`autoRenewing`.
 * Falls back to the line item with the furthest expiry when the product id is
 * not echoed back, so a response with several items still yields a period.
 *
 * @param data - Raw `purchases.subscriptionsv2.get` body
 * @param productId - Product id the registry resolved server-side
 */
function pickLineItem(data: Record<string, unknown>, productId: string): Record<string, unknown> {
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems.map(asRecord) : [];
  const match = lineItems.find((item) => item.productId === productId);
  if (match) return match;
  let latest: Record<string, unknown> = {};
  let latestExpiry = 0;
  for (const item of lineItems) {
    const expiry = parseDate(item.expiryTime);
    if (expiry && expiry.getTime() > latestExpiry) {
      latest = item;
      latestExpiry = expiry.getTime();
    }
  }
  return latest;
}

/**
 * Best-effort acknowledgement of a **subscription**; a failure must never void
 * a real purchase.
 *
 * Consumables deliberately do not come here — they are consumed instead, which
 * is the only Play write that makes them re-buyable.
 *
 * @returns `true` when Play accepted the write
 */
async function acknowledge(accessToken: string, productId: string, token: string): Promise<boolean> {
  const pkg = STORE_VERIFICATION_CONFIG.googlePlay.packageName;
  const target = `applications/${pkg}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  try {
    const result = await playRequest(target, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!result.ok) {
      console.warn(`[store-verification] Play acknowledge rejected (${result.status}) for ${productId}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[store-verification] Play acknowledge failed:", error);
    return false;
  }
}

/**
 * Best-effort consumption of a **credit pack** — the terminal Play state that
 * lets the same product be bought again.
 *
 * A sibling of {@link acknowledge} on the identical path (same
 * `androidpublisher` scope), differing only in the method suffix. It is never
 * called for subscriptions: consuming one is not a valid operation, and VIP is
 * acknowledged, not consumed.
 *
 * @returns `true` when Play accepted the write
 */
async function consume(accessToken: string, productId: string, token: string): Promise<boolean> {
  const pkg = STORE_VERIFICATION_CONFIG.googlePlay.packageName;
  const target = `applications/${pkg}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:consume`;
  try {
    const result = await playRequest(target, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!result.ok) {
      console.warn(`[store-verification] Play consume rejected (${result.status}) for ${productId}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[store-verification] Play consume failed:", error);
    return false;
  }
}

/**
 * Play `consumptionState` meaning the pack is already consumed.
 *
 * Play has shipped both spellings — the string enum
 * (`CONSUMPTION_STATE_CONSUMED`) and the numeric value (`1`, "consumed"),
 * while `NEVER_CONSUMED` / `YET_TO_BE_CONSUMED` both mean "not yet". Only an
 * unambiguous "consumed" short-circuits; anything else retries the write,
 * which Play answers 400 for without side effects.
 *
 * @param value - Raw `ProductPurchase.consumptionState`
 */
function isConsumed(value: unknown): boolean {
  if (value === 1) return true;
  if (typeof value !== "string") return false;
  const upper = value.toUpperCase();
  return upper === "CONSUMED" || upper === "CONSUMPTION_STATE_CONSUMED";
}

async function verifySubscription(
  productId: string,
  token: string,
  accessToken: string,
): Promise<StoreVerificationOutcome> {
  const pkg = STORE_VERIFICATION_CONFIG.googlePlay.packageName;
  const target = `applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
  const response = await playRequest(target, accessToken);
  if (!response.ok) {
    return outcomeForRejection(response.status);
  }

  const data = asRecord(response.body);
  const stateRaw = typeof data.subscriptionState === "string" ? data.subscriptionState : "";
  const state = stateRaw.startsWith("SUBSCRIPTION_STATE_") ? stateRaw.slice("SUBSCRIPTION_STATE_".length) : stateRaw || "UNKNOWN";

  if (state === "PENDING") {
    return { kind: "pending", reason: "play_pending_payment" };
  }

  // v2 puts the period on the line item; reading a root-level `expiryTime`
  // yields null for every real purchase, which denies them all (audit F1).
  // The root reads below are only there to survive response drift.
  const lineItem = pickLineItem(data, productId);
  const periodEnd = parseDate(lineItem.expiryTime) ?? parseDate(data.expiryTime);
  const periodStart = parseDate(data.startTime) ?? parseDate(lineItem.startTime);
  const autoRenewPlan = asRecord(lineItem.autoRenewingPlan);
  const autoRenewing =
    lineItem.autoRenewingPlan !== undefined && lineItem.autoRenewingPlan !== null
      ? autoRenewPlan.autoRenewEnabled === true
      : data.autoRenewing === true;
  const orderId =
    typeof data.latestOrderId === "string"
      ? data.latestOrderId
      : typeof lineItem.latestSuccessfulOrderId === "string"
        ? lineItem.latestSuccessfulOrderId
        : null;
  const testPurchase = data.testPurchase !== undefined && data.testPurchase !== null;
  const accountIds = asRecord(data.externalAccountIdentifiers);
  const obfuscatedAccountId =
    typeof accountIds.obfuscatedExternalAccountId === "string" ? accountIds.obfuscatedExternalAccountId : null;
  const entitled = ENTITLED_STATES.has(state) && periodEnd !== null && periodEnd.getTime() > Date.now();

  const receipt: StoreReceipt = {
    platform: "google_play",
    kind: "subscription",
    productId,
    purchaseKey: token,
    orderId,
    entitlementStart: periodStart,
    entitlementEnd: periodEnd,
    autoRenewing,
    entitled,
    state,
    environment: testPurchase ? "SANDBOX" : "PRODUCTION",
    metadata: {
      autoRenewing,
      testPurchase,
      acknowledgementState: isAcknowledged(data.acknowledgementState) ? 1 : 0,
      ...(periodEnd ? { expiryTime: periodEnd.toISOString() } : {}),
      ...(obfuscatedAccountId ? { obfuscatedAccountId } : {}),
    },
  };

  if (!entitled) return { kind: "denied", reason: `play_not_entitled_${state.toLowerCase()}` };
  return { kind: "verified", receipt };
}

async function verifyConsumable(
  productId: string,
  token: string,
  accessToken: string,
): Promise<StoreVerificationOutcome> {
  const pkg = STORE_VERIFICATION_CONFIG.googlePlay.packageName;
  const target = `applications/${pkg}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const response = await playRequest(target, accessToken);
  if (!response.ok) {
    return outcomeForRejection(response.status);
  }

  const data = asRecord(response.body);
  const state = normalizeProductPurchaseState(data.purchaseState);
  if (state === PRODUCT_STATE_PENDING) {
    return { kind: "pending", reason: "play_pending_payment" };
  }
  if (state !== PRODUCT_STATE_PURCHASED) {
    return { kind: "denied", reason: `play_purchase_state_${state.toLowerCase()}` };
  }

  const purchaseTime = typeof data.purchaseTimeMillis === "string" ? new Date(Number(data.purchaseTimeMillis)) : null;
  // Play's `purchaseType` on `purchases.products.get`: 0 = Test order, so the
  // same order id space means "not a real-money purchase" (audit F7).
  const purchaseType = typeof data.purchaseType === "number" ? data.purchaseType : null;
  const testPurchase = purchaseType === 0;
  const receipt: StoreReceipt = {
    platform: "google_play",
    kind: "consumable",
    productId,
    purchaseKey: token,
    orderId: typeof data.orderId === "string" ? data.orderId : null,
    entitlementStart: purchaseTime,
    entitlementEnd: null,
    autoRenewing: false,
    entitled: true,
    state,
    environment: testPurchase ? "SANDBOX" : "PRODUCTION",
    metadata: {
      quantity: typeof data.quantity === "number" ? data.quantity : 1,
      acknowledged: isAcknowledged(data.acknowledgementState),
      testPurchase,
      ...(purchaseType !== null ? { purchaseType } : {}),
      ...(typeof data.consumptionState === "string" || typeof data.consumptionState === "number"
        ? { consumptionState: data.consumptionState }
        : {}),
    },
  };

  return { kind: "verified", receipt };
}

/**
 * Verifies a Play purchase proof.
 *
 * @param input - Lookup keys sent by the client (never trusted data)
 */
export const verifyGooglePlay: StoreVerifier = async (input) => {
  if (!storeVerificationReady("google_play")) {
    return { kind: "unavailable", reason: "google_play_not_configured" };
  }
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { kind: "unavailable", reason: "google_play_credentials" };
  }
  return input.kind === "subscription"
    ? verifySubscription(input.productId, input.transactionId, accessToken)
    : verifyConsumable(input.productId, input.transactionId, accessToken);
};

/**
 * Applies the terminal Play write for a purchase whose grant has **already
 * committed**, and only ever for that.
 *
 * Ordering invariant: `verify` (read) → `grant` (Postgres commit) →
 * `finalize` (Play write). Running the write earlier would acknowledge a
 * purchase before this server knows its own transaction succeeded, destroying
 * Play's three-day auto-refund path for money we may never have delivered.
 *
 * Per kind:
 * - **subscription** → `:acknowledge`. Stops the auto-refund of an entitlement
 *   we just granted. Never `:consume`: consuming a subscription is invalid.
 * - **consumable** → `:consume`, the only write that makes the pack
 *   re-buyable. Deliberately *not* followed by an `:acknowledge` fallback:
 *   acknowledging without consuming would trade a retryable failure for a
 *   permanent one. If this returns `false`, replaying the verify retries it —
 *   the grant is idempotent, so the replay is the retry mechanism.
 *
 * The pre-checks read what Play itself reported during verification, so a
 * replay whose write already landed skips the call instead of provoking a 400.
 *
 * Never throws and never fails the caller's response: the grant is committed,
 * and a 5xx here would lie to a customer who was already served.
 *
 * @param receipt - Receipt returned by {@link verifyGooglePlay}
 * @returns `true` when the purchase is in its terminal state (or already was)
 */
export async function finalizeGooglePlayPurchase(receipt: StoreReceipt): Promise<boolean> {
  if (!storeVerificationReady("google_play")) return false;
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return false;
    const token = receipt.purchaseKey;

    if (receipt.kind === "consumable") {
      if (isConsumed(receipt.metadata.consumptionState)) return true;
      const consumed = await consume(accessToken, receipt.productId, token);
      if (!consumed) {
        console.warn(
          `[store-verification] ${receipt.productId} granted but not consumed; replaying the verify retries it`,
        );
      }
      return consumed;
    }

    if (receipt.metadata.acknowledgementState === 1) return true;
    return await acknowledge(accessToken, receipt.productId, token);
  } catch (error) {
    console.warn("[store-verification] finalize failed:", error);
    return false;
  }
}
