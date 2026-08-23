/**
 * Email Templates Index
 *
 * Centralised barrel export for all transactional email template functions.
 * Every template uses the shared `buildEmailHtml` layout for visual consistency.
 */

export { getPasswordResetTemplate } from './password-reset.js';
export { getVerificationTemplate } from './verification.js';
export { getWelcomeTemplate } from './welcome.js';
export { getTrialEndingTemplate } from './trial-ending.js';
export { getFeedbackAcknowledgmentTemplate } from './feedback-acknowledgment.js';
export { getPasswordChangedTemplate } from './password-changed.js';
export { getEmailChangedTemplate } from './email-changed.js';
export { getAccountDeletedTemplate } from './account-deleted.js';
export { getPaymentFailedTemplate } from './payment-failed.js';
export { getRefundProcessedTemplate } from './refund-processed.js';
export { getSubscriptionCanceledTemplate } from './subscription-canceled.js';
export { getFeedbackInternalTemplate } from './feedback-internal.js';
export { getWeeklyRecommendationsTemplate } from './weekly-recommendations.js';
export { getMonthlyActivityTemplate } from './monthly-activity.js';
export { getAnnouncementTemplate } from './announcement.js';
export { getStoryPublishedTemplate } from './story-published.js';

export type { FeedbackInternalTemplateParams } from './feedback-internal.js';
export type { RecommendedBookEmailItem } from './weekly-recommendations.js';
export type { MonthlyActivityStats } from './monthly-activity.js';
