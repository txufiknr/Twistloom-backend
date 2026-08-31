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
  currency: string;
  payoutVerified: boolean;
}

export interface CreatorEarning {
  id: string;
  bookId: string;
  bookTitle: string | null;
  source: EarningSource;
  grossAmount: number;
  platformFee: number;
  creatorAmount: number;
  currency: string;
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
  currency: string;
  status: string;
  createdAt: Date;
}

export interface ConvertToCreditsResult {
  converted: number;
  creditsAdded: number;
  newBalance: number;
  newCredits: number;
}
