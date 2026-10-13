import type { EmailType } from "../types/email-delivery.js";
import type { EmailPreferenceBoolKey } from "../types/email-preferences.js";
export interface EmailPolicy { priority: number; lifetimeMs: number; preference?: EmailPreferenceBoolKey }
const hour = 3600_000;
/** Exhaustive registry: adding an email requires an explicit policy. Lower priority numbers go first. */
export const EMAIL_POLICIES: Record<EmailType, EmailPolicy> = {
  verification: { priority: 0, lifetimeMs: 15 * 60_000 }, password_reset: { priority: 0, lifetimeMs: hour },
  password_changed: { priority: 0, lifetimeMs: 7 * 24 * hour }, email_changed: { priority: 0, lifetimeMs: 7 * 24 * hour },
  account_deleted: { priority: 0, lifetimeMs: 24 * hour }, welcome: { priority: 1, lifetimeMs: 48 * hour },
  trial_ending: { priority: 1, lifetimeMs: 24 * hour }, payment_failed: { priority: 1, lifetimeMs: 48 * hour },
  refund: { priority: 1, lifetimeMs: 7 * 24 * hour }, subscription_canceled: { priority: 1, lifetimeMs: 7 * 24 * hour },
  feedback_ack: { priority: 1, lifetimeMs: 48 * hour }, feedback_internal: { priority: 1, lifetimeMs: 48 * hour },
  weekly: { priority: 2, lifetimeMs: 48 * hour, preference: "weeklyRecommendations" },
  monthly: { priority: 2, lifetimeMs: 7 * 24 * hour, preference: "monthlyActivitySummary" },
  announcement: { priority: 2, lifetimeMs: 7 * 24 * hour, preference: "productAnnouncements" },
  story_published: { priority: 2, lifetimeMs: 48 * hour, preference: "storyPublished" },
};
export function emailWorkerUrl(): string | null {
  try {
    const base = new URL(process.env.BACKEND_URL ?? "");
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password
      || (process.env.NODE_ENV === "production" && base.protocol !== "https:")) return null;
    return new URL("/api/cron/emails", base).href;
  } catch { return null; }
}
/** Rollout gate: deliberately disabled until the shared schema and infrastructure are provisioned. */
export function emailDeliveryEnabled(): boolean {
  return process.env.EMAIL_DELIVERY_ENABLED === "true" && Boolean(process.env.RESEND_API_KEY)
    && Boolean(process.env.CRON_SECRET) && Boolean(process.env.QSTASH_TOKEN) && emailWorkerUrl() !== null
    && Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
    && (process.env.NODE_ENV !== "production" || /^[0-9a-f]{64}$/i.test(process.env.PII_ENCRYPTION_KEY_HEX ?? ""));
}
function positive(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
export const emailRequestsPerSecond = () => positive(process.env.EMAIL_REQUESTS_PER_SECOND, 2, 1000);
export const emailConcurrency = () => positive(process.env.EMAIL_CONCURRENCY, 8, 32);
export const EMAIL_LEASE_MS = 90_000;
export const EMAIL_WORK_BUDGET_MS = 40_000;
export const EMAIL_PROVIDER_TIMEOUT_MS = 8000;
export const EMAIL_AUDIENCE_BATCH = 250;
export const EMAIL_SEND_BATCH = 50;
export const EMAIL_MAX_ATTEMPTS = 6;
export const EMAIL_SAFE_RETRY_MS = 23 * hour;
export const EMAIL_WORKERS = 4;
export const EMAIL_RETENTION_MS = 90 * 24 * hour;
