/**
 * Weekly "books you might like" Email Template
 *
 * Voice: full noir/thriller — compelling, atmospheric, still scannable.
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export interface RecommendedBookEmailItem {
  title: string;
  url: string;
  blurb?: string;
}

/**
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - User display name
 * @param books - Recommended books (3–6)
 * @param preferencesUrl - Link to manage email preferences
 */
export function getWeeklyRecommendationsTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  books: RecommendedBookEmailItem[],
  preferencesUrl?: string,
): string {
  const listHtml = books
    .map(
      (b, i) => `
      <p style="margin: 0 0 16px 0;">
        <span style="color: #6b7280; font-size: 12px; letter-spacing: 0.5px;">${t(locale, 'weekly.fileLabel', { n: String(i + 1).padStart(2, '0') })}</span><br/>
        <a href="${b.url}" style="color: #8b0000; font-weight: 600; text-decoration: none;">${b.title}</a>
        ${b.blurb ? `<br/><span style="color: #6b7280; font-size: 14px;">${b.blurb}</span>` : ''}
      </p>`,
    )
    .join('');

  return buildEmailHtml({
    title: t(locale, 'weekly.subject', { appName }),
    heading: t(locale, 'weekly.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'weekly.body1', { appName })}</p>
      <p>${t(locale, 'weekly.body2')}</p>
      ${listHtml}
      <p>${t(locale, 'weekly.body3')}</p>
    `,
    footerHtml: preferencesUrl
      ? `<p>${t(locale, 'weekly.footer', { url: preferencesUrl })}</p>`
      : undefined,
  });
}
