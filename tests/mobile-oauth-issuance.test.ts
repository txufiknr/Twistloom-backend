/**
 * Dual mobile auth issuance + Apple claim validation (F02/F03/F04/F83).
 *
 * Covers the shared {@link issueMobileLoginPair} success/failure matrix and
 * Apple identity claim rules without a live database or Apple JWKS network
 * call (DB legs mocked; Apple claims validated via pure assert helpers).
 */

import { describe, expect, it, beforeAll, afterAll, mock, beforeEach } from "bun:test";

const ORIGINAL_ENV = { ...process.env };
const TEST_MOBILE_SECRET = "dual-mobile-auth-secret-at-least-32-chars!";

// Env must exist before importing mobile-tokens consumers.
process.env.MOBILE_ACCESS_SECRET = TEST_MOBILE_SECRET;
process.env.MOBILE_ACCESS_TTL_MINUTES = "15";
process.env.MOBILE_ACCESS_AUD = "reader";

const actualMobileTokens = await import("../src/services/mobile-tokens.js");
const realIssueAccessToken = actualMobileTokens.issueAccessToken;

const issueAccessToken = mock(
  async (userId: string, sessionId: string, tokenVersion: number) =>
    realIssueAccessToken(userId, sessionId, tokenVersion),
);

const createSession = mock(async () => "session-test-1");
const createRefreshFamily = mock(async () => ({
  familyId: "fam-test-1",
  refreshToken: "refresh-secret-test",
}));
const resolveAdminAccess = mock(async () => ({
  isAdmin: false,
  isSuperAdmin: false,
  permissions: [],
}));

mock.module("../src/services/mobile-tokens.js", () => ({
  ...actualMobileTokens,
  issueAccessToken,
  getAccessTtlSeconds: actualMobileTokens.getAccessTtlSeconds,
}));

const userRow = {
  tokenVersion: 7,
  email: "user@example.com",
  name: "Test User",
  username: "testuser",
  imageUrl: null as string | null,
  isNewUser: false,
  bannedAt: null as Date | null,
};

const selectChain = {
  from: () => ({
    where: () => ({
      limit: async () => [userRow],
    }),
  }),
};

const txSelectChain = {
  from: () => ({
    where: () => ({
      limit: async () => [{ tokenVersion: userRow.tokenVersion }],
    }),
  }),
};

const dbRead = { select: () => selectChain };
const dbWrite = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      select: () => txSelectChain,
      insert: () => ({ values: async () => undefined }),
    }),
};

mock.module("../src/services/session-manager.js", () => ({
  createSession,
  updateSessionMetadata: async () => undefined,
}));
mock.module("../src/services/token-family.js", () => ({
  createRefreshFamily,
}));
mock.module("../src/middleware/admin-auth.js", () => ({
  resolveAdminAccess,
  isSuperAdminUserId: () => false,
}));
mock.module("../src/db/client.js", () => ({
  dbRead,
  dbWrite,
  db: dbWrite,
}));

const { issueMobileLoginPair } = await import("../src/services/mobile-login.js");
const {
  assertAppleClaims,
  isAppleEmailVerified,
  APPLE_ISSUER,
} = await import("../src/services/apple-auth.js");

beforeAll(() => {
  process.env.MOBILE_ACCESS_SECRET = TEST_MOBILE_SECRET;
  process.env.MOBILE_ACCESS_TTL_MINUTES = "15";
  process.env.MOBILE_ACCESS_AUD = "reader";
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  createSession.mockClear();
  createRefreshFamily.mockClear();
  resolveAdminAccess.mockClear();
  issueAccessToken.mockClear();
  userRow.bannedAt = null;
});

describe("issueMobileLoginPair (SSOT for password/google/apple)", () => {
  it("returns the canonical bearer pair shape", async () => {
    const result = await issueMobileLoginPair("user-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pair.tokenType).toBe("Bearer");
    expect(result.pair.expiresIn).toBe(900);
    expect(typeof result.pair.accessToken).toBe("string");
    expect(result.pair.refreshToken).toBe("refresh-secret-test");
    expect(result.pair.familyId).toBe("fam-test-1");
    expect(result.pair.user.userId).toBe("user-1");
    expect(result.pair.user.email).toBe("user@example.com");
    expect(result.pair.user.sessionId).toBe("session-test-1");
    expect(result.pair.user.isAdmin).toBe(false);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createRefreshFamily).toHaveBeenCalledTimes(1);
    expect(issueAccessToken).toHaveBeenCalledTimes(1);
    expect(resolveAdminAccess).toHaveBeenCalledWith("user-1");
  });

  it("fails closed when the user row is missing", async () => {
    const original = selectChain.from;
    selectChain.from = () => ({
      where: () => ({ limit: async () => [] }),
    });
    try {
      const result = await issueMobileLoginPair("ghost");
      expect(result).toEqual({ ok: false, reason: "missing" });
      expect(createSession).not.toHaveBeenCalled();
      expect(createRefreshFamily).not.toHaveBeenCalled();
    } finally {
      selectChain.from = original;
    }
  });

  it("fails closed for banned users without minting tokens", async () => {
    userRow.bannedAt = new Date("2026-01-01");
    const result = await issueMobileLoginPair("banned-user");
    expect(result).toEqual({ ok: false, reason: "banned" });
    expect(createSession).not.toHaveBeenCalled();
    expect(issueAccessToken).not.toHaveBeenCalled();
  });
});

describe("Apple identity claim validation (F02/F83)", () => {
  const audience = "com.twistloom.app";

  it("accepts valid issuer/audience/sub", () => {
    expect(
      assertAppleClaims(
        { iss: APPLE_ISSUER, aud: audience, sub: "apple-sub-1" },
        audience,
      ),
    ).toBeNull();
  });

  it("accepts array aud containing the bundle id", () => {
    expect(
      assertAppleClaims(
        { iss: APPLE_ISSUER, aud: [audience, "other"], sub: "s" },
        audience,
      ),
    ).toBeNull();
  });

  it("rejects wrong issuer", () => {
    expect(
      assertAppleClaims(
        { iss: "https://evil.example", aud: audience, sub: "s" },
        audience,
      ),
    ).toBe("wrong_issuer");
  });

  it("rejects wrong audience (web Services ID vs native bundle)", () => {
    expect(
      assertAppleClaims(
        { iss: APPLE_ISSUER, aud: "com.twistloom.web", sub: "s" },
        audience,
      ),
    ).toBe("wrong_audience");
  });

  it("rejects missing sub", () => {
    expect(
      assertAppleClaims({ iss: APPLE_ISSUER, aud: audience }, audience),
    ).toBe("missing_sub");
    expect(
      assertAppleClaims(
        { iss: APPLE_ISSUER, aud: audience, sub: "" },
        audience,
      ),
    ).toBe("missing_sub");
  });

  it("normalizes Apple email_verified string and boolean forms", () => {
    expect(isAppleEmailVerified(true)).toBe(true);
    expect(isAppleEmailVerified("true")).toBe(true);
    expect(isAppleEmailVerified(false)).toBe(false);
    expect(isAppleEmailVerified("false")).toBe(false);
    expect(isAppleEmailVerified(undefined)).toBe(false);
  });
});
