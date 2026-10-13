import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { dispatchEmailWorkers } from "../src/services/email-dispatch.js";
import { emailDeliveryEnabled, emailWorkerUrl } from "../src/config/email-delivery.js";

const savedEnv = { UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN, EMAIL_DELIVERY_ENABLED: process.env.EMAIL_DELIVERY_ENABLED,
  RESEND_API_KEY: process.env.RESEND_API_KEY, CRON_SECRET: process.env.CRON_SECRET, QSTASH_TOKEN: process.env.QSTASH_TOKEN,
  BACKEND_URL: process.env.BACKEND_URL, NODE_ENV: process.env.NODE_ENV };
beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-only";
  process.env.EMAIL_DELIVERY_ENABLED = "true";
  process.env.RESEND_API_KEY = "test-only";
  process.env.QSTASH_TOKEN = "test-only";
  process.env.CRON_SECRET = "test-cron";
  process.env.BACKEND_URL = "https://backend.example.test/";
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("shared email wakeups", () => {
  it("publishes bounded authenticated workers with distinct stable deduplication keys", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ messageId: "test" }));
    try {
      expect(await dispatchEmailWorkers("queued/test", 10)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(fetch.mock.calls[0]?.[0]).toBe("https://qstash.upstash.io/v2/publish/https://backend.example.test/api/cron/emails");
      const keys = fetch.mock.calls.map(call => {
        const headers = new Headers(call[1]?.headers);
        expect(headers.get("Upstash-Forward-Authorization")).toBe("Bearer test-cron");
        expect(headers.get("Upstash-Flow-Control-Value")).toBe("parallelism=4");
        expect(call[1]?.body).toBe("{}");
        return headers.get("Upstash-Deduplication-Id");
      });
      expect(new Set(keys).size).toBe(4);
      expect(keys[0]).toBe("queued/test/0");
    } finally { fetch.mockRestore(); }
  });
  it("delays a continuation until due work can resume", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await dispatchEmailWorkers("slice/test/lease", 1, new Date(Date.now() + 120_000));
      const delay = new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Upstash-Delay");
      expect(delay).toBe("120s");
    } finally { fetch.mockRestore(); }
  });
  it("keeps durable work recoverable when publishing fails", async () => {
    const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unavailable"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await dispatchEmailWorkers("slice/test/lease")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); warn.mockRestore(); }
  });
  it("requires a working dispatch configuration before enabling jobs", () => {
    expect(emailDeliveryEnabled()).toBe(true);
    delete process.env.QSTASH_TOKEN;
    expect(emailDeliveryEnabled()).toBe(false);
    process.env.QSTASH_TOKEN = "test-only";
    process.env.BACKEND_URL = "invalid";
    expect(emailWorkerUrl()).toBeNull();
    process.env.NODE_ENV = "production";
    process.env.BACKEND_URL = "http://backend.example.test";
    expect(emailDeliveryEnabled()).toBe(false);
  });
});
