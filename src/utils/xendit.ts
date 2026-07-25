/**
 * Xendit HTTP helpers (raw fetch — no SDK dependency).
 *
 * Supports:
 * - Invoice API v2 (credit packs)
 * - Customers API (subscription prerequisite)
 * - Recurring Plans API (subscriptions v1)
 *
 * @see https://developers.xendit.co/api-reference/#create-invoice
 * @see https://developers.xendit.co/api-reference/#create-customer
 * @see https://developers.xendit.co/api-reference/#create-recurring-plan
 */

import { XENDIT_CONFIG } from "../config/xendit.js";
import { requireEnv } from "./env.js";

const XENDIT_INVOICE_API = "https://api.xendit.co/v2/invoices";
const XENDIT_CUSTOMER_API = "https://api.xendit.co/customers";
const XENDIT_RECURRING_API = "https://api.xendit.co/recurring/plans";

// ─── Auth helper ────────────────────────────────────────────────────────

function getXenditAuth(): string {
  const secretKey = requireEnv("XENDIT_SECRET_KEY");
  return Buffer.from(`${secretKey}:`).toString("base64");
}

function getXenditHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${getXenditAuth()}`,
    "Content-Type": "application/json",
  };
}

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
 * Xendit Customer object (created before subscription checkout).
 *
 * @see https://developers.xendit.co/api-reference/#create-customer
 */
export interface XenditCustomer {
  id: string;
  reference_id: string;
  given_names?: string;
  email?: string;
  mobile_number?: string;
  status?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

/**
 * Payload for creating a Xendit customer.
 */
export interface CreateXenditCustomerParams {
  referenceId: string;
  givenNames: string;
  email: string;
  mobileNumber?: string;
  metadata?: Record<string, string>;
}

/**
 * Xendit Recurring Plan object.
 *
 * @see https://developers.xendit.co/api-reference/#create-recurring-plan
 */
export interface XenditRecurringPlan {
  id: string;
  reference_id: string;
  customer_id: string;
  recurring_action: string;
  failed_cycle_action: string;
  recurring_cycle_count: number;
  currency: string;
  amount: number;
  status: string;
  created: string;
  updated: string;
  schedule_id: string;
  payment_methods?: Array<{
    payment_method_id: string;
    priority: number;
  }>;
  schedule: {
    id: string;
    reference_id: string;
    interval: string;
    interval_count: number;
    total_recurrence: number | null;
    anchor_date: string;
    retry_interval: string;
    retry_interval_count: number;
    total_retry: number;
    failed_attempt_notifications: number[];
  };
  immediate_action_type: string;
  notification_config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  description?: string;
  actions: Array<{
    url: string;
    action: string;
    method: string;
    url_type: string;
  }>;
  success_return_url?: string;
  items: unknown[] | null;
  payment_link_for_failed_attempt: boolean;
  failure_code: string | null;
  [key: string]: unknown;
}

/**
 * Payload for creating a Xendit recurring plan (fixed-amount subscription).
 */
export interface CreateXenditRecurringPlanParams {
  referenceId: string;
  customerId: string;
  amountIdr: number;
  description: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  metadata?: Record<string, string>;
  /** When to start charging (ISO 8601). Omit to charge immediately. */
  anchorDate?: string;
  /** Total number of recurrences. Null = indefinite. */
  totalRecurrence?: number | null;
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

// ─── Customer API ──────────────────────────────────────────────────────

/**
 * Creates a Xendit Customer (required before creating a recurring plan).
 *
 * @param params - Customer fields
 * @returns Created customer object
 *
 * @see https://developers.xendit.co/api-reference/#create-customer
 */
export async function createXenditCustomer(
  params: CreateXenditCustomerParams
): Promise<XenditCustomer> {
  const body = {
    reference_id: params.referenceId,
    given_names: params.givenNames,
    email: params.email,
    mobile_number: params.mobileNumber,
    metadata: params.metadata ?? {},
  };

  const response = await fetch(XENDIT_CUSTOMER_API, {
    method: "POST",
    headers: getXenditHeaders(),
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as XenditCustomer & {
    error_code?: string;
    message?: string;
  };

  if (!response.ok) {
    const message = payload.message || payload.error_code || response.statusText;
    throw new Error(`Xendit create customer failed (${response.status}): ${message}`);
  }

  return payload;
}

// ─── Recurring Plans API ────────────────────────────────────────────────

/**
 * Creates a Xendit fixed-amount recurring plan (subscription).
 *
 * Returns the plan with an `actions` array containing the redirect URL for
 * the user to link their payment method — single redirect flow.
 *
 * @param params - Recurring plan fields
 * @returns Created plan including `actions[].url` for user redirect
 *
 * @see https://developers.xendit.co/api-reference/#create-recurring-plan
 */
export async function createXenditRecurringPlan(
  params: CreateXenditRecurringPlanParams
): Promise<XenditRecurringPlan> {
  const body: Record<string, unknown> = {
    reference_id: params.referenceId,
    customer_id: params.customerId,
    recurring_action: "PAYMENT",
    currency: "IDR",
    amount: params.amountIdr,
    schedule: {
      reference_id: `sch-${params.referenceId}`,
      interval: "MONTH",
      interval_count: 1,
      total_recurrence: params.totalRecurrence ?? null,
      anchor_date: params.anchorDate ?? new Date().toISOString(),
      retry_interval: "DAY",
      retry_interval_count: 1,
      total_retry: 3,
      failed_attempt_notifications: [1, 3],
    },
    notification_config: {
      locale: "en",
      recurring_created: ["WHATSAPP", "EMAIL"],
      recurring_succeeded: ["WHATSAPP", "EMAIL"],
      recurring_failed: ["WHATSAPP", "EMAIL"],
    },
    failed_cycle_action: "STOP",
    immediate_action_type: "FULL_AMOUNT",
    payment_link_for_failed_attempt: true,
    metadata: params.metadata ?? {},
    description: params.description,
    success_return_url: params.successRedirectUrl,
    failure_return_url: params.failureRedirectUrl,
  };

  const response = await fetch(XENDIT_RECURRING_API, {
    method: "POST",
    headers: getXenditHeaders(),
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as XenditRecurringPlan & {
    error_code?: string;
    message?: string;
  };

  if (!response.ok) {
    const message = payload.message || payload.error_code || response.statusText;
    throw new Error(`Xendit create recurring plan failed (${response.status}): ${message}`);
  }

  if (!payload.actions || payload.actions.length === 0) {
    throw new Error("Xendit recurring plan response missing actions — payment method linking URL required");
  }

  return payload;
}

/**
 * Deactivates a Xendit recurring plan (cancels subscription).
 *
 * @param planId - The Xendit recurring plan ID (repl_xxx)
 *
 * @see https://developers.xendit.co/api-reference/#deactivate-recurring-plan
 */
export async function deactivateXenditPlan(planId: string): Promise<void> {
  const response = await fetch(`${XENDIT_RECURRING_API}/${planId}/deactivate`, {
    method: "POST",
    headers: getXenditHeaders(),
  });

  const payload = (await response.json()) as {
    error_code?: string;
    message?: string;
  };

  if (!response.ok) {
    const message = payload.message || payload.error_code || response.statusText;
    throw new Error(`Xendit deactivate plan failed (${response.status}): ${message}`);
  }
}

// ─── Invoice API ────────────────────────────────────────────────────────

/**
 * Creates a Xendit Invoice and returns the hosted checkout URL.
 *
 * @param params - Invoice fields
 * @returns Created invoice including `invoice_url`
 */
export async function createXenditInvoice(
  params: CreateXenditInvoiceParams
): Promise<XenditInvoice> {
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
    headers: getXenditHeaders(),
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
