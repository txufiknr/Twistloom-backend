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
  moderationReports,
  moderationAppeals,
  bookGenerations,
  books,
  users,
} from "../db/schema.js";
import { eq, and, desc, sql, isNull, or, gt, gte, ilike } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import type {
  EnforcementAction,
  ViolationType,
  ViolationSeverity,
  RiskTier,
  ViolationEventSource,
  UserEnforcementStatus,
  UserEnforcementActionSummary,
  ReportStatus,
  ReportTargetType,
  ReportType,
  AppealStatus,
} from "../types/trust-safety.js";
import { invalidateUserBanCache } from "../middleware/nextauth.js";
import { invalidateUserProfileCache } from "./cache.js";
import { addCredits } from "./credits.js";

// ---------------------------------------------------------------------------
// In-Memory Capabilities Cache (LRU)
// ---------------------------------------------------------------------------
const userCapabilitiesCache = new LRUCache<string, UserEnforcementStatus>({
  max: 5000,
  ttl: 1000 * 60 * 2, // 2 minutes TTL
});

/**
 * Invalidates the cached enforcement status for a specific user.
 */
export function invalidateUserEnforcementCache(userId: string): void {
  userCapabilitiesCache.delete(userId);
}

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
  invalidateUserEnforcementCache(userId);
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
  invalidateUserEnforcementCache(updatedAction.userId);
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

/**
 * Retrieves enforcement status from in-memory cache or queries the database.
 */
export async function getOrFetchUserEnforcementStatus(userId: string): Promise<UserEnforcementStatus> {
  const cached = userCapabilitiesCache.get(userId);
  if (cached) return cached;

  const fresh = await getUserEnforcementStatus(userId);
  userCapabilitiesCache.set(userId, fresh);
  return fresh;
}

/**
 * Returns the count of AI book generations started by a user today (UTC).
 */
export async function getTodayGenerationCount(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [genCount] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(bookGenerations)
    .where(
      and(
        eq(bookGenerations.userId, userId),
        gte(bookGenerations.createdAt, startOfDay)
      )
    );

  return genCount?.count ?? 0;
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

// ---------------------------------------------------------------------------
// Admin Moderation Cockpit Queries & Mutations (Phase 4)
// ---------------------------------------------------------------------------

export interface AdminTrustSafetySummary {
  openReportsCount: number;
  pendingAppealsCount: number;
  activeSuspensionsCount: number;
  violationsLast24h: number;
  highRiskUsersCount: number;
}

export async function getAdminTrustSafetySummary(): Promise<AdminTrustSafetySummary> {
  const now = new Date();
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [[reportsRow], [appealsRow], [suspensionsRow], [violationsRow], [highRiskRow]] =
    await Promise.all([
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(moderationReports)
        .where(eq(moderationReports.status, "open")),
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(moderationAppeals)
        .where(eq(moderationAppeals.status, "pending")),
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(userEnforcementActions)
        .where(
          and(
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
        ),
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(userViolationEvents)
        .where(gte(userViolationEvents.createdAt, last24h)),
      dbRead
        .select({ count: sql<number>`count(*)::int` })
        .from(userTrustProfiles)
        .where(or(eq(userTrustProfiles.riskTier, "high"), eq(userTrustProfiles.riskTier, "critical"))),
    ]);

  return {
    openReportsCount: reportsRow?.count ?? 0,
    pendingAppealsCount: appealsRow?.count ?? 0,
    activeSuspensionsCount: suspensionsRow?.count ?? 0,
    violationsLast24h: violationsRow?.count ?? 0,
    highRiskUsersCount: highRiskRow?.count ?? 0,
  };
}

export interface ListAdminReportsParams {
  status?: string;
  targetType?: string;
  reportType?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getAdminModerationReports(params: ListAdminReportsParams) {
  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const offset = Math.max(params.offset || 0, 0);

  const conditions = [];

  if (params.status) {
    conditions.push(eq(moderationReports.status, params.status as ReportStatus));
  }
  if (params.targetType) {
    conditions.push(eq(moderationReports.targetType, params.targetType as ReportTargetType));
  }
  if (params.reportType) {
    conditions.push(eq(moderationReports.reportType, params.reportType as ReportType));
  }
  if (params.search && params.search.trim().length > 0) {
    conditions.push(
      or(
        ilike(moderationReports.message, `%${params.search.trim()}%`),
        ilike(users.name, `%${params.search.trim()}%`),
        ilike(users.username, `%${params.search.trim()}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await dbRead
    .select({
      id: moderationReports.id,
      reporterId: moderationReports.reporterId,
      targetType: moderationReports.targetType,
      targetId: moderationReports.targetId,
      reportedUserId: moderationReports.reportedUserId,
      reportType: moderationReports.reportType,
      message: moderationReports.message,
      status: moderationReports.status,
      resolvedBy: moderationReports.resolvedBy,
      resolutionNotes: moderationReports.resolutionNotes,
      resolvedAt: moderationReports.resolvedAt,
      createdAt: moderationReports.createdAt,
      updatedAt: moderationReports.updatedAt,
      reportedUserName: users.name,
      reportedUserUsername: users.username,
      reportedUserImageUrl: users.imageUrl,
    })
    .from(moderationReports)
    .leftJoin(users, eq(moderationReports.reportedUserId, users.userId))
    .where(whereClause)
    .orderBy(desc(moderationReports.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(moderationReports)
    .leftJoin(users, eq(moderationReports.reportedUserId, users.userId))
    .where(whereClause);

  return {
    reports: rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function updateAdminModerationReport(
  reportId: string,
  updateData: { status: "under_review" | "resolved" | "dismissed"; resolutionNotes?: string | null },
  adminId: string
) {
  const now = new Date();
  const [updated] = await dbWrite
    .update(moderationReports)
    .set({
      status: updateData.status,
      resolutionNotes: updateData.resolutionNotes || null,
      resolvedBy: adminId,
      resolvedAt: updateData.status === "resolved" || updateData.status === "dismissed" ? now : null,
      updatedAt: now,
    })
    .where(eq(moderationReports.id, reportId))
    .returning();

  return updated ?? null;
}

export interface ListAdminViolationsParams {
  userId?: string;
  violationType?: string;
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getAdminViolationEvents(params: ListAdminViolationsParams) {
  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const offset = Math.max(params.offset || 0, 0);

  const conditions = [];

  if (params.userId) {
    conditions.push(eq(userViolationEvents.userId, params.userId));
  }
  if (params.violationType) {
    conditions.push(eq(userViolationEvents.violationType, params.violationType as ViolationType));
  }
  if (params.source) {
    conditions.push(eq(userViolationEvents.source, params.source as ViolationEventSource));
  }
  if (params.search && params.search.trim().length > 0) {
    conditions.push(
      or(
        ilike(userViolationEvents.rawInput, `%${params.search.trim()}%`),
        ilike(users.name, `%${params.search.trim()}%`),
        ilike(users.username, `%${params.search.trim()}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await dbRead
    .select({
      id: userViolationEvents.id,
      userId: userViolationEvents.userId,
      violationType: userViolationEvents.violationType,
      confidenceScore: userViolationEvents.confidenceScore,
      source: userViolationEvents.source,
      rawInput: userViolationEvents.rawInput,
      detectionDetails: userViolationEvents.detectionDetails,
      ipAddress: userViolationEvents.ipAddress,
      userAgent: userViolationEvents.userAgent,
      createdAt: userViolationEvents.createdAt,
      userName: users.name,
      userUsername: users.username,
      userImageUrl: users.imageUrl,
    })
    .from(userViolationEvents)
    .leftJoin(users, eq(userViolationEvents.userId, users.userId))
    .where(whereClause)
    .orderBy(desc(userViolationEvents.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userViolationEvents)
    .leftJoin(users, eq(userViolationEvents.userId, users.userId))
    .where(whereClause);

  return {
    violations: rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function getUserForensicDossier(userId: string) {
  const [userProfile, trustProfile, enforcementStatus, allActions, recentViolations, reportsAgainst] =
    await Promise.all([
      dbRead
        .select({
          userId: users.userId,
          name: users.name,
          username: users.username,
          email: users.email,
          imageUrl: users.imageUrl,
          tier: users.tier,
          credits: users.credits,
          bannedAt: users.bannedAt,
          createdAt: users.createdAt,
          lastActive: users.lastActive,
        })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1),
      getOrCreateUserTrustProfile(userId),
      getUserEnforcementStatus(userId),
      dbRead
        .select()
        .from(userEnforcementActions)
        .where(eq(userEnforcementActions.userId, userId))
        .orderBy(desc(userEnforcementActions.createdAt))
        .limit(50),
      dbRead
        .select()
        .from(userViolationEvents)
        .where(eq(userViolationEvents.userId, userId))
        .orderBy(desc(userViolationEvents.createdAt))
        .limit(20),
      dbRead
        .select({
          id: moderationReports.id,
          targetType: moderationReports.targetType,
          targetId: moderationReports.targetId,
          reportType: moderationReports.reportType,
          message: moderationReports.message,
          status: moderationReports.status,
          createdAt: moderationReports.createdAt,
        })
        .from(moderationReports)
        .where(eq(moderationReports.reportedUserId, userId))
        .orderBy(desc(moderationReports.createdAt))
        .limit(20),
    ]);

  if (!userProfile[0]) return null;

  // Calculate prompt velocity: count of violation events in the last 15 minutes
  const last15m = new Date(Date.now() - 15 * 60 * 1000);
  const [velocityResult] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userViolationEvents)
    .where(
      and(
        eq(userViolationEvents.userId, userId),
        gte(userViolationEvents.createdAt, last15m)
      )
    );

  const [bookCountResult] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(books)
    .where(eq(books.userId, userId));

  return {
    user: userProfile[0],
    trustProfile,
    capabilities: enforcementStatus,
    activeActions: enforcementStatus.activeActions,
    allActions,
    recentViolations,
    reportsAgainst,
    stats: {
      velocity15m: velocityResult?.count ?? 0,
      totalBooks: bookCountResult?.count ?? 0,
    },
  };
}

export interface ListAdminAppealsParams {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getAdminModerationAppeals(params: ListAdminAppealsParams) {
  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const offset = Math.max(params.offset || 0, 0);

  const conditions = [];

  if (params.status) {
    conditions.push(eq(moderationAppeals.status, params.status as AppealStatus));
  }
  if (params.search && params.search.trim().length > 0) {
    conditions.push(
      or(
        ilike(moderationAppeals.appealReason, `%${params.search.trim()}%`),
        ilike(users.name, `%${params.search.trim()}%`),
        ilike(users.username, `%${params.search.trim()}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await dbRead
    .select({
      id: moderationAppeals.id,
      enforcementActionId: moderationAppeals.enforcementActionId,
      userId: moderationAppeals.userId,
      appealReason: moderationAppeals.appealReason,
      userEvidence: moderationAppeals.userEvidence,
      status: moderationAppeals.status,
      adminNotes: moderationAppeals.adminNotes,
      reviewedBy: moderationAppeals.reviewedBy,
      resolvedAt: moderationAppeals.resolvedAt,
      createdAt: moderationAppeals.createdAt,
      updatedAt: moderationAppeals.updatedAt,
      userName: users.name,
      userUsername: users.username,
      userImageUrl: users.imageUrl,
      actionType: userEnforcementActions.action,
      actionViolationType: userEnforcementActions.violationType,
      actionSeverity: userEnforcementActions.severity,
      actionReason: userEnforcementActions.reason,
      actionExpiresAt: userEnforcementActions.expiresAt,
      actionIsRevoked: userEnforcementActions.isRevoked,
    })
    .from(moderationAppeals)
    .leftJoin(users, eq(moderationAppeals.userId, users.userId))
    .leftJoin(userEnforcementActions, eq(moderationAppeals.enforcementActionId, userEnforcementActions.id))
    .where(whereClause)
    .orderBy(desc(moderationAppeals.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(moderationAppeals)
    .leftJoin(users, eq(moderationAppeals.userId, users.userId))
    .where(whereClause);

  return {
    appeals: rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

export interface ResolveAdminAppealParams {
  decision: "approved" | "rejected";
  adminNotes?: string | null;
  grantApologyCredits?: boolean;
  apologyCreditAmount?: number;
}

export async function resolveAdminModerationAppeal(
  appealId: string,
  resolutionData: ResolveAdminAppealParams,
  adminId: string
) {
  const now = new Date();

  const result = await dbWrite.transaction(async (tx) => {
    const [appeal] = await tx
      .select()
      .from(moderationAppeals)
      .where(eq(moderationAppeals.id, appealId))
      .limit(1);

    if (!appeal) throw new Error("Appeal not found");

    const [updatedAppeal] = await tx
      .update(moderationAppeals)
      .set({
        status: resolutionData.decision,
        adminNotes: resolutionData.adminNotes || null,
        reviewedBy: adminId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(moderationAppeals.id, appealId))
      .returning();

    if (resolutionData.decision === "approved") {
      // 1. Mark the enforcement action as revoked
      await tx
        .update(userEnforcementActions)
        .set({
          isRevoked: true,
          revokedAt: now,
          internalNotes: resolutionData.adminNotes
            ? sql`COALESCE(${userEnforcementActions.internalNotes}, '') || E'\n[Appeal Approved]: ' || ${resolutionData.adminNotes}`
            : userEnforcementActions.internalNotes,
          updatedAt: now,
        })
        .where(eq(userEnforcementActions.id, appeal.enforcementActionId));

      // 2. Restore User Trust Profile
      await tx
        .insert(userTrustProfiles)
        .values({
          userId: appeal.userId,
          trustScore: 100,
          strikeCount: 0,
          riskTier: "low",
          lastEvaluatedAt: now,
        })
        .onConflictDoUpdate({
          target: userTrustProfiles.userId,
          set: {
            trustScore: 100,
            strikeCount: 0,
            riskTier: "low",
            lastEvaluatedAt: now,
            updatedAt: now,
          },
        });

      // 3. Clear users.bannedAt if no other active ban remains
      const otherBans = await tx
        .select({ id: userEnforcementActions.id })
        .from(userEnforcementActions)
        .where(
          and(
            eq(userEnforcementActions.userId, appeal.userId),
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

      if (otherBans.length === 0) {
        await tx
          .update(users)
          .set({ bannedAt: null, updatedAt: now })
          .where(eq(users.userId, appeal.userId));
      }

      // 4. Grant Apology Credits if requested
      if (resolutionData.grantApologyCredits !== false) {
        const creditAmount = resolutionData.apologyCreditAmount ?? 10;
        await addCredits(appeal.userId, creditAmount, {
          context: "trust_safety_restitution",
          metadata: {
            appealId: appeal.id,
            enforcementActionId: appeal.enforcementActionId,
            reason: "Overturned False Positive Restitution",
          },
          tx,
        });
      }
    }

    return { appeal: updatedAppeal, userId: appeal.userId };
  });

  // Invalidate caches
  invalidateUserBanCache(result.userId);
  invalidateUserEnforcementCache(result.userId);
  await invalidateUserProfileCache(result.userId);

  return result.appeal;
}

export interface ListAdminActionsParams {
  userId?: string;
  action?: string;
  violationType?: string;
  isRevoked?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getAdminEnforcementActions(params: ListAdminActionsParams) {
  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const offset = Math.max(params.offset || 0, 0);

  const conditions = [];

  if (params.userId) {
    conditions.push(eq(userEnforcementActions.userId, params.userId));
  }
  if (params.action) {
    conditions.push(eq(userEnforcementActions.action, params.action as EnforcementAction));
  }
  if (params.violationType) {
    conditions.push(eq(userEnforcementActions.violationType, params.violationType as ViolationType));
  }
  if (params.isRevoked !== undefined) {
    conditions.push(eq(userEnforcementActions.isRevoked, params.isRevoked));
  }
  if (params.search && params.search.trim().length > 0) {
    conditions.push(
      or(
        ilike(userEnforcementActions.reason, `%${params.search.trim()}%`),
        ilike(users.name, `%${params.search.trim()}%`),
        ilike(users.username, `%${params.search.trim()}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await dbRead
    .select({
      id: userEnforcementActions.id,
      userId: userEnforcementActions.userId,
      action: userEnforcementActions.action,
      violationType: userEnforcementActions.violationType,
      severity: userEnforcementActions.severity,
      reason: userEnforcementActions.reason,
      internalNotes: userEnforcementActions.internalNotes,
      appliedBy: userEnforcementActions.createdBy,
      expiresAt: userEnforcementActions.expiresAt,
      isRevoked: userEnforcementActions.isRevoked,
      revokedAt: userEnforcementActions.revokedAt,
      createdAt: userEnforcementActions.createdAt,
      updatedAt: userEnforcementActions.updatedAt,
      userName: users.name,
      userUsername: users.username,
      userImageUrl: users.imageUrl,
    })
    .from(userEnforcementActions)
    .leftJoin(users, eq(userEnforcementActions.userId, users.userId))
    .where(whereClause)
    .orderBy(desc(userEnforcementActions.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userEnforcementActions)
    .leftJoin(users, eq(userEnforcementActions.userId, users.userId))
    .where(whereClause);

  return {
    actions: rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// User-Facing Trust & Safety Overview & Appeals Services (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Retrieves a comprehensive trust & safety overview for the authenticated user,
 * including reputation metrics, capabilities status, active disciplinary actions,
 * daily generation quota usage, and appeal history.
 */
export async function getUserTrustSafetyOverview(userId: string) {
  const [trustProfile, status, todayGenerations, activeActions, userAppealsList] = await Promise.all([
    getOrCreateUserTrustProfile(userId),
    getOrFetchUserEnforcementStatus(userId),
    getTodayGenerationCount(userId),
    dbRead
      .select({
        id: userEnforcementActions.id,
        action: userEnforcementActions.action,
        violationType: userEnforcementActions.violationType,
        severity: userEnforcementActions.severity,
        reason: userEnforcementActions.reason,
        expiresAt: userEnforcementActions.expiresAt,
        createdAt: userEnforcementActions.createdAt,
      })
      .from(userEnforcementActions)
      .where(
        and(
          eq(userEnforcementActions.userId, userId),
          eq(userEnforcementActions.isRevoked, false),
          or(isNull(userEnforcementActions.expiresAt), gt(userEnforcementActions.expiresAt, sql`NOW()`)),
        )
      )
      .orderBy(desc(userEnforcementActions.createdAt)),
    dbRead
      .select({
        id: moderationAppeals.id,
        enforcementActionId: moderationAppeals.enforcementActionId,
        appealReason: moderationAppeals.appealReason,
        userEvidence: moderationAppeals.userEvidence,
        status: moderationAppeals.status,
        adminNotes: moderationAppeals.adminNotes,
        resolvedAt: moderationAppeals.resolvedAt,
        createdAt: moderationAppeals.createdAt,
        actionType: userEnforcementActions.action,
        actionReason: userEnforcementActions.reason,
      })
      .from(moderationAppeals)
      .leftJoin(userEnforcementActions, eq(moderationAppeals.enforcementActionId, userEnforcementActions.id))
      .where(eq(moderationAppeals.userId, userId))
      .orderBy(desc(moderationAppeals.createdAt)),
  ]);

  return {
    trustProfile: {
      trustScore: trustProfile.trustScore,
      riskTier: trustProfile.riskTier,
      strikeCount: trustProfile.strikeCount,
      probationUntil: trustProfile.probationUntil,
    },
    capabilities: {
      isBanned: status.isBanned,
      isSuspended: status.isSuspended,
      isThrottled: status.isThrottled,
      isMuted: status.isMuted,
      dailyGenerationLimit: status.dailyGenerationLimit,
    },
    quota: {
      usedToday: todayGenerations,
      dailyLimit: status.dailyGenerationLimit,
    },
    activeActions,
    appeals: userAppealsList,
  };
}

export interface SubmitUserAppealPayload {
  actionId: string;
  appealReason: string;
  userEvidence?: string;
}

/**
 * Submits a self-service appeal for an active disciplinary enforcement action.
 */
export async function submitUserAppeal(userId: string, payload: SubmitUserAppealPayload) {
  // 1. Verify the enforcement action exists and belongs to this user
  const [action] = await dbRead
    .select()
    .from(userEnforcementActions)
    .where(
      and(
        eq(userEnforcementActions.id, payload.actionId),
        eq(userEnforcementActions.userId, userId),
      )
    )
    .limit(1);

  if (!action) {
    throw new Error("Disciplinary action not found or does not belong to your account.");
  }

  // 2. Check if an appeal already exists for this action
  const [existingAppeal] = await dbRead
    .select()
    .from(moderationAppeals)
    .where(eq(moderationAppeals.enforcementActionId, payload.actionId))
    .limit(1);

  if (existingAppeal) {
    if (existingAppeal.status === "pending") {
      throw new Error("An appeal is already pending review for this action.");
    }
    throw new Error(`An appeal for this action has already been resolved (${existingAppeal.status}).`);
  }

  // 3. Create the appeal row
  const [created] = await dbWrite
    .insert(moderationAppeals)
    .values({
      userId,
      enforcementActionId: payload.actionId,
      appealReason: payload.appealReason.trim(),
      userEvidence: payload.userEvidence?.trim() || null,
      status: "pending",
    })
    .returning();

  return created;
}

/**
 * Retrieves all moderation appeals filed by the user.
 */
export async function getUserAppeals(userId: string) {
  const appeals = await dbRead
    .select({
      id: moderationAppeals.id,
      enforcementActionId: moderationAppeals.enforcementActionId,
      appealReason: moderationAppeals.appealReason,
      userEvidence: moderationAppeals.userEvidence,
      status: moderationAppeals.status,
      adminNotes: moderationAppeals.adminNotes,
      resolvedAt: moderationAppeals.resolvedAt,
      createdAt: moderationAppeals.createdAt,
      actionType: userEnforcementActions.action,
      actionReason: userEnforcementActions.reason,
    })
    .from(moderationAppeals)
    .leftJoin(userEnforcementActions, eq(moderationAppeals.enforcementActionId, userEnforcementActions.id))
    .where(eq(moderationAppeals.userId, userId))
    .orderBy(desc(moderationAppeals.createdAt));

  return appeals;
}



