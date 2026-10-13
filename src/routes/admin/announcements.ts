/**
 * Admin Announcements Routes
 *
 * CRUD + lifecycle for platform announcements (cap-1 active). All endpoints
 * are gated by the existing `announcements` admin capability — the key has
 * always existed in `ADMIN_PERMISSIONS`, so no permission or nav change is
 * required (ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP.md, Non-Breaking Guarantees).
 *
 * Mounted from `routes/admin.ts` at `/announcements`:
 * - GET    /admin/announcements              — paginated history (status/kind filters)
 * - POST   /admin/announcements              — create draft
 * - PATCH  /admin/announcements/:id          — edit draft/scheduled (locked once active)
 * - POST   /admin/announcements/:id/publish  — activate now or schedule (startsAt)
 * - POST   /admin/announcements/:id/end      — revoke; clears the banner slot
 * - POST   /admin/announcements/:id/email    — queue a durable email campaign
 * - GET    /admin/announcements/email-jobs/:jobId — campaign progress
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middleware/nextauth.js";
import { requirePermission, requireSuperAdmin } from "../../middleware/admin-auth.js";
import { dbWrite } from "../../db/client.js";
import { announcements } from "../../db/schema.js";
import {
  AnnouncementError,
  createAnnouncement,
  deleteAnnouncement,
  endAnnouncement,
  listAnnouncements,
  publishAnnouncement,
  updateAnnouncement,
} from "../../services/announcements.js";
import { countAnnouncementEmailRecipients, getAnnouncementEmailJob, queueAnnouncementEmail, requireAnnouncementEmailJobs } from "../../services/announcement-email.js";
import { isValidUuid } from "../../utils/uuid.js";
import {
  cApiError,
  cConflictError,
  cNotFoundError,
  cUnauthorizedError,
  cValidationError,
} from "../../utils/error.js";
import type { Context } from "hono";
import type { AppEnv } from "../../hono/env.js";

const router = new Hono<AppEnv>();

/** Maps a tagged `AnnouncementError` to its HTTP envelope; rethrows nothing. */
export function announcementErrorResponse(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof AnnouncementError)) return null;
  switch (error.code) {
    case "announcements.notFound":
      return cNotFoundError(c, error.message, error, error.code);
    case "announcements.anotherActiveExists":
    case "announcements.locked":
    case "announcements.emailInProgress":
    case "announcements.emailAlreadySent":
      return cConflictError(c, error.message, error, error.code);
    case "announcements.emailUnavailable":
      return cApiError(c, error.message, error, 503, error.code);
    case "announcements.validation":
    case "announcements.notPublishable":
      return cValidationError(c, error.message, error, 400, error.code);
    default:
      return cValidationError(c, error.message, error, 400, error.code);
  }
}

function invalidIdResponse(c: Context<AppEnv>, id: string) {
  if (isValidUuid(id)) return null;
  return cValidationError(c, "Announcement id is invalid.", undefined, 400, "announcements.validation");
}

/**
 * GET /admin/announcements
 *
 * Paginated history, newest first. Query: `status`, `kind`, `limit`, `offset`.
 * Runs the lifecycle sweep first so expired/due rows report honest chips.
 */
router.get("/", requireAuth, requirePermission("announcements"), async (c) => {
  try {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1), 100);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const result = await listAnnouncements({
      status: c.req.query("status"),
      kind: c.req.query("kind"),
      limit,
      offset,
    });
    return c.json({
      announcements: result.items,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to list announcements", error);
  }
});

/**
 * POST /admin/announcements
 *
 * Creates a draft. Publishing is the separate `/publish` step so drafts never
 * touch the cap-1 invariant. Body: kind, severity, title, body, optional
 * bodyHtml/cta/i18n/schedule fields.
 */
router.post("/", requireAuth, requirePermission("announcements"), async (c) => {
  const userId = c.get("userId");
  if (!userId) return cUnauthorizedError(c, "Authentication required");
  try {
    const body = c.get("body") as Record<string, unknown>;
    const announcement = await createAnnouncement(body ?? {}, userId);
    return c.json({ announcement });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to create announcement", error);
  }
});

/**
 * PATCH /admin/announcements/:id
 *
 * Edits a draft or scheduled announcement; active/ended rows are locked
 * (`announcements.locked`). Scheduled rows keep their banner row in sync.
 */
router.patch("/:id", requireAuth, requirePermission("announcements"), async (c) => {
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    const body = c.get("body") as Record<string, unknown>;
    const announcement = await updateAnnouncement(id, body ?? {});
    return c.json({ announcement });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to update announcement", error);
  }
});

/**
 * POST /admin/announcements/:id/publish
 *
 * Activates now, or schedules for a future `startsAt` (the banner row waits
 * via its own `starts_at` — no scheduler process needed). Enforces the cap-1
 * invariant: a concurrent/other published row fails with
 * `announcements.anotherActiveExists` (409). Body: { startsAt?, expiresAt? }.
 */
router.post("/:id/publish", requireAuth, requirePermission("announcements"), async (c) => {
  const userId = c.get("userId");
  if (!userId) return cUnauthorizedError(c, "Authentication required");
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    const body = (c.get("body") ?? {}) as { startsAt?: unknown; expiresAt?: unknown };
    const announcement = await publishAnnouncement(id, body, userId);
    return c.json({ announcement });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to publish announcement", error);
  }
});

/**
 * POST /admin/announcements/:id/end
 *
 * Revokes: flips status to `ended`, expires the banner row (the active
 * announcement drops to null for every user within one poll), and releases
 * parked user megaphone broadcasts. Idempotent on already-ended rows.
 */
router.post("/:id/end", requireAuth, requirePermission("announcements"), async (c) => {
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    const announcement = await endAnnouncement(id);
    return c.json({ announcement });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to end announcement", error);
  }
});

/**
 * DELETE /admin/announcements/:id
 *
 * Deletes a draft announcement. Locked for scheduled, active, or ended rows.
 */
router.delete("/:id", requireAuth, requirePermission("announcements"), async (c) => {
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    await deleteAnnouncement(id);
    return c.json({ success: true, id });
  } catch (error) {
    const mapped = announcementErrorResponse(c, error);
    if (mapped) return mapped;
    return cApiError(c, "Failed to delete announcement", error);
  }
});

/** Campaign creation returns promptly; the protected cron drains the durable outbox. */
router.post("/:id/email", requireAuth, requireSuperAdmin, async (c) => {
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    requireAnnouncementEmailJobs();
    const body: unknown = c.get("body") ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return cValidationError(c, "Invalid email request");
    }
    const dryRun = "dryRun" in body ? body.dryRun : false;
    const force = "force" in body ? body.force : false;
    const requestId = "requestId" in body ? body.requestId : undefined;
    if (typeof dryRun !== "boolean" || typeof force !== "boolean") return cValidationError(c, "Invalid email options");
    if (dryRun) {
      const [row] = await dbWrite.select({ title: announcements.title }).from(announcements).where(eq(announcements.id, id)).limit(1);
      if (!row) return cNotFoundError(c, "Announcement not found", undefined, "announcements.notFound");
      return c.json({ dryRun: true, title: row.title, recipientCount: await countAnnouncementEmailRecipients() });
    }
    const userId = c.get("userId");
    if (!userId) return cUnauthorizedError(c, "Authentication required");
    const job = await queueAnnouncementEmail({ announcementId: id, force, requestId }, userId);
    return c.json({ success: true, queued: true, ...job }, 202);
  } catch (error) {
    return announcementErrorResponse(c, error) ?? cApiError(c, "Failed to queue announcement", error);
  }
});

router.get("/email-jobs/:jobId", requireAuth, requireSuperAdmin, async (c) => {
  const { jobId } = c.req.param();
  const invalid = invalidIdResponse(c, jobId);
  if (invalid) return invalid;
  try {
    requireAnnouncementEmailJobs();
    c.header("Cache-Control", "private, no-store");
    return c.json(await getAnnouncementEmailJob(jobId));
  } catch (error) {
    return announcementErrorResponse(c, error) ?? cApiError(c, "Failed to read email progress", error);
  }
});

export default router;
