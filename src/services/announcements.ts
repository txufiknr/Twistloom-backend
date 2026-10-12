/**
 * Announcements service — authoring, the publish pipeline into the broadcast
 * banner slot, and the user read model.
 *
 * Three surfaces, one record (see ADMIN_ANNOUNCEMENTS_BROADCAST_ROADMAP.md):
 * - **Banner** — publish inserts a `broadcasts` row (source `system`, linked
 *   via `announcementId`) that occupies the single live slot returned by
 *   `/broadcasts/current`; queued user megaphone broadcasts are parked behind
 *   the banner window rather than deleted (Q3).
 * - **Notification center** — `getUserAnnouncementState` returns the single
 *   active row + per-user unseen flag backed by `users.last_seen_announcement_id`.
 * - **Email** — the existing blast, stamped on the record via `emailSentAt`
 *   (handled in the admin route).
 *
 * Errors are thrown as `AnnouncementError` carrying a `<namespace>.<key>` code
 * that routes map to HTTP and clients translate (AGENTS.md §9).
 */

import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { type DBClient, dbRead, dbWrite } from "../db/client.js";
import { announcements, broadcasts, users } from "../db/schema.js";
import {
  ANNOUNCEMENT_CTA_TEXT_MAX_LENGTH,
  ANNOUNCEMENT_BODY_HTML_MAX_LENGTH,
  ANNOUNCEMENT_BODY_MAX_LENGTH,
  ANNOUNCEMENT_DEFAULT_WINDOW_SECONDS,
  ANNOUNCEMENT_TITLE_MAX_LENGTH,
  type AnnouncementErrorCode,
} from "../config/announcements.js";
import {
  ANNOUNCEMENT_PUBLISHED_STATUSES,
  isAnnouncementKind,
  isAnnouncementSeverity,
  isAnnouncementStatus,
  type ActiveAnnouncementResponse,
  type AnnouncementHistoryItem,
  type AnnouncementKind,
  type AnnouncementPublic,
  type AnnouncementSeverity,
  type AnnouncementStatus,
} from "../types/announcements.js";
import type { BroadcastStatus } from "../types/broadcast.js";
import { cleanSingleLineText, sanitizeText } from "../utils/text-processing.js";
import { sanitizeBlogHtml } from "../utils/sanitize-html.js";
import { getErrorMessage } from "../utils/error.js";
import { generateId, isValidUuid } from "../utils/uuid.js";
import { getRedisClient } from "../utils/redis.js";
import { invalidateCurrentBroadcastCache } from "./broadcast.js";

const LIVE_ANNOUNCEMENT_CACHE_KEY = "announcement:live";
const LIVE_ANNOUNCEMENT_CACHE_TTL_SECONDS = 30;

/** Invalidates the cached active announcement row in Redis. */
export async function invalidateLiveAnnouncementCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(LIVE_ANNOUNCEMENT_CACHE_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Tagged error carrying a client-translatable `announcements.*` code. */
export class AnnouncementError extends Error {
  constructor(
    public readonly code: AnnouncementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnnouncementError";
  }
}

type AnnouncementRow = typeof announcements.$inferSelect;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireCleanString(value: unknown, field: string, maxLength: number): string {
  const cleaned = cleanSingleLineText(value, maxLength);
  if (!cleaned) {
    throw new AnnouncementError("announcements.validation", `${field} is required.`);
  }
  return cleaned;
}

function sanitizeBody(value: unknown): string {
  const cleaned = sanitizeText(typeof value === "string" ? value : "", {
    preserveNewlines: true,
  }).trim();
  if (!cleaned) {
    throw new AnnouncementError("announcements.validation", "body is required.");
  }
  if (cleaned.length > ANNOUNCEMENT_BODY_MAX_LENGTH) {
    throw new AnnouncementError(
      "announcements.validation",
      `body must be at most ${ANNOUNCEMENT_BODY_MAX_LENGTH} characters.`,
    );
  }
  return cleaned;
}

async function sanitizeBodyHtml(value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AnnouncementError("announcements.validation", "bodyHtml must be a string.");
  }
  if (value.length > ANNOUNCEMENT_BODY_HTML_MAX_LENGTH * 2) {
    throw new AnnouncementError(
      "announcements.validation",
      `bodyHtml must be at most ${ANNOUNCEMENT_BODY_HTML_MAX_LENGTH} characters.`,
    );
  }
  const cleaned = await sanitizeBlogHtml(value);
  if (!cleaned) return null;
  if (cleaned.length > ANNOUNCEMENT_BODY_HTML_MAX_LENGTH) {
    throw new AnnouncementError(
      "announcements.validation",
      `bodyHtml must be at most ${ANNOUNCEMENT_BODY_HTML_MAX_LENGTH} characters.`,
    );
  }
  return cleaned;
}

/**
 * Validates an optional CTA pair. URLs are either internal app paths
 * (`/dashboard/...`) or absolute http(s) URLs — never `javascript:` and
 * never protocol-relative (`//host`).
 */
function validateCta(rawUrl: unknown, rawText: unknown): { ctaUrl: string | null; ctaText: string | null } {
  if (rawUrl === null || rawUrl === undefined || rawUrl === "") {
    return { ctaUrl: null, ctaText: null };
  }
  if (typeof rawUrl !== "string") {
    throw new AnnouncementError("announcements.validation", "ctaUrl must be a string.");
  }
  const url = rawUrl.trim();
  if (url.length > 2048) {
    throw new AnnouncementError("announcements.validation", "ctaUrl must be at most 2048 characters.");
  }
  const isInternalPath = url.startsWith("/") && !url.startsWith("//");
  const isAbsoluteHttp = /^https?:\/\/[^\s]+$/i.test(url);
  if (!isInternalPath && !isAbsoluteHttp) {
    throw new AnnouncementError(
      "announcements.validation",
      "ctaUrl must be an absolute http(s) URL or an internal path starting with '/'.",
    );
  }
  const text = cleanSingleLineText(rawText, ANNOUNCEMENT_CTA_TEXT_MAX_LENGTH);
  if (!text) {
    throw new AnnouncementError("announcements.validation", "ctaText is required when ctaUrl is set.");
  }
  return { ctaUrl: url, ctaText: text };
}

function parseIsoDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new AnnouncementError("announcements.validation", `${field} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AnnouncementError("announcements.validation", `${field} is not a valid date.`);
  }
  return parsed;
}

function validateKind(value: unknown): AnnouncementKind {
  if (!isAnnouncementKind(value)) {
    throw new AnnouncementError("announcements.validation", "kind is invalid.");
  }
  return value;
}

function validateSeverity(value: unknown): AnnouncementSeverity {
  if (!isAnnouncementSeverity(value)) {
    throw new AnnouncementError("announcements.validation", "severity is invalid.");
  }
  return value;
}

function validateI18nParams(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AnnouncementError("announcements.validation", "i18nParams must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) {
    throw new AnnouncementError("announcements.validation", "i18nParams has too many keys.");
  }
  const params: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== "string") {
      throw new AnnouncementError("announcements.validation", "i18nParams values must be strings.");
    }
    params[key] = entry.slice(0, 500);
  }
  return params;
}

function isUniqueViolation(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    (typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code === "23505") ||
    message.includes("announcements_one_published_unique") ||
    message.toLowerCase().includes("duplicate key value violates unique constraint")
  );
}

// ---------------------------------------------------------------------------
// Row mappings & shared filters
// ---------------------------------------------------------------------------

/** Maps a row to the user-facing projection (never leaks author/draft data). */
export function toPublicAnnouncement(row: AnnouncementRow): AnnouncementPublic {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    cta: row.ctaUrl && row.ctaText ? { url: row.ctaUrl, text: row.ctaText } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const publishedStatusFilter = inArray(announcements.status, [...ANNOUNCEMENT_PUBLISHED_STATUSES]);

/**
 * Lazily flips published rows whose window has elapsed to `ended` so the cap-1
 * slot frees up and status chips stay honest. Idempotent; called from write
 * paths (publish/list) — user read paths filter by time instead, staying
 * strictly read-only.
 */
async function expireDueAnnouncements(client: DBClient): Promise<void> {
  const now = new Date();
  await client
    .update(announcements)
    .set({ status: "ended", updatedAt: now })
    .where(
      and(
        publishedStatusFilter,
        isNotNull(announcements.expiresAt),
        lte(announcements.expiresAt, now),
      ),
    );
}

/** Lazily promotes `scheduled` rows whose `starts_at` has arrived to `active`. */
async function activateDueAnnouncements(client: DBClient): Promise<void> {
  const now = new Date();
  await client
    .update(announcements)
    .set({ status: "active", updatedAt: now })
    .where(
      and(
        eq(announcements.status, "scheduled"),
        isNotNull(announcements.startsAt),
        lte(announcements.startsAt, now),
      ),
    );
}

/** Runs both idempotent sweeps — expire AFTER activate so an elapsed scheduled row settles as `ended`. */
async function sweepAnnouncementLifecycle(client: DBClient): Promise<void> {
  await activateDueAnnouncements(client);
  await expireDueAnnouncements(client);
}

/**
 * The single live announcement: a published row that has started and not yet
 * expired. Under cap-1 at most one row can match; `scheduled` rows whose start
 * time has arrived are treated as live (their status is promoted on admin
 * write paths, never on this hot read).
 */
async function getLiveAnnouncementRow(): Promise<AnnouncementRow | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get(LIVE_ANNOUNCEMENT_CACHE_KEY);
      if (cached !== null && cached !== undefined) {
        if (cached === "null") return null;
        const parsed = JSON.parse(cached as string);
        return {
          ...parsed,
          startsAt: parsed.startsAt ? new Date(parsed.startsAt) : null,
          expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
          emailSentAt: parsed.emailSentAt ? new Date(parsed.emailSentAt) : null,
          createdAt: new Date(parsed.createdAt),
          updatedAt: new Date(parsed.updatedAt),
        } as AnnouncementRow;
      }
    } catch {
      /* fall through to DB */
    }
  }

  const now = new Date();
  const [row] = await dbRead
    .select()
    .from(announcements)
    .where(
      and(
        publishedStatusFilter,
        or(isNull(announcements.startsAt), lte(announcements.startsAt, now)),
        or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
      ),
    )
    .limit(1);

  const result = row ?? null;
  if (redis) {
    try {
      await redis.set(
        LIVE_ANNOUNCEMENT_CACHE_KEY,
        result ? JSON.stringify(result) : "null",
        { ex: LIVE_ANNOUNCEMENT_CACHE_TTL_SECONDS },
      );
    } catch {
      /* non-fatal */
    }
  }

  return result;
}

async function getLastSeenId(userId: string): Promise<string | null> {
  const [user] = await dbRead
    .select({ lastSeenId: users.lastSeenAnnouncementId })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  return user?.lastSeenId ?? null;
}

// ---------------------------------------------------------------------------
// User read model
// ---------------------------------------------------------------------------

/**
 * Read model for `GET /announcements`: the live announcement (or null) plus
 * the per-user unseen flag (false for guests). Two indexed point lookups —
 * active row via the cap-1 partial index, user row by PK.
 */
export async function getUserAnnouncementState(userId?: string | null): Promise<ActiveAnnouncementResponse> {
  const announcement = await getLiveAnnouncementRow();
  if (!announcement) return { announcement: null, unseen: false };
  if (!userId) {
    return {
      announcement: toPublicAnnouncement(announcement),
      unseen: false,
    };
  }
  const lastSeenId = await getLastSeenId(userId);
  return {
    announcement: toPublicAnnouncement(announcement),
    unseen: lastSeenId !== announcement.id,
  };
}

/**
 * The 0/1 announcement contribution to the notification badge — folded
 * server-side into the `/notifications/unread-count` and list envelopes so
 * every badge call-site stays a single number (Q1).
 */
export async function getAnnouncementUnseenCount(userId: string): Promise<number> {
  const announcement = await getLiveAnnouncementRow();
  if (!announcement) return 0;
  const lastSeenId = await getLastSeenId(userId);
  return lastSeenId !== announcement.id ? 1 : 0;
}

/**
 * Idempotent seen-state write: points `users.last_seen_announcement_id` at
 * the given announcement. Validates that the target announcement exists.
 */
export async function markAnnouncementSeen(userId: string, announcementId: string): Promise<void> {
  if (!isValidUuid(announcementId)) {
    throw new AnnouncementError("announcements.validation", "Invalid announcement ID.");
  }

  const [exists] = await dbRead
    .select({ id: announcements.id })
    .from(announcements)
    .where(eq(announcements.id, announcementId))
    .limit(1);

  if (!exists) {
    throw new AnnouncementError("announcements.notFound", "Announcement not found.");
  }

  await dbWrite
    .update(users)
    .set({ lastSeenAnnouncementId: announcementId })
    .where(eq(users.userId, userId));
}

/**
 * Clears the unseen flag when there is a live announcement — used by
 * `POST /notifications/read-all` so "mark all read" fully clears the badge.
 * No-op when nothing is active.
 */
export async function markActiveAnnouncementSeen(userId: string): Promise<void> {
  const announcement = await getLiveAnnouncementRow();
  if (!announcement) return;
  const lastSeenId = await getLastSeenId(userId);
  if (lastSeenId === announcement.id) return;
  await markAnnouncementSeen(userId, announcement.id);
}

// ---------------------------------------------------------------------------
// User read model: history
// ---------------------------------------------------------------------------

export interface AnnouncementHistoryResult {
  items: AnnouncementHistoryItem[];
  totalCount: number;
}

/** Maps a row to the history projection (public fields + lifecycle window). */
function toHistoryItem(row: AnnouncementRow): AnnouncementHistoryItem {
  return {
    ...toPublicAnnouncement(row),
    status: row.status,
    startsAt: row.startsAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Page-number paginated history for `GET /announcements/history`: every
 * non-draft row whose window has started (the live one + everything ended),
 * newest first by effective start (`COALESCE(starts_at, created_at)`).
 *
 * Strictly read-only — lifecycle sweeps never run on user reads; a
 * `scheduled` row whose start time has already arrived is returned with its
 * stored status (promoted on the next admin write). Cap-1 limits only the
 * LIVE slot, never history depth.
 */
export async function listUserAnnouncementHistory(
  page: number,
  limit: number,
): Promise<AnnouncementHistoryResult> {
  const now = new Date();
  const visibilityFilter = and(
    ne(announcements.status, "draft"),
    or(isNull(announcements.startsAt), lte(announcements.startsAt, now)),
  );
  const [rows, totalRow] = await Promise.all([
    dbRead
      .select()
      .from(announcements)
      .where(visibilityFilter)
      .orderBy(desc(sql`COALESCE(${announcements.startsAt}, ${announcements.createdAt})`))
      .limit(limit)
      .offset((page - 1) * limit),
    dbRead.select({ value: count() }).from(announcements).where(visibilityFilter),
  ]);
  return { items: rows.map(toHistoryItem), totalCount: totalRow[0]?.value ?? 0 };
}

// ---------------------------------------------------------------------------
// Admin: authoring
// ---------------------------------------------------------------------------

export interface CreateAnnouncementInput {
  kind?: unknown;
  severity?: unknown;
  title?: unknown;
  body?: unknown;
  bodyHtml?: unknown;
  ctaUrl?: unknown;
  ctaText?: unknown;
  i18nKey?: unknown;
  i18nParams?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Creates a `draft` row. Publishing is a separate step so drafts never touch
 * the cap-1 invariant or the banner slot.
 */
export async function createAnnouncement(
  input: CreateAnnouncementInput,
  createdBy: string,
): Promise<AnnouncementRow> {
  const kind = validateKind(input.kind);
  const severity = validateSeverity(input.severity);
  const title = requireCleanString(input.title, "title", ANNOUNCEMENT_TITLE_MAX_LENGTH);
  const body = sanitizeBody(input.body);
  const bodyHtml = await sanitizeBodyHtml(input.bodyHtml);
  const { ctaUrl, ctaText } = validateCta(input.ctaUrl, input.ctaText);
  const startsAt = parseIsoDate(input.startsAt, "startsAt");
  const expiresAt = parseIsoDate(input.expiresAt, "expiresAt");
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    throw new AnnouncementError("announcements.validation", "expiresAt must be after startsAt.");
  }
  const i18nKey =
    input.i18nKey === null || input.i18nKey === undefined || input.i18nKey === ""
      ? null
      : requireCleanString(input.i18nKey, "i18nKey", 200);
  const i18nParams = validateI18nParams(input.i18nParams);

  const [row] = await dbWrite
    .insert(announcements)
    .values({
      kind,
      severity,
      title,
      body,
      bodyHtml,
      ctaUrl,
      ctaText,
      i18nKey,
      i18nParams,
      startsAt,
      expiresAt,
      status: "draft",
      createdBy,
    })
    .returning();
  if (!row) throw new AnnouncementError("announcements.validation", "Failed to create announcement.");
  return row;
}

export interface UpdateAnnouncementInput {
  kind?: unknown;
  severity?: unknown;
  title?: unknown;
  body?: unknown;
  bodyHtml?: unknown;
  ctaUrl?: unknown;
  ctaText?: unknown;
  i18nKey?: unknown;
  i18nParams?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Edits a draft or scheduled announcement (locked once active — enforced by
 * `sweepAnnouncementLifecycle` + the status check so a due-scheduled row can't
 * slip through). When the row is already scheduled, the linked banner row is
 * kept in sync in the same transaction.
 */
export async function updateAnnouncement(id: string, input: UpdateAnnouncementInput): Promise<AnnouncementRow> {
  const result = await dbWrite.transaction(async (tx) => {
    await sweepAnnouncementLifecycle(tx);

    const [row] = await tx.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!row) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
    if (row.status === "active" || row.status === "ended") {
      throw new AnnouncementError("announcements.locked", "Only draft or scheduled announcements can be edited.");
    }

    const patch: Partial<AnnouncementRow> = {};
    if (input.kind !== undefined) patch.kind = validateKind(input.kind);
    if (input.severity !== undefined) patch.severity = validateSeverity(input.severity);
    if (input.title !== undefined) patch.title = requireCleanString(input.title, "title", ANNOUNCEMENT_TITLE_MAX_LENGTH);
    if (input.body !== undefined) patch.body = sanitizeBody(input.body);
    if (input.bodyHtml !== undefined) patch.bodyHtml = await sanitizeBodyHtml(input.bodyHtml);
    if (input.ctaUrl !== undefined || input.ctaText !== undefined) {
      const url = input.ctaUrl === undefined ? row.ctaUrl : input.ctaUrl;
      const text = input.ctaText === undefined ? row.ctaText : input.ctaText;
      const cta = validateCta(url, text);
      patch.ctaUrl = cta.ctaUrl;
      patch.ctaText = cta.ctaText;
    }
    if (input.i18nKey !== undefined) {
      patch.i18nKey =
        input.i18nKey === null || input.i18nKey === "" ? null : requireCleanString(input.i18nKey, "i18nKey", 200);
    }
    if (input.i18nParams !== undefined) patch.i18nParams = validateI18nParams(input.i18nParams);

    let startsAt = row.startsAt;
    let expiresAt = row.expiresAt;
    if (input.startsAt !== undefined) startsAt = parseIsoDate(input.startsAt, "startsAt");
    if (input.expiresAt !== undefined) expiresAt = parseIsoDate(input.expiresAt, "expiresAt");
    if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
      throw new AnnouncementError("announcements.validation", "expiresAt must be after startsAt.");
    }
    if (input.startsAt !== undefined) patch.startsAt = startsAt;
    if (input.expiresAt !== undefined) patch.expiresAt = expiresAt;

    const [updated] = await tx
      .update(announcements)
      .set(patch)
      .where(eq(announcements.id, id))
      .returning();
    if (!updated) throw new AnnouncementError("announcements.notFound", "Announcement not found.");

    // Keep the pre-created banner row in sync for scheduled announcements.
    if (updated.status === "scheduled" && updated.broadcastId) {
      await tx
        .update(broadcasts)
        .set({
          message: updated.body,
          messageKey: updated.i18nKey,
          messageParams: updated.i18nParams,
          severity: updated.severity,
          ctaUrl: updated.ctaUrl,
          ctaText: updated.ctaText,
          startsAt: updated.startsAt ?? new Date(),
          expiresAt: updated.expiresAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(broadcasts.id, updated.broadcastId));
      await invalidateCurrentBroadcastCache();
    }

    return updated;
  });

  await invalidateLiveAnnouncementCache();
  return result;
}

// ---------------------------------------------------------------------------
// Admin: publish pipeline
// ---------------------------------------------------------------------------

/**
 * Resolves the `broadcasts.user_id` for a banner row (NOT NULL + FK): the
 * platform account (`SYSTEM_USER_ID`) when it exists in `users` (renders the
 * platform name on the banner per Step 8), otherwise the publishing admin.
 */
async function resolveBannerUserId(client: DBClient, publisherId: string): Promise<string> {
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (isValidUuid(systemUserId)) {
    const [row] = await client
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, systemUserId))
      .limit(1);
    if (row) return row.userId;
  }
  return publisherId;
}

/**
 * Parks overlapping queued user megaphone broadcasts behind the banner window
 * so an active announcement truly owns the single live slot (Q3). Durations
 * and FIFO order are preserved; nothing is deleted. Rows already scheduled
 * after the banner are untouched.
 */
async function parkUserBroadcastsBehind(tx: DBClient, bannerStart: Date, bannerEnd: Date): Promise<void> {
  const now = new Date();
  const overlapping = await tx
    .select({ id: broadcasts.id, startsAt: broadcasts.startsAt, expiresAt: broadcasts.expiresAt })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.status, "queued"),
        eq(broadcasts.source, "user"),
        gt(broadcasts.expiresAt, now),
        lt(broadcasts.startsAt, bannerEnd),
        gt(broadcasts.expiresAt, bannerStart),
      ),
    )
    .orderBy(asc(broadcasts.startsAt));

  let cursor = bannerEnd.getTime();
  for (const row of overlapping) {
    const duration = row.expiresAt.getTime() - row.startsAt.getTime();
    const newStart = Math.max(cursor, row.startsAt.getTime());
    const newExpires = newStart + duration;
    if (newStart === row.startsAt.getTime()) {
      cursor = newExpires;
      continue;
    }
    await tx
      .update(broadcasts)
      .set({ startsAt: new Date(newStart), expiresAt: new Date(newExpires), updatedAt: now })
      .where(eq(broadcasts.id, row.id));
    cursor = newExpires;
  }
}

/**
 * Pulls every queued user broadcast forward to resume right now (FIFO order
 * and durations preserved). Called when an announcement ends early so
 * broadcasts parked behind a multi-hour/day window aren't stranded until the
 * original window end. If a user broadcast is currently live, the cursor
 * starts from its expiry rather than `now` to prevent overlapping banners.
 */
async function releaseUserBroadcasts(tx: DBClient): Promise<void> {
  const now = new Date();
  const [activeUserBroadcast] = await tx
    .select({ expiresAt: broadcasts.expiresAt })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.status, "queued"),
        eq(broadcasts.source, "user"),
        lte(broadcasts.startsAt, now),
        gt(broadcasts.expiresAt, now),
      ),
    )
    .limit(1);

  const pending = await tx
    .select({ id: broadcasts.id, startsAt: broadcasts.startsAt, expiresAt: broadcasts.expiresAt })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.status, "queued"),
        eq(broadcasts.source, "user"),
        gt(broadcasts.startsAt, now),
        gt(broadcasts.expiresAt, now),
      ),
    )
    .orderBy(asc(broadcasts.startsAt));

  let cursor = activeUserBroadcast ? activeUserBroadcast.expiresAt.getTime() : now.getTime();
  for (const row of pending) {
    const duration = row.expiresAt.getTime() - row.startsAt.getTime();
    await tx
      .update(broadcasts)
      .set({ startsAt: new Date(cursor), expiresAt: new Date(cursor + duration), updatedAt: now })
      .where(eq(broadcasts.id, row.id));
    cursor += duration;
  }
}

export interface PublishAnnouncementOptions {
  startsAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Publishes an announcement: enforces the cap-1 invariant (clean pre-check +
 * race-proof partial unique index), resolves the visibility window, inserts
 * the banner row, and parks queued user broadcasts behind the window.
 *
 * - Publishing a row that is already `active` is a no-op (double-click safe).
 * - `startsAt` in the future ⇒ status `scheduled`; the banner row waits via
 *   its own `starts_at` (no scheduler process needed for the banner).
 *
 * @throws `AnnouncementError` with `announcements.anotherActiveExists` when a
 *   concurrent publish already claimed the cap-1 slot.
 */
export async function publishAnnouncement(
  id: string,
  options: PublishAnnouncementOptions,
  publisherId: string,
): Promise<AnnouncementRow> {
  let result: AnnouncementRow;
  try {
    result = await dbWrite.transaction(async (tx) => {
      await sweepAnnouncementLifecycle(tx);

      const [row] = await tx.select().from(announcements).where(eq(announcements.id, id)).limit(1);
      if (!row) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
      if (row.status === "active") return row;

      const [other] = await tx
        .select({ id: announcements.id })
        .from(announcements)
        .where(and(publishedStatusFilter, ne(announcements.id, id)))
        .limit(1);
      if (other) {
        throw new AnnouncementError(
          "announcements.anotherActiveExists",
          "Another announcement is already published. End it before publishing this one.",
        );
      }

      const now = new Date();
      const startsAt = parseIsoDate(options.startsAt, "startsAt") ?? row.startsAt ?? now;
      const expiresAt =
        parseIsoDate(options.expiresAt, "expiresAt") ??
        row.expiresAt ??
        new Date(startsAt.getTime() + ANNOUNCEMENT_DEFAULT_WINDOW_SECONDS * 1000);
      if (expiresAt.getTime() <= startsAt.getTime()) {
        throw new AnnouncementError("announcements.validation", "expiresAt must be after startsAt.");
      }
      const status: AnnouncementStatus = startsAt.getTime() > now.getTime() ? "scheduled" : "active";

      // Banner row — direct insert (not sendSystemBroadcast): the window is
      // admin-defined, not the 8-second event display window.
      const broadcastId = generateId();
      const bannerUserId = await resolveBannerUserId(tx, publisherId);
      await tx.insert(broadcasts).values({
        id: broadcastId,
        userId: bannerUserId,
        source: "system",
        type: "message",
        message: row.body,
        messageKey: row.i18nKey,
        messageParams: row.i18nParams,
        status: "queued" satisfies BroadcastStatus,
        moderationResult: { outcome: "approve", reasons: [] },
        containsSpoiler: false,
        announcementId: row.id,
        severity: row.severity,
        ctaUrl: row.ctaUrl,
        ctaText: row.ctaText,
        startsAt,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });

      await parkUserBroadcastsBehind(tx, startsAt, expiresAt);

      const [updated] = await tx
        .update(announcements)
        .set({ status, startsAt, expiresAt, broadcastId, updatedAt: now })
        .where(eq(announcements.id, id))
        .returning();
      if (!updated) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
      return updated;
    });
  } catch (error) {
    // Concurrent publish hit the race-proof partial unique index.
    if (isUniqueViolation(error)) {
      throw new AnnouncementError(
        "announcements.anotherActiveExists",
        "Another announcement is already published. End it before publishing this one.",
      );
    }
    throw error;
  }

  await invalidateCurrentBroadcastCache();
  await invalidateLiveAnnouncementCache();
  return result;
}

/**
 * Revokes an announcement: flips status to `ended`, expires the banner row
 * (clears the single live slot immediately), and releases parked user
 * broadcasts so the megaphone queue resumes now instead of at the original
 * window end. Idempotent on already-ended rows.
 *
 * @throws `AnnouncementError` with `announcements.notPublishable` for drafts.
 */
export async function endAnnouncement(id: string): Promise<AnnouncementRow> {
  const result = await dbWrite.transaction(async (tx) => {
    const [row] = await tx.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!row) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
    if (row.status === "ended") return row;
    if (row.status === "draft") {
      throw new AnnouncementError("announcements.notPublishable", "A draft cannot be ended — publish it first.");
    }

    const now = new Date();
    const [updated] = await tx
      .update(announcements)
      .set({ status: "ended", updatedAt: now })
      .where(eq(announcements.id, id))
      .returning();

    if (row.broadcastId) {
      await tx
        .update(broadcasts)
        .set({ status: "expired" satisfies BroadcastStatus, expiresAt: now, updatedAt: now })
        .where(eq(broadcasts.id, row.broadcastId));
    }
    await releaseUserBroadcasts(tx);
    return updated ?? row;
  });

  await invalidateCurrentBroadcastCache();
  await invalidateLiveAnnouncementCache();
  return result;
}

/**
 * Deletes an announcement: only drafts can be deleted. Published, active, or
 * ended announcements are locked for auditing and history preservation.
 *
 * @throws `AnnouncementError` with `announcements.notFound` if the row does not exist.
 * @throws `AnnouncementError` with `announcements.locked` if the row is not in `draft` status.
 */
export async function deleteAnnouncement(id: string): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    const [row] = await tx.select().from(announcements).where(eq(announcements.id, id)).limit(1);
    if (!row) throw new AnnouncementError("announcements.notFound", "Announcement not found.");
    if (row.status !== "draft") {
      throw new AnnouncementError("announcements.locked", "Only draft announcements can be deleted.");
    }
    await tx.delete(announcements).where(eq(announcements.id, id));
  });
  await invalidateLiveAnnouncementCache();
}

// ---------------------------------------------------------------------------
// Admin: history listing
// ---------------------------------------------------------------------------

export interface ListAnnouncementsParams {
  status?: unknown;
  kind?: unknown;
  limit: number;
  offset: number;
}

export interface ListAnnouncementsResult {
  items: AnnouncementRow[];
  total: number;
}

/** Paginated history, newest first, with optional status/kind filters. */
export async function listAnnouncements(params: ListAnnouncementsParams): Promise<ListAnnouncementsResult> {
  // Keep chips honest before reporting (rare, admin-triggered writes).
  await sweepAnnouncementLifecycle(dbWrite);

  const filters = [];
  if (params.status !== undefined && params.status !== "") {
    if (!isAnnouncementStatus(params.status)) {
      throw new AnnouncementError("announcements.validation", "status filter is invalid.");
    }
    filters.push(eq(announcements.status, params.status));
  }
  if (params.kind !== undefined && params.kind !== "") {
    filters.push(eq(announcements.kind, validateKind(params.kind)));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [items, totalRow] = await Promise.all([
    dbRead
      .select()
      .from(announcements)
      .where(where)
      .orderBy(desc(announcements.createdAt))
      .limit(params.limit)
      .offset(params.offset),
    dbRead.select({ value: count() }).from(announcements).where(where),
  ]);

  return { items, total: totalRow[0]?.value ?? 0 };
}
