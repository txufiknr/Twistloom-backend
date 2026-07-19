/**
 * @overview Public Social Mentions Routes
 *
 * Exposes the curated social-proof wall for the public homepage. Unlike the
 * admin endpoints (which live under `/admin/social-mentions` and require system
 * admin privileges), these routes are completely public and unauthenticated.
 *
 * Only items that have been both approved AND featured by an admin are returned,
 * so raw auto-ingested or rejected content can never leak to users. The wall
 * unifies two streams:
 *   - `social`  : third-party posts scraped by the ingestion cron (`socialMentions`)
 *   - `user`    : first-party reader testimonials (`bookTestimonials`)
 *
 * Use the `source` query param to scope the wall (default: `all`).
 *
 * Endpoints:
 * - GET /social-mentions - List featured, approved items for the wall
 */

import type { Request, Response, Router as RouterType } from "express";
import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { handleApiError, handleValidationError } from "../utils/error.js";
import { dbRead } from "../db/client.js";
import { socialMentions, bookTestimonials } from "../db/schema.js";

const router: RouterType = Router();

/**
 * Builds the shared public projection for a social mention row.
 * Each returned row is tagged with `source: "social"`.
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
 * Each returned row is tagged with `source: "user"`.
 */
function userWallQuery() {
  return dbRead
    .select({
      id: bookTestimonials.id,
      source: sql<string>`'user'`.as("source"),
      platform: sql<string | null>`NULL`.as("platform"),
      author: sql<string>`'Twistloom Reader'`.as("author"),
      authorAvatar: sql<string | null>`NULL`.as("author_avatar"),
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
    .where(and(
      eq(bookTestimonials.status, "approved"),
      eq(bookTestimonials.featured, true),
    ));
}

/**
 * GET /social-mentions
 *
 * Public homepage social-proof wall. Returns items an admin has approved and
 * featured. Results unify third-party social mentions and first-party reader
 * testimonials, each tagged with a `source` field (`"social"` | `"user"`).
 *
 * Scope is controlled by the `source` query param:
 *   - `all`   (default): both streams
 *   - `social`: only third-party scraped posts
 *   - `user`  : only reader-submitted testimonials
 *
 * Within each stream, ordering follows the same curation priority as the admin
 * queue. The combined result is ordered by `relevanceScore` DESC then
 * `createdAt` DESC so the strongest items surface first.
 *
 * @param source - Stream scope: "all" | "social" | "user" (default "all")
 * @param limit - Maximum rows to return (default: 20, max: 100)
 * @returns Object with `source` echo and `mentions` array (each tagged by source)
 *
 * @example
 * ```json
 * {
 *   "source": "all",
 *   "mentions": [
 *     {
 *       "id": "0194f2d1-...",
 *       "source": "social",
 *       "platform": "reddit",
 *       "author": "u/bookworm",
 *       "content": "I've tried AI Dungeon and NovelAI, but Twistloom...",
 *       "url": "https://www.reddit.com/r/...",
 *       "score": 236,
 *       "relevanceScore": 95,
 *       "featured": true
 *     },
 *     {
 *       "id": "0194f2d2-...",
 *       "source": "user",
 *       "platform": null,
 *       "author": "Twistloom Reader",
 *       "content": "Twistloom generated an ending I genuinely didn't expect.",
 *       "rating": 5,
 *       "bookId": "book-uuid",
 *       "relevanceScore": 0,
 *       "featured": true
 *     }
 *   ]
 * }
 * ```
 */
router.get("/social-mentions",
  async (req: Request, res: Response) => {
    try {
      const { source = "all", limit = "20" } = req.query;
      const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);

      const validSource = source === "social" || source === "user" ? source : "all";

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
        .limit(limitNum);

      res.json({ source: validSource, mentions: rows });
    } catch (error) {
      handleApiError(res, "Failed to retrieve social mentions", error);
    }
  }
);

/**
 * GET /social-mentions/:id
 *
 * Public single-item lookup for the wall. Same visibility rules as the list
 * (approved + featured), across both streams. Because IDs are unique across
 * both tables (uuids), a single lookup tries the social stream first, then the
 * user stream.
 *
 * @param id - Item identifier (social mention or testimonial)
 * @returns The featured item row tagged with its `source`, or 404 if not public
 */
router.get("/social-mentions/:id",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
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
        return res.json(social);
      }

      const [user] = await dbRead
        .select({
          id: bookTestimonials.id,
          source: sql<string>`'user'`.as("source"),
          platform: sql<string | null>`NULL`.as("platform"),
          author: sql<string>`'Twistloom Reader'`.as("author"),
          authorAvatar: sql<string | null>`NULL`.as("author_avatar"),
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
        .where(and(
          eq(bookTestimonials.id, itemId),
          eq(bookTestimonials.status, "approved"),
          eq(bookTestimonials.featured, true),
        ))
        .limit(1);

      if (!user) {
        return handleValidationError(res, "Social mention not found", undefined, 404);
      }

      res.json(user);
    } catch (error) {
      handleApiError(res, "Failed to retrieve social mention", error);
    }
  }
);

export default router;
