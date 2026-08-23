import { dbRead } from "../db/client.js";
import { books, pages, userPageProgress } from "../db/schema.js";
import { eq, asc, inArray, count } from "drizzle-orm";

export interface BookPageAnalytics {
  page: number;
  visitCount: number;
  transitionsOut: number;
  momentum: string | null;
  mood: string | null;
  /** 0..100 — proxy: (visitCount − transitionsOut) / visitCount */
  dropOffPct: number;
}

export interface BookAnalyticsDetail {
  bookId: string;
  title: string;
  totalPages: number;
  reads: number;
  pages: BookPageAnalytics[];
}

/**
 * Per-page drop-off + momentum for a single book (roadmap 1.9 / P6).
 * Used by both the admin analytics route and the book-owner analytics route.
 */
export async function getBookAnalytics(bookId: string): Promise<BookAnalyticsDetail | null> {
  const [book] = await dbRead
    .select({
      id: books.id,
      title: books.title,
      totalPages: books.totalPages,
      readCount: books.readCount,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  if (!book) return null;

  const pageRows = await dbRead
    .select({
      id: pages.id,
      page: pages.page,
      visitCount: pages.visitCount,
      momentum: pages.momentum,
      mood: pages.mood,
    })
    .from(pages)
    .where(eq(pages.bookId, bookId))
    .orderBy(asc(pages.page));

  const pageIds = pageRows.map((p) => p.id);
  const transMap: Record<string, number> = {};

  if (pageIds.length > 0) {
    const transAgg = await dbRead
      .select({
        actionedPageId: userPageProgress.actionedPageId,
        transitionsOut: count(),
      })
      .from(userPageProgress)
      .where(inArray(userPageProgress.actionedPageId, pageIds))
      .groupBy(userPageProgress.actionedPageId);

    for (const row of transAgg) {
      transMap[row.actionedPageId] = Number(row.transitionsOut ?? 0);
    }
  }

  const pagesOut = pageRows.map((p) => {
    const transitionsOut = transMap[p.id] ?? 0;
    const dropOffPct = p.visitCount > 0 ? Math.max(0, Math.round(((p.visitCount - transitionsOut) / p.visitCount) * 100)) : 0;
    return {
      page: p.page,
      visitCount: p.visitCount,
      transitionsOut,
      momentum: p.momentum,
      mood: p.mood,
      dropOffPct,
    };
  });

  return {
    bookId,
    title: book.title,
    totalPages: book.totalPages,
    reads: book.readCount,
    pages: pagesOut,
  };
}
