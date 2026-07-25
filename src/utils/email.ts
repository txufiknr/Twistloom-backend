/**
 * Email Utilities
 *
 * Provides transactional email sending via Resend. All public functions delegate
 * to the private `sendEmail` helper, which centralises error handling, logging,
 * and the Resend API call — keeping individual email functions DRY.
 *
 * Use {@link sendEmailSafe} from routes/services for fire-and-forget best-effort
 * sends that never throw into the request path.
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
  type FeedbackInternalTemplateParams,
  type RecommendedBookEmailItem,
  type MonthlyActivityStats,
} from '../config/emails/index.js';
import { getErrorMessage } from './error.js';

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

/**
 * Core send helper — all public email functions eventually call this.
 * Never throws; returns `false` on error.
 */
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
 * Logs failures; never rejects. Prefer this over inline try/catch around sends.
 *
 * @param label - Log context (e.g. route name)
 * @param sendFn - Async function that performs the send
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
}): string {
  if (!opts) return '';
  const parts: string[] = [];
  if (opts.at) {
    parts.push(
      opts.at.toLocaleString('en-US', {
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

function preferencesUrl(): string | undefined {
  const base = process.env.FRONTEND_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, '')}/dashboard/account/preferences?tab=notifications`;
}

// ---------------------------------------------------------------------------
// Auth / lifecycle
// ---------------------------------------------------------------------------

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Reset Your ${APP_NAME} Password`,
    html: getPasswordResetTemplate(APP_NAME, resetUrl),
  });
}

export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
  otpCode?: string,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Verify Your ${APP_NAME} Email`,
    html: getVerificationTemplate(APP_NAME, verificationUrl, otpCode),
  });
}

export async function sendWelcomeEmail(email: string, username: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Welcome to ${APP_NAME}!`,
    html: getWelcomeTemplate(APP_NAME, username),
  });
}

export async function sendPasswordChangedEmail(
  email: string,
  name: string,
  detailHtml?: string,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Your ${APP_NAME} password was changed`,
    html: getPasswordChangedTemplate(APP_NAME, name, detailHtml),
  });
}

export async function sendEmailChangedAlertEmail(
  oldEmail: string,
  name: string,
  newEmail: string,
  detailHtml?: string,
): Promise<boolean> {
  return sendEmail({
    to: oldEmail,
    subject: `Your ${APP_NAME} email address was changed`,
    html: getEmailChangedTemplate(APP_NAME, name, maskEmail(newEmail), detailHtml),
  });
}

export async function sendAccountDeletedEmail(email: string, name: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Your ${APP_NAME} account has been deleted`,
    html: getAccountDeletedTemplate(APP_NAME, name),
  });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export async function sendTrialEndingEmail(
  email: string,
  name: string,
  trialEndDate: Date,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Your ${APP_NAME} VIP Trial Ends Soon`,
    html: getTrialEndingTemplate(APP_NAME, name, trialEndDate),
  });
}

export async function sendPaymentFailedEmail(
  email: string,
  name: string,
  portalUrl?: string,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Action needed: ${APP_NAME} payment failed`,
    html: getPaymentFailedTemplate(APP_NAME, name, portalUrl),
  });
}

export async function sendRefundProcessedEmail(
  email: string,
  name: string,
  creditsDeducted: number,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Refund processed — ${APP_NAME}`,
    html: getRefundProcessedTemplate(APP_NAME, name, creditsDeducted),
  });
}

export async function sendSubscriptionCanceledEmail(
  email: string,
  name: string,
  accessEndsAt?: Date,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Your ${APP_NAME} VIP subscription was canceled`,
    html: getSubscriptionCanceledTemplate(APP_NAME, name, accessEndsAt),
  });
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

export async function sendFeedbackAcknowledgmentEmail(email: string, name: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `We Received Your Feedback — ${APP_NAME}`,
    html: getFeedbackAcknowledgmentTemplate(APP_NAME, name),
  });
}

export async function sendFeedbackInternalEmail(
  to: string,
  params: Omit<FeedbackInternalTemplateParams, 'appName'>,
): Promise<boolean> {
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
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `This week's dossiers — ${APP_NAME}`,
    html: getWeeklyRecommendationsTemplate(APP_NAME, name, books, preferencesUrl()),
  });
}

export async function sendMonthlyActivityEmail(
  email: string,
  name: string,
  monthLabel: string,
  stats: MonthlyActivityStats,
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `Your ${monthLabel} dossier — ${APP_NAME}`,
    html: getMonthlyActivityTemplate(APP_NAME, name, monthLabel, stats, preferencesUrl()),
  });
}

export async function sendAnnouncementEmail(
  email: string,
  title: string,
  bodyHtml: string,
  cta?: { url: string; text: string },
): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: `${title} — ${APP_NAME}`,
    html: getAnnouncementTemplate(APP_NAME, title, bodyHtml, cta, preferencesUrl()),
  });
}
