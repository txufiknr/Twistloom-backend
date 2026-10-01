/**
 * Store verifier parsers — recorded-response fixtures (audit F1/F3/F7).
 *
 * `tests/store-verification.test.ts` injects outcomes through
 * `setStoreVerifierForTesting`, so the code that *turns a real store response
 * into an outcome* — the layer where audit F1 denied every Play subscription
 * because it read v1 field names off a `SubscriptionPurchaseV2` body — was
 * never exercised. These fixtures pin that layer against the response shapes
 * the stores actually send, using a stubbed `fetch` and no network:
 *
 * - Google Play `purchases.subscriptionsv2.get` (period lives on
 *   `lineItems[].expiryTime`, auto-renew on
 *   `lineItems[].autoRenewingPlan.autoRenewEnabled`), plus
 *   `purchases.products.get` for credit packs
 * - App Store Server API production → sandbox host fallback (a sandbox
 *   transaction is a 404 on the production host, not a denial), plus the
 *   documented `StatusResponse` nesting (`data[] → lastTransactions[]` with
 *   facts inside the signed JWS payloads)
 * - credential failures (401/403) answering `unavailable`, never `denied`
 *
 * `bun test` runs every file in **one process**, and a module mock cannot be
 * unregistered in that process. So nothing here mocks the config module: the
 * settings are read from `process.env` on every access (see
 * `src/config/store-verification.ts`), which lets this file enable a platform
 * per test and put the environment back afterwards — the project's sibling
 * suite, which asserts the *unconfigured* default, therefore passes in any
 * file order. The single module double is `GoogleAuth`: only
 * `src/services/store-verification/google-play.ts` ever constructs it, the
 * unconfigured path never reaches it, and every other export of
 * `google-auth-library` (notably `OAuth2Client`) is re-exported untouched, so
 * its presence for the rest of the run changes no other test.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";

// ---------------------------------------------------------------------------
// Environment — set per test, removed again so no other file observes it.
// ---------------------------------------------------------------------------

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const appStorePrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const STORE_ENV: Record<string, string> = {
  GOOGLE_PLAY_ENABLED: "true",
  GOOGLE_PLAY_PACKAGE_NAME: "com.twistloom.app",
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    client_email: "publisher@test.iam.gserviceaccount.com",
    private_key: "test-only-key",
  }),
  APP_STORE_ENABLED: "true",
  APP_STORE_BUNDLE_ID: "com.twistloom.app",
  APP_STORE_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  APP_STORE_KEY_ID: "TESTKEYID",
  APP_STORE_PRIVATE_KEY: appStorePrivateKey,
};

beforeEach(() => {
  for (const [key, value] of Object.entries(STORE_ENV)) process.env[key] = value;
});

afterEach(() => {
  for (const key of Object.keys(STORE_ENV)) delete process.env[key];
});

// ---------------------------------------------------------------------------
// google-auth-library double — installed before the verifiers are imported.
// ---------------------------------------------------------------------------

const realGoogleAuth = await import("google-auth-library");

mock.module("google-auth-library", () => ({
  ...realGoogleAuth,
  GoogleAuth: class {
    async getAccessToken(): Promise<string> {
      return "test-access-token";
    }
  },
}));

const { verifyGooglePlay, finalizeGooglePlayPurchase } = await import("../src/services/store-verification/google-play.js");
const { verifyAppStore } = await import("../src/services/store-verification/app-store.js");

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

type FetchRoute = (url: string, init?: RequestInit) => Response | undefined;

const PLAY_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const APP_STORE_PROD = "https://api.appstoreconnect.apple.com";
const APP_STORE_SANDBOX = "https://api.storekit-sandbox.apple.com";

let routes: FetchRoute[] = [];
const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push(url);
  for (const route of routes) {
    const response = route(url, init);
    if (response) return response;
  }
  throw new Error(`unexpected request: ${url}`);
}) as typeof fetch;

beforeEach(() => {
  routes = [];
  fetchCalls.length = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function status(code: number): Response {
  return new Response("", { status: code });
}

/** Matches a Play path segment, answering with `status` unless `body` is given. */
function play(segment: string, body: unknown): FetchRoute {
  return (url) => (url.startsWith(PLAY_BASE) && url.includes(segment) ? json(body) : undefined);
}

function playStatus(segment: string, code: number): FetchRoute {
  return (url) => (url.startsWith(PLAY_BASE) && url.includes(segment) ? status(code) : undefined);
}

/** Answers one App Store host; `code >= 400` replies with that status. */
function appStore(host: string, code: number, body?: unknown): FetchRoute {
  return (url) => (url.startsWith(host) ? (code >= 400 ? status(code) : json(body)) : undefined);
}

const DAY = 86_400_000;
const FUTURE = new Date(Date.now() + 25 * DAY);
const PAST = new Date(Date.now() - 2 * DAY);
const START = new Date("2026-08-18T07:00:00Z");

/** Realistic `SubscriptionPurchaseV2`: no root expiry/auto-renew by design. */
function playV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startTime: START.toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    latestOrderId: "GPA.3335-1234-5678-90123",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "11111111-1111-1111-1111-111111111111" },
    lineItems: [
      {
        productId: "vip_monthly",
        expiryTime: FUTURE.toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
    ...overrides,
  };
}

const SUBSCRIPTION_PROOF = {
  platform: "google_play",
  kind: "subscription",
  productId: "vip_monthly",
  transactionId: "tok_alpha",
} as const;

const CREDIT_PROOF = {
  platform: "google_play",
  kind: "consumable",
  productId: "vip_100",
  transactionId: "tok_beta",
} as const;

// ---------------------------------------------------------------------------
// Google Play — subscriptions (`purchases.subscriptionsv2.get`)
// ---------------------------------------------------------------------------

describe("Google Play subscription verification (SubscriptionPurchaseV2)", () => {
  it("reads the period from the line items, where v2 actually puts it", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2())];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;

    const receipt = outcome.receipt;
    // F1 regression: a root-level read would produce null and deny here.
    expect(receipt.entitlementEnd?.getTime()).toBe(FUTURE.getTime());
    expect(receipt.autoRenewing).toBe(true);
    expect(receipt.entitlementStart?.getTime()).toBe(START.getTime());
    expect(receipt.orderId).toBe("GPA.3335-1234-5678-90123");
    expect(receipt.purchaseKey).toBe("tok_alpha");
    expect(receipt.state).toBe("ACTIVE");
    expect(receipt.environment).toBe("PRODUCTION");
    expect(receipt.metadata.obfuscatedAccountId).toBe("11111111-1111-1111-1111-111111111111");
    expect(receipt.metadata.testPurchase).toBe(false);
    expect(fetchCalls.some((url) => url.includes(":acknowledge"))).toBe(false);
  });

  it("answers verified without touching Play's write endpoints", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }))];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome.kind).toBe("verified");
    // Verification is a read. Exactly one call, the GET — the write is
    // `finalizeGooglePlayPurchase`, which runs only after the grant commits.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.some((url) => url.includes(":acknowledge") || url.includes(":consume"))).toBe(false);
  });

  it("keeps a canceled subscription entitled until its paid period ends", async () => {
    routes = [
      play("/purchases/subscriptionsv2/", playV2({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED" })),
    ];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome.kind).toBe("verified");
  });

  it("denies a state Play does not entitle", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }))];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "play_not_entitled_on_hold" });
    expect(fetchCalls.some((url) => url.includes(":acknowledge"))).toBe(false);
  });

  it("denies an expired period even when Play still reports ACTIVE", async () => {
    routes = [
      play("/purchases/subscriptionsv2/", playV2({ lineItems: [{ productId: "vip_monthly", expiryTime: PAST.toISOString() }] })),
    ];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "play_not_entitled_active" });
  });

  it("answers pending for a purchase awaiting payment", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" }))];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome).toEqual({ kind: "pending", reason: "play_pending_payment" });
  });

  it("records a test purchase as SANDBOX instead of production", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ testPurchase: { testPurchaseType: "TEST" } }))];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.environment).toBe("SANDBOX");
    expect(outcome.receipt.metadata.testPurchase).toBe(true);
  });

  it("still parses a response that only carries a root expiry", async () => {
    routes = [
      play(
        "/purchases/subscriptionsv2/",
        playV2({ lineItems: [], expiryTime: FUTURE.toISOString(), autoRenewing: false }),
      ),
    ];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.entitlementEnd?.getTime()).toBe(FUTURE.getTime());
    expect(outcome.receipt.autoRenewing).toBe(false);
  });

  it("treats a bad service account as unavailable, not as a rejected purchase", async () => {
    routes = [playStatus("/purchases/subscriptionsv2/", 401)];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome).toEqual({ kind: "unavailable", reason: "google_play_credentials" });
  });

  it("treats an unknown token as a denial", async () => {
    routes = [playStatus("/purchases/subscriptionsv2/", 404)];

    const outcome = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "play_token_rejected_404" });
  });
});

// ---------------------------------------------------------------------------
// Google Play — credit packs (`purchases.products.get`)
// ---------------------------------------------------------------------------

describe("Google Play credit pack verification (ProductPurchase)", () => {
  it("reads the v1 product purchase without mutating it", async () => {
    routes = [
      play(
        "/purchases/products/",
        {
          // `ProductPurchase.purchaseState` is an integer on v1 (0 Purchased).
          purchaseState: 0,
          purchaseTimeMillis: String(START.getTime()),
          orderId: "GPA.4444-2222-3333-4444444",
          acknowledgementState: 0,
          quantity: 1,
          consumptionState: 0,
        },
      ),
    ];

    const outcome = await verifyGooglePlay(CREDIT_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    const receipt = outcome.receipt;
    expect(receipt.orderId).toBe("GPA.4444-2222-3333-4444444");
    expect(receipt.state).toBe("PURCHASE_STATE_PURCHASED");
    expect(receipt.entitlementStart?.getTime()).toBe(START.getTime());
    expect(receipt.environment).toBe("PRODUCTION");
    expect(receipt.metadata.testPurchase).toBe(false);
    // Play rejects an unknown productId in the path itself.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("purchases/products/vip_100/tokens/tok_beta");
    expect(fetchCalls.some((url) => url.includes(":acknowledge") || url.includes(":consume"))).toBe(false);
  });

  it("also accepts the prefixed enum spelling of purchaseState", async () => {
    routes = [play("/purchases/products/", { purchaseState: "PURCHASE_STATE_PURCHASED", purchaseTimeMillis: "1" })];

    const outcome = await verifyGooglePlay(CREDIT_PROOF);
    expect(outcome.kind).toBe("verified");
  });

  it("denies a pack Play still reports as pending or canceled", async () => {
    routes = [play("/purchases/products/", { purchaseState: 2, purchaseTimeMillis: "1" })];
    expect(await verifyGooglePlay(CREDIT_PROOF)).toEqual({ kind: "pending", reason: "play_pending_payment" });

    routes = [play("/purchases/products/", { purchaseState: 1, purchaseTimeMillis: "1" })];
    const canceled = await verifyGooglePlay(CREDIT_PROOF);
    expect(canceled.kind).toBe("denied");
    if (canceled.kind !== "denied") return;
    expect(canceled.reason).toBe("play_purchase_state_purchase_state_canceled");
  });

  it("records a Play test order as SANDBOX", async () => {
    routes = [
      play("/purchases/products/", { purchaseState: 0, purchaseTimeMillis: "1", purchaseType: 0 }),
    ];

    const outcome = await verifyGooglePlay(CREDIT_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.environment).toBe("SANDBOX");
    expect(outcome.receipt.metadata.purchaseType).toBe(0);
  });

  it("treats a bad service account as unavailable, not as a rejected purchase", async () => {
    routes = [playStatus("/purchases/products/", 403)];

    const outcome = await verifyGooglePlay(CREDIT_PROOF);
    expect(outcome).toEqual({ kind: "unavailable", reason: "google_play_credentials" });
  });
});

// ---------------------------------------------------------------------------
// Google Play finalize — the post-grant write, which verification never makes
// ---------------------------------------------------------------------------

/** Realistic `ProductPurchase`; `overrides` swap the states under test. */
function playProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purchaseState: 0,
    purchaseTimeMillis: String(START.getTime()),
    orderId: "GPA.4444-2222-3333-4444444",
    acknowledgementState: 0,
    quantity: 1,
    consumptionState: 0,
    ...overrides,
  };
}

describe("Google Play finalize (read → grant → write)", () => {
  it("consumes a granted credit pack so the product becomes re-buyable", async () => {
    routes = [play("/purchases/products/", playProduct())];
    const verified = await verifyGooglePlay(CREDIT_PROOF);
    expect(verified.kind).toBe("verified");
    if (verified.kind !== "verified") return;

    const afterRead = fetchCalls.length;
    routes = [play(":consume", {})];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);

    const writes = fetchCalls.slice(afterRead);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("purchases/products/vip_100/tokens/tok_beta:consume");
    // Consume is the terminal write for a pack; a sibling `:acknowledge`
    // would only hide which step is load-bearing.
    expect(writes.some((url) => url.includes(":acknowledge"))).toBe(false);
  });

  it("acknowledges a granted subscription and never consumes it", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }))];
    const verified = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    expect(verified.kind).toBe("verified");
    if (verified.kind !== "verified") return;

    const afterRead = fetchCalls.length;
    routes = [play(":acknowledge", {})];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);

    const writes = fetchCalls.slice(afterRead);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("subscriptions/vip_monthly/tokens/tok_alpha:acknowledge");
    // Consuming a subscription is not a valid Play operation.
    expect(writes.some((url) => url.includes(":consume"))).toBe(false);
  });

  it("skips the write when Play already reports the subscription acknowledged", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }))];
    const verified = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    if (verified.kind !== "verified") throw new Error("expected verified");

    const afterRead = fetchCalls.length;
    routes = [play(":acknowledge", { unexpected: true })];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);
    expect(fetchCalls).toHaveLength(afterRead);
  });

  it("reads a numeric acknowledgementState as acknowledged too", async () => {
    routes = [play("/purchases/subscriptionsv2/", playV2({ acknowledgementState: 1 }))];
    const verified = await verifyGooglePlay(SUBSCRIPTION_PROOF);
    if (verified.kind !== "verified") throw new Error("expected verified");

    const afterRead = fetchCalls.length;
    routes = [play(":acknowledge", { unexpected: true })];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);
    expect(fetchCalls).toHaveLength(afterRead);
  });

  it("skips the write when Play already reports the pack consumed", async () => {
    routes = [play("/purchases/products/", playProduct({ consumptionState: "CONSUMPTION_STATE_CONSUMED" }))];
    const verified = await verifyGooglePlay(CREDIT_PROOF);
    if (verified.kind !== "verified") throw new Error("expected verified");

    const afterRead = fetchCalls.length;
    routes = [play(":consume", { unexpected: true })];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);
    expect(fetchCalls).toHaveLength(afterRead);
  });

  it("reads Play's numeric consumptionState=1 as consumed too", async () => {
    routes = [play("/purchases/products/", playProduct({ consumptionState: 1 }))];
    const verified = await verifyGooglePlay(CREDIT_PROOF);
    if (verified.kind !== "verified") throw new Error("expected verified");

    const afterRead = fetchCalls.length;
    routes = [play(":consume", { unexpected: true })];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(true);
    expect(fetchCalls).toHaveLength(afterRead);
  });

  it("returns false instead of throwing when Play rejects the write", async () => {
    routes = [play("/purchases/products/", playProduct())];
    const verified = await verifyGooglePlay(CREDIT_PROOF);
    if (verified.kind !== "verified") throw new Error("expected verified");

    routes = [playStatus(":consume", 500)];
    expect(await finalizeGooglePlayPurchase(verified.receipt)).toBe(false);
  });

  it("makes a replayed verify skip the write, so replay stays idempotent", async () => {
    routes = [play("/purchases/products/", playProduct())];
    const first = await verifyGooglePlay(CREDIT_PROOF);
    if (first.kind !== "verified") throw new Error("expected verified");
    routes = [play(":consume", {})];
    expect(await finalizeGooglePlayPurchase(first.receipt)).toBe(true);

    routes = [play("/purchases/products/", playProduct({ consumptionState: "CONSUMPTION_STATE_CONSUMED" }))];
    const replay = await verifyGooglePlay(CREDIT_PROOF);
    if (replay.kind !== "verified") throw new Error("expected verified");

    const afterReplayRead = fetchCalls.length;
    routes = [play(":consume", { unexpected: true })];
    expect(await finalizeGooglePlayPurchase(replay.receipt)).toBe(true);
    expect(fetchCalls).toHaveLength(afterReplayRead);
  });
});

// ---------------------------------------------------------------------------
// App Store Server API — production and sandbox hosts
// ---------------------------------------------------------------------------

async function signedTransaction(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode("test-secret"));
}

/** `signedRenewalInfo` has the same compact-JWS shape as `signedTransactionInfo`. */
const signedRenewalInfo = signedTransaction;

/** The subscription chain id these fixtures are addressed by. */
const ORIGINAL_TRANSACTION_ID = "2000000123456";

/**
 * Apple's `Get All Subscription Statuses` body in its **documented** shape:
 * `data[] → SubscriptionGroupIdentifierItem → lastTransactions[]`, with
 * `productId`/`expiresDate`/`purchaseDate`/`revocationDate` living inside the
 * App-Store-signed `signedTransactionInfo` JWS and `autoRenewStatus` inside
 * `signedRenewalInfo` — never on the group items.
 *
 * A flattened fixture (fields directly on `data[]` elements) is exactly what
 * let the pre-fix parser pass its suite while production denied every real
 * subscription as `appstore_missing_expiry`; the fixture therefore mirrors
 * Apple's nesting on purpose.
 *
 * @param overrides - `transaction`/`renewal` override decoded JWS claims;
 *   `envelope` overrides `lastTransactionsItem` fields (e.g. `status`)
 * @param root - Top-level response fields (`environment`, `bundleId`)
 */
async function subscriptionStatus(
  overrides: {
    transaction?: Record<string, unknown>;
    renewal?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
  } = {},
  root: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const signedTransactionInfo = await signedTransaction({
    // JWSTransactionDecodedPayload always names the app — this is where the
    // bundle binding is actually read from (the consumable endpoint's root
    // response has no bundleId field at all).
    bundleId: "com.twistloom.app",
    productId: "vip_monthly",
    transactionId: ORIGINAL_TRANSACTION_ID,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    purchaseDate: START.getTime(),
    expiresDate: FUTURE.getTime(),
    ...overrides.transaction,
  });
  const signedRenewalInfoClaims = await signedRenewalInfo({
    autoRenewStatus: 1,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    ...overrides.renewal,
  });
  return {
    environment: "Production",
    bundleId: "com.twistloom.app",
    ...root,
    data: [
      {
        subscriptionGroupIdentifier: "1000000000",
        lastTransactions: [
          {
            originalTransactionId: ORIGINAL_TRANSACTION_ID,
            status: 1,
            signedTransactionInfo,
            signedRenewalInfo: signedRenewalInfoClaims,
            ...overrides.envelope,
          },
        ],
      },
    ],
  };
}

const APP_STORE_PROOF = {
  platform: "app_store",
  kind: "subscription",
  productId: "vip_monthly",
  transactionId: "2000000123456",
} as const;

describe("App Store verification (production and sandbox hosts)", () => {
  it("reads a production subscription without touching the sandbox host", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus())];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.environment).toBe("Production");
    expect(outcome.receipt.entitlementEnd?.getTime()).toBe(FUTURE.getTime());
    expect(outcome.receipt.autoRenewing).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/inApps/v1/subscriptions/2000000123456");
  });

  it("retries the sandbox host when production answers 404", async () => {
    routes = [
      appStore(APP_STORE_PROD, 404),
      // Apple omitted `environment`; the host that had the record decides.
      appStore(APP_STORE_SANDBOX, 200, await subscriptionStatus({}, { environment: undefined })),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.environment).toBe("Sandbox");
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]).toContain(APP_STORE_SANDBOX);
  });

  it("denies when neither host knows the transaction", async () => {
    routes = [appStore(APP_STORE_PROD, 404), appStore(APP_STORE_SANDBOX, 404)];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_transaction_rejected_404" });
    expect(fetchCalls).toHaveLength(2);
  });

  it("does not retry the sandbox host for an answer that is not 404", async () => {
    routes = [appStore(APP_STORE_PROD, 409)];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_transaction_rejected_409" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("treats a rejected API key as unavailable, not as a rejected purchase", async () => {
    routes = [appStore(APP_STORE_PROD, 401)];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "unavailable", reason: "app_store_credentials" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("denies a product Apple reports for a different product", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { productId: "vip_yearly" } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_product_mismatch" });
  });

  it("denies a subscription whose paid period has ended", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { expiresDate: PAST.getTime() } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") return;
    expect(outcome.reason).toContain("appstore_not_entitled_status_1");
  });

  it("verifies a credit pack through the sandbox host", async () => {
    const signed = await signedTransaction({
      bundleId: "com.twistloom.app",
      productId: "vip_100",
      transactionId: "2000000999",
      originalTransactionId: "2000000999",
      purchaseDate: START.getTime(),
      quantity: 1,
    });
    // Apple's real `TransactionInfoResponse` shape: `signedTransactionInfo`
    // ONLY — no root bundleId. A root-level check would never run here, which
    // is why the binding reads the signed claims.
    routes = [
      appStore(APP_STORE_PROD, 404),
      appStore(APP_STORE_SANDBOX, 200, { signedTransactionInfo: signed }),
    ];

    const outcome = await verifyAppStore({
      platform: "app_store",
      kind: "consumable",
      productId: "vip_100",
      transactionId: "2000000999",
    });
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.orderId).toBe("2000000999");
    expect(outcome.receipt.environment).toBe("Sandbox");
    expect(fetchCalls[1]).toContain("/inApps/v1/transactions/2000000999");
  });

  it("denies a credit pack whose signed claims name a different app bundle", async () => {
    const signed = await signedTransaction({
      bundleId: "com.attacker.app",
      productId: "vip_100",
      transactionId: "2000000997",
      originalTransactionId: "2000000997",
      purchaseDate: START.getTime(),
      quantity: 1,
    });
    routes = [appStore(APP_STORE_PROD, 200, { signedTransactionInfo: signed })];

    const outcome = await verifyAppStore({
      platform: "app_store",
      kind: "consumable",
      productId: "vip_100",
      transactionId: "2000000997",
    });
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_bundle_mismatch" });
  });

  it("fails closed when the signed credit-pack transaction carries no bundle id", async () => {
    const signed = await signedTransaction({
      productId: "vip_100",
      transactionId: "2000000996",
      originalTransactionId: "2000000996",
      purchaseDate: START.getTime(),
      quantity: 1,
    });
    routes = [appStore(APP_STORE_PROD, 200, { signedTransactionInfo: signed })];

    const outcome = await verifyAppStore({
      platform: "app_store",
      kind: "consumable",
      productId: "vip_100",
      transactionId: "2000000996",
    });
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_bundle_mismatch" });
  });

  it("denies a credit pack whose signed transaction it cannot decode", async () => {
    routes = [appStore(APP_STORE_PROD, 200, { signedTransactionInfo: "aaa.bbb.ccc" })];

    const outcome = await verifyAppStore({
      platform: "app_store",
      kind: "consumable",
      productId: "vip_100",
      transactionId: "2000000995",
    });
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_unreadable_transaction" });
  });

  it("denies a revoked transaction", async () => {
    const signed = await signedTransaction({
      bundleId: "com.twistloom.app",
      productId: "vip_100",
      transactionId: "2000000998",
      originalTransactionId: "2000000998",
      purchaseDate: START.getTime(),
      revocationDate: START.getTime(),
      revocationReason: 0,
    });
    routes = [appStore(APP_STORE_PROD, 200, { signedTransactionInfo: signed })];

    const outcome = await verifyAppStore({
      platform: "app_store",
      kind: "consumable",
      productId: "vip_100",
      transactionId: "2000000998",
    });
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_revoked" });
  });

  // -----------------------------------------------------------------------
  // StatusResponse contract — the nesting Apple actually documents.
  // -----------------------------------------------------------------------

  it("denies a flattened StatusResponse that does not match Apple's nesting", async () => {
    // The pre-fix parser read `data[]` elements directly and only passed
    // because its fixture was flattened too; pin the real contract so the
    // fixture can never drift back unnoticed.
    routes = [
      appStore(APP_STORE_PROD, 200, {
        environment: "Production",
        bundleId: "com.twistloom.app",
        data: [
          {
            productId: "vip_monthly",
            status: 1,
            expiresDate: FUTURE.getTime(),
            originalTransactionId: ORIGINAL_TRANSACTION_ID,
          },
        ],
      }),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_no_subscription_status" });
  });

  it("selects the matching chain across subscription groups", async () => {
    const otherTransaction = await signedTransaction({
      productId: "vip_yearly",
      transactionId: "999999999",
      originalTransactionId: "999999999",
      purchaseDate: START.getTime(),
      expiresDate: FUTURE.getTime(),
    });
    const mine = await subscriptionStatus();
    const mineGroups = Array.isArray(mine.data) ? mine.data : [];
    routes = [
      appStore(APP_STORE_PROD, 200, {
        ...mine,
        data: [
          {
            subscriptionGroupIdentifier: "other-group",
            lastTransactions: [
              {
                originalTransactionId: "999999999",
                status: 1,
                signedTransactionInfo: otherTransaction,
              },
            ],
          },
          ...mineGroups,
        ],
      }),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.productId).toBe("vip_monthly");
    expect(outcome.receipt.purchaseKey).toBe(ORIGINAL_TRANSACTION_ID);
  });

  it("denies a revoked subscription even while the envelope still reads active", async () => {
    routes = [
      appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { revocationDate: START.getTime() } })),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_revoked" });
  });

  it("denies the revoked status value Apple reports for a refunded period", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ envelope: { status: 5 } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_not_entitled_status_5" });
  });

  it("fails closed when the signed transaction carries no expiry", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { expiresDate: undefined } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_missing_expiry" });
  });

  it("fails closed when the signed transaction carries no product id", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { productId: undefined } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_missing_product" });
  });

  it("denies a signed transaction it cannot decode", async () => {
    routes = [
      appStore(APP_STORE_PROD, 200, {
        environment: "Production",
        bundleId: "com.twistloom.app",
        data: [
          {
            subscriptionGroupIdentifier: "1000000000",
            lastTransactions: [
              {
                originalTransactionId: ORIGINAL_TRANSACTION_ID,
                status: 1,
                signedTransactionInfo: "aaa.bbb.ccc",
              },
            ],
          },
        ],
      }),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_unreadable_transaction" });
  });

  it("denies a StatusResponse with no subscription for this customer", async () => {
    routes = [
      appStore(APP_STORE_PROD, 200, { environment: "Production", bundleId: "com.twistloom.app", data: [] }),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_no_subscription_status" });
  });

  it("denies a response for a different app bundle", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({}, { bundleId: "com.attacker.app" }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_bundle_mismatch" });
  });

  it("denies when only the signed claims disagree about the bundle", async () => {
    // The root is silent (or clean) — the App-Store-signed claims are the
    // authoritative binding and a mismatch there must still deny.
    routes = [
      appStore(
        APP_STORE_PROD,
        200,
        await subscriptionStatus({ transaction: { bundleId: "com.attacker.app" } }, { bundleId: undefined }),
      ),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome).toEqual({ kind: "denied", reason: "appstore_bundle_mismatch" });
  });

  it("accepts the root bundle id when the claims omit one", async () => {
    routes = [
      appStore(
        APP_STORE_PROD,
        200,
        await subscriptionStatus({ transaction: { bundleId: undefined } }),
      ),
    ];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("verified");
  });

  it("prefers the environment Apple signed into the transaction over the envelope", async () => {
    routes = [appStore(APP_STORE_PROD, 200, await subscriptionStatus({ transaction: { environment: "Sandbox" } }))];

    const outcome = await verifyAppStore(APP_STORE_PROOF);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.receipt.environment).toBe("Sandbox");
  });
});
