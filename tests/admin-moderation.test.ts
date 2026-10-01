/**
 * Admin moderation tests (P0 of the access-moderation audit).
 *
 * Verifies the invariants the audit called out for `routes/admin.ts`:
 * 1. `PATCH /admin/books/:id` is not a parallel mutation path — the write goes
 *    through `updateBook()` (SSOT) and refreshes the shared caches
 *    (`user:books`, `books:explore:page:1:*`) plus the forum feed.
 * 2. Enum bodies are structurally validated (400, no `as`-cast coercion).
 * 3. `GET /admin/users/:userId/transactions` 404s for an unknown account —
 *    the Drizzle row-array truthiness bug.
 * 4. Ban takedowns (`ban.hide_books`) invalidate every affected book and
 *    re-read the policy fail-loud (`getBanPolicy`).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { parseJsonBody } from "../src/middleware/body.js";
import type { AppEnv } from "../src/hono/env.js";
import { createFakeDb } from "./helpers/store-verification-db.js";

const fakeDb = createFakeDb();

const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDbClient,
  dbRead: fakeDb.dbRead,
  dbWrite: fakeDb.dbWrite,
}));

// SSOT write: applies the patch to the in-memory row the way `updateBook`
// would. The store entry is REPLACED (never mutated) because a real UPDATE
// returns a fresh tuple — mutating in place would silently rewrite the
// `before` snapshot the route captured for cache invalidation.
const updateBookMock = mock(async (bookId: string, updates: Record<string, unknown>) => {
  const index = fakeDb.rows.books.findIndex((book) => book.id === bookId);
  if (index === -1) throw new Error(`updateBook: no book ${bookId}`);
  const updated = { ...fakeDb.rows.books[index], ...updates, updatedAt: new Date() };
  fakeDb.rows.books[index] = updated;
  return { ...updated };
});
const invalidateBookCacheMock = mock((_bookId: string) => {});
const invalidateEnrichedBookCacheMock = mock((_key: string) => {});
const actualBookService = await import("../src/services/book.js");
mock.module("../src/services/book.js", () => ({
  ...actualBookService,
  updateBook: updateBookMock,
  invalidateBookCache: invalidateBookCacheMock,
  invalidateEnrichedBookCache: invalidateEnrichedBookCacheMock,
}));

const invalidateUserBooksCacheMock = mock(async (_userId: string) => 1);
const invalidateExploreCacheMock = mock(async (_options?: unknown) => true);
const invalidateUserProfileCacheMock = mock(async (_userId: string) => true);
const actualCacheService = await import("../src/services/cache.js");
mock.module("../src/services/cache.js", () => ({
  ...actualCacheService,
  invalidateUserBooksCache: invalidateUserBooksCacheMock,
  invalidateExploreCache: invalidateExploreCacheMock,
  invalidateUserProfileCache: invalidateUserProfileCacheMock,
}));

const notifyForumOfBookChangeMock = mock((_payload: unknown) => {});
const notifyForumUserBannedMock = mock((_userId: string, _reason?: string) => {});
const notifyForumUserUnbannedMock = mock((_userId: string) => {});
const notifyForumStoryArchivedMock = mock((_storyId: string, _slug?: string | null) => {});
const actualForumQueue = await import("../src/services/forum-queue.js");
mock.module("../src/services/forum-queue.js", () => ({
  ...actualForumQueue,
  notifyForumOfBookChange: notifyForumOfBookChangeMock,
  notifyForumUserBanned: notifyForumUserBannedMock,
  notifyForumUserUnbanned: notifyForumUserUnbannedMock,
  notifyForumStoryArchived: notifyForumStoryArchivedMock,
}));

const applyEnforcementActionMock = mock(async (_input: unknown) => ({
  id: "enforcement-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
}));
const actualTrustSafety = await import("../src/services/trust-safety.js");
mock.module("../src/services/trust-safety.js", () => ({
  ...actualTrustSafety,
  applyEnforcementAction: applyEnforcementActionMock,
}));

const adminRouter = (await import("../src/routes/admin.js")).default;

/** Session identity for the request under test (`undefined` = anonymous). */
let sessionUserId: string | undefined = "admin-with-books";

const app = new Hono<AppEnv>();
app.use("*", parseJsonBody);
app.use("*", async (c, next) => {
  if (sessionUserId !== undefined) c.set("userId", sessionUserId);
  await next();
});
app.route("/admin", adminRouter);

function request(path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seedBook(row: Record<string, unknown>) {
  fakeDb.rows.books.push(row);
}

beforeEach(() => {
  fakeDb.reset();
  sessionUserId = "admin-with-books";
  fakeDb.rows.adminUsers.push(
    { userId: "admin-with-books", permissions: ["books", "users"] },
    { userId: "admin-blog-only", permissions: ["blog"] },
    { userId: "plain-user", permissions: [] },
  );
  updateBookMock.mockClear();
  invalidateBookCacheMock.mockClear();
  invalidateEnrichedBookCacheMock.mockClear();
  invalidateUserBooksCacheMock.mockClear();
  invalidateExploreCacheMock.mockClear();
  invalidateUserProfileCacheMock.mockClear();
  notifyForumOfBookChangeMock.mockClear();
  notifyForumUserBannedMock.mockClear();
  notifyForumUserUnbannedMock.mockClear();
  notifyForumStoryArchivedMock.mockClear();
  applyEnforcementActionMock.mockClear();
});

describe("PATCH /admin/books/:id (moderation through the SSOT)", () => {
  beforeEach(() => {
    seedBook({
      id: "book-1",
      userId: "author-1",
      slug: "story-one",
      title: "Story One",
      status: "active",
      visibility: "public",
    });
  });

  it("writes through updateBook and refreshes every shared cache layer", async () => {
    const response = await request("/admin/books/book-1", "PATCH", { status: "archived" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "book-1",
      slug: "story-one",
      status: "archived",
      visibility: "public",
    });

    // SSOT: no hand-rolled `dbWrite.update` on the moderation path.
    expect(updateBookMock).toHaveBeenCalledTimes(1);
    expect(updateBookMock).toHaveBeenCalledWith("book-1", { status: "archived" });

    // Author list (Redis) — the reader must stop seeing the book immediately.
    expect(invalidateUserBooksCacheMock).toHaveBeenCalledWith("author-1");

    // Explore page-1 (Redis, global) — before/after must describe the transition.
    expect(invalidateExploreCacheMock).toHaveBeenCalledTimes(1);
    const exploreArgs = invalidateExploreCacheMock.mock.calls[0]?.[0] as {
      before: { id: string; status: string };
      after: { id: string; status: string };
    };
    expect(exploreArgs.before).toMatchObject({ id: "book-1", status: "active" });
    expect(exploreArgs.after).toMatchObject({ id: "book-1", status: "archived" });

    // Forum feed sees the moderation.
    expect(notifyForumOfBookChangeMock).toHaveBeenCalledTimes(1);
    expect(fakeDb.rows.books[0]?.status).toBe("archived");
  });

  it("accepts a slug identifier but always updates by primary key", async () => {
    const response = await request("/admin/books/story-one", "PATCH", { visibility: "private" });

    expect(response.status).toBe(200);
    expect(updateBookMock).toHaveBeenCalledWith("book-1", { visibility: "private" });
    expect(await response.json()).toMatchObject({ id: "book-1", visibility: "private" });
  });

  it("applies both fields when both are provided", async () => {
    const response = await request("/admin/books/book-1", "PATCH", {
      status: "active",
      visibility: "unlisted",
    });

    expect(response.status).toBe(200);
    expect(updateBookMock).toHaveBeenCalledWith("book-1", { status: "active", visibility: "unlisted" });
    expect(fakeDb.rows.books[0]).toMatchObject({ status: "active", visibility: "unlisted" });
  });

  it("rejects an unknown status enum with 400 and performs no write", async () => {
    const response = await request("/admin/books/book-1", "PATCH", { status: "bogus" });

    expect(response.status).toBe(400);
    expect(updateBookMock).not.toHaveBeenCalled();
    expect(fakeDb.rows.books[0]?.status).toBe("active");
  });

  it("rejects an unknown visibility enum with 400", async () => {
    const response = await request("/admin/books/book-1", "PATCH", { visibility: "secret" });

    expect(response.status).toBe(400);
    expect(updateBookMock).not.toHaveBeenCalled();
  });

  it("rejects an empty patch with 400", async () => {
    const response = await request("/admin/books/book-1", "PATCH", {});

    expect(response.status).toBe(400);
    expect(updateBookMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown identifier", async () => {
    const response = await request("/admin/books/no-such-book", "PATCH", { status: "archived" });

    expect(response.status).toBe(404);
    expect(updateBookMock).not.toHaveBeenCalled();
  });

  it("requires a session (401) and admin membership (403)", async () => {
    sessionUserId = undefined;
    const anonymous = await request("/admin/books/book-1", "PATCH", { status: "archived" });
    expect(anonymous.status).toBe(401);

    sessionUserId = "plain-user";
    const nonAdmin = await request("/admin/books/book-1", "PATCH", { status: "archived" });
    expect(nonAdmin.status).toBe(403);

    sessionUserId = "admin-blog-only";
    const wrongPermission = await request("/admin/books/book-1", "PATCH", { status: "archived" });
    expect(wrongPermission.status).toBe(403);

    expect(updateBookMock).not.toHaveBeenCalled();
  });
});

describe("GET /admin/users/:userId/transactions", () => {
  it("404s for an unknown account instead of returning an empty ledger", async () => {
    const response = await request("/admin/users/no-such-user/transactions");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "User not found" });
  });

  it("returns an empty ledger for a known account with no transactions", async () => {
    fakeDb.rows.users.push({ userId: "user-without-history" });

    const response = await request("/admin/users/user-without-history/transactions");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total: 0,
      limit: 20,
      offset: 0,
      transactions: [],
    });
  });
});

describe("PATCH /admin/users/:userId/ban (content takedown + invalidation)", () => {
  beforeEach(() => {
    fakeDb.rows.users.push({ userId: "bad-actor", bannedAt: null });
    seedBook({
      id: "b-public",
      userId: "bad-actor",
      slug: "public-book",
      status: "active",
      visibility: "public",
    });
    seedBook({
      id: "b-unlisted",
      userId: "bad-actor",
      slug: "unlisted-book",
      status: "archived",
      visibility: "unlisted",
    });
    seedBook({
      id: "b-private",
      userId: "bad-actor",
      slug: "private-book",
      status: "active",
      visibility: "private",
    });
  });

  it("hides non-private books and invalidates each affected book + author caches", async () => {
    fakeDb.rows.adminSettings.push({ key: "ban.hide_books", value: true });

    const response = await request("/admin/users/bad-actor/ban", "PATCH", { reason: "spam" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.appliedTakedowns).toContain("hide_books");
    expect(body.settingsUnresolved).toBeUndefined();

    expect(fakeDb.rows.books.find((book) => book.id === "b-public")?.visibility).toBe("private");
    expect(fakeDb.rows.books.find((book) => book.id === "b-unlisted")?.visibility).toBe("private");
    // Already private — never selected, never invalidated.
    expect(fakeDb.rows.books.find((book) => book.id === "b-private")?.visibility).toBe("private");

    for (const bookId of ["b-public", "b-unlisted"]) {
      expect(invalidateBookCacheMock).toHaveBeenCalledWith(bookId);
      expect(invalidateEnrichedBookCacheMock).toHaveBeenCalledWith(bookId);
    }
    // Slug-keyed LRU variants too (the enriched cache is keyed by id AND slug).
    expect(invalidateEnrichedBookCacheMock).toHaveBeenCalledWith("public-book");
    expect(invalidateEnrichedBookCacheMock).toHaveBeenCalledWith("unlisted-book");
    // ONE Explore pattern wipe for the whole batch — the old per-book loop
    // ran a sequential Redis SCAN per affected book (audit §4.1).
    expect(invalidateExploreCacheMock).toHaveBeenCalledTimes(1);
    expect(invalidateUserBooksCacheMock).toHaveBeenCalledWith("bad-actor");

    // Forum threads of hidden books leave the portal feed with them —
    // archive dispatched for each affected (non-private) book, never for the
    // already-private one (audit §5.2).
    expect(notifyForumStoryArchivedMock).toHaveBeenCalledTimes(2);
    expect(notifyForumStoryArchivedMock).toHaveBeenCalledWith("b-public", "public-book");
    expect(notifyForumStoryArchivedMock).toHaveBeenCalledWith("b-unlisted", "unlisted-book");

    expect(applyEnforcementActionMock).toHaveBeenCalledTimes(1);
    expect(notifyForumUserBannedMock).toHaveBeenCalledWith("bad-actor", "admin_ban");
    expect(invalidateUserProfileCacheMock).toHaveBeenCalledWith("bad-actor");
  });

  it("leaves books untouched when hide_books is not configured", async () => {
    const response = await request("/admin/users/bad-actor/ban", "PATCH", { reason: "spam" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.appliedTakedowns).not.toContain("hide_books");
    expect(fakeDb.rows.books.find((book) => book.id === "b-public")?.visibility).toBe("public");
    expect(invalidateBookCacheMock).not.toHaveBeenCalled();
    expect(invalidateExploreCacheMock).not.toHaveBeenCalled();
    expect(invalidateUserBooksCacheMock).not.toHaveBeenCalled();
    expect(notifyForumStoryArchivedMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed violation type with 400 before any enforcement write", async () => {
    const response = await request("/admin/users/bad-actor/ban", "PATCH", {
      violationType: "not-a-violation",
    });

    expect(response.status).toBe(400);
    expect(applyEnforcementActionMock).not.toHaveBeenCalled();
    expect(fakeDb.rows.users.find((user) => user.userId === "bad-actor")?.bannedAt).toBeNull();
  });

  it("404s when the account does not exist", async () => {
    const response = await request("/admin/users/ghost-user/ban", "PATCH", { reason: "spam" });

    expect(response.status).toBe(404);
    expect(applyEnforcementActionMock).not.toHaveBeenCalled();
  });
});

// `mock.module` is process-global and `mock.restore()` does not revert module
// mocks — re-register the real namespaces so later test files never see these
// fakes (see the mock-restore rule in tests/helpers/store-verification-db.ts).
afterAll(() => {
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/services/book.js", () => actualBookService);
  mock.module("../src/services/cache.js", () => actualCacheService);
  mock.module("../src/services/forum-queue.js", () => actualForumQueue);
  mock.module("../src/services/trust-safety.js", () => actualTrustSafety);
});
