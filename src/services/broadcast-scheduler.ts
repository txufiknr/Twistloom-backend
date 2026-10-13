/** Shared scheduling for the single global banner slot. */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DBTransaction } from "../db/client.js";
import { broadcasts } from "../db/schema.js";
import { BROADCAST_GLOBAL_INTERVAL_SECONDS } from "../config/broadcast.js";

/** Acquire before any announcement/inventory row locks; released by COMMIT/ROLLBACK. */
export async function lockBroadcastSchedule(tx: DBTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1415008845, 1)`);
}

/** A reserved announcement display window. */
export interface BannerWindow { startsAt: Date; expiresAt: Date }

/** Ordinary broadcasts keep their original duration and creation-order FIFO. */
export interface QueueEntry extends BannerWindow { id: string; createdAt: Date }

/**
 * Pure queue planning. Keep a live display intact, cascade shifts on insertion,
 * and compact on edit/end. Announcement boundaries and ordinary slots respect
 * the same global spacing. No paid display is truncated.
 */
export function planBroadcastQueue(
  rows: readonly QueueEntry[], now: Date, banner: BannerWindow | null, compact: boolean,
  intervalMs = BROADCAST_GLOBAL_INTERVAL_SECONDS * 1000, earliestStart = now,
): Array<QueueEntry> {
  const live = rows.find(row => row.startsAt <= now && row.expiresAt > now);
  let cursor = Math.max(earliestStart.getTime(), live ? live.expiresAt.getTime() + intervalMs : now.getTime());
  const pending = rows.filter(row => row !== live)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return pending.map(row => {
    const duration = row.expiresAt.getTime() - row.startsAt.getTime();
    let start = compact ? cursor : Math.max(cursor, row.startsAt.getTime());
    if (banner && start < banner.expiresAt.getTime() + intervalMs &&
      start + duration + intervalMs > banner.startsAt.getTime()) {
      start = banner.expiresAt.getTime() + intervalMs;
    }
    cursor = start + duration + intervalMs;
    return { ...row, startsAt: new Date(start), expiresAt: new Date(start + duration) };
  });
}

/** Defer a new/edited banner briefly rather than preempt a live paid display. */
export async function preserveLiveBroadcast(tx: DBTransaction, window: BannerWindow): Promise<BannerWindow> {
  const now = new Date();
  const gap = BROADCAST_GLOBAL_INTERVAL_SECONDS * 1000;
  const [live] = await tx.select({ expiresAt: broadcasts.expiresAt }).from(broadcasts)
    .where(and(inArray(broadcasts.status, ["queued", "expired"]),
      lte(broadcasts.startsAt, now), gt(broadcasts.expiresAt, new Date(now.getTime() - gap))))
    .orderBy(desc(broadcasts.expiresAt)).limit(1);
  const minimum = Math.max(now.getTime(), live ? live.expiresAt.getTime() + gap : 0);
  const shift = Math.max(0, minimum - window.startsAt.getTime());
  return { startsAt: new Date(window.startsAt.getTime() + shift), expiresAt: new Date(window.expiresAt.getTime() + shift) };
}

/** Rebuild the indexed, capacity-bounded ordinary queue while holding the shared lock. */
export async function rescheduleBroadcastQueue(tx: DBTransaction, banner: BannerWindow | null, compact: boolean, earliestStart?: Date): Promise<void> {
  const now = new Date();
  const rows = await tx.select({ id: broadcasts.id, startsAt: broadcasts.startsAt,
    expiresAt: broadcasts.expiresAt, createdAt: broadcasts.createdAt }).from(broadcasts)
    .where(and(eq(broadcasts.status, "queued"), isNull(broadcasts.announcementId), gt(broadcasts.expiresAt, now)))
    .orderBy(asc(broadcasts.createdAt), asc(broadcasts.id));
  const originals = new Map(rows.map(row => [row.id, row]));
  const [recent] = await tx.select({ expiresAt: broadcasts.expiresAt }).from(broadcasts)
    .where(and(inArray(broadcasts.status, ["queued", "expired"]), lte(broadcasts.startsAt, now),
      lte(broadcasts.expiresAt, now), gt(broadcasts.expiresAt, new Date(now.getTime() - BROADCAST_GLOBAL_INTERVAL_SECONDS * 1000))))
    .orderBy(desc(broadcasts.expiresAt)).limit(1);
  const minimum = new Date(Math.max(now.getTime(), earliestStart?.getTime() ?? 0,
    recent ? recent.expiresAt.getTime() + BROADCAST_GLOBAL_INTERVAL_SECONDS * 1000 : 0));
  for (const next of planBroadcastQueue(rows, now, banner, compact, undefined, minimum)) {
    const original = originals.get(next.id);
    if (original?.startsAt.getTime() === next.startsAt.getTime() && original.expiresAt.getTime() === next.expiresAt.getTime()) continue;
    await tx.update(broadcasts).set({ startsAt: next.startsAt, expiresAt: next.expiresAt, updatedAt: now })
      .where(eq(broadcasts.id, next.id));
  }
}
