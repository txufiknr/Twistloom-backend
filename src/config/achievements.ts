import type { AchievementRule } from "../types/achievements.js";

export const ACHIEVEMENT_REGISTRY: AchievementRule[] = [
  {
    id: 'gen_50',
    title: 'Master Weaver',
    description: 'Generated 50 branching thriller books',
    metric: 'booksGenerated',
    threshold: 50,
    badgeIcon: 'badge_weaver_gold',
    tier: 'gold'
  },
  {
    id: 'complete_50',
    title: 'Fate Sealed',
    description: 'Completed 50 branching thriller storylines',
    metric: 'booksCompleted',
    threshold: 50,
    badgeIcon: 'badge_completion_gold',
    tier: 'gold'
  },
  {
    id: 'read_500',
    title: 'Voracious Reader',
    description: 'Explored 500 pages across the dark loom',
    metric: 'pagesRead',
    threshold: 500,
    badgeIcon: 'badge_reader_silver',
    tier: 'silver'
  },
  {
    id: 'branches_500',
    title: 'Reality Bender',
    description: 'Opened 500 alternate choice pathways',
    metric: 'branchesOpened',
    threshold: 500,
    badgeIcon: 'badge_branch_platinum',
    tier: 'platinum'
  }
];