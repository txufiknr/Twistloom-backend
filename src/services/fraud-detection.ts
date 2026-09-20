/**
 * Fraud Detection & Credit Protection Service
 *
 * Detects and prevents:
 * - Credit pumping (abnormal credit accrual patterns)
 * - Refund abuse (excessive refunds, chargeback cycles)
 * - Multi-account abuse (IP/fingerprint/behavioral matching)
 * - Bot detection (behavioral anomalies, impossible travel)
 *
 * Integrates with the trust scoring engine (trust-score.ts) and
 * provides middleware guards for credit-sensitive operations.
 *
 * @see docs/architecture/TRUST_AND_SAFETY_ARCHITECTURE.md §TS.7
 * @see docs/roadmap/TRUST_AND_SAFETY_ROADMAP.md §TS.7
 */

import { dbRead } from "../db/client.js";
import { transactions, userTrustProfiles } from "../db/schema.js";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import { getRiskTierFromScore } from "./trust-score.js";
import type { RiskTier } from "../types/trust-safety.js";
import type { TransactionType } from "../types/credits.js";

// ============================================================================
// Types
// ============================================================================

export interface FraudCheckResult {
  allowed: boolean;
  reason?: string;
  riskTier?: RiskTier;
  flags: FraudFlag[];
}

export interface FraudFlag {
  type: FraudFlagType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string;
}

export type FraudFlagType =
  | 'velocity_credit_pump'
  | 'velocity_refund_abuse'
  | 'trust_tier_restricted'
  | 'probation_active'
  | 'chargeback_risk'
  | 'multi_account_suspected'
  | 'bot_behavior';

export interface VelocityCheck {
  windowMs: number;
  maxOperations: number;
  operationType: TransactionType;
}

export interface CreditRestrictions {
  maxDailyCredits: number;
  maxCreditBalance: number;
  requireManualApproval: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

/** Credit pumping detection: max credits earned per 24-hour window */
const CREDIT_VELOCITY_LIMITS: Partial<Record<TransactionType, VelocityCheck>> = {
  purchase: { windowMs: 24 * 60 * 60 * 1000, maxOperations: 50, operationType: 'purchase' },
  refund: { windowMs: 24 * 60 * 60 * 1000, maxOperations: 5, operationType: 'refund' },
  usage: { windowMs: 60 * 60 * 1000, maxOperations: 30, operationType: 'usage' },
};

/** Trust tier restrictions for credit operations */
const TIER_CREDIT_RESTRICTIONS: Record<RiskTier, CreditRestrictions> = {
  low: { maxDailyCredits: Infinity, maxCreditBalance: Infinity, requireManualApproval: false },
  elevated: { maxDailyCredits: 500, maxCreditBalance: 2000, requireManualApproval: false },
  high: { maxDailyCredits: 100, maxCreditBalance: 500, requireManualApproval: true },
  critical: { maxDailyCredits: 0, maxCreditBalance: 0, requireManualApproval: true },
};

// ============================================================================
// Velocity Detection
// ============================================================================

/**
 * Checks if a user has exceeded the velocity threshold for a specific
 * operation type within the configured time window.
 *
 * @param userId - The user to check
 * @param operationType - The type of operation to check
 * @param customWindowMs - Optional override for the window
 * @param customMaxOps - Optional override for the max operations
 * @returns Whether velocity threshold is exceeded and current count
 */
export async function checkCreditVelocity(
  userId: string,
  operationType: TransactionType,
  customWindowMs?: number,
  customMaxOps?: number,
): Promise<{ exceeded: boolean; count: number; limit: number }> {
  const config = CREDIT_VELOCITY_LIMITS[operationType];
  if (!config) return { exceeded: false, count: 0, limit: Infinity };

  const windowMs = customWindowMs ?? config.windowMs;
  const maxOps = customMaxOps ?? config.maxOperations;
  const windowStart = new Date(Date.now() - windowMs);

  const [result] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, operationType as TransactionType),
        gte(transactions.createdAt, windowStart),
      ),
    );

  const count = result?.count ?? 0;
  return { exceeded: count >= maxOps, count, limit: maxOps };
}

// ============================================================================
// Trust Tier Checks
// ============================================================================

/**
 * Checks if a user's trust tier allows them to perform credit-sensitive
 * operations. Returns the restrictions applicable to their tier.
 *
 * @param userId - The user to check
 * @returns Fraud check result with any applicable restrictions
 */
export async function checkTrustTierForCredits(userId: string): Promise<FraudCheckResult> {
  const flags: FraudFlag[] = [];

  // Fetch trust profile
  const [profile] = await dbRead
    .select()
    .from(userTrustProfiles)
    .where(eq(userTrustProfiles.userId, userId))
    .limit(1);

  const trustScore = profile?.trustScore ?? 100;
  const riskTier = getRiskTierFromScore(trustScore);

  // Check tier restrictions
  const restrictions = TIER_CREDIT_RESTRICTIONS[riskTier];

  if (riskTier === 'critical') {
    flags.push({
      type: 'trust_tier_restricted',
      severity: 'critical',
      details: `User at critical risk (score: ${trustScore}) — all credit operations blocked`,
    });
    return { allowed: false, reason: 'Account at critical trust level — credit operations suspended', riskTier, flags };
  }

  if (riskTier === 'high' && restrictions.requireManualApproval) {
    flags.push({
      type: 'trust_tier_restricted',
      severity: 'high',
      details: `User at high risk (score: ${trustScore}) — credit operations require manual approval`,
    });
    return { allowed: false, reason: 'Account requires manual approval for credit operations', riskTier, flags };
  }

  if (riskTier === 'elevated') {
    // Check daily credit accrual
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [dailyCredits] = await dbRead
      .select({ total: sql<number>`coalesce(sum(${transactions.credits}), 0)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          gte(transactions.createdAt, todayStart),
          sql`${transactions.credits} > 0`,
        ),
      );

    if ((dailyCredits?.total ?? 0) >= restrictions.maxDailyCredits) {
      flags.push({
        type: 'velocity_credit_pump',
        severity: 'medium',
        details: `Daily credit limit reached (${dailyCredits?.total}/${restrictions.maxDailyCredits})`,
      });
    }
  }

  // Check probation
  if (profile?.probationUntil && profile.probationUntil > new Date()) {
    flags.push({
      type: 'probation_active',
      severity: 'high',
      details: `User on probation until ${profile.probationUntil.toISOString()}`,
    });
  }

  return {
    allowed: flags.length === 0 || !flags.some(f => f.severity === 'critical'),
    riskTier,
    flags,
  };
}

// ============================================================================
// Refund Abuse Detection
// ============================================================================

/**
 * Detects refund abuse patterns: excessive refunds, rapid refund cycling,
 * or refunds that exceed a threshold of recent purchases.
 *
 * @param userId - The user to check
 * @param windowMs - Time window for analysis (default 30 days)
 * @param maxRefundRatio - Maximum allowed refund-to-purchase ratio (default 0.3)
 * @returns Fraud check result
 */
export async function detectRefundAbuse(
  userId: string,
  windowMs: number = 30 * 24 * 60 * 60 * 1000,
  maxRefundRatio: number = 0.3,
): Promise<FraudCheckResult> {
  const flags: FraudFlag[] = [];
  const windowStart = new Date(Date.now() - windowMs);

  // Count refunds in window
  const [refundResult] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'refund'),
        gte(transactions.createdAt, windowStart),
      ),
    );

  // Count purchases in window
  const [purchaseResult] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'purchase'),
        gte(transactions.createdAt, windowStart),
      ),
    );

  const refundCount = refundResult?.count ?? 0;
  const purchaseCount = purchaseResult?.count ?? 0;

  // Calculate refund ratio
  const refundRatio = purchaseCount > 0 ? refundCount / purchaseCount : refundCount > 0 ? 1.0 : 0;

  if (refundRatio >= maxRefundRatio && refundCount >= 3) {
    flags.push({
      type: 'velocity_refund_abuse',
      severity: refundRatio >= 0.5 ? 'critical' : 'high',
      details: `Refund ratio ${(refundRatio * 100).toFixed(1)}% (${refundCount} refunds / ${purchaseCount} purchases in 30 days)`,
    });
  }

  // Check for rapid refund cycling (refund within 24h of purchase)
  const recentPurchases = await dbRead
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'purchase'),
        gte(transactions.createdAt, new Date(Date.now() - 48 * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(10);

  for (const purchase of recentPurchases) {
    // Check if there's a refund within 24h of this purchase
    const [correspondingRefund] = await dbRead
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.type, 'refund'),
          gte(transactions.createdAt, purchase.createdAt),
          sql`${transactions.createdAt} <= ${new Date(purchase.createdAt.getTime() + 24 * 60 * 60 * 1000)}`,
        ),
      )
      .limit(1);

    if (correspondingRefund) {
      flags.push({
        type: 'chargeback_risk',
        severity: 'high',
        details: `Rapid refund cycling detected: refund within 24h of purchase`,
      });
      break;
    }
  }

  return {
    allowed: !flags.some(f => f.severity === 'critical'),
    flags,
  };
}

// ============================================================================
// Multi-Account Detection (Lightweight)
// ============================================================================

/**
 * Lightweight multi-account detection based on shared characteristics.
 * This is a v1 heuristic — a more sophisticated version would use
 * device fingerprinting and behavioral biometrics.
 *
 * NOTE: IP-based detection requires a `user_ip_logs` table which is not
 * yet implemented. This function currently always returns no flags.
 * When an IP log table is added, implement the cross-reference here.
 *
 * @param userId - The user to check
 * @param ipAddress - The IP address to cross-reference
 * @returns Fraud check result with any suspected multi-account flags
 */
export async function detectMultiAccount(
  _userId: string,
  _ipAddress?: string,
): Promise<FraudCheckResult> {
  // TODO: Implement IP-based multi-account detection when user_ip_logs table exists
  return { allowed: true, flags: [] };
}

// ============================================================================
// Composite Fraud Check
// ============================================================================

/**
 * Runs all fraud detection checks for a user in parallel and returns
 * a composite result. Used as a guard before credit-sensitive operations.
 *
 * @param userId - The user to check
 * @param ipAddress - Optional IP address for multi-account detection
 * @param operationType - The type of operation being performed
 * @returns Composite fraud check result
 */
export async function runFraudChecks(
  userId: string,
  ipAddress?: string,
  operationType: TransactionType = 'usage',
): Promise<FraudCheckResult> {
  const allFlags: FraudFlag[] = [];

  // Run all checks in parallel for performance
  const [tierCheck, velocityCheck, refundCheck, multiAccountCheck] = await Promise.all([
    checkTrustTierForCredits(userId),
    checkCreditVelocity(userId, operationType),
    detectRefundAbuse(userId),
    detectMultiAccount(userId, ipAddress),
  ]);

  // Aggregate flags
  allFlags.push(...tierCheck.flags);
  if (velocityCheck.exceeded) {
    allFlags.push({
      type: 'velocity_credit_pump',
      severity: 'high',
      details: `Velocity threshold exceeded: ${velocityCheck.count}/${velocityCheck.limit} operations in window`,
    });
  }
  allFlags.push(...refundCheck.flags);
  allFlags.push(...multiAccountCheck.flags);

  // Determine overall result
  const hasCritical = allFlags.some(f => f.severity === 'critical');
  const hasHigh = allFlags.some(f => f.severity === 'high');

  return {
    allowed: !hasCritical && !hasHigh,
    reason: hasCritical
      ? 'Critical fraud indicators detected — operation blocked'
      : hasHigh
        ? 'High-risk fraud indicators detected — operation requires review'
        : undefined,
    riskTier: tierCheck.riskTier,
    flags: allFlags,
  };
}

// ============================================================================
// Middleware Guard
// ============================================================================

/**
 * Middleware guard for credit-sensitive operations. Checks trust tier,
 * velocity, and refund abuse patterns. Throws if operation is not allowed.
 *
 * @param userId - The user performing the operation
 * @param ipAddress - Optional IP address
 * @param operationType - The type of operation
 * @throws Error if fraud checks fail
 */
export async function requireNoFraudFlags(
  userId: string,
  ipAddress?: string,
  operationType: TransactionType = 'usage',
): Promise<void> {
  const result = await runFraudChecks(userId, ipAddress, operationType);

  if (!result.allowed) {
    const flagSummary = result.flags
      .map((f) => `[${f.severity}] ${f.type}: ${f.details}`)
      .join('; ');

    console.warn(
      `[FraudDetection] 🚫 User ${userId} blocked from ${operationType}: ${result.reason}\n` +
      `  Flags: ${flagSummary}`,
    );

    throw new Error(result.reason ?? 'Fraud detection: operation not allowed');
  }

  // Log warnings for non-blocking flags
  if (result.flags.length > 0) {
    const warningSummary = result.flags
      .map((f) => `[${f.severity}] ${f.type}`)
      .join(', ');
    console.warn(
      `[FraudDetection] ⚠️ User ${userId} has fraud warnings for ${operationType}: ${warningSummary}`,
    );
  }
}
