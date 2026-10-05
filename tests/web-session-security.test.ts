import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Hono } from "hono";
import { initAuthConfig } from "@hono/auth-js";
import { SignJWT } from "jose";
import { encode } from "@auth/core/jwt";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AppEnv } from "../src/hono/env.js";

const secret = "web-security-test-only-secret-with-32-chars";
const userId = "019a0000-0000-7000-8000-000000000001";
const otherUserId = "019a0000-0000-7000-8000-000000000002";
const sidA = "019a0000-0000-7000-8000-000000000003";
const sidB = "019a0000-0000-7000-8000-000000000004";
const originalSecret = process.env.AUTH_SECRET;
const originalUrl = process.env.AUTH_URL;
process.env.AUTH_SECRET = secret;
delete process.env.AUTH_URL;
const dialect = new PgDialect();
let bannedAt: Date | null = null;
const sessions = new Map<string, string>();
let primaryReads = 0;
let createdSessions = 0;
let userExists = true;
let primaryUnavailable = false;
let metadataWrites = 0;
let metadataUnavailable = false;
const primaryUser = () => ({ userId, email: "web@example.test", name: "Web", username: "web",
  imageUrl: null, isNewUser: false, bannedAt, passwordHash: "test-only-hash" });

// Query legs only are doubled: real cookie decoding, policy and issuance run.
function select(fields?: Record<string, unknown>) {
  let joined = false;
  let params: unknown[] = [];
  const result = () => {
    primaryReads++;
    if (primaryUnavailable) throw new Error("Test primary-store outage");
    if (fields?.id) return [...sessions].filter(([, owner]) => owner === params[0]).map(([id]) => ({ id }));
    if (!joined) return userExists ? [primaryUser()] : [];
    const [sid, owner] = params;
    return userExists && typeof sid === "string" && owner === userId && sessions.get(sid) === owner
      ? [primaryUser()] : [];
  };
  const query = {
    from: () => query,
    innerJoin: () => { joined = true; return query; },
    where: (condition: SQL) => { params = dialect.sqlToQuery(condition).params; return query; },
    then: (resolve: (rows: unknown[]) => void) => resolve(result()),
    limit: () => ({ then: (resolve: (rows: unknown[]) => void) => resolve(result()),
      for: async () => result() }),
  };
  return query;
}
const primary = {
  select,
  delete: () => ({ where: async (condition: SQL) => {
    const compiled = dialect.sqlToQuery(condition);
    const [owner, current] = compiled.params;
    if (compiled.sql.includes('"auth_sessions"."id" =')) {
      const matched = sessions.get(String(owner)) === current;
      if (matched) sessions.delete(String(owner));
      return { rowCount: matched ? 1 : 0 };
    }
    let rowCount = 0;
    for (const [id, sessionOwner] of sessions) {
      if (sessionOwner === owner && id !== current) { sessions.delete(id); rowCount++; }
    }
    return { rowCount };
  } }),
  insert: () => ({ values: async (row: { id: string; userId: string }) => {
    createdSessions++; sessions.set(row.id, row.userId);
  } }),
  transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(primary),
};
const actualDb = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({ ...actualDb, db: primary, dbWrite: primary,
  dbRead: { select: () => { throw new Error("Authorization used a replica"); } } }));
// Other route suites replace createSession globally. Load the real module under
// a distinct URL so this suite exercises the actual session insert as well.
const sessionModuleUrl = "../src/services/session-manager.js?web-session-security";
const actualSessions: typeof import("../src/services/session-manager.js") = await import(sessionModuleUrl);
mock.module("../src/services/session-manager.js", () => ({ ...actualSessions,
  updateSessionMetadata: async () => {
    metadataWrites++;
    if (metadataUnavailable) throw new Error("Test metadata-write outage");
  } }));
const { verifyNextAuthToken } = await import("../src/middleware/nextauth.js");
const { issueWebSession } = await import("../src/services/web-session.js");
const { AuthPolicyError } = await import("../src/utils/auth-error.js");
const { createCookieBearerIdentityMiddleware } = await import("../src/middleware/cookie-bearer-identity.js");
const { parseJsonBody } = await import("../src/middleware/body.js");
const actualUser = await import("../src/services/user.js");
const actualPassword = await import("../src/utils/password.js");
const actualLockout = await import("../src/utils/account-lockout.js");
const actualReset = await import("../src/utils/password-reset.js");
const actualUserController = await import("../src/services/user-controller.js");
const actualAdmin = await import("../src/middleware/admin-auth.js");
const actualRateLimit = await import("../src/middleware/rate-limit.js");
const actualGoogle = await import("google-auth-library");
let passwordHash: string | null = "test-only-hash";
let locked = false;
mock.module("../src/services/user.js", () => ({ ...actualUser,
  getUserForAuth: async () => ({ ...primaryUser(), passwordHash }) }));
mock.module("../src/utils/password.js", () => ({ ...actualPassword,
  verifyPassword: async (password: string) => password === "correct-test-password" }));
mock.module("../src/utils/account-lockout.js", () => ({ ...actualLockout,
  checkAccountLockout: async () => ({ isLocked: locked, remainingTime: 120000, attempts: 5 }),
  recordFailedLogin: async () => {}, resetFailedLoginAttempts: async () => {} }));
mock.module("../src/utils/password-reset.js", () => ({ ...actualReset, revokePasswordResetTokens: async () => {} }));
mock.module("../src/services/user-controller.js", () => ({ ...actualUserController,
  createOrUpdateOAuthUser: async () => userId }));
mock.module("../src/middleware/admin-auth.js", () => ({ ...actualAdmin,
  resolveAdminAccess: async () => ({ isAdmin: false }) }));
mock.module("../src/middleware/rate-limit.js", () => ({ ...actualRateLimit, checkRateLimitByIP: () => true }));
// Google's verifier is a boundary double; the issuance policy remains real.
mock.module("google-auth-library", () => ({ ...actualGoogle, OAuth2Client: class {
  async verifyIdToken() { return { getPayload: () => ({ email: "web@example.test", email_verified: true, sub: "test-only-google-sub" }) }; }
} }));
const authRouteUrl = "../src/routes/auth.js?web-session-security";
const { default: authRouter }: typeof import("../src/routes/auth.js") = await import(authRouteUrl);
const exchanges = new Hono<AppEnv>();
exchanges.use("*", parseJsonBody);
exchanges.route("/api/auth", authRouter);
function exchange(provider: string, password = "correct-test-password") {
  return exchanges.request("http://localhost/api/auth/" + provider, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailOrUsername: "web", password, idToken: "test-only-token" }),
  });
}

const app = new Hono<AppEnv>();
app.use("*", initAuthConfig(() => ({ secret, trustHost: true, providers: [] })));
app.get("/api/whoami", async c => c.json(await verifyNextAuthToken(c)));
app.onError((err, c) => err instanceof AuthPolicyError
  ? c.json({ error: err.message, code: err.code }, err.status) : c.json({ error: err.message }, 500));

async function cookie(sid: string | undefined, uid = userId, secure = false, age = 3600) {
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const token = await encode({ secret, salt: name, maxAge: age,
    token: { email: "web@example.test", userId: uid, sessionId: sid } });
  return { name, token, header: name + "=" + token };
}
function request(header: string, secure = false) {
  return app.request((secure ? "https" : "http") + "://localhost/api/whoami", { headers: { cookie: header } });
}
beforeEach(() => {
  bannedAt = null; sessions.clear(); sessions.set(sidA, userId); sessions.set(sidB, userId);
  primaryReads = 0; createdSessions = 0;
  userExists = true; locked = false; passwordHash = "test-only-hash";
  primaryUnavailable = false; metadataWrites = 0; metadataUnavailable = false;
});
afterAll(() => {
  mock.module("../src/db/client.js", () => actualDb);
  mock.module("../src/services/session-manager.js", () => actualSessions);
  mock.module("../src/services/user.js", () => actualUser);
  mock.module("../src/utils/password.js", () => actualPassword);
  mock.module("../src/utils/account-lockout.js", () => actualLockout);
  mock.module("../src/utils/password-reset.js", () => actualReset);
  mock.module("../src/services/user-controller.js", () => actualUserController);
  mock.module("../src/middleware/admin-auth.js", () => actualAdmin);
  mock.module("../src/middleware/rate-limit.js", () => actualRateLimit);
  mock.module("google-auth-library", () => actualGoogle);
  if (originalSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = originalSecret;
  if (originalUrl === undefined) delete process.env.AUTH_URL; else process.env.AUTH_URL = originalUrl;
});

describe("tracked web session security", () => {
  it("rechecks revocation after warming decoding cache", async () => {
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    sessions.delete(sidA);
    const denied = await request(signed.header);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "auth.sessionRevoked" });
    expect(denied.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(primaryReads).toBe(2);
  });
  it("rechecks a ban after warming decoding cache", async () => {
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    bannedAt = new Date();
    const denied = await request(signed.header);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "auth.accountBanned" });
  });
  it("preserves policy codes and cookie deletion through the real global app handler", async () => {
    const applicationUrl = "../src/app.js?web-session-security";
    const { app: application }: typeof import("../src/app.js") = await import(applicationUrl);
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    sessions.delete(sidA);
    const revoked = await application.request("http://localhost/api/auth/sessions", {
      headers: { cookie: signed.header },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ success: false, code: "auth.sessionRevoked" });
    expect(revoked.headers.get("set-cookie")).toContain("Max-Age=0");
    sessions.set(sidA, userId);
    bannedAt = new Date();
    const banned = await application.request("http://localhost/api/auth/sessions", {
      headers: { cookie: signed.header },
    });
    expect(banned.status).toBe(403);
    expect(await banned.json()).toMatchObject({ success: false, error: "account_banned", code: "auth.accountBanned" });
  });
  it("fails closed on a primary outage without deleting a still-valid cookie", async () => {
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    primaryUnavailable = true;
    const unavailable = await request(signed.header);
    expect(unavailable.status).toBe(500);
    expect(unavailable.headers.get("set-cookie")).toBeNull();
    primaryUnavailable = false;
    expect((await request(signed.header)).status).toBe(200);
    expect(primaryReads).toBe(3);
  });
  it("rejects a deleted owner even when their cookie decode is warm", async () => {
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    userExists = false;
    expect((await request(signed.header)).status).toBe(401);
    expect(createdSessions).toBe(0);
  });
  it("does not let the decode cache extend the token's expiry", async () => {
    // Avoid a real one-second boundary while other checks compete for CPU.
    // Advance only the policy clock; the LRU uses monotonic elapsed time.
    const signed = await cookie(sidA, userId, false, 60);
    expect((await request(signed.header)).status).toBe(200);
    const afterExpiry = Date.now() + 61_000;
    const clock = spyOn(Date, "now").mockReturnValue(afterExpiry);
    try {
      expect((await request(signed.header)).status).toBe(401);
    } finally { clock.mockRestore(); }
  });
  it("keeps fresh authorization while coalescing advisory metadata writes", async () => {
    const sid = "019a0000-0000-7000-8000-000000000010";
    sessions.set(sid, userId);
    const signed = await cookie(sid);
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(signed.header)));
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(primaryReads).toBe(6);
    expect(metadataWrites).toBe(1);
    sessions.delete(sid);
    expect((await request(signed.header)).status).toBe(401);
    expect(primaryReads).toBe(7);
  });
  it("retries failed metadata writes without rejecting a valid session", async () => {
    const sid = "019a0000-0000-7000-8000-000000000011";
    sessions.set(sid, userId);
    const signed = await cookie(sid);
    metadataUnavailable = true;
    expect((await request(signed.header)).status).toBe(200);
    metadataUnavailable = false;
    expect((await request(signed.header)).status).toBe(200);
    expect(metadataWrites).toBe(2);
    expect(primaryReads).toBe(2);
  });
  it("registers advisory writes with the Netlify execution context", async () => {
    const sid = "019a0000-0000-7000-8000-000000000012";
    sessions.set(sid, userId);
    const signed = await cookie(sid);
    const tasks: Promise<unknown>[] = [];
    const response = await app.fetch(new Request("http://localhost/api/whoami", {
      headers: { cookie: signed.header },
    }), {}, { waitUntil: task => { tasks.push(task); }, passThroughOnException: () => {}, props: {} });
    expect(response.status).toBe(200);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(metadataWrites).toBe(1);
  });
  it("verifies secure cookies when HTTPS is carried by proxy headers", async () => {
    const signed = await cookie(sidA, userId, true);
    const response = await app.request("http://localhost/api/whoami", { headers: {
      cookie: signed.header, "x-forwarded-proto": "https", "x-forwarded-host": "twistloom-web.netlify.app",
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: userId, sessionId: sidA });
  });
  it("preserves a JSON mutation body after resolving the cookie identity", async () => {
    const mutations = new Hono<AppEnv>();
    mutations.use("*", initAuthConfig(() => ({ secret, trustHost: true, providers: [] })));
    mutations.use("*", createCookieBearerIdentityMiddleware(verifyNextAuthToken));
    mutations.use("*", parseJsonBody);
    mutations.post("/api/mutation", c => c.json({ userId: c.get("userId"), body: c.get("body") }));
    const response = await mutations.request("http://localhost/api/mutation", { method: "POST",
      headers: { cookie: (await cookie(sidA)).header, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test-only-mutation" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId, body: { content: "test-only-mutation" } });
  });
  it("rejects a session owned by another user", async () => {
    sessions.set(sidA, otherUserId);
    expect((await request((await cookie(sidA)).header)).status).toBe(401);
  });
  it("does not share session attribution between concurrent devices", async () => {
    const [a, b] = await Promise.all([cookie(sidA), cookie(sidB)]);
    const responses = await Promise.all([request(a.header), request(b.header)]);
    expect(await responses[0].json()).toMatchObject({ sessionId: sidA });
    expect(await responses[1].json()).toMatchObject({ sessionId: sidB });
    expect(await actualSessions.logoutFromAllOtherDevices(userId, sidA)).toBe(1);
    expect((await request(a.header)).status).toBe(200);
    expect((await request(b.header)).status).toBe(401);
  });
  it("clears all actual secure numbered chunks on revocation", async () => {
    const signed = await cookie(sidA, userId, true);
    const split = Math.floor(signed.token.length / 2);
    const header = signed.name + ".0=" + signed.token.slice(0, split) + "; " + signed.name + ".1=" + signed.token.slice(split);
    expect((await request(header, true)).status).toBe(200);
    sessions.delete(sidA);
    const denied = await request(header, true);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toContain(signed.name + ".0=");
    expect(denied.headers.get("set-cookie")).toContain(signed.name + ".1=");
  });
  it("rejects legacy missing-ID and expired cookies", async () => {
    expect((await request((await cookie(undefined)).header)).status).toBe(401);
    expect((await request((await cookie(sidA, userId, false, -100)).header)).status).toBe(401);
  });
  it("preserves anonymous access without a cookie", async () => {
    expect(await (await request("")).json()).toBeNull();
    expect(primaryReads).toBe(0);
  });
  it("allows reauthentication with a revoked cookie while protected requests still fail", async () => {
    const signed = await cookie(sidA);
    sessions.delete(sidA);
    const exchange = new Hono<AppEnv>();
    exchange.use("*", initAuthConfig(() => ({ secret, trustHost: true, providers: [] })));
    exchange.use("*", createCookieBearerIdentityMiddleware(verifyNextAuthToken));
    exchange.post("/api/auth/:provider", c => c.json({ reachedExchange: true }));
    for (const provider of ["verify-credentials", "google-oauth", "google-one-tap"]) {
      expect((await exchange.request("http://localhost/api/auth/" + provider,
        { method: "POST", headers: { cookie: signed.header } })).status).toBe(200);
    }
    expect(primaryReads).toBe(0);
    expect((await request(signed.header)).status).toBe(401);
  });
  it("checks identity conflicts even when the secure cookie is chunked", async () => {
    const hybrid = new Hono<AppEnv>();
    hybrid.use("*", async (c, next) => { c.set("userId", otherUserId); await next(); });
    hybrid.use("*", createCookieBearerIdentityMiddleware(async () => ({ id: userId, email: "web@example.test" })));
    hybrid.get("/api/whoami", c => c.json({ ok: true }));
    expect((await hybrid.request("http://localhost/api/whoami", { headers: {
      authorization: "Bearer test-only", cookie: "__Secure-authjs.session-token.0=test-only",
    } })).status).toBe(401);
  });
  it("does not issue a session for a banned account", async () => {
    bannedAt = new Date();
    expect(await issueWebSession(userId)).toEqual({ ok: false, reason: "banned" });
    expect(createdSessions).toBe(0);
  });
  it("returns a canonical tracked session on allowed issuance", async () => {
    const result = await issueWebSession(userId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(sessions.get(result.user.sessionId)).toBe(userId);
    expect(createdSessions).toBe(1);
  });
});

describe("web authentication route contracts", () => {
  it("distinguishes incorrect passwords, social accounts and timed lockouts", async () => {
    expect(await (await exchange("verify-credentials", "incorrect-test-password")).json())
      .toMatchObject({ success: false, code: "auth.invalidCredentials" });
    passwordHash = null;
    expect(await (await exchange("verify-credentials")).json()).toMatchObject({ code: "auth.socialLoginRequired" });
    locked = true;
    const response = await exchange("verify-credentials");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "auth.accountLocked", lockedUntil: expect.any(String) });
    expect(createdSessions).toBe(0);
  });
  for (const provider of ["verify-credentials", "google-oauth", "google-one-tap"]) {
    it(`${provider} rejects banned issuance before creating a session`, async () => {
      bannedAt = new Date();
      const response = await exchange(provider);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ success: false, code: "auth.accountBanned" });
      expect(createdSessions).toBe(0);
    });
    it(`${provider} returns canonical tracked IDs on success`, async () => {
      const response = await exchange(provider);
      expect(response.status).toBe(200);
      const identity = await response.json();
      expect(identity).toMatchObject({ userId, isAdmin: false });
      expect(sessions.get(identity.sessionId)).toBe(userId);
      expect(createdSessions).toBe(1);
    });
  }
  it("rejects an account deleted between identity verification and issuance", async () => {
    userExists = false;
    const response = await exchange("verify-credentials");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "auth.serviceUnavailable" });
    expect(createdSessions).toBe(0);
  });
});


describe('purpose-bound browser revocation', () => {
  async function proof(owner = userId, sid = sidA, purpose = 'revoke') {
    const key = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('twistloom:web-control:v1:' + secret)));
    return new SignJWT({ purpose, sessionId: sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(owner)
      .setIssuer('twistloom-web').setAudience('twistloom-web-control').setIssuedAt().setExpirationTime('60s').sign(key);
  }
  const revoke = (proof: string) => exchanges.request('http://localhost/api/auth/revoke-web-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof }),
  });
  it('removes only the owned session and rejects a copied warm cookie', async () => {
    const signed = await cookie(sidA);
    expect((await request(signed.header)).status).toBe(200);
    expect((await revoke(await proof())).status).toBe(200);
    expect(sessions.has(sidB)).toBe(true);
    expect((await request(signed.header)).status).toBe(401);
    expect((await revoke(await proof())).status).toBe(200); // Idempotent cleanup.
  });
  it('can revoke a banned account without a request cookie', async () => {
    bannedAt = new Date();
    expect((await revoke(await proof())).status).toBe(200);
    expect(sessions.has(sidA)).toBe(false);
  });
  it('a proof with the wrong owner, wrong purpose or invalid signature cannot revoke', async () => {
    expect((await revoke(await proof(otherUserId))).status).toBe(200);
    expect(sessions.has(sidA)).toBe(true);
    expect((await revoke(await proof(userId, sidA, 'exchange'))).status).toBe(401);
    expect((await revoke('forged-proof')).status).toBe(401);
    expect(sessions.has(sidA)).toBe(true);
  });
  it('old password proof cannot issue after a concurrent credential change', async () => {
    expect(await issueWebSession(userId, 'previous-password-hash')).toEqual({ ok: false, reason: 'credentials' });
    expect(createdSessions).toBe(0);
  });
});
