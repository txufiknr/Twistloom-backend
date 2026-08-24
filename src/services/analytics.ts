import { dbRead } from "../db/client.js";
import { books, pages, userPageProgress, pageReactions, userActivityLogs } from "../db/schema.js";
import { eq, asc, inArray, count, countDistinct, sql, gte, desc, and, type Column } from "drizzle-orm";

export interface BookPageAnalytics {
  page: number;
  visitCount: number;
  transitionsOut: number;
  momentum: string | null;
  mood: string | null;
  /** 0..100 — proxy: (visitCount − transitionsOut) / visitCount */
  dropOffPct: number;
}

export interface BranchEngagement {
  branchId: string | null;
  pages: number;
  visits: number;
  avgDropOffPct: number;
  avgMomentum: number | null;
}

export type HealthGrade = "A" | "B" | "C" | "D";

export interface StoryHealthScore {
  overall: number;
  grade: HealthGrade;
  components: {
    completion: number | null;
    narrativeQuality: number | null;
    retention: number | null;
    momentum: number | null;
    satisfaction: number | null;
    reread: number | null;
    resonance: number | null;
  };
}

export interface PageDwell {
  page: number;
  avgDwellMs: number | null;
}

export interface PageReactions {
  page: number;
  total: number;
  byEmoji: Record<string, number>;
}

export interface BookAnalyticsDetail {
  bookId: string;
  title: string;
  totalPages: number;
  reads: number;
  pages: BookPageAnalytics[];
  /** VIP-only section. Omitted entirely for non-VIP owners; always present for admin. */
  branchEngagement?: BranchEngagement[];
  /** VIP-only composite score (roadmap 2.13). Omitted for non-VIP owners. */
  storyHealth?: StoryHealthScore;
  /** VIP-only 30-day per-book engagement history (roadmap 1.9 historical trend). */
  historyTrend?: { day: string; count: number }[];
  /** VIP-only average dwell time per page in ms (roadmap 1.9 dwell-time). */
  dwellByPage?: PageDwell[];
  /** VIP-only per-page reader reactions breakdown (roadmap 1.9 emotional resonance). */
  reactionsByPage?: PageReactions[];
}

export interface CommunityAnalytics {
  totals: {
    books: number;
    reads: number;
    completions: number;
    comments: number;
    testimonials: number;
    ratings: number;
    likes: number;
  };
  topBooks: {
    id: string;
    title: string;
    readCount: number;
    completionRate: number | null;
    rating: number | null;
    trendingScore: number | null;
    likesCount: number;
  }[];
  themes: { key: string; count: number }[];
  languages: { key: string; count: number }[];
  modes: { key: string; count: number }[];
  statuses: { key: string; count: number }[];
  visibility: { key: string; count: number }[];
  publishingCadence: { month: string; count: number }[];
  engagementTrend: { day: string; count: number }[];
}

/** Ordinal scale for the categorical `StoryMomentum` signal (presentation only). */
const MOMENTUM_SCORE: Record<string, number> = {
  building: 30,
  rising: 60,
  critical: 90,
  resolution: 45,
};

function gradeFor(overall: number): HealthGrade {
  if (overall >= 85) return "A";
  if (overall >= 70) return "B";
  if (overall >= 55) return "C";
  return "D";
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Composite "Story Health Score" (roadmap 2.13) — the YouTube-Studio-style
 * pairing of creator metrics + reader behavior. All inputs are existing columns.
 */
function computeStoryHealth(input: {
  totalPages: number;
  completionRate: number | null;
  rating: number | null;
  visitSum: number;
  uniqueReaders: number;
  reactionCount: number;
  avgDropOffPct: number;
  avgMomentumScore: number | null;
  avgNarrativeQuality: number | null;
}): StoryHealthScore {
  const completion =
    input.completionRate != null ? clamp(Math.round(input.completionRate * 100)) : null;
  const retention = clamp(Math.round(100 - input.avgDropOffPct));
  const momentum = input.avgMomentumScore != null ? clamp(Math.round(input.avgMomentumScore)) : null;
  const narrativeQuality =
    input.avgNarrativeQuality != null ? clamp(Math.round(input.avgNarrativeQuality)) : null;
  const satisfaction = input.rating != null ? clamp(Math.round(input.rating * 20)) : null;
  const reread =
    input.visitSum > 0 && input.uniqueReaders > 0
      ? clamp(Math.round(((input.visitSum - input.uniqueReaders) / input.visitSum) * 100))
      : null;
  const resonance =
    input.reactionCount > 0 && input.totalPages > 0
      ? clamp(Math.round((input.reactionCount / input.totalPages) * 20))
      : null;

  const components: StoryHealthScore["components"] = {
    completion,
    narrativeQuality,
    retention,
    momentum,
    satisfaction,
    reread,
    resonance,
  };

  // Weighted average over available (non-null) components.
  const weights: Record<keyof StoryHealthScore["components"], number> = {
    completion: 0.25,
    narrativeQuality: 0.2,
    retention: 0.2,
    momentum: 0.15,
    satisfaction: 0.1,
    reread: 0.05,
    resonance: 0.05,
  };
  let wSum = 0;
  let vSum = 0;
  (Object.keys(components) as (keyof typeof components)[]).forEach((k) => {
    const v = components[k];
    if (v != null) {
      wSum += weights[k];
      vSum += v * weights[k];
    }
  });
  const overall = wSum > 0 ? Math.round(vSum / wSum) : 0;

  return { overall, grade: gradeFor(overall), components };
}

/**
 * Per-page drop-off + momentum for a single book (roadmap 1.9 / P6).
 * Used by both the admin analytics route and the book-owner analytics route.
 *
 * `includeVip` gates the VIP-only sections (`branchEngagement`, `storyHealth`):
 * pass `true` for admin/staff and for VIP book owners; `false` for non-VIP
 * owners (fields are omitted so no VIP data leaks to the client).
 */
export async function getBookAnalytics(
  bookId: string,
  includeVip = false,
): Promise<BookAnalyticsDetail | null> {
  const [book] = await dbRead
    .select({
      id: books.id,
      title: books.title,
      totalPages: books.totalPages,
      readCount: books.readCount,
      completionRate: books.completionRate,
      rating: books.rating,
      ratingCount: books.ratingCount,
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
      branchId: pages.branchId,
      scoreBefore: pages.scoreBefore,
      scoreAfter: pages.scoreAfter,
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
    const dropOffPct =
      p.visitCount > 0 ? Math.max(0, Math.round(((p.visitCount - transitionsOut) / p.visitCount) * 100)) : 0;
    return {
      page: p.page,
      visitCount: p.visitCount,
      transitionsOut,
      momentum: p.momentum,
      mood: p.mood,
      dropOffPct,
    };
  });

  const result: BookAnalyticsDetail = {
    bookId,
    title: book.title,
    totalPages: book.totalPages,
    reads: book.readCount,
    pages: pagesOut,
  };

  if (includeVip) {
    // ── Branch engagement ──
    const byBranch = new Map<string, { pages: number; visits: number; dropSum: number; momSum: number; momCount: number }>();
    for (const p of pageRows) {
      const key = p.branchId ?? "main";
      const agg = byBranch.get(key) ?? { pages: 0, visits: 0, dropSum: 0, momSum: 0, momCount: 0 };
      agg.pages += 1;
      agg.visits += p.visitCount;
      const transitionsOut = transMap[p.id] ?? 0;
      const dropOffPct =
        p.visitCount > 0 ? Math.max(0, Math.round(((p.visitCount - transitionsOut) / p.visitCount) * 100)) : 0;
      agg.dropSum += dropOffPct;
      if (p.momentum && MOMENTUM_SCORE[p.momentum] != null) {
        agg.momSum += MOMENTUM_SCORE[p.momentum];
        agg.momCount += 1;
      }
      byBranch.set(key, agg);
    }
    result.branchEngagement = Array.from(byBranch.entries()).map(([branchId, a]) => ({
      branchId: branchId === "main" ? null : branchId,
      pages: a.pages,
      visits: a.visits,
      avgDropOffPct: a.pages > 0 ? Math.round(a.dropSum / a.pages) : 0,
      avgMomentum: a.momCount > 0 ? Math.round(a.momSum / a.momCount) : null,
    }));

    // ── Story Health Score ──
    const visitSum = pageRows.reduce((s, p) => s + p.visitCount, 0);
    const [{ uniqueReaders } = { uniqueReaders: 0 }] = await dbRead
      .select({ uniqueReaders: countDistinct(userPageProgress.userId) })
      .from(userPageProgress)
      .where(eq(userPageProgress.bookId, bookId));
    const [{ reactionCount } = { reactionCount: 0 }] = await dbRead
      .select({ reactionCount: count() })
      .from(pageReactions)
      .where(eq(pageReactions.bookId, bookId));

    const avgDropOffPct =
      pagesOut.length > 0
        ? pagesOut.reduce((s, p) => s + p.dropOffPct, 0) / pagesOut.length
        : 0;

    let momSum = 0;
    let momCount = 0;
    let narrSum = 0;
    let narrCount = 0;
    for (const p of pageRows) {
      if (p.momentum && MOMENTUM_SCORE[p.momentum] != null) {
        momSum += MOMENTUM_SCORE[p.momentum];
        momCount += 1;
      }
      if (p.scoreBefore != null && p.scoreAfter != null) {
        narrSum += (p.scoreBefore + p.scoreAfter) / 2;
        narrCount += 1;
      }
    }
    const avgMomentumScore = momCount > 0 ? momSum / momCount : null;
    const avgNarrativeQuality = narrCount > 0 ? narrSum / narrCount : null;

    result.storyHealth = computeStoryHealth({
      totalPages: book.totalPages,
      completionRate: book.completionRate,
      rating: book.rating,
      visitSum,
      uniqueReaders: Number(uniqueReaders ?? 0),
      reactionCount: Number(reactionCount ?? 0),
      avgDropOffPct,
      avgMomentumScore,
      avgNarrativeQuality,
    });

    // ── Historical trend (per-book 30-day engagement) ──
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trendRows = await dbRead
      .select({
        day: sql<string>`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`,
        count: count(),
      })
      .from(userPageProgress)
      .where(and(
        eq(userPageProgress.bookId, bookId),
        gte(userPageProgress.createdAt, since),
      ))
      .groupBy(sql`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`);
    result.historyTrend = trendRows.map((r) => ({ day: String(r.day), count: Number(r.count ?? 0) }));

    // ── Dwell time per page + per-page reaction breakdown ──
    if (pageIds.length > 0) {
      const dwellRows = await dbRead
        .select({
          targetId: userActivityLogs.targetId,
          avgDwellMs: sql<number>`avg((metadata->>'dwellMs')::int)`,
        })
        .from(userActivityLogs)
        .where(and(
          eq(userActivityLogs.activityType, "page_dwell"),
          inArray(userActivityLogs.targetId, pageIds),
        ))
        .groupBy(userActivityLogs.targetId);
      const dwellMap = new Map<string, number | null>();
      for (const r of dwellRows) {
        dwellMap.set(r.targetId ?? "", r.avgDwellMs == null ? null : Number(r.avgDwellMs));
      }
      result.dwellByPage = pageRows.map((p) => ({
        page: p.page,
        avgDwellMs: dwellMap.get(p.id) ?? null,
      }));

      const reactRows = await dbRead
        .select({
          pageId: pageReactions.pageId,
          emoji: pageReactions.emoji,
          cnt: count(),
        })
        .from(pageReactions)
        .where(inArray(pageReactions.pageId, pageIds))
        .groupBy(pageReactions.pageId, pageReactions.emoji);
      const reactMap = new Map<string, Record<string, number>>();
      for (const r of reactRows) {
        const m = reactMap.get(r.pageId) ?? {};
        m[r.emoji] = Number(r.cnt ?? 0);
        reactMap.set(r.pageId, m);
      }
      result.reactionsByPage = pageRows.map((p) => {
        const byEmoji = reactMap.get(p.id) ?? {};
        const total = Object.values(byEmoji).reduce((s, n) => s + n, 0);
        return { page: p.page, total, byEmoji };
      });
    }
  }

  return result;
}

/**
 * Platform-wide community analytics (roadmap 3.5). All aggregates come from
 * trigger-maintained `books` columns + `userPageProgress`/`pageReactions` —
 * no new signal capture required.
 */
export async function getCommunityAnalytics(): Promise<CommunityAnalytics> {
  const [{ totals } = { totals: null }] = await dbRead
    .select({
      totals: sql<{
        books: number;
        reads: number;
        completions: number;
        comments: number;
        testimonials: number;
        ratings: number;
        likes: number;
      }>`json_build_object(
        'books', count(*),
        'reads', coalesce(sum(${books.readCount}), 0)::int,
        'completions', coalesce(sum(${books.completeCount}), 0)::int,
        'comments', coalesce(sum(${books.commentsCount}), 0)::int,
        'testimonials', coalesce(sum(${books.testimonialsCount}), 0)::int,
        'ratings', coalesce(sum(${books.ratingCount}), 0)::int,
        'likes', coalesce(sum(${books.likesCount}), 0)::int
      )`,
    })
    .from(books);

  const t = totals ?? {
    books: 0,
    reads: 0,
    completions: 0,
    comments: 0,
    testimonials: 0,
    ratings: 0,
    likes: 0,
  };

  const topBooks = await dbRead
    .select({
      id: books.id,
      title: books.title,
      readCount: books.readCount,
      completionRate: books.completionRate,
      rating: books.rating,
      trendingScore: books.trendingScore,
      likesCount: books.likesCount,
    })
    .from(books)
    .orderBy(desc(books.readCount))
    .limit(10);

  const distribution = async (column: Column): Promise<{ key: string; count: number }[]> => {
    const rows = await dbRead
      .select({ key: sql<string>`${column}`, count: count() })
      .from(books)
      .groupBy(sql`${column}`);
    return rows
      .map((r) => ({ key: String(r.key ?? "unknown"), count: Number(r.count ?? 0) }))
      .filter((r) => r.key.length > 0)
      .sort((a, b) => b.count - a.count);
  };

  const themesRows = await dbRead
    .select({ key: sql<string>`unnest(${books.keywords})`, count: count() })
    .from(books);
  const themes = themesRows
    .map((r) => ({ key: String(r.key ?? ""), count: Number(r.count ?? 0) }))
    .filter((r) => r.key.length > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const cadenceRows = await dbRead
    .select({
      month: sql<string>`to_char(date_trunc('month', ${books.createdAt}), 'YYYY-MM')`,
      count: count(),
    })
    .from(books)
    .groupBy(sql`date_trunc('month', ${books.createdAt})`)
    .orderBy(sql`date_trunc('month', ${books.createdAt})`);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const trendRows = await dbRead
    .select({
      day: sql<string>`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(userPageProgress)
    .where(gte(userPageProgress.createdAt, since))
    .groupBy(sql`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${userPageProgress.createdAt}, 'YYYY-MM-DD')`);

  return {
    totals: {
      books: Number(t.books ?? 0),
      reads: Number(t.reads ?? 0),
      completions: Number(t.completions ?? 0),
      comments: Number(t.comments ?? 0),
      testimonials: Number(t.testimonials ?? 0),
      ratings: Number(t.ratings ?? 0),
      likes: Number(t.likes ?? 0),
    },
    topBooks: topBooks.map((b) => ({
      id: b.id,
      title: b.title,
      readCount: b.readCount,
      completionRate: b.completionRate != null ? Number(b.completionRate) : null,
      rating: b.rating != null ? Number(b.rating) : null,
      trendingScore: b.trendingScore != null ? Number(b.trendingScore) : null,
      likesCount: b.likesCount,
    })),
    themes,
    languages: await distribution(books.language),
    modes: await distribution(books.mode),
    statuses: await distribution(books.status),
    visibility: await distribution(books.visibility),
    publishingCadence: cadenceRows.map((r) => ({ month: r.month, count: Number(r.count ?? 0) })),
    engagementTrend: trendRows.map((r) => ({ day: r.day, count: Number(r.count ?? 0) })),
  };
}
