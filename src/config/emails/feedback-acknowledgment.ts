/**
 * Feedback Acknowledgment Email Template
 *
 * Generates HTML for the thank-you email sent after a user submits feedback.
 * Confirms receipt, apologizes for any inconvenience, and reassures that the
 * team will address the issue as soon as possible.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name (e.g. "Twistloom")
 * @param name - User's display name for personalisation
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getFeedbackAcknowledgmentTemplate('en', 'Twistloom', 'Jane');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getFeedbackAcknowledgmentTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'feedbackAck.subject', { appName }),
    heading: t(locale, 'feedbackAck.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'feedbackAck.body1')}</p>
      <p>${t(locale, 'feedbackAck.body2')}</p>
      <p>${t(locale, 'feedbackAck.body3', { appName })}</p>
    `,
    footerHtml: `
      <p>${t(locale, 'feedbackAck.footer')}</p>
    `,
  });
}
