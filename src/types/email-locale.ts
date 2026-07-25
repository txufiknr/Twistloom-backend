/**
 * Supported locales for account UI language and email rendering.
 * Keep in lockstep with twistloom-web `LOCALES` (`en`, `id`).
 */

export const EMAIL_LOCALES = ['en', 'id'] as const;

export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

export function isEmailLocale(value: unknown): value is EmailLocale {
  return typeof value === 'string' && (EMAIL_LOCALES as readonly string[]).includes(value);
}

export function parseEmailLocale(value: unknown): EmailLocale | null {
  if (value === null) return null;
  return isEmailLocale(value) ? value : null;
}
