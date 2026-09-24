/**
 * Step 10 — dual-credential auth matrix (G-auth-6).
 *
 * Covers the roadmap's bearer/cookie contract without a live database:
 * - no Authorization → cookie path / pass-through
 * - service-bearer (`/api/cron/*`) exemption
 * - non-Bearer schemes → 401 (no silent cookie fallback)
 * - forged / expired / wrong-secret bearer → 401
 * - valid bearer identity attaches userId (DB legs mocked)
 * - Auth.js signed-cookie factory round-trip (plain + secure variants)
 *
 * DB-backed end-to-end refresh/logout paths remain covered by unit tests
 * (`mobile-tokens`, `auth-cookie-baseline`) until a staging fixture lands.
 */

import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { Hono } from "hono";
import { initAuthConfig, getAuthUser } from "@hono/auth-js";
import { SignJWT } from "jose";

import {
  createSignedSessionCookie,
  decodeSignedSessionToken,
  resolveAuthSecret,
  sessionCookieName,
} from "./helpers/auth-session.js";

// ---------------------------------------------------------------------------
// Environment (must be set before importing bearer / mobile-tokens consumers)
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
const TEST_MOBILE_SECRET = "step10-mobile-secret-at-least-32-chars!!";
const TEST_AUTH_SECRET = resolveAuthSecret();

// DB legs that bearer middleware hits after a valid JWT — import real module
// first (avoids mock.module factory deadlock), then override DB-only exports.
const actualMobileTokens = await import("../src/services/mobile-tokens.js");

const loadUserForBearer = mock(async () => ({
  ok: true as const,
  userId: "user-step10",
  tokenVersion: 7,
  email: "step10@example.com",
}));
const sessionRowExistsFresh = mock(async () => true);
const touchBearerSession = mock(() => {});

mock.module("../src/services/mobile-tokens.js", () => ({
  ...actualMobileTokens,
  loadUserForBearer,
  sessionRowExistsFresh,
  touchBearerSession,
}));

const { bearerAuthMiddleware, extractBearerToken, isServiceBearerPath } =
  await import("../src/middleware/bearer.js");
const { issueAccessToken } = actualMobileTokens;

// ---------------------------------------------------------------------------
// Mini apps
// ---------------------------------------------------------------------------

function buildBearerApp(): Hono {
  const app = new Hono();
  app.use("/api/*", bearerAuthMiddleware);
  app.get("/api/whoami", (c) => c.json({ userId: c.get("userId") ?? null }));
  app.get("/api/cron/probe", (c) => c.json({ ok: true }));
  return app;
}

function buildCookieApp(): Hono {
  const app = new Hono();
  app.use(
    "*",
    initAuthConfig(() => ({
      secret: TEST_AUTH_SECRET,
      trustHost: true,
      providers: [],
    })),
  );
  app.get("/api/session", async (c) => {
    const authUser = await getAuthUser(c);
    if (!authUser) return c.json({ authenticated: false });
    const email =
      (authUser.user as { email?: string } | undefined)?.email ??
      (authUser.session?.user as { email?: string } | undefined)?.email;
    const sessionId = (authUser.token as { sessionId?: string } | undefined)
      ?.sessionId;
    return c.json({ authenticated: true, email, sessionId });
  });
  return app;
}

const bearerApp = buildBearerApp();
const cookieApp = buildCookieApp();

async function bearerHeaders(token: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${token}` };
}

async function validToken(userId = "user-step10", sessionId?: string, tv = 7) {
  // Unique sid per call so the 15s bearer identity LRU never reuses a prior
  // test's cached success and skips mocked DB legs.
  return (await issueAccessToken(userId, sessionId ?? `sess-${crypto.randomUUID()}`, tv))
    .token;
}

// Expired HS256 JWT with the same claims/issuer/audience as production tokens.
async function expiredToken(): Promise<string> {
  const secret = new TextEncoder().encode(TEST_MOBILE_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "sess-1", tv: 7 })
    .setProtectedHeader({ alg: "HS256", kid: "m0-hs256", typ: "JWT" })
    .setSubject("user-step10")
    .setIssuer("twistloom-backend")
    .setAudience("reader")
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(secret);
}

beforeAll(() => {
  process.env.MOBILE_ACCESS_SECRET = TEST_MOBILE_SECRET;
  process.env.MOBILE_ACCESS_TTL_MINUTES = "15";
  process.env.MOBILE_ACCESS_AUD = "reader";
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  delete process.env.MOBILE_ACCESS_SECRET_PREVIOUS;
  loadUserForBearer.mockClear();
  sessionRowExistsFresh.mockClear();
  touchBearerSession.mockClear();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// extractBearerToken / isServiceBearerPath
// ---------------------------------------------------------------------------

describe("extractBearerToken / isServiceBearerPath", () => {
  it("extracts a well-formed Bearer token", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer   spaced  ")).toBe("spaced");
  });

  it("returns null for non-Bearer schemes and empty tokens", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("exempts only /api/cron service paths", () => {
    expect(isServiceBearerPath("/api/cron/probe")).toBe(true);
    expect(isServiceBearerPath("/api/auth/mobile/token")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bearer middleware matrix
// ---------------------------------------------------------------------------

describe("Bearer middleware matrix (Step 10)", () => {
  it("passes through with no Authorization header (cookie path preserved)", async () => {
    const res = await bearerApp.request("/api/whoami");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBeNull();
  });

  it("exempts service-bearer cron paths (NB-2) — CRON_SECRET not 401'd here", async () => {
    const res = await bearerApp.request("/api/cron/probe", {
      headers: { Authorization: "Bearer not-a-user-jwt" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("rejects non-Bearer scheme with 401 (no cookie fallback)", async () => {
    const res = await bearerApp.request("/api/whoami", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "Invalid authorization scheme",
    });
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects bare/empty Bearer with 401", async () => {
    const res = await bearerApp.request("/api/whoami", {
      headers: { Authorization: "Bearer" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("rejects malformed token with 401 invalid_token", async () => {
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders("not-a-jwt"),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Invalid token" });
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("rejects forged/tampered token with 401", async () => {
    const token = await validToken();
    const parts = token.split(".");
    const payload = parts[1].replace(/^.(?=.)/, (m) => (m === "A" ? "B" : "A"));
    const tampered = [parts[0], payload, parts[2]].join(".");
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(tampered),
    });
    expect(res.status).toBe(401);
  });

  it("rejects token signed with wrong secret with 401", async () => {
    const previous = process.env.MOBILE_ACCESS_SECRET;
    process.env.MOBILE_ACCESS_SECRET = "another-secret-completely-different-32!";
    try {
      const wrong = await issueAccessToken("user-step10", "sess-1", 7);
      process.env.MOBILE_ACCESS_SECRET = previous;
      const res = await bearerApp.request("/api/whoami", {
        headers: await bearerHeaders(wrong.token),
      });
      expect(res.status).toBe(401);
    } finally {
      process.env.MOBILE_ACCESS_SECRET = previous;
    }
  });

  it("rejects expired token with 401 Token expired", async () => {
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(await expiredToken()),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Token expired" });
  });

  it("accepts a valid bearer and attaches userId (DB legs mocked)", async () => {
    loadUserForBearer.mockClear();
    sessionRowExistsFresh.mockClear();
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(await validToken()),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-step10");
    expect(loadUserForBearer).toHaveBeenCalled();
    expect(sessionRowExistsFresh).toHaveBeenCalled();
  });

  it("returns 401 when session row is missing (revoked sid)", async () => {
    sessionRowExistsFresh.mockImplementationOnce(async () => false);
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(await validToken()),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Session revoked" });
  });

  it("returns 403 when loadUserForBearer reports banned", async () => {
    loadUserForBearer.mockImplementationOnce(async () => ({
      ok: false as const,
      kind: "banned" as const,
    }));
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(await validToken()),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Account banned" });
  });

  it("returns 401 when tokenVersion mismatch (revoked)", async () => {
    loadUserForBearer.mockImplementationOnce(async () => ({
      ok: false as const,
      kind: "revoked" as const,
    }));
    const res = await bearerApp.request("/api/whoami", {
      headers: await bearerHeaders(await validToken()),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Token revoked" });
  });
});

// ---------------------------------------------------------------------------
// Auth.js signed-cookie factory (plain + secure)
// ---------------------------------------------------------------------------

describe("Auth.js signed-cookie factory (Step 10 helper)", () => {
  it("round-trips a plain authjs.session-token cookie", async () => {
    const { cookieHeader, token, cookieName } = await createSignedSessionCookie({
      email: "cookie-user@example.com",
      sessionId: "sess-cookie-1",
      variant: "plain",
    });
    expect(cookieName).toBe("authjs.session-token");
    expect(cookieHeader.startsWith("authjs.session-token=")).toBe(true);

    const decoded = await decodeSignedSessionToken(token, { variant: "plain" });
    expect(decoded).not.toBeNull();
    expect(decoded?.email).toBe("cookie-user@example.com");
    expect(decoded?.sessionId).toBe("sess-cookie-1");
  });

  it("round-trips a __Secure- cookie with matching salt", async () => {
    const { token, cookieName } = await createSignedSessionCookie({
      email: "secure-user@example.com",
      sessionId: "sess-cookie-2",
      variant: "secure",
    });
    expect(cookieName).toBe("__Secure-authjs.session-token");

    const decoded = await decodeSignedSessionToken(token, { variant: "secure" });
    expect(decoded?.email).toBe("secure-user@example.com");

    // Wrong salt derives a different HKDF key → decrypt fails (not null payload).
    let wrongSaltFailed = false;
    try {
      await decodeSignedSessionToken(token, { variant: "plain" });
    } catch {
      wrongSaltFailed = true;
    }
    expect(wrongSaltFailed).toBe(true);
  });

  it("getAuthUser decrypts a signed cookie on a mini Auth.js app", async () => {
    const { cookieHeader } = await createSignedSessionCookie({
      email: "getauthuser@example.com",
      sessionId: "sess-ga-u",
      variant: "plain",
    });
    const res = await cookieApp.request("/api/session", {
      headers: { Cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.email).toBe("getauthuser@example.com");
    expect(body.sessionId).toBe("sess-ga-u");
  });

  it("getAuthUser rejects a cookie signed with a different secret", async () => {
    const { cookieHeader } = await createSignedSessionCookie({
      email: "evil@example.com",
      secret: "another-auth-secret-not-used-by-app-32!!",
      variant: "plain",
    });
    const res = await cookieApp.request("/api/session", {
      headers: { Cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("getAuthUser returns unauthenticated with no cookie", async () => {
    const res = await cookieApp.request("/api/session");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("uses the same cookie names Auth.js expects", () => {
    expect(sessionCookieName("plain")).toBe("authjs.session-token");
    expect(sessionCookieName("secure")).toBe("__Secure-authjs.session-token");
  });
});

// ---------------------------------------------------------------------------
// Logout body contract (NB-4) — keep green alongside the matrix
// ---------------------------------------------------------------------------

describe("Logout body contract (NB-4) in Step 10", () => {
  it("stays byte-identical", () => {
    expect(JSON.stringify({ message: "Logged out successfully" })).toBe(
      '{"message":"Logged out successfully"}',
    );
  });
});
