/**
 * Password Changed Email Template
 *
 * Confirms a successful password change (in-app or via reset link).
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param detailHtml - Optional IP / User-Agent / time details
 */
export function getPasswordChangedTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  detailHtml?: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'passwordChanged.subject', { appName }),
    heading: t(locale, 'passwordChanged.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'passwordChanged.body1', { appName })}</p>
      ${detailHtml ?? ''}
      <p>${t(locale, 'passwordChanged.body2')}</p>
      <p>${t(locale, 'passwordChanged.body3')}</p>
    `,
    footerHtml: `
      <p>${t(locale, 'passwordChanged.footer')}</p>
    `,
  });
}
