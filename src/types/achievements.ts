export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';

export type AchievementCategory =
  | 'multiverse'
  | 'explorer'
  | 'archetypes'
  | 'peril'
  | 'seeker'
  | 'investigator'
  | 'survivor'
  | 'chronicler'
  | 'causality'
  | 'subterranean'
  | 'legacy';

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
  | 'customActionsWritten'
  | 'easterEggsFound'
  | 'creatorsSupported'
  | 'wallNotesPosted'
  | 'wallNoteLikesReceived'
  | 'endingsSharedToWall';

export interface AchievementRule {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  tier: AchievementTier;
  category: AchievementCategory;
}
