/**
 * User email preference flags for optional product / engagement mail.
 *
 * Security, verification, password reset, and billing emails are always sent
 * and are intentionally excluded from this model.
 */

/** Preference-gated engagement categories */
export interface EmailPreferences {
  /** Weekly "books you might like" digest */
  weeklyRecommendations: boolean;
  /** Monthly activity summary */
  monthlyActivitySummary: boolean;
  /** Unscheduled product announcements from Twistloom */
  productAnnouncements: boolean;
}

/** Partial update payload for PATCH /user/email-preferences */
export type EmailPreferencesUpdate = Partial<EmailPreferences>;

/** Default prefs applied after onboarding (opt-out model) */
export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  weeklyRecommendations: true,
  monthlyActivitySummary: true,
  productAnnouncements: true,
};

/** Valid keys for preference updates */
export const EMAIL_PREFERENCE_KEYS = [
  'weeklyRecommendations',
  'monthlyActivitySummary',
  'productAnnouncements',
] as const satisfies readonly (keyof EmailPreferences)[];

export type EmailPreferenceKey = (typeof EMAIL_PREFERENCE_KEYS)[number];
