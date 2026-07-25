/**
 * Monthly Activity Summary Email Template
 *
 * Voice: full noir/thriller — stats stay clear; framing is atmospheric.
 */

import { buildEmailHtml } from './base-layout.js';

export interface MonthlyActivityStats {
  booksCreated: number;
  booksCompleted: number;
  pagesRead: number;
  likesGiven: number;
  checkinStreak?: number;
}

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param monthLabel - e.g. "June 2026"
 * @param stats - Aggregated activity
 * @param preferencesUrl - Link to manage email preferences
 */
export function getMonthlyActivityTemplate(
  appName: string,
  name: string,
  monthLabel: string,
  stats: MonthlyActivityStats,
  preferencesUrl?: string,
): string {
  return buildEmailHtml({
    title: `Your ${monthLabel} dossier — ${appName}`,
    heading: `${monthLabel} is closed, ${name}.`,
    bodyHtml: `
      <p>We've sealed last month's file. Here's what the record shows you did inside ${appName}:</p>
      <ul style="padding-left: 20px; line-height: 1.8;">
        <li><strong>${stats.booksCreated}</strong> stor${stats.booksCreated === 1 ? 'y' : 'ies'} you set in motion</li>
        <li><strong>${stats.booksCompleted}</strong> ending${stats.booksCompleted === 1 ? '' : 's'} you reached</li>
        <li><strong>${stats.pagesRead}</strong> page${stats.pagesRead === 1 ? '' : 's'} turned</li>
        <li><strong>${stats.likesGiven}</strong> mark${stats.likesGiven === 1 ? '' : 's'} of approval left behind</li>
        ${stats.checkinStreak != null ? `<li>Longest check-in streak: <strong>${stats.checkinStreak}</strong> night${stats.checkinStreak === 1 ? '' : 's'}</li>` : ''}
      </ul>
      <p>The ledger never lies. A new month is already open — and it doesn't care how last one ended.</p>
    `,
    footerHtml: preferencesUrl
      ? `<p><a href="${preferencesUrl}" style="color: #8b0000;">Manage email preferences</a></p>`
      : undefined,
  });
}
