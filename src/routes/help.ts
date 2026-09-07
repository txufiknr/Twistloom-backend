import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/nextauth.js";
import { cApiError, cValidationError } from "../utils/error.js";
import { dbRead, dbWrite } from "../db/client.js";
import { helpArticleFeedback } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";

const router = new Hono<AppEnv>();

const VALID_VOTES = ["helpful", "not_helpful"] as const;
type HelpVote = (typeof VALID_VOTES)[number];

function isHelpVote(value: unknown): value is HelpVote {
  return typeof value === "string" && (VALID_VOTES as readonly string[]).includes(value);
}

/**
 * POST /help/articles/:articleId/vote
 *
 * Records or updates a reader's helpfulness vote on a help center article.
 * One vote per user per article — sending a different vote replaces the
 * previous one (upsert on the unique (articleId, userId) constraint).
 *
 * Requires authentication.
 *
 * @param articleId - Help article key (e.g. "branching-stories")
 * @body { vote: "helpful" | "not_helpful" }
 * @returns The recorded vote
 */
router.post("/articles/:articleId/vote", requireAuth, async (c) => {
  try {
    const { articleId } = c.req.param();
    const userId = c.get("userId")!;
    const body = c.get("body") as { vote?: unknown };

    if (!articleId || typeof articleId !== "string") {
      return cValidationError(c, "articleId is required");
    }

    if (!isHelpVote(body?.vote)) {
      return cValidationError(c, "vote must be 'helpful' or 'not_helpful'");
    }

    // Upsert: insert or update vote on conflict (articleId, userId)
    const [existing] = await dbRead
      .select({ id: helpArticleFeedback.id })
      .from(helpArticleFeedback)
      .where(
        and(
          eq(helpArticleFeedback.articleId, articleId),
          eq(helpArticleFeedback.userId, userId),
        ),
      )
      .limit(1);

    let result;
    if (existing) {
      [result] = await dbWrite
        .update(helpArticleFeedback)
        .set({ vote: body.vote, updatedAt: new Date() })
        .where(eq(helpArticleFeedback.id, existing.id))
        .returning();
    } else {
      [result] = await dbWrite
        .insert(helpArticleFeedback)
        .values({ articleId, userId, vote: body.vote })
        .returning();
    }

    return c.json({
      articleId,
      vote: result.vote,
      success: true,
    });
  } catch (error) {
    return cApiError(c, "Failed to record vote", error);
  }
});

/**
 * GET /help/articles/:articleId/stats
 *
 * Returns aggregated helpfulness counts for an article.
 * Public endpoint — no auth required.
 *
 * @returns { helpful: number, notHelpful: number }
 */
router.get("/articles/:articleId/stats", async (c) => {
  try {
    const { articleId } = c.req.param();

    if (!articleId || typeof articleId !== "string") {
      return cValidationError(c, "articleId is required");
    }

    const [stats] = await dbRead
      .select({
        helpful: sql<number>`count(*) filter (where ${helpArticleFeedback.vote} = 'helpful')`,
        notHelpful: sql<number>`count(*) filter (where ${helpArticleFeedback.vote} = 'not_helpful')`,
      })
      .from(helpArticleFeedback)
      .where(eq(helpArticleFeedback.articleId, articleId));

    return c.json({
      helpful: Number(stats?.helpful ?? 0),
      notHelpful: Number(stats?.notHelpful ?? 0),
    });
  } catch (error) {
    return cApiError(c, "Failed to get article stats", error);
  }
});

export default router;
