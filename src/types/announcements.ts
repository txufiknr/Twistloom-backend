/**
 * Platform announcement types (admin-authored, cap-1 active).
 *
 * An announcement is authored once (draft → scheduled/active → ended) and is
 * surfaced on three surfaces: the BroadcastBanner slot (via a linked
 * `broadcasts` row), the notification-center pinned section, and an optional
 * email blast. See `ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP.md` (frontend repo)
 * for the full design.
 *
 * Vocabulary is validated with the exported guards — never with ad-hoc string
 * checks (AGENTS.md §10 "Type Safety").
 */

import type { PaginatedResponse } from "../utils/pagination.js";

/** Content category of an announcement. */
export type AnnouncementKind = "maintenance" | "feature" | "promo" | "incident";

/** Visual urgency of an announcement; drives banner/panel styling. */
export type AnnouncementSeverity = "info" | "warning" | "critical";

/**
 * Lifecycle of an announcement row:
 * - `draft`     — authored, never published
 * - `scheduled` — published with a future `starts_at`
 * - `active`    — published; live while `starts_at <= now < expires_at`
 * - `ended`     — revoked or expired (terminal)
 */
export type AnnouncementStatus = "draft" | "scheduled" | "active" | "ended";

export const ANNOUNCEMENT_KINDS = ["maintenance", "feature", "promo", "incident"] as const;

export const ANNOUNCEMENT_SEVERITIES = ["info", "warning", "critical"] as const;

export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "active", "ended"] as const;

/** Statuses that count toward the cap-1 invariant (published, not terminal). */
export const ANNOUNCEMENT_PUBLISHED_STATUSES = ["scheduled", "active"] as const;

export function isAnnouncementKind(value: unknown): value is AnnouncementKind {
  return typeof value === "string" && (ANNOUNCEMENT_KINDS as readonly string[]).includes(value);
}

export function isAnnouncementSeverity(value: unknown): value is AnnouncementSeverity {
  return typeof value === "string" && (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(value);
}

export function isAnnouncementStatus(value: unknown): value is AnnouncementStatus {
  return typeof value === "string" && (ANNOUNCEMENT_STATUSES as readonly string[]).includes(value);
}

/** Optional call-to-action rendered on the banner and pinned section. */
export interface AnnouncementCta {
  url: string;
  text: string;
}

/**
 * User-facing projection returned by `GET /announcements`.
 *
 * Never includes `createdBy`, draft rows, or email metadata — announcements
 * are a public platform communication, not an admin record.
 */
export interface AnnouncementPublic {
  id: string;
  kind: AnnouncementKind;
  severity: AnnouncementSeverity;
  title: string;
  body: string;
  cta: AnnouncementCta | null;
  createdAt: string;
}

/**
 * Envelope for `GET /announcements` — the single active announcement (cap-1)
 * plus the per-user unseen flag.
 */
export interface ActiveAnnouncementResponse {
  /** The live announcement, or null when none is active right now. */
  announcement: AnnouncementPublic | null;
  /** True when an announcement is active and the user has not seen it yet. */
  unseen: boolean;
}

/**
 * Row shape of `GET /announcements/history` — the public projection plus the
 * lifecycle window so the list can render status chips and dates without a
 * second lookup. `startsAt`/`expiresAt` are nullable (an active row may run
 * indefinitely).
 */
export interface AnnouncementHistoryItem extends AnnouncementPublic {
  status: AnnouncementStatus;
  startsAt: string | null;
  expiresAt: string | null;
}

/**
 * Envelope for `GET /announcements/history` — page-number pagination shared
 * with every other user-facing list (`books`, `comments`, …).
 */
export type AnnouncementHistoryResponse = PaginatedResponse<AnnouncementHistoryItem, "announcements">;
