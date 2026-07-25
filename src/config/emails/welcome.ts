/**
 * Welcome Email Template
 *
 * Generates HTML template for welcome emails sent after successful signup.
 * Uses the shared base layout.
 *
 * @param locale - Email locale for i18n strings
 * @param appName - Application display name (e.g. "Twistloom")
 * @param username - New user's chosen username
 * @returns Complete email HTML string
 *
 * @example
 * ```typescript
 * const html = getWelcomeTemplate('en', 'Twistloom', 'johndoe');
 * ```
 */

import { buildEmailHtml } from './base-layout.js';
import { t } from './i18n.js';
import type { EmailLocale } from '../../types/email-locale.js';

export function getWelcomeTemplate(locale: EmailLocale, appName: string, username: string): string {
  return buildEmailHtml({
    title: t(locale, 'welcome.subject', { appName }),
    heading: t(locale, 'welcome.heading', { username }),
    bodyHtml: `
      <p>${t(locale, 'welcome.body1', { appName })}</p>
      <p>${t(locale, 'welcome.body2')}</p>
      <p>${t(locale, 'welcome.body3')}</p>
      <p>${t(locale, 'welcome.body4', { appName })}</p>
      <p>${t(locale, 'welcome.body5', { appName })}</p>
    `,
    footerHtml: `
      <p style="font-style: italic;">${t(locale, 'welcome.footer', { appName })}</p>
    `,
  });
}
