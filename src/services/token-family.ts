/**
 * Refresh Token Family Service (G-auth-2 / RFC 9700 rotation)
 *
 * Stores **SHA-256 hashes** of opaque refresh secrets keyed by family id
 * (one family per login session / `auth_sessions.sid`). Rotation is atomic:
 * the presented hash is appended to `usedHashes` and a new current
 * `refreshHash` is written in one transaction. Presenting any hash already in
 * `usedHashes` revokes the entire family (theft detection).
 *
 * Schema lives in `src/db/schema.ts` (`refreshFamilies`) — migrations are
 * run by the human owner only (AGENTS.md §3.5).
 */

import { dbWrite } from "../db/client.js";
import { refreshFamilies, users } from "../db/schema.js";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { generateId } from "../utils/uuid.js";
import { hashSHA256 } from "../utils/hash.js";

/** Refresh family lifetime (days). Override with MOBILE_REFRESH_TTL_DAYS. */
const DEFAULT_REFRESH_TTL_DAYS = 30;

export interface CreateFamilyResult {
  familyId: string;
  refreshToken: string;
}

export type RotateFailureReason =
  | "not_found"
  | "revoked"
  | "expired"
  | "reused"
  | "tv_mismatch"
  | "banned";

export type RotateResult =
  | {
      ok: true;
      familyId: string;
      newRefreshToken: string;
      userId: string;
      sessionId: string;
      tokenVersion: number;
    }
  | { ok: false; reason: RotateFailureReason; familyId?: string };

type Tx = Parameters<Parameters<typeof dbWrite.transaction>[0]>[0];

/** Row shape required by {@link evaluateRotation} (subset of `refresh_families`). */
export interface RotationFamilyRow {
  id: string;
  userId: string;
  sessionId: string;
  tokenVersion: number;
  refreshHash: string;
  usedHashes: string[] | null;
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}

/**
 * Live user row required for rotation enforcement (subset of `users`).
 */
export interface RotationUserRow {
  tokenVersion: number;
  bannedAt: Date | string | null;
}

export type RotationDecision =
  | { action: "not_found" }
  | { action: "fail"; reason: Exclude<RotateFailureReason, "not_found">; revoke: boolean }
  | { action: "rotate" };

/**
 * Pure RFC 9700 rotation decision for one locked family row.
 *
 * Keys reuse detection off the **presented** hash versus the current
 * `refreshHash` (not a bare `usedAt` timestamp), so consecutive legitimate
 * refreshes keep working while a replay of any prior secret revokes the family.
 *
 * @param row - Family row matched by current hash **or** `usedHashes`, or null when no row matched
 * @param presentedHash - SHA-256 of the token the client presented
 * @param user - Live `users` row (`tokenVersion` + `bannedAt`), or null when the user is missing
 * @param now - Evaluation clock (injectable for tests); defaults to `Date.now()`
 * @returns `not_found`, `fail` (with `revoke` when the family must be revoked), or `rotate`
 */
export function evaluateRotation(
  row: RotationFamilyRow | null | undefined,
  presentedHash: string,
  user: RotationUserRow | null,
  now: Date = new Date(),
): RotationDecision {
  if (!row) return { action: "not_found" };
  if (row.revokedAt) return { action: "fail", reason: "revoked", revoke: false };
  if (row.expiresAt && new Date(row.expiresAt) < now) {
    return { action: "fail", reason: "expired", revoke: false };
  }
  // Fail closed on ban at refresh (do not mint a new secret for banned users).
  if (user?.bannedAt) {
    return { action: "fail", reason: "banned", revoke: true };
  }
  if (!user || user.tokenVersion !== row.tokenVersion) {
    return { action: "fail", reason: "tv_mismatch", revoke: true };
  }
  // Lookup can match usedHashes; anything other than the current hash is reuse.
  if (row.refreshHash !== presentedHash) {
    return { action: "fail", reason: "reused", revoke: true };
  }
  return { action: "rotate" };
}

function refreshTtlMs(): number {
  const raw = Number(process.env.MOBILE_REFRESH_TTL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REFRESH_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function randomRefreshSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates a new refresh family bound to a session and returns the plaintext
 * secret (only shown once). Server stores only the SHA-256 hash.
 *
 * @param userId - Authenticated user id
 * @param sessionId - `auth_sessions.id` this family is bound to
 * @param tokenVersion - Snapshot of `users.token_version` at issuance
 * @param executor - Optional transaction executor so family insert can share
 *   the same transaction as session creation (atomic mobile login)
 */
export async function createRefreshFamily(
  userId: string,
  sessionId: string,
  tokenVersion: number,
  executor: Tx | typeof dbWrite = dbWrite,
): Promise<CreateFamilyResult> {
  const familyId = generateId();
  const refreshToken = randomRefreshSecret();
  const hash = await hashSHA256(refreshToken);
  const expiresAt = new Date(Date.now() + refreshTtlMs());

  await executor.insert(refreshFamilies).values({
    id: familyId,
    userId,
    sessionId,
    tokenVersion,
    refreshHash: hash,
    expiresAt,
  });

  return { familyId, refreshToken };
}

/**
 * Looks up a family id by presented refresh hash (current or already-used)
 * without mutating state. Used for family-keyed rate limiting before rotate.
 */
export async function peekFamilyIdByPresentedHash(
  presentedHash: string,
): Promise<string | null> {
  const [row] = await dbWrite
    .select({ id: refreshFamilies.id })
    .from(refreshFamilies)
    .where(
      or(
        eq(refreshFamilies.refreshHash, presentedHash),
        sql`${refreshFamilies.usedHashes} @> ARRAY[${presentedHash}]`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Atomically rotates a refresh secret (RFC 9700).
 *
 * Lookup matches either the **current** `refreshHash` or any hash already
 * appended to `usedHashes`:
 * - Missing → `not_found`.
 * - Revoked / expired → failure without further mutation.
 * - `tokenVersion` mismatch (logout-all / password change) → failure + revoke.
 * - Presented hash found only in `usedHashes` (already rotated away) →
 *   revoke entire family (theft signal) → `reused`.
 * - Presented hash equals current `refreshHash` → append it to `usedHashes`,
 *   write the new current hash, stamp `usedAt`, return the new secret.
 *
 * The reuse check keys off the **presented** hash (not a bare `usedAt`
 * timestamp), so consecutive legitimate refreshes keep working while a
 * replay of any prior secret still revokes the family.
 */
export async function rotateRefreshToken(
  presentedToken: string,
): Promise<RotateResult> {
  const hash = await hashSHA256(presentedToken);

  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(refreshFamilies)
      .where(
        or(
          eq(refreshFamilies.refreshHash, hash),
          sql`${refreshFamilies.usedHashes} @> ARRAY[${hash}]`,
        ),
      )
      .limit(1)
      .for("update");

    if (!row) {
      return { ok: false, reason: "not_found" };
    }

    // Early exits that never need the user row — evaluateRotation still
    // re-checks these, so the live tokenVersion/ban are only loaded when relevant.
    const pre = evaluateRotation(row, hash, { tokenVersion: row.tokenVersion, bannedAt: null });
    if (pre.action === "fail" && !pre.revoke) {
      return { ok: false, reason: pre.reason, familyId: row.id };
    }

    const [userRow] = await tx
      .select({ tokenVersion: users.tokenVersion, bannedAt: users.bannedAt })
      .from(users)
      .where(eq(users.userId, row.userId))
      .limit(1);

    const decision = evaluateRotation(
      row,
      hash,
      userRow
        ? { tokenVersion: userRow.tokenVersion, bannedAt: userRow.bannedAt }
        : null,
    );

    if (decision.action === "fail") {
      if (decision.revoke) {
        await tx
          .update(refreshFamilies)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(eq(refreshFamilies.id, row.id));
      }
      return { ok: false, reason: decision.reason, familyId: row.id };
    }

    if (decision.action === "not_found") {
      return { ok: false, reason: "not_found" };
    }

    const newSecret = randomRefreshSecret();
    const newHash = await hashSHA256(newSecret);
    const priorUsed = row.usedHashes ?? [];

    await tx
      .update(refreshFamilies)
      .set({
        refreshHash: newHash,
        usedHashes: [...priorUsed, hash],
        usedAt: new Date(),
        replacedByRefreshHash: newHash,
        updatedAt: new Date(),
      })
      .where(eq(refreshFamilies.id, row.id));

    return {
      ok: true,
      familyId: row.id,
      newRefreshToken: newSecret,
      userId: row.userId,
      sessionId: row.sessionId,
      tokenVersion: row.tokenVersion,
    };
  });
}

/**
 * Revokes every refresh family for a user (logout-all, password change, ban).
 * Pass `executor` when inside an outer transaction so revoke shares it.
 */
export async function revokeAllFamiliesForUser(
  userId: string,
  executor: Tx | typeof dbWrite = dbWrite,
): Promise<number> {
  const result = await executor
    .update(refreshFamilies)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(refreshFamilies.userId, userId), isNull(refreshFamilies.revokedAt)));
  return result.rowCount || 0;
}

/**
 * Revokes all families bound to a session id (single-device logout).
 *
 * Note: deleting the `auth_sessions` row already hard-deletes bound families
 * via `ON DELETE CASCADE`. Prefer this soft-revoke when the session row must
 * remain (or as a pre-delete belt-and-suspenders before session delete).
 */
export async function revokeFamiliesForSession(
  sessionId: string,
  executor: Tx | typeof dbWrite = dbWrite,
): Promise<number> {
  const result = await executor
    .update(refreshFamilies)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(refreshFamilies.sessionId, sessionId), isNull(refreshFamilies.revokedAt)));
  return result.rowCount || 0;
}
