/**
 * Story Published Email Template
 *
 * Sent to a follower when an author they follow publishes a new public book.
 * Voice mirrors the other engagement mails (noir framing) but stays clear.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name
 * @param name - Recipient's display name (personalisation)
 * @param authorName - Name of the author who published the book
 * @param bookTitle - Title of the newly published book
 * @param bookUrl - Deep link to the book on the frontend
 * @param preferencesUrl - Link to manage email preferences (footer)
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getStoryPublishedTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  authorName: string,
  bookTitle: string,
  bookUrl: string,
  preferencesUrl?: string,
): string {
  return buildEmailHtml({
    title: t(locale, 'storyPublished.subject', { appName }),
    heading: t(locale, 'storyPublished.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'storyPublished.body1', { authorName, bookTitle })}</p>
      <p>${t(locale, 'storyPublished.body2')}</p>
    `,
    button: { url: bookUrl, text: t(locale, 'storyPublished.cta') },
    plainUrl: bookUrl,
    footerHtml: preferencesUrl
      ? `<p>${t(locale, 'storyPublished.footer', { url: preferencesUrl })}</p>`
      : undefined,
  });
}
