import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";
import { generateId } from "../src/utils/uuid.js";
const actualDb = { ...await import("../src/db/client.js") };
const db = createFakeDb();
mock.module("../src/db/client.js", () => ({ ...actualDb, dbRead: db.dbRead, dbWrite: db.dbWrite }));
const { queueEmailCampaign, queueWeeklyEmailCampaign, queueMonthlyEmailCampaign } = await import("../src/services/email-campaigns.js");
const keys = ["EMAIL_DELIVERY_ENABLED", "RESEND_API_KEY", "CRON_SECRET", "QSTASH_TOKEN", "BACKEND_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "NODE_ENV"];
const saved = new Map(keys.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of keys) process.env[key] = "test-only";
  process.env.EMAIL_DELIVERY_ENABLED = "true"; process.env.NODE_ENV = "test";
  process.env.BACKEND_URL = "https://backend.example.test"; db.reset();
});
afterAll(() => {
  mock.module("../src/db/client.js", () => actualDb);
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
it("returns the first frozen campaign on event replay", async () => {
  const first = await queueEmailCampaign({ requestKey: "weekly/event", title: "First", audience: { kind: "weekly", books: [] } });
  const replay = await queueEmailCampaign({ requestKey: "weekly/event", title: "Changed", audience: { kind: "weekly", books: [{ title: "New", url: "https://example.test/new" }] } });
  expect(replay).toEqual(first); expect(replay.title).toBe("First");
  expect(db.rows.emailCampaigns).toHaveLength(1); expect(replay.pendingCount).toBe(0);
});
it("rejects request-key reuse across category and announcement identities", async () => {
  await queueEmailCampaign({ requestKey: "shared/event", title: "Weekly", audience: { kind: "weekly", books: [] } });
  await expect(queueEmailCampaign({ requestKey: "shared/event", title: "Announcement", audience: { kind: "announcement" } })).rejects.toThrow("another identity");
  const announcementId = generateId();
  await queueEmailCampaign({ requestKey: "announcement/event", title: "First", audience: { kind: "announcement" }, announcementId });
  await expect(queueEmailCampaign({ requestKey: "announcement/event", title: "Second", audience: { kind: "announcement" }, announcementId: generateId() })).rejects.toThrow("another identity");
  expect(db.rows.emailCampaigns).toHaveLength(2);
});
it("rolls campaign intent back with its domain mutation", async () => {
  await expect(db.dbWrite.transaction(async tx => {
    await queueEmailCampaign({ requestKey: "publication/rollback", title: "Story", audience: { kind: "story_published",
      authorId: generateId(), authorName: "Author", bookId: generateId(), bookSlug: "story", bookTitle: "Story" } }, tx);
    throw new Error("domain rollback");
  })).rejects.toThrow("domain rollback");
  expect(db.rows.emailCampaigns).toHaveLength(0);
});
it("shares insertion defaults while preserving an announcement source fingerprint", async () => {
  const contentHash = "a".repeat(64);
  const row = await queueEmailCampaign({ requestKey: "announcement/manual", audience: { kind: "announcement" }, title: "Manual", contentHash,
    templates: { en: { from: "sender@example.test", subject: "Manual", html: "<p>Frozen</p>" } } });
  expect(row.contentHash).toBe(contentHash); expect(row.type).toBe("announcement");
  expect(row.status).toBe("queued"); expect(row.sent).toBe(0); expect(row.audienceComplete).toBe(false);
  expect(row.templates.en?.html).toBe("<p>Frozen</p>");
});
it("deduplicates UTC digest periods through the common campaign helper", async () => {
  const monday = await queueWeeklyEmailCampaign(new Date("2026-10-12T00:00:00Z"));
  expect(await queueWeeklyEmailCampaign(new Date("2026-10-18T23:59:59Z"))).toBe(monday);
  const month = await queueMonthlyEmailCampaign(new Date("2026-10-01T00:00:00Z"));
  expect(await queueMonthlyEmailCampaign(new Date("2026-10-31T23:59:59Z"))).toBe(month);
  expect(db.rows.emailCampaigns.map(row => row.requestKey)).toEqual(["weekly/2026-10-12", "monthly/2026-09"]);
});
