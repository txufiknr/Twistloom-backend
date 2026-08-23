/**
 * User email preference flags for optional product / engagement mail,
 * plus optional email language override (C+D hybrid i18n).
 *
 * Security, verification, password reset, and billing emails are always sent
 * and are intentionally excluded from toggle flags — but they still respect
 * email language resolution (emailLocale ?? preferredLocale).
 */

import type { EmailLocale } from './email-locale.js';

/** Preference-gated engagement categories + optional email language override */
export interface EmailPreferences {
  /** Weekly "books you might like" digest */
  weeklyRecommendations: boolean;
  /** Monthly activity summary */
  monthlyActivitySummary: boolean;
  /** Unscheduled product announcements from Twistloom */
  productAnnouncements: boolean;
  /** New story published by someone the user follows */
  storyPublished: boolean;
  /**
   * Email language override.
   * `null` = follow account `preferredLocale` (same as app language).
   */
  emailLocale: EmailLocale | null;
}

/** Partial update payload for PATCH /user/email-preferences */
export type EmailPreferencesUpdate = {
  weeklyRecommendations?: boolean;
  monthlyActivitySummary?: boolean;
  productAnnouncements?: boolean;
  storyPublished?: boolean;
  /** Pass `null` to clear override (same as app) */
  emailLocale?: EmailLocale | null;
};

/** Default prefs applied after onboarding (opt-out model) */
export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  weeklyRecommendations: true,
  monthlyActivitySummary: true,
  productAnnouncements: true,
  storyPublished: true,
  emailLocale: null,
};

/** Boolean engagement keys */
export const EMAIL_PREFERENCE_BOOL_KEYS = [
  'weeklyRecommendations',
  'monthlyActivitySummary',
  'productAnnouncements',
  'storyPublished',
] as const satisfies readonly (keyof EmailPreferences)[];

export type EmailPreferenceBoolKey = (typeof EMAIL_PREFERENCE_BOOL_KEYS)[number];

/** @deprecated use EMAIL_PREFERENCE_BOOL_KEYS */
export const EMAIL_PREFERENCE_KEYS = EMAIL_PREFERENCE_BOOL_KEYS;
export type EmailPreferenceKey = EmailPreferenceBoolKey;
