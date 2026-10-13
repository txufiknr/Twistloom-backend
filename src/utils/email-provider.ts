/** The sole Resend sending adapter. EMAIL_DELIVERY_ARCHITECTURE.md §6. */
import type { EmailTemplate, EmailSendResult } from "../types/email-delivery.js";
export type { EmailSendResult } from "../types/email-delivery.js";
import { EMAIL_PROVIDER_TIMEOUT_MS } from "../config/email-delivery.js";


/** Only allowlisted error names leave this boundary; provider messages can contain PII. */
async function providerErrorName(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "name" in body && typeof body.name === "string" ? body.name : null;
  } catch { return null; }
}

export function emailProviderRetryAt(response: Response, fallbackMs: number, now = new Date()): Date {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    const timestamp = Number.isFinite(seconds) ? now.getTime() + seconds * 1000 : Date.parse(raw);
    if (Number.isFinite(timestamp) && timestamp > now.getTime()) return new Date(timestamp);
  }
  return new Date(now.getTime() + fallbackMs);
}

/** Never logs recipients. A timeout is ambiguous, not a definitive failed delivery. */
export async function sendProviderEmail(template: EmailTemplate, to: string,
  idempotencyKey: string): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { kind: "retry", ambiguous: false, code: "provider_not_configured" };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...template, to }),
      signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const name = await providerErrorName(response);
      if (name === "daily_quota_exceeded") {
        const now = new Date();
        return { kind: "paused", code: name, retryAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) };
      }
      // Monthly billing reset dates vary. A single bounded probe checks for recovery or a plan upgrade.
      if (name === "monthly_quota_exceeded") return { kind: "paused", code: name, retryAt: emailProviderRetryAt(response, 3600_000) };
      return { kind: "paused", code: "rate_limit_exceeded", retryAt: emailProviderRetryAt(response, 30_000) };
    }
    if (response.status >= 500) return { kind: "retry", ambiguous: true, code: "provider_unavailable" };
    if (response.status === 409) {
      const name = await providerErrorName(response);
      if (name === "concurrent_idempotent_requests") return { kind: "retry", ambiguous: true, code: name };
      if (name === "resource_locked") return { kind: "retry", ambiguous: false, code: name };
      return { kind: "needs_review", code: "provider_idempotency_conflict" };
    }
    if (response.status === 401 || response.status === 403) return { kind: "paused", code: "provider_configuration", retryAt: new Date(Date.now() + 300_000) };
    if (!response.ok) return { kind: "failed", code: `provider_http_${response.status}` };
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "id" in body && typeof body.id === "string") {
      return { kind: "accepted", providerId: body.id };
    }
    return { kind: "retry", ambiguous: true, code: "provider_invalid_response" };
  } catch {
    return { kind: "retry", ambiguous: true, code: "provider_network_ambiguous" };
  }
}
