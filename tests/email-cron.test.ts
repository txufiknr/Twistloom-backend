import { afterAll, beforeEach, expect, it, mock } from "bun:test";
const actualCampaigns = { ...await import("../src/services/email-campaigns.js") };
const actualDelivery = { ...await import("../src/services/email-delivery.js") };
const actualGate = { ...await import("../src/services/email-gate.js") };
const calls: string[] = [];
let pausedUntil: Date | null = null;
mock.module("../src/services/email-campaigns.js", () => ({ ...actualCampaigns,
  processEmailCampaigns: async (inAppOnly = false) => { calls.push(inAppOnly ? "campaigns/in-app" : "campaigns/all"); },
}));
mock.module("../src/services/email-delivery.js", () => ({ ...actualDelivery,
  processEmailMessages: async () => { calls.push("messages"); return { processed: 3, nextRunAt: null }; },
}));
mock.module("../src/services/email-gate.js", () => ({ ...actualGate, emailProviderPausedUntil: async () => pausedUntil }));
const router = (await import("../src/routes/cron.js")).default;
const keys = ["EMAIL_DELIVERY_ENABLED", "RESEND_API_KEY", "CRON_SECRET", "QSTASH_TOKEN", "BACKEND_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "NODE_ENV"];
const saved = new Map(keys.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of keys) process.env[key] = "test-only";
  process.env.EMAIL_DELIVERY_ENABLED = "true"; process.env.NODE_ENV = "test";
  process.env.BACKEND_URL = "https://backend.example.test"; calls.length = 0; pausedUntil = null;
});
afterAll(() => {
  mock.module("../src/services/email-campaigns.js", () => actualCampaigns);
  mock.module("../src/services/email-delivery.js", () => actualDelivery);
  mock.module("../src/services/email-gate.js", () => actualGate);
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
for (const path of ["/emails", "/announcement-emails"]) {
  const invoke = () => router.request(path, { method: "POST", headers: { authorization: "Bearer test-only" } });
  it(`${path} runs the shared pipeline and returns its result`, async () => {
    const response = await invoke();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data: { processed: 3, nextRunAt: null } });
    expect(calls).toEqual(["campaigns/all", "messages"]);
  });
  it(`${path} preserves in-app fan-out during a shared provider pause`, async () => {
    pausedUntil = new Date("2026-10-14T00:00:00Z");
    const response = await invoke();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, pausedUntil: pausedUntil.toISOString() });
    expect(calls).toEqual(["campaigns/in-app"]);
  });
  it(`${path} enforces both cron authentication and the shared rollout gate`, async () => {
    expect((await router.request(path, { method: "POST" })).status).toBe(401);
    process.env.EMAIL_DELIVERY_ENABLED = "false";
    expect((await invoke()).status).toBe(503); expect(calls).toEqual([]);
  });
}
