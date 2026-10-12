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
 * - POST   /admin/announcements/:id/email    — fire the existing email blast; stamps email_sent_at
 */

import { Hono } from "hono";
import { and, eq, isNotNull } from "drizzle-orm";
import { requireAuth } from "../../middleware/nextauth.js";
import { requirePermission, requireSuperAdmin } from "../../middleware/admin-auth.js";
import { dbRead, dbWrite } from "../../db/client.js";
import { announcements, users } from "../../db/schema.js";
import {
  AnnouncementError,
  createAnnouncement,
  deleteAnnouncement,
  endAnnouncement,
  listAnnouncements,
  publishAnnouncement,
  updateAnnouncement,
} from "../../services/announcements.js";
import { sanitizeBlogHtml } from "../../utils/sanitize-html.js";
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
function announcementErrorResponse(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof AnnouncementError)) return null;
  switch (error.code) {
    case "announcements.notFound":
      return cNotFoundError(c, error.message, error, error.code);
    case "announcements.anotherActiveExists":
    case "announcements.locked":
      return cConflictError(c, error.message, error, error.code);
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

/**
 * POST /admin/announcements/:id/email
 *
 * Fires the existing product-announcement blast (same audience filter as
 * `POST /admin/email/announcements`: opted-in, non-new users with an email)
 * using this record's title/body/CTA, then stamps `email_sent_at`.
 * Gated by `requireSuperAdmin` to match `POST /admin/email/announcements`.
 * Body: { dryRun?: boolean, force?: boolean }. Response mirrors the legacy blast endpoint.
 */
router.post("/:id/email", requireAuth, requireSuperAdmin, async (c) => {
  const { id } = c.req.param();
  const invalid = invalidIdResponse(c, id);
  if (invalid) return invalid;
  try {
    const [row] = await dbRead.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!row) return cNotFoundError(c, "Announcement not found", undefined, "announcements.notFound");

    const body = (c.get("body") ?? {}) as { dryRun?: boolean; force?: boolean };

    if (row.emailSentAt && !body.force) {
      return cConflictError(
        c,
        "Email blast was already sent for this announcement. Pass force=true to re-send.",
        undefined,
        "announcements.emailAlreadySent",
      );
    }

    const { normalizeEmailPreferences } = await import("../../services/email-preferences.js");
    const { sendAnnouncementEmail } = await import("../../utils/email.js");

    // Deliberately dbRead: full-table recipient fan-out must not load every
    // user onto the primary (same rationale as POST /admin/email/announcements).
    const rows = await dbRead
      .select({
        userId: users.userId,
        email: users.email,
        emailPreferences: users.emailPreferences,
        isNewUser: users.isNewUser,
      })
      .from(users)
      .where(and(eq(users.isNewUser, false), isNotNull(users.email)));

    const recipients = rows.filter((r) => {
      const prefs = normalizeEmailPreferences(r.emailPreferences);
      return prefs.productAnnouncements && !!r.email;
    });

    if (body.dryRun) {
      return c.json({
        dryRun: true,
        recipientCount: recipients.length,
        title: row.title,
      });
    }

    // bodyHtml wins; the plain-text body is sanitized already, and
    // sanitizeBlogHtml is the repo's defensive wrapper for email HTML.
    const html = row.bodyHtml ?? (await sanitizeBlogHtml(`<p>${row.body}</p>`));
    const cta = row.ctaUrl && row.ctaText ? { url: row.ctaUrl, text: row.ctaText } : undefined;

    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const ok = await sendAnnouncementEmail(r.email, row.title, html, cta, { userId: r.userId });
      if (ok) sent++;
      else failed++;
    }

    if (sent > 0) {
      await dbWrite
        .update(announcements)
        .set({ emailSentAt: new Date() })
        .where(eq(announcements.id, id));
    }

    console.log(
      `[admin] 📢 Announcement email "${row.title}" sent=${sent} failed=${failed} eligible=${recipients.length}`,
    );

    return c.json({
      success: true,
      title: row.title,
      recipientCount: recipients.length,
      sent,
      failed,
    });
  } catch (error) {
    return cApiError(c, "Failed to send announcement", error);
  }
});

export default router;
