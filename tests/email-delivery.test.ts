import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";
import { generateId } from "../src/utils/uuid.js";
import type { EmailSendResult, EmailType } from "../src/types/email-delivery.js";
const actualDb = { ...await import("../src/db/client.js") };
const actualGate = { ...await import("../src/services/email-gate.js") };
const actualProvider = { ...await import("../src/utils/email-provider.js") };
const actualDispatch = { ...await import("../src/services/email-dispatch.js") };
const db = createFakeDb();
let allowed = true;
let permits = 0;
let maxPermits = Infinity;
let stealLease = false;
let result: EmailSendResult = { kind: "accepted", providerId: "accepted" };
const sends: Array<{ to: string; key: string; html: string }> = [];
const wakeups: Date[] = [];
mock.module("../src/db/client.js", () => ({ ...actualDb, dbRead: db.dbRead, dbWrite: db.dbWrite }));
mock.module("../src/services/email-gate.js", () => ({ ...actualGate,
  acquireEmailPermit: async () => allowed && permits++ < maxPermits ? { allowed: true, probeToken: null } : { allowed: false, retryAt: new Date(Date.now() + 1000) },
  recordEmailProviderResult: async () => {}, releaseEmailProbe: async () => {},
}));
mock.module("../src/utils/email-provider.js", () => ({ ...actualProvider, sendProviderEmail: async (template: { html: string }, to: string, key: string) => {
  sends.push({ html: template.html, to, key });
  if (stealLease) db.rows.emailMessages.find(row => row.requestKey === key).leaseToken = generateId();
  return result;
} }));
mock.module("../src/services/email-dispatch.js", () => ({ ...actualDispatch, dispatchEmailWorkers: async (_id: string, _count: number, runAt: Date) => { wakeups.push(runAt); return true; } }));
const { queueEmailMessage, deliverEmailNow, processEmailMessages, emailRetryLimit } = await import("../src/services/email-delivery.js");
const keys = ["EMAIL_DELIVERY_ENABLED", "RESEND_API_KEY", "CRON_SECRET", "QSTASH_TOKEN", "BACKEND_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const saved = new Map(keys.map(key => [key, process.env[key]]));
const userId = generateId();
beforeEach(() => {
  for (const key of keys) process.env[key] = "test-only";
  process.env.EMAIL_DELIVERY_ENABLED = "true"; process.env.BACKEND_URL = "https://backend.example.test";
  allowed = true; permits = 0; maxPermits = Infinity; stealLease = false;
  result = { kind: "accepted", providerId: "accepted" }; sends.length = 0; wakeups.length = 0;
  db.reset({ users: [{ userId, email: "recipient@example.test", isNewUser: false, emailPreferences: { weeklyRecommendations: true } }] });
});
afterAll(() => {
  mock.module("../src/db/client.js", () => actualDb); mock.module("../src/services/email-gate.js", () => actualGate);
  mock.module("../src/utils/email-provider.js", () => actualProvider); mock.module("../src/services/email-dispatch.js", () => actualDispatch);
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const queue = (type: EmailType = "welcome", requestKey = `test/${generateId()}`) => queueEmailMessage({ type, requestKey, locale: "en", userId,
  payload: { to: "recipient@example.test", from: "sender@example.test", subject: "Test", html: "<p>Frozen</p>" } });
describe("shared durable delivery", () => {
  it("rolls back durable intent with a failed domain transaction", async () => {
    await expect(db.dbWrite.transaction(async tx => {
      await queueEmailMessage({ type: "refund", requestKey: "refund/rollback", locale: "en",
        payload: { to: "recipient@example.test", from: "sender@example.test", subject: "Refund", html: "<p>Refund</p>" } }, tx);
      throw new Error("Domain mutation failed");
    })).rejects.toThrow("Domain mutation failed");
    expect(db.rows.emailMessages).toHaveLength(0); expect(sends).toHaveLength(0);
  });
  it("encrypts retained payloads and deduplicates logical events", async () => {
    const id = await queue("welcome", "welcome/event"); expect(await queue("welcome", "welcome/event")).toBe(id);
    expect(db.rows.emailMessages).toHaveLength(1); expect(db.rows.emailMessages[0].payloadEncrypted).not.toContain("recipient@example.test");
    expect(sends).toHaveLength(0);
  });
  it("rejects reusing a logical key for a different email type", async () => {
    await queue("welcome", "shared/key");
    await expect(queue("refund", "shared/key")).rejects.toThrow("another event identity");
    expect(db.rows.emailMessages).toHaveLength(1); expect(sends).toHaveLength(0);
  });
  it("queues billing intent for failure events, without duplicating status-sync alerts", async () => {
    const { updateSubscription } = await import("../src/services/subscription.js");
    db.rows.subscriptions.push({ id: generateId(), userId, providerSubscriptionId: "sub/email", gateway: "stripe",
      status: "active", email: "recipient@example.test", name: "User" });
    await updateSubscription({ providerSubscriptionId: "sub/email", status: "past_due" });
    expect(db.rows.emailMessages).toHaveLength(0);
    await updateSubscription({ providerSubscriptionId: "sub/email", status: "past_due", paymentFailureEventId: "evt/failure" });
    await updateSubscription({ providerSubscriptionId: "sub/email", status: "past_due", paymentFailureEventId: "evt/failure" });
    expect(db.rows.emailMessages).toHaveLength(1); expect(sends).toHaveLength(0);
  });
  it("rolls back billing status when required intent cannot be persisted", async () => {
    const { updateSubscription } = await import("../src/services/subscription.js");
    db.rows.subscriptions.push({ id: generateId(), userId, providerSubscriptionId: "sub/rollback", gateway: "stripe",
      status: "active", email: "recipient@example.test", name: "User" });
    await queue("welcome", "payment_failed/stripe/evt/collision");
    await expect(updateSubscription({ providerSubscriptionId: "sub/rollback", status: "past_due",
      paymentFailureEventId: "evt/collision" })).rejects.toThrow("another event identity");
    expect(db.rows.subscriptions[0].status).toBe("active"); expect(sends).toHaveLength(0);
  });
  it("records acceptance once and never repeats a completed request", async () => {
    const id = await queue(); expect((await deliverEmailNow(id)).status).toBe("sent"); expect((await deliverEmailNow(id)).status).toBe("sent");
    expect(sends).toHaveLength(1); expect(db.rows.emailMessages[0].providerId).toBe("accepted");
  });
  it("defers without claiming or consuming attempts when Redis admission fails", async () => {
    const id = await queue(); allowed = false; expect((await deliverEmailNow(id)).status).toBe("pending");
    expect(db.rows.emailMessages[0].attempts).toBe(0); expect(sends).toHaveLength(0); expect(wakeups).toHaveLength(1);
  });
  it("recovers an expired send intent with the original key and payload", async () => {
    const id = await queue(); result = { kind: "retry", ambiguous: true, code: "timeout" }; await deliverEmailNow(id);
    const row = db.rows.emailMessages[0]; row.status = "sending"; row.leaseToken = generateId(); row.leaseExpiresAt = new Date(0);
    result = { kind: "accepted", providerId: "recovered" }; expect((await deliverEmailNow(id)).status).toBe("sent"); expect(sends[1]).toEqual(sends[0]);
  });
  it("does not reclaim a live lease", async () => {
    const id = await queue(); const row = db.rows.emailMessages[0]; row.status = "sending"; row.leaseToken = generateId(); row.leaseExpiresAt = new Date(Date.now() + 90_000);
    expect((await deliverEmailNow(id)).status).toBe("sending"); expect(sends).toHaveLength(0);
  });
  it("does not overwrite a result after ownership changes", async () => {
    const id = await queue(); stealLease = true;
    await deliverEmailNow(id);
    expect(db.rows.emailMessages[0].status).toBe("sending"); expect(db.rows.emailMessages[0].providerId ?? null).toBeNull();
  });
  it("skips an obsolete credential before contacting the provider", async () => {
    const id = await queueEmailMessage({ type: "verification", requestKey: "verification/old", userId, locale: "en", credentialHash: "old-proof",
      payload: { to: "recipient@example.test", from: "sender@example.test", subject: "Verify", html: "<p>Old code</p>" } });
    db.rows.userAuth.push({ userId, emailVerificationToken: "new-proof", emailVerificationExpires: new Date(Date.now() + 60_000) });
    expect((await deliverEmailNow(id)).status).toBe("skipped"); expect(sends).toHaveLength(0);
  });
  it("does not exhaust recipient retries on quota exhaustion", async () => {
    const id = await queue(); result = { kind: "paused", code: "monthly_quota_exceeded", retryAt: new Date(Date.now() + 3600_000) };
    expect((await deliverEmailNow(id)).status).toBe("pending"); expect(db.rows.emailMessages[0].attempts).toBe(0); expect(db.rows.emailMessages[0].firstAttemptAt).toBeNull();
  });
  it("preserves earlier uncertainty through a quota pause", async () => {
    const id = await queue(); const row = db.rows.emailMessages[0]; const first = new Date(Date.now() - 100_000); row.ambiguous = true; row.firstAttemptAt = first;
    result = { kind: "paused", code: "daily_quota_exceeded", retryAt: new Date(Date.now() + 3600_000) }; await deliverEmailNow(id);
    expect(row.firstAttemptAt).toEqual(first); expect(row.ambiguous).toBe(true);
  });
  it("rechecks opt-out before optional delivery", async () => {
    const id = await queue("weekly"); db.rows.users[0].emailPreferences = { weeklyRecommendations: false };
    expect((await deliverEmailNow(id)).status).toBe("skipped"); expect(sends).toHaveLength(0);
  });
  it("preserves mandatory old-address destinations", async () => {
    const id = await queue("email_changed"); db.rows.users[0].email = "new@example.test";
    expect((await deliverEmailNow(id)).status).toBe("sent"); expect(sends[0].to).toBe("recipient@example.test");
  });
  it("never retargets an optional message after an address change", async () => {
    const id = await queue("weekly"); db.rows.users[0].email = "new@example.test";
    expect((await deliverEmailNow(id)).status).toBe("skipped"); expect(sends).toHaveLength(0);
  });
  it("expires unsent messages without sending", async () => {
    const id = await queue(); db.rows.emailMessages[0].expiresAt = new Date(0);
    expect((await deliverEmailNow(id)).status).toBe("skipped"); expect(sends).toHaveLength(0);
  });
  it("quarantines uncertain sends before idempotency expires", async () => {
    const id = await queue(); const row = db.rows.emailMessages[0]; row.ambiguous = true; row.firstAttemptAt = new Date(Date.now() - 23 * 3600_000);
    expect((await deliverEmailNow(id)).status).toBe("needs_review"); expect(sends).toHaveLength(0);
    expect(emailRetryLimit(6, new Date(), false)).toBe("failed"); expect(emailRetryLimit(6, new Date(), true)).toBe("needs_review");
  });
  it("uses the same bounded worker across categories", async () => {
    await queue("password_changed"); await queue("feedback_ack"); expect((await processEmailMessages()).processed).toBe(2);
    expect(db.rows.emailMessages.map(row => row.status)).toEqual(["sent", "sent"]); expect(sends).toHaveLength(2);
  });
  it("rotates a throttled campaign and increments progress only for fenced terminal results", async () => {
    const first = generateId(); const second = generateId();
    db.rows.emailCampaigns.push(...[first, second].map(id => ({ id, nextDispatchAt: new Date(0), pendingCount: 2,
      sent: 0, skipped: 0, failed: 0, needsReview: 0 })));
    for (const campaignId of [first, second]) for (let i = 0; i < 2; i++) {
      await queue("weekly"); db.rows.emailMessages.at(-1).campaignId = campaignId;
    }
    maxPermits = 1; await processEmailMessages(); permits = 0; await processEmailMessages();
    expect(db.rows.emailCampaigns.map(row => row.sent)).toEqual([1, 1]);
    expect(db.rows.emailCampaigns.map(row => row.pendingCount)).toEqual([1, 1]);
  });
  it("redirects billing mail to the live account address after an email change", async () => {
    const id = await queue("payment_failed"); db.rows.users[0].email = "new@example.test";
    expect((await deliverEmailNow(id)).status).toBe("sent"); expect(sends[0].to).toBe("new@example.test");
  });
  it("schedules the worker continuation no earlier than a denied admission retry", async () => {
    await queue(); await queue();
    allowed = false;
    await processEmailMessages();
    expect(wakeups).toHaveLength(1); expect(wakeups[0].getTime()).toBeGreaterThan(Date.now());
  });
});
