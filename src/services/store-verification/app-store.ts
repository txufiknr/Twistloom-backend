/**
 * Apple App Store Server API purchase verifier.
 *
 * Endpoints:
 * - Subscriptions: `GET /inApps/v1/subscriptions/{transactionId}` — status
 *   array with `productId`, `expiresDate`, `status`.
 * - Consumables: `GET /inApps/v1/transactions/{transactionId}` — a signed
 *   transaction whose payload carries `productId`, `purchaseDate`, `revocationDate`.
 *
 * The client's `signedTransaction` (JWS) is deliberately **never** a grant
 * source: it is client-held data and we do not keep Apple's certificate chain
 * to validate it. The server-to-server call above is the authority, and the
 * claimed `productId` is matched against what Apple returns for that
 * transaction id — that is the purchase/product binding check.
 *
 * The JWS returned *by Apple over TLS* is decoded without signature
 * verification: the transport and our API key establish authenticity, and a
 * signature check would only re-prove the same channel. Both the production
 * host (`api.appstoreconnect.apple.com`) and the sandbox host
 * (`api.storekit-sandbox.apple.com`) are Apple-operated endpoints on that same
 * channel, so a sandbox retry inherits the assumption; if responses ever come
 * from some other host, verify `xc` instead.
 *
 * Auth: ES256 JWT signed with the App Store Connect API key
 * (`APP_STORE_ISSUER_ID`/`APP_STORE_KEY_ID`/`APP_STORE_PRIVATE_KEY`).
 */

import { decodeJwt, importPKCS8, SignJWT } from "jose";
import { STORE_VERIFICATION_CONFIG, storeVerificationReady } from "../../config/store-verification.js";
import type { StoreReceipt, StoreVerificationOutcome, StoreVerifier } from "./types.js";

/** Apple `status` values that still grant access to the period. */
const ENTITLED_STATUSES = new Set([1, 3, 4]);

/** Which App Store host answered — used to record the environment honestly. */
type AppStoreHost = "production" | "sandbox";

/**
 * A host's answer. `servedFrom` is null only for a request that never reached
 * a host (a signing failure thrown before the call).
 */
type AppStoreResponse =
  | { ok: true; body: unknown; servedFrom: AppStoreHost }
  | { ok: false; status: number; servedFrom: AppStoreHost | null };

/** Cached signing key keyed by the configured private key. */
let cachedKey: { key: string; promise: Promise<CryptoKey> } | null = null;

/** Drops the cached signing key (used when credentials change in tests). */
export function resetAppStoreAuth(): void {
  cachedKey = null;
}

async function getSigningKey(privateKey: string): Promise<CryptoKey> {
  if (!cachedKey || cachedKey.key !== privateKey) {
    cachedKey = { key: privateKey, promise: importPKCS8(privateKey, "ES256") };
  }
  return cachedKey.promise;
}

async function loadPrivateKey(): Promise<string | null> {
  const cfg = STORE_VERIFICATION_CONFIG.appStore;
  if (cfg.privateKey) return cfg.privateKey;
  if (!cfg.privateKeyPath) return null;
  try {
    const fs = await import("node:fs/promises");
    return (await fs.readFile(cfg.privateKeyPath, "utf8")).trim();
  } catch (error) {
    console.warn("[store-verification] cannot read APP_STORE_PRIVATE_KEY_PATH:", error);
    return null;
  }
}

/** Mints a short-lived bearer token for the App Store Server API. */
async function createToken(): Promise<string> {
  const cfg = STORE_VERIFICATION_CONFIG.appStore;
  const privateKey = await loadPrivateKey();
  if (!privateKey) throw new Error("App Store private key is not configured");
  const key = await getSigningKey(privateKey);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ aud: cfg.audience, scope: cfg.audience })
    .setProtectedHeader({ alg: "ES256", kid: cfg.keyId, typ: "JWT" })
    .setIssuer(cfg.issuerId)
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.tokenLifetimeSeconds)
    .sign(key);
}

/**
 * Calls one App Store Server API host.
 *
 * 404/409 mean "this host has no such transaction", which is a denial from
 * *that host*. 401/403 mean our own key is wrong, which must surface as
 * "unavailable" (audit F7) — never as "your purchase was rejected".
 */
async function requestHost(
  baseUrl: string,
  path: string,
  token: string,
  servedFrom: AppStoreHost,
): Promise<AppStoreResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404 || response.status === 409 || response.status === 401 || response.status === 403) {
    await response.text();
    return { ok: false, status: response.status, servedFrom };
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`App Store Server API ${response.status}: ${body.slice(0, 300)}`);
  }
  return { ok: true, body: await response.json(), servedFrom };
}

/**
 * Calls an App Store Server API path, production first.
 *
 * A sandbox transaction is invisible to the production host — Apple answers
 * 404 (errorCode `4040010`, `TransactionIdNotFoundError`), which a naive
 * verifier turns into "denied", so every sandbox purchase would be refused and
 * StoreKit would keep replaying an unfinished transaction (audit F3). Only a
 * production **404** retries on the sandbox host: 409/401/403 are answers
 * about the request or our key, not about which environment exists.
 */
async function appStoreRequest(path: string): Promise<AppStoreResponse> {
  const cfg = STORE_VERIFICATION_CONFIG.appStore;
  const token = await createToken();
  const production = await requestHost(cfg.baseUrl, path, token, "production");
  if (production.ok || production.status !== 404) return production;
  return requestHost(cfg.sandboxBaseUrl, path, token, "sandbox");
}

/**
 * Resolves the environment a transaction came from.
 *
 * Apple reports it when the payload carries one (`Production`/`Sandbox`);
 * otherwise the host that actually served the record decides, which is sound
 * because the other host already answered 404 for this transaction id.
 *
 * @param reported - `environment` from the response payload, if present
 * @param servedFrom - Host that produced the answer
 */
function resolveEnvironment(reported: unknown, servedFrom: AppStoreHost | null): string | null {
  if (typeof reported === "string" && reported.length > 0) return reported;
  if (servedFrom === "sandbox") return "Sandbox";
  if (servedFrom === "production") return "Production";
  return null;
}

/** Mirrors {@link outcomeForRejection} on the Play side: credentials vs purchase. */
function outcomeForRejection(status: number): StoreVerificationOutcome {
  if (status === 401 || status === 403) {
    return { kind: "unavailable", reason: "app_store_credentials" };
  }
  return { kind: "denied", reason: `appstore_transaction_rejected_${status}` };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** Apple sends epoch milliseconds as a number. */
function parseEpochMs(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value));
  return null;
}

/** Picks the status entry that describes the transaction we were given. */
function pickStatusEntry(data: unknown[], transactionId: string): Record<string, unknown> {
  const entries = data.map(asRecord);
  return (
    entries.find((entry) => pick(entry, "originalTransactionId", "original_transaction_id") === transactionId) ??
    entries.find((entry) => pick(entry, "transactionId", "transaction_id") === transactionId) ??
    entries[0] ??
    {}
  );
}

async function verifySubscription(productId: string, transactionId: string): Promise<StoreVerificationOutcome> {
  const response = await appStoreRequest(
    `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`,
  );
  if (!response.ok) {
    return outcomeForRejection(response.status);
  }

  const payload = asRecord(response.body);
  const entries = Array.isArray(payload.data) ? payload.data : [];
  const entry = pickStatusEntry(entries, transactionId);
  if (Object.keys(entry).length === 0) {
    return { kind: "denied", reason: "appstore_no_subscription_status" };
  }

  const bundleId = typeof payload.bundleId === "string" ? payload.bundleId : null;
  const expectedBundleId = STORE_VERIFICATION_CONFIG.appStore.bundleId;
  if (bundleId && bundleId !== expectedBundleId) {
    return { kind: "denied", reason: "appstore_bundle_mismatch" };
  }

  const appleProductId = pick(entry, "productId", "product_id");
  if (typeof appleProductId === "string" && appleProductId !== productId) {
    return { kind: "denied", reason: "appstore_product_mismatch" };
  }

  const statusRaw = pick(entry, "status");
  const status = typeof statusRaw === "number" ? statusRaw : Number(statusRaw ?? 0);
  const periodEnd = parseEpochMs(pick(entry, "expiresDate", "expires_date", "firstExpiresDate"));
  const periodStartRaw = parseEpochMs(pick(entry, "recentSubscriptionStartDate", "originalPurchaseDate", "purchaseDate"));

  if (!periodEnd) {
    return { kind: "denied", reason: "appstore_missing_expiry" };
  }

  const entitled = ENTITLED_STATUSES.has(status) && periodEnd.getTime() > Date.now();
  const autoRenewRaw = pick(entry, "autoRenewStatus", "auto_renew_status", "willAutoRenew");
  const autoRenewing = autoRenewRaw === 1 || autoRenewRaw === true;

  const receipt: StoreReceipt = {
    platform: "app_store",
    kind: "subscription",
    productId,
    purchaseKey:
      (pick(entry, "originalTransactionId", "original_transaction_id") as string | undefined) ?? transactionId,
    orderId: (pick(entry, "transactionId", "transaction_id") as string | undefined) ?? transactionId,
    entitlementStart: periodStartRaw,
    entitlementEnd: periodEnd,
    autoRenewing,
    entitled,
    state: String(status),
    environment: resolveEnvironment(pick(entry, "environment") ?? payload.environment, response.servedFrom),
    metadata: {
      appleStatus: status,
      autoRenewing,
      isInBillingRetryPeriod: pick(entry, "isInBillingRetryPeriod", "is_in_billing_retry_period") === true,
      expiresDate: periodEnd.toISOString(),
    },
  };

  if (!entitled) return { kind: "denied", reason: `appstore_not_entitled_status_${status}` };
  return { kind: "verified", receipt };
}

async function verifyConsumable(productId: string, transactionId: string): Promise<StoreVerificationOutcome> {
  const response = await appStoreRequest(`/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
  if (!response.ok) {
    return outcomeForRejection(response.status);
  }

  const payload = asRecord(response.body);
  const bundleId = typeof payload.bundleId === "string" ? payload.bundleId : null;
  const expectedBundleId = STORE_VERIFICATION_CONFIG.appStore.bundleId;
  if (bundleId && bundleId !== expectedBundleId) {
    return { kind: "denied", reason: "appstore_bundle_mismatch" };
  }

  let transaction: Record<string, unknown> = {};
  const signed = payload.signedTransactionInfo;
  if (typeof signed === "string" && signed.split(".").length === 3) {
    try {
      transaction = asRecord(decodeJwt(signed));
    } catch {
      return { kind: "denied", reason: "appstore_unreadable_transaction" };
    }
  } else if (typeof payload.productId === "string") {
    transaction = payload;
  }

  const appleProductId = pick(transaction, "productId", "product_id");
  if (typeof appleProductId !== "string") {
    return { kind: "denied", reason: "appstore_missing_product" };
  }
  if (appleProductId !== productId) {
    return { kind: "denied", reason: "appstore_product_mismatch" };
  }

  const revocation = pick(transaction, "revocationDate", "revocation_date");
  if (revocation !== undefined) {
    return { kind: "denied", reason: "appstore_revoked" };
  }

  const purchaseDate = parseEpochMs(pick(transaction, "purchaseDate", "purchase_date"));
  const expiresDate = parseEpochMs(pick(transaction, "expiresDate", "expires_date", "expirationDate"));
  const quantityRaw = pick(transaction, "quantity");
  const environment = pick(transaction, "environment") ?? payload.environment;

  const receipt: StoreReceipt = {
    platform: "app_store",
    kind: "consumable",
    productId,
    purchaseKey:
      (pick(transaction, "originalTransactionId", "original_transaction_id") as string | undefined) ?? transactionId,
    orderId: (pick(transaction, "transactionId", "transaction_id") as string | undefined) ?? transactionId,
    entitlementStart: purchaseDate,
    entitlementEnd: expiresDate,
    autoRenewing: false,
    entitled: true,
    state: "PURCHASED",
    environment: resolveEnvironment(environment, response.servedFrom),
    metadata: {
      quantity: typeof quantityRaw === "number" ? quantityRaw : 1,
      ...(expiresDate ? { expiresDate: expiresDate.toISOString() } : {}),
    },
  };

  return { kind: "verified", receipt };
}

/**
 * Verifies an App Store purchase proof against the App Store Server API.
 *
 * @param input - Lookup keys sent by the client (never trusted data)
 */
export const verifyAppStore: StoreVerifier = async (input) => {
  if (!storeVerificationReady("app_store")) {
    return { kind: "unavailable", reason: "app_store_not_configured" };
  }
  try {
    return input.kind === "subscription"
      ? await verifySubscription(input.productId, input.transactionId)
      : await verifyConsumable(input.productId, input.transactionId);
  } catch (error) {
    // Only our own credential/signing problems reach here; never a denial.
    console.warn("[store-verification] App Store verification error:", error);
    return { kind: "unavailable", reason: "app_store_request_failed" };
  }
};
