/**
 * Notification Taxonomy & Localization Configuration
 * @overview Machine keys and taxonomies for the notification system
 */

export const NOTIFICATION_TYPES = [
  'payment_success',
  'refund',
  'first_purchase_bonus',
  'referral_bonus',
  'trial_ending_soon',
  'thanks_received',
  'thanks_reply',
  'wall_post_reaction',
  'wall_post_reply',
  'wall_post_incoming',
  'story_published',
  'ai_completed',
  'ai_failed',
  'testimonial_like',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_I18N_KEYS = {
  PAYMENT_SUCCESS: 'notification.paymentSuccess',
  REFUND_PROCESSED: 'notification.refundProcessed',
  FIRST_PURCHASE_BONUS: 'notification.firstPurchaseBonus',
  REFERRAL_VIP_BONUS: 'notification.referralVipBonus',
  REFERRAL_STANDARD_BONUS: 'notification.referralStandardBonus',
  REFERRAL_WELCOME_BONUS: 'notification.referralWelcomeBonus',
  TRIAL_ENDING_SOON: 'notification.trialEndingSoon',
  STORY_PUBLISHED: 'notification.storyPublished',
  AI_STORY_COMPLETED: 'notification.aiStoryCompleted',
  AI_STORY_FAILED: 'notification.aiStoryFailed',
  TESTIMONIAL_LIKE_SINGLE: 'notification.testimonialLikeSingle',
  TESTIMONIAL_LIKE_MULTIPLE: 'notification.testimonialLikeMultiple',
  THANKS_RECEIVED: 'notification.thanksReceived',
  THANKS_REPLY: 'notification.thanksReply',
  WALL_POST_REACTION: 'notification.wallPostReaction',
  WALL_POST_REPLY: 'notification.wallPostReply',
  WALL_POST_INCOMING: 'notification.wallPostIncoming',
} as const;

export type NotificationI18nKey = (typeof NOTIFICATION_I18N_KEYS)[keyof typeof NOTIFICATION_I18N_KEYS];
