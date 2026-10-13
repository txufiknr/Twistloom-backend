import type { EmailCampaignStatus } from "./email-delivery.js";

/** Safe admin status projection; never exposes recipient email addresses. */
export interface AnnouncementEmailJob {
  jobId: string;
  status: EmailCampaignStatus;
  title: string;
  recipientCount: number;
  sent: number;
  failed: number;
  skipped: number;
  needsReview: number;
  audienceComplete: boolean;
}
