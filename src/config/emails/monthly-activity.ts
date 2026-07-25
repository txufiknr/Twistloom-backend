/**
 * Monthly Activity Summary Email Template
 *
 * Voice: full noir/thriller — stats stay clear; framing is atmospheric.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export interface MonthlyActivityStats {
  booksCreated: number;
  booksCompleted: number;
  pagesRead: number;
  likesGiven: number;
  checkinStreak?: number;
}

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param monthLabel - e.g. "June 2026"
 * @param stats - Aggregated activity
 * @param preferencesUrl - Link to manage email preferences
 */
export function getMonthlyActivityTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  monthLabel: string,
  stats: MonthlyActivityStats,
  preferencesUrl?: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'monthly.subject', { month: monthLabel, appName }),
    heading: t(locale, 'monthly.heading', { month: monthLabel, name }),
    bodyHtml: `
      <p>${t(locale, 'monthly.body1', { appName })}</p>
      <ul style="padding-left: 20px; line-height: 1.8;">
        <li>${t(locale, 'monthly.statCreated', { n: stats.booksCreated })}</li>
        <li>${t(locale, 'monthly.statCompleted', { n: stats.booksCompleted })}</li>
        <li>${t(locale, 'monthly.statPages', { n: stats.pagesRead })}</li>
        <li>${t(locale, 'monthly.statLikes', { n: stats.likesGiven })}</li>
        ${stats.checkinStreak != null ? `<li>${t(locale, 'monthly.statStreak', { n: stats.checkinStreak })}</li>` : ''}
      </ul>
      <p>${t(locale, 'monthly.body2')}</p>
    `,
    footerHtml: preferencesUrl
      ? `<p>${t(locale, 'monthly.footer', { url: preferencesUrl })}</p>`
      : undefined,
  });
}
