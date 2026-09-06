/**
 * Thanks (Creator Tipping) Configuration
 *
 * Defines preset amounts, platform fee, withdrawal limits, and rate limits
 * for the Thanks feature. Separate from the credit system — Thanks are
 * direct fiat transactions (reader pays money → creator receives money).
 */
export const THANKS_CONFIG = {
  /** Platform fee percentage (0-100). 5 = 5% deducted at time of Thanks. */
  platformFeePercent: 5,

  /** Preset tip amounts in IDR (smallest unit: whole IDR) */
  presetAmountsIDR: [10_000, 25_000, 50_000, 100_000],

  /** Preset tip amounts in USD (smallest unit: cents) */
  presetAmountsUSD: [100, 250, 500, 1_000],

  /** Minimum withdrawal amount (creator must reach this before cashing out) */
  minimumWithdrawalIDR: 100_000,
  minimumWithdrawalUSD: 1_000,

  /** Maximum single tip amount to prevent abuse */
  maxTipAmountIDR: 5_000_000,
  maxTipAmountUSD: 10_000,

  /** Currency defaults by gateway */
  defaultCurrency: {
    stripe: "USD" as const,
    xendit: "IDR" as const,
  },

  /** Rate limiting */
  maxTipsPerMinute: 10,
  maxTipsPerBookPerUser: 100,

  /** Balance → Credits conversion */
  /** How many IDR equals 1 credit (configurable without deploy) */
  idrPerCredit: 1_000,
  /** Minimum IDR amount convertible in a single transaction */
  minConversionAmountIDR: 10_000,
  /** How many USD cents equals 1 credit (~6.45 cents = $0.0645 per credit, aligned with 1000 IDR / 15500) */
  usdCentsPerCredit: 6.45,
  /** Minimum USD cents convertible in a single transaction ($1.00 = 100 cents) */
  minConversionAmountUSD: 100,
} as const;

export type ThanksCurrency = "IDR" | "USD";

/**
 * Calculate the platform fee for a given tip amount.
 * @param amount - Gross tip amount in smallest currency unit
 * @returns Platform fee in same unit
 */
export function calculatePlatformFee(amount: number): number {
  return Math.round(amount * THANKS_CONFIG.platformFeePercent / 100);
}

/**
 * Calculate creator net amount after platform fee.
 * @param amount - Gross tip amount in smallest currency unit
 * @returns Creator receives this amount
 */
export function calculateCreatorAmount(amount: number): number {
  return amount - calculatePlatformFee(amount);
}

/**
 * Builds the external_id used for Xendit Thanks tip invoices.
 * Format: `thanks-{readerId}-{bookId}-{timestampMs}`
 */
export function buildXenditThanksExternalId(
  readerId: string,
  bookId: string,
  timestampMs: number = Date.now()
): string {
  return `thanks-${readerId}-${bookId}-${timestampMs}`;
}

/**
 * Parses a Xendit Thanks external_id back into its components.
 */
export function parseXenditThanksExternalId(
  externalId: string
): { readerId: string; bookId: string; timestampMs: number } | null {
  const match = /^thanks-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i.exec(
    externalId
  );
  if (!match) return null;
  return {
    readerId: match[1],
    bookId: match[2],
    timestampMs: Number(match[3]),
  };
}
