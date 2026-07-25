/**
 * Product Announcement Email Template
 *
 * Voice: noir framing around admin-provided title/body (content stays as authored).
 * Footer copy is thriller-themed but clear.
 */

import { buildEmailHtml } from './base-layout.js';

/**
 * @param appName - Application display name
 * @param title - Announcement title
 * @param bodyHtml - Pre-sanitized HTML body from admin
 * @param cta - Optional call-to-action
 * @param preferencesUrl - Link to manage email preferences
 */
export function getAnnouncementTemplate(
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
      <p style="color: #6b7280; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0 0 12px 0;">A message from the ${appName} team</p>
      ${bodyHtml}
    `,
    button: cta,
    plainUrl: cta?.url,
    footerHtml: preferencesUrl
      ? `<p>Don't want these dispatches? <a href="${preferencesUrl}" style="color: #8b0000;">Manage preferences</a> or turn off product announcements anytime.</p>`
      : undefined,
  });
}
