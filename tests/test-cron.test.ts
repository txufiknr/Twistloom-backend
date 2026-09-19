import { describe, expect, it } from "bun:test";
import { constantTimeEqual } from "../src/utils/crypto.js";
import cronRouter from "../src/routes/cron.js";

describe("Cron Security & Authentication", () => {
  describe("constantTimeEqual", () => {
    it("returns true for identical strings", () => {
      expect(constantTimeEqual("secret-token-123", "secret-token-123")).toBe(true);
      expect(constantTimeEqual("", "")).toBe(true);
      expect(constantTimeEqual("a", "a")).toBe(true);
    });

    it("returns false for strings of different length", () => {
      expect(constantTimeEqual("secret-token-123", "secret-token-12")).toBe(false);
      expect(constantTimeEqual("short", "longer-string")).toBe(false);
      expect(constantTimeEqual("", "non-empty")).toBe(false);
    });

    it("returns false for strings of same length with different characters", () => {
      expect(constantTimeEqual("secret-token-123", "secret-token-124")).toBe(false);
      expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    });
  });

  describe("Cron Router Middleware Authentication", () => {
    const originalEnv = { ...process.env };

    it("allows request when CRON_SECRET is configured and valid Bearer token provided", async () => {
      process.env.CRON_SECRET = "super-secret-cron-key";
      process.env.NODE_ENV = "production";

      const res = await cronRouter.request("/probe", {
        method: "GET",
        headers: {
          authorization: "Bearer super-secret-cron-key",
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.message).toBe("Cron service reachable");

      process.env = { ...originalEnv };
    });

    it("allows request when CRON_SECRET is configured and valid x-cron-secret header provided", async () => {
      process.env.CRON_SECRET = "super-secret-cron-key";
      process.env.NODE_ENV = "production";

      const res = await cronRouter.request("/probe", {
        method: "GET",
        headers: {
          "x-cron-secret": "super-secret-cron-key",
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      process.env = { ...originalEnv };
    });

    it("rejects with 401 when CRON_SECRET is configured and invalid token provided", async () => {
      process.env.CRON_SECRET = "super-secret-cron-key";
      process.env.NODE_ENV = "production";

      const res = await cronRouter.request("/probe", {
        method: "GET",
        headers: {
          authorization: "Bearer wrong-key",
        },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Unauthorized");

      process.env = { ...originalEnv };
    });

    it("rejects with 401 when CRON_SECRET is configured and no token provided", async () => {
      process.env.CRON_SECRET = "super-secret-cron-key";
      process.env.NODE_ENV = "production";

      const res = await cronRouter.request("/probe", {
        method: "GET",
      });

      expect(res.status).toBe(401);

      process.env = { ...originalEnv };
    });

    it("rejects with 500 when CRON_SECRET is unset in staging environment", async () => {
      delete process.env.CRON_SECRET;
      process.env.NODE_ENV = "staging";

      const res = await cronRouter.request("/probe", {
        method: "GET",
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("CRON_SECRET not configured on server");

      process.env = { ...originalEnv };
    });

    it("rejects with 500 when CRON_SECRET is unset in production environment", async () => {
      delete process.env.CRON_SECRET;
      process.env.NODE_ENV = "production";

      const res = await cronRouter.request("/probe", {
        method: "GET",
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("CRON_SECRET not configured on server");

      process.env = { ...originalEnv };
    });

    it("allows unauthenticated execution in test or development environment when CRON_SECRET is unset", async () => {
      delete process.env.CRON_SECRET;
      process.env.NODE_ENV = "test";

      const res = await cronRouter.request("/probe", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      process.env = { ...originalEnv };
    });
  });
});
