/**
 * Trust Score Engine — Dynamic Reputation Calculation with Time-Decay
 *
 * Implements exponential time-decay scoring, velocity-based anomaly detection,
 * automated strike recovery, and risk tier classification.
 *
 * The trust score $S \in [0, 100]$ is calculated as:
 *   S = max(0, 100 - SUM(w_i * c_i * e^(-lambda * (t - t_i))))
 *
 * Where:
 *   w_i = severity weight (low=5, med=15, high=35, crit=100)
 *   c_i = detection confidence (0.5-1.0)
 *   lambda = decay constant (ln(2) / halfLife, halfLife = 30 days)
 *   (t - t_i) = time since violation in days
 *
 * @see docs/architecture/TRUST_AND_SAFETY_ARCHITECTURE.md §6
 * @see docs/roadmap/TRUST_AND_SAFETY_ROADMAP.md §TS.6
 */

import { dbRead, dbWrite } from "../db/client.js";
import { userTrustProfiles, userEnforcementActions, userViolationEvents } from "../db/schema.js";
import { eq, and, desc, sql, or, isNull, gt, gte } from "drizzle-orm";
import type { RiskTier } from "../types/trust-safety.js";

// ============================================================================
// Constants
// ============================================================================

/** Half-life for exponential decay in days */
const DECAY_HALF_LIFE_DAYS = 30;

/** Decay constant lambda = ln(2) / halfLife */
const LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;

/** Severity weights for trust score deduction */
const SEVERITY_WEIGHTS: Record<string, number> = {
  low: 5,
  medium: 15,
  high: 35,
  critical: 100,
};

/** Risk tier thresholds */
const RISK_TIER_THRESHOLDS: ReadonlyArray<{ min: number; max: number; tier: RiskTier }> = [
  { min: 90, max: 100, tier: 'low' },
  { min: 70, max: 89, tier: 'elevated' },
  { min: 40, max: 69, tier: 'high' },
  { min: 0, max: 39, tier: 'critical' },
];

/** Velocity threshold: rejections per 15-minute window that trigger auto-throttle */
const VELOCITY_THRESHOLD = 10;
const VELOCITY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const VELOCITY_PENALTY = 20;

/** Strike recovery periods in days */
const STRIKE_RECOVERY_PERIODS: ReadonlyArray<{ strikeRange: [number, number]; recoveryDays: number }> = [
  { strikeRange: [1, 1], recoveryDays: 30 },
  { strikeRange: [2, 2], recoveryDays: 60 },
  { strikeRange: [3, 3], recoveryDays: 90 },
  { strikeRange: [4, 999], recoveryDays: 180 },
];

// ============================================================================
// Core Scoring Functions
// ============================================================================

/**
 * Calculates the exponential time-decay weight for a violation event.
 *
 * @param daysSinceViolation - Days elapsed since the violation occurred
 * @returns Decay factor between 0 and 1 (older violations have lower weight)
 */
export function calculateDecayFactor(daysSinceViolation: number): number {
  return Math.exp(-LAMBDA * daysSinceViolation);
}

/**
 * Maps a severity string to its numeric weight.
 */
export function getSeverityWeight(severity: string): number {
  return SEVERITY_WEIGHTS[severity] ?? SEVERITY_WEIGHTS.low;
}

/**
 * Calculates a single violation's contribution to trust score deduction,
 * accounting for severity, confidence, and time-decay.
 *
 * @param severity - Violation severity ('low', 'medium', 'high', 'critical')
 * @param confidence - Detection confidence (0.5-1.0)
 * @param daysSinceViolation - Days since the violation occurred
 * @returns The deduction amount (0-100 scale)
 */
export function calculateViolationDeduction(
  severity: string,
  confidence: number,
  daysSinceViolation: number,
): number {
  const weight = getSeverityWeight(severity);
  const clampedConfidence = Math.max(0.5, Math.min(1.0, confidence));
  const decayFactor = calculateDecayFactor(daysSinceViolation);
  return weight * clampedConfidence * decayFactor;
}

/**
 * Maps a numeric trust score to a risk tier.
 */
export function getRiskTierFromScore(score: number): RiskTier {
  for (const { min, max, tier } of RISK_TIER_THRESHOLDS) {
    if (score >= min && score <= max) return tier;
  }
  return 'critical';
}

/**
 * Gets the recovery period (in days) for a given strike count.
 */
export function getRecoveryDays(strikeCount: number): number {
  for (const { strikeRange, recoveryDays } of STRIKE_RECOVERY_PERIODS) {
    if (strikeCount >= strikeRange[0] && strikeCount <= strikeRange[1]) {
      return recoveryDays;
    }
  }
  return 180; // Default for 4+ strikes
}

// ============================================================================
// Trust Score Evaluation
// ============================================================================

export interface TrustScoreEvaluation {
  userId: string;
  trustScore: number;
  riskTier: RiskTier;
  strikeCount: number;
  activeViolationCount: number;
  probationUntil: Date | null;
  lastEvaluatedAt: Date;
  changes: {
    previousScore: number;
    scoreDelta: number;
    previousTier: RiskTier;
    tierChanged: boolean;
    strikesExpired: number;
    probationSet: boolean;
  };
}

/**
 * Evaluates a single user's trust score by:
 * 1. Fetching all unrevoked enforcement actions
 * 2. Applying exponential time-decay to each violation's weight
 * 3. Calculating the aggregate deduction from base score (100)
 * 4. Determining risk tier and probation status
 * 5. Updating the user_trust_profiles row
 *
 * @param userId - The user to evaluate
 * @returns Evaluation result with score, tier, and change metadata
 */
export async function evaluateUserTrustScore(userId: string): Promise<TrustScoreEvaluation> {
  const now = new Date();
  const nowMs = now.getTime();

  // 1. Fetch current trust profile
  const [existingProfile] = await dbRead
    .select()
    .from(userTrustProfiles)
    .where(eq(userTrustProfiles.userId, userId))
    .limit(1);

  const previousScore = existingProfile?.trustScore ?? 100;
  const previousTier = existingProfile?.riskTier ?? 'low';

  // 2. Fetch all active (unrevoked) enforcement actions
  const activeActions = await dbRead
    .select()
    .from(userEnforcementActions)
    .where(
      and(
        eq(userEnforcementActions.userId, userId),
        eq(userEnforcementActions.isRevoked, false),
        or(
          isNull(userEnforcementActions.expiresAt),
          gt(userEnforcementActions.expiresAt, now),
        ),
      ),
    )
    .orderBy(desc(userEnforcementActions.createdAt));

  // 3. Fetch violation events for velocity calculation
  const recentViolations = await dbRead
    .select()
    .from(userViolationEvents)
    .where(
      and(
        eq(userViolationEvents.userId, userId),
        gte(userViolationEvents.createdAt, new Date(nowMs - VELOCITY_WINDOW_MS)),
      ),
    );

  // 4. Calculate trust score with time-decay
  let totalDeduction = 0;
  let activeStrikeCount = 0;

  for (const action of activeActions) {
    const daysSince = (nowMs - action.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const deduction = calculateViolationDeduction(
      action.severity,
      1.0, // Admin-applied actions have confidence 1.0
      daysSince,
    );
    totalDeduction += deduction;
    activeStrikeCount++;
  }

  // 5. Apply velocity penalty if threshold exceeded
  if (recentViolations.length >= VELOCITY_THRESHOLD) {
    totalDeduction += VELOCITY_PENALTY;
  }

  // 6. Calculate final score
  const newTrustScore = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));
  const newRiskTier = getRiskTierFromScore(newTrustScore);

  // 7. Determine probation period
  let probationUntil = existingProfile?.probationUntil ?? null;

  // Set probation based on risk tier
  if (newRiskTier === 'critical' && !probationUntil) {
    // Critical risk: 90-day probation
    probationUntil = new Date(nowMs + 90 * 24 * 60 * 60 * 1000);
  } else if (newRiskTier === 'high' && !probationUntil) {
    // High risk: 60-day probation
    probationUntil = new Date(nowMs + 60 * 24 * 60 * 60 * 1000);
  } else if (newRiskTier === 'elevated' && !probationUntil) {
    // Elevated risk: 30-day probation
    probationUntil = new Date(nowMs + 30 * 24 * 60 * 60 * 1000);
  } else if (newRiskTier === 'low' && probationUntil && probationUntil < now) {
    // Score recovered to low — clear probation
    probationUntil = null;
  }

  // 8. Persist the evaluation
  await dbWrite
    .insert(userTrustProfiles)
    .values({
      userId,
      trustScore: newTrustScore,
      strikeCount: activeStrikeCount,
      riskTier: newRiskTier,
      probationUntil,
      lastEvaluatedAt: now,
    })
    .onConflictDoUpdate({
      target: userTrustProfiles.userId,
      set: {
        trustScore: newTrustScore,
        strikeCount: activeStrikeCount,
        riskTier: newRiskTier,
        probationUntil,
        lastEvaluatedAt: now,
        updatedAt: now,
      },
    });

  return {
    userId,
    trustScore: newTrustScore,
    riskTier: newRiskTier,
    strikeCount: activeStrikeCount,
    activeViolationCount: recentViolations.length,
    probationUntil,
    lastEvaluatedAt: now,
    changes: {
      previousScore,
      scoreDelta: newTrustScore - previousScore,
      previousTier,
      tierChanged: newRiskTier !== previousTier,
      strikesExpired: 0, // Computed during batch evaluation
      probationSet: probationUntil !== null && probationUntil > now,
    },
  };
}

// ============================================================================
// Batch Evaluation (Cron Entry Point)
// ============================================================================

export interface BatchEvaluationResult {
  evaluatedCount: number;
  tierChanges: number;
  scoresChanged: number;
  probationSet: number;
  errors: string[];
}

/**
 * Batch-evaluates trust scores for all users with active enforcement actions
 * or recent violation events. This is the main entry point for the daily cron job.
 *
 * Process:
 * 1. Find all users with active enforcement actions
 * 2. Find all users with recent violation events (last 30 days)
 * 3. Evaluate trust score for each unique user
 * 4. Update risk tiers and probation periods
 *
 * @returns Batch evaluation summary
 */
export async function batchEvaluateTrustScores(): Promise<BatchEvaluationResult> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const errors: string[] = [];
  let evaluatedCount = 0;
  let tierChanges = 0;
  let scoresChanged = 0;
  let probationSet = 0;

  // 1. Find users with active enforcement actions
  const usersWithActions = await dbRead
    .selectDistinct({ userId: userEnforcementActions.userId })
    .from(userEnforcementActions)
    .where(
      and(
        eq(userEnforcementActions.isRevoked, false),
        or(
          isNull(userEnforcementActions.expiresAt),
          gt(userEnforcementActions.expiresAt, now),
        ),
      ),
    );

  // 2. Find users with recent violation events
  const usersWithViolations = await dbRead
    .selectDistinct({ userId: userViolationEvents.userId })
    .from(userViolationEvents)
    .where(gte(userViolationEvents.createdAt, thirtyDaysAgo));

  // 3. Deduplicate user IDs
  const allUserIds = new Set([
    ...usersWithActions.map((r) => r.userId),
    ...usersWithViolations.map((r) => r.userId),
  ]);

  console.log(`[TrustScore] 🔄 Starting batch evaluation for ${allUserIds.size} users`);

  // 4. Evaluate each user
  for (const userId of allUserIds) {
    if (!userId) continue; // Skip null userIds
    try {
      const result = await evaluateUserTrustScore(userId);
      evaluatedCount++;

      if (result.changes.tierChanged) tierChanges++;
      if (result.changes.scoreDelta !== 0) scoresChanged++;
      if (result.changes.probationSet) probationSet++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`User ${userId}: ${msg}`);
      console.error(`[TrustScore] ❌ Failed to evaluate user ${userId}:`, msg);
    }
  }

  const summary: BatchEvaluationResult = {
    evaluatedCount,
    tierChanges,
    scoresChanged,
    probationSet,
    errors,
  };

  console.log(
    `[TrustScore] ✅ Batch evaluation complete: ${evaluatedCount} users, ` +
    `${tierChanges} tier changes, ${scoresChanged} score changes, ` +
    `${probationSet} probations set, ${errors.length} errors`,
  );

  return summary;
}

// ============================================================================
// Velocity Detection
// ============================================================================

/**
 * Checks if a user has exceeded the velocity threshold (too many failed
 * attempts in a short window). Returns true if velocity throttle should
 * be applied.
 *
 * @param userId - The user to check
 * @param windowMs - Time window in milliseconds (default 15 minutes)
 * @param threshold - Maximum allowed events in window (default 10)
 * @returns Whether velocity threshold is exceeded
 */
export async function checkVelocityThreshold(
  userId: string,
  windowMs: number = VELOCITY_WINDOW_MS,
  threshold: number = VELOCITY_THRESHOLD,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMs);

  const [result] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(userViolationEvents)
    .where(
      and(
        eq(userViolationEvents.userId, userId),
        gte(userViolationEvents.createdAt, windowStart),
      ),
    );

  return (result?.count ?? 0) >= threshold;
}
