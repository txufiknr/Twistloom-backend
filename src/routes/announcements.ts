/**
 * Announcements Routes (user-facing)
 *
 * Read side of the cap-1 announcement system: the single active announcement
 * plus the per-user unseen flag, the paginated publish history (Announcements
 * tab), and the idempotent seen-state write.
 *
 * Deliberately a parallel collection — announcements are never rows in
 * `user_notifications` (see ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP.md §3.2
 * Alternative D). Active announcement and seen-state endpoints require
 * authentication, while history is a global published list accessible to both
 * authenticated users and guests.
 */

import { Hono } from "hono";
import { optionalAuth, requireAuth } from "../middleware/nextauth.js";
import {
  AnnouncementError,
  getUserAnnouncementState,
  listUserAnnouncementHistory,
  markAnnouncementSeen,
} from "../services/announcements.js";
import { isValidUuid } from "../utils/uuid.js";
import { calculatePaginationMeta, createPaginatedResponse, extractPaginationParams } from "../utils/pagination.js";
import { cApiError, cNotFoundError, cUnauthorizedError, cValidationError } from "../utils/error.js";
import type { AppEnv } from "../hono/env.js";

const router = new Hono<AppEnv>();

/** Default page size for the announcement-history list (panel tab). */
const HISTORY_DEFAULT_LIMIT = 20;

/**
 * GET /api/announcements
 *
 * The single active announcement (cap-1), with the unseen flag derived from
 * `users.last_seen_announcement_id` when authenticated (or unseen=false for guests).
 * Returns `{ announcement: null, unseen: false }` when nothing is live — draft and
 * ended rows are never exposed. Accessible to both authenticated users and guests.
 */
router.get("/", optionalAuth, async (c) => {
  const userId = c.get("userId");
  try {
    const state = await getUserAnnouncementState(userId);
    return c.json(state);
  } catch (error) {
    return cApiError(c, "Failed to load announcement", error);
  }
});

/**
 * GET /api/announcements/history?page=&limit=
 *
 * Page-number paginated history of every published, started announcement
 * (newest first) — the data behind the Announcements tab of the notification
 * center. Cap-1 limits only the live slot; this list is bounded purely by
 * how many announcements have been published. Accessible to both authenticated
 * users and guests.
 */
router.get("/history", optionalAuth, async (c) => {
  try {
    const { page = 1, limit = HISTORY_DEFAULT_LIMIT } = extractPaginationParams(c.req.query(), HISTORY_DEFAULT_LIMIT);
    const { items, totalCount } = await listUserAnnouncementHistory(page, limit);
    return c.json(createPaginatedResponse(items, calculatePaginationMeta(page, limit, totalCount), "announcements"));
  } catch (error) {
    return cApiError(c, "Failed to load announcement history", error);
  }
});

/**
 * POST /api/announcements/:id/seen
 *
 * Idempotent seen-state write — one rare, tiny UPDATE on the caller's own
 * `users` row. Repeated calls simply re-point the same column.
 */
router.post("/:id/seen", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!userId) return cUnauthorizedError(c, "Authentication required");

  const { id } = c.req.param();
  if (!isValidUuid(id)) {
    return cValidationError(c, "Announcement id is invalid.", undefined, 400, "announcements.validation");
  }

  try {
    await markAnnouncementSeen(userId, id);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof AnnouncementError) {
      return cNotFoundError(c, error.message, error, error.code);
    }
    return cApiError(c, "Failed to mark announcement seen", error);
  }
});

export default router;
