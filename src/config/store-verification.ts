/**
 * Store purchase verification configuration (Google Play Billing + Apple StoreKit).
 *
 * One adapter serves two product types — VIP entitlement
 * (`POST /api/payments/subscription/verify`) and store credit packs
 * (`POST /api/payments/store-credit/verify`) — because the roadmap assigned a
 * single owner for store verification (VIP Q6 / credits Q2). Verification is a
 * **server-side** decision: a store callback alone never grants anything.
 *
 * Both master switches default to `false`. While a platform is off the verify
 * endpoints answer `503 store_verification_unavailable` instead of guessing,
 * because an unavailable store must never read as a denial and must never read
 * as a grant. Credentials are server-side only and must never reach the client,
 * source or logs.
 *
 * Env (naming follows the existing `PROVIDER_ROLE` convention):
 * - `GOOGLE_PLAY_ENABLED` — master switch for Play verification
 * - `GOOGLE_PLAY_PACKAGE_NAME` — Android application id (e.g. `com.twistloom.app`)
 * - `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` — service-account key JSON (inline), or
 *   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH` — path to the same file
 * - `APP_STORE_ENABLED` — master switch for App Store verification
 * - `APP_STORE_BUNDLE_ID` — iOS bundle id
 * - `APP_STORE_ISSUER_ID` / `APP_STORE_KEY_ID` / `APP_STORE_PRIVATE_KEY` (PKCS8
 *   inline, newlines as `\n`) or `APP_STORE_PRIVATE_KEY_PATH` — App Store
 *   Connect API key
 *
 * @see docs/roadmap/OWNER_GATES_REGISTER.md OG-2 for the clearance steps
 */

/** Store platforms a purchase proof can name — mirrors the client wire values. */
export type StoreVerificationPlatform = "google_play" | "app_store";

const APP_STORE_BASE_URL = "https://api.appstoreconnect.apple.com";
/**
 * Sandbox host of the App Store Server API.
 *
 * A transaction bought in a sandbox account simply does not exist on the
 * production host (404 / `4040010 TransactionIdNotFoundError`), so verification
 * retries there before calling it a denial — see `app-store.ts`. Fixed, not
 * env-configurable: Apple owns both hosts and the path/auth scheme is shared.
 */
const APP_STORE_SANDBOX_BASE_URL = "https://api.storekit-sandbox.apple.com";

/**
 * Store verification settings, read from the environment **on every access**.
 *
 * The live read is deliberate. A process-wide snapshot evaluated at import time
 * cannot be varied by a test: `bun test` runs every file in one process, so a
 * file that imported this module first would pin every later file to its state
 * (and a module mock of this path cannot be unregistered). Production behaviour
 * is identical either way — the environment of a running server does not change
 * — while tests can now enable a platform per case and put it back.
 */
export const STORE_VERIFICATION_CONFIG = {
  get googlePlay() {
    return {
      /** Master kill-switch — while false the verify endpoints answer 503. */
      enabled: process.env.GOOGLE_PLAY_ENABLED === "true",
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME || "",
      /** Inline service-account JSON. Mutually exclusive with `serviceAccountJsonPath`. */
      serviceAccountJson: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "",
      serviceAccountJsonPath: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH || "",
      /** OAuth2 scope required by the Android Publisher API. */
      scope: "https://www.googleapis.com/auth/androidpublisher",
      apiBaseUrl: "https://androidpublisher.googleapis.com/androidpublisher/v3",
    } as const;
  },
  get appStore() {
    return {
      /** Master kill-switch — while false the verify endpoints answer 503. */
      enabled: process.env.APP_STORE_ENABLED === "true",
      bundleId: process.env.APP_STORE_BUNDLE_ID || "",
      issuerId: process.env.APP_STORE_ISSUER_ID || "",
      keyId: process.env.APP_STORE_KEY_ID || "",
      /** PKCS8 private key inline (`\n` escaped) — never logged, never sent to a client. */
      privateKey: (process.env.APP_STORE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      privateKeyPath: process.env.APP_STORE_PRIVATE_KEY_PATH || "",
      baseUrl: APP_STORE_BASE_URL,
      /** Sandbox host retried after a production 404 (sandbox transactions). */
      sandboxBaseUrl: APP_STORE_SANDBOX_BASE_URL,
      /** JWT audience required by the App Store Server API. */
      audience: "appstoreconnect-v1",
      /** Token lifetime in seconds (Apple allows ≤ 20 minutes). */
      tokenLifetimeSeconds: 1200,
    } as const;
  },
};

/**
 * Whether a platform can actually be queried right now — the master switch is
 * on **and** every credential it needs is present.
 *
 * The enable check and the credential check are separate on purpose: an
 * operator may set `*_ENABLED=true` before the keys arrive, and that mis-order
 * must degrade to "unavailable", never to a runtime crash or a silent grant.
 *
 * @param platform - Store platform from the purchase proof
 */
export function storeVerificationReady(platform: StoreVerificationPlatform): boolean {
  if (platform === "google_play") {
    const cfg = STORE_VERIFICATION_CONFIG.googlePlay;
    const hasCredential = cfg.serviceAccountJson.length > 0 || cfg.serviceAccountJsonPath.length > 0;
    return cfg.enabled && cfg.packageName.length > 0 && hasCredential;
  }
  const cfg = STORE_VERIFICATION_CONFIG.appStore;
  const hasPrivateKey = cfg.privateKey.length > 0 || cfg.privateKeyPath.length > 0;
  return cfg.enabled && cfg.bundleId.length > 0 && cfg.issuerId.length > 0 && cfg.keyId.length > 0 && hasPrivateKey;
}

/**
 * Maps a client wire platform (`googlePlay` / `appStore`, from the VIP proof)
 * or a gateway-style value (`google_play` / `app_store`) onto
 * {@link StoreVerificationPlatform}.
 *
 * Returns `null` for anything else — "callers must not verify against a store
 * they cannot name", and an unknown value is contract drift, never a default.
 *
 * @param value - Raw platform string from a request body
 */
export function parseStorePlatform(value: unknown): StoreVerificationPlatform | null {
  if (value === "google_play" || value === "googlePlay") return "google_play";
  if (value === "app_store" || value === "appStore") return "app_store";
  return null;
}
