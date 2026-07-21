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
  gender: Gender | null;
  source: Source | null;
  lastActive: Date;
  isNewUser: boolean;
  stats: UserStats;
  subscription: UserSubscription;
  credits: number;
  createdAt: Date;
  updatedAt: Date;
  /** Whether the authenticated viewer follows this user (only set on public profile view) */
  isFollowing?: boolean;
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
  'shared_ending';

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

export type EnrichedUserSelect = Omit<User, 'stats' | 'subscription' | 'isFollowing'> & UserStats & UserSubscription;