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
  booksCount: number;
  readsCount: number;
  likedBooksCount: number;
  savedBooksCount: number;
  followersCount: number;
  likesReceived: number;
  accountDaysOld: number;
  emailVerified: Date | null;
  havePurchased: boolean;
}

export type UserTier = 'standard' | 'vip';

export interface User {
  id: string;
  email: string | null;
  username: string | null;
  name: string | null;
  bio: string | null;
  image: string | null;
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
  userName: string;
  userImage: string;
  bookId: string;
  parentCommentId?: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}