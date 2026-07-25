/**
 * Email template i18n
 *
 * Catalog-driven strings with English fallback. Used by all email templates.
 */

import type { EmailLocale } from '../../types/email-locale.js';
import { DEFAULT_EMAIL_LOCALE, isEmailLocale } from '../../types/email-locale.js';
import en from './locales/en.json' with { type: 'json' };
import id from './locales/id.json' with { type: 'json' };

type Catalog = Record<string, string>;

const CATALOGS: Record<EmailLocale, Catalog> = {
  en: en as Catalog,
  id: id as Catalog,
};

/**
 * Interpolates `{{var}}` placeholders in a catalog string.
 */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Looks up a catalog key for the locale, falling back to English.
 */
export function t(
  locale: EmailLocale | string | undefined,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const loc: EmailLocale = isEmailLocale(locale) ? locale : DEFAULT_EMAIL_LOCALE;
  const primary = CATALOGS[loc]?.[key];
  const fallback = CATALOGS[DEFAULT_EMAIL_LOCALE]?.[key];
  const raw = primary ?? fallback;
  if (!raw) {
    console.warn(`[email-i18n] Missing key "${key}" (locale=${loc})`);
    return key;
  }
  if (!primary && loc !== DEFAULT_EMAIL_LOCALE) {
    console.warn(`[email-i18n] Missing key "${key}" for locale=${loc}, using en`);
  }
  return interpolate(raw, vars);
}

/**
 * Formats a date for email bodies in the user's locale.
 */
export function formatEmailDate(locale: EmailLocale | string | undefined, date: Date): string {
  const loc: EmailLocale = isEmailLocale(locale) ? locale : DEFAULT_EMAIL_LOCALE;
  const tag = loc === 'id' ? 'id-ID' : 'en-US';
  return date.toLocaleDateString(tag, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * BCP 47 tag for Intl APIs.
 */
export function emailLocaleTag(locale: EmailLocale | string | undefined): string {
  return isEmailLocale(locale) && locale === 'id' ? 'id-ID' : 'en-US';
}

/**
 * Frontend path prefix for locale-aware deep links (`en` → ``, `id` → `/id`).
 */
export function emailLocalePathPrefix(locale: EmailLocale | string | undefined): string {
  return isEmailLocale(locale) && locale === 'id' ? '/id' : '';
}
