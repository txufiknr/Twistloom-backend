import type { AchievementTier } from "./achievements.js";

/**
 * Union type of all possible gender values
 * 
 * Generated from the genders array to ensure type safety
 * and autocomplete support for gender selection.
 */
export const genders = [ 'male', 'female', 'unknown' ] as const;
export type Gender = typeof genders[number];
export type KnownGender = Omit<Gender, 'unknown'>

export const avatarFrames = ['bronze', 'silver', 'gold', 'platinum'] as const;
export type AvatarFrame = typeof avatarFrames[number];

/**
 * Union type of all possible user source values
 * 
 * Used during user onboarding to track where the user discovered the platform.
 */
export const sources = ['social_media', 'friend', 'google', 'advertisement', 'other'] as const;
export type Source = typeof sources[number];

export const feedbackCategories = ['feedback', 'bug_report', 'feature_request', 'other'] as const;
export type FeedbackCategory = typeof feedbackCategories[number];

export const feedbackStatuses = ['idle', 'submitting', 'success', 'error'] as const;
export type FeedbackStatus = typeof feedbackStatuses[number];

/** Admin resolution workflow — separate from user submission `status`. */
export const feedbackAdminStatuses = ['unread', 'read', 'solved'] as const;
export type FeedbackAdminStatus = typeof feedbackAdminStatuses[number];

/**
 * Union type of all possible like target types
 * 
 * Used for user likes system to type-safe target identification.
 */
export const likeTargetTypes = [ 'book', 'page', 'comment', 'user' ] as const;
export type LikeTargetType = typeof likeTargetTypes[number];

/**
 * User statistics for profile display
 */
export interface UserStats {
  readsCount: number;
  likedBooksCount: number;
  savedBooksCount: number;
  likesReceived: number;
  accountDaysOld: number;
  emailVerified: Date | null;
  havePurchased: boolean;

  // Denormalized counters from the `user_counters` table (single source of truth)
  // These are included so callers can read SSOT fields directly when available.
  booksGenerated: number;
  booksCompleted: number;
  pagesRead: number;
  pagesGenerated: number;
  branchesOpened: number;
  topupCredits: number;
  referredUsers: number;
  followersCount: number;
  followingCount: number;
  commentsCount: number;
  customActionsWritten: number;
  activeCheckinStreak: number;
  maxCheckinStreak: number;
}

export type UserTier = 'standard' | 'vip';

export interface UserSubscription {
  tier: UserTier | null;
}

export interface User {
  id: string;
  email?: string;
  username: string;
  name: string;
  bio: string | null;
  imageUrl: string | null;
  avatarFrame: string | null;
  gender: Gender | null;
  source: Source | null;
  lastActive: Date;
  isNewUser: boolean;
  /**
   * Whether a referrer is already recorded (referrer_id set).
   * Own profile (GET /user) only — omit on public profiles.
   */
  hasReferrer?: boolean;
  /**
   * Account / app language of record (`en` | `id`).
   * Own profile (GET /user) — used for email locale resolution default.
   */
  preferredLocale?: string;
  stats: UserStats;
  subscription: UserSubscription;
  credits: number;
  /** GDPR: timestamp of when the user accepted the Terms of Service */
  termsAcceptedAt: Date | null;
  /** GDPR: version of Terms of Service that was accepted (e.g. "2025-01-15") */
  termsVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Whether the authenticated viewer follows this user (only set on public profile view) */
  isFollowing?: boolean;
  /** Whether the authenticated viewer has blocked this user (only set on public profile view) */
  isBlocked?: boolean;
  /** Whether this user is banned (moderation state; used to noindex their profile) */
  isBanned?: boolean;
  /** Whether this user is a member of the beta tester program (one-time join + reward) */
  isBetaTester?: boolean;
}

export type UserActivityType =
  'workflow_triggered' |
  'book_creation_started' |
  'book_created' |
  'liked' |
  'favorited' |
  'commented' |
  'followed' |
  'credits_consumed' |
  'credits_added' |
  'session_updated' |
  'onboarding_complete' |
  'referrer_set' |
  'shared_ending' |
  'beta_tester_joined' |
  'quest_completed' |
  'quest_reward_claimed';

export type CheckinClaimType = 'regular' | 'vip_2x';

export interface CheckinRecord {
  checkInDate: string; // YYYY-MM-DD
  creditsClaimed: number;
  createdAt: Date;
}

export interface CheckinPostResponse {
  success: boolean;
  creditsAwarded: number;
  checkInDate: string;
  message: string;
  currentStreak: number;
  totalCreditsClaimed: number;
}

export interface CheckinStatusResponse {
  canCheckIn: boolean;
  lastCheckInDate: string | null;
  totalCheckIns: number;
  totalCreditsClaimed: number;
  currentStreak: number;
  longestStreak: number;
  /** 0-based grid slot index for today's position in the cycle (0-6). */
  todayCycleDay: number;
  recentCheckIns: CheckinRecord[];
  isVip: boolean;
  regularClaimAmount: number;
  vipClaimAmount: number;
  claimedRewards: CheckinClaimType[];
}

export type UserComment = {
  id: string;
  userId: string;
  name: string;
  imageUrl: string;
  bookId: string;
  pageId?: string;
  paragraphNumber?: number;
  parentCommentId?: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export type UserAchievement = {
  id: string;
  title: string;
  description: string;
  badgeImageUrl: string;
  tier: AchievementTier;
  currentProgress: number;
  threshold: number;
  progressPercent: number;
  isUnlocked: boolean;
  unlockedAt: Date | null;
  isNotified: boolean;
};

export type EnrichedUserSelect = Omit<User, 'stats' | 'subscription' | 'isFollowing' | 'isBlocked' | 'hasReferrer'> & UserStats & UserSubscription & {
  hasReferrer: boolean;
  isBanned: boolean;
};