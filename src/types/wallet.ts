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

export interface CreatorWallet {
  creatorId: string;
  availableAmount: number;
  pendingAmount: number;
  withdrawnAmount: number;
  lifetimeGrossAmount?: number;
  lifetimeFeeAmount?: number;
  currency: "IDR" | "USD" | string;
  payoutVerified: boolean;
  stripeConnectAccountId?: string | null;
}

export interface CreatorEarning {
  id: string;
  bookId: string;
  bookTitle: string | null;
  source: EarningSource;
  intakeAmount?: number;
  intakeCurrency?: "IDR" | "USD" | string;
  fxRate?: number;
  settlementAmount?: number;
  grossAmount: number;
  platformFee: number;
  creatorAmount: number;
  currency: "IDR" | "USD" | string;
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
  currency: "IDR" | "USD" | string;
  status: string;
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
