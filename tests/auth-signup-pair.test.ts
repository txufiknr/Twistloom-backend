/**
 * Q1-A contract (USER_ONBOARDING_WIZARD_ROADMAP): POST /auth/signup issues
 * the mobile token pair in-band with the canonical isNewUser claim, so the
 * Flutter app installs a session from the signup response alone and the
 * welcome wizard gate opens with no second exchange.
 *
 * DB / email / password legs are mocked; `issueMobileLoginPair` runs for real
 * (the SSOT under test) with its session/family/admin collaborators mocked the
 * same way as `mobile-oauth-issuance.test.ts`. No live network or database.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/hono/env.js";
import { parseJsonBody } from "../src/middleware/body.js";

const ORIGINAL_ENV = { ...process.env };
process.env.MOBILE_ACCESS_SECRET = "signup-pair-secret-at-least-32-chars!!";
process.env.MOBILE_ACCESS_TTL_MINUTES = "15";
process.env.MOBILE_ACCESS_AUD = "reader";

// ---------------------------------------------------------------------------
// Mocked collaborators (registered before routes/auth is imported)
// ---------------------------------------------------------------------------

const issuanceUserRow = {
  userId: "user-signup-1",
  tokenVersion: 3,
  email: "pair@example.com",
  name: "Pair User",
  username: "pairuser",
  imageUrl: null as string | null,
  isNewUser: true,
  bannedAt: null as Date | null,
};

/** Rows the issuance user lookup returns; emptied to force the degraded path. */
let issuanceRows = [issuanceUserRow];
let insertedUser: Record<string, unknown> = {};

const dbRead = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => issuanceRows,
      }),
    }),
  }),
};

const dbWrite = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          returning: async () => { insertedUser = row; return [
            { ...row, userId: "user-signup-1", isNewUser: true },
          ]; },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => issuanceRows }),
          }),
        }),
      }),
    }),
};

// Captured BEFORE the stub below replaces it — `afterAll` puts it back.
const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({ dbRead, dbWrite, db: dbWrite }));

const createSession = mock(async () => "session-signup-1");
const createRefreshFamily = mock(async () => ({
  familyId: "fam-signup-1",
  refreshToken: "refresh-secret-signup",
}));
const resolveAdminAccess = mock(async () => ({
  isAdmin: false,
  isSuperAdmin: false,
  permissions: [] as string[],
}));

const actualSessionManager = await import(
  "../src/services/session-manager.js"
);
mock.module("../src/services/session-manager.js", () => ({
  ...actualSessionManager,
  createSession,
}));

const actualTokenFamily = await import("../src/services/token-family.js");
mock.module("../src/services/token-family.js", () => ({
  ...actualTokenFamily,
  createRefreshFamily,
}));

const actualAdminAuth = await import("../src/middleware/admin-auth.js");
// Captured BEFORE the stub below replaces it — `afterAll` puts it back.
const realResolveAdminAccess = actualAdminAuth.resolveAdminAccess;
mock.module("../src/middleware/admin-auth.js", () => ({
  ...actualAdminAuth,
  resolveAdminAccess,
}));

const signupUserData = {
  email: "pair@example.com",
  name: "Pair User",
  username: "pairuser",
  gender: "female",
  imageUrl: null as string | null,
  bio: null as string | null,
};

// Names imported from services/user by the routes/auth closure:
// routes/auth (sanitizeUserData, getUserForAuth, getUserIdByEmail),
// middleware/nextauth (getUserIdByEmail, invalidateByEmail),
// services/user-controller (…, logUserActivity, updateUserLastActivity,
// performDailyCheckIn) — called only on paths this test does not exercise.
// Captured BEFORE the stubs below replace them — `afterAll` puts them back.
const actualUserService = await import("../src/services/user.js");
mock.module("../src/services/user.js", () => ({
  sanitizeUserData: mock(async () => signupUserData),
  getUserForAuth: mock(async () => null),
  getUserIdByEmail: mock(async () => null),
  invalidateByEmail: mock(() => {}),
  logUserActivity: mock(async () => {}),
  updateUserLastActivity: mock(async () => {}),
  performDailyCheckIn: mock(async () => null),
}));

const actualPasswordUtil = await import("../src/utils/password.js");
mock.module("../src/utils/password.js", () => ({
  hashPassword: mock(async () => "hashed-password"),
  verifyPassword: mock(async () => true),
}));

const actualEmailVerification = await import("../src/utils/email-verification.js");
mock.module("../src/utils/email-verification.js", () => ({
  createEmailVerificationToken: mock(async () => "verification-token-test"),
  verifyEmailToken: mock(async () => null),
  isEmailVerified: mock(async () => false),
  hasEmailVerificationToken: mock(async () => false),
  markEmailAsVerified: mock(async () => undefined),
  revokeEmailVerificationToken: mock(async () => undefined),
}));

// Only routes/auth imports utils/email inside this closure; the real module
// pulls in the Resend SDK and template config this contract test never uses.
const actualEmailUtil = await import("../src/utils/email.js");
mock.module("../src/utils/email.js", () => ({
  sendVerificationEmail: mock(async () => true),
  sendPasswordResetEmail: mock(async () => true),
  sendPasswordChangedEmail: mock(async () => true),
  sendEmailChangedAlertEmail: mock(async () => true),
  sendEmailSafe: mock(() => {}),
  formatSecurityDetailHtml: mock(() => ""),
}));

const { default: authRouter } = await import("../src/routes/auth.js");

function buildAuthApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", parseJsonBody);
  app.route("/api/auth", authRouter);
  return app;
}

function postSignup(app: Hono<AppEnv>, overrides: object = {}) {
  return app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "pair@example.com",
      username: "pairuser",
      name: "Pair User",
      gender: "female",
      password: "Sup3r!SecretPass!",
      receiveEmails: true,
      agreedToTerms: true,
      ageConfirmed: true,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  createSession.mockClear();
  createRefreshFamily.mockClear();
  issuanceRows = [issuanceUserRow]; insertedUser = {};
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
  // `mock.module` leaks forward across test files in the same process, so a
  // permanent "nobody is an admin" stub here would silently break every later
  // file that authorizes through admin membership (admin moderation, the book
  // detail gate's admin bypass). Restore every mocked namespace — see the
  // mock-restore rule in tests/helpers/store-verification-db.ts.
  mock.module("../src/middleware/admin-auth.js", () => ({
    ...actualAdminAuth,
    resolveAdminAccess: realResolveAdminAccess,
  }));
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/services/session-manager.js", () => actualSessionManager);
  mock.module("../src/services/token-family.js", () => actualTokenFamily);
  mock.module("../src/services/user.js", () => actualUserService);
  mock.module("../src/utils/password.js", () => actualPasswordUtil);
  mock.module("../src/utils/email-verification.js", () => actualEmailVerification);
  mock.module("../src/utils/email.js", () => actualEmailUtil);
});

describe("POST /auth/signup (Q1-A: in-band token pair + isNewUser)", () => {
  it("returns 201 with a token pair whose user carries isNewUser", async () => {
    const app = buildAuthApp();
    const res = await postSignup(app);

    expect(res.status).toBe(201);
    const body = await res.json();
    // The pair half of the Q1 contract: AuthRepository._decodePair needs
    // refreshToken + user in the same response that seeds isNewUser.
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken.length).toBeGreaterThan(0);
    expect(typeof body.accessToken).toBe("string");
    expect(body.accessToken.length).toBeGreaterThan(0);
    expect(body.tokenType).toBe("Bearer");

    expect(body.user).toBeDefined();
    expect(body.user.isNewUser).toBe(true);
    expect(body.user.userId).toBe("user-signup-1");
    expect(body.isNewUser).toBe(true);

    // Additive parity: pre-Q1-A callers still read these fields.
    expect(typeof body.message).toBe("string");
    expect(typeof body.verificationEmailSent).toBe("boolean");
    expect(body.userId).toBe("user-signup-1");

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createRefreshFamily).toHaveBeenCalledTimes(1);
  });

  it('persists explicit opt-out rather than enabling defaults after signup', async () => {
    expect((await postSignup(buildAuthApp(), { receiveEmails: false })).status).toBe(201);
    const preferences = insertedUser.emailPreferences as Record<string, boolean>;
    expect(preferences.weeklyRecommendations).toBe(false);
    expect(preferences.monthlyActivitySummary).toBe(false);
    expect(preferences.productAnnouncements).toBe(false);
    expect(preferences.storyPublished).toBe(false);
  });

  it("degrades to a creation-only 201 when issuance cannot run", async () => {
    issuanceRows = [];
    const app = buildAuthApp();
    const res = await postSignup(app);

    // The account already exists either way: 201 without tokens keeps
    // non-interactive/legacy callers working, and the canonical insert-row
    // isNewUser still lets clients seed the flag without a refetch.
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.refreshToken).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
    expect(body.isNewUser).toBe(true);
    expect(body.userId).toBe("user-signup-1");
    expect(typeof body.message).toBe("string");
    expect(typeof body.verificationEmailSent).toBe("boolean");

    expect(createSession).not.toHaveBeenCalled();
    expect(createRefreshFamily).not.toHaveBeenCalled();
  });
});
