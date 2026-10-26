/** Bounded shared campaign enumeration and progress. EMAIL_DELIVERY_ARCHITECTURE.md §5. */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite, type DBTransaction } from "../db/client.js";
import { emailCampaigns as campaigns, emailMessages as messages, users, userFollows, userAuth, books, userCompletedBooks, userLikes, announcements } from "../db/schema.js";
import { NOTIFICATION_I18N_KEYS } from "../config/notifications.js";
import { createNotificationsBatch, type InsertNotificationParams } from "./notifications.js";
import { EMAIL_AUDIENCE_BATCH, EMAIL_LEASE_MS, EMAIL_POLICIES } from "../config/email-delivery.js";
import { DEFAULT_EMAIL_LOCALE, isEmailLocale } from "../types/email-locale.js";
import type { EmailAudience, EmailTemplate } from "../types/email-delivery.js";
import type { EmailLocale } from "../types/email-locale.js";
import { generateId } from "../utils/uuid.js";
import { encryptPII } from "../utils/crypto.js";
import { requireEmailDelivery, emailContentHash } from "./email-delivery.js";
import { normalizeEmailPreferences, preferencesUrlForLocale } from "./email-preferences.js";
import { normalizeInAppPreferences } from "./in-app-preferences.js";
import { APP_NAME } from "../config/constants.js";
import { getWeeklyRecommendationsTemplate, getMonthlyActivityTemplate, getStoryPublishedTemplate } from "../config/emails/index.js";
import { t, emailLocalePathPrefix } from "../config/emails/i18n.js";
import { dispatchEmailWorkers } from "./email-dispatch.js";

type Campaign = typeof campaigns.$inferSelect;
export interface QueueCampaignInput {
  requestKey: string; audience: EmailAudience; title: string;
  templates?: Partial<Record<EmailLocale, EmailTemplate>>; announcementId?: string; createdBy?: string;
  /** Domain fingerprint for replay validation; defaults to the frozen rendering input. */
  contentHash?: string;
}
/** Persist one immutable event/period snapshot; callers own domain validation and post-commit dispatch. */
export async function queueEmailCampaign(input: QueueCampaignInput, tx?: DBTransaction): Promise<Campaign> {
  requireEmailDelivery();
  if (!input.requestKey || input.requestKey.length > 256) throw new Error("Invalid email campaign request key");
  if (input.announcementId && input.audience.kind !== "announcement") throw new Error("Only announcement campaigns can link an announcement");
  const connection = tx ?? dbWrite;
  const contentHash = input.contentHash ?? emailContentHash(JSON.stringify({ audience: input.audience, templates: input.templates, title: input.title }));
  const [created] = await connection.insert(campaigns).values({ id: generateId(), requestKey: input.requestKey,
    type: input.audience.kind, audience: input.audience, title: input.title, contentHash, templates: input.templates ?? {},
    announcementId: input.announcementId ?? null, createdBy: input.createdBy ?? null,
    expiresAt: new Date(Date.now() + EMAIL_POLICIES[input.audience.kind].lifetimeMs), nextRunAt: new Date(),
    status: "queued", audienceComplete: false, recipientCount: 0, pendingCount: 0, sent: 0, failed: 0, skipped: 0, needsReview: 0 })
    .onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await connection.select().from(campaigns).where(eq(campaigns.requestKey, input.requestKey)).limit(1);
  if (!existing) throw new Error("Email campaign conflict without receipt");
  if (existing.type !== input.audience.kind || existing.announcementId !== (input.announcementId ?? null)) {
    throw new Error("Email campaign request key belongs to another identity");
  }
  // Period/event identity wins over changing recommendations on repeated scheduler deliveries.
  return existing;
}

export async function queueWeeklyEmailCampaign(now = new Date()): Promise<string> {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const top = await dbWrite.select({ title: books.title, slug: books.slug, id: books.id }).from(books)
    .where(and(eq(books.status, "active"), eq(books.visibility, "public"))).orderBy(desc(books.trendingScore), asc(books.id)).limit(5);
  const base = process.env.FRONTEND_URL?.replace(/\/$/, "") ?? "https://twistloom.com";
  return (await queueEmailCampaign({ requestKey: `weekly/${monday.toISOString().slice(0, 10)}`, title: "Weekly recommendations",
    audience: { kind: "weekly", books: top.map(book => ({ title: book.title, url: `${base}/books/${book.slug || book.id}` })) } })).id;
}
export async function queueMonthlyEmailCampaign(now = new Date()): Promise<string> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const label = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return (await queueEmailCampaign({ requestKey: `monthly/${start.toISOString().slice(0, 7)}`, title: `Monthly summary ${label}`,
    audience: { kind: "monthly", start: start.toISOString(), end: end.toISOString(), label } })).id;
}

async function enumerate(campaign: Campaign): Promise<void> {
  if (campaign.audienceComplete || campaign.expiresAt <= new Date()) return;
  await dbWrite.transaction(async tx => {
    const [owned] = await tx.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.id, campaign.id), eq(campaigns.leaseToken, campaign.leaseToken ?? ""))).for("update").limit(1);
    if (!owned) return;
    const audience = campaign.audience;
    // Delayed fan-out must not notify about a book that left public since the
    // campaign was queued. One primary read per slice; already-queued pending
    // recipients are suppressed at send time by the delivery eligibility check.
    // Closing the cursor here stops future pages without touching counters —
    // completion derives from audienceComplete + zero pending.
    if (audience.kind === "story_published") {
      const [book] = await tx.select({ status: books.status, visibility: books.visibility }).from(books).where(eq(books.id, audience.bookId)).limit(1);
      if (!book || book.status !== "active" || book.visibility !== "public") {
        await tx.update(campaigns).set({ audienceComplete: true }).where(eq(campaigns.id, campaign.id));
        return;
      }
    }
    const following = audience.kind === "story_published"
      ? inArray(users.userId, tx.select({ id: userFollows.followerId }).from(userFollows).where(eq(userFollows.followingId, audience.authorId))) : undefined;
    // Include opted-out followers for their independent in-app channel; other campaigns filter their email category.
    const preference = EMAIL_POLICIES[audience.kind].preference;
    const filter = audience.kind === "story_published" ? undefined
      : preference ? sql`COALESCE(${users.emailPreferences}->>${preference}, 'true') = 'true'` : undefined;
    const rows = await tx.select({ userId: users.userId, email: users.email, name: users.name, preferredLocale: users.preferredLocale,
      emailPreferences: users.emailPreferences, inAppPreferences: users.inAppPreferences }).from(users)
      .where(and(eq(users.isNewUser, false), audience.kind === "story_published" ? undefined : isNotNull(users.email),
        lte(users.createdAt, campaign.createdAt), campaign.audienceCursor ? gt(users.userId, campaign.audienceCursor) : undefined, following, filter))
      .orderBy(asc(users.userId)).limit(EMAIL_AUDIENCE_BATCH);
    const ids = rows.map(row => row.userId);
    // Three aggregate queries per PAGE, rather than three per recipient. Empty pages issue none.
    const monthly = audience.kind === "monthly" && ids.length ? await Promise.all([
      tx.select({ userId: books.userId, total: sql<number>`count(*)::int` }).from(books).where(and(inArray(books.userId, ids),
        sql`${books.createdAt} >= ${audience.start}::timestamptz AND ${books.createdAt} < ${audience.end}::timestamptz`)).groupBy(books.userId),
      tx.select({ userId: userCompletedBooks.userId, total: sql<number>`count(*)::int` }).from(userCompletedBooks).where(and(inArray(userCompletedBooks.userId, ids),
        sql`${userCompletedBooks.completedAt} >= ${audience.start}::timestamptz AND ${userCompletedBooks.completedAt} < ${audience.end}::timestamptz`)).groupBy(userCompletedBooks.userId),
      tx.select({ userId: userLikes.userId, total: sql<number>`count(*)::int` }).from(userLikes).where(and(inArray(userLikes.userId, ids),
        sql`${userLikes.createdAt} >= ${audience.start}::timestamptz AND ${userLikes.createdAt} < ${audience.end}::timestamptz`)).groupBy(userLikes.userId),
    ]) : null;
    const verified = audience.kind === "story_published" && ids.length
      ? new Set((await tx.select({ userId: userAuth.userId }).from(userAuth).where(and(inArray(userAuth.userId, ids), isNotNull(userAuth.emailVerified)))).map(row => row.userId)) : null;
    const pending: Array<typeof messages.$inferInsert> = [];
    const notifications: InsertNotificationParams[] = [];
    for (const row of rows) {
      if (audience.kind === "story_published" && normalizeInAppPreferences(row.inAppPreferences).storyPublished) notifications.push({
        userId: row.userId, type: "story_published", fallbackTitle: "New story from someone you follow", fallbackMessage: audience.bookTitle,
        i18nKey: NOTIFICATION_I18N_KEYS.STORY_PUBLISHED,
        i18nParams: { bookTitle: audience.bookTitle, authorId: audience.authorId, bookSlug: audience.bookSlug, authorName: audience.authorName ?? "" },
        data: { authorId: audience.authorId, bookId: audience.bookId, bookSlug: audience.bookSlug, bookTitle: audience.bookTitle, authorName: audience.authorName },
      });
      const prefs = normalizeEmailPreferences(row.emailPreferences);
      if (!row.email || (preference && !prefs[preference]) || (verified && !verified.has(row.userId))) continue;
      const locale = prefs.emailLocale ?? (isEmailLocale(row.preferredLocale) ? row.preferredLocale : DEFAULT_EMAIL_LOCALE);
      let template: EmailTemplate | undefined = campaign.templates[locale];
      if (audience.kind === "weekly") {
        if (!audience.books.length) continue;
        template = { from: process.env.RESEND_FROM_EMAIL || "noreply@twistloom.com", subject: t(locale, "weekly.subject", { appName: APP_NAME }),
          html: getWeeklyRecommendationsTemplate(locale, APP_NAME, row.name || "there", audience.books, preferencesUrlForLocale(locale)) };
      } else if (audience.kind === "monthly") {
        const stats = { booksCreated: monthly?.[0].find(item => item.userId === row.userId)?.total ?? 0,
          booksCompleted: monthly?.[1].find(item => item.userId === row.userId)?.total ?? 0,
          likesGiven: monthly?.[2].find(item => item.userId === row.userId)?.total ?? 0, pagesRead: 0 };
        if (!stats.booksCreated && !stats.booksCompleted && !stats.likesGiven) continue;
        template = { from: process.env.RESEND_FROM_EMAIL || "noreply@twistloom.com", subject: t(locale, "monthly.subject", { appName: APP_NAME, month: audience.label }),
          html: getMonthlyActivityTemplate(locale, APP_NAME, row.name || "there", audience.label, stats, preferencesUrlForLocale(locale)) };
      } else if (audience.kind === "story_published") {
        const base = process.env.FRONTEND_URL?.replace(/\/$/, "") ?? "https://twistloom.com";
        template = { from: process.env.RESEND_FROM_EMAIL || "noreply@twistloom.com", subject: t(locale, "storyPublished.subject", { appName: APP_NAME }),
          html: getStoryPublishedTemplate(locale, APP_NAME, row.name || "there", audience.authorName, audience.bookTitle,
            `${base}${emailLocalePathPrefix(locale)}/books/${encodeURIComponent(audience.bookSlug)}`, preferencesUrlForLocale(locale)) };
      }
      if (!template) throw new Error("Campaign has no frozen template for recipient locale");
      pending.push({ id: generateId(), campaignId: campaign.id, userId: row.userId, requestKey: `campaign/${campaign.id}/${row.userId}`,
        type: audience.kind, priority: 2, locale, recipientEncrypted: audience.kind === "announcement" ? await encryptPII(row.email) : null,
        payloadEncrypted: audience.kind === "announcement" ? null : await encryptPII(JSON.stringify({ ...template, to: row.email })),
        status: "pending", attempts: 0, ambiguous: false, nextAttemptAt: new Date(), expiresAt: campaign.expiresAt });
    }
    if (notifications.length) await createNotificationsBatch(notifications, tx);
    const inserted = pending.length ? await tx.insert(messages).values(pending).onConflictDoNothing().returning({ id: messages.id }) : [];
    await tx.update(campaigns).set({ audienceCursor: rows.at(-1)?.userId ?? campaign.audienceCursor,
      audienceComplete: rows.length < EMAIL_AUDIENCE_BATCH, recipientCount: sql`${campaigns.recipientCount} + ${inserted.length}`,
      pendingCount: sql`${campaigns.pendingCount} + ${inserted.length}` }).where(eq(campaigns.id, campaign.id));
  });
}

export async function processEmailCampaigns(inAppOnly = false): Promise<void> {
  requireEmailDelivery();
  const now = new Date();
  const campaign = await dbWrite.transaction(async tx => {
    const [row] = await tx.select().from(campaigns).where(and(sql`${campaigns.status} IN ('queued', 'running')`,
      inAppOnly ? eq(campaigns.type, "story_published") : undefined,
      lte(campaigns.nextRunAt, now), or(isNull(campaigns.leaseExpiresAt), lte(campaigns.leaseExpiresAt, now))))
      .orderBy(asc(campaigns.nextRunAt), asc(campaigns.createdAt), asc(campaigns.id)).for("update", { skipLocked: true }).limit(1);
    if (!row) return null;
    const [claimed] = await tx.update(campaigns).set({ status: "running", leaseToken: generateId(), leaseExpiresAt: new Date(now.getTime() + EMAIL_LEASE_MS) })
      .where(eq(campaigns.id, row.id)).returning(); return claimed ?? null;
  });
  if (!campaign) return;
  await enumerate(campaign);
  await dbWrite.transaction(async tx => {
    // Match deletion's announcement -> campaign ordering; message reads below acquire no row locks.
    if (campaign.announcementId) await tx.select({ id: announcements.id }).from(announcements)
      .where(eq(announcements.id, campaign.announcementId)).for("update").limit(1);
    const [current] = await tx.select().from(campaigns).where(and(eq(campaigns.id, campaign.id), eq(campaigns.leaseToken, campaign.leaseToken ?? ""))).for("update").limit(1);
    if (!current) return;
    const expired = current.expiresAt <= new Date();
    const done = (current.audienceComplete || expired) && current.pendingCount === 0;
    await tx.update(campaigns).set({ audienceComplete: current.audienceComplete || expired,
      status: done ? (current.failed || current.needsReview ? "completed_with_errors" : "completed") : "queued",
      completedAt: done ? new Date() : null, nextRunAt: new Date(Date.now() + (current.audienceComplete ? 30_000 : 0)), leaseToken: null, leaseExpiresAt: null })
      .where(eq(campaigns.id, campaign.id));
    if (done && current.announcementId) await tx.update(announcements).set({ emailSentAt: new Date() }).where(eq(announcements.id, current.announcementId));
  });
  const [next] = await dbWrite.select({ nextRunAt: campaigns.nextRunAt }).from(campaigns)
    .where(and(sql`${campaigns.status} IN ('queued', 'running')`, inAppOnly ? eq(campaigns.type, "story_published") : undefined,
      or(isNull(campaigns.leaseExpiresAt), lte(campaigns.leaseExpiresAt, new Date()))))
    .orderBy(asc(campaigns.nextRunAt), asc(campaigns.id)).limit(1);
  if (next) await dispatchEmailWorkers(`campaign-slice/${campaign.id}/${campaign.leaseToken}`, 1, next.nextRunAt);
}
