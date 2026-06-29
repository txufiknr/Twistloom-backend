import type { AchievementRule } from "../types/achievements.js";

/**
 * Single Source of Truth (SSOT) for Twistloom's Achievement System.
 *
 * Every metric has exactly FOUR tiers: bronze → silver → gold → platinum.
 * Evaluated server-side against `user_counters` on every counter increment.
 *
 * Metric → Source table / event
 *  booksGenerated       books                 (INSERT / DELETE)
 *  booksCompleted       user_completed_books  (INSERT / DELETE)
 *  pagesRead            user_page_progress    (INSERT / DELETE)
 *  branchesOpened       pages                 (INSERT, distinct branch_id)
 *  topupCredits         transactions          (INSERT, type = 'purchase')
 *  referredUsers        users                 (INSERT, referrer_id IS NOT NULL)
 *  followersCount       user_follows          (INSERT / DELETE, tracks following_id)
 *  maxCheckinStreak     user_checkins         (INSERT, consecutive-day logic)
 *  customActionsWritten custom_actions        (INSERT, outcome = 'allow')  ← NEW
 */
export const ACHIEVEMENT_REGISTRY: AchievementRule[] = [

  // ── BOOKS GENERATED ────────────────────────────────────────────────────────
  {
    id: 'gen_50',
    title: 'Story Weaver',
    description: 'Wove 50 branching worlds into the Loom',
    metric: 'booksGenerated', threshold: 50,
    badgeImageUrl: 'badge_gen_bronze', tier: 'bronze',
  },
  {
    id: 'gen_100',
    title: 'Architect of Fear',
    description: 'Constructed 100 labyrinthine horrors the mind cannot unsee',
    metric: 'booksGenerated', threshold: 100,
    badgeImageUrl: 'badge_gen_silver', tier: 'silver',
  },
  {
    id: 'gen_250',
    title: 'The Chronicler',
    description: 'Chronicled 250 descents into the dark — each one uniquely damning',
    metric: 'booksGenerated', threshold: 250,
    badgeImageUrl: 'badge_gen_gold', tier: 'gold',
  },
  {
    id: 'gen_500',
    title: 'The Loom Master',
    description: 'Summoned 500 worlds from nothing. The dark listens when you speak.',
    metric: 'booksGenerated', threshold: 500,
    badgeImageUrl: 'badge_gen_platinum', tier: 'platinum',
  },

  // ── BOOKS COMPLETED ────────────────────────────────────────────────────────
  {
    id: 'comp_50',
    title: 'Still Breathing',
    description: 'Survived 50 harrowing storylines. So far.',
    metric: 'booksCompleted', threshold: 50,
    badgeImageUrl: 'badge_comp_bronze', tier: 'bronze',
  },
  {
    id: 'comp_100',
    title: 'Fate Sealed',
    description: 'Sealed the fate of 100 narratives with your choices',
    metric: 'booksCompleted', threshold: 100,
    badgeImageUrl: 'badge_comp_silver', tier: 'silver',
  },
  {
    id: 'comp_250',
    title: 'Defier of Death',
    description: 'Defied oblivion across 250 completed storylines. It keeps missing.',
    metric: 'booksCompleted', threshold: 250,
    badgeImageUrl: 'badge_comp_gold', tier: 'gold',
  },
  {
    id: 'comp_500',
    title: 'Beyond the Abyss',
    description: 'Emerged from 500 storylines. Something came back with you.',
    metric: 'booksCompleted', threshold: 500,
    badgeImageUrl: 'badge_comp_platinum', tier: 'platinum',
  },

  // ── PAGES READ ─────────────────────────────────────────────────────────────
  {
    id: 'read_500',
    title: 'Voracious Reader',
    description: 'Devoured 500 pages of unspeakable terror',
    metric: 'pagesRead', threshold: 500,
    badgeImageUrl: 'badge_read_bronze', tier: 'bronze',
  },
  {
    id: 'read_2000',
    title: 'Insatiable Curiosity',
    description: 'Consumed 2,000 pages the sane turn away from',
    metric: 'pagesRead', threshold: 2000,
    badgeImageUrl: 'badge_read_silver', tier: 'silver',
  },
  {
    id: 'read_5000',
    title: 'Lore Keeper',
    description: 'Absorbed 5,000 pages of forbidden knowledge. Some cannot be unlearned.',
    metric: 'pagesRead', threshold: 5000,
    badgeImageUrl: 'badge_read_gold', tier: 'gold',
  },
  {
    id: 'read_10000',
    title: 'The Abyss Stares Back',
    description: '10,000 pages into the dark. It has learned your name.',
    metric: 'pagesRead', threshold: 10000,
    badgeImageUrl: 'badge_read_platinum', tier: 'platinum',
  },

  // ── PAGES GENERATED ───────────────────────────────────────────────────────
  {
    id: 'page_50',
    title: 'Ink Starter',
    description: 'Drafted 50 pages of your own haunting narrative',
    metric: 'pagesGenerated', threshold: 50,
    badgeImageUrl: 'badge_page_bronze', tier: 'bronze',
  },
  {
    id: 'page_100',
    title: 'Page Turner',
    description: 'Spun 100 pages into existence. The Loom keeps asking for more.',
    metric: 'pagesGenerated', threshold: 100,
    badgeImageUrl: 'badge_page_silver', tier: 'silver',
  },
  {
    id: 'page_250',
    title: 'Wordsmith of the Void',
    description: 'Crafted 250 pages from shadow and silence. Even the dark is impressed.',
    metric: 'pagesGenerated', threshold: 250,
    badgeImageUrl: 'badge_page_gold', tier: 'gold',
  },
  {
    id: 'page_500',
    title: 'Master of the Manuscript',
    description: 'Generated 500 pages. The story is no longer yours alone.',
    metric: 'pagesGenerated', threshold: 500,
    badgeImageUrl: 'badge_page_platinum', tier: 'platinum',
  },

  // ── BRANCHES OPENED ────────────────────────────────────────────────────────
  {
    id: 'branch_50',
    title: 'Crossroads',
    description: 'Stepped off the beaten path 50 times',
    metric: 'branchesOpened', threshold: 50,
    badgeImageUrl: 'badge_branch_bronze', tier: 'bronze',
  },
  {
    id: 'branch_100',
    title: 'Reality Bender',
    description: 'Fractured reality across 100 alternate choice pathways',
    metric: 'branchesOpened', threshold: 100,
    badgeImageUrl: 'badge_branch_silver', tier: 'silver',
  },
  {
    id: 'branch_250',
    title: 'Fractured Timeline',
    description: 'Shattered the timeline across 250 divergences. Each fork is a different you.',
    metric: 'branchesOpened', threshold: 250,
    badgeImageUrl: 'badge_branch_gold', tier: 'gold',
  },
  {
    id: 'branch_500',
    title: 'Parallel Haunting',
    description: 'Haunting 500 parallel timelines simultaneously. Which one is the real you?',
    metric: 'branchesOpened', threshold: 500,
    badgeImageUrl: 'badge_branch_platinum', tier: 'platinum',
  },

  // ── CREDITS TOP-UP ─────────────────────────────────────────────────────────
  {
    id: 'topup_500',
    title: 'Shadow Investor',
    description: 'Poured 500 credits into the dark machinery of the Loom',
    metric: 'topupCredits', threshold: 500,
    badgeImageUrl: 'badge_topup_bronze', tier: 'bronze',
  },
  {
    id: 'topup_2000',
    title: 'Patron of the Dark',
    description: 'Fed 2,000 credits to the narrative machine without flinching',
    metric: 'topupCredits', threshold: 2000,
    badgeImageUrl: 'badge_topup_silver', tier: 'silver',
  },
  {
    id: 'topup_5000',
    title: 'High Roller',
    description: 'Staked 5,000 credits on the unknown. The house always wins — or does it?',
    metric: 'topupCredits', threshold: 5000,
    badgeImageUrl: 'badge_topup_gold', tier: 'gold',
  },
  {
    id: 'topup_10000',
    title: 'The Benefactor',
    description: 'Bankrolled 10,000 credits into the Loom. The dark owes you a debt it cannot repay.',
    metric: 'topupCredits', threshold: 10000,
    badgeImageUrl: 'badge_topup_platinum', tier: 'platinum',
  },

  // ── REFERRED USERS ─────────────────────────────────────────────────────────
  {
    id: 'ref_10',
    title: 'Whisperer',
    description: 'Whispered 10 new souls toward the dark',
    metric: 'referredUsers', threshold: 10,
    badgeImageUrl: 'badge_ref_bronze', tier: 'bronze',
  },
  {
    id: 'ref_50',
    title: 'Cultist',
    description: 'Lured 50 followers into the embrace of the Loom',
    metric: 'referredUsers', threshold: 50,
    badgeImageUrl: 'badge_ref_silver', tier: 'silver',
  },
  {
    id: 'ref_100',
    title: 'Harbinger',
    description: 'Delivered 100 new souls to the narrative web',
    metric: 'referredUsers', threshold: 100,
    badgeImageUrl: 'badge_ref_gold', tier: 'gold',
  },
  {
    id: 'ref_500',
    title: 'Cult Leader',
    description: '500 devotees entered the dark at your word. They trust you with their minds.',
    metric: 'referredUsers', threshold: 500,
    badgeImageUrl: 'badge_ref_platinum', tier: 'platinum',
  },

  // ── FOLLOWERS COUNT ────────────────────────────────────────────────────────
  {
    id: 'fol_100',
    title: 'Noticed',
    description: '100 readers sense something unsettling whenever you post',
    metric: 'followersCount', threshold: 100,
    badgeImageUrl: 'badge_fol_bronze', tier: 'bronze',
  },
  {
    id: 'fol_500',
    title: 'Local Legend',
    description: '500 readers know your name with quiet, creeping dread',
    metric: 'followersCount', threshold: 500,
    badgeImageUrl: 'badge_fol_silver', tier: 'silver',
  },
  {
    id: 'fol_5000',
    title: 'Infamous',
    description: '5,000 readers watch every word you write next',
    metric: 'followersCount', threshold: 5000,
    badgeImageUrl: 'badge_fol_gold', tier: 'gold',
  },
  {
    id: 'fol_50000',
    title: 'Dark Icon',
    description: '50,000 souls orbit your shadow. You are no longer a person. You are a myth.',
    metric: 'followersCount', threshold: 50000,
    badgeImageUrl: 'badge_fol_platinum', tier: 'platinum',
  },

  // ── CHECK-IN STREAK ────────────────────────────────────────────────────────
  {
    id: 'streak_7',
    title: 'The Ritual Begins',
    description: 'Returned for 7 consecutive days. Something is starting to form.',
    metric: 'maxCheckinStreak', threshold: 7,
    badgeImageUrl: 'badge_streak_bronze', tier: 'bronze',
  },
  {
    id: 'streak_30',
    title: 'A Month in the Shadows',
    description: '30 unbroken days inside the dark. You stopped asking why.',
    metric: 'maxCheckinStreak', threshold: 30,
    badgeImageUrl: 'badge_streak_silver', tier: 'silver',
  },
  {
    id: 'streak_90',
    title: 'Relentless',
    description: '90 consecutive days. The Loom has become part of your routine. Part of you.',
    metric: 'maxCheckinStreak', threshold: 90,
    badgeImageUrl: 'badge_streak_gold', tier: 'gold',
  },
  {
    id: 'streak_365',
    title: 'Eternal Witness',
    description: '365 days without missing a single night. The Loom knows your footsteps by sound.',
    metric: 'maxCheckinStreak', threshold: 365,
    badgeImageUrl: 'badge_streak_platinum', tier: 'platinum',
  },

  // ── CUSTOM ACTIONS WRITTEN ─────────────────────────────────────────────────
  // Source: custom_actions WHERE outcome = 'allow'
  // Requires: customActionsWritten column in user_counters + trigger #9
  {
    id: 'custom_10',
    title: 'The Meddler',
    description: 'Forced fate\'s hand 10 times with your own written choices',
    metric: 'customActionsWritten' as AchievementRule['metric'],
    threshold: 10,
    badgeImageUrl: 'badge_custom_bronze', tier: 'bronze',
  },
  {
    id: 'custom_50',
    title: 'Fate Forger',
    description: 'Forged 50 paths the Loom never anticipated. It noticed.',
    metric: 'customActionsWritten' as AchievementRule['metric'],
    threshold: 50,
    badgeImageUrl: 'badge_custom_silver', tier: 'silver',
  },
  {
    id: 'custom_100',
    title: 'Chaos Author',
    description: 'Authored 100 custom actions that bent the narrative\'s spine',
    metric: 'customActionsWritten' as AchievementRule['metric'],
    threshold: 100,
    badgeImageUrl: 'badge_custom_gold', tier: 'gold',
  },
  {
    id: 'custom_250',
    title: 'Reality Sculptor',
    description: 'Sculpted 250 custom choices from raw possibility. The Loom no longer resists you.',
    metric: 'customActionsWritten' as AchievementRule['metric'],
    threshold: 250,
    badgeImageUrl: 'badge_custom_platinum', tier: 'platinum',
  },
];
