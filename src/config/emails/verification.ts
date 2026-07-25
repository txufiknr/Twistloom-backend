/**
 * Email Verification Template
 *
 * Generates HTML template for email verification emails using the shared base layout.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name (e.g. "Twistloom")
 * @param verificationUrl - Full email verification URL including token
 * @param otpCode - Optional one-time verification code
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getVerificationTemplate('en', 'Twistloom', 'https://app.com/verify-email?token=abc123');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getVerificationTemplate(
  locale: EmailLocale,
  appName: string,
  verificationUrl: string,
  otpCode?: string,
): string {
  const codeHtml = otpCode
    ? `
    <div style="margin: 24px 0; text-align: center;">
      <p style="font-size: 13px; color: #a1a1aa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">${t(locale, 'verification.codeLabel')}</p>
      <div style="font-size: 32px; font-weight: 900; letter-spacing: 8px; color: #ffffff; background: #18181b; padding: 14px 24px; border-radius: 12px; display: inline-block; border: 1px solid #27272a; font-family: monospace;">
        ${otpCode}
      </div>
    </div>
  `
    : '';

  return buildEmailHtml({
    title: t(locale, 'verification.subject', { appName }),
    heading: t(locale, 'verification.heading'),
    bodyHtml: `
      <p>${t(locale, 'verification.body1', { appName })}</p>
      ${codeHtml}
      <p style="margin-top: 16px;">${t(locale, 'verification.body2')}</p>
    `,
    button: { url: verificationUrl, text: t(locale, 'verification.button') },
    plainUrl: verificationUrl,
    footerHtml: `
      <p>${t(locale, 'verification.footer1')}</p>
      <p>${t(locale, 'verification.footer2')}</p>
    `,
  });
}
