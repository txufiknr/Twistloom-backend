/**
 * GET /auth/username-available contract: the advisory probe the Flutter signup
 * form's checkmark suffix consumes.
 *
 * What this asserts (MOBILE_AUTH_CONTRACT / AUTH_API_DOCUMENTATION):
 *   - 200 `{ available: boolean }` for free, taken and reserved candidates
 *   - the candidate is sanitized exactly as signup sanitizes it, so "checked"
 *     equals "would be stored"
 *   - 400 when `username` is missing or blank
 *   - 429 only when the dedicated Redis budget is exhausted
 *
 * DB and Redis legs are mocked (`createFakeDb` evaluates the real drizzle
 * `eq` predicate, so the uniqueness lookup cannot be lied about);
 * `validateUsername` / `sanitizeUsername` run for real because they are the
 * rules under test. No live network or database.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/hono/env.js";
import { parseJsonBody } from "../src/middleware/body.js";
import { createFakeDb } from "./helpers/store-verification-db.js";

// ---------------------------------------------------------------------------
// Mocked collaborators (registered before routes/auth is imported)
// ---------------------------------------------------------------------------

const fake = createFakeDb();
const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  dbRead: fake.dbRead,
  dbWrite: fake.dbWrite,
  db: fake.dbWrite,
}));

/** When false the mocked Redis budget rejects the request (429 case). */
let rateLimitAllowed = true;

const actualRedis = await import("../src/utils/redis.js");
mock.module("../src/utils/redis.js", () => ({
  ...actualRedis,
  checkRateLimit: mock(async () => ({
    allowed: rateLimitAllowed,
    requestCount: 1,
    resetAfter: 60,
  })),
}));

const { default: authRouter } = await import("../src/routes/auth.js");

function buildAuthApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", parseJsonBody);
  app.route("/api/auth", authRouter);
  return app;
}

function check(app: Hono<AppEnv>, username?: string) {
  const query =
    username === undefined ? "" : `?username=${encodeURIComponent(username)}`;
  return app.request(`/api/auth/username-available${query}`);
}

beforeEach(() => {
  fake.reset({
    users: [
      {
        userId: "user-taken-1",
        username: "takenname",
        email: "taken@example.com",
      },
      {
        userId: "user-taken-2",
        username: "taken-name",
        email: "taken-name@example.com",
      },
    ],
  });
  rateLimitAllowed = true;
});

afterAll(() => {
  mock.restore();
  // `mock.module` leaks forward across test files in the same process and
  // `mock.restore()` does not revert it — put the real modules back for
  // whatever runs next (pattern: auth-signup-pair.test.ts).
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/utils/redis.js", () => actualRedis);
});

describe("GET /auth/username-available (advisory signup probe)", () => {
  it("reports a free, well-formed username as available", async () => {
    const app = buildAuthApp();
    const res = await check(app, "story-weaver");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  it("reports a held username as unavailable", async () => {
    const app = buildAuthApp();
    const res = await check(app, "takenname");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("sanitizes the candidate the way signup does before the lookup", async () => {
    const app = buildAuthApp();
    // Case and separators normalize to the stored form, so this must hit the
    // same row as `taken-name` rather than querying the raw string.
    const res = await check(app, "Taken.Name");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("reports reserved words as unavailable", async () => {
    const app = buildAuthApp();
    const res = await check(app, "admin");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("reports malformed candidates as unavailable instead of 4xx", async () => {
    const app = buildAuthApp();
    const res = await check(app, "ab");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("returns 400 when username is missing", async () => {
    const app = buildAuthApp();
    const res = await check(app);

    expect(res.status).toBe(400);
  });

  it("returns 400 when username is blank", async () => {
    const app = buildAuthApp();
    const res = await check(app, "   ");

    expect(res.status).toBe(400);
  });

  it("returns 429 when the per-IP budget is exhausted", async () => {
    rateLimitAllowed = false;
    const app = buildAuthApp();
    const res = await check(app, "story-weaver");

    expect(res.status).toBe(429);
  });
});
