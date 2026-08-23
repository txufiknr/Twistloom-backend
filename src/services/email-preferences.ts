/**
 * Email Preferences Service
 *
 * SSOT for optional product/engagement email flags and email language override.
 * Security and billing mail never consult engagement toggles, but do use
 * {@link resolveEmailLocale} for template language.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  DEFAULT_EMAIL_PREFERENCES,
  EMAIL_PREFERENCE_BOOL_KEYS,
  type EmailPreferences,
  type EmailPreferencesUpdate,
} from '../types/email-preferences.js';
import {
  DEFAULT_EMAIL_LOCALE,
  isEmailLocale,
  type EmailLocale,
} from '../types/email-locale.js';
import { emailLocalePathPrefix } from '../config/emails/i18n.js';

/**
 * Merges stored jsonb with defaults so missing keys are never undefined.
 */
export function normalizeEmailPreferences(
  raw: Partial<EmailPreferences> | null | undefined,
): EmailPreferences {
  let emailLocale: EmailLocale | null = null;
  if (raw && 'emailLocale' in raw) {
    if (raw.emailLocale === null) emailLocale = null;
    else if (isEmailLocale(raw.emailLocale)) emailLocale = raw.emailLocale;
  }

  return {
    weeklyRecommendations:
      raw?.weeklyRecommendations ?? DEFAULT_EMAIL_PREFERENCES.weeklyRecommendations,
    monthlyActivitySummary:
      raw?.monthlyActivitySummary ?? DEFAULT_EMAIL_PREFERENCES.monthlyActivitySummary,
    productAnnouncements:
      raw?.productAnnouncements ?? DEFAULT_EMAIL_PREFERENCES.productAnnouncements,
    storyPublished:
      raw?.storyPublished ?? DEFAULT_EMAIL_PREFERENCES.storyPublished,
    emailLocale,
  };
}

/**
 * Sanitises a partial update: known boolean keys + optional emailLocale (locale | null).
 */
export function sanitizeEmailPreferencesUpdate(body: unknown): EmailPreferencesUpdate | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const update: EmailPreferencesUpdate = {};
  let hasKey = false;
  const record = body as Record<string, unknown>;

  for (const key of EMAIL_PREFERENCE_BOOL_KEYS) {
    if (key in record) {
      const value = record[key];
      if (typeof value !== 'boolean') return null;
      update[key] = value;
      hasKey = true;
    }
  }

  if ('emailLocale' in record) {
    const value = record.emailLocale;
    if (value === null) {
      update.emailLocale = null;
      hasKey = true;
    } else if (isEmailLocale(value)) {
      update.emailLocale = value;
      hasKey = true;
    } else {
      return null;
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

/**
 * Updates account UI language (`preferredLocale`). Fire-and-forget friendly from clients.
 */
export async function updatePreferredLocale(
  userId: string,
  locale: EmailLocale,
): Promise<EmailLocale | null> {
  if (!isEmailLocale(locale)) return null;

  const [row] = await dbWrite
    .update(users)
    .set({ preferredLocale: locale, updatedAt: new Date() })
    .where(eq(users.userId, userId))
    .returning({ preferredLocale: users.preferredLocale });

  return isEmailLocale(row?.preferredLocale) ? row.preferredLocale : null;
}

/**
 * Resolves effective email language: emailLocale override ?? preferredLocale ?? en.
 */
export async function resolveEmailLocale(userId: string): Promise<EmailLocale> {
  const [row] = await dbRead
    .select({
      preferredLocale: users.preferredLocale,
      emailPreferences: users.emailPreferences,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return DEFAULT_EMAIL_LOCALE;

  const prefs = normalizeEmailPreferences(row.emailPreferences);
  if (isEmailLocale(prefs.emailLocale)) return prefs.emailLocale;
  if (isEmailLocale(row.preferredLocale)) return row.preferredLocale;
  return DEFAULT_EMAIL_LOCALE;
}

/**
 * Resolve locale when only email is known (e.g. password reset by email).
 */
export async function resolveEmailLocaleByEmail(email: string): Promise<EmailLocale> {
  const [row] = await dbRead
    .select({
      preferredLocale: users.preferredLocale,
      emailPreferences: users.emailPreferences,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!row) return DEFAULT_EMAIL_LOCALE;
  const prefs = normalizeEmailPreferences(row.emailPreferences);
  if (isEmailLocale(prefs.emailLocale)) return prefs.emailLocale;
  if (isEmailLocale(row.preferredLocale)) return row.preferredLocale;
  return DEFAULT_EMAIL_LOCALE;
}

/**
 * Locale-aware preferences deep link for email footers.
 */
export function preferencesUrlForLocale(locale: EmailLocale): string | undefined {
  const base = process.env.FRONTEND_URL;
  if (!base) return undefined;
  const prefix = emailLocalePathPrefix(locale);
  return `${base.replace(/\/$/, '')}${prefix}/dashboard/account/preferences?tab=notifications`;
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

export type UnsubscribeCategory =
  | 'weeklyRecommendations'
  | 'monthlyActivitySummary'
  | 'productAnnouncements'
  | 'storyPublished'
  | 'all';

interface UnsubscribePayload {
  userId: string;
  category: UnsubscribeCategory;
  exp: number;
}

const UNSUBSCRIBE_CATEGORIES: UnsubscribeCategory[] = [
  'weeklyRecommendations',
  'monthlyActivitySummary',
  'productAnnouncements',
  'storyPublished',
  'all',
];

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
    if (!UNSUBSCRIBE_CATEGORIES.includes(payload.category)) return null;
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
      storyPublished: false,
    });
  }
  return updateEmailPreferences(userId, { [category]: false });
}

/**
 * Builds a public unsubscribe URL for email footers.
 */
export function buildUnsubscribeUrl(
  userId: string,
  category: UnsubscribeCategory = 'all',
  locale?: EmailLocale,
): string | null {
  const base = process.env.FRONTEND_URL;
  if (!base) return null;
  const token = createUnsubscribeToken(userId, category);
  const prefix = emailLocalePathPrefix(locale ?? DEFAULT_EMAIL_LOCALE);
  return `${base.replace(/\/$/, '')}${prefix}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
