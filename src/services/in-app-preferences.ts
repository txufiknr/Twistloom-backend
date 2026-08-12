/**
 * In-App Preferences Service
 *
 * SSOT for optional in-app notification flags (comments, likes,
 * storyPublished, aiCompleted). Mirrors the email-preferences service so the
 * two preference groups follow the same storage / normalization / update
 * patterns. Security-adjacent notifications are not yet exposed here; every
 * key is opt-out and defaults to enabled.
 */

import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  DEFAULT_IN_APP_PREFERENCES,
  IN_APP_PREFERENCE_BOOL_KEYS,
  type InAppPreferences,
  type InAppPreferencesUpdate,
} from '../types/in-app-preferences.js';

/**
 * Merges stored jsonb with defaults so missing keys are never undefined.
 */
export function normalizeInAppPreferences(
  raw: Partial<InAppPreferences> | null | undefined,
): InAppPreferences {
  return {
    comments: raw?.comments ?? DEFAULT_IN_APP_PREFERENCES.comments,
    likes: raw?.likes ?? DEFAULT_IN_APP_PREFERENCES.likes,
    storyPublished: raw?.storyPublished ?? DEFAULT_IN_APP_PREFERENCES.storyPublished,
    aiCompleted: raw?.aiCompleted ?? DEFAULT_IN_APP_PREFERENCES.aiCompleted,
  };
}

/**
 * Sanitises a partial update: only known boolean keys are accepted.
 * Returns null when the payload is empty or contains an invalid value.
 */
export function sanitizeInAppPreferencesUpdate(body: unknown): InAppPreferencesUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const update: InAppPreferencesUpdate = {};
  let hasKey = false;
  const record = body as Record<string, unknown>;

  for (const key of IN_APP_PREFERENCE_BOOL_KEYS) {
    if (key in record) {
      const value = record[key];
      if (typeof value !== 'boolean') return null;
      update[key] = value;
      hasKey = true;
    }
  }

  return hasKey ? update : null;
}

/**
 * Loads normalised in-app preferences for a user.
 */
export async function getInAppPreferences(userId: string): Promise<InAppPreferences | null> {
  const [row] = await dbRead
    .select({ inAppPreferences: users.inAppPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return null;
  return normalizeInAppPreferences(row.inAppPreferences);
}

/**
 * Merges and persists preference updates. Returns the full normalised prefs.
 */
export async function updateInAppPreferences(
  userId: string,
  patch: InAppPreferencesUpdate,
): Promise<InAppPreferences | null> {
  const current = await getInAppPreferences(userId);
  if (!current) return null;

  const next = normalizeInAppPreferences({ ...current, ...patch });

  await dbWrite
    .update(users)
    .set({ inAppPreferences: next, updatedAt: new Date() })
    .where(eq(users.userId, userId));

  return next;
}

/**
 * Applies default in-app prefs (opt-out model) at onboarding complete.
 */
export async function ensureDefaultInAppPreferences(userId: string): Promise<void> {
  const [row] = await dbRead
    .select({ inAppPreferences: users.inAppPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return;
  if (row.inAppPreferences != null) return;

  await dbWrite
    .update(users)
    .set({ inAppPreferences: DEFAULT_IN_APP_PREFERENCES, updatedAt: new Date() })
    .where(eq(users.userId, userId));
}
