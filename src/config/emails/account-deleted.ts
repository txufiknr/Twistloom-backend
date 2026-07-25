/**
 * Account Deleted Confirmation Template
 *
 * Voice: mild farewell noir — irreversible facts stay plain and clear.
 * Not a security-alert template (no action required); still prioritizes clarity.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 */
export function getAccountDeletedTemplate(locale: EmailLocale, appName: string, name: string): string {
  return buildEmailHtml({
    title: t(locale, 'accountDeleted.subject', { appName }),
    heading: t(locale, 'accountDeleted.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'accountDeleted.body1', { appName })}</p>
      <p>${t(locale, 'accountDeleted.body2')}</p>
    `,
    footerHtml: `
      <p>${t(locale, 'accountDeleted.footer')}</p>
    `,
  });
}
