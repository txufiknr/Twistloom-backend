export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'mythic';

export type AchievementCategory =
  | 'multiverse'
  | 'explorer'
  | 'seeker'
  | 'survivor'
  | 'chronicler'
  | 'legacy';

export type AchievementMetric = 
  // --- Existing 15 Vanity / Platform Metrics ---
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
  | 'endingsSharedToWall'
  // --- Narrative-Native Exploration Metrics ---
  | 'storiesCompleted'
  | 'alternateEndingsDiscovered'
  | 'deepBranchCompletions'
  | 'distinctEndingTypesReached'
  | 'rareEndingsFound'
  | 'branchPointsExplored'
  | 'highRiskChoicesTaken'
  | 'cluesUncovered'
  | 'threadsResolved'
  | 'consequenceExperienced';

export interface AchievementRule {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  tier: AchievementTier;
  category: AchievementCategory;
}
