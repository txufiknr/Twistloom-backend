/**
 * Product Announcement Email Template
 *
 * Voice: noir framing around admin-provided title/body (content stays as authored).
 * Footer copy is thriller-themed but clear.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param title - Announcement title
 * @param bodyHtml - Pre-sanitized HTML body from admin
 * @param cta - Optional call-to-action
 * @param preferencesUrl - Link to manage email preferences
 */
export function getAnnouncementTemplate(
  locale: EmailLocale,
  appName: string,
  title: string,
  bodyHtml: string,
  cta?: { url: string; text: string },
  preferencesUrl?: string,
): string {
  return buildEmailHtml({
    title: `${title} — ${appName}`,
    heading: title,
    bodyHtml: `
      <p style="color: #6b7280; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0 0 12px 0;">${t(locale, 'announcement.fromTeam', { appName })}</p>
      ${bodyHtml}
    `,
    button: cta,
    plainUrl: cta?.url,
    footerHtml: preferencesUrl
      ? `<p>${t(locale, 'announcement.footer', { url: preferencesUrl })}</p>`
      : undefined,
  });
}
