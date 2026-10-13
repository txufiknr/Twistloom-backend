import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";
import { generateId } from "../src/utils/uuid.js";
const actualDb = { ...await import("../src/db/client.js") }; const actualDispatch = { ...await import("../src/services/email-dispatch.js") };
const db = createFakeDb();
mock.module("../src/db/client.js", () => ({ ...actualDb, dbRead: db.dbRead, dbWrite: db.dbWrite }));
mock.module("../src/services/email-dispatch.js", () => ({ ...actualDispatch, dispatchEmailWorkers: async () => true }));
const { queueAnnouncementEmail } = await import("../src/services/announcement-email.js");
const { createAnnouncement, deleteAnnouncement } = await import("../src/services/announcements.js");
const keys = ["EMAIL_DELIVERY_ENABLED", "RESEND_API_KEY", "CRON_SECRET", "QSTASH_TOKEN", "BACKEND_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const saved = new Map(keys.map(key => [key, process.env[key]])); const admin = generateId();
beforeEach(() => { for (const key of keys) process.env[key] = "test-only"; process.env.EMAIL_DELIVERY_ENABLED = "true"; process.env.BACKEND_URL = "https://backend.example.test"; db.reset({ users: [{ userId: admin }] }); });
afterAll(() => { mock.module("../src/db/client.js", () => actualDb); mock.module("../src/services/email-dispatch.js", () => actualDispatch); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
it("gates unprovisioned work", async () => { process.env.EMAIL_DELIVERY_ENABLED = "false"; await expect(queueAnnouncementEmail({ title: "Audit", bodyHtml: "<p>Body</p>" }, admin)).rejects.toThrow("not configured"); expect(db.rows.emailCampaigns).toHaveLength(0); });
it("preserves idempotent announcement jobs on shared storage", async () => {
  const record = await createAnnouncement({ title: "Audit", body: "Body", kind: "feature", severity: "info" }, admin);
  const first = await queueAnnouncementEmail({ announcementId: record.id }, admin); expect(await queueAnnouncementEmail({ announcementId: record.id }, admin)).toEqual(first);
  expect(db.rows.emailCampaigns).toHaveLength(1); expect(db.rows.emailCampaigns[0].type).toBe("announcement");
  await expect(queueAnnouncementEmail({ announcementId: record.id, force: true, requestId: generateId() }, admin)).rejects.toThrow("in progress");
  await deleteAnnouncement(record.id); expect(db.rows.emailCampaigns[0].announcementId).toBeNull();
});
it("rejects changing content under the same manual request key", async () => {
  const requestId = generateId(); await queueAnnouncementEmail({ title: "Audit", bodyHtml: "<p>One</p>", requestId }, admin);
  await expect(queueAnnouncementEmail({ title: "Audit", bodyHtml: "<p>Two</p>", requestId }, admin)).rejects.toThrow("different content");
});
