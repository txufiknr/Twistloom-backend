/**
 * Email Changed (old address) Template
 *
 * Alerts the previous login email that the account email was updated.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param newEmailMasked - Partially masked new email for context
 * @param detailHtml - Optional IP / User-Agent details
 */
export function getEmailChangedTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  newEmailMasked: string,
  detailHtml?: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'emailChanged.subject', { appName }),
    heading: t(locale, 'emailChanged.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'emailChanged.body1', { appName, newEmailMasked })}</p>
      ${detailHtml ?? ''}
      <p>${t(locale, 'emailChanged.body2')}</p>
      <p>${t(locale, 'emailChanged.body3')}</p>
    `,
    footerHtml: `
      <p>${t(locale, 'emailChanged.footer')}</p>
    `,
  });
}
