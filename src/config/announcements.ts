/**
 * Announcements tunables and client-translatable error codes.
 *
 * Mirrors the `src/config/broadcast.ts` pattern: a `const` array of codes
 * plus a derived union so invalid codes cannot be constructed (AGENTS.md §9
 * rule 2). Codes are `<namespace>.<key>` and resolve client-side to
 * `announcements.errors.<key>` in `messages/<locale>.json` — both locales must
 * define every key.
 */

/** Max characters for the announcement title. */
export const ANNOUNCEMENT_TITLE_MAX_LENGTH = 200;

/** Max characters for the plain-text body (banner chip + list row). */
export const ANNOUNCEMENT_BODY_MAX_LENGTH = 2000;

/** Max characters for the optional rich-detail HTML body. */
export const ANNOUNCEMENT_BODY_HTML_MAX_LENGTH = 50_000;

/** Max characters for the CTA label. */
export const ANNOUNCEMENT_CTA_TEXT_MAX_LENGTH = 80;

/**
 * Banner window applied when an announcement publishes without an explicit
 * `expiresAt` — also stamped back onto the row so `announcements.expires_at`
 * and `broadcasts.expires_at` always agree (single source for expiry).
 * Kept short on purpose: an active announcement parks the user megaphone
 * queue behind it (FIFO), so long windows would block broadcasts for days.
 */
export const ANNOUNCEMENT_DEFAULT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Error codes surfaced to clients. Every entry resolves to
 * `announcements.errors.<key>` in both `messages/en.json` and `messages/id.json`.
 */
export const ANNOUNCEMENT_ERROR_CODES = [
  /** Invalid kind/severity/status, missing required fields, bad time window. */
  "announcements.validation",
  /** No announcement row for the given id. */
  "announcements.notFound",
  /** Cap-1 invariant: another scheduled/active announcement already exists. */
  "announcements.anotherActiveExists",
  /** Edit attempted on an announcement that is already active (locked). */
  "announcements.locked",
  /** Publish/end attempted in a state that does not allow it. */
  "announcements.notPublishable",
  "announcements.emailUnavailable",
  "announcements.emailInProgress",
  "announcements.emailAlreadySent",
] as const;

export type AnnouncementErrorCode = (typeof ANNOUNCEMENT_ERROR_CODES)[number];

/** Type guard used when mapping arbitrary DB/HTTP failures to a known code. */
export function isAnnouncementErrorCode(value: unknown): value is AnnouncementErrorCode {
  return typeof value === "string" && (ANNOUNCEMENT_ERROR_CODES as readonly string[]).includes(value);
}
