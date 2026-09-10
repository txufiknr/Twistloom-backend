/**
 * User privacy preference flags.
 *
 * Controls privacy settings for the user's public profile, such as whether
 * comments written by the user across Twistloom are visible to other visitors.
 * Stored as a JSONB column on `users` (`privacy_preferences`), mirroring the
 * `in_app_preferences` and `email_preferences` pattern.
 *
 * Default: private (only visible to the user themself).
 */

export interface PrivacyPreferences {
  /** Show stories liked by the user on their public profile (default: false). */
  showLikedOnProfile: boolean;
  /** Show reading history on their public profile (default: false). */
  showReadsOnProfile: boolean;
  /** Show book reviews/testimonials given by the user on their public profile (default: true). */
  showReviewsOnProfile: boolean;
  /**
   * Allow people visiting your profile to browse comments you've posted
   * across Twistloom. Your comments may still be visible where you originally posted them.
   * Default: false (private).
   */
  showCommentsOnProfile: boolean;
  /** Show reader Mind Matrix psychological profile on their public profile (default: true). */
  showMindMatrixOnProfile: boolean;
  /** Show the Wall tab to profile visitors (default: true). */
  showWallOnProfile: boolean;
  /** Allow eligible visitors to publish incoming Notes to this wall (default: true). */
  allowWallNotesFromOthers: boolean;
}

/** Partial update payload for PATCH /user/privacy-preferences */
export type PrivacyPreferencesUpdate = Partial<Pick<PrivacyPreferences, PrivacyPreferenceBoolKey>>;

/** Default privacy prefs */
export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  showLikedOnProfile: false,
  showReadsOnProfile: false,
  showReviewsOnProfile: true,
  showCommentsOnProfile: false,
  showMindMatrixOnProfile: true,
  showWallOnProfile: true,
  allowWallNotesFromOthers: true,
};

/** Boolean toggle keys */
export const PRIVACY_PREFERENCE_BOOL_KEYS = [
  'showLikedOnProfile',
  'showReadsOnProfile',
  'showReviewsOnProfile',
  'showCommentsOnProfile',
  'showMindMatrixOnProfile',
  'showWallOnProfile',
  'allowWallNotesFromOthers',
] as const satisfies readonly (keyof PrivacyPreferences)[];

export type PrivacyPreferenceBoolKey = (typeof PRIVACY_PREFERENCE_BOOL_KEYS)[number];
