/**
 * Xendit payment gateway configuration
 *
 * IDR pricing for credit packs and VIP subscription.
 * v1 ships credit-pack Invoice API and subscription Recurring Plans API.
 *
 * @see docs/roadmap/STRIPE_AND_XENDIT_GATEWAY_AGNOSTIC_ROADMAP.md §6.4
 */

import type { CREDIT_PACKS } from "./credits.js";
import { isValidUuid } from "../utils/uuid.js";

/** Credit pack IDs that have Xendit IDR prices — synchronized with CREDIT_PACKS */
export type XenditCreditPackId = (typeof CREDIT_PACKS)[number]["id"];

/**
 * Xendit-specific configuration for IDR pricing and payment channels.
 *
 * Env:
 * - `XENDIT_SECRET_KEY` — API secret (test/live)
 * - `XENDIT_WEBHOOK_TOKEN` — callback verification token
 * - `XENDIT_USD_TO_IDR_RATE` — fixed FX rate for display/reference (default 15500)
 * - `XENDIT_ENABLED` — master switch (`true` to accept Xendit checkout/webhooks)
 */
export const XENDIT_CONFIG = {
  /** Master kill-switch — checkout/webhook reject when false */
  enabled: process.env.XENDIT_ENABLED === "true",

  secretKey: process.env.XENDIT_SECRET_KEY || "",
  webhookToken: process.env.XENDIT_WEBHOOK_TOKEN || "",

  /** Fixed USD → IDR rate (update when FX moves materially) */
  usdToIdrRate: parseInt(process.env.XENDIT_USD_TO_IDR_RATE || "15500", 10),

  /**
   * Credit pack prices in IDR (whole rupiah; Xendit Invoice amounts are integers).
   * Aligned to ~USD pack prices at the default exchange rate.
   */
  creditPacks: [
    {
      id: "observer" as const,
      amountIdr: 45000, // ~$2.99
      description: "Observer Pack",
    },
    {
      id: "investigator" as const,
      amountIdr: 125000, // ~$7.99
      description: "Investigator Pack",
    },
    {
      id: "mastermind" as const,
      amountIdr: 310000, // ~$19.99
      description: "Mastermind Pack",
    },
  ],

  /**
   * VIP subscription price in IDR (reserved for Phase 2b — not used in v1).
   */
  subscription: {
    amountIdr: 150000,
    currency: "IDR" as const,
    interval: "MONTH" as const,
    intervalCount: 1,
  },

  /** Common Indonesia payment channels (Invoice API selects automatically) */
  availableChannels: [
    "VIRTUAL_ACCOUNT_BCA",
    "VIRTUAL_ACCOUNT_MANDIRI",
    "VIRTUAL_ACCOUNT_BNI",
    "VIRTUAL_ACCOUNT_BRI",
    "EWALLET_OVO",
    "EWALLET_DANA",
    "EWALLET_SHOPEEPAY",
    "QRIS",
    "CREDIT_CARD",
  ] as const,

  /** Invoice expiry in seconds (48h) */
  invoiceDurationSeconds: 172800,
} as const;

/**
 * Returns the Xendit IDR amount for a credit pack id, or `null` if unknown.
 *
 * @param packId - Credit pack id (e.g. `observer`)
 */
export function getXenditPackPriceIdr(packId: string): number | null {
  const pack = XENDIT_CONFIG.creditPacks.find((p) => p.id === packId);
  return pack?.amountIdr ?? null;
}

/**
 * Builds the external_id used for Xendit invoices (idempotency + metadata recovery).
 *
 * Format: `credit-pack-{userId}-{packId}-{timestamp}`
 */
export function buildXenditCreditPackExternalId(
  userId: string,
  packId: string,
  timestampMs: number = Date.now()
): string {
  return `credit-pack-${userId}-${packId}-${timestampMs}`;
}

/**
 * Parses `external_id` from {@link buildXenditCreditPackExternalId}.
 *
 * @returns Parsed fields or `null` if the string does not match
 */
export function parseXenditCreditPackExternalId(
  externalId: string
): { userId: string; packId: string; timestampMs: number } | null {
  // UUID v7 is 36 chars with hyphens; pack ids are single tokens without hyphens in practice
  const match = /^credit-pack-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([a-z0-9_-]+)-(\d+)$/i.exec(
    externalId
  );
  if (!match) return null;
  return {
    userId: match[1],
    packId: match[2],
    timestampMs: Number(match[3]),
  };
}

/**
 * Builds the reference_id used for Xendit subscription recurring plans.
 *
 * Format: `vip-sub-{userId}-{timestamp}`
 */
export function buildXenditSubscriptionReferenceId(
  userId: string,
  timestampMs: number = Date.now()
): string {
  return `vip-sub-${userId}-${timestampMs}`;
}

/**
 * Parses a Xendit subscription reference_id back into its components.
 *
 * @returns Parsed fields or `null` if the string does not match
 */
export function parseXenditSubscriptionReferenceId(
  referenceId: string
): { userId: string; timestampMs: number } | null {
  const match = /^vip-sub-([a-f0-9-]+)-(\d+)$/i.exec(referenceId);
  if (!match) return null;

  const userId = match[1];
  if (!isValidUuid(userId)) return null;

  const timestampMs = Number(match[2]);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

  return { userId, timestampMs };
}
