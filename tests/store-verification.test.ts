/**
 * Store purchase verification — server contract (B1 / VIP Q6 + credits Q2).
 *
 * Exercises the endpoints a Flutter client will call, without a live store or
 * a live database:
 * - the server-side product registry (a client cannot name a pack it did not buy)
 * - `503 store_verification_unavailable` while OG-2 credentials are absent
 * - `denied` / `pending` / `verified` as distinct, parseable answers
 * - replay idempotency: resubmitting one purchase grants exactly once
 * - rate limiting and the auth middleware in front of both endpoints
 *
 * Store facts are injected through `setStoreVerifierForTesting`; database rows
 * live in `tests/helpers/store-verification-db.ts`, which reproduces the
 * schema's composite unique indexes because those constraints *are* the
 * idempotency guarantee being asserted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { CREDIT_PACKS } from "../src/config/credits.js";
import { createFakeDb, type FakeDb } from "./helpers/store-verification-db.js";

// ---------------------------------------------------------------------------
// Environment — the config modules read these once, so set them before any
// dynamic import of `src/config/store-verification.js`.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "GOOGLE_PLAY_ENABLED",
  "GOOGLE_PLAY_PACKAGE_NAME",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH",
  "APP_STORE_ENABLED",
  "APP_STORE_BUNDLE_ID",
  "APP_STORE_ISSUER_ID",
  "APP_STORE_KEY_ID",
  "APP_STORE_PRIVATE_KEY",
  "APP_STORE_PRIVATE_KEY_PATH",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  ORIGINAL_ENV[key] = process.env[key];
  delete process.env[key];
}

const USER_ID = "11111111-1111-1111-1111-111111111111";
/** A second app account — the one a shared device or a leaked token might belong to. */
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// Module doubles (captured before `mock.module`, per the bearer-matrix pattern)
// ---------------------------------------------------------------------------

const fakeDb: FakeDb = createFakeDb();
const actualDb = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDb,
  dbRead: fakeDb.dbRead,
  dbWrite: fakeDb.dbWrite,
}));

let rateLimitAllowed = true;
const actualRedis = await import("../src/utils/redis.js");
mock.module("../src/utils/redis.js", () => ({
  ...actualRedis,
  checkRateLimit: async () => ({ allowed: rateLimitAllowed, requestCount: 1 }),
}));

// `requireAuth` only checks `c.get("userId")`; in production the global auth
// middleware in `app.ts` fills it. The test app plays that role, so the real
// `requireAuth` stays in the chain and the unauthenticated case below can omit
// it rather than mocking the middleware.
function attachTestUser(c: any, next: () => Promise<void>) {
  c.set("user", { id: USER_ID });
  c.set("userId", USER_ID);
  return next();
}

const {
  resolveStoreProduct,
  setStoreVerifierForTesting,
  setStoreFinalizerForTesting,
  resetStoreVerifiers,
} = await import("../src/services/store-verification/index.js");
const { storeVerificationReady } = await import("../src/config/store-verification.js");
const { verifyGooglePlay } = await import("../src/services/store-verification/google-play.js");
const { verifyAppStore } = await import("../src/services/store-verification/app-store.js");
const { parseJsonBody } = await import("../src/middleware/body.js");
const paymentsRouter = (await import("../src/routes/payments.js")).default;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date();
const FIRST_PERIOD_END = new Date(now.getTime() + 25 * 86_400_000);
const SECOND_PERIOD_END = new Date(FIRST_PERIOD_END.getTime() + 30 * 86_400_000);

const SUBSCRIPTION_PROOF = {
  platform: "googlePlay",
  productId: "vip_monthly",
  transactionId: "tok_alpha",
};

function subscriptionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    platform: "google_play",
    kind: "subscription",
    productId: "vip_monthly",
    purchaseKey: "tok_alpha",
    orderId: null,
    entitlementStart: new Date(now.getTime() - 5 * 86_400_000),
    entitlementEnd: FIRST_PERIOD_END,
    autoRenewing: true,
    entitled: true,
    state: "ACTIVE",
    environment: "PRODUCTION",
    metadata: { autoRenewing: true },
    ...overrides,
  } as any;
}

function buildApp() {
  const app = new Hono();
  app.use("*", parseJsonBody);
  app.use("*", attachTestUser);
  app.route("/api/payments", paymentsRouter);
  return app;
}

async function post(app: Hono, path: string, body: unknown) {
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${path} returned non-JSON ${response.status}: ${text.slice(0, 400)}`);
  }
}

function seedUser(credits = 40) {
  fakeDb.rows.users.push({
    userId: USER_ID,
    username: "store-tester",
    credits,
    tier: "standard",
    subscriptionId: null,
    vipExpiresAt: null,
  });
}

const originalStoreProductId = CREDIT_PACKS[0].storeProductId;

beforeAll(() => {
  CREDIT_PACKS[0].storeProductId = "com.twistloom.credits.observer";
});

afterAll(() => {
  CREDIT_PACKS[0].storeProductId = originalStoreProductId;
  resetStoreVerifiers();
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  fakeDb.reset();
  rateLimitAllowed = true;
  setStoreVerifierForTesting(null);
  setStoreFinalizerForTesting(null);
});

// ---------------------------------------------------------------------------

describe("store product registry", () => {
  it("recognises the VIP subscription product", () => {
    expect(resolveStoreProduct("vip_monthly")).toEqual({ kind: "subscription", productId: "vip_monthly" });
  });

  it("resolves a registered store credit pack", () => {
    expect(resolveStoreProduct("com.twistloom.credits.observer")).toMatchObject({
      kind: "consumable",
      packId: "observer",
      credits: 50,
    });
  });

  it("refuses an unregistered product id", () => {
    expect(resolveStoreProduct("com.attacker.premium")).toBeNull();
    expect(resolveStoreProduct("")).toBeNull();
    expect(resolveStoreProduct(null)).toBeNull();
    expect(resolveStoreProduct(42)).toBeNull();
  });

  it("refuses packs whose store listing is not published yet (OG-2)", () => {
    CREDIT_PACKS[0].storeProductId = null;
    try {
      expect(resolveStoreProduct("com.twistloom.credits.observer")).toBeNull();
    } finally {
      CREDIT_PACKS[0].storeProductId = "com.twistloom.credits.observer";
    }
  });
});

describe("store platform parsing", () => {
  it("accepts both wire spellings", async () => {
    const { parseStorePlatform } = await import("../src/config/store-verification.js");
    expect(parseStorePlatform("googlePlay")).toBe("google_play");
    expect(parseStorePlatform("google_play")).toBe("google_play");
    expect(parseStorePlatform("appStore")).toBe("app_store");
    expect(parseStorePlatform("app_store")).toBe("app_store");
  });

  it("rejects anything it cannot name", async () => {
    const { parseStorePlatform } = await import("../src/config/store-verification.js");
    expect(parseStorePlatform("stripe")).toBeNull();
    expect(parseStorePlatform("")).toBeNull();
    expect(parseStorePlatform(undefined)).toBeNull();
    expect(parseStorePlatform(7)).toBeNull();
  });
});

describe("unconfigured store credentials", () => {
  it("reports every platform as not ready by default", async () => {
    expect(storeVerificationReady("google_play")).toBe(false);
    expect(storeVerificationReady("app_store")).toBe(false);
  });

  it("answers unavailable rather than denied from both verifiers", async () => {
    const google = await verifyGooglePlay({
      platform: "google_play",
      kind: "subscription",
      productId: "vip_monthly",
      transactionId: "tok_alpha",
    });
    expect(google).toEqual({ kind: "unavailable", reason: "google_play_not_configured" });

    const apple = await verifyAppStore({
      platform: "app_store",
      kind: "subscription",
      productId: "vip_monthly",
      transactionId: "1000000123456789",
    });
    expect(apple).toEqual({ kind: "unavailable", reason: "app_store_not_configured" });
  });

  it("returns 503 store_verification_unavailable for both endpoints", async () => {
    const app = buildApp();
    const subscription = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(subscription.status).toBe(503);
    expect(subscription.body.code).toBe("store_verification_unavailable");

    const credits = await post(app, "/api/payments/store-credit/verify", {
      store: "google_play",
      productId: "com.twistloom.credits.observer",
      verificationData: "tok_pack",
    });
    expect(credits.status).toBe(503);
    expect(credits.body.code).toBe("store_verification_unavailable");
  });
});

describe("request validation", () => {
  const app = buildApp();

  it("rejects an unknown platform", async () => {
    const result = await post(app, "/api/payments/subscription/verify", {
      ...SUBSCRIPTION_PROOF,
      platform: "stripe",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("invalid_platform");
  });

  it("rejects a proof with no transaction id", async () => {
    const result = await post(app, "/api/payments/subscription/verify", {
      ...SUBSCRIPTION_PROOF,
      transactionId: "   ",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("missing_purchase_proof");
  });

  it("rejects an unregistered product before contacting a store", async () => {
    const result = await post(app, "/api/payments/subscription/verify", {
      ...SUBSCRIPTION_PROOF,
      productId: "com.attacker.premium",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("unknown_product");
  });

  it("will not verify a credit pack through the subscription endpoint", async () => {
    const result = await post(app, "/api/payments/subscription/verify", {
      ...SUBSCRIPTION_PROOF,
      productId: "com.twistloom.credits.observer",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("product_kind_mismatch");
  });

  it("will not verify a subscription through the credit endpoint", async () => {
    const result = await post(app, "/api/payments/store-credit/verify", {
      store: "google_play",
      productId: "vip_monthly",
      verificationData: "tok_alpha",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("product_kind_mismatch");
  });
});

describe("verification answers", () => {
  const app = buildApp();

  it("reports denied without touching the database", async () => {
    setStoreVerifierForTesting(async () => ({ kind: "denied", reason: "play_token_rejected_400" }));
    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "denied" });
    expect(fakeDb.rows.subscriptions).toHaveLength(0);
  });

  it("reports pending without granting anything", async () => {
    setStoreVerifierForTesting(async () => ({ kind: "pending", reason: "play_pending_payment" }));
    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "pending" });
    expect(fakeDb.rows.subscriptions).toHaveLength(0);
  });

  it("gives the credit endpoint a parseable balance on a denial", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "denied", reason: "appstore_revoked" }));
    const result = await post(app, "/api/payments/store-credit/verify", {
      store: "app_store",
      productId: "com.twistloom.credits.observer",
      verificationData: "1000000123456789",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "denied", granted: false, newBalance: 40 });
  });
});

describe("VIP grant and replay", () => {
  const app = buildApp();

  it("grants once and answers an identical replay with the same row", async () => {
    seedUser(40);
    const receipt = subscriptionReceipt();
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt }));

    const first = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("verified");
    expect(first.body.subscription).toMatchObject({ gateway: "google_play", status: "active" });
    expect(first.body.credits).toBe(240); // 40 + VIP_BENEFITS.monthlyCredits

    const second = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(second.body).toEqual(first.body);

    expect(fakeDb.rows.subscriptions).toHaveLength(1);
    expect(
      fakeDb.rows.transactions.filter((row) => row.context === "subscription_activation"),
    ).toHaveLength(1);
    expect(fakeDb.rows.users[0].tier).toBe("vip");
    expect(fakeDb.rows.users[0].subscriptionId).toBe(fakeDb.rows.subscriptions[0].id);
  });

  it("advances the period exactly once when the store reports a renewal", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({
      kind: "verified",
      receipt: subscriptionReceipt(),
    }));
    await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);

    const renewedReceipt = subscriptionReceipt({ entitlementEnd: SECOND_PERIOD_END });
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: renewedReceipt }));

    const renewal = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(renewal.status).toBe(200);
    expect(renewal.body.subscription.currentPeriodEnd).toBe(SECOND_PERIOD_END.toISOString());

    const replay = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(replay.body.subscription.currentPeriodEnd).toBe(SECOND_PERIOD_END.toISOString());

    expect(fakeDb.rows.subscriptions).toHaveLength(1);
    expect(fakeDb.rows.subscriptions[0].currentPeriodEnd.getTime()).toBe(SECOND_PERIOD_END.getTime());
    expect(
      fakeDb.rows.subscriptionTransactions.filter((row) => row.type === "renewal"),
    ).toHaveLength(1);
    expect(
      fakeDb.rows.transactions.filter((row) => row.context === "subscription_renewal"),
    ).toHaveLength(1);
  });

  it("refuses a token whose row another account already owns", async () => {
    seedUser(40);
    // The foreign row sits in an *earlier* period than the proof, so without an
    // ownership gate this call would renew it and then repoint the caller's
    // `users.subscriptionId` at someone else's subscription.
    fakeDb.rows.subscriptions.push({
      userId: OTHER_USER_ID,
      gateway: "google_play",
      providerSubscriptionId: "tok_alpha",
      providerCustomerId: "tok_alpha",
      providerPriceId: "vip_monthly",
      status: "active",
      currentPeriodStart: new Date(now.getTime() - 40 * 86_400_000),
      currentPeriodEnd: new Date(now.getTime() + 5 * 86_400_000),
      cancelAtPeriodEnd: false,
      isTrial: false,
      metadata: null,
    });
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: subscriptionReceipt() }));

    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "denied" });
    // The caller gains nothing…
    expect(fakeDb.rows.users[0].tier).toBe("standard");
    expect(fakeDb.rows.users[0].subscriptionId).toBeNull();
    expect(fakeDb.rows.users[0].credits).toBe(40);
    // …and the other account's row is left exactly as it was.
    expect(fakeDb.rows.subscriptions).toHaveLength(1);
    expect(fakeDb.rows.subscriptions[0].userId).toBe(OTHER_USER_ID);
    expect(fakeDb.rows.subscriptions[0].currentPeriodEnd.getTime()).toBe(now.getTime() + 5 * 86_400_000);
    expect(fakeDb.rows.subscriptionTransactions).toHaveLength(0);
  });

  it("stops serving a row the store reports as no longer entitled", async () => {
    seedUser(40);
    fakeDb.rows.subscriptions.push({
      userId: USER_ID,
      gateway: "google_play",
      providerSubscriptionId: "tok_alpha",
      providerCustomerId: "tok_alpha",
      providerPriceId: "vip_monthly",
      status: "active",
      currentPeriodStart: new Date(now.getTime() - 40 * 86_400_000),
      currentPeriodEnd: new Date(now.getTime() + 10 * 86_400_000),
      cancelAtPeriodEnd: false,
      isTrial: false,
      metadata: null,
    });
    setStoreVerifierForTesting(async () => ({
      kind: "verified",
      receipt: subscriptionReceipt({ entitled: false, state: "EXPIRED" }),
    }));

    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "denied" });
    expect(fakeDb.rows.subscriptions[0].status).toBe("canceled");
  });
});

describe("credit pack grant and replay", () => {
  const app = buildApp();
  const CREDIT_PROOF = {
    store: "google_play",
    productId: "com.twistloom.credits.observer",
    verificationData: "tok_pack",
    packId: "observer",
  };

  function packReceipt() {
    return {
      platform: "google_play",
      kind: "consumable",
      productId: "com.twistloom.credits.observer",
      purchaseKey: "tok_pack",
      orderId: "GPA.1234-5678-9012-34567890",
      entitlementStart: now,
      entitlementEnd: null,
      autoRenewing: false,
      entitled: true,
      state: "PURCHASE_STATE_PURCHASED",
      environment: "PRODUCTION",
      metadata: { quantity: 1 },
    } as any;
  }

  it("grants the pack plus the first-purchase bonus, then never again", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));

    const first = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "verified",
      granted: true,
      alreadyGranted: false,
      bonusCredits: 50,
      newBalance: 140, // 40 + 50 pack + 50 first-purchase bonus
    });

    const replay = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      granted: false,
      alreadyGranted: true,
      bonusCredits: 0,
      newBalance: 140,
    });

    expect(
      fakeDb.rows.transactions.filter((row) => row.context === "credit_pack_purchase"),
    ).toHaveLength(1);
    expect(
      fakeDb.rows.transactions.filter((row) => row.type === "first_purchase_bonus"),
    ).toHaveLength(1);
    expect(fakeDb.rows.users[0].credits).toBe(140);
  });

  it("ignores a packId that disagrees with the product the server resolved", async () => {
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));
    const result = await post(app, "/api/payments/store-credit/verify", {
      ...CREDIT_PROOF,
      packId: "mastermind",
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("product_kind_mismatch");
  });

  it("answers denied instead of alreadyGranted when another account owns the pack", async () => {
    seedUser(40);
    fakeDb.rows.transactions.push({
      userId: OTHER_USER_ID,
      gateway: "google_play",
      providerPaymentId: "GPA.1234-5678-9012-34567890",
      type: "purchase",
      context: "credit_pack_purchase",
      credits: 50,
    });
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));

    const result = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);

    expect(result.status).toBe(200);
    // `alreadyGranted` would tell this account the pack was theirs once.
    expect(result.body).toMatchObject({
      status: "denied",
      granted: false,
      alreadyGranted: false,
      bonusCredits: 0,
      newBalance: 40,
    });
    expect(fakeDb.rows.users[0].credits).toBe(40);
    expect(fakeDb.rows.transactions).toHaveLength(1);
    expect(fakeDb.rows.transactions[0].userId).toBe(OTHER_USER_ID);
  });
});

describe("post-grant finalize (verify → grant → store write)", () => {
  const app = buildApp();
  const CREDIT_PROOF = {
    store: "google_play",
    productId: "com.twistloom.credits.observer",
    verificationData: "tok_pack",
    packId: "observer",
  };

  function packReceipt() {
    return {
      platform: "google_play",
      kind: "consumable",
      productId: "com.twistloom.credits.observer",
      purchaseKey: "tok_pack",
      orderId: "GPA.1234-5678-9012-34567890",
      entitlementStart: now,
      entitlementEnd: null,
      autoRenewing: false,
      entitled: true,
      state: "PURCHASE_STATE_PURCHASED",
      environment: "PRODUCTION",
      metadata: { quantity: 1 },
    } as any;
  }

  it("runs the store write only after the grant has committed", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));
    const packRowsAtFinalize: number[] = [];
    setStoreFinalizerForTesting(async () => {
      packRowsAtFinalize.push(
        fakeDb.rows.transactions.filter((row) => row.context === "credit_pack_purchase").length,
      );
      return true;
    });

    const result = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("verified");
    // Reading the grant inside the finalize proves the ordering, not just that
    // both happened: the row was already committed when Play was written to.
    expect(packRowsAtFinalize).toEqual([1]);
    expect(fakeDb.rows.users[0].credits).toBe(140);
  });

  it("finalizes the replay path too, so a failed write can be retried", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));
    let finalized = 0;
    setStoreFinalizerForTesting(async () => {
      finalized += 1;
      return true;
    });

    await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);
    await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);

    expect(finalized).toBe(2);
    expect(fakeDb.rows.transactions.filter((row) => row.context === "credit_pack_purchase")).toHaveLength(1);
  });

  it("never finalizes a purchase the grant refused", async () => {
    seedUser(40);
    fakeDb.rows.transactions.push({
      userId: OTHER_USER_ID,
      gateway: "google_play",
      providerPaymentId: "GPA.1234-5678-9012-34567890",
      type: "purchase",
      context: "credit_pack_purchase",
      credits: 50,
    });
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));
    let finalized = 0;
    setStoreFinalizerForTesting(async () => {
      finalized += 1;
      return true;
    });

    const result = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);

    expect(result.body.status).toBe("denied");
    // Play's three-day auto-refund must stay available for money we did not deliver.
    expect(finalized).toBe(0);
  });

  it("never finalizes a verification that did not verify", async () => {
    seedUser(40);
    let finalized = 0;
    setStoreFinalizerForTesting(async () => {
      finalized += 1;
      return true;
    });

    setStoreVerifierForTesting(async () => ({ kind: "pending", reason: "test" }));
    await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    setStoreVerifierForTesting(async () => ({ kind: "denied", reason: "test" }));
    await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);

    expect(finalized).toBe(0);
  });

  it("finalizes a granted VIP subscription with a subscription receipt", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: subscriptionReceipt() }));
    let finalized: any = null;
    setStoreFinalizerForTesting(async (receipt) => {
      finalized = receipt;
      return true;
    });

    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("verified");
    expect(finalized).toMatchObject({ kind: "subscription", productId: "vip_monthly", purchaseKey: "tok_alpha" });
  });

  it("never finalizes a subscription grant the store says has lapsed", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({
      kind: "verified",
      receipt: subscriptionReceipt({ entitled: false, state: "EXPIRED" }),
    }));
    let finalized = 0;
    setStoreFinalizerForTesting(async () => {
      finalized += 1;
      return true;
    });

    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);

    expect(result.body).toEqual({ status: "denied" });
    expect(finalized).toBe(0);
  });

  it("never lets a failing store write fail a committed grant", async () => {
    seedUser(40);
    setStoreVerifierForTesting(async () => ({ kind: "verified", receipt: packReceipt() }));
    setStoreFinalizerForTesting(async () => {
      throw new Error("store write unavailable");
    });

    const result = await post(app, "/api/payments/store-credit/verify", CREDIT_PROOF);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "verified", granted: true, newBalance: 140 });
    expect(fakeDb.rows.users[0].credits).toBe(140);
  });
});

describe("rate limiting", () => {
  it("answers 429 once the per-user budget is spent", async () => {
    const app = buildApp();
    rateLimitAllowed = false;
    setStoreVerifierForTesting(async () => ({ kind: "denied", reason: "test" }));
    const result = await post(app, "/api/payments/subscription/verify", SUBSCRIPTION_PROOF);
    expect(result.status).toBe(429);
  });
});

describe("authentication", () => {
  it("does not reach the handler without a session", async () => {
    const app = new Hono();
    app.use("*", parseJsonBody);
    app.route("/api/payments", paymentsRouter);

    const response = await app.request("/api/payments/subscription/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SUBSCRIPTION_PROOF),
    });
    expect(response.status).toBe(401);
  });
});
