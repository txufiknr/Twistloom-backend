/**
 * Auth.js signed-session cookie factory for Step 10 integration tests.
 *
 * Produces a real Auth.js JWE session cookie (same EncryptJWT /
 * A256CBC-HS512 + HKDF construction as `@auth/core/jwt` `encode`) so
 * `getAuthUser` / `verifyNextAuthToken` can decrypt it without a live
 * Next.js frontend.
 *
 * Salt rules (must match Auth.js):
 * - plain cookie name `authjs.session-token`
 * - secure cookie name `__Secure-authjs.session-token`
 */

import { encode, decode } from "@auth/core/jwt";

export type SessionCookieVariant = "plain" | "secure";

export interface CreateSignedSessionCookieOptions {
  email: string;
  name?: string;
  sessionId?: string;
  secret?: string;
  variant?: SessionCookieVariant;
  /** Seconds until the JWE expires (default 24h). */
  maxAgeSeconds?: number;
}

/** Cookie name for a variant (must match Auth.js defaults). */
export function sessionCookieName(variant: SessionCookieVariant = "plain"): string {
  return variant === "secure" ? "__Secure-authjs.session-token" : "authjs.session-token";
}

/** Resolves AUTH_SECRET for tests; falls back to a stable test-only secret. */
export function resolveAuthSecret(override?: string): string {
  return (
    override ??
    process.env.AUTH_SECRET ??
    "step10-test-auth-secret-at-least-32-chars!!"
  );
}

/**
 * Encodes a signed Auth.js session cookie value and returns the full
 * `name=value` pair ready for a `Cookie` request header.
 *
 * The token payload mirrors what the Next.js `jwt()` callback embeds:
 * `email`, `name`, and `sessionId` (read by `verifyNextAuthToken` from
 * `authUser.token.sessionId`).
 */
export async function createSignedSessionCookie(
  options: CreateSignedSessionCookieOptions,
): Promise<{ cookieHeader: string; cookieName: string; token: string }> {
  const variant = options.variant ?? "plain";
  const cookieName = sessionCookieName(variant);
  const secret = resolveAuthSecret(options.secret);

  const token = await encode({
    secret,
    salt: cookieName,
    token: {
      email: options.email,
      name: options.name ?? "Step 10 Tester",
      sessionId: options.sessionId ?? "session-step10",
      sub: options.email,
    },
    maxAge: options.maxAgeSeconds ?? 24 * 60 * 60,
  });

  return {
    cookieHeader: `${cookieName}=${token}`,
    cookieName,
    token,
  };
}

/** Decodes a session token with the matching salt (round-trip assertion helper). */
export async function decodeSignedSessionToken(
  token: string,
  options: { secret?: string; variant?: SessionCookieVariant } = {},
): Promise<Record<string, unknown> | null> {
  const cookieName = sessionCookieName(options.variant ?? "plain");
  return decode({
    token,
    secret: resolveAuthSecret(options.secret),
    salt: cookieName,
  });
}
