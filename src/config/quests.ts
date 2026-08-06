import type { QuestRule } from "../types/quests.js";

/** Minimum credit reward across all quests in the registry (economy floor). */
export const QUEST_REWARD_MIN = 5;
/** Maximum credit reward across all quests in the registry (economy ceiling). */
export const QUEST_REWARD_MAX = 30;

/**
 * Single Source of Truth (SSOT) for Twistloom's Quest System ("The Prologue").
 *
 * Every quest is statically defined here — mirroring `ACHIEVEMENT_REGISTRY` —
 * and evaluated server-side against real user data (evaluate-on-read). Quest
 * completion writes a `user_quests` row with `status = 'completed'`; claiming
 * the reward flips it to `'claimed'` and pays credits via `addCredits`.
 *
 * Detector → Source table / event
 *  counter                   user_counters        (trigger-maintained)
 *  profile                   users                (is_new_user + name/bio/avatar/gender)
 *  likes                     user_likes           (target_type = 'book')
 *  favorites                 user_favorites
 *  follows                   user_follows         (follower = me)
 *  testimonials              book_testimonials    (written by me)
 *  completedBooks            user_completed_books
 *  nonMainBranch             user_completed_books JOIN pages (page.branch_id != 'main')
 *  distinctBooks             user_sessions        (distinct book_id)
 *  distinctAuthors           user_sessions JOIN books (distinct books.user_id)
 *  bookMode                  books                (user's own, mode = novel|multiverse)
 *  thrillerGenre             user_sessions JOIN books (keywords ILIKE 'psychological%')
 *  resumedSession            user_sessions        (updated_at > created_at)
 *  distinctBranchContexts    user_page_progress JOIN pages (distinct branch_id per book)
 *  penSessions               pen_sessions
 *  penEdits                  pen_edits            (by edit_type)
 *  authorPages               pages                (human_author_user_id = me)
 *  publishedBook             books                (status='active', visibility != 'private')
 *  canonValidations          canon_validations    (books authored by me)
 *
 * Quests whose detectors depend on data shapes that are not finalised yet
 * (Pen lore/character/AI flows) ship with `enabled: false` and a `dependsOn`
 * tag so the UI never shows them — flipping one flag activates them later.
 *
 * Reward ladder: 5–30 credits; Chapter I–V totals 385 credits.
 */
export const QUEST_REGISTRY: QuestRule[] = [
  // ── CHAPTER I · First Steps (65 credits) ──────────────────────────────────
  {
    id: 'qs_01_1', chapterId: 'ch1',
    title: 'Complete your profile',
    description: 'Who you are makes your stories yours.',
    rewardCredits: 10,
    detector: { kind: 'profile', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_2', chapterId: 'ch1',
    title: 'Create your first story with Spark',
    description: 'Feel the magic in thirty seconds.',
    rewardCredits: 15,
    detector: { kind: 'counter', metric: 'booksGenerated', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_3', chapterId: 'ch1',
    title: 'Read your first story page',
    description: 'Start consuming the world you can build.',
    rewardCredits: 10,
    detector: { kind: 'counter', metric: 'pagesRead', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_4', chapterId: 'ch1',
    title: 'Make your first choice',
    description: 'Every branch is a new life for your story.',
    rewardCredits: 10,
    detector: { kind: 'distinctBranchContexts', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_5', chapterId: 'ch1',
    title: 'React to a story',
    description: 'Tell a writer their work moved you.',
    rewardCredits: 5,
    detector: { kind: 'likes', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_6', chapterId: 'ch1',
    title: 'Save a story to your Library',
    description: 'Collect the worlds you want to return to.',
    rewardCredits: 5,
    detector: { kind: 'favorites', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_01_7', chapterId: 'ch1',
    title: 'Discover another story',
    description: 'There is always another universe waiting.',
    rewardCredits: 10,
    detector: { kind: 'distinctBooks', threshold: 2 },
    enabled: true,
  },

  // ── CHAPTER II · Discover the Multiverse (80 credits) ────────────────────
  {
    id: 'qs_02_1', chapterId: 'ch2',
    title: 'Generate a story from just one sentence',
    description: 'A single line can hold an entire multiverse.',
    rewardCredits: 10,
    detector: { kind: 'counter', metric: 'booksGenerated', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_02_2', chapterId: 'ch2',
    title: 'Try a different writing style',
    description: 'The same idea, a completely different voice.',
    rewardCredits: 10,
    detector: { kind: 'bookMode', mode: 'novel', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_02_3', chapterId: 'ch2',
    title: 'Continue an existing story',
    description: 'Return to a tale that is not finished with you.',
    rewardCredits: 5,
    detector: { kind: 'resumedSession', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_02_4', chapterId: 'ch2',
    title: 'Reach your first alternate ending',
    description: 'Choose a road you have never walked.',
    rewardCredits: 15,
    detector: { kind: 'nonMainBranch', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_02_5', chapterId: 'ch2',
    title: 'Read five different stories',
    description: 'The multiverse rewards the curious.',
    rewardCredits: 15,
    detector: { kind: 'distinctBooks', threshold: 5 },
    enabled: true,
  },
  {
    id: 'qs_02_6', chapterId: 'ch2',
    title: 'Explore three branches of one story',
    description: 'Every fork hides a different truth.',
    rewardCredits: 15,
    detector: { kind: 'distinctBranchContexts', threshold: 3 },
    enabled: true,
  },
  {
    id: 'qs_02_7', chapterId: 'ch2',
    title: 'Replay a story and choose differently',
    description: 'Second chances exist — if you dare.',
    rewardCredits: 10,
    detector: { kind: 'resumedSession', threshold: 1 },
    enabled: true,
  },

  // ── CHAPTER III · Become a Creator (110 credits) ─────────────────────────
  {
    id: 'qs_03_1', chapterId: 'ch3',
    title: 'Open Pen for the first time',
    description: 'Step behind the curtain of creation.',
    rewardCredits: 5,
    detector: { kind: 'penSessions', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_03_2', chapterId: 'ch3',
    title: 'Create your first project',
    description: 'Every epic begins with a blank page.',
    rewardCredits: 10,
    detector: { kind: 'counter', metric: 'booksGenerated', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_03_3', chapterId: 'ch3',
    title: 'Add your first character',
    description: 'A story is only as alive as its people.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'human_wrote', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_4', chapterId: 'ch3',
    title: 'Create your first location',
    description: 'Where will your characters live?',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'human_wrote', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_5', chapterId: 'ch3',
    title: "Create your world's lore",
    description: 'The past gives the present its weight.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'plan', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_6', chapterId: 'ch3',
    title: 'Write your first chapter',
    description: 'First words, first world.',
    rewardCredits: 15,
    detector: { kind: 'authorPages', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_7', chapterId: 'ch3',
    title: 'Ask AI to expand a scene',
    description: 'Let the loom weave a wider thread.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'ai_continued', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_8', chapterId: 'ch3',
    title: 'Rewrite dialogue with AI',
    description: 'Sharpen every voice.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'ai_revised', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_9', chapterId: 'ch3',
    title: 'Create your story outline',
    description: 'Plan the traps before you spring them.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'plan', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_03_10', chapterId: 'ch3',
    title: 'Publish your first draft',
    description: 'Send your story out into the night.',
    rewardCredits: 20,
    detector: { kind: 'publishedBook' },
    enabled: true,
  },

  // ── CHAPTER IV · Collaborate with AI (65 credits) ─────────────────────────
  {
    id: 'qs_04_1', chapterId: 'ch4',
    title: 'Turn a simple idea into a story',
    description: 'One spark is all the loom needs.',
    rewardCredits: 10,
    detector: { kind: 'counter', metric: 'booksGenerated', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_04_2', chapterId: 'ch4',
    title: 'Brainstorm with AI',
    description: 'Two minds — one of them endless.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'ai_continued', threshold: 1 },
    enabled: false,
    dependsOn: 'ai-chat',
  },
  {
    id: 'qs_04_3', chapterId: 'ch4',
    title: 'Expand a scene',
    description: 'More room to breathe, more room to fear.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'ai_continued', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_04_4', chapterId: 'ch4',
    title: 'Improve dialogue',
    description: 'Let every character find their voice.',
    rewardCredits: 10,
    detector: { kind: 'penEdits', editType: 'ai_revised', threshold: 1 },
    enabled: false,
    dependsOn: 'pen-v2',
  },
  {
    id: 'qs_04_5', chapterId: 'ch4',
    title: 'Check story consistency',
    description: 'Continuity is the author\u2019s discipline.',
    rewardCredits: 10,
    detector: { kind: 'canonValidations', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_04_6', chapterId: 'ch4',
    title: 'Generate the next chapter',
    description: 'The story never stops asking for more.',
    rewardCredits: 15,
    detector: { kind: 'counter', metric: 'pagesGenerated', threshold: 1 },
    enabled: true,
  },

  // ── CHAPTER V · The Reader Journey (65 credits) ───────────────────────────
  {
    id: 'qs_05_1', chapterId: 'ch5',
    title: 'Read ten pages',
    description: 'Build the habit of worlds.',
    rewardCredits: 10,
    detector: { kind: 'counter', metric: 'pagesRead', threshold: 10 },
    enabled: true,
  },
  {
    id: 'qs_05_2', chapterId: 'ch5',
    title: 'Finish your first story',
    description: 'See a tale to its end.',
    rewardCredits: 15,
    detector: { kind: 'completedBooks', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_05_3', chapterId: 'ch5',
    title: 'Unlock your first hidden ending',
    description: 'The truest endings hide in the shadows.',
    rewardCredits: 15,
    detector: { kind: 'nonMainBranch', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_05_4', chapterId: 'ch5',
    title: 'Read your first psychological thriller',
    description: 'The mind is the darkest setting.',
    rewardCredits: 5,
    detector: { kind: 'thrillerGenre', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_05_5', chapterId: 'ch5',
    title: 'Read stories from three different creators',
    description: 'Every creator sees the dark differently.',
    rewardCredits: 10,
    detector: { kind: 'distinctAuthors', threshold: 3 },
    enabled: true,
  },
  {
    id: 'qs_05_6', chapterId: 'ch5',
    title: 'Leave your first review',
    description: 'Tell the author how far they took you.',
    rewardCredits: 5,
    detector: { kind: 'testimonials', threshold: 1 },
    enabled: true,
  },
  {
    id: 'qs_05_7', chapterId: 'ch5',
    title: 'Favorite your first creator',
    description: 'Follow the voices you trust.',
    rewardCredits: 5,
    detector: { kind: 'follows', threshold: 1 },
    enabled: true,
  },
];
