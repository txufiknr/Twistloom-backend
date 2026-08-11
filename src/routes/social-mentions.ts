/**
 * @overview Public Social Mentions Routes (Hono)
 *
 * Exposes the curated social-proof wall for the public homepage. Unlike the
 * admin endpoints (which live under `/admin/social-mentions` and require system
 * admin privileges), these routes are completely public and unauthenticated.
 *
 * Product CTAs (Read / More like this) are derived server-side only when the
 * linked book is still public+active (D2/D3).
 */

import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { cApiError, cValidationError } from "../utils/error.js";
import { dbRead } from "../db/client.js";
import { socialMentions, bookTestimonials, platformTestimonials, users, books, uploadedImages } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";
import { extractPaginationParams, calculatePaginationMeta } from "../utils/pagination.js";
import { buildBookReadHref } from "../services/social/extract-twistloom-link.js";

const router = new Hono<AppEnv>();

interface WallBookEmbed {
  id: string;
  slug: string;
  title: string;
  imageUrl: string | null;
}

interface WallActions {
  canRead: boolean;
  canSimilar: boolean;
  readHref: string | null;
  openOriginalUrl: string | null;
}

type WallRow = {
  id: string;
  source: string;
  platform: string | null;
  author: string;
  authorAvatar: string | null;
  authorAvatarFrame: string | null;
  title: string | null;
  content: string;
  url: string | null;
  score: number;
  rating: number | null;
  sentimentScore: number;
  relevanceScore: number;
  status: string;
  featured: boolean;
  publishedAt: Date | null;
  bookId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Builds the shared public projection for a social mention row.
 * relatedBookId is exposed as bookId for a unified wall contract.
 */
function socialWallQuery() {
  return dbRead
    .select({
      id: socialMentions.id,
      source: sql<string>`'social'`.as("source"),
      platform: sql<string | null>`${socialMentions.platform}`.as("platform"),
      author: socialMentions.author,
      authorAvatar: socialMentions.authorAvatar,
      authorAvatarFrame: sql<string | null>`NULL`.as("author_avatar_frame"),
      title: socialMentions.title,
      content: socialMentions.content,
      url: sql<string | null>`${socialMentions.url}`.as("url"),
      score: socialMentions.score,
      rating: sql<number | null>`NULL`.as("rating"),
      sentimentScore: socialMentions.sentimentScore,
      relevanceScore: socialMentions.relevanceScore,
      status: socialMentions.status,
      featured: socialMentions.featured,
      publishedAt: socialMentions.publishedAt,
      bookId: sql<string | null>`${socialMentions.relatedBookId}`.as("book_id"),
      createdAt: socialMentions.createdAt,
      updatedAt: socialMentions.updatedAt,
    })
    .from(socialMentions)
    .where(and(
      eq(socialMentions.status, "approved"),
      eq(socialMentions.featured, true),
    ));
}

/**
 * Builds the shared public projection for a user testimonial row.
 */
function userWallQuery() {
  return dbRead
    .select({
      id: bookTestimonials.id,
      source: sql<string>`'user'`.as("source"),
      platform: sql<string | null>`NULL`.as("platform"),
      author: sql<string>`COALESCE(${users.name}, 'Twistloom Reader')`.as("author"),
      authorAvatar: users.imageUrl,
      authorAvatarFrame: users.avatarFrame,
      title: sql<string | null>`NULL`.as("title"),
      content: bookTestimonials.content,
      url: sql<string | null>`NULL`.as("url"),
      score: sql<number>`0`.as("score"),
      rating: bookTestimonials.rating,
      sentimentScore: sql<number>`0`.as("sentiment_score"),
      relevanceScore: sql<number>`0`.as("relevance_score"),
      status: bookTestimonials.status,
      featured: bookTestimonials.featured,
      publishedAt: sql<Date | null>`NULL`.as("published_at"),
      bookId: bookTestimonials.bookId,
      createdAt: bookTestimonials.createdAt,
      updatedAt: bookTestimonials.updatedAt,
    })
    .from(bookTestimonials)
    .leftJoin(users, eq(bookTestimonials.userId, users.userId))
    .where(and(
      eq(bookTestimonials.status, "approved"),
      eq(bookTestimonials.featured, true),
    ));
}

/**
 * Builds the shared public projection for a platform testimonial row (beta
 * testers endorsing Twistloom the platform, scoped to no book).
 */
function platformWallQuery() {
  return dbRead
    .select({
      id: platformTestimonials.id,
      source: sql<string>`'platform'`.as("source"),
      platform: sql<string | null>`NULL`.as("platform"),
      author: sql<string>`COALESCE(${users.name}, 'Twistloom Reader')`.as("author"),
      authorAvatar: users.imageUrl,
      authorAvatarFrame: users.avatarFrame,
      title: sql<string | null>`NULL`.as("title"),
      content: platformTestimonials.content,
      url: sql<string | null>`NULL`.as("url"),
      score: sql<number>`0`.as("score"),
      rating: platformTestimonials.rating,
      sentimentScore: sql<number>`0`.as("sentiment_score"),
      relevanceScore: sql<number>`0`.as("relevance_score"),
      status: platformTestimonials.status,
      featured: platformTestimonials.featured,
      publishedAt: sql<Date | null>`NULL`.as("published_at"),
      bookId: sql<string | null>`NULL`.as("book_id"),
      createdAt: platformTestimonials.createdAt,
      updatedAt: platformTestimonials.updatedAt,
    })
    .from(platformTestimonials)
    .leftJoin(users, eq(platformTestimonials.userId, users.userId))
    .where(and(
      eq(platformTestimonials.status, "approved"),
      eq(platformTestimonials.featured, true),
    ));
}

/**
 * Batch-loads public+active books for wall CTA eligibility (D3).
 */
async function loadPublicBooksByIds(
  bookIds: string[],
): Promise<Map<string, WallBookEmbed>> {
  const unique = [...new Set(bookIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const map = new Map<string, WallBookEmbed>();
  if (unique.length === 0) return map;

  const rows = await dbRead
    .select({
      id: books.id,
      slug: books.slug,
      title: books.title,
      imageUrl: sql<string | null>`(
        SELECT ui.image_url FROM ${uploadedImages} ui WHERE ui.image_id = ${books.imageId} LIMIT 1
      )`.as("image_url"),
    })
    .from(books)
    .where(and(
      inArray(books.id, unique),
      eq(books.status, "active"),
      eq(books.visibility, "public"),
    ));

  for (const row of rows) {
    if (!row.slug) continue;
    map.set(row.id, {
      id: row.id,
      slug: row.slug,
      title: row.title,
      imageUrl: row.imageUrl,
    });
  }

  return map;
}

/**
 * Attaches book embed + derived actions for homepage CTAs.
 */
function enrichWallRows(
  rows: WallRow[],
  publicBooks: Map<string, WallBookEmbed>,
) {
  return rows.map((row) => {
    const book = row.bookId ? publicBooks.get(row.bookId) ?? null : null;
    const actions: WallActions = {
      canRead: !!book,
      canSimilar: !!book,
      readHref: book ? buildBookReadHref(book.slug) : null,
      openOriginalUrl: row.url ?? null,
    };

    return {
      ...row,
      // Only expose bookId when CTA-eligible so clients never deep-link private books
      bookId: book ? book.id : null,
      book,
      actions,
    };
  });
}

router.get("/", async (c) => {
  try {
    const { limit = 20, page = 1 } = extractPaginationParams(c.req.query(), 20);
    const source = c.req.query().source ?? "all";
    const validSource = source === "social" || source === "user" || source === "platform" ? source : "all";

    const offset = (page - 1) * limit;

    let query;
    if (validSource === "social") {
      query = socialWallQuery();
    } else if (validSource === "user") {
      query = userWallQuery();
    } else if (validSource === "platform") {
      query = platformWallQuery();
    } else {
      query = union(socialWallQuery(), userWallQuery(), platformWallQuery());
    }

    const rows = (await query
      .orderBy(desc(sql`relevance_score`), desc(sql`created_at`))
      .limit(limit)
      .offset(offset)) as WallRow[];

    const publicBooks = await loadPublicBooksByIds(rows.map((r) => r.bookId).filter(Boolean) as string[]);
    const mentions = enrichWallRows(rows, publicBooks);

    let totalCount: number;
    if (validSource === "social") {
      const [row] = await dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(socialMentions)
        .where(and(eq(socialMentions.status, "approved"), eq(socialMentions.featured, true)));
      totalCount = row.count;
    } else if (validSource === "user") {
      const [row] = await dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(bookTestimonials)
        .where(and(eq(bookTestimonials.status, "approved"), eq(bookTestimonials.featured, true)));
      totalCount = row.count;
    } else if (validSource === "platform") {
      const [row] = await dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(platformTestimonials)
        .where(and(eq(platformTestimonials.status, "approved"), eq(platformTestimonials.featured, true)));
      totalCount = row.count;
    } else {
      const [[socialRow], [userRow], [platformRow]] = await Promise.all([
        dbRead
          .select({ count: sql<number>`count(*)::int` })
          .from(socialMentions)
          .where(and(eq(socialMentions.status, "approved"), eq(socialMentions.featured, true))),
        dbRead
          .select({ count: sql<number>`count(*)::int` })
          .from(bookTestimonials)
          .where(and(eq(bookTestimonials.status, "approved"), eq(bookTestimonials.featured, true))),
        dbRead
          .select({ count: sql<number>`count(*)::int` })
          .from(platformTestimonials)
          .where(and(eq(platformTestimonials.status, "approved"), eq(platformTestimonials.featured, true))),
      ]);
      totalCount = socialRow.count + userRow.count + platformRow.count;
    }

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    return c.json({ source: validSource, mentions, pagination });
  } catch (error) {
    return cApiError(c, "Failed to retrieve social mentions", error);
  }
});

router.get("/:id", async (c) => {
  try {
    const { id } = c.req.param();
    const itemId = Array.isArray(id) ? id[0] : id;

    const [social] = await dbRead
      .select({
        id: socialMentions.id,
        source: sql<string>`'social'`.as("source"),
        platform: socialMentions.platform,
        author: socialMentions.author,
        authorAvatar: socialMentions.authorAvatar,
        authorAvatarFrame: sql<string | null>`NULL`.as("author_avatar_frame"),
        title: socialMentions.title,
        content: socialMentions.content,
        url: socialMentions.url,
        score: socialMentions.score,
        rating: sql<number | null>`NULL`.as("rating"),
        sentimentScore: socialMentions.sentimentScore,
        relevanceScore: socialMentions.relevanceScore,
        status: socialMentions.status,
        featured: socialMentions.featured,
        publishedAt: socialMentions.publishedAt,
        bookId: sql<string | null>`${socialMentions.relatedBookId}`.as("book_id"),
        createdAt: socialMentions.createdAt,
        updatedAt: socialMentions.updatedAt,
      })
      .from(socialMentions)
      .where(and(
        eq(socialMentions.id, itemId),
        eq(socialMentions.status, "approved"),
        eq(socialMentions.featured, true),
      ))
      .limit(1);

    if (social) {
      const publicBooks = await loadPublicBooksByIds(social.bookId ? [social.bookId] : []);
      const [enriched] = enrichWallRows([social as WallRow], publicBooks);
      return c.json(enriched);
    }

    const [user] = await dbRead
      .select({
        id: bookTestimonials.id,
        source: sql<string>`'user'`.as("source"),
        platform: sql<string | null>`NULL`.as("platform"),
        author: sql<string>`COALESCE(${users.name}, 'Twistloom Reader')`.as("author"),
        authorAvatar: users.imageUrl,
        authorAvatarFrame: users.avatarFrame,
        title: sql<string | null>`NULL`.as("title"),
        content: bookTestimonials.content,
        url: sql<string | null>`NULL`.as("url"),
        score: sql<number>`0`.as("score"),
        rating: bookTestimonials.rating,
        sentimentScore: sql<number>`0`.as("sentiment_score"),
        relevanceScore: sql<number>`0`.as("relevance_score"),
        status: bookTestimonials.status,
        featured: bookTestimonials.featured,
        publishedAt: sql<Date | null>`NULL`.as("published_at"),
        bookId: bookTestimonials.bookId,
        createdAt: bookTestimonials.createdAt,
        updatedAt: bookTestimonials.updatedAt,
      })
      .from(bookTestimonials)
      .leftJoin(users, eq(bookTestimonials.userId, users.userId))
      .where(and(
        eq(bookTestimonials.id, itemId),
        eq(bookTestimonials.status, "approved"),
        eq(bookTestimonials.featured, true),
      ))
      .limit(1);

    if (!user) {
      return cValidationError(c, "Social mention not found", undefined, 404);
    }

    const publicBooks = await loadPublicBooksByIds(user.bookId ? [user.bookId] : []);
    const [enriched] = enrichWallRows([user as WallRow], publicBooks);
    return c.json(enriched);
  } catch (error) {
    return cApiError(c, "Failed to retrieve social mention", error);
  }
});

export default router;
