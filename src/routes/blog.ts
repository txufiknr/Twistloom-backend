/**
 * Public portal blog API (published posts only).
 * Consumed by Twistloom Portal SSR for /blog.
 * CMS mutations live under /api/admin/blog-posts.
 */
import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { dbRead } from "../db/client.js";
import { portalBlogPosts } from "../db/schema.js";
import { cApiError, cNotFoundError } from "../utils/error.js";
import { sanitizeBlogHtml } from "../utils/sanitize-html.js";
import type { AppEnv } from "../hono/env.js";

const router = new Hono<AppEnv>();

/**
 * GET /blog/posts
 * Lists published posts (newest first).
 */
router.get("/posts", async (c) => {
  try {
    const { limit = "20", offset = "0" } = c.req.query();
    const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const offsetNum = Math.max(Number(offset) || 0, 0);

    const conditions = and(eq(portalBlogPosts.status, "published"));

    const rows = await dbRead
      .select({
        id: portalBlogPosts.id,
        slug: portalBlogPosts.slug,
        title: portalBlogPosts.title,
        description: portalBlogPosts.description,
        excerpt: portalBlogPosts.excerpt,
        coverUrl: portalBlogPosts.coverUrl,
        authorName: portalBlogPosts.authorName,
        publishedAt: portalBlogPosts.publishedAt,
        updatedAt: portalBlogPosts.updatedAt,
      })
      .from(portalBlogPosts)
      .where(conditions)
      .orderBy(desc(portalBlogPosts.publishedAt), desc(portalBlogPosts.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const [{ count }] = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(portalBlogPosts)
      .where(conditions);

    return c.json({
      total: Number(count),
      limit: limitNum,
      offset: offsetNum,
      posts: rows,
    });
  } catch (error) {
    return cApiError(c, "Failed to list blog posts", error);
  }
});

/**
 * GET /blog/posts/:slug
 * Single published post with body.
 */
router.get("/posts/:slug", async (c) => {
  try {
    const { slug } = c.req.param();
    const [post] = await dbRead
      .select()
      .from(portalBlogPosts)
      .where(and(eq(portalBlogPosts.slug, slug), eq(portalBlogPosts.status, "published")))
      .limit(1);

    if (!post) return cNotFoundError(c, "Blog post not found");
    // Defense-in-depth: re-sanitize stored HTML on public read
    return c.json({
      ...post,
      bodyHtml: sanitizeBlogHtml(post.bodyHtml),
    });
  } catch (error) {
    return cApiError(c, "Failed to get blog post", error);
  }
});

export default router;