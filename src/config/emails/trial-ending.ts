/**
 * VIP Trial Ending Email Template
 *
 * Generates HTML template for the email sent ~3 days before a user's VIP free
 * trial expires. Uses the shared base layout and thriller-themed voice consistent
 * with the other transactional templates.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name (e.g. "Twistloom")
 * @param name - User's display name for personalisation
 * @param trialEndDate - When the trial ends / the card will be charged
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getTrialEndingTemplate('en', 'Twistloom', 'Jane', new Date('2026-07-15'));
 * ```
 */

import { buildEmailHtml } from './base-layout.js';
import { t, formatEmailDate } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getTrialEndingTemplate(
  locale: EmailLocale,
  appName: string,
  name: string,
  trialEndDate: Date,
): string {
  const date = formatEmailDate(locale, trialEndDate);

  return buildEmailHtml({
    title: t(locale, 'trialEnding.subject', { appName }),
    heading: t(locale, 'trialEnding.heading', { name }),
    bodyHtml: `
      <p>${t(locale, 'trialEnding.body1', { appName, date })}</p>
      <p>${t(locale, 'trialEnding.body2')}</p>
      <p>${t(locale, 'trialEnding.body3')}</p>
    `,
    // Note: button intentionally omitted — no deep link from email is necessary.
    // The in-app subscription settings page is the canonical management entry
    // point, and the companion in-app notification carries the CTA. Stripe's
    // own trial-ending email (sent automatically from the Dashboard) serves
    // as a zero-code safety net.
    footerHtml: `
      <p>${t(locale, 'trialEnding.footer1')}</p>
      <p>${t(locale, 'trialEnding.footer2', { date })}</p>
    `,
  });
}
