export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type AchievementMetric = 
  | 'booksGenerated' 
  | 'booksCompleted' 
  | 'pagesRead' 
  | 'branchesOpened'
  | 'topupCredits'
  | 'referredUsers'
  | 'followersCount'
  | 'maxCheckinStreak';

export interface AchievementRule {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  badgeIcon: string;
  tier: AchievementTier;
}