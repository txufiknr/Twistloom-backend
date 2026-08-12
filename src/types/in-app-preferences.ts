/**
 * User in-app notification preference flags.
 *
 * Controls which real-time / in-app notifications a user receives (comments,
 * likes, story publish, AI generation completion). Stored as a JSONB column
 * on `users` (`in_app_preferences`), mirroring the `email_preferences`
 * pattern. Unlike email, there is no "always on" category here yet — every
 * toggle is opt-out and defaults to enabled.
 */

/** Preference-gated in-app notification categories */
export interface InAppPreferences {
  /** Someone commented on the user's book */
  comments: boolean;
  /** Someone liked the user's book */
  likes: boolean;
  /** The user's story was published successfully */
  storyPublished: boolean;
  /** An AI book generation the user started has finished */
  aiCompleted: boolean;
}

/** Partial update payload for PATCH /user/in-app-preferences */
export type InAppPreferencesUpdate = Partial<Pick<InAppPreferences, InAppPreferenceBoolKey>>;

/** Default in-app prefs (opt-out model, all on) */
export const DEFAULT_IN_APP_PREFERENCES: InAppPreferences = {
  comments: true,
  likes: true,
  storyPublished: true,
  aiCompleted: true,
};

/** Boolean toggle keys */
export const IN_APP_PREFERENCE_BOOL_KEYS = [
  'comments',
  'likes',
  'storyPublished',
  'aiCompleted',
] as const satisfies readonly (keyof InAppPreferences)[];

export type InAppPreferenceBoolKey = (typeof IN_APP_PREFERENCE_BOOL_KEYS)[number];
