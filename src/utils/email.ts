/**
 * Email Utilities
 *
 * Provides transactional email sending via Resend. Templates are locale-aware
 * (C+D hybrid: emailLocale override ?? preferredLocale ?? en).
 *
 * Use {@link sendEmailSafe} for fire-and-forget best-effort sends.
 */

import { Resend } from 'resend';
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
import { getErrorMessage } from './error.js';
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

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured; unable to send email');
  }

  resendClient = new Resend(apiKey);
  return resendClient;
}

const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@twistloom.com';

// ---------------------------------------------------------------------------
// Shared send helper
// ---------------------------------------------------------------------------

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const { to, subject, html, from } = options;

  try {
    const { error } = await getResendClient().emails.send({
      from: from ?? DEFAULT_FROM_EMAIL,
      to,
      subject,
      html,
    });

    if (error) {
      console.error(`[sendEmail] ❌ Resend API error for "${subject}" to ${to}:`, error);
      return false;
    }

    console.log(`[sendEmail] ✅ "${subject}" sent to ${to}`);
    return true;
  } catch (error) {
    console.error(`[sendEmail] ❌ Failed to send "${subject}" to ${to}:`, error);
    return false;
  }
}

/**
 * Best-effort fire-and-forget wrapper for route/service call sites.
 */
export function sendEmailSafe(label: string, sendFn: () => Promise<boolean>): void {
  void (async () => {
    try {
      const sent = await sendFn();
      if (!sent) {
        console.error(`[${label}] ❌ Email send returned false`);
      }
    } catch (error) {
      console.error(`[${label}] ❌ Email send failed:`, getErrorMessage(error));
    }
  })();
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

async function localeForUser(userId?: string | null): Promise<EmailLocale> {
  if (!userId) return DEFAULT_EMAIL_LOCALE;
  try {
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'passwordReset.subject', { appName: APP_NAME }),
    html: getPasswordResetTemplate(locale, APP_NAME, resetUrl),
  });
}

export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
  otpCode?: string,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'verification.subject', { appName: APP_NAME }),
    html: getVerificationTemplate(locale, APP_NAME, verificationUrl, otpCode),
  });
}

export async function sendWelcomeEmail(
  email: string,
  username: string,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'welcome.subject', { appName: APP_NAME }),
    html: getWelcomeTemplate(locale, APP_NAME, username),
  });
}

export async function sendPasswordChangedEmail(
  email: string,
  name: string,
  detailHtml?: string,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(oldEmail);
  return sendEmail({
    to: oldEmail,
    subject: t(locale, 'emailChanged.subject', { appName: APP_NAME }),
    html: getEmailChangedTemplate(locale, APP_NAME, name, maskEmail(newEmail), detailHtml),
  });
}

export async function sendAccountDeletedEmail(
  email: string,
  name: string,
  opts?: { locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale ? coerceLocale(opts.locale) : await localeForEmail(email);
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'trialEnding.subject', { appName: APP_NAME }),
    html: getTrialEndingTemplate(locale, APP_NAME, name, trialEndDate),
  });
}

export async function sendPaymentFailedEmail(
  email: string,
  name: string,
  portalUrl?: string,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'paymentFailed.subject', { appName: APP_NAME }),
    html: getPaymentFailedTemplate(locale, APP_NAME, name, portalUrl),
  });
}

export async function sendRefundProcessedEmail(
  email: string,
  name: string,
  creditsDeducted: number,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'refund.subject', { appName: APP_NAME }),
    html: getRefundProcessedTemplate(locale, APP_NAME, name, creditsDeducted),
  });
}

export async function sendSubscriptionCanceledEmail(
  email: string,
  name: string,
  accessEndsAt?: Date,
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
    to: email,
    subject: t(locale, 'feedbackAck.subject', { appName: APP_NAME }),
    html: getFeedbackAcknowledgmentTemplate(locale, APP_NAME, name),
  });
}

export async function sendFeedbackInternalEmail(
  to: string,
  params: Omit<FeedbackInternalTemplateParams, 'appName'>,
): Promise<boolean> {
  // Ops inbox stays English
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
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
  opts?: { userId?: string; locale?: EmailLocale },
): Promise<boolean> {
  const locale = opts?.locale
    ? coerceLocale(opts.locale)
    : opts?.userId
      ? await localeForUser(opts.userId)
      : await localeForEmail(email);
  return sendEmail({
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

interface SendStoryPublishedEmailOptions {
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
    : await localeForUser(opts.userId);

  const base = process.env.FRONTEND_URL?.replace(/\/$/, '') ?? '';
  const prefix = emailLocalePathPrefix(locale);
  const bookUrl = `${base}${prefix}/books/${encodeURIComponent(opts.bookSlug)}`;

  return sendEmail({
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
