/**
 * Credit Voucher Types
 *
 * Defines the domain types for the credit voucher redemption system.
 * @see docs/roadmap/TWISTLOOM_CREDIT_VOUCHERS_AND_PROMOTIONAL_ENTITLEMENTS_ROADMAP.md
 */

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export type CampaignStatus = "draft" | "active" | "paused" | "exhausted" | "ended" | "revoked";
export type GrantType = "credit_grant";
export type EligibilityPolicy = "open" | "email_domain" | "assigned";
export type DistributionType = "single_use_batch" | "multi_use" | "assigned";

export interface VoucherCampaign {
  id: string;
  slug: string;
  displayName: string;
  internalPurpose: string;
  status: CampaignStatus;
  grantType: GrantType;
  creditsPerRedemption: number;
  maxRedemptions: number;
  maxRedemptionsPerUser: number;
  startsAt: Date | null;
  endsAt: Date | null;
  eligibilityPolicy: EligibilityPolicy;
  distributionType: DistributionType;
  createdByUserId: string;
  approvedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

export type CodeStatus = "issued" | "active" | "redeemed" | "revoked";

export interface VoucherCode {
  id: string;
  campaignId: string;
  codeHmac: string;
  hmacKeyVersion: number;
  publicPrefix: string;
  lastFour: string;
  status: CodeStatus;
  assignedUserId: string | null;
  maxRedemptions: number;
  redeemedCount: number;
  activatedAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export interface VoucherRedemption {
  id: string;
  campaignId: string;
  codeId: string;
  userId: string;
  creditsGranted: number;
  transactionId: string;
  idempotencyKey: string;
  redeemedAt: Date;
  eligibilitySnapshot: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API request / response
// ---------------------------------------------------------------------------

export interface RedeemCreditVoucherRequest {
  code: string;
  idempotencyKey: string;
}

export interface RedeemCreditVoucherResponse {
  redemptionId: string;
  transactionId: string;
  creditsGranted: number;
  newBalance: number;
  campaignDisplayName?: string;
  redeemedAt: string;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminCreateCampaignRequest {
  slug: string;
  displayName: string;
  internalPurpose: string;
  creditsPerRedemption: number;
  maxRedemptions: number;
  maxRedemptionsPerUser?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  eligibilityPolicy?: EligibilityPolicy;
  distributionType?: DistributionType;
}

export interface AdminUpdateCampaignRequest {
  displayName?: string;
  internalPurpose?: string;
  status?: CampaignStatus;
  creditsPerRedemption?: number;
  maxRedemptions?: number;
  maxRedemptionsPerUser?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface AdminGenerateCodesRequest {
  campaignId: string;
  count: number;
}

export interface AdminGenerateCodesResponse {
  campaignId: string;
  generated: number;
  /** Raw codes — shown once at creation, never stored. */
  codes: string[];
}

export interface AdminVoucherCampaignListItem {
  id: string;
  slug: string;
  displayName: string;
  status: CampaignStatus;
  grantType: GrantType;
  creditsPerRedemption: number;
  maxRedemptions: number;
  maxRedemptionsPerUser: number;
  codesIssued: number;
  codesRedeemed: number;
  startsAt: string | null;
  endsAt: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface AdminVoucherCampaignDetail extends AdminVoucherCampaignListItem {
  internalPurpose: string;
  eligibilityPolicy: EligibilityPolicy;
  distributionType: DistributionType;
  approvedByUserId: string | null;
  updatedAt: string;
}
