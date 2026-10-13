/** Shared delivery contract. Provider acceptance does not imply inbox delivery. */
export type EmailType = "verification" | "password_reset" | "password_changed" | "email_changed" | "account_deleted"
  | "welcome" | "trial_ending" | "payment_failed" | "refund" | "subscription_canceled"
  | "feedback_ack" | "feedback_internal" | "weekly" | "monthly" | "announcement" | "story_published";
export type EmailMessageStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "needs_review";
export type EmailCampaignStatus = "queued" | "running" | "completed" | "completed_with_errors";
export interface EmailTemplate { from: string; subject: string; html: string }
export interface EmailPayload extends EmailTemplate { to: string }
export type EmailAudience =
  | { kind: "announcement" }
  | { kind: "weekly"; books: Array<{ title: string; url: string }> }
  | { kind: "monthly"; start: string; end: string; label: string }
  | { kind: "story_published"; authorId: string; authorName: string; bookId: string; bookSlug: string; bookTitle: string };
export type EmailSendResult =
  | { kind: "accepted"; providerId: string }
  | { kind: "retry"; ambiguous: boolean; code: string }
  | { kind: "paused"; code: "daily_quota_exceeded" | "monthly_quota_exceeded" | "rate_limit_exceeded" | "provider_configuration"; retryAt: Date }
  | { kind: "failed" | "needs_review"; code: string };
export interface EmailDeliveryResult { messageId: string; status: EmailMessageStatus }
