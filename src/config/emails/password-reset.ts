/**
 * Password Reset Email Template
 *
 * Generates HTML template for password reset emails using the shared base layout.
 * Voice: suspenseful but clear — the user may be anxious, so instructions must
 * be the most prominent element.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name (e.g. "Twistloom")
 * @param resetUrl - Full password reset URL including token
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getPasswordResetTemplate('en', 'Twistloom', 'https://app.com/reset-password?token=abc123');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getPasswordResetTemplate(locale: EmailLocale, appName: string, resetUrl: string): string {
  return buildEmailHtml({
    title: t(locale, 'passwordReset.subject', { appName }),
    heading: t(locale, 'passwordReset.heading'),
    bodyHtml: `
      <p>${t(locale, 'passwordReset.body1', { appName })}</p>
      <p>${t(locale, 'passwordReset.body2')}</p>
    `,
    button: { url: resetUrl, text: t(locale, 'passwordReset.button') },
    plainUrl: resetUrl,
    footerHtml: `
      <p>${t(locale, 'passwordReset.footer1')}</p>
      <p>${t(locale, 'passwordReset.footer2')}</p>
    `,
  });
}
