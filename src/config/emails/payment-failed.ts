/**
 * Payment Failed / Past Due Email Template
 *
 * Voice: mild noir — urgency with atmosphere; action and facts stay unmistakable.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param portalUrl - Optional customer portal / billing URL
 */
export function getPaymentFailedTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  portalUrl?: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'paymentFailed.subject', { appName }),
    heading: t(locale, 'paymentFailed.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'paymentFailed.body1', { appName })}</p>
      <p>${t(locale, 'paymentFailed.body2')}</p>
    `,
    button: portalUrl ? { url: portalUrl, text: t(locale, 'paymentFailed.button') } : undefined,
    plainUrl: portalUrl,
    footerHtml: `
      <p>${t(locale, 'paymentFailed.footer')}</p>
    `,
  });
}
