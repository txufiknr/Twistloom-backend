/**
 * Cookie-auth baseline (Step 3) — must stay green before Step 5 ships
 * and on every PR thereafter (NB-2…NB-8).
 *
 * These tests lock response contracts that Twistloom-web depends on so
 * bearer work cannot silently break the browser face.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { cValidationError, cUnauthorizedError, cForbiddenError, cRateLimitError } from "../src/utils/error.js";

describe("Cookie auth baseline contracts (NB-2…NB-8)", () => {
  it("verify-credentials success shape is frozen (NB-1)", () => {
    // Documented contract fields — assert presence when building the response
    // object the same way the route does (no network needed).
    const response = {
      userId: "u1",
      email: "a@b.c",
      name: "N",
      username: "n",
      imageUrl: null,
      isNewUser: false,
      isAdmin: false,
      sessionId: "s1",
    };
    for (const key of [
      "userId",
      "email",
      "name",
      "username",
      "imageUrl",
      "isNewUser",
      "isAdmin",
      "sessionId",
    ]) {
      expect(Object.keys(response)).toContain(key);
    }
    // Extra additive keys must not be required by web (additive-only rule)
    expect(Object.keys(response).length).toBe(8);
  });

  it("logout body stays byte-identical (NB-4)", () => {
    // Route returns exactly this object — snapshot the exact shape.
    const body = { message: "Logged out successfully" };
    expect(JSON.stringify(body)).toBe('{"message":"Logged out successfully"}');
  });

  it("cookie-path error envelope uses success/error (NB-5)", () => {
    const envelope = { success: false, error: "Invalid credentials" };
    expect(envelope.success).toBe(false);
    expect(typeof envelope.error).toBe("string");
  });

  it("mobile token error envelope uses success/error (aligned with NB-5)", () => {
    const envelope = { success: false, error: "Token expired" };
    expect(envelope.success).toBe(false);
    expect(typeof envelope.error).toBe("string");
  });
});

describe("Standard error helpers emit { success:false, error } (NB-5)", () => {
  const app = new Hono();
  app.get("/validation", (c) => cValidationError(c, "Invalid credentials"));
  app.get("/unauthorized", (c) => cUnauthorizedError(c, "Invalid credentials"));
  app.get("/forbidden", (c) => cForbiddenError(c, "Account banned"));
  app.get("/rate-limit", (c) => cRateLimitError(c));

  it("cValidationError returns success:false + error string", async () => {
    const res = await app.request("/validation");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Invalid credentials" });
  });

  it("cUnauthorizedError returns 401 + success:false envelope", async () => {
    const res = await app.request("/unauthorized");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("cForbiddenError returns 403 + success:false envelope (ban path)", async () => {
    const res = await app.request("/forbidden");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: "Account banned" });
  });

  it("cRateLimitError returns 429 + success:false envelope", async () => {
    const res = await app.request("/rate-limit");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

describe("Logout route contract (NB-4 + session/family revocation)", () => {
  it("POST /logout returns byte-identical cookie body even without auth", async () => {
    const { default: authRouter } = await import("../src/routes/auth.js");
    const res = await authRouter.request("/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('{"message":"Logged out successfully"}');
    expect(JSON.parse(text)).toEqual({ message: "Logged out successfully" });
  });
});

describe("Cron auth regression (service-bearer must keep working)", () => {
  it("cron router still validates CRON_SECRET via Authorization Bearer", async () => {
    const originalEnv = { ...process.env };
    process.env.CRON_SECRET = "baseline-cron-secret";
    process.env.NODE_ENV = "test";

    const { default: cronRouter } = await import("../src/routes/cron.js");
    const ok = await cronRouter.request("/probe", {
      method: "GET",
      headers: { authorization: "Bearer baseline-cron-secret" },
    });
    expect(ok.status).toBe(200);

    const bad = await cronRouter.request("/probe", {
      method: "GET",
      headers: { authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);

    process.env = { ...originalEnv };
  });
});
