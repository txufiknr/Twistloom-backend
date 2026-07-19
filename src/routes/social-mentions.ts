/**
 * @overview Public Social Mentions Routes
 *
 * Exposes the curated social-proof wall for the public homepage. Unlike the
 * admin endpoints (which live under `/admin/social-mentions` and require system
 * admin privileges), these routes are completely public and unauthenticated.
 *
 * Only mentions that have been both approved AND featured by an admin are
 * returned, so raw auto-ingested or rejected content can never leak to users.
 *
 * Endpoints:
 * - GET /social-mentions - List featured, approved social mentions for the wall
 */

import type { Request, Response, Router as RouterType } from "express";
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { handleApiError, handleValidationError } from "../utils/error.js";
import { dbRead } from "../db/client.js";
import { socialMentions } from "../db/schema.js";

const router: RouterType = Router();

/**
 * GET /social-mentions
 *
 * Public homepage social-proof wall. Returns social mentions that an admin has
 * approved and featured, ordered by relevance score (highest first) then
 * publication date. Mirrors the curated SQL:
 *
 * ```sql
 * SELECT *
 * FROM social_mentions
 * WHERE status = 'approved' AND featured = true
 * ORDER BY relevance_score DESC, published_at DESC;
 * ```
 *
 * This endpoint is intentionally unauthenticated — it powers the marketing
 * wall and must be cheap and cacheable on the client (ISR / unstable_cache).
 *
 * @param limit - Maximum rows to return (default: 20, max: 100)
 * @returns Array of featured social mentions
 */
router.get("/social-mentions",
  async (req: Request, res: Response) => {
    try {
      const { limit = "20" } = req.query;
      const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);

      const rows = await dbRead
        .select()
        .from(socialMentions)
        .where(and(
          eq(socialMentions.status, "approved"),
          eq(socialMentions.featured, true),
        ))
        .orderBy(desc(socialMentions.relevanceScore), desc(socialMentions.publishedAt))
        .limit(limitNum);

      res.json({ mentions: rows });
    } catch (error) {
      handleApiError(res, "Failed to retrieve social mentions", error);
    }
  }
);

/**
 * GET /social-mentions/:id
 *
 * Public single mention lookup for the wall (same visibility rules as the
 * list: only approved + featured mentions are returned).
 *
 * @param id - Social mention identifier
 * @returns The featured social mention row, or 404 if not public
 */
router.get("/social-mentions/:id",
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const mentionId = Array.isArray(id) ? id[0] : id;

      const [mention] = await dbRead
        .select()
        .from(socialMentions)
        .where(and(
          eq(socialMentions.id, mentionId),
          eq(socialMentions.status, "approved"),
          eq(socialMentions.featured, true),
        ))
        .limit(1);

      if (!mention) {
        return handleValidationError(res, "Social mention not found", undefined, 404);
      }

      res.json(mention);
    } catch (error) {
      handleApiError(res, "Failed to retrieve social mention", error);
    }
  }
);

export default router;
