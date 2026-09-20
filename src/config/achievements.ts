import type { AchievementRule } from "../types/achievements.js";

/**
 * Single Source of Truth (SSOT) for Twistloom's Achievement System.
 *
 * Every metric has exactly FOUR tiers: bronze → silver → gold → platinum.
 * Evaluated server-side against `user_counters` on every counter increment.
 *
 * Metric → Source table / event
 *  ── Platform & Social Metrics (15 metrics, 60 badges) ──
 *  booksGenerated             books                  (INSERT / DELETE)
 *  booksCompleted             user_completed_books   (INSERT)
 *  pagesRead                  user_page_progress     (INSERT / DELETE)
 *  pagesGenerated             pages                  (INSERT)
 *  branchesOpened             pages                  (INSERT, distinct branch_id)
 *  topupCredits               transactions           (INSERT, type = 'purchase')
 *  referredUsers              users                  (UPDATE, referral_rewarded_at)
 *  followersCount             user_follows           (INSERT / DELETE)
 *  maxCheckinStreak           user_checkins          (INSERT / UPDATE / DELETE)
 *  customActionsWritten       custom_actions         (INSERT / UPDATE, outcome = 'allow')
 *  easterEggsFound            easter_egg_discoveries (INSERT, claimed = true)
 *  creatorsSupported          creator_earnings       (INSERT / UPDATE, status = 'completed')
 *  wallNotesPosted            posts                  (INSERT / DELETE)
 *  wallNoteLikesReceived      user_likes             (INSERT / DELETE)
 *  endingsSharedToWall        posts                  (INSERT / DELETE)
 *
 *  ── Narrative Exploration Metrics (10 metrics, 40 badges) ──
 *  storiesCompleted           user_completed_books   (INSERT, first completion per book)
 *  alternateEndingsDiscovered user_completed_books   (INSERT, subsequent completions per book)
 *  deepBranchCompletions      user_completed_books   (INSERT, page >= 15 & non-main branch)
 *  distinctEndingTypesReached user_completed_books   (INSERT, distinct canonical viableEnding types)
 *  rareEndingsFound           user_completed_books   (INSERT, book complete_count <= 5 or rate < 20%)
 *  branchPointsExplored       user_page_progress     (INSERT / DELETE, non-main branch next_page)
 *  highRiskChoicesTaken       user_page_progress     (INSERT / DELETE, peril choice selected)
 *  consequenceExperienced     user_page_progress     (INSERT / DELETE, consequence action selected)
 *  cluesUncovered             user_completed_books   (INSERT, story_states clues discovered)
 *  threadsResolved            user_completed_books   (INSERT, story_states closed threads)
 *
 * Total Registry: 100 Badges across 25 metrics (4 tiers each: bronze -> silver -> gold -> platinum).
 * Badge images are resolved client-side via `getAchievementImageUrl(id)` in
 * `src/lib/config/achievements.ts`, which checks a hardcoded set of known
 * asset IDs against `/images/achievements/{id}.png`. No backend field needed.
 */
export const ACHIEVEMENT_REGISTRY: AchievementRule[] = [

  // ── BOOKS GENERATED ────────────────────────────────────────────────────────
  {
    id: 'gen_50',
    title: 'Story Weaver',
    description: 'Wove 50 branching worlds into the Loom',
    metric: 'booksGenerated', threshold: 50,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'gen_100',
    title: 'Architect of Fear',
    description: 'Constructed 100 labyrinthine horrors the mind cannot unsee',
    metric: 'booksGenerated', threshold: 100,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'gen_250',
    title: 'The Chronicler',
    description: 'Chronicled 250 descents into the dark — each one uniquely damning',
    metric: 'booksGenerated', threshold: 250,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'gen_500',
    title: 'The Loom Master',
    description: 'Summoned 500 worlds from nothing. The dark listens when you speak.',
    metric: 'booksGenerated', threshold: 500,
    tier: 'platinum', category: 'legacy',
  },

  // ── BOOKS COMPLETED ────────────────────────────────────────────────────────
  {
    id: 'comp_50',
    title: 'Still Breathing',
    description: 'Survived 50 harrowing storylines. So far.',
    metric: 'booksCompleted', threshold: 50,
    tier: 'bronze', category: 'survivor',
  },
  {
    id: 'comp_100',
    title: 'Fate Sealed',
    description: 'Sealed the fate of 100 narratives with your choices',
    metric: 'booksCompleted', threshold: 100,
    tier: 'silver', category: 'survivor',
  },
  {
    id: 'comp_250',
    title: 'Defier of Death',
    description: 'Defied oblivion across 250 completed storylines. It keeps missing.',
    metric: 'booksCompleted', threshold: 250,
    tier: 'gold', category: 'survivor',
  },
  {
    id: 'comp_500',
    title: 'Beyond the Abyss',
    description: 'Emerged from 500 storylines. Something came back with you.',
    metric: 'booksCompleted', threshold: 500,
    tier: 'platinum', category: 'survivor',
  },

  // ── PAGES READ ─────────────────────────────────────────────────────────────
  {
    id: 'read_500',
    title: 'Voracious Reader',
    description: 'Devoured 500 pages of unspeakable terror',
    metric: 'pagesRead', threshold: 500,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'read_2000',
    title: 'Insatiable Curiosity',
    description: 'Consumed 2,000 pages the sane turn away from',
    metric: 'pagesRead', threshold: 2000,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'read_5000',
    title: 'Lore Keeper',
    description: 'Absorbed 5,000 pages of forbidden knowledge. Some cannot be unlearned.',
    metric: 'pagesRead', threshold: 5000,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'read_10000',
    title: 'The Abyss Stares Back',
    description: '10,000 pages into the dark. It has learned your name.',
    metric: 'pagesRead', threshold: 10000,
    tier: 'platinum', category: 'legacy',
  },

  // ── PAGES GENERATED ───────────────────────────────────────────────────────
  {
    id: 'page_50',
    title: 'Ink Starter',
    description: 'Drafted 50 pages of your own haunting narrative',
    metric: 'pagesGenerated', threshold: 50,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'page_100',
    title: 'Page Turner',
    description: 'Spun 100 pages into existence. The Loom keeps asking for more.',
    metric: 'pagesGenerated', threshold: 100,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'page_250',
    title: 'Wordsmith of the Void',
    description: 'Crafted 250 pages from shadow and silence. Even the dark is impressed.',
    metric: 'pagesGenerated', threshold: 250,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'page_500',
    title: 'Master of the Manuscript',
    description: 'Generated 500 pages. The story is no longer yours alone.',
    metric: 'pagesGenerated', threshold: 500,
    tier: 'platinum', category: 'legacy',
  },

  // ── BRANCHES OPENED ────────────────────────────────────────────────────────
  {
    id: 'branch_50',
    title: 'Crossroads',
    description: 'Stepped off the beaten path 50 times',
    metric: 'branchesOpened', threshold: 50,
    tier: 'bronze', category: 'explorer',
  },
  {
    id: 'branch_100',
    title: 'Reality Bender',
    description: 'Fractured reality across 100 alternate choice pathways',
    metric: 'branchesOpened', threshold: 100,
    tier: 'silver', category: 'explorer',
  },
  {
    id: 'branch_250',
    title: 'Fractured Timeline',
    description: 'Shattered the timeline across 250 divergences. Each fork is a different you.',
    metric: 'branchesOpened', threshold: 250,
    tier: 'gold', category: 'explorer',
  },
  {
    id: 'branch_500',
    title: 'Parallel Haunting',
    description: 'Haunting 500 parallel timelines simultaneously. Which one is the real you?',
    metric: 'branchesOpened', threshold: 500,
    tier: 'platinum', category: 'explorer',
  },

  // ── CREDITS TOP-UP ─────────────────────────────────────────────────────────
  {
    id: 'topup_500',
    title: 'Shadow Investor',
    description: 'Poured 500 credits into the dark machinery of the Loom',
    metric: 'topupCredits', threshold: 500,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'topup_2000',
    title: 'Patron of the Dark',
    description: 'Fed 2,000 credits to the narrative machine without flinching',
    metric: 'topupCredits', threshold: 2000,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'topup_5000',
    title: 'High Roller',
    description: 'Staked 5,000 credits on the unknown. The house always wins — or does it?',
    metric: 'topupCredits', threshold: 5000,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'topup_10000',
    title: 'The Benefactor',
    description: 'Bankrolled 10,000 credits into the Loom. The dark owes you a debt it cannot repay.',
    metric: 'topupCredits', threshold: 10000,
    tier: 'platinum', category: 'legacy',
  },

  // ── REFERRED USERS ─────────────────────────────────────────────────────────
  {
    id: 'ref_10',
    title: 'Whisperer',
    description: 'Whispered 10 new souls toward the dark',
    metric: 'referredUsers', threshold: 10,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'ref_50',
    title: 'Cultist',
    description: 'Lured 50 followers into the embrace of the Loom',
    metric: 'referredUsers', threshold: 50,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'ref_100',
    title: 'Harbinger',
    description: 'Delivered 100 new souls to the narrative web',
    metric: 'referredUsers', threshold: 100,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'ref_500',
    title: 'Cult Leader',
    description: '500 devotees entered the dark at your word. They trust you with their minds.',
    metric: 'referredUsers', threshold: 500,
    tier: 'platinum', category: 'legacy',
  },

  // ── FOLLOWERS COUNT ────────────────────────────────────────────────────────
  {
    id: 'fol_100',
    title: 'Noticed',
    description: '100 readers sense something unsettling whenever you post',
    metric: 'followersCount', threshold: 100,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'fol_500',
    title: 'Local Legend',
    description: '500 readers know your name with quiet, creeping dread',
    metric: 'followersCount', threshold: 500,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'fol_5000',
    title: 'Infamous',
    description: '5,000 readers watch every word you write next',
    metric: 'followersCount', threshold: 5000,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'fol_50000',
    title: 'Dark Icon',
    description: '50,000 souls orbit your shadow. You are no longer a person. You are a myth.',
    metric: 'followersCount', threshold: 50000,
    tier: 'platinum', category: 'legacy',
  },

  // ── CHECK-IN STREAK ────────────────────────────────────────────────────────
  {
    id: 'streak_7',
    title: 'The Ritual Begins',
    description: 'Returned for 7 consecutive days. Something is starting to form.',
    metric: 'maxCheckinStreak', threshold: 7,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'streak_30',
    title: 'A Month in the Shadows',
    description: '30 unbroken days inside the dark. You stopped asking why.',
    metric: 'maxCheckinStreak', threshold: 30,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'streak_90',
    title: 'Relentless',
    description: '90 consecutive days. The Loom has become part of your routine. Part of you.',
    metric: 'maxCheckinStreak', threshold: 90,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'streak_365',
    title: 'Eternal Witness',
    description: '365 days without missing a single night. The Loom knows your footsteps by sound.',
    metric: 'maxCheckinStreak', threshold: 365,
    tier: 'platinum', category: 'legacy',
  },

  // ── CUSTOM ACTIONS WRITTEN ─────────────────────────────────────────────────
  // Source: custom_actions WHERE outcome = 'allow'
  // Requires: customActionsWritten column in user_counters + trigger #9
  {
    id: 'custom_10',
    title: 'The Meddler',
    description: 'Forced fate\'s hand 10 times with your own written choices',
    metric: 'customActionsWritten',
    threshold: 10,
    tier: 'bronze', category: 'chronicler',
  },
  {
    id: 'custom_50',
    title: 'Fate Forger',
    description: 'Forged 50 paths the Loom never anticipated. It noticed.',
    metric: 'customActionsWritten',
    threshold: 50,
    tier: 'silver', category: 'chronicler',
  },
  {
    id: 'custom_100',
    title: 'Chaos Author',
    description: 'Authored 100 custom actions that bent the narrative\'s spine',
    metric: 'customActionsWritten',
    threshold: 100,
    tier: 'gold', category: 'chronicler',
  },
  {
    id: 'custom_250',
    title: 'Reality Sculptor',
    description: 'Sculpted 250 custom choices from raw possibility. The Loom no longer resists you.',
    metric: 'customActionsWritten',
    threshold: 250,
    tier: 'platinum', category: 'chronicler',
  },

  // ── EASTER EGGS FOUND ─────────────────────────────────────────────────────
  // Source: easter_egg_discoveries WHERE claimed = true
  // Requires: easterEggsFound column in user_counters + trigger #11
  {
    id: 'egg_1',
    title: 'Something Hidden',
    description: 'Some stories hide more than their endings. You found the first thread.',
    metric: 'easterEggsFound', threshold: 1,
    tier: 'bronze', category: 'seeker',
  },
  {
    id: 'egg_5',
    title: 'Lore Seeker',
    description: 'Five secrets pulled from the dark. You are beginning to see the pattern.',
    metric: 'easterEggsFound', threshold: 5,
    tier: 'silver', category: 'seeker',
  },
  {
    id: 'egg_20',
    title: 'Thread Seeker',
    description: 'Twenty hidden threads unearthed. The Loom leaves its doors unlocked for you.',
    metric: 'easterEggsFound', threshold: 20,
    tier: 'gold', category: 'seeker',
  },
  {
    id: 'egg_50',
    title: 'Secrets of the Loom',
    description: 'Fifty secrets discovered. The Loom has nothing left to hide from you.',
    metric: 'easterEggsFound', threshold: 50,
    tier: 'platinum', category: 'seeker',
  },

  // ── CREATORS SUPPORTED (Thanks) ────────────────────────────────────────────
  // Source: creator_earnings WHERE status = 'completed'
  // Requires: creatorsSupported column in user_counters + trigger #12
  // Metric counts DISTINCT creators the reader has sent Thanks to (not total tips).
  {
    id: 'thanks_1',
    title: 'Blood Money',
    description: 'Your first coin slipped into the dark. A creator felt it.',
    metric: 'creatorsSupported',
    threshold: 1,
    tier: 'bronze', category: 'legacy',
  },
  {
    id: 'thanks_5',
    title: 'The Consigliere',
    description: 'Five creators owe you a debt. You are building something dangerous.',
    metric: 'creatorsSupported',
    threshold: 5,
    tier: 'silver', category: 'legacy',
  },
  {
    id: 'thanks_20',
    title: 'Shadow Patron',
    description: 'Twenty creators dance to your invisible strings. The dark economy has a new landlord.',
    metric: 'creatorsSupported',
    threshold: 20,
    tier: 'gold', category: 'legacy',
  },
  {
    id: 'thanks_50',
    title: 'The Syndicate',
    description: 'Fifty creators. One name in the shadows. You don\'t just read the dark — you fund it.',
    metric: 'creatorsSupported',
    threshold: 50,
    tier: 'platinum', category: 'legacy',
  },

  // ── PERSONAL WALL NOTES POSTED ───────────────────────────────────────────
  { id: 'wall_10', title: 'Margin Scribe', description: 'Pinned 10 public dispatches to the Wall before the ink went cold', metric: 'wallNotesPosted', threshold: 10, tier: 'bronze', category: 'chronicler' },
  { id: 'wall_50', title: 'Town Crier', description: 'Carved 50 notes into the public square. Travelers have begun to stop and read.', metric: 'wallNotesPosted', threshold: 50, tier: 'silver', category: 'chronicler' },
  { id: 'wall_200', title: 'Echo Chamber', description: '200 public dispatches. The dark corridors of the Loom resonate with your voice.', metric: 'wallNotesPosted', threshold: 200, tier: 'gold', category: 'chronicler' },
  { id: 'wall_500', title: 'The Living Chronicle', description: '500 public notes. You are woven into the very mortar and masonry of the Loom.', metric: 'wallNotesPosted', threshold: 500, tier: 'platinum', category: 'chronicler' },

  // ── PERSONAL WALL NOTE REACTIONS RECEIVED ────────────────────────────────
  { id: 'wall_like_25', title: 'Resonant Voice', description: 'Your notes struck a quiet, unsettling chord in 25 passing readers', metric: 'wallNoteLikesReceived', threshold: 25, tier: 'bronze', category: 'chronicler' },
  { id: 'wall_like_100', title: 'Crowd Favorite', description: '100 souls found truth in your margins. They keep coming back for more.', metric: 'wallNoteLikesReceived', threshold: 100, tier: 'silver', category: 'chronicler' },
  { id: 'wall_like_500', title: 'The Magnet', description: '500 readers stopped and pressed their hearts against your words', metric: 'wallNoteLikesReceived', threshold: 500, tier: 'gold', category: 'chronicler' },
  { id: 'wall_like_2500', title: 'Oracle of the Corkboard', description: '2,500 reactions. When you post a note, the town square falls quiet to listen.', metric: 'wallNoteLikesReceived', threshold: 2500, tier: 'platinum', category: 'chronicler' },

  // ── PERSONAL ENDINGS SHARED TO WALL ─────────────────────────────────────
  { id: 'share_end_1', title: 'First Revelation', description: 'Exposed the secret of your first discovered ending to the Wall', metric: 'endingsSharedToWall', threshold: 1, tier: 'bronze', category: 'multiverse' },
  { id: 'share_end_10', title: 'The Informant', description: 'Broadcasted 10 divergent fates to warn fellow wanderers of what lies ahead', metric: 'endingsSharedToWall', threshold: 10, tier: 'silver', category: 'multiverse' },
  { id: 'share_end_50', title: 'Cartographer of Doom', description: '50 endings exposed to the light. The maze is rapidly running out of secrets.', metric: 'endingsSharedToWall', threshold: 50, tier: 'gold', category: 'multiverse' },
  { id: 'share_end_100', title: 'Unveiler of the Multiverse', description: '100 endings charted. You have catalogued every nightmare the Loom can conjure.', metric: 'endingsSharedToWall', threshold: 100, tier: 'platinum', category: 'multiverse' },

  // ── NARRATIVE: STORIES COMPLETED ─────────────────────────────────────────
  { id: 'stories_done_1', title: 'The First Tapestry', description: 'Completed your first full branching narrative', metric: 'storiesCompleted', threshold: 1, tier: 'bronze', category: 'multiverse' },
  { id: 'stories_done_10', title: 'Weaver of Tales', description: 'Guided 10 complete stories to resolution', metric: 'storiesCompleted', threshold: 10, tier: 'silver', category: 'multiverse' },
  { id: 'stories_done_50', title: 'Master of Destinies', description: 'Guided 50 complete stories to resolution', metric: 'storiesCompleted', threshold: 50, tier: 'gold', category: 'multiverse' },
  { id: 'stories_done_150', title: 'Grand Archivist', description: 'Completed 150 distinct story worlds across the Loom', metric: 'storiesCompleted', threshold: 150, tier: 'platinum', category: 'multiverse' },

  // ── NARRATIVE: ALTERNATE ENDINGS DISCOVERED ─────────────────────────────
  { id: 'alt_ending_3', title: 'Parallel Thread', description: 'Discovered 3 alternate endings in previously completed stories', metric: 'alternateEndingsDiscovered', threshold: 3, tier: 'bronze', category: 'multiverse' },
  { id: 'alt_ending_15', title: 'Timeline Drifter', description: 'Uncovered 15 alternate realities across the multiverse', metric: 'alternateEndingsDiscovered', threshold: 15, tier: 'silver', category: 'multiverse' },
  { id: 'alt_ending_50', title: 'Quantum Wanderer', description: 'Diverged into 50 divergent timelines', metric: 'alternateEndingsDiscovered', threshold: 50, tier: 'gold', category: 'multiverse' },
  { id: 'alt_ending_150', title: 'Multiverse Weaver', description: 'Mastered 150 alternate fates across parallel worlds', metric: 'alternateEndingsDiscovered', threshold: 150, tier: 'platinum', category: 'multiverse' },

  // ── NARRATIVE: DEEP BRANCH COMPLETIONS ──────────────────────────────────
  { id: 'deep_branch_3', title: 'Divergent Path', description: 'Completed 3 branches 15+ pages deep into alternate realities', metric: 'deepBranchCompletions', threshold: 3, tier: 'bronze', category: 'explorer' },
  { id: 'deep_branch_15', title: 'Subterranean Guide', description: 'Completed 15 deep divergent branches', metric: 'deepBranchCompletions', threshold: 15, tier: 'silver', category: 'explorer' },
  { id: 'deep_branch_50', title: 'Abyssal Navigator', description: 'Completed 50 deep divergent branches', metric: 'deepBranchCompletions', threshold: 50, tier: 'gold', category: 'explorer' },
  { id: 'deep_branch_120', title: 'Void Walker', description: 'Completed 120 deep divergent realities far from the canonical trunk', metric: 'deepBranchCompletions', threshold: 120, tier: 'platinum', category: 'explorer' },

  // ── NARRATIVE: DISTINCT ENDING TYPES REACHED ─────────────────────────────
  { id: 'ending_type_2', title: 'Taste of the Macabre', description: 'Experienced 2 distinct psychological ending archetypes across the Loom', metric: 'distinctEndingTypesReached', threshold: 2, tier: 'bronze', category: 'multiverse' },
  { id: 'ending_type_5', title: 'Student of Madness', description: 'Experienced 5 distinct psychological ending archetypes', metric: 'distinctEndingTypesReached', threshold: 5, tier: 'silver', category: 'multiverse' },
  { id: 'ending_type_10', title: 'Anatomy of Despair', description: 'Experienced 10 distinct psychological ending archetypes', metric: 'distinctEndingTypesReached', threshold: 10, tier: 'gold', category: 'multiverse' },
  { id: 'ending_type_18', title: 'Human Tapestry', description: 'Omniscient Dread: Uncovered all 18 psychological ending archetypes', metric: 'distinctEndingTypesReached', threshold: 18, tier: 'platinum', category: 'multiverse' },

  // ── NARRATIVE: RARE ENDINGS FOUND ────────────────────────────────────────
  { id: 'rare_end_1', title: 'Hidden Corridor', description: 'Discovered an elusive ending found by fewer than 20% of readers', metric: 'rareEndingsFound', threshold: 1, tier: 'bronze', category: 'seeker' },
  { id: 'rare_end_5', title: 'Shadow Realities', description: 'Discovered 5 rare endings that few readers ever uncover', metric: 'rareEndingsFound', threshold: 5, tier: 'silver', category: 'seeker' },
  { id: 'rare_end_15', title: 'Rare Reality', description: 'Discovered 15 rare endings across divergent narrative corridors', metric: 'rareEndingsFound', threshold: 15, tier: 'gold', category: 'seeker' },
  { id: 'rare_end_40', title: 'Secret Keeper', description: 'Mastered 40 legendary rare endings hidden in the deep dark', metric: 'rareEndingsFound', threshold: 40, tier: 'platinum', category: 'seeker' },

  // ── NARRATIVE: CLUES UNCOVERED ───────────────────────────────────────────
  { id: 'clues_found_30', title: 'Keen Eye', description: 'Uncovered 30 narrative clues hidden across mystery plots', metric: 'cluesUncovered', threshold: 30, tier: 'bronze', category: 'seeker' },
  { id: 'clues_found_120', title: 'Forensic Gaze', description: 'Uncovered 120 narrative clues buried deep within the prose', metric: 'cluesUncovered', threshold: 120, tier: 'silver', category: 'seeker' },
  { id: 'clues_found_400', title: 'Unraveler of Lies', description: 'Uncovered 400 clues, piecing together the fractured truth', metric: 'cluesUncovered', threshold: 400, tier: 'gold', category: 'seeker' },
  { id: 'clues_found_1000', title: 'Truth Unmasked', description: 'Grand Inquisitor: Uncovered 1,000 hidden narrative clues', metric: 'cluesUncovered', threshold: 1000, tier: 'platinum', category: 'seeker' },

  // ── NARRATIVE: BRANCH POINTS EXPLORED ────────────────────────────────────
  { id: 'branch_fork_75', title: 'The Road Not Taken', description: 'Explored 75 branching decision points away from the trunk', metric: 'branchPointsExplored', threshold: 75, tier: 'bronze', category: 'explorer' },
  { id: 'branch_fork_300', title: 'Wayfarer of Forks', description: 'Explored 300 branching decision points across divergent storylines', metric: 'branchPointsExplored', threshold: 300, tier: 'silver', category: 'explorer' },
  { id: 'branch_fork_1000', title: 'Pathfinder', description: 'Explored 1,000 branching decision points across the Loom', metric: 'branchPointsExplored', threshold: 1000, tier: 'gold', category: 'explorer' },
  { id: 'branch_fork_2500', title: 'Cartographer of Possibility', description: 'Charted 2,500 branching decision points into the unknown', metric: 'branchPointsExplored', threshold: 2500, tier: 'platinum', category: 'explorer' },

  // ── NARRATIVE: HIGH-RISK CHOICES TAKEN ───────────────────────────────────
  { id: 'risk_choice_50', title: 'Playing with Fire', description: 'Made 50 high-peril choices in the face of imminent danger', metric: 'highRiskChoicesTaken', threshold: 50, tier: 'bronze', category: 'survivor' },
  { id: 'risk_choice_200', title: 'Edge of the Precipice', description: 'Made 200 high-peril choices without flinching', metric: 'highRiskChoicesTaken', threshold: 200, tier: 'silver', category: 'survivor' },
  { id: 'risk_choice_600', title: 'Tempting the Abyss', description: 'Made 600 high-peril choices against overwhelming odds', metric: 'highRiskChoicesTaken', threshold: 600, tier: 'gold', category: 'survivor' },
  { id: 'risk_choice_1500', title: 'Iron Will', description: 'Architect of Ruin: Made 1,500 high-peril choices and survived', metric: 'highRiskChoicesTaken', threshold: 1500, tier: 'platinum', category: 'survivor' },

  // ── NARRATIVE: DELAYED CONSEQUENCES EXPERIENCED ──────────────────────────
  { id: 'consequence_20', title: 'I Remember You', description: 'Reached 20 pages echoing consequences from an earlier decision', metric: 'consequenceExperienced', threshold: 20, tier: 'bronze', category: 'survivor' },
  { id: 'consequence_80', title: 'Echoes of the Past', description: 'Experienced 80 narrative consequences shaped by your choices', metric: 'consequenceExperienced', threshold: 80, tier: 'silver', category: 'survivor' },
  { id: 'consequence_250', title: 'Long Shadows', description: 'Experienced 250 delayed consequences echoing forward through time', metric: 'consequenceExperienced', threshold: 250, tier: 'gold', category: 'survivor' },
  { id: 'consequence_600', title: 'Fate Defier', description: 'Unbreakable Causality: Navigated 600 long-term narrative consequences', metric: 'consequenceExperienced', threshold: 600, tier: 'platinum', category: 'survivor' },

  // ── NARRATIVE: THREADS RESOLVED ──────────────────────────────────────────
  { id: 'thread_res_3', title: 'Loose Ends', description: 'Brought 3 ongoing narrative plot threads to resolution', metric: 'threadsResolved', threshold: 3, tier: 'bronze', category: 'chronicler' },
  { id: 'thread_res_15', title: 'Untangled Knot', description: 'Resolved 15 ongoing narrative threads across complex mysteries', metric: 'threadsResolved', threshold: 15, tier: 'silver', category: 'chronicler' },
  { id: 'thread_res_50', title: 'No Loose Threads', description: 'Resolved 50 ongoing narrative threads across the Loom', metric: 'threadsResolved', threshold: 50, tier: 'gold', category: 'chronicler' },
  { id: 'thread_res_150', title: 'Master Chronicler', description: 'The Loom\'s Weaver: Resolved 150 complex story threads to ultimate closure', metric: 'threadsResolved', threshold: 150, tier: 'platinum', category: 'chronicler' },

  // ── VIP PRESTIGE: MYTHIC TIER ──────────────────────────────────────────
  { id: 'mythic_weaver', title: 'Mythic Weaver', description: 'VIP Prestige: Generated 2,000 branching horror worlds as an active VIP', metric: 'booksGenerated', threshold: 2000, tier: 'mythic', category: 'legacy' },
  { id: 'mythic_survivor', title: 'Void Sovereign', description: 'VIP Prestige: Survived 1,500 fatal narrative storylines as an active VIP', metric: 'booksCompleted', threshold: 1500, tier: 'mythic', category: 'survivor' },
  { id: 'mythic_scholar', title: 'Omniscient Scholar', description: 'VIP Prestige: Consumed 40,000 pages of divergent dark fiction as an active VIP', metric: 'pagesRead', threshold: 40000, tier: 'mythic', category: 'legacy' },
  { id: 'mythic_inquisitor', title: 'Loom Oracle', description: 'VIP Prestige: Uncovered 5,000 hidden narrative clues across labyrinthine plots as an active VIP', metric: 'cluesUncovered', threshold: 5000, tier: 'mythic', category: 'seeker' },
  { id: 'mythic_fate', title: 'Architect of Fate', description: 'VIP Prestige: Navigated 10,000 perilous branching decision points as an active VIP', metric: 'branchPointsExplored', threshold: 10000, tier: 'mythic', category: 'explorer' },
];

