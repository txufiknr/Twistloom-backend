/**
 * Email Utilities
 *
 * Provides transactional email sending via Resend. Templates are locale-aware
 * (C+D hybrid: emailLocale override ?? preferredLocale ?? en).
 *
 * Delivery uses the shared durable outbox. Always await persistence.
 */

import { type DBTransaction } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { EmailType } from '../types/email-delivery.js';
import { queueEmailMessage, deliverEmailNow } from '../services/email-delivery.js';
import { dispatchEmailWorkers } from '../services/email-dispatch.js';
import { emailDeliveryEnabled } from '../config/email-delivery.js';
import { APP_NAME } from '../config/constants.js';
import {
  getPasswordResetTemplate,
  getVerificationTemplate,
  getWelcomeTemplate,
  getTrialEndingTemplate,
  getFeedbackAcknowledgmentTemplate,
  getPasswordChangedTemplate,
  getEmailChangedTemplate,
  getAccountDeletedTemplate,
  getPaymentFailedTemplate,
  getRefundProcessedTemplate,
  getSubscriptionCanceledTemplate,
  getFeedbackInternalTemplate,
  getWeeklyRecommendationsTemplate,
  getMonthlyActivityTemplate,
  getAnnouncementTemplate,
  getStoryPublishedTemplate,
  type FeedbackInternalTemplateParams,
  type RecommendedBookEmailItem,
  type MonthlyActivityStats,
} from '../config/emails/index.js';
import { t, emailLocalePathPrefix } from '../config/emails/i18n.js';

import {
  resolveEmailLocale,
  resolveEmailLocaleByEmail,
  preferencesUrlForLocale,
} from '../services/email-preferences.js';
import {
  DEFAULT_EMAIL_LOCALE,
  isEmailLocale,
  type EmailLocale,
} from '../types/email-locale.js';

// ---------------------------------------------------------------------------
// Client initialisation
// ---------------------------------------------------------------------------

const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@twistloom.com';

// ---------------------------------------------------------------------------
// Shared send helper
// ---------------------------------------------------------------------------

export interface EmailSendOptions {
  userId?: string; locale?: EmailLocale; tx?: DBTransaction; requestKey?: string;
  expiresAt?: Date; credentialHash?: string; enqueueOnly?: boolean;
}
interface SendEmailOptions { to: string; subject: string; html: string; from?: string; type: EmailType; locale: EmailLocale; context?: EmailSendOptions }
/** Templates may enqueue inside domain transactions; provider calls happen only after commit. */
async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!emailDeliveryEnabled()) return false;
  const { context, type, locale, ...content } = options;
  if (!context?.requestKey) throw new Error('Email producer requires a stable requestKey');
  const id = await queueEmailMessage({ type, locale, payload: { ...content, from: content.from ?? DEFAULT_FROM_EMAIL },
    requestKey: context.requestKey, userId: context.userId,
    expiresAt: context?.expiresAt, credentialHash: context?.credentialHash }, context?.tx);
  if (context?.tx) return false;
  if (context?.enqueueOnly) { await dispatchEmailWorkers(`message/${id}`); return false; }
  return (await deliverEmailNow(id)).status === 'sent';
}
/** Formats optional security context for password/email-change mails */
export function formatSecurityDetailHtml(opts?: {
  at?: Date;
  ip?: string | null;
  userAgent?: string | null;
  locale?: EmailLocale;
}): string {
  if (!opts) return '';
  const tag = opts.locale === 'id' ? 'id-ID' : 'en-US';
  const parts: string[] = [];
  if (opts.at) {
    parts.push(
      opts.at.toLocaleString(tag, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC',
    );
  }
  if (opts.ip) parts.push(`IP: ${opts.ip}`);
  if (opts.userAgent) {
    const ua = opts.userAgent.length > 120 ? `${opts.userAgent.slice(0, 117)}...` : opts.userAgent;
    parts.push(`Device: ${ua}`);
  }
  if (parts.length === 0) return '';
  return `<p style="color: #6b7280; font-size: 14px;">${parts.join('<br/>')}</p>`;
}

/** Masks email for security notifications (keeps domain readable) */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  if (local.length <= 2) return `*@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 4))}@${domain}`;
}

async function localeForUser(userId?: string | null, tx?: DBTransaction): Promise<EmailLocale> {
  if (!userId) return DEFAULT_EMAIL_LOCALE;
  try {
    if (tx) {
      const [row] = await tx.select({ preferredLocale: users.preferredLocale, emailPreferences: users.emailPreferences }).from(users).where(eq(users.userId, userId)).limit(1);
      const prefs = row?.emailPreferences;
      const override = prefs && typeof prefs === 'object' && 'emailLocale' in prefs ? prefs.emailLocale : null;
      return isEmailLocale(override) ? override : isEmailLocale(row?.preferredLocale) ? row.preferredLocale : DEFAULT_EMAIL_LOCALE;
    }
    return await resolveEmailLocale(userId);
  } catch {
    return DEFAULT_EMAIL_LOCALE;
  }
}

async function localeForEmail(email: string): Promise<EmailLocale> {
  try {
    return await resolveEmailLocaleByEmail(email);
  } catch {
    return DEFAULT_EMAIL_LOCALE;
  }
}

function coerceLocale(locale?: EmailLocale | string | null): EmailLocale {
  return isEmailLocale(locale) ? locale : DEFAULT_EMAIL_LOCALE;
}

// ---------------------------------------------------------------------------
// Auth / lifecycle
// ---------------------------------------------------------------------------

export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'password_reset', locale, context: opts,
    to: email,
    subject: t(locale, 'passwordReset.subject', { appName: APP_NAME }),
    html: getPasswordResetTemplate(locale, APP_NAME, resetUrl),
  });
}

export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
  otpCode?: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'verification', locale, context: opts,
    to: email,
    subject: t(locale, 'verification.subject', { appName: APP_NAME }),
    html: getVerificationTemplate(locale, APP_NAME, verificationUrl, otpCode),
  });
}

export async function sendWelcomeEmail(
  email: string,
  username: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'welcome', locale, context: opts,
    to: email,
    subject: t(locale, 'welcome.subject', { appName: APP_NAME }),
    html: getWelcomeTemplate(locale, APP_NAME, username),
  });
}

export async function sendPasswordChangedEmail(
  email: string,
  name: string,
  detailHtml?: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'password_changed', locale, context: opts,
    to: email,
    subject: t(locale, 'passwordChanged.subject', { appName: APP_NAME }),
    html: getPasswordChangedTemplate(locale, APP_NAME, name, detailHtml),
  });
}

export async function sendEmailChangedAlertEmail(
  oldEmail: string,
  name: string,
  newEmail: string,
  detailHtml?: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(oldEmail);
  return sendEmail({
    type: 'email_changed', locale, context: opts,
    to: oldEmail,
    subject: t(locale, 'emailChanged.subject', { appName: APP_NAME }),
    html: getEmailChangedTemplate(locale, APP_NAME, name, maskEmail(newEmail), detailHtml),
  });
}

export async function sendAccountDeletedEmail(
  email: string,
  name: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale ? coerceLocale(opts.locale) : await localeForEmail(email);
  return sendEmail({
    type: 'account_deleted', locale, context: opts,
    to: email,
    subject: t(locale, 'accountDeleted.subject', { appName: APP_NAME }),
    html: getAccountDeletedTemplate(locale, APP_NAME, name),
  });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export async function sendTrialEndingEmail(
  email: string,
  name: string,
  trialEndDate: Date,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'trial_ending', locale, context: opts,
    to: email,
    subject: t(locale, 'trialEnding.subject', { appName: APP_NAME }),
    html: getTrialEndingTemplate(locale, APP_NAME, name, trialEndDate),
  });
}

export async function sendPaymentFailedEmail(
  email: string,
  name: string,
  portalUrl?: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'payment_failed', locale, context: opts,
    to: email,
    subject: t(locale, 'paymentFailed.subject', { appName: APP_NAME }),
    html: getPaymentFailedTemplate(locale, APP_NAME, name, portalUrl),
  });
}

export async function sendRefundProcessedEmail(
  email: string,
  name: string,
  creditsDeducted: number,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'refund', locale, context: opts,
    to: email,
    subject: t(locale, 'refund.subject', { appName: APP_NAME }),
    html: getRefundProcessedTemplate(locale, APP_NAME, name, creditsDeducted),
  });
}

export async function sendSubscriptionCanceledEmail(
  email: string,
  name: string,
  accessEndsAt?: Date,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'subscription_canceled', locale, context: opts,
    to: email,
    subject: t(locale, 'subCanceled.subject', { appName: APP_NAME }),
    html: getSubscriptionCanceledTemplate(locale, APP_NAME, name, accessEndsAt),
  });
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export async function sendFeedbackAcknowledgmentEmail(
  email: string,
  name: string,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'feedback_ack', locale, context: opts,
    to: email,
    subject: t(locale, 'feedbackAck.subject', { appName: APP_NAME }),
    html: getFeedbackAcknowledgmentTemplate(locale, APP_NAME, name),
  });
}

export async function sendFeedbackInternalEmail(
  to: string,
  params: Omit<FeedbackInternalTemplateParams, 'appName'>,
  opts?: EmailSendOptions,
): Promise<boolean> {
  // Ops inbox stays English
  return sendEmail({
    type: 'feedback_internal', locale: DEFAULT_EMAIL_LOCALE, context: opts,
    to,
    subject: `[Feedback] ${params.category} — ${APP_NAME}`,
    html: getFeedbackInternalTemplate({ ...params, appName: APP_NAME }),
  });
}

// ---------------------------------------------------------------------------
// Engagement (preference-gated by callers)
// ---------------------------------------------------------------------------

export async function sendWeeklyRecommendationsEmail(
  email: string,
  name: string,
  books: RecommendedBookEmailItem[],
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'weekly', locale, context: opts,
    to: email,
    subject: t(locale, 'weekly.subject', { appName: APP_NAME }),
    html: getWeeklyRecommendationsTemplate(
      locale,
      APP_NAME,
      name,
      books,
      preferencesUrlForLocale(locale),
    ),
  });
}

export async function sendMonthlyActivityEmail(
  email: string,
  name: string,
  monthLabel: string,
  stats: MonthlyActivityStats,
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'monthly', locale, context: opts,
    to: email,
    subject: t(locale, 'monthly.subject', { appName: APP_NAME, month: monthLabel }),
    html: getMonthlyActivityTemplate(
      locale,
      APP_NAME,
      name,
      monthLabel,
      stats,
      preferencesUrlForLocale(locale),
    ),
  });
}

export async function sendAnnouncementEmail(
  email: string,
  title: string,
  bodyHtml: string,
  cta?: { url: string; text: string },
  opts?: EmailSendOptions,
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId, opts.tx)
      : await localeForEmail(email);
  return sendEmail({
    type: 'announcement', locale, context: opts,
    to: email,
    subject: `${title} — ${APP_NAME}`,
    html: getAnnouncementTemplate(
      locale,
      APP_NAME,
      title,
      bodyHtml,
      cta,
      preferencesUrlForLocale(locale),
    ),
  });
}

// ---------------------------------------------------------------------------
// Follower engagement: new story published by a followed author
// ---------------------------------------------------------------------------

interface SendStoryPublishedEmailOptions extends EmailSendOptions {
  /** Recipient (follower) email */
  to: string;
  /** Recipient display name */
  name: string;
  /** Author (publisher) display name */
  authorName: string;
  /** Published book title */
  bookTitle: string;
  /** Published book slug (for the deep link) */
  bookSlug: string;
  /** Recipient user id (for locale resolution + preferences deep link) */
  userId: string;
  /** Optional explicit locale override */
  locale?: EmailLocale;
}

export async function sendStoryPublishedEmail(
  opts: SendStoryPublishedEmailOptions,
): Promise<boolean> {
  const locale = opts.locale
    ? coerceLocale(opts.locale)
    : await localeForUser(opts.userId, opts.tx);

  const base = process.env.FRONTEND_URL?.replace(/\/$/, '') ?? '';
  const prefix = emailLocalePathPrefix(locale);
  const bookUrl = `${base}${prefix}/books/${encodeURIComponent(opts.bookSlug)}`;

  return sendEmail({
    type: 'story_published', locale, context: opts,
    to: opts.to,
    subject: t(locale, 'storyPublished.subject', { appName: APP_NAME }),
    html: getStoryPublishedTemplate(
      locale,
      APP_NAME,
      opts.name,
      opts.authorName,
      opts.bookTitle,
      bookUrl,
      preferencesUrlForLocale(locale),
    ),
  });
}
