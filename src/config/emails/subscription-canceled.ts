/**
 * Subscription Canceled Email Template
 *
 * Voice: mild noir — clear access end date, atmospheric close.
 */

import { buildEmailHtml } from './base-layout.js';
import { t, formatEmailDate } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param accessEndsAt - Optional date when VIP access ends
 */
export function getSubscriptionCanceledTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  accessEndsAt?: Date,
): string {
  const accessLine = accessEndsAt
    ? `<p>${t(locale, 'subCanceled.accessUntil', { date: formatEmailDate(locale, accessEndsAt) })}</p>`
    : `<p>${t(locale, 'subCanceled.accessGeneric')}</p>`;

  return buildEmailHtml({
    title: t(locale, 'subCanceled.subject', { appName }),
    heading: t(locale, 'subCanceled.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'subCanceled.body1', { appName })}</p>
      ${accessLine}
      <p>${t(locale, 'subCanceled.body2')}</p>
    `,
  });
}
