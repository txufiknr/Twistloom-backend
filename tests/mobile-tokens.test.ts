import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  issueAccessToken,
  verifyAccessToken,
  PROVISIONAL_AUDIENCE,
  MOBILE_TOKEN_ISSUER,
} from "../src/services/mobile-tokens.js";
import {
  evaluateRotation,
  type RotationFamilyRow,
} from "../src/services/token-family.js";
import { isServiceBearerPath } from "../src/middleware/bearer.js";
import { constantTimeEqual } from "../src/utils/crypto.js";
import { hashSHA256 } from "../src/utils/hash.js";

const ORIGINAL_ENV = { ...process.env };

function setSecret(secret: string) {
  process.env.MOBILE_ACCESS_SECRET = secret;
}

beforeEach(() => {
  setSecret("unit-test-mobile-secret-at-least-32-chars!!");
  process.env.MOBILE_ACCESS_TTL_MINUTES = "15";
  process.env.MOBILE_ACCESS_AUD = "reader";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Mobile access tokens (Step 4)", () => {
  it("issues a HS256 JWT with expected claims", async () => {
    const result = await issueAccessToken("user-1", "session-1", 7);
    expect(typeof result.token).toBe("string");
    expect(result.expiresIn).toBe(900);

    const verified = await verifyAccessToken(result.token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.sub).toBe("user-1");
      expect(verified.claims.sid).toBe("session-1");
      expect(verified.claims.tv).toBe(7);
      expect(verified.claims.iss).toBe(MOBILE_TOKEN_ISSUER);
      expect(verified.claims.aud).toBe(PROVISIONAL_AUDIENCE);
    }
  });

  it("rejects a token signed with a different secret", async () => {
    const result = await issueAccessToken("user-1", "session-1", 0);
    setSecret("another-secret-completely-different-32!");
    const verified = await verifyAccessToken(result.token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe("secret");
  });

  it("accepts previous secret during dual-secret rotation window", async () => {
    const result = await issueAccessToken("user-1", "session-1", 0);
    // Rotate: current secret changes, previous keeps working
    process.env.MOBILE_ACCESS_SECRET = "brand-new-secret-for-rotation-32ch";
    process.env.MOBILE_ACCESS_SECRET_PREVIOUS =
      "unit-test-mobile-secret-at-least-32-chars!!";
    const verified = await verifyAccessToken(result.token);
    expect(verified.ok).toBe(true);
  });

  it("rejects tampered payload", async () => {
    const result = await issueAccessToken("user-1", "session-1", 0);
    const parts = result.token.split(".");
    // Flip a character in the payload segment
    const payload = parts[1].replace(/^.(?=.)/, (m) => (m === "A" ? "B" : "A"));
    const tampered = [parts[0], payload, parts[2]].join(".");
    const verified = await verifyAccessToken(tampered);
    expect(verified.ok).toBe(false);
  });

  it("throws when MOBILE_ACCESS_SECRET is missing", async () => {
    delete process.env.MOBILE_ACCESS_SECRET;
    await expect(issueAccessToken("u", "s", 0)).rejects.toThrow(/MOBILE_ACCESS_SECRET/);
  });
});

describe("Service-bearer path exemption (Step 5)", () => {
  it("exempts /api/cron/* so CRON_SECRET Authorization still works", () => {
    expect(isServiceBearerPath("/api/cron/probe")).toBe(true);
    expect(isServiceBearerPath("/api/cron")).toBe(true);
    expect(isServiceBearerPath("/api/cron/process-disbursements")).toBe(true);
  });

  it("does not exempt other API routes", () => {
    expect(isServiceBearerPath("/api/auth/mobile/token")).toBe(false);
    expect(isServiceBearerPath("/api/books")).toBe(false);
    expect(isServiceBearerPath("/apicron/x")).toBe(false);
    expect(isServiceBearerPath("/api/cronish")).toBe(false);
  });
});

describe("hashSHA256 (refresh family storage)", () => {
  it("is deterministic and hex-encoded", async () => {
    const a = await hashSHA256("refresh-secret-value");
    const b = await hashSHA256("refresh-secret-value");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSHA256("other")).not.toBe(a);
  });
});

describe("evaluateRotation — RFC 9700 family rotation (Step 6)", () => {
  const NOW = new Date("2026-01-15T12:00:00Z");
  const CURRENT = "hash-current";
  const PREVIOUS = "hash-previous";
  const OLDER = "hash-older";
  const UNKNOWN = "hash-unknown";

  function familyRow(overrides: Partial<RotationFamilyRow> = {}): RotationFamilyRow {
    return {
      id: "family-1",
      userId: "user-1",
      sessionId: "session-1",
      tokenVersion: 3,
      refreshHash: CURRENT,
      usedHashes: [OLDER, PREVIOUS],
      revokedAt: null,
      expiresAt: new Date("2026-02-15T12:00:00Z"),
      ...overrides,
    };
  }

  it("returns not_found when no family row matched the presented hash", () => {
    expect(evaluateRotation(null, UNKNOWN, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({ action: "not_found" });
    expect(evaluateRotation(undefined, UNKNOWN, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({ action: "not_found" });
  });

  it("rotates when the presented hash is the current refreshHash (usedAt may be set)", () => {
    // Regression: a bare usedAt check treated the second legitimate refresh as reuse.
    // Rotation only keys off presented hash vs current refreshHash.
    const row = familyRow({ usedHashes: [OLDER, PREVIOUS] });
    expect(evaluateRotation(row, CURRENT, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({ action: "rotate" });
  });

  it("rotates on consecutive legitimate refreshes (current hash advances each time)", () => {
    // Simulate rotate #1: H1 current → H2 current, H1 moved to usedHashes.
    const afterFirst = familyRow({ refreshHash: "h2", usedHashes: ["h1"] });
    expect(evaluateRotation(afterFirst, "h2", { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({ action: "rotate" });

    // Simulate rotate #2: H2 current → H3 current, H2 appended. Second refresh must NOT revoke.
    const afterSecond = familyRow({
      refreshHash: "h3",
      usedHashes: ["h1", "h2"],
    });
    expect(evaluateRotation(afterSecond, "h3", { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({ action: "rotate" });
  });

  it("flags reuse and revokes when any prior hash is replayed", () => {
    const row = familyRow();
    expect(evaluateRotation(row, PREVIOUS, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "reused",
      revoke: true,
    });
    expect(evaluateRotation(row, OLDER, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "reused",
      revoke: true,
    });
  });

  it("fails closed on revoked families without re-revoking", () => {
    const row = familyRow({ revokedAt: new Date("2026-01-01T00:00:00Z") });
    expect(evaluateRotation(row, CURRENT, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "revoked",
      revoke: false,
    });
  });

  it("fails closed on expired families without re-revoking", () => {
    const row = familyRow({ expiresAt: new Date("2026-01-01T00:00:00Z") });
    expect(evaluateRotation(row, CURRENT, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "expired",
      revoke: false,
    });
  });

  it("revokes on tokenVersion mismatch (logout-all / password change)", () => {
    const row = familyRow({ tokenVersion: 2 });
    expect(evaluateRotation(row, CURRENT, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "tv_mismatch",
      revoke: true,
    });
  });

  it("revokes when the user row is missing", () => {
    const row = familyRow();
    expect(evaluateRotation(row, CURRENT, null, NOW)).toEqual({
      action: "fail",
      reason: "tv_mismatch",
      revoke: true,
    });
  });

  it("fails closed on banned users at refresh (do not mint new secret)", () => {
    const row = familyRow();
    expect(evaluateRotation(row, CURRENT, { tokenVersion: 3, bannedAt: new Date("2026-01-01") }, NOW)).toEqual({
      action: "fail",
      reason: "banned",
      revoke: true,
    });
  });

  it("prefers revoked over reuse when both apply", () => {
    const row = familyRow({ revokedAt: new Date("2026-01-01T00:00:00Z") });
    expect(evaluateRotation(row, PREVIOUS, { tokenVersion: 3, bannedAt: null }, NOW)).toEqual({
      action: "fail",
      reason: "revoked",
      revoke: false,
    });
  });
});

describe("Cron cookie-baseline regression (Step 3 gate)", () => {
  it("constantTimeEqual still matches cron expectations", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});
