import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { emailProviderRetryAt, sendProviderEmail } from "../src/utils/email-provider.js";

const originalKey = process.env.RESEND_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalKey;
});
describe("bounded shared email provider", () => {
  const template = { from: "test@example.test", subject: "Test", html: "<p>Frozen</p>" };
  it("sends the stable key and immutable request payload", async () => {
    process.env.RESEND_API_KEY = "test-only";
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "accepted" }));
    try {
      expect(await sendProviderEmail(template, "reader@example.test", "campaign/recipient")).toEqual({ kind: "accepted", providerId: "accepted" });
      const options = fetch.mock.calls[0]?.[1];
      expect(new Headers(options?.headers).get("Idempotency-Key")).toBe("campaign/recipient");
      expect(options?.body).toBe(JSON.stringify({ ...template, to: "reader@example.test" }));
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    } finally { fetch.mockRestore(); }
  });
  for (const [status, kind, ambiguous] of [[429, "paused", undefined], [503, "retry", true], [409, "needs_review", undefined], [422, "failed", undefined], [401, "paused", undefined], [403, "paused", undefined]]) {
    it(`classifies HTTP ${status} without exposing the provider response`, async () => {
      process.env.RESEND_API_KEY = "test-only";
      if (typeof status !== "number") throw new Error("Invalid fixture");
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("private provider error", { status }));
      try {
        const result = await sendProviderEmail(template, "reader@example.test", "stable");
        expect(result.kind).toBe(kind);
        if ("ambiguous" in result) expect(result.ambiguous).toBe(ambiguous);
        expect(JSON.stringify(result)).not.toContain("private");
      } finally { fetch.mockRestore(); }
    });
  }
  it("treats an interrupted request as ambiguous", async () => {
    process.env.RESEND_API_KEY = "test-only";
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    try { expect(await sendProviderEmail(template, "reader@example.test", "stable")).toMatchObject({ kind: "retry", ambiguous: true }); }
    finally { fetch.mockRestore(); }
  });
  for (const [name, kind] of [["concurrent_idempotent_requests", "retry"], ["resource_locked", "retry"],
    ["invalid_idempotent_request", "needs_review"], ["unknown_conflict", "needs_review"]]) {
    it(`handles named 409 ${name} with the original key`, async () => {
      process.env.RESEND_API_KEY = "test-only";
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name, message: "private recipient" }, { status: 409 }));
      try {
        const result = await sendProviderEmail(template, "reader@example.test", "original");
        expect(result.kind).toBe(kind);
        if ("ambiguous" in result) expect(result.ambiguous).toBe(name === "concurrent_idempotent_requests");
        expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe("original");
        expect(JSON.stringify(result)).not.toContain("private");
      } finally { fetch.mockRestore(); }
    });
  }
  for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded", "rate_limit_exceeded"]) {
    it(`defers named quota or rate error ${name}`, async () => {
      process.env.RESEND_API_KEY = "test-only";
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name }, { status: 429, headers: { "Retry-After": "120" } }));
      try {
        const before = Date.now();
        const result = await sendProviderEmail(template, "reader@example.test", "stable");
        expect(result.kind).toBe("paused");
        if (result.kind !== "paused") throw new Error("Expected a provider pause");
        expect(result.code).toBe(name);
        if (name === "daily_quota_exceeded") {
          expect(result.retryAt.getUTCHours()).toBe(0);
          expect(result.retryAt.getUTCMinutes()).toBe(0);
          expect(result.retryAt.getTime()).toBeGreaterThan(before);
        } else expect(result.retryAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
      } finally { fetch.mockRestore(); }
    });
  }
  it("supports numeric and HTTP-date Retry-After and rejects invalid values", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    expect(emailProviderRetryAt(new Response(null, { headers: { "Retry-After": "45" } }), 1000, now).getTime()).toBe(now.getTime() + 45_000);
    expect(emailProviderRetryAt(new Response(null, { headers: { "Retry-After": "Tue, 13 Oct 2026 00:02:00 GMT" } }), 1000, now).getTime()).toBe(now.getTime() + 120_000);
    expect(emailProviderRetryAt(new Response(null, { headers: { "Retry-After": "invalid" } }), 1000, now).getTime()).toBe(now.getTime() + 1000);
  });
});
