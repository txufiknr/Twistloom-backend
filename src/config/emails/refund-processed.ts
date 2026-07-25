/**
 * Refund Processed Email Template
 *
 * Voice: mild noir — confirmation first, atmosphere second.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param creditsDeducted - Credits removed due to refund
 */
export function getRefundProcessedTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  creditsDeducted: number,
): string {
  return buildEmailHtml({
    title: t(locale, 'refund.subject', { appName }),
    heading: t(locale, 'refund.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'refund.body1', { appName })}</p>
      <p>${t(locale, 'refund.body2', { credits: creditsDeducted })}</p>
    `,
    footerHtml: `
      <p>${t(locale, 'refund.footer')}</p>
    `,
  });
}
