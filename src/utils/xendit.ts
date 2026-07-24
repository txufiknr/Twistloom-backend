/**
 * Xendit HTTP helpers (raw fetch — no SDK dependency for Invoice API v1).
 *
 * @see https://developers.xendit.co/api-reference/#create-invoice
 * @see docs/roadmap/STRIPE_AND_XENDIT_GATEWAY_AGNOSTIC_ROADMAP.md §6.1
 */

import { XENDIT_CONFIG } from "../config/xendit.js";
import { requireEnv } from "./env.js";

const XENDIT_INVOICE_API = "https://api.xendit.co/v2/invoices";

/**
 * Payload for creating a one-time credit-pack invoice.
 */
export interface CreateXenditInvoiceParams {
  externalId: string;
  amountIdr: number;
  description: string;
  payerEmail: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  customerName?: string;
  /** Free-form metadata echoed back on webhook where supported */
  metadata?: Record<string, string>;
}

/**
 * Minimal invoice fields we rely on after create / webhook.
 */
export interface XenditInvoice {
  id: string;
  external_id: string;
  status: string;
  amount: number;
  paid_amount?: number;
  currency?: string;
  invoice_url?: string;
  description?: string;
  payer_email?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Returns true when Xendit is enabled and credentials are present.
 */
export function isXenditConfigured(): boolean {
  return XENDIT_CONFIG.enabled && Boolean(XENDIT_CONFIG.secretKey);
}

/**
 * Verifies the Xendit webhook `x-callback-token` header.
 *
 * @param callbackToken - Value of `x-callback-token` request header
 */
export function verifyXenditCallbackToken(callbackToken: string | undefined | null): boolean {
  const expected = XENDIT_CONFIG.webhookToken || process.env.XENDIT_WEBHOOK_TOKEN;
  if (!expected || !callbackToken) return false;
  return callbackToken === expected;
}

/**
 * Creates a Xendit Invoice and returns the hosted checkout URL.
 *
 * Uses Basic auth: `secretKey:` (empty password) base64-encoded.
 *
 * @param params - Invoice fields
 * @returns Created invoice including `invoice_url`
 */
export async function createXenditInvoice(
  params: CreateXenditInvoiceParams
): Promise<XenditInvoice> {
  const secretKey = requireEnv("XENDIT_SECRET_KEY");
  const auth = Buffer.from(`${secretKey}:`).toString("base64");

  const body = {
    external_id: params.externalId,
    amount: params.amountIdr,
    currency: "IDR",
    description: params.description,
    invoice_duration: XENDIT_CONFIG.invoiceDurationSeconds,
    payer_email: params.payerEmail,
    success_redirect_url: params.successRedirectUrl,
    failure_redirect_url: params.failureRedirectUrl,
    customer: {
      given_names: params.customerName || "Twistloom User",
      email: params.payerEmail,
    },
    items: [
      {
        name: params.description,
        quantity: 1,
        price: params.amountIdr,
        category: "Credit Pack",
      },
    ],
    metadata: params.metadata ?? {},
  };

  const response = await fetch(XENDIT_INVOICE_API, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as XenditInvoice & {
    error_code?: string;
    message?: string;
  };

  if (!response.ok) {
    const message = payload.message || payload.error_code || response.statusText;
    throw new Error(`Xendit create invoice failed (${response.status}): ${message}`);
  }

  if (!payload.invoice_url) {
    throw new Error("Xendit create invoice response missing invoice_url");
  }

  return payload;
}
