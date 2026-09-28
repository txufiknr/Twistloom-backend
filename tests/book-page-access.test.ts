import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { EnrichedBookData } from "../src/types/book.js";
import { getBookPageAccessError } from "../src/services/book-page-access.js";

type AccessBook = Pick<EnrichedBookData, "userId" | "status" | "visibility">;

const deniedPage = {
  id: "page-private",
  page: 1,
  bookId: "book-private",
  parentId: null,
  branchId: "main",
  visitCount: 0,
};
let resolvedBook: AccessBook & {
  id: string;
  totalPages: number;
  stats: { readCount: number };
  title: string;
} = {
  id: "book-private",
  userId: "book-owner",
  status: "active",
  visibility: "private",
  totalPages: 1,
  stats: { readCount: 0 },
  title: "Private test book",
};

const markPageVisited = mock(async () => ({
  nthVisit: 1,
  visitorPercentage: 100,
  readerUserId: "other-user",
}));

const actualBookService = await import("../src/services/book.js");
mock.module("../src/services/book.js", () => ({
  ...actualBookService,
  getEnrichedBook: mock(async () => resolvedBook),
  getPageActionsFromDB: mock(async () => []),
  getPageFromDB: mock(async () => deniedPage),
}));
const actualStoryService = await import("../src/services/story.js");
mock.module("../src/services/story.js", () => ({
  ...actualStoryService,
  computeVisitStats: () => ({ nthVisit: 1, visitorPercentage: 100 }),
  mapActionToSelectedAction: () => ({}),
  markPageVisited,
}));

const { visitBookPage } = await import("../src/services/book-controller.js");

async function checkAccess(book: AccessBook, userId?: string) {
  const app = new Hono();
  app.get("/", (c) => {
    const error = getBookPageAccessError(c, book, userId);
    return error ?? c.json({ allowed: true });
  });
  const response = await app.request("/");
  return { status: response.status, body: await response.json() };
}

async function requestPageVisit(userId: string) {
  const app = new Hono();
  app.get("/", async (c) => {
    const result = await visitBookPage(
      {
        userId,
        pageId: deniedPage.id,
        bookIdentifier: deniedPage.bookId,
        skipVisit: false,
        takeAction: true,
        consumeCredits: true,
      },
      { c },
    );
    return result.errorResponse ?? c.json({ visited: true });
  });
  return app.request("/");
}

describe("book page access before visit side effects", () => {
  const ownerId = "book-owner";
  const privateBook: AccessBook = {
    userId: ownerId,
    status: "active",
    visibility: "private",
  };

  it("rejects anonymous private-book access with 401", async () => {
    expect(await checkAccess(privateBook)).toEqual({
      status: 401,
      body: {
        success: false,
        error: "Authentication required to view this book",
      },
    });
  });

  it("rejects non-owner private-book access with 403", async () => {
    expect(await checkAccess(privateBook, "other-user")).toEqual({
      status: 403,
      body: { success: false, error: "You do not have access to this book" },
    });
  });

  it("allows the private-book owner", async () => {
    expect(await checkAccess(privateBook, ownerId)).toEqual({
      status: 200,
      body: { allowed: true },
    });
  });

  it("rejects a non-owner of an archived public book", async () => {
    expect(
      await checkAccess(
        { ...privateBook, status: "archived", visibility: "public" },
        "other-user",
      ),
    ).toEqual({
      status: 403,
      body: { success: false, error: "You do not have access to this book" },
    });
  });

  it("allows anonymous access to active public books", async () => {
    expect(
      await checkAccess({ ...privateBook, visibility: "public" }),
    ).toEqual({ status: 200, body: { allowed: true } });
  });

  it("preserves direct-link access to unlisted and follower books", async () => {
    for (const visibility of ["unlisted", "followers"] as const) {
      expect(
        await checkAccess({ ...privateBook, visibility }),
      ).toEqual({ status: 200, body: { allowed: true } });
    }
  });

  it("denies a private-page visit before persistence or credit processing", async () => {
    resolvedBook = {
      ...privateBook,
      id: deniedPage.bookId,
      totalPages: 1,
      stats: { readCount: 0 },
      title: "Private test book",
    };
    markPageVisited.mockClear();

    const response = await requestPageVisit("other-user");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "You do not have access to this book",
    });
    expect(markPageVisited).not.toHaveBeenCalled();
  });
});