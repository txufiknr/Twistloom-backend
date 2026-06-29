export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type AchievementMetric = 
  | 'booksGenerated'
  | 'booksCompleted'
  | 'pagesRead'
  | 'pagesGenerated'
  | 'branchesOpened'
  | 'topupCredits'
  | 'referredUsers'
  | 'followersCount'
  | 'maxCheckinStreak'
  | 'customActionsWritten';

export interface AchievementRule {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  badgeImageUrl: string;
  tier: AchievementTier;
}