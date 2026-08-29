/**
 * Trust & Safety Service
 *
 * Core service layer managing user trust profiles, disciplinary actions,
 * violation telemetry, and active enforcement capability gating.
 */

import { dbRead, dbWrite } from "../db/client.js";
import {
  userTrustProfiles,
  userEnforcementActions,
  userViolationEvents,
  users,
} from "../db/schema.js";
import { eq, and, desc, sql, isNull, or, gt } from "drizzle-orm";
import type {
  EnforcementAction,
  ViolationType,
  ViolationSeverity,
  RiskTier,
  ViolationEventSource,
  UserEnforcementStatus,
  UserEnforcementActionSummary,
} from "../types/trust-safety.js";
import { invalidateUserBanCache } from "../middleware/nextauth.js";
import { invalidateUserProfileCache } from "./cache.js";

/**
 * Retrieves the user's trust profile or initializes a default profile if not present.
 */
export async function getOrCreateUserTrustProfile(userId: string) {
  const [existing] = await dbRead
    .select()
    .from(userTrustProfiles)
    .where(eq(userTrustProfiles.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await dbWrite
    .insert(userTrustProfiles)
    .values({
      userId,
      trustScore: 100,
      strikeCount: 0,
      riskTier: "low",
    })
    .onConflictDoUpdate({
      target: userTrustProfiles.userId,
      set: { updatedAt: new Date() },
    })
    .returning();

  return created;
}

export interface ApplyEnforcementActionParams {
  userId: string;
  action: EnforcementAction;
  violationType: ViolationType;
  severity?: ViolationSeverity;
  reason: string;
  internalNotes?: string | null;
  createdBy?: string | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records a new enforcement action and applies necessary user status mutations.
 * Maintains dual-write compatibility with `users.bannedAt`.
 */
export async function applyEnforcementAction(params: ApplyEnforcementActionParams) {
  const {
    userId,
    action,
    violationType,
    severity = "low",
    reason,
    internalNotes = null,
    createdBy = null,
    expiresAt = null,
    metadata = {},
  } = params;

  const now = new Date();

  // Execute all related writes atomically in a single transaction
  const actionRow = await dbWrite.transaction(async (tx) => {
    // 1. Insert enforcement action into immutable ledger
    const [inserted] = await tx
      .insert(userEnforcementActions)
      .values({
        userId,
        action,
        violationType,
        severity,
        reason,
        internalNotes,
        createdBy,
        expiresAt,
        isRevoked: false,
        metadata,
      })
      .returning();

    // 2. Adjust Trust Profile (deduct score and increment strikes)
    const [existingProfile] = await tx
      .select()
      .from(userTrustProfiles)
      .where(eq(userTrustProfiles.userId, userId))
      .limit(1);

    const currentScore = existingProfile?.trustScore ?? 100;
    const currentTier = existingProfile?.riskTier ?? "low";

    let scoreDeduction = 0;
    switch (severity) {
      case "low":
        scoreDeduction = 10;
        break;
      case "medium":
        scoreDeduction = 25;
        break;
      case "high":
        scoreDeduction = 45;
        break;
      case "critical":
        scoreDeduction = 100;
        break;
    }

    const newTrustScore = Math.max(0, currentScore - scoreDeduction);
    let newRiskTier: RiskTier = currentTier;
    if (newTrustScore < 25) newRiskTier = "critical";
    else if (newTrustScore < 50) newRiskTier = "high";
    else if (newTrustScore < 75) newRiskTier = "elevated";

    await tx
      .insert(userTrustProfiles)
      .values({
        userId,
        trustScore: newTrustScore,
        strikeCount: 1,
        riskTier: newRiskTier,
        lastEvaluatedAt: now,
      })
      .onConflictDoUpdate({
        target: userTrustProfiles.userId,
        set: {
          trustScore: newTrustScore,
          strikeCount: sql`${userTrustProfiles.strikeCount} + 1`,
          riskTier: newRiskTier,
          lastEvaluatedAt: now,
          updatedAt: now,
        },
      });

    // 3. Dual-write to `users` for hard lockout actions (permanent_ban or suspend)
    if (action === "permanent_ban" || action === "suspend") {
      await tx
        .update(users)
        .set({
          bannedAt: now,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.userId, userId));
    }

    return inserted;
  });

  // 4. Invalidate caches
  invalidateUserBanCache(userId);
  await invalidateUserProfileCache(userId);

  return actionRow;
}

/**
 * Revokes an enforcement action (e.g. after successful appeal) and restores permissions if clean.
 */
export async function revokeEnforcementAction(
  actionId: string,
  reviewerId?: string | null,
  reviewNotes?: string | null
) {
  const now = new Date();

  const updatedAction = await dbWrite.transaction(async (tx) => {
    // 1. Mark action as revoked
    const [action] = await tx
      .update(userEnforcementActions)
      .set({
        isRevoked: true,
        revokedAt: now,
        internalNotes: reviewNotes
          ? sql`COALESCE(${userEnforcementActions.internalNotes}, '') || E'\n[Revocation Note]: ' || ${reviewNotes}`
          : userEnforcementActions.internalNotes,
        updatedAt: now,
      })
      .where(eq(userEnforcementActions.id, actionId))
      .returning();

    if (!action) return null;

    const userId = action.userId;

    // 2. Check if user has any other active ban or suspension
    const activeBans = await tx
      .select({ id: userEnforcementActions.id })
      .from(userEnforcementActions)
      .where(
        and(
          eq(userEnforcementActions.userId, userId),
          eq(userEnforcementActions.isRevoked, false),
          or(
            eq(userEnforcementActions.action, "permanent_ban"),
            eq(userEnforcementActions.action, "suspend")
          ),
          or(
            isNull(userEnforcementActions.expiresAt),
            gt(userEnforcementActions.expiresAt, now)
          )
        )
      );

    // If no other active ban/suspension exists, clear `users.bannedAt`
    if (activeBans.length === 0) {
      await tx
        .update(users)
        .set({
          bannedAt: null,
          updatedAt: now,
        })
        .where(eq(users.userId, userId));
    }

    return action;
  });

  if (!updatedAction) return null;

  // 3. Invalidate caches
  invalidateUserBanCache(updatedAction.userId);
  await invalidateUserProfileCache(updatedAction.userId);

  return updatedAction;
}

/**
 * Fetches all currently active enforcement actions for a user.
 */
export async function getActiveEnforcementsForUser(userId: string) {
  const now = new Date();

  return await dbRead
    .select()
    .from(userEnforcementActions)
    .where(
      and(
        eq(userEnforcementActions.userId, userId),
        eq(userEnforcementActions.isRevoked, false),
        or(
          isNull(userEnforcementActions.expiresAt),
          gt(userEnforcementActions.expiresAt, now)
        )
      )
    )
    .orderBy(desc(userEnforcementActions.createdAt));
}

/**
 * Computes user capabilities status for middleware gating.
 */
export async function getUserEnforcementStatus(userId: string): Promise<UserEnforcementStatus> {
  const activeRows = await getActiveEnforcementsForUser(userId);

  let isBanned = false;
  let isSuspended = false;
  let isThrottled = false;
  let isMuted = false;
  let dailyGenerationLimit: number | null = null;

  const activeActions: UserEnforcementActionSummary[] = [];

  for (const row of activeRows) {
    activeActions.push({
      id: row.id,
      action: row.action,
      violationType: row.violationType,
      severity: row.severity,
      reason: row.reason,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    });

    if (row.action === "permanent_ban") isBanned = true;
    if (row.action === "suspend") isSuspended = true;
    if (row.action === "limit_generation" || row.action === "limit_daily_usage") {
      isThrottled = true;
      dailyGenerationLimit = 5;
    }
    if (row.action === "mute_community") isMuted = true;
  }

  return {
    userId,
    isBanned,
    isSuspended,
    isThrottled,
    isMuted,
    dailyGenerationLimit,
    activeActions,
  };
}

export interface RecordViolationEventParams {
  userId: string;
  violationType: ViolationType;
  confidenceScore?: number;
  source: ViolationEventSource;
  rawInput?: string | null;
  detectionDetails?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Asynchronously logs a violation event (non-blocking evidence telemetry).
 */
export async function recordViolationEvent(params: RecordViolationEventParams): Promise<void> {
  try {
    await dbWrite.insert(userViolationEvents).values({
      userId: params.userId,
      violationType: params.violationType,
      confidenceScore: params.confidenceScore ?? 1.0,
      source: params.source,
      rawInput: params.rawInput?.slice(0, 500) ?? null,
      detectionDetails: params.detectionDetails ?? {},
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent?.slice(0, 255) ?? null,
    });
  } catch (error) {
    // Non-blocking telemetry log — never crash the parent request
    console.error("[Trust & Safety] ⚠️ Failed to log violation event:", error);
  }
}
