/**
 * Trust & Safety Type Definitions
 *
 * Defines domain enums, severity scales, risk tiers, and structured payloads
 * for the Twistloom Trust & Safety progressive enforcement system.
 */

/**
 * High-level violation categories
 */
export const violationTypes = [
  'ai_policy',
  'prompt_abuse',
  'credit_abuse',
  'automation',
  'community_abuse',
  'harassment',
  'copyright',
  'illegal_content',
  'payment_fraud',
  'security',
  'other',
] as const;

export type ViolationType = (typeof violationTypes)[number];

/**
 * Severity ranking for violations
 */
export const violationSeverities = ['low', 'medium', 'high', 'critical'] as const;

export type ViolationSeverity = (typeof violationSeverities)[number];

/**
 * Disciplinary actions in progressive enforcement ladder
 */
export const enforcementActions = [
  'warning',
  'limit_generation',
  'limit_daily_usage',
  'mute_community',
  'hide_profile',
  'remove_content',
  'suspend',
  'permanent_ban',
] as const;

export type EnforcementAction = (typeof enforcementActions)[number];

/**
 * User dynamic risk tiers
 */
export const riskTiers = ['low', 'elevated', 'high', 'critical'] as const;

export type RiskTier = (typeof riskTiers)[number];

/**
 * Target entity types supported by polymorphic moderation reports
 */
export const reportTargetTypes = [
  'user',
  'book',
  'page',
  'comment',
  'testimonial',
  'custom_action',
] as const;

export type ReportTargetType = (typeof reportTargetTypes)[number];

/**
 * Polymorphic report reason categories
 */
export const reportTypes = [
  'spam',
  'harassment',
  'impersonation',
  'copyright',
  'inappropriate',
  'ai_safety',
  'other',
] as const;

export type ReportType = (typeof reportTypes)[number];

/**
 * Moderation report resolution states
 */
export const reportStatuses = ['open', 'under_review', 'resolved', 'dismissed'] as const;

export type ReportStatus = (typeof reportStatuses)[number];

/**
 * Appeal review statuses
 */
export const appealStatuses = ['pending', 'approved', 'rejected'] as const;

export type AppealStatus = (typeof appealStatuses)[number];

/**
 * Sources for recorded violation events
 */
export const violationEventSources = [
  'client_gate',
  'ai_moderator',
  'rate_engine',
  'user_report',
  'payment_gateway',
  'admin_manual',
] as const;

export type ViolationEventSource = (typeof violationEventSources)[number];

/**
 * Structured User Trust Profile
 */
export interface UserTrustProfile {
  userId: string;
  trustScore: number;
  strikeCount: number;
  riskTier: RiskTier;
  probationUntil: Date | null;
  lastEvaluatedAt: Date;
  updatedAt: Date;
}

/**
 * Active enforcement summary evaluated by middleware
 */
export interface UserEnforcementStatus {
  userId: string;
  isBanned: boolean;
  isSuspended: boolean;
  isThrottled: boolean;
  isMuted: boolean;
  dailyGenerationLimit: number | null;
  activeActions: UserEnforcementActionSummary[];
}

export interface UserEnforcementActionSummary {
  id: string;
  action: EnforcementAction;
  violationType: ViolationType;
  severity: ViolationSeverity;
  reason: string;
  expiresAt: Date | null;
  createdAt: Date;
}
