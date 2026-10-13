/** Announcement validation, campaign production and safe admin progress; delivery is shared. */
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { dbWrite } from "../db/client.js";
import { emailCampaigns as campaigns, announcements, users } from "../db/schema.js";
import { AnnouncementError } from "./announcements.js";
import { preferencesUrlForLocale } from "./email-preferences.js";
import { isValidUuid } from "../utils/uuid.js";
import { sanitizeBlogHtml } from "../utils/sanitize-html.js";
import { cleanSingleLineText } from "../utils/text-processing.js";
import { getAnnouncementTemplate } from "../config/emails/announcement.js";
import { APP_NAME } from "../config/constants.js";

import type { AnnouncementEmailJob } from "../types/announcement-email.js";
import { dispatchEmailWorkers } from "./email-dispatch.js";
import { ANNOUNCEMENT_TITLE_MAX_LENGTH, ANNOUNCEMENT_BODY_HTML_MAX_LENGTH, ANNOUNCEMENT_CTA_TEXT_MAX_LENGTH } from "../config/announcements.js";
import { emailDeliveryEnabled, EMAIL_WORKERS } from "../config/email-delivery.js";
import { emailContentHash } from "./email-delivery.js";
import { queueEmailCampaign } from "./email-campaigns.js";

type Campaign = typeof campaigns.$inferSelect;

// Literal predicates match partial indexes even when the driver uses a generic prepared plan.
const openCampaigns = sql`${campaigns.status} IN ('queued', 'running')`;
const escapeEmailText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const audienceFilter = and(eq(users.isNewUser, false), isNotNull(users.email),
  sql`COALESCE(${users.emailPreferences}->>'productAnnouncements', 'true') = 'true'`);

/** Avoid accidentally enabling unmigrated jobs, or accepting work with no delivery configuration. */
export function requireAnnouncementEmailJobs(): void {
  if (!emailDeliveryEnabled()) throw new AnnouncementError("announcements.emailUnavailable", "Announcement email delivery is not configured yet.");
}

function toJob(row: Campaign): AnnouncementEmailJob {
  return { jobId: row.id, status: row.status, title: row.title, recipientCount: row.recipientCount,
    sent: row.sent, failed: row.failed, skipped: row.skipped, needsReview: row.needsReview, audienceComplete: row.audienceComplete };
}

/** Authoritative O(1) admin progress lookup; email addresses and rendered content remain private. */
export async function getAnnouncementEmailJob(id: string): Promise<AnnouncementEmailJob> {
  const [row] = await dbWrite.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.type, "announcement"))).limit(1);
  if (!row) throw new AnnouncementError("announcements.notFound", "Email campaign not found.");
  return toJob(row);
}

/** Explicit preview uses an SQL audience count, never a full recipient array in an API request. */
export async function countAnnouncementEmailRecipients(): Promise<number> {
  const [row] = await dbWrite.select({ value: count() }).from(users).where(audienceFilter);
  return row?.value ?? 0;
}

export interface QueueAnnouncementEmailInput {
  announcementId?: string;
  title?: unknown;
  bodyHtml?: unknown;
  cta?: { url: string; text: string };
  force?: boolean;
  requestId?: unknown;
}

/**
 * Primary transaction claims one campaign and snapshots both locale templates.
 * Campaign rows form the durable outbox, drained by the QStash-triggered cron.
 * Normal record retries reuse its permanent request key; deliberate re-sends
 * require a fresh UUID that the caller must reuse on network retries.
 */
export async function queueAnnouncementEmail(input: QueueAnnouncementEmailInput, authorId: string): Promise<AnnouncementEmailJob> {
  requireAnnouncementEmailJobs();
  if (input.requestId !== undefined && !isValidUuid(input.requestId)) throw new AnnouncementError("announcements.validation", "requestId must be a UUID.");
  if (input.force && !isValidUuid(input.requestId)) throw new AnnouncementError("announcements.validation", "A deliberate resend requires an idempotent requestId.");
  const job = await dbWrite.transaction(async tx => {
    // Serialize campaign creation; never hold this across a provider call.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1415008845, 2)`);
    let title = cleanSingleLineText(input.title, ANNOUNCEMENT_TITLE_MAX_LENGTH);
    let bodyHtml = typeof input.bodyHtml === "string" ? input.bodyHtml : "";
    let cta = input.cta;
    if (input.announcementId) {
      const [announcement] = await tx.select().from(announcements).where(eq(announcements.id, input.announcementId)).for("update").limit(1);
      if (!announcement) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
      const [existing] = await tx.select().from(campaigns).where(and(eq(campaigns.announcementId, announcement.id),
        input.force ? eq(campaigns.requestKey, `announcement/${announcement.id}/${input.requestId}`) : eq(campaigns.requestKey, `announcement/${announcement.id}/initial`))).limit(1);
      if (existing) return toJob(existing);
      const [open] = await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.announcementId, announcement.id), openCampaigns)).limit(1);
      if (open) throw new AnnouncementError("announcements.emailInProgress", "An email campaign is already in progress.");
      if (announcement.emailSentAt && !input.force) throw new AnnouncementError("announcements.emailAlreadySent", "This announcement already has an email campaign.");
      title = announcement.title;
      // Escape plain text before treating it as HTML; sanitizer alone is not text escaping.
      bodyHtml = announcement.bodyHtml ?? `<p>${announcement.body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>")}</p>`;
      cta = announcement.ctaUrl && announcement.ctaText ? { url: announcement.ctaUrl, text: announcement.ctaText } : undefined;
    }
    if (!title || !bodyHtml || bodyHtml.length > ANNOUNCEMENT_BODY_HTML_MAX_LENGTH) throw new AnnouncementError("announcements.validation", "A title and bounded HTML body are required.");
    if (cta && (!/^https?:\/\/[^\s]+$/i.test(cta.url) && !(cta.url.startsWith("/") && !cta.url.startsWith("//")))) {
      throw new AnnouncementError("announcements.validation", "Invalid email CTA URL.");
    }
    if (cta) {
      const text = cleanSingleLineText(cta.text, ANNOUNCEMENT_CTA_TEXT_MAX_LENGTH);
      if (!text || cta.url.length > 2048 || /[\s"'<>\\]/.test(cta.url)) throw new AnnouncementError("announcements.validation", "Invalid email CTA.");
      try { cta = { text, url: new URL(cta.url, process.env.FRONTEND_URL || "https://twistloom.com").href }; }
      catch { throw new AnnouncementError("announcements.validation", "Invalid email CTA URL."); }
    }
    const html = await sanitizeBlogHtml(bodyHtml);
    const contentHash = emailContentHash(JSON.stringify({ title, html, cta }));
    const requestKey = input.announcementId ? `announcement/${input.announcementId}/${input.force ? input.requestId : "initial"}` : `legacy/${authorId}/${input.requestId ?? contentHash}`;
    const [existing] = await tx.select().from(campaigns).where(eq(campaigns.requestKey, requestKey)).limit(1);
    if (existing) {
      if (existing.contentHash !== contentHash) throw new AnnouncementError("announcements.validation", "requestId was already used for different content.");
      return toJob(existing);
    }
    const from = process.env.RESEND_FROM_EMAIL || "noreply@twistloom.com";
    const template = (locale: "en" | "id") => ({ from, subject: `${title} — ${APP_NAME}`,
      html: getAnnouncementTemplate(locale, escapeEmailText(APP_NAME), escapeEmailText(title), html,
        cta ? { url: escapeEmailText(cta.url), text: escapeEmailText(cta.text) } : undefined,
        preferencesUrlForLocale(locale)) });
    const campaign = await queueEmailCampaign({ announcementId: input.announcementId,
      requestKey, audience: { kind: "announcement" }, contentHash, title,
      templates: { en: template("en"), id: template("id") }, createdBy: authorId }, tx);
    return toJob(campaign);
  });
  await dispatchEmailWorkers(`queued/${job.jobId}`, EMAIL_WORKERS);
  return job;
}


