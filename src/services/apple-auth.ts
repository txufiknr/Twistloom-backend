/**
 * Apple Sign-In identity-token verification (native face).
 *
 * Validates RS256 identity tokens issued by Apple against Apple's JWKS
 * (`https://appleid.apple.com/auth/keys`) using `jose`. Audience is the
 * iOS/macOS bundle id (`APPLE_CLIENT_ID`) so a web Services ID token cannot
 * be replayed against the mobile exchange.
 *
 * Linking is by stable Apple `sub` first; email (including Private Relay
 * addresses) is optional metadata and never used as the sole merge key
 * without a verified provider row (see `createOrUpdateOAuthUser`).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

/** Apple's documented identity-token issuer. */
export const APPLE_ISSUER = "https://appleid.apple.com";

/** Apple JWKS endpoint (RS256 public keys, rotated by Apple). */
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

/** First-login display name supplied only on the initial authorization. */
export interface AppleUserProfile {
  givenName?: string;
  familyName?: string;
}

export interface AppleIdentity {
  /** Stable Apple user identifier — primary link key. */
  sub: string;
  /** Shared email (may be a Private Relay address); absent if withheld. */
  email?: string;
  /** True when Apple's `email_verified` claim is true/`"true"`. */
  emailVerified: boolean;
  name?: string;
}

export type AppleVerifyFailure =
  | "missing_client_id"
  | "invalid_token"
  | "wrong_issuer"
  | "wrong_audience"
  | "missing_sub";

export type VerifyAppleIdentityResult =
  | { ok: true; identity: AppleIdentity }
  | { ok: false; reason: AppleVerifyFailure };

/** Lazily created remote JWKS (cached keys; refresh handled by `jose`). */
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  remoteJwks ??= createRemoteJWKSet(APPLE_JWKS_URL);
  return remoteJwks;
}

function readAudience(payloadAud: unknown): string | undefined {
  if (typeof payloadAud === "string") return payloadAud;
  if (Array.isArray(payloadAud)) {
    return payloadAud.find((v): v is string => typeof v === "string");
  }
  return undefined;
}

/**
 * Normalizes Apple's `email_verified` claim, which may be boolean `true`
 * or the string `"true"`. Anything else is treated as unverified.
 */
export function isAppleEmailVerified(raw: unknown): boolean {
  return raw === true || raw === "true";
}

/**
 * Pure claim checks shared by production verification and unit tests
 * (signature/JWKS step is exercised separately).
 */
export function assertAppleClaims(
  payload: Record<string, unknown>,
  audience: string,
): AppleVerifyFailure | null {
  if (payload.iss !== APPLE_ISSUER) return "wrong_issuer";
  if (readAudience(payload.aud) !== audience) return "wrong_audience";
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) return "missing_sub";
  return null;
}

/**
 * Verifies an Apple identity token and projects the identity used for
 * account upsert.
 *
 * @param identityToken - RS256 JWT from `sign_in_with_apple`
 * @param profile - Optional first-login name fields (not inside the JWT)
 * @returns Typed identity or a stable failure reason (never throws for
 *   expected invalid-token cases)
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  profile?: AppleUserProfile,
): Promise<VerifyAppleIdentityResult> {
  const audience = process.env.APPLE_CLIENT_ID;
  if (!audience) return { ok: false, reason: "missing_client_id" };

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(identityToken, getJwks(), {
      issuer: APPLE_ISSUER,
      audience,
      algorithms: ["RS256"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("issuer")) return { ok: false, reason: "wrong_issuer" };
    if (message.includes("audience")) return { ok: false, reason: "wrong_audience" };
    return { ok: false, reason: "invalid_token" };
  }

  const claimFailure = assertAppleClaims(payload, audience);
  if (claimFailure) return { ok: false, reason: claimFailure };

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const nameParts = [profile?.givenName, profile?.familyName]
    .filter((p): p is string => Boolean(p && p.trim().length > 0))
    .join(" ");

  return {
    ok: true,
    identity: {
      sub: payload.sub as string,
      email: email?.toLowerCase(),
      emailVerified: isAppleEmailVerified(payload.email_verified),
      name: nameParts.length > 0 ? nameParts : undefined,
    },
  };
}

/** Test hook: replace the remote JWKS resolver (unit tests inject local keys). */
export function setAppleJwksForTesting(
  jwks: ReturnType<typeof createRemoteJWKSet> | null,
): void {
  remoteJwks = jwks;
}
