/**
 * Apple App Store Server API purchase verifier.
 *
 * Endpoints:
 * - Subscriptions: `GET /inApps/v1/subscriptions/{transactionId}` — Apple's
 *   `StatusResponse` nests as `data[]` → `SubscriptionGroupIdentifierItem`
 *   (`subscriptionGroupIdentifier`, `lastTransactions[]`) → `lastTransactionsItem`
 *   (`originalTransactionId`, `status`, `signedTransactionInfo`,
 *   `signedRenewalInfo`). The facts used for entitlement (`productId`,
 *   `expiresDate`, `purchaseDate`, `revocationDate`, `autoRenewStatus`) live
 *   **inside the App-Store-signed JWS payloads**, never on the group items —
 *   see {@link collectStatusEntries} / {@link selectStatusEntry}.
 * - Consumables: `GET /inApps/v1/transactions/{transactionId}` — a signed
 *   transaction whose payload carries `productId`, `purchaseDate`, `revocationDate`.
 *
 * The client's `signedTransaction` (JWS) is deliberately **never** a grant
 * source: it is client-held data and we do not keep Apple's certificate chain
 * to validate it. The server-to-server call above is the authority, and the
 * claimed `productId` is matched against what Apple returns for that
 * transaction id — that is the purchase/product binding check. The app
 * binding reads `bundleId` from the **signed claims** (plus the `StatusResponse`
 * root when present): `TransactionInfoResponse` has no root `bundleId` field,
 * so a root-only check would never run — see {@link bundleIdDenial}.
 *
 * The JWS returned *by Apple over TLS* is decoded without signature
 * verification: the transport and our API key establish authenticity, and a
 * signature check would only re-prove the same channel. Both the production
 * host (`api.appstoreconnect.apple.com`) and the sandbox host
 * (`api.storekit-sandbox.apple.com`) are Apple-operated endpoints on that same
 * channel, so a sandbox retry inherits the assumption; if responses ever come
 * from some other host, verify `xc` instead.
 *
 * > **Open follow-up (P2, non-blocking):** optionally verify the `x5c`
 * > certificate chain of the nested `signedTransactionInfo` /
 * > `signedRenewalInfo` JWS against Apple's root CA before trusting their
 * > claims. This is defence-in-depth only — the payloads already arrive inside
 * > the authenticated TLS channel described above, which is the trust anchor
 * > this module documents. Track it with the other store-verification P2 items
 * > in `docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md`.
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

/**
 * Decodes one App-Store-signed JWS into its claims.
 *
 * Decoding (not verifying) is deliberate and documented in the module header:
 * the JWS arrives inside an authenticated TLS response from Apple's own host.
 *
 * @param signed - Compact JWS (`header.payload.signature`) or anything else
 * @returns The decoded claims, or `null` when `signed` is not a readable
 *   three-part JWS — the caller decides whether that is fatal
 */
function decodeJwsClaims(signed: unknown): Record<string, unknown> | null {
  if (typeof signed !== "string" || signed.split(".").length !== 3) return null;
  try {
    return asRecord(decodeJwt(signed));
  } catch {
    return null;
  }
}

/**
 * Denies a purchase whose bundle binding does not match the configured app.
 *
 * The bundle id can arrive in two places: inside the App-Store-signed JWS
 * claims (`JWSTransactionDecodedPayload.bundleId` — the authoritative one) and,
 * for the `StatusResponse` envelope only, as a root `bundleId` field.
 * `TransactionInfoResponse` (the single-transaction endpoint behind
 * {@link verifyConsumable}) carries **no** root `bundleId` at all — checking the
 * root alone is a check that never runs, which is the gap this helper closes.
 *
 * Every candidate that is present must equal the configured bundle id, and a
 * configured verifier with **no** candidate anywhere is denied: when
 * `APP_STORE_BUNDLE_ID` is set, an unbindable transaction fails closed —
 * the same doctrine as the missing-`productId` / missing-`expiresDate` checks.
 *
 * @param rootPayload - Top-level response object
 * @param claims - Decoded `signedTransactionInfo` claims, when readable
 * @returns A denial outcome, or `null` when the transaction binds to this app
 *   (or no bundle id is configured — `storeVerificationReady` already requires
 *   one, so the skip exists only for direct-call tests)
 */
function bundleIdDenial(
  rootPayload: Record<string, unknown>,
  claims: Record<string, unknown> | null,
): StoreVerificationOutcome | null {
  const expected = STORE_VERIFICATION_CONFIG.appStore.bundleId;
  if (!expected) return null;

  const candidates: string[] = [];
  if (claims) {
    const fromClaims = pick(claims, "bundleId", "bundle_id");
    if (typeof fromClaims === "string" && fromClaims.length > 0) candidates.push(fromClaims);
  }
  const fromRoot = rootPayload.bundleId;
  if (typeof fromRoot === "string" && fromRoot.length > 0) candidates.push(fromRoot);

  if (candidates.length === 0 || candidates.some((value) => value !== expected)) {
    return { kind: "denied", reason: "appstore_bundle_mismatch" };
  }
  return null;
}

/** A `lastTransactionsItem` whose signed payloads have been decoded. */
interface DecodedStatusEntry {
  /** The envelope item — carries `status`, `originalTransactionId`. */
  item: Record<string, unknown>;
  /** Claims of `signedTransactionInfo` (`productId`, `expiresDate`, …). */
  transaction: Record<string, unknown>;
  /** Claims of `signedRenewalInfo`, when Apple sent a readable one. */
  renewal: Record<string, unknown> | null;
}

/**
 * Flattens Apple's `StatusResponse` into decoded per-transaction entries.
 *
 * Apple's contract (`StatusResponse.data[]`) is an array of
 * `SubscriptionGroupIdentifierItem`, each holding `subscriptionGroupIdentifier`
 * and a `lastTransactions[]` array; `productId`, `expiresDate`, `status` and
 * friends are **not** on the group items. Reading group items directly (the
 * pre-fix behaviour) found no `expiresDate` and denied every valid
 * subscription as `appstore_missing_expiry`.
 *
 * Entries without a readable `signedTransactionInfo` carry no verifiable
 * facts and are dropped: an entry we cannot read must never be the basis of a
 * grant, and `hasUnreadableTransaction` lets {@link verifySubscription}
 * distinguish "Apple sent something we could not parse" from "Apple sent
 * nothing for this transaction".
 *
 * @param data - The `payload.data` array from a `StatusResponse`
 * @returns Decoded usable entries plus whether any JWS failed to decode
 */
function collectStatusEntries(data: unknown[]): {
  usable: DecodedStatusEntry[];
  hasUnreadableTransaction: boolean;
} {
  const usable: DecodedStatusEntry[] = [];
  let hasUnreadableTransaction = false;

  for (const group of data) {
    const lastTransactions = pick(asRecord(group), "lastTransactions", "last_transactions");
    if (!Array.isArray(lastTransactions)) continue;
    for (const raw of lastTransactions) {
      const item = asRecord(raw);
      const signedTransaction = item.signedTransactionInfo;
      if (typeof signedTransaction !== "string") continue; // no facts to verify
      const transaction = decodeJwsClaims(signedTransaction);
      if (!transaction) {
        hasUnreadableTransaction = true;
        continue;
      }
      usable.push({ item, transaction, renewal: decodeJwsClaims(item.signedRenewalInfo) });
    }
  }

  return { usable, hasUnreadableTransaction };
}

/**
 * Picks the entry that describes the purchase we were asked to verify.
 *
 * Selection order: (1) the entry whose signed transaction names the requested
 * `transactionId` as its `originalTransactionId` or `transactionId` (a client
 * may present either); (2) the entry whose signed `productId` matches the
 * product under verification; (3) a single remaining entry, so a wrong-product
 * purchase still reaches the product-binding check and is denied *there*
 * instead of being mislabelled "no subscription status".
 *
 * @param usable - Decoded entries from {@link collectStatusEntries}
 * @param transactionId - Lookup key the client presented
 * @param productId - Product the route is verifying
 * @returns The selected entry, or `null` when no entry can be identified
 */
function selectStatusEntry(
  usable: DecodedStatusEntry[],
  transactionId: string,
  productId: string,
): DecodedStatusEntry | null {
  const byId = usable.find(({ transaction }) => {
    const original = pick(transaction, "originalTransactionId", "original_transaction_id");
    const current = pick(transaction, "transactionId", "transaction_id");
    return original === transactionId || current === transactionId;
  });
  if (byId) return byId;

  const byProduct = usable.find(({ transaction }) => pick(transaction, "productId", "product_id") === productId);
  if (byProduct) return byProduct;

  return usable.length === 1 ? usable[0] : null;
}

/**
 * Verifies an auto-renewable subscription against `Get All Subscription Statuses`.
 *
 * Every fact used below comes from Apple's response: `status` from the
 * `lastTransactionsItem` envelope, everything else from its
 * `signedTransactionInfo` / `signedRenewalInfo` claims. Missing facts fail
 * **closed** — an absent `productId` or `expiresDate` denies the purchase
 * rather than skipping the check.
 *
 * @param productId - Registered product the client claims to have bought
 * @param transactionId - StoreKit transaction id (current or original)
 */
async function verifySubscription(productId: string, transactionId: string): Promise<StoreVerificationOutcome> {
  const response = await appStoreRequest(
    `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`,
  );
  if (!response.ok) {
    return outcomeForRejection(response.status);
  }

  const payload = asRecord(response.body);
  const data = Array.isArray(payload.data) ? payload.data : [];
  const { usable, hasUnreadableTransaction } = collectStatusEntries(data);
  if (usable.length === 0) {
    return {
      kind: "denied",
      reason: hasUnreadableTransaction ? "appstore_unreadable_transaction" : "appstore_no_subscription_status",
    };
  }

  const entry = selectStatusEntry(usable, transactionId, productId);
  if (!entry) {
    return { kind: "denied", reason: "appstore_no_subscription_status" };
  }
  const { item, transaction, renewal } = entry;

  // Bundle binding — both the `StatusResponse` root and the signed claims must
  // agree with the configured app (claims are authoritative; see bundleIdDenial).
  const bundleDenial = bundleIdDenial(payload, transaction);
  if (bundleDenial) return bundleDenial;

  // Product binding — fail closed: Apple must name the product it verified.
  const appleProductId = pick(transaction, "productId", "product_id");
  if (typeof appleProductId !== "string") {
    return { kind: "denied", reason: "appstore_missing_product" };
  }
  if (appleProductId !== productId) {
    return { kind: "denied", reason: "appstore_product_mismatch" };
  }

  // A refund/revocation wins even while the envelope still reads `active`.
  if (pick(transaction, "revocationDate", "revocation_date") !== undefined) {
    return { kind: "denied", reason: "appstore_revoked" };
  }

  const statusRaw = pick(item, "status");
  const status = typeof statusRaw === "number" ? statusRaw : Number(statusRaw ?? 0);
  const periodEnd = parseEpochMs(pick(transaction, "expiresDate", "expires_date", "expirationDate"));
  const periodStartRaw = parseEpochMs(pick(transaction, "purchaseDate", "purchase_date"));

  if (!periodEnd) {
    return { kind: "denied", reason: "appstore_missing_expiry" };
  }

  const entitled = ENTITLED_STATUSES.has(status) && periodEnd.getTime() > Date.now();
  const autoRenewRaw = renewal ? pick(renewal, "autoRenewStatus", "auto_renew_status") : undefined;
  const autoRenewing = autoRenewRaw === 1 || autoRenewRaw === true;
  const inBillingRetryPeriod = (renewal ? pick(renewal, "isInBillingRetryPeriod") : undefined) === true;

  const originalTransactionId = pick(transaction, "originalTransactionId", "original_transaction_id");
  const appleTransactionId = pick(transaction, "transactionId", "transaction_id");

  const receipt: StoreReceipt = {
    platform: "app_store",
    kind: "subscription",
    productId,
    purchaseKey:
      typeof originalTransactionId === "string" && originalTransactionId.length > 0
        ? originalTransactionId
        : transactionId,
    orderId:
      typeof appleTransactionId === "string" && appleTransactionId.length > 0
        ? appleTransactionId
        : transactionId,
    entitlementStart: periodStartRaw,
    entitlementEnd: periodEnd,
    autoRenewing,
    entitled,
    state: String(status),
    environment: resolveEnvironment(pick(transaction, "environment") ?? payload.environment, response.servedFrom),
    metadata: {
      appleStatus: status,
      autoRenewing,
      isInBillingRetryPeriod: inBillingRetryPeriod,
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

  // Decode first: `TransactionInfoResponse` is `{ signedTransactionInfo }`
  // only — `bundleId`, `productId` and friends live inside the JWS claims,
  // never at the root, so a root-level check would never run.
  let transaction: Record<string, unknown> | null = null;
  const signed = payload.signedTransactionInfo;
  if (signed !== undefined && signed !== null) {
    transaction = decodeJwsClaims(signed);
    if (!transaction) {
      return { kind: "denied", reason: "appstore_unreadable_transaction" };
    }
  } else if (typeof payload.productId === "string") {
    // Flat body (legacy shim): the root itself carries the transaction claims.
    transaction = payload;
  }
  if (!transaction) {
    return { kind: "denied", reason: "appstore_unreadable_transaction" };
  }

  const bundleDenial = bundleIdDenial(payload, transaction);
  if (bundleDenial) return bundleDenial;

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

  // Empty-string claims fall back to the path id — a blank purchaseKey/orderId
  // would collide across rows (mirrors the subscription path's guards).
  const originalTransactionId = pick(transaction, "originalTransactionId", "original_transaction_id");
  const orderIdClaim = pick(transaction, "transactionId", "transaction_id");

  const receipt: StoreReceipt = {
    platform: "app_store",
    kind: "consumable",
    productId,
    purchaseKey:
      typeof originalTransactionId === "string" && originalTransactionId.length > 0
        ? originalTransactionId
        : transactionId,
    orderId: typeof orderIdClaim === "string" && orderIdClaim.length > 0 ? orderIdClaim : transactionId,
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
