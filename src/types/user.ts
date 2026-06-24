import type { AchievementTier } from "./achievements.js";

export const genders = [
  'male', 'female', 'unknown'
] as const;

/**
 * Union type of all possible gender values
 * 
 * Generated from the genders array to ensure type safety
 * and autocomplete support for gender selection.
 */
export type Gender = typeof genders[number];

export type KnownGender = Omit<Gender, 'unknown'>

/**
 * Union type of all possible like target types
 * 
 * Used for user likes system to type-safe target identification.
 */
export const likeTargetTypes = [
  'book', 'page', 'comment', 'user'
] as const;

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
  branchesOpened: number;
  topupCredits: number;
  referredUsers: number;
  followersCount: number;
  activeCheckinStreak: number;
  maxCheckinStreak: number;
}

export type UserTier = 'standard' | 'vip';

export interface User {
  id: string;
  email: string | null;
  username: string | null;
  name: string | null;
  bio: string | null;
  imageUrl: string | null;
  stats: UserStats;
  tier: UserTier | null;
  credits: number;
  createdAt: Date;
  updatedAt: Date;
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
  'referrer_set';

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
  nextClaimAmount: number;
  recentCheckIns: CheckinRecord[];
  isVip: boolean;
  regularClaimAmount: number;
  vipClaimAmount: number;
}

export type UserComment = {
  id: string;
  userId: string;
  name: string;
  imageUrl: string;
  bookId: string;
  parentCommentId?: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export type UserAchievement = {
  id: string;
  title: string;
  description: string;
  badgeIcon: string;
  tier: AchievementTier;
  currentProgress: number;
  threshold: number;
  progressPercent: number;
  isUnlocked: boolean;
  unlockedAt: Date | null;
  isNotified: boolean;
};