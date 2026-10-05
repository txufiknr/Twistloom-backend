/**
 * Short-lived server-to-server attestations. A domain-separated key derived
 * from the shared Auth.js secret never doubles as the native signing key.
 * Claims are purpose-bound; the browser cannot mint an exchange or revocation.
 */
import { jwtVerify } from "jose";
import { isValidUuid } from "../utils/uuid.js";
import { hashSHA256 } from "../utils/hash.js";
import { checkRateLimit } from "../utils/redis.js";

async function controlKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for web control");
  return new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`twistloom:web-control:v1:${secret}`)));
}

export async function readWebControl(proof: string, purpose: "revoke" | "exchange") {
  try {
    const { payload } = await jwtVerify(proof, await controlKey(), {
      algorithms: ["HS256"], issuer: "twistloom-web", audience: "twistloom-web-control",
      requiredClaims: ["exp", "iat"], maxTokenAge: "60s",
    });
    if (payload.purpose !== purpose || !payload.iat || !payload.exp ||
        payload.exp <= payload.iat || payload.exp - payload.iat > 60) return null;
    return payload;
  } catch { return null; }
}

/** Account-scoped limits protect exchanges without pooling every web user into
 * one five-attempt frontend-egress bucket. Unsigned direct clients keep IP limits. */
export async function isWebExchange(proof: string | undefined, body: unknown): Promise<boolean> {
  if (!proof) return false;
  const claims = await readWebControl(proof, "exchange");
  return Boolean(claims && claims.bodyHash === await hashSHA256(JSON.stringify(body)));
}

export async function allowWebExchange(proof: string | undefined, body: unknown, identifier: string, ip: string): Promise<boolean | null> {
  if (!proof) return null;
  if (!await isWebExchange(proof, body)) return null;
  try {
    if (!(await checkRateLimit(`auth:web-egress:${await hashSHA256(ip)}`,
      { maxRequests: 300, windowSeconds: 60 })).allowed) return false;
    return (await checkRateLimit(`auth:web-account:${await hashSHA256(identifier.trim().toLowerCase())}`,
      { maxRequests: 5, windowSeconds: 60 })).allowed;
  } catch {
    console.error("[auth] Distributed exchange limiter unavailable (fail open)");
    return true;
  }
}

export async function readRevocation(proof: string) {
  const claims = await readWebControl(proof, "revoke");
  return claims && isValidUuid(claims.sub) && isValidUuid(claims.sessionId)
    ? { userId: claims.sub, sessionId: claims.sessionId } : null;
}
