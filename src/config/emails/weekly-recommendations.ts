/**
 * Weekly "books you might like" Email Template
 *
 * Voice: full noir/thriller — compelling, atmospheric, still scannable.
 */

import { buildEmailHtml } from './base-layout.js';

export interface RecommendedBookEmailItem {
  title: string;
  url: string;
  blurb?: string;
}

/**
 * @param appName - Application display name
 * @param name - User display name
 * @param books - Recommended books (3–6)
 * @param preferencesUrl - Link to manage email preferences
 */
export function getWeeklyRecommendationsTemplate(
  appName: string,
  name: string,
  books: RecommendedBookEmailItem[],
  preferencesUrl?: string,
): string {
  const listHtml = books
    .map(
      (b, i) => `
      <p style="margin: 0 0 16px 0;">
        <span style="color: #6b7280; font-size: 12px; letter-spacing: 0.5px;">FILE ${String(i + 1).padStart(2, '0')}</span><br/>
        <a href="${b.url}" style="color: #8b0000; font-weight: 600; text-decoration: none;">${b.title}</a>
        ${b.blurb ? `<br/><span style="color: #6b7280; font-size: 14px;">${b.blurb}</span>` : ''}
      </p>`,
    )
    .join('');

  return buildEmailHtml({
    title: `This week's dossiers — ${appName}`,
    heading: `We've been watching what you read, ${name}.`,
    bodyHtml: `
      <p>From the shadows of ${appName}, a few stories surfaced — the kind that don't let go once you open the first page.</p>
      <p>Picked for you from the shelves that match your trail. Choose carefully. Or don't. Either way, something will change.</p>
      ${listHtml}
      <p>Open one when the house is quiet. That's when they hit hardest.</p>
    `,
    footerHtml: preferencesUrl
      ? `<p>Too many whispers? <a href="${preferencesUrl}" style="color: #8b0000;">Manage email preferences</a></p>`
      : undefined,
  });
}
