/**
 * Email Preferences Service
 *
 * SSOT for optional product/engagement email flags. Security and billing mail
 * never consult this service.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  DEFAULT_EMAIL_PREFERENCES,
  EMAIL_PREFERENCE_KEYS,
  type EmailPreferenceKey,
  type EmailPreferences,
  type EmailPreferencesUpdate,
} from '../types/email-preferences.js';

/**
 * Merges stored jsonb with defaults so missing keys are never undefined.
 */
export function normalizeEmailPreferences(
  raw: Partial<EmailPreferences> | null | undefined,
): EmailPreferences {
  return {
    weeklyRecommendations: raw?.weeklyRecommendations ?? DEFAULT_EMAIL_PREFERENCES.weeklyRecommendations,
    monthlyActivitySummary:
      raw?.monthlyActivitySummary ?? DEFAULT_EMAIL_PREFERENCES.monthlyActivitySummary,
    productAnnouncements: raw?.productAnnouncements ?? DEFAULT_EMAIL_PREFERENCES.productAnnouncements,
  };
}

/**
 * Sanitises a partial update: only known boolean keys.
 */
export function sanitizeEmailPreferencesUpdate(body: unknown): EmailPreferencesUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const update: EmailPreferencesUpdate = {};
  let hasKey = false;

  for (const key of EMAIL_PREFERENCE_KEYS) {
    if (key in body) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value !== 'boolean') return null;
      update[key] = value;
      hasKey = true;
    }
  }

  return hasKey ? update : null;
}

/**
 * Loads normalised preferences for a user.
 */
export async function getEmailPreferences(userId: string): Promise<EmailPreferences | null> {
  const [row] = await dbRead
    .select({ emailPreferences: users.emailPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return null;
  return normalizeEmailPreferences(row.emailPreferences);
}

/**
 * Merges and persists preference updates. Returns the full normalised prefs.
 */
export async function updateEmailPreferences(
  userId: string,
  patch: EmailPreferencesUpdate,
): Promise<EmailPreferences | null> {
  const current = await getEmailPreferences(userId);
  if (!current) return null;

  const next = normalizeEmailPreferences({ ...current, ...patch });

  await dbWrite
    .update(users)
    .set({ emailPreferences: next, updatedAt: new Date() })
    .where(eq(users.userId, userId));

  return next;
}

/**
 * Applies default engagement prefs (opt-out model) at onboarding complete.
 */
export async function ensureDefaultEmailPreferences(userId: string): Promise<void> {
  const [row] = await dbRead
    .select({ emailPreferences: users.emailPreferences })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return;
  if (row.emailPreferences != null) return;

  await dbWrite
    .update(users)
    .set({ emailPreferences: DEFAULT_EMAIL_PREFERENCES, updatedAt: new Date() })
    .where(eq(users.userId, userId));
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens (HMAC, long-lived, category-aware)
// ---------------------------------------------------------------------------

function unsubscribeSecret(): string {
  return (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.RESEND_API_KEY ||
    'dev-unsubscribe-secret'
  );
}

export type UnsubscribeCategory = EmailPreferenceKey | 'all';

interface UnsubscribePayload {
  userId: string;
  category: UnsubscribeCategory;
  exp: number;
}

/**
 * Creates a signed unsubscribe token for email footers.
 * Default TTL: 365 days.
 */
export function createUnsubscribeToken(
  userId: string,
  category: UnsubscribeCategory = 'all',
  ttlMs = 365 * 24 * 60 * 60 * 1000,
): string {
  const payload: UnsubscribePayload = {
    userId,
    category,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', unsubscribeSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifies and parses an unsubscribe token. Returns null if invalid/expired.
 */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = createHmac('sha256', unsubscribeSecret()).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UnsubscribePayload;
    if (!payload.userId || !payload.category || !payload.exp) return null;
    if (payload.exp < Date.now()) return null;
    if (payload.category !== 'all' && !EMAIL_PREFERENCE_KEYS.includes(payload.category as EmailPreferenceKey)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Applies unsubscribe for a category (or all engagement).
 */
export async function applyUnsubscribe(
  userId: string,
  category: UnsubscribeCategory,
): Promise<EmailPreferences | null> {
  if (category === 'all') {
    return updateEmailPreferences(userId, {
      weeklyRecommendations: false,
      monthlyActivitySummary: false,
      productAnnouncements: false,
    });
  }
  return updateEmailPreferences(userId, { [category]: false });
}

/**
 * Builds a public unsubscribe URL for email footers.
 */
export function buildUnsubscribeUrl(userId: string, category: UnsubscribeCategory = 'all'): string | null {
  const base = process.env.FRONTEND_URL;
  if (!base) return null;
  const token = createUnsubscribeToken(userId, category);
  return `${base.replace(/\/$/, '')}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
