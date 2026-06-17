export type AchievementMetric = 'booksGenerated' | 'booksCompleted' | 'pagesRead' | 'branchesOpened';
export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';

export type AchievementRule = {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  badgeIcon: string; // Asset key or image URL
  tier: AchievementTier;
};