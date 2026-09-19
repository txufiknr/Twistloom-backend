/**
 * Creator Wallet Types
 *
 * Type definitions for the creator wallet system — balances, earnings,
 * payouts, and conversions. Separate from the Thanks intake types.
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 */

/** Earning source that deposited funds into the wallet */
export type EarningSource = "thanks" | "revenue_share" | "custom_action" | "other";

/** Supported creator wallet settlement currencies */
export type WalletCurrency = "IDR" | "USD";

/** Payout status lifecycle states */
export type PayoutStatus = "pending" | "processing" | "completed" | "failed";

export interface CreatorWallet {
  creatorId: string;
  availableAmount: number;
  pendingAmount: number;
  withdrawnAmount: number;
  lifetimeGrossAmount?: number;
  lifetimeFeeAmount?: number;
  currency: WalletCurrency;
  payoutVerified: boolean;
  stripeConnectAccountId?: string | null;
}

export interface CreatorEarning {
  id: string;
  bookId: string;
  bookTitle: string | null;
  source: EarningSource;
  intakeAmount?: number;
  intakeCurrency?: WalletCurrency;
  fxRate?: number;
  settlementAmount?: number;
  grossAmount: number;
  platformFee: number;
  creatorAmount: number;
  currency: WalletCurrency;
  status?: "pending" | "completed" | "refunded";
  matureAt?: Date | null;
  readerName: string;
  readerId: string;
  message: string | null;
  reply: string | null;
  replyAt: string | null;
  createdAt: Date;
}

export interface CreatorPayout {
  id: string;
  creatorId: string;
  payoutMethodId?: string | null;
  amount: number;
  fee: number;
  netAmount: number;
  currency: WalletCurrency;
  status: PayoutStatus;
  provider?: string | null;
  createdAt: Date;
}

export interface ConvertToCreditsResult {
  converted: number;
  creditsAdded: number;
  newBalance: number;
  newCredits: number;
  /** When converting via pack, the pack ID used for pricing */
  packId?: string;
}

export const payoutMethodTypes = ["bank_transfer", "e_wallet", "stripe_connect"] as const;
export type PayoutMethodType = (typeof payoutMethodTypes)[number];

export const kycVerificationStatuses = ["pending", "verified", "rejected", "requires_manual_review"] as const;
export type KycVerificationStatus = (typeof kycVerificationStatuses)[number];

export const kycVerificationTypes = ["bank_account_inquiry", "identity_document", "tin_tax_form"] as const;
export type KycVerificationType = (typeof kycVerificationTypes)[number];

export const verificationConfidences = ["high", "medium", "low"] as const;
export type VerificationConfidence = (typeof verificationConfidences)[number];

export const bankAccountStatuses = ["SUCCESS", "INVALID_ACCOUNT_NO", "FAILED"] as const;
export type BankAccountStatus = (typeof bankAccountStatuses)[number];

export interface CreatorPayoutMethod {
  id: string;
  creatorId: string;
  methodType: PayoutMethodType;
  bankName: string | null;
  bankCode: string | null;
  accountLast4: string | null;
  accountName: string | null;
  currency: WalletCurrency;
  isDefault: boolean;
  isVerified: boolean;
  createdAt: Date;
}

export interface CreatorKycVerification {
  id: string;
  creatorId: string;
  payoutMethodId: string | null;
  verificationType: KycVerificationType;
  status: KycVerificationStatus;
  inquiryHolderName: string | null;
  registeredName: string | null;
  nameMatchScore: number | null;
  confidence: VerificationConfidence | null;
  failureReason: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface BankAccountValidationResult {
  bankCode: string;
  accountNumberMasked: string;
  accountHolderName: string;
  nameMatchScore: number;
  confidence: VerificationConfidence;
  isMatch: boolean;
  status: BankAccountStatus;
  rawStatus?: string;
}

export const payoutEventActorTypes = ["system", "admin", "webhook", "creator"] as const;
export type PayoutEventActorType = (typeof payoutEventActorTypes)[number];

export interface CreatorPayoutEvent {
  id: string;
  payoutId: string;
  previousStatus: PayoutStatus | null;
  newStatus: PayoutStatus;
  actorType: PayoutEventActorType;
  actorId: string | null;
  note: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MaturationResult {
  maturedCount: number;
  creatorsCount: number;
  totalAmountsByCurrency: Record<WalletCurrency, number>;
}

export interface DisbursementBatchResult {
  processedCount: number;
  completedCount: number;
  pendingCount: number;
  failedCount: number;
  skippedCount: number;
}

export const taxFormTypes = ["w8ben", "w9", "npwp"] as const;
export type TaxFormType = (typeof taxFormTypes)[number];

export const taxProfileStatuses = ["pending", "verified", "rejected"] as const;
export type TaxProfileStatus = (typeof taxProfileStatuses)[number];

export interface CreatorTaxProfile {
  id: string;
  creatorId: string;
  formType: TaxFormType;
  taxCountry: string;
  taxIdLast4: string | null;
  legalName: string;
  signatureName?: string | null;
  signerIpAddress?: string | null;
  treatyBenefitClaimed: boolean;
  treatyCountry: string | null;
  treatyArticle: string | null;
  withholdingRate: number;
  certifiedAt: Date;
  expiresAt?: Date | null;
  status: TaxProfileStatus;
  failureReason: string | null;
  createdAt: Date;
}

export interface SaveTaxProfileRequest {
  formType: TaxFormType;
  taxCountry: string;
  taxId?: string;
  legalName: string;
  signatureName?: string;
  signerIpAddress?: string;
  treatyBenefitClaimed?: boolean;
  treatyCountry?: string;
  treatyArticle?: string;
}

export interface SaveTaxProfileResponse {
  success: boolean;
  taxProfileId?: string;
  withholdingRate: number;
  status: TaxProfileStatus;
  message?: string;
}





