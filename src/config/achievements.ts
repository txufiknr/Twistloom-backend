import type { AchievementRule } from "../types/achievements.js";

/**
 * Single Source of Truth (SSOT) for Twistloom's Achievement System.
 * 
 * Defines all unlockable badges, thresholds, and tier classifications.
 * Evaluated instantly against the `user_counters` table.
 * 
 * Achievements:
 * - Books Generated: 50 > 100 > 500
 * - Books Completed: 50 > 100 > 500
 * - Pages Read: 500 > 2000 > 5000 > 10000
 * - Branches Opened: 50 > 100 > 500
 * - Credits Top-Up: 500 > 2000 > 5000 > 10000
 * - Referred Users: 50 > 100 > 500
 * - Followers Count: 500 > 5000 > 50000
 * - Check-in Streak: 30 > 90 > 365
 */
export const ACHIEVEMENT_REGISTRY: AchievementRule[] = [
  // --- BOOKS GENERATED ---
  { id: 'gen_50', title: 'Story Weaver', description: 'Generated 50 branching books', metric: 'booksGenerated', threshold: 50, badgeImageUrl: 'badge_gen_bronze', tier: 'bronze' },
  { id: 'gen_100', title: 'Architect of Fear', description: 'Generated 100 branching books', metric: 'booksGenerated', threshold: 100, badgeImageUrl: 'badge_gen_silver', tier: 'silver' },
  { id: 'gen_500', title: 'The Loom Master', description: 'Generated 500 branching books', metric: 'booksGenerated', threshold: 500, badgeImageUrl: 'badge_gen_gold', tier: 'gold' },

  // --- BOOKS COMPLETED ---
  { id: 'comp_50', title: 'Survivor', description: 'Survived 50 storylines', metric: 'booksCompleted', threshold: 50, badgeImageUrl: 'badge_comp_bronze', tier: 'bronze' },
  { id: 'comp_100', title: 'Fate Sealed', description: 'Survived 100 storylines', metric: 'booksCompleted', threshold: 100, badgeImageUrl: 'badge_comp_silver', tier: 'silver' },
  { id: 'comp_500', title: 'Defier of Death', description: 'Survived 500 storylines', metric: 'booksCompleted', threshold: 500, badgeImageUrl: 'badge_comp_platinum', tier: 'platinum' },

  // --- PAGES READ ---
  { id: 'read_500', title: 'Voracious Reader', description: 'Explored 500 pages of terror', metric: 'pagesRead', threshold: 500, badgeImageUrl: 'badge_read_bronze', tier: 'bronze' },
  { id: 'read_2000', title: 'Insatiable Curiosity', description: 'Explored 2,000 pages of terror', metric: 'pagesRead', threshold: 2000, badgeImageUrl: 'badge_read_silver', tier: 'silver' },
  { id: 'read_5000', title: 'Lore Keeper', description: 'Explored 5,000 pages of terror', metric: 'pagesRead', threshold: 5000, badgeImageUrl: 'badge_read_gold', tier: 'gold' },
  { id: 'read_10000', title: 'The Abyss Stares Back', description: 'Explored 10,000 pages of terror', metric: 'pagesRead', threshold: 10000, badgeImageUrl: 'badge_read_platinum', tier: 'platinum' },

  // --- BRANCHES OPENED ---
  { id: 'branch_50', title: 'Crossroads', description: 'Opened 50 alternate choice pathways', metric: 'branchesOpened', threshold: 50, badgeImageUrl: 'badge_branch_bronze', tier: 'bronze' },
  { id: 'branch_100', title: 'Reality Bender', description: 'Opened 100 alternate choice pathways', metric: 'branchesOpened', threshold: 100, badgeImageUrl: 'badge_branch_silver', tier: 'silver' },
  { id: 'branch_500', title: 'Fractured Timeline', description: 'Opened 500 alternate choice pathways', metric: 'branchesOpened', threshold: 500, badgeImageUrl: 'badge_branch_gold', tier: 'gold' },

  // --- CREDITS TOP-UP ---
  { id: 'topup_500', title: 'Investigator', description: 'Acquired 500 credits', metric: 'topupCredits', threshold: 500, badgeImageUrl: 'badge_credits_bronze', tier: 'bronze' },
  { id: 'topup_2000', title: 'Patron of the Dark', description: 'Acquired 2,000 credits', metric: 'topupCredits', threshold: 2000, badgeImageUrl: 'badge_credits_silver', tier: 'silver' },
  { id: 'topup_5000', title: 'High Roller', description: 'Acquired 5,000 credits', metric: 'topupCredits', threshold: 5000, badgeImageUrl: 'badge_credits_gold', tier: 'gold' },
  { id: 'topup_10000', title: 'The Benefactor', description: 'Acquired 10,000 credits', metric: 'topupCredits', threshold: 10000, badgeImageUrl: 'badge_credits_platinum', tier: 'platinum' },

  // --- REFERRED USERS ---
  { id: 'ref_50', title: 'Cultist', description: 'Brought 50 new souls to the Loom', metric: 'referredUsers', threshold: 50, badgeImageUrl: 'badge_ref_bronze', tier: 'bronze' },
  { id: 'ref_100', title: 'Harbinger', description: 'Brought 100 new souls to the Loom', metric: 'referredUsers', threshold: 100, badgeImageUrl: 'badge_ref_silver', tier: 'silver' },
  { id: 'ref_500', title: 'Cult Leader', description: 'Brought 500 new souls to the Loom', metric: 'referredUsers', threshold: 500, badgeImageUrl: 'badge_ref_platinum', tier: 'platinum' },

  // --- FOLLOWERS COUNT ---
  { id: 'fol_500', title: 'Local Legend', description: 'Gathered 500 followers', metric: 'followersCount', threshold: 500, badgeImageUrl: 'badge_fol_bronze', tier: 'bronze' },
  { id: 'fol_5000', title: 'Infamous', description: 'Gathered 5,000 followers', metric: 'followersCount', threshold: 5000, badgeImageUrl: 'badge_fol_silver', tier: 'silver' },
  { id: 'fol_50000', title: 'Dark Icon', description: 'Gathered 50,000 followers', metric: 'followersCount', threshold: 50000, badgeImageUrl: 'badge_fol_platinum', tier: 'platinum' },

  // --- CHECK-IN STREAK ---
  { id: 'streak_30', title: 'A Month in the Shadows', description: 'Maintained a 30-day check-in streak', metric: 'maxCheckinStreak', threshold: 30, badgeImageUrl: 'badge_streak_bronze', tier: 'bronze' },
  { id: 'streak_90', title: 'Relentless', description: 'Maintained a 90-day check-in streak', metric: 'maxCheckinStreak', threshold: 90, badgeImageUrl: 'badge_streak_silver', tier: 'silver' },
  { id: 'streak_365', title: 'Eternal Witness', description: 'Maintained a 365-day check-in streak', metric: 'maxCheckinStreak', threshold: 365, badgeImageUrl: 'badge_streak_platinum', tier: 'platinum' },
];