/**
 * Mobile Access Token Service (Alternative C — native face)
 *
 * Signs and verifies short-lived HS256 access JWTs for Flutter (and other
 * first-party native clients) using `jose`. Cookie (Auth.js) verification is
 * intentionally untouched — this module only powers the bearer branch.
 *
 * Claims: `sub` (userId), `sid` (auth_sessions id), `tv` (users.token_version),
 * `iss`, `aud` (provisional `reader` until parent Q6 is decided), `exp`, `iat`.
 *
 * Signing material: `MOBILE_ACCESS_SECRET` — **never** reuse `AUTH_SECRET`
 * (cookie JWE material must not double as a mobile signing key without an
 * explicit security review). Dual-secret verify: if `MOBILE_ACCESS_SECRET_PREVIOUS`
 * is set, verification accepts either current or previous key (rotation window).
 *
 * Opaque refresh tokens are handled by `token-family.ts`, not here.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { AuthUser } from "../types/express.js";
import { dbRead } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { updateSessionMetadata } from "./session-manager.js";

/** Default access-token lifetime (minutes). Override with MOBILE_ACCESS_TTL_MINUTES. */
const DEFAULT_ACCESS_TTL_MINUTES = 15;
/** Clock-skew leeway (seconds) accepted on `exp`/`iat`. */
const CLOCK_SKEW_SECONDS = 60;
/** Issuer claim for all mobile access tokens. */
export const MOBILE_TOKEN_ISSUER = "twistloom-backend";
/** Provisional audience (reader) until parent Q6 / Step 12 enforces dual audiences. */
export const PROVISIONAL_AUDIENCE = "reader";
/** `kid` emitted on every JWT so a later RS256/JWKS migration stays non-breaking. */
const KEY_ID = "m0-hs256";

export interface MobileAccessTokenClaims {
  sub: string;
  sid?: string;
  tv: number;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

export interface IssueAccessTokenResult {
  token: string;
  expiresIn: number;
  claims: MobileAccessTokenClaims;
}

/**
 * Access-token TTL in seconds (respects `MOBILE_ACCESS_TTL_MINUTES`).
 * Exported so route responses can report `expiresIn` without re-parsing env.
 */
export function getAccessTtlSeconds(): number {
  const raw = Number(process.env.MOBILE_ACCESS_TTL_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACCESS_TTL_MINUTES;
  return Math.floor(minutes * 60);
}

function getSecretBytes(): Uint8Array {
  const secret = process.env.MOBILE_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "MOBILE_ACCESS_SECRET must be set to at least 32 characters (separate from AUTH_SECRET)",
    );
  }
  return new TextEncoder().encode(secret);
}

function getPreviousSecretBytes(): Uint8Array | null {
  const secret = process.env.MOBILE_ACCESS_SECRET_PREVIOUS;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

function getAudience(): string {
  // Provisional until Step 12; env override allows staging pen experiments.
  return process.env.MOBILE_ACCESS_AUD || PROVISIONAL_AUDIENCE;
}

/**
 * Signs a short-lived HS256 access token for a mobile session.
 *
 * @param userId - Authenticated user id (`sub`)
 * @param sessionId - `auth_sessions.id` bound to this login (`sid`)
 * @param tokenVersion - Current `users.token_version` (`tv`)
 * @returns Signed JWT and absolute expiry in seconds
 * @throws If `MOBILE_ACCESS_SECRET` is missing/too short
 */
export async function issueAccessToken(
  userId: string,
  sessionId: string,
  tokenVersion: number,
): Promise<IssueAccessTokenResult> {
  const ttl = getAccessTtlSeconds();
  const secret = getSecretBytes();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  const token = await new SignJWT({
    sid: sessionId,
    tv: tokenVersion,
  })
    .setProtectedHeader({ alg: "HS256", kid: KEY_ID, typ: "JWT" })
    .setSubject(userId)
    .setIssuer(MOBILE_TOKEN_ISSUER)
    .setAudience(getAudience())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret);

  return {
    token,
    expiresIn: ttl,
    claims: {
      sub: userId,
      sid: sessionId,
      tv: tokenVersion,
      iss: MOBILE_TOKEN_ISSUER,
      aud: getAudience(),
      exp,
      iat: now,
    },
  };
}

export type VerifyAccessTokenFailure =
  | "malformed"
  | "expired"
  | "wrong_issuer"
  | "wrong_audience"
  | "algorithm"
  | "secret";

export type VerifyAccessTokenResult =
  | { ok: true; claims: MobileAccessTokenClaims }
  | { ok: false; reason: VerifyAccessTokenFailure };

/**
 * Verifies a mobile access JWT (signature, iss, aud, exp±leeway, alg allow-list).
 * Does **not** check `tokenVersion` or session-row existence — those are
 * enforce-revocation concerns (bearer middleware / Step 7).
 *
 * Accepts `MOBILE_ACCESS_SECRET_PREVIOUS` during rotation windows.
 */
export async function verifyAccessToken(
  token: string,
): Promise<VerifyAccessTokenResult> {
  const secrets: Uint8Array[] = [getSecretBytes()];
  const prev = getPreviousSecretBytes();
  if (prev) secrets.push(prev);

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: MOBILE_TOKEN_ISSUER,
        audience: getAudience(),
        clockTolerance: CLOCK_SKEW_SECONDS,
      });

      const sub = payload.sub;
      if (!sub || typeof sub !== "string") {
        return { ok: false, reason: "malformed" };
      }

      const tv = typeof payload.tv === "number" ? payload.tv : undefined;
      if (tv === undefined) {
        return { ok: false, reason: "malformed" };
      }

      const sid = typeof payload.sid === "string" ? payload.sid : undefined;
      const exp = typeof payload.exp === "number" ? payload.exp : undefined;
      const iat = typeof payload.iat === "number" ? payload.iat : undefined;
      if (exp === undefined || iat === undefined) {
        return { ok: false, reason: "malformed" };
      }

      return {
        ok: true,
        claims: {
          sub,
          sid,
          tv,
          iss: MOBILE_TOKEN_ISSUER,
          aud: typeof payload.aud === "string" ? payload.aud : getAudience(),
          exp,
          iat,
        },
      };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return { ok: false, reason: "expired" };
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        // Try next secret (rotation) if any remain; otherwise wrong secret.
        continue;
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        const claim = err.claim;
        if (claim === "iss") return { ok: false, reason: "wrong_issuer" };
        if (claim === "aud") return { ok: false, reason: "wrong_audience" };
        if (claim === "exp" || claim === "nbf") return { ok: false, reason: "expired" };
        return { ok: false, reason: "malformed" };
      }
      if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
        return { ok: false, reason: "malformed" };
      }
      return { ok: false, reason: "malformed" };
    }
  }

  return { ok: false, reason: "secret" };
}

/**
 * Loads `tokenVersion` + ban state for a verified access token and enforces
 * revocation (Step 7): `tv` mismatch or missing user → reject.
 * Ban check mirrors cookie path (403 `account_banned`).
 *
 * Fresh DB reads — never the 10-minute `sessionExists` LRU.
 */
export async function loadUserForBearer(
  claims: MobileAccessTokenClaims,
): Promise<
  | { ok: true; userId: string; tokenVersion: number; email: string }
  | { ok: false; kind: "revoked" | "banned" | "missing" }
> {
  const [row] = await dbRead
    .select({
      userId: users.userId,
      email: users.email,
      tokenVersion: users.tokenVersion,
      bannedAt: users.bannedAt,
    })
    .from(users)
    .where(eq(users.userId, claims.sub))
    .limit(1);

  if (!row) return { ok: false, kind: "missing" };
  if (row.bannedAt) return { ok: false, kind: "banned" };
  if (row.tokenVersion !== claims.tv) return { ok: false, kind: "revoked" };

  return {
    ok: true,
    userId: row.userId,
    tokenVersion: row.tokenVersion,
    email: row.email,
  };
}

/**
 * Fresh `auth_sessions` existence check for `sid` (never process-local LRU).
 * Returns false when the session row is gone (single-device logout).
 */
export async function sessionRowExistsFresh(sessionId: string): Promise<boolean> {
  const { authSessions } = await import("../db/schema.js");
  const [row] = await dbRead
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  return Boolean(row);
}

/**
 * Maps verified bearer claims to the shared {@link AuthUser} shape used by
 * cookie auth so `requireAuth` / routes need no branching.
 */
export function toAuthUserFromBearer(
  userId: string,
  email: string,
  claims: MobileAccessTokenClaims,
): AuthUser {
  return {
    id: userId,
    email,
    sessionId: claims.sid,
  };
}

/** Fire-and-forget session metadata update (parity with cookie path). */
export function touchBearerSession(
  sessionId: string | undefined,
  userAgent: string | null,
  ip: string | null,
): void {
  if (!sessionId) return;
  updateSessionMetadata(sessionId, userAgent, ip).catch((err) => {
    console.error("[bearer] ❌ Session metadata update failed:", err);
  });
}
