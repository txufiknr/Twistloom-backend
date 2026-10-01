/**
 * @summary Shared reader for the `admin_settings` key-value store
 * @description SSOT for admin setting defaults and threshold lookups.
 *
 * Consumers:
 * - `routes/admin.ts` — seeds defaults, ban content takedowns
 * - `routes/books.ts` — testimonial auto-reject threshold on submission
 * - `cron/social-mentions.ts` — mention auto-approve threshold on ingest
 *
 * Reads always merge stored values over {@link DEFAULT_ADMIN_SETTINGS} so a
 * key that has never been seeded (super admin never opened /admin/settings)
 * still resolves to its documented default instead of `undefined`.
 */
import { dbRead, dbWrite } from "../db/client.js";
import { adminSettings } from "../db/schema.js";

/** Default values for every supported setting key (validation + fallback SSOT). */
export const DEFAULT_ADMIN_SETTINGS: Record<string, unknown> = {
  "ban.hide_books": false,
  "ban.anonymize_comments": false,
  "ban.reject_testimonials": false,
  "ban.revoke_sessions": false,
  "moderation.auto_reject_testimonial_score": 3.0,
  "moderation.auto_approve_mention_score": 4.0,
};

export interface ModerationThresholds {
  /** Testimonials whose integer rating (1-5) is strictly below this are auto-rejected. */
  autoRejectTestimonialScore: number;
  /** Cron-ingested mentions whose normalized relevance (0-5) is strictly above this are auto-approved. */
  autoApproveMentionScore: number;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Loads all settings as a key-value map. Never throws — falls back to
 * {@link DEFAULT_ADMIN_SETTINGS} on any DB error so moderation consumers
 * degrade to documented defaults instead of failing content ingestion.
 */
export async function getAdminSettingsMap(): Promise<Record<string, unknown>> {
  try {
    const rows = await dbRead.select().from(adminSettings);
    const map: Record<string, unknown> = { ...DEFAULT_ADMIN_SETTINGS };
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map;
  } catch (error) {
    console.error("[admin-settings] Failed to read admin_settings, using defaults:", error);
    return { ...DEFAULT_ADMIN_SETTINGS };
  }
}

/** Reads the moderation thresholds (validated numeric, defaults applied). */
export async function getModerationThresholds(): Promise<ModerationThresholds> {
  const settings = await getAdminSettingsMap();
  return {
    autoRejectTestimonialScore: toFiniteNumber(
      settings["moderation.auto_reject_testimonial_score"],
      3.0,
    ),
    autoApproveMentionScore: toFiniteNumber(
      settings["moderation.auto_approve_mention_score"],
      4.0,
    ),
  };
}

/**
 * Result of an enforcement-critical settings read.
 *
 * `ok: false` means the stored policy could NOT be resolved — it does **not**
 * mean "no takedowns configured". Callers must surface this instead of
 * substituting defaults.
 */
export type BanPolicyResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: unknown };

/**
 * Loads the ban policy for an **explicit administrator enforcement action**.
 *
 * Consumer contract (deliberately different from {@link getAdminSettingsMap}):
 *
 * | Consumer | Reader | On DB failure |
 * |---|---|---|
 * | Content ingestion, testimonial/mention thresholds | `getAdminSettingsMap` | **fail-open** to {@link DEFAULT_ADMIN_SETTINGS} — a missing setting must not block ingestion |
 * | Admin ban takedowns (`ban.hide_books`, `ban.revoke_sessions`, …) | `getBanPolicy` | **fail-loud** — substituting `false` would silently skip configured takedowns (policy drift) while the ban itself succeeds |
 *
 * Reads from the primary (`dbWrite`) so a just-changed setting is visible and
 * so replica unavailability cannot masquerade as "unset". The ban must still
 * proceed when this fails — `users.bannedAt` is the actual lockout — so callers
 * report `settingsUnresolved` rather than aborting.
 *
 * @returns `{ ok: true, settings }` with defaults merged under stored values,
 *          or `{ ok: false, error }` when the policy could not be read
 */
export async function getBanPolicy(): Promise<BanPolicyResult> {
  try {
    const rows = await dbWrite.select().from(adminSettings);
    const map: Record<string, unknown> = { ...DEFAULT_ADMIN_SETTINGS };
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return { ok: true, settings: map };
  } catch (error) {
    console.error("[admin-settings] ❌ Failed to read admin_settings for enforcement action:", error);
    return { ok: false, error };
  }
}

/**
 * The cron relevance heuristic (`computeLocalHeuristics`) scores 0-100+, while
 * `moderation.auto_approve_mention_score` is a 0-5 threshold (matching the
 * Settings UI). Normalizes relevance onto the 0-5 scale for comparison.
 */
export function normalizeMentionRelevance(relevanceScore: number): number {
  return Math.max(0, Math.min(5, relevanceScore / 20));
}
