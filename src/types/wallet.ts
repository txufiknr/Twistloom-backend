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
  readerName: string;
  readerId: string;
  message: string | null;
  reply: string | null;
  replyAt: string | null;
  createdAt: Date;
}

export interface CreatorPayout {
  id: string;
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


