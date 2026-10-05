/**
 * Book access gate tests — the authoritative snapshot behind reader and
 * detail authorization (P0/P1 of the access-moderation audit).
 *
 * Covers the three claims the audit made:
 * 1. `getBookAccessSnapshot()` reads the **primary** write connection, never
 *    the replica — a just-committed moderation must be visible immediately.
 * 2. The detail surface (`GET /api/books/:identifier`) enforces the
 *    owner/archived policy with **404** for non-owners, including the admin
 *    bypass the web moderation panel depends on.
 * 3. A stale enriched-LRU projection cannot widen page access: the page gate
 *    is fed by the snapshot, not by `getEnrichedBook()`.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/hono/env.js";
import { cNotFoundError } from "../src/utils/error.js";
import { createFakeDb } from "./helpers/store-verification-db.js";

// Two independent stores so "replica lag" is observable: dbRead (replica) can
// hold a stale public row while dbWrite (primary) already says private.
const primaryDb = createFakeDb();
const replicaDb = createFakeDb();

const actualDbClient = await import("../src/db/client.js");
mock.module("../src/db/client.js", () => ({
  ...actualDbClient,
  dbRead: replicaDb.dbRead,
  dbWrite: primaryDb.dbWrite,
}));

const { getBookAccessSnapshot, getBookDetailAccessError, isRestrictedToOwner } =
  await import("../src/services/book-page-access.js");

// --- Page-gate fixtures: a stale enriched projection vs. a moderated row ---
const stalePage = {
  id: "page-stale",
  page: 1,
  bookId: "stale-1",
  parentId: null,
  branchId: "main",
  visitCount: 0,
};

// The enriched LRU still serves the book as public+active (5-minute TTL,
// process-local, possibly a different instance than the one that moderated).
const staleEnriched = {
  id: "stale-1",
  userId: "author-1",
  status: "active",
  visibility: "public",
  totalPages: 1,
  stats: { readCount: 0 },
  title: "Moderated to private",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const markPageVisited = mock(async () => ({
  nthVisit: 1,
  visitorPercentage: 100,
  readerUserId: "reader-2",
}));

const actualBookService = await import("../src/services/book.js");
mock.module("../src/services/book.js", () => ({
  ...actualBookService,
  // Echoes the requested identifier so route-level tests can resolve their
  // own seed ids while every caller still observes the same stale
  // public+active projection (both in-file callers pass a book identifier).
  getEnrichedBook: mock(async (identifier: string) => ({
    ...staleEnriched,
    id: identifier,
  })),
  getPageFromDB: mock(async () => stalePage),
  getPageActionsFromDB: mock(async () => []),
}));
const actualStoryService = await import("../src/services/story.js");
mock.module("../src/services/story.js", () => ({
  ...actualStoryService,
  computeVisitStats: () => ({ nthVisit: 1, visitorPercentage: 100 }),
  mapActionToSelectedAction: () => ({}),
  markPageVisited,
}));

const { visitBookPage } = await import("../src/services/book-controller.js");

// The real router, mounted behind a thin auth-injecting middleware. Its
// `optionalAuth` is a pass-through (the production global auth middleware
// populates `userId`), so setting the var here is exactly how an authenticated
// request reaches the handler. Registration happens after every `mock.module`
// above, so the router resolves all of them.
const { default: booksRouter } = await import("../src/routes/books.js");
let routeUserId: string | undefined;
const booksApp = new Hono<AppEnv>();
booksApp.use("*", async (c, next) => {
  if (routeUserId !== undefined) c.set("userId", routeUserId);
  await next();
});
booksApp.route("/", booksRouter);

async function routeRequest(path: string, userId?: string) {
  routeUserId = userId;
  try {
    return await booksApp.request(path, { headers: { accept: "application/json" } });
  } finally {
    routeUserId = undefined;
  }
}

const OWNER = "author-1";
const OTHER = "reader-2";

type Seed = {
  id: string;
  userId?: string;
  slug?: string;
  status?: string;
  visibility?: string;
};

function seedBook(store: typeof primaryDb, seed: Seed): Seed {
  const row = {
    id: seed.id,
    userId: seed.userId ?? OWNER,
    slug: seed.slug ?? null,
    title: "Seeded book",
    status: seed.status ?? "active",
    visibility: seed.visibility ?? "public",
  };
  store.rows.books.push(row);
  return row;
}

async function detailAccess(bookId: string, userId?: string) {
  const app = new Hono();
  app.get("/:id", async (c) => {
    // The route resolves the authoritative snapshot itself and hands it to the
    // gate (mirrors GET /api/books/:identifier and visitBookPage).
    const snapshot = await getBookAccessSnapshot(bookId);
    if (!snapshot) return cNotFoundError(c, "Book not found");
    const denied = await getBookDetailAccessError(c, snapshot, userId);
    return denied ?? c.json({ allowed: true });
  });
  const response = await app.request(`/${bookId}`);
  return { status: response.status, body: await response.json() };
}

describe("isRestrictedToOwner (policy SSOT)", () => {
  it("restricts private books regardless of status", () => {
    expect(isRestrictedToOwner({ userId: OWNER, status: "active", visibility: "private" })).toBe(true);
    expect(isRestrictedToOwner({ userId: OWNER, status: "draft", visibility: "private" })).toBe(true);
  });

  it("restricts archived books regardless of visibility", () => {
    expect(isRestrictedToOwner({ userId: OWNER, status: "archived", visibility: "public" })).toBe(true);
    expect(isRestrictedToOwner({ userId: OWNER, status: "archived", visibility: "unlisted" })).toBe(true);
  });

  it("leaves active public/unlisted/followers books open (direct-link behaviour)", () => {
    for (const visibility of ["public", "unlisted", "followers"] as const) {
      expect(isRestrictedToOwner({ userId: OWNER, status: "active", visibility })).toBe(false);
    }
  });

  it("does not restrict drafts (reachable only by UUID until first publish)", () => {
    expect(isRestrictedToOwner({ userId: OWNER, status: "draft", visibility: "public" })).toBe(false);
  });
});

describe("getBookAccessSnapshot (authoritative primary read)", () => {
  it("returns owner/status/visibility for an existing row", async () => {
    seedBook(primaryDb, { id: "snap-1", status: "active", visibility: "private" });
    await expect(getBookAccessSnapshot("snap-1")).resolves.toEqual({
      userId: OWNER,
      status: "active",
      visibility: "private",
    });
  });

  it("returns null when the row no longer exists", async () => {
    await expect(getBookAccessSnapshot("snap-missing")).resolves.toBeNull();
  });

  it("reads the primary, not the replica — replica lag cannot widen access", async () => {
    // Replica still says public+active (stale); primary already says private.
    seedBook(replicaDb, { id: "snap-lag", status: "active", visibility: "public" });
    seedBook(primaryDb, { id: "snap-lag", status: "active", visibility: "private" });

    await expect(getBookAccessSnapshot("snap-lag")).resolves.toEqual({
      userId: OWNER,
      status: "active",
      visibility: "private",
    });
  });
});

describe("getBookDetailAccessError (GET /api/books/:identifier — 404 contract)", () => {
  it("allows active public books for anyone", async () => {
    seedBook(primaryDb, { id: "pub-1", status: "active", visibility: "public" });
    expect(await detailAccess("pub-1")).toEqual({ status: 200, body: { allowed: true } });
    expect(await detailAccess("pub-1", OTHER)).toEqual({ status: 200, body: { allowed: true } });
  });

  it("preserves direct links for unlisted and follower books", async () => {
    for (const [index, visibility] of ["unlisted", "followers"].entries()) {
      seedBook(primaryDb, { id: `link-${index}`, status: "active", visibility });
      expect(await detailAccess(`link-${index}`)).toEqual({ status: 200, body: { allowed: true } });
    }
  });

  it("returns 404 (not 401/403) for a private book, for anonymous and signed-in non-owners alike", async () => {
    seedBook(primaryDb, { id: "priv-1", status: "active", visibility: "private" });
    const expected = { status: 404, body: { success: false, error: "Book not found" } };
    expect(await detailAccess("priv-1")).toEqual(expected);
    expect(await detailAccess("priv-1", OTHER)).toEqual(expected);
  });

  it("allows the owner of a private book (editor SSR bootstrap, generation tracker)", async () => {
    seedBook(primaryDb, { id: "priv-2", status: "active", visibility: "private" });
    expect(await detailAccess("priv-2", OWNER)).toEqual({ status: 200, body: { allowed: true } });
  });

  it("returns 404 for non-owners of archived books", async () => {
    seedBook(primaryDb, { id: "arch-1", status: "archived", visibility: "public" });
    expect(await detailAccess("arch-1")).toEqual({ status: 404, body: { success: false, error: "Book not found" } });
    expect(await detailAccess("arch-1", OWNER)).toEqual({ status: 200, body: { allowed: true } });
  });

  it("returns 404 for unknown identifiers without touching authorization", async () => {
    expect(await detailAccess("does-not-exist")).toEqual({
      status: 404,
      body: { success: false, error: "Book not found" },
    });
  });

  it("bypasses the restriction for an admin holding the `books` permission (web moderation panel)", async () => {
    seedBook(primaryDb, { id: "priv-3", status: "active", visibility: "private" });
    primaryDb.rows.adminUsers.push({ userId: "admin-books", permissions: ["books"] });

    expect(await detailAccess("priv-3", "admin-books")).toEqual({ status: 200, body: { allowed: true } });
  });

  it("does NOT bypass for an admin without `books`, nor for a plain user", async () => {
    seedBook(primaryDb, { id: "priv-4", status: "active", visibility: "private" });
    primaryDb.rows.adminUsers.push({ userId: "admin-blog", permissions: ["blog"] });

    expect(await detailAccess("priv-4", "admin-blog")).toEqual({
      status: 404,
      body: { success: false, error: "Book not found" },
    });
    expect(await detailAccess("priv-4", "no-admin")).toEqual({
      status: 404,
      body: { success: false, error: "Book not found" },
    });
  });

  it("lets an admin moderate an archived book too", async () => {
    seedBook(primaryDb, { id: "arch-2", status: "archived", visibility: "private" });
    expect(await detailAccess("arch-2", "admin-books")).toEqual({ status: 200, body: { allowed: true } });
  });
});

describe("stale enriched projection cannot widen page access (P0 regression)", () => {
  it("denies the visit when the primary row says private, even though the cache says public", async () => {
    // Primary: moderated to private. Replica/caches may still say public.
    seedBook(primaryDb, { id: "stale-1", status: "active", visibility: "private" });

    markPageVisited.mockClear();

    const app = new Hono();
    app.get("/", async (c) => {
      const result = await visitBookPage(
        {
          userId: OTHER,
          pageId: stalePage.id,
          bookIdentifier: stalePage.bookId,
          skipVisit: false,
          takeAction: true,
          consumeCredits: true,
        },
        { c },
      );
      return result.errorResponse ?? c.json({ visited: true });
    });

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "You do not have access to this book",
    });
    expect(markPageVisited).not.toHaveBeenCalled();
  });
});

describe("GET /:identifier — snapshot-keyed cache header & body (audit §1.2 regression)", () => {
  it("owner of a freshly-moderated book gets no-store + the authoritative private visibility", async () => {
    // Enriched LRU still says public+active (stale); the primary says private.
    seedBook(primaryDb, { id: "hdr-1", status: "active", visibility: "private" });

    const response = await routeRequest("/hdr-1", OWNER);

    expect(response.status).toBe(200);
    // Pre-fix the header was derived from the LRU projection →
    // "private, max-age=300" with a stale public body. Both must come from
    // the snapshot now.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as { book: { status: string; visibility: string } };
    expect(body.book.visibility).toBe("private");
    expect(body.book.status).toBe("active");
  });

  it("anonymous visitor of the same moderated book gets 404 + no-store", async () => {
    const response = await routeRequest("/hdr-1");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("an active public book keeps the 300s private-cache tier", async () => {
    seedBook(primaryDb, { id: "hdr-2", status: "active", visibility: "public" });

    const response = await routeRequest("/hdr-2", OTHER);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=300, stale-while-revalidate=150",
    );
  });
});

afterAll(() => {
  // `mock.module` leaks forward across test files in the same process and
  // `mock.restore()` does not revert it — put the real modules back for
  // whatever runs next (pattern: auth-signup-pair.test.ts).
  mock.module("../src/db/client.js", () => actualDbClient);
  mock.module("../src/services/book.js", () => actualBookService);
  mock.module("../src/services/story.js", () => actualStoryService);
});


it('revoked primary admin membership cannot be restored by replica lag', async () => {
  seedBook(primaryDb, { id: 'admin-revocation-lag', status: 'archived', visibility: 'private' });
  replicaDb.rows.adminUsers.push({ userId: 'revoked-admin', permissions: ['books'] });
  expect((await detailAccess('admin-revocation-lag', 'revoked-admin')).status).toBe(404);
});
