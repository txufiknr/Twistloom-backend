/**
 * @overview Public Social Mentions Routes (Hono)
 *
 * Exposes the curated social-proof wall for the public homepage. Unlike the
 * admin endpoints (which live under `/admin/social-mentions` and require system
 * admin privileges), these routes are completely public and unauthenticated.
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { cApiError, cValidationError } from "../utils/error.js";
import { dbRead } from "../db/client.js";
import { socialMentions, bookTestimonials, users } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";
import { extractPaginationParams, calculatePaginationMeta } from "../utils/pagination.js";

const router = new Hono<AppEnv>();

/**
 * Builds the shared public projection for a social mention row.
 */
function socialWallQuery() {
  return dbRead
    .select({
      id: socialMentions.id,
      source: sql<string>`'social'`.as("source"),
      platform: sql<string | null>`${socialMentions.platform}`.as("platform"),
      author: socialMentions.author,
      authorAvatar: socialMentions.authorAvatar,
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
      bookId: sql<string | null>`NULL`.as("book_id"),
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

router.get("/", async (c) => {
  try {
    const { limit = 20, page = 1 } = extractPaginationParams(c.req.query(), 20);
    const source = c.req.query().source ?? "all";
    const validSource = source === "social" || source === "user" ? source : "all";

    const offset = (page - 1) * limit;

    let query;
    if (validSource === "social") {
      query = socialWallQuery();
    } else if (validSource === "user") {
      query = userWallQuery();
    } else {
      query = union(socialWallQuery(), userWallQuery());
    }

    const rows = await query
      .orderBy(desc(sql`relevance_score`), desc(sql`created_at`))
      .limit(limit)
      .offset(offset);

    // Total count for the requested source, used to build pagination metadata.
    // Social and user mentions come from disjoint tables, so the "all" total is
    // the sum of the two independent counts.
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
    } else {
      const [socialRow] = await dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(socialMentions)
        .where(and(eq(socialMentions.status, "approved"), eq(socialMentions.featured, true)));
      const [userRow] = await dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(bookTestimonials)
        .where(and(eq(bookTestimonials.status, "approved"), eq(bookTestimonials.featured, true)));
      totalCount = socialRow.count + userRow.count;
    }

    const pagination = calculatePaginationMeta(page, limit, totalCount);

    return c.json({ source: validSource, mentions: rows, pagination });
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
        bookId: sql<string | null>`NULL`.as("book_id"),
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
      return c.json(social);
    }

    const [user] = await dbRead
      .select({
        id: bookTestimonials.id,
        source: sql<string>`'user'`.as("source"),
        platform: sql<string | null>`NULL`.as("platform"),
        author: sql<string>`COALESCE(${users.name}, 'Twistloom Reader')`.as("author"),
        authorAvatar: users.imageUrl,
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

    return c.json(user);
  } catch (error) {
    return cApiError(c, "Failed to retrieve social mention", error);
  }
});

export default router;
