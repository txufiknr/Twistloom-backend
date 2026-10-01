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
 * Type guard for untrusted request input destined for `user_enforcement_actions.violation_type`.
 *
 * Enforcement/ban mutations are privileged: validate structurally instead of casting
 * a request string (`body.violationType as ViolationType`), so the compile-time
 * invariant on {@link ViolationType} cannot be bypassed at the API boundary.
 *
 * @param value - Raw value parsed from a request body
 * @returns `true` when the value is a known {@link ViolationType}
 */
export function isViolationType(value: unknown): value is ViolationType {
  return typeof value === "string" && (violationTypes as readonly string[]).includes(value);
}

/**
 * Type guard for untrusted request input destined for enforcement `severity`.
 *
 * @param value - Raw value parsed from a request body
 * @returns `true` when the value is a known {@link ViolationSeverity}
 */
export function isViolationSeverity(value: unknown): value is ViolationSeverity {
  return typeof value === "string" && (violationSeverities as readonly string[]).includes(value);
}

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
 * Type guard for untrusted request input destined for enforcement `action`.
 *
 * @param value - Raw value parsed from a request body
 * @returns `true` when the value is a known {@link EnforcementAction}
 */
export function isEnforcementAction(value: unknown): value is EnforcementAction {
  return typeof value === "string" && (enforcementActions as readonly string[]).includes(value);
}

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
  'post',
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
