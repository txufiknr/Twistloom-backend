/**
 * Announcements Subsystem Unit Tests
 *
 * Verifies:
 * 1. Authoring & Draft Lifecycle (create, edit, delete, draft-only deletion invariant)
 * 2. Cap-1 Invariant Enforcement (race-proof singleton semantics & error mapping)
 * 3. Broadcast Overlap Safety (releaseUserBroadcasts respects live active broadcasts)
 * 4. User Read Model & Guest Support (authenticated unseen calculation vs. guest unseen=false)
 * 5. Seen-State Validation (rejects malformed UUIDs and nonexistent announcement IDs)
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createFakeDb } from "./helpers/store-verification-db.js";
import { generateId } from "../src/utils/uuid.js";

const fakeDb = createFakeDb();

const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDbClient,
  dbRead: fakeDb.dbRead,
  dbWrite: fakeDb.dbWrite,
}));

// Mock redis to avoid requiring a running Redis instance in unit tests
const actualRedis = await import("../src/utils/redis.js");
const fakeRedisStore = new Map<string, string>();
mock.module("../src/utils/redis.js", () => ({
  ...actualRedis,
  getRedisClient: () => ({
    get: async (key: string) => fakeRedisStore.get(key) ?? null,
    set: async (key: string, val: string) => {
      fakeRedisStore.set(key, val);
      return "OK";
    },
    del: async (key: string) => {
      fakeRedisStore.delete(key);
      return 1;
    },
  }),
}));

const {
  AnnouncementError,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  publishAnnouncement,
  endAnnouncement,
  getUserAnnouncementState,
  getAnnouncementUnseenCount,
  markAnnouncementSeen,
} = await import("../src/services/announcements.js");

const ADMIN_ID = generateId();
const USER_ID = generateId();

afterAll(() => {
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/utils/redis.js", () => actualRedis);
});

beforeEach(() => {
  fakeRedisStore.clear();
  fakeDb.reset({
    users: [
      {
        userId: USER_ID,
        email: "reader@example.com",
        credits: 100,
        lastSeenAnnouncementId: null,
      },
      {
        userId: ADMIN_ID,
        email: "admin@example.com",
        credits: 100,
        lastSeenAnnouncementId: null,
      },
    ],
    announcements: [],
    broadcasts: [],
  });
});

describe("Announcements Subsystem", () => {
  describe("Draft Lifecycle & Deletion", () => {
    it("creates a draft announcement without affecting cap-1 live slot", async () => {
      const draft = await createAnnouncement(
        {
          title: "Maintenance Notice",
          body: "Scheduled maintenance tomorrow.",
          kind: "maintenance",
          severity: "warning",
        },
        ADMIN_ID,
      );

      expect(draft).toBeDefined();
      expect(draft.id).toBeDefined();
      expect(draft.status).toBe("draft");
      expect(draft.title).toBe("Maintenance Notice");

      // Verify draft is not live
      const live = await getUserAnnouncementState(USER_ID);
      expect(live.announcement).toBeNull();
      expect(live.unseen).toBe(false);
    });

    it("allows updating an existing draft announcement", async () => {
      const draft = await createAnnouncement(
        {
          title: "Initial Draft",
          body: "Initial text.",
          kind: "feature",
          severity: "info",
        },
        ADMIN_ID,
      );

      const updated = await updateAnnouncement(draft.id, {
        title: "Updated Title",
        body: "Updated body text.",
      });

      expect(updated.title).toBe("Updated Title");
      expect(updated.body).toBe("Updated body text.");
    });

    it("allows deleting a draft announcement", async () => {
      const draft = await createAnnouncement(
        {
          title: "Draft to discard",
          body: "This should be deleted.",
          kind: "promo",
          severity: "info",
        },
        ADMIN_ID,
      );

      await deleteAnnouncement(draft.id);

      expect(fakeDb.rows.announcements.some((r) => r.id === draft.id)).toBe(false);
    });

    it("rejects deleting a published or ended announcement (locked invariant)", async () => {
      const draft = await createAnnouncement(
        {
          title: "Published Notice",
          body: "Live platform notice.",
          kind: "feature",
          severity: "info",
        },
        ADMIN_ID,
      );

      await publishAnnouncement(draft.id, {}, ADMIN_ID);

      await expect(deleteAnnouncement(draft.id)).rejects.toThrow(AnnouncementError);

      await endAnnouncement(draft.id);

      await expect(deleteAnnouncement(draft.id)).rejects.toThrow(AnnouncementError);
    });
  });

  describe("Cap-1 Invariant Enforcement", () => {
    it("enforces at most one active announcement platform-wide", async () => {
      const a1 = await createAnnouncement(
        {
          title: "Announcement 1",
          body: "First announcement.",
          kind: "feature",
          severity: "info",
        },
        ADMIN_ID,
      );

      const a2 = await createAnnouncement(
        {
          title: "Announcement 2",
          body: "Second announcement.",
          kind: "promo",
          severity: "warning",
        },
        ADMIN_ID,
      );

      // Publish first announcement -> should succeed
      await publishAnnouncement(a1.id, {}, ADMIN_ID);
      const row1 = fakeDb.rows.announcements.find((r) => r.id === a1.id);
      expect(row1?.status).toBe("active");

      // Attempting to publish second announcement while first is active must fail with anotherActiveExists
      try {
        await publishAnnouncement(a2.id, {}, ADMIN_ID);
        expect.unreachable("Should have thrown anotherActiveExists");
      } catch (err) {
        expect(err).toBeInstanceOf(AnnouncementError);
        expect((err as AnnouncementError).code).toBe("announcements.anotherActiveExists");
      }

      // End first announcement -> releases cap-1 slot
      await endAnnouncement(a1.id);
      expect(fakeDb.rows.announcements.find((r) => r.id === a1.id)?.status).toBe("ended");

      // Now publishing second announcement must succeed
      await publishAnnouncement(a2.id, {}, ADMIN_ID);
      expect(fakeDb.rows.announcements.find((r) => r.id === a2.id)?.status).toBe("active");
    });
  });

  describe("Broadcast Queue & Overlap Prevention", () => {
    it("reschedules queued user broadcasts after the live active broadcast when announcement ends early", async () => {
      const now = new Date();
      const liveBroadcastExpiry = new Date(now.getTime() + 60_000); // Live for 60s more
      const queuedBroadcastDuration = 10_000;

      // Seed an active live user broadcast
      fakeDb.rows.broadcasts.push({
        id: "b_live",
        userId: USER_ID,
        source: "user",
        type: "message",
        message: "Live user broadcast",
        status: "queued",
        startsAt: new Date(now.getTime() - 10_000),
        expiresAt: liveBroadcastExpiry,
      });

      // Seed a pending queued user broadcast parked in the future
      fakeDb.rows.broadcasts.push({
        id: "b_pending",
        userId: USER_ID,
        source: "user",
        type: "message",
        message: "Parked user broadcast",
        status: "queued",
        startsAt: new Date(now.getTime() + 3600_000), // Parked 1 hour later
        expiresAt: new Date(now.getTime() + 3600_000 + queuedBroadcastDuration),
      });

      // Create and publish an announcement, then end it
      const ann = await createAnnouncement(
        {
          title: "Maintenance",
          body: "Short notice.",
          kind: "maintenance",
          severity: "critical",
        },
        ADMIN_ID,
      );

      await publishAnnouncement(ann.id, {}, ADMIN_ID);
      await endAnnouncement(ann.id);

      // Inspect b_pending: its startsAt must NOT be now; it must be at or after liveBroadcastExpiry!
      const pendingRow = fakeDb.rows.broadcasts.find((b) => b.id === "b_pending");
      expect(pendingRow).toBeDefined();
      expect(pendingRow.startsAt.getTime()).toBeGreaterThanOrEqual(liveBroadcastExpiry.getTime());
      expect(pendingRow.expiresAt.getTime()).toBe(pendingRow.startsAt.getTime() + queuedBroadcastDuration);
    });
  });

  describe("User Read Model & Guest Support", () => {
    it("returns unseen=false for guests while authenticated user gets personalized unseen=true", async () => {
      const ann = await createAnnouncement(
        {
          title: "Public Release",
          body: "Welcome to Twistloom v2.",
          kind: "feature",
          severity: "info",
        },
        ADMIN_ID,
      );

      await publishAnnouncement(ann.id, {}, ADMIN_ID);

      // Guest read: passing undefined / null
      const guestState = await getUserAnnouncementState(null);
      expect(guestState.announcement).not.toBeNull();
      expect(guestState.announcement?.title).toBe("Public Release");
      expect(guestState.unseen).toBe(false);

      // Authenticated user read: passing USER_ID
      const authState = await getUserAnnouncementState(USER_ID);
      expect(authState.announcement).not.toBeNull();
      expect(authState.announcement?.title).toBe("Public Release");
      expect(authState.unseen).toBe(true);

      const unseenCount = await getAnnouncementUnseenCount(USER_ID);
      expect(unseenCount).toBe(1);
    });
  });

  describe("Seen-State Validation", () => {
    it("validates announcement existence before recording seen state", async () => {
      const ann = await createAnnouncement(
        {
          title: "Real Announcement",
          body: "Visible to readers.",
          kind: "feature",
          severity: "info",
        },
        ADMIN_ID,
      );

      await publishAnnouncement(ann.id, {}, ADMIN_ID);

      // 1. Valid existing ID
      await markAnnouncementSeen(USER_ID, ann.id);
      const user = fakeDb.rows.users.find((u) => u.userId === USER_ID);
      expect(user?.lastSeenAnnouncementId).toBe(ann.id);

      const afterSeen = await getUserAnnouncementState(USER_ID);
      expect(afterSeen.unseen).toBe(false);

      // 2. Invalid non-UUID string
      await expect(markAnnouncementSeen(USER_ID, "not-a-uuid")).rejects.toThrow(AnnouncementError);

      // 3. Valid UUID that does NOT exist in announcements table
      const nonExistentUuid = generateId();
      try {
        await markAnnouncementSeen(USER_ID, nonExistentUuid);
        expect.unreachable("Should have rejected non-existent announcement");
      } catch (err) {
        expect(err).toBeInstanceOf(AnnouncementError);
        expect((err as AnnouncementError).code).toBe("announcements.notFound");
      }
    });
  });
});
