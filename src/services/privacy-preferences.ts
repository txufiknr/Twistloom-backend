/**
 * Privacy Preferences Service
 *
 * SSOT for user privacy flags (showCommentsOnProfile). Mirrors the
 * in-app-preferences and email-preferences services so preferences
 * follow the same storage / normalization / update patterns across the platform.
 *
 * Default: private (showCommentsOnProfile = false).
 */

import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  DEFAULT_PRIVACY_PREFERENCES,
  PRIVACY_PREFERENCE_BOOL_KEYS,
  type PrivacyPreferences,
  type PrivacyPreferencesUpdate,
} from '../types/privacy-preferences.js';

/**
 * Merges stored jsonb with defaults so missing keys are never undefined.
 */
export function normalizePrivacyPreferences(
  raw: Partial<PrivacyPreferences> | null | undefined,
): PrivacyPreferences {
  return {
    showLikedOnProfile:
      raw?.showLikedOnProfile ?? DEFAULT_PRIVACY_PREFERENCES.showLikedOnProfile,
    showReadsOnProfile:
      raw?.showReadsOnProfile ?? DEFAULT_PRIVACY_PREFERENCES.showReadsOnProfile,
    showReviewsOnProfile:
      raw?.showReviewsOnProfile ?? DEFAULT_PRIVACY_PREFERENCES.showReviewsOnProfile,
    showCommentsOnProfile:
      raw?.showCommentsOnProfile ?? DEFAULT_PRIVACY_PREFERENCES.showCommentsOnProfile,
    showMindMatrixOnProfile:
      raw?.showMindMatrixOnProfile ?? DEFAULT_PRIVACY_PREFERENCES.showMindMatrixOnProfile,
  };
}

/**
 * Sanitises a partial update: only known boolean keys are accepted.
 * Returns null when the payload is empty or contains an invalid value.
 */
export function sanitizePrivacyPreferencesUpdate(body: unknown): PrivacyPreferencesUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const update: PrivacyPreferencesUpdate = {};
  let hasKey = false;
  const record = body as Record<string, unknown>;

  for (const key of PRIVACY_PREFERENCE_BOOL_KEYS) {
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
 * Loads normalised privacy preferences for a user.
 */
export async function getPrivacyPreferences(userId: string): Promise<PrivacyPreferences | null> {
  const [row] = await dbRead
    .select({ privacyPreferences: users.privacyPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return null;
  return normalizePrivacyPreferences(row.privacyPreferences);
}

/**
 * Merges and persists preference updates. Returns the full normalised prefs.
 */
export async function updatePrivacyPreferences(
  userId: string,
  patch: PrivacyPreferencesUpdate,
): Promise<PrivacyPreferences | null> {
  const current = await getPrivacyPreferences(userId);
  if (!current) return null;

  const next = normalizePrivacyPreferences({ ...current, ...patch });

  await dbWrite
    .update(users)
    .set({ privacyPreferences: next, updatedAt: new Date() })
    .where(eq(users.userId, userId));

  return next;
}

/**
 * Applies default privacy prefs (private by default) at onboarding complete or when null.
 */
export async function ensureDefaultPrivacyPreferences(userId: string): Promise<void> {
  const [row] = await dbRead
    .select({ privacyPreferences: users.privacyPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return;
  if (row.privacyPreferences != null) return;

  await dbWrite
    .update(users)
    .set({ privacyPreferences: DEFAULT_PRIVACY_PREFERENCES, updatedAt: new Date() })
    .where(eq(users.userId, userId));
}
