import type { PenEditType } from "./pen.js";

/**
 * Lifecycle state of a quest for a single user.
 *
 * - `in_progress` — the goal is not yet met.
 * - `completed` — detected as met, reward pending claim.
 * - `claimed`   — reward has been redeemed.
 *
 * @remarks Mirrors the frontend contract in
 * `Twistloom-web/src/lib/types/api/quests.ts`.
 */
export type QuestStatus = 'in_progress' | 'completed' | 'claimed';

/**
 * Counters available for `{ kind: 'counter' }` detectors.
 *
 * These are read from the trigger-maintained `user_counters` table (the same
 * source the achievement service uses), so a quest against any of these is
 * O(1) on read with no derived aggregate needed.
 */
export type QuestCounterMetric =
  | 'booksGenerated'
  | 'booksCompleted'
  | 'pagesRead'
  | 'pagesGenerated'
  | 'branchesOpened'
  | 'followersCount'
  | 'customActionsWritten';

/**
 * Discriminated union describing *how* a quest's goal is detected.
 *
 * Each variant maps to an explicit, user-scoped, indexed query in the quest
 * evaluation service (or a direct `user_counters` read for `counter`), so
 * evaluation is declarative and testable rather than scattered through routes.
 */
export type QuestDetector =
  /** Threshold on a `user_counters` metric. */
  | { kind: 'counter'; metric: QuestCounterMetric; threshold: number }
  /** Profile completed: `is_new_user = false` AND a name AND (bio | avatar | gender). */
  | { kind: 'profile'; threshold: number }
  /** Count of `user_likes` where `target_type = 'book'` for the user. */
  | { kind: 'likes'; threshold: number }
  /** Count of `user_favorites` rows for the user. */
  | { kind: 'favorites'; threshold: number }
  /** Count of `user_follows` rows where the user is the follower. */
  | { kind: 'follows'; threshold: number }
  /** Count of `book_testimonials` written by the user. */
  | { kind: 'testimonials'; threshold: number }
  /** Count of `user_completed_books` rows for the user. */
  | { kind: 'completedBooks'; threshold: number }
  /** Count of endings reached that are NOT the main branch (`page.branch_id != 'main'`). */
  | { kind: 'nonMainBranch'; threshold: number }
  /** Count of distinct `books.id` the user has open `user_sessions` for. */
  | { kind: 'distinctBooks'; threshold: number }
  /** Count of distinct authors (`books.user_id`) across the user's reads. */
  | { kind: 'distinctAuthors'; threshold: number }
  /** Count of the user's own books in a given mode (`novel` | `multiverse`). */
  | { kind: 'bookMode'; mode: 'novel' | 'multiverse'; threshold: number }
  /** Distinct read books carrying a `psychological*` keyword. */
  | { kind: 'thrillerGenre'; threshold: number }
  /** Count of `user_sessions` that were resumed (`updated_at > created_at`). */
  | { kind: 'resumedSession'; threshold: number }
  /** Distinct branch contexts explored for ONE book (proxy for "explore 3 branches"). */
  | { kind: 'distinctBranchContexts'; threshold: number }
  /** Count of `pen_sessions` rows for the user. */
  | { kind: 'penSessions'; threshold: number }
  /** Count of `pen_edits` rows of a specific `edit_type` for the user. */
  | { kind: 'penEdits'; editType: PenEditType; threshold: number }
  /** Binary: the user has authored at least one page via Pen (`pages.human_author_user_id = user`). */
  | { kind: 'authorPages'; threshold: number }
  /** Binary: the user has a `published` book (`status = 'active'`, `visibility != 'private'`). */
  | { kind: 'publishedBook' }
  /** Count of `canon_validations` for books authored by the user. */
  | { kind: 'canonValidations'; threshold: number };

/** Presentational + structural metadata for one quest (SSOT in `config/quests.ts`). */
export interface QuestRule {
  /** Key that links to `user_quests.quest_id`. Format `qs_<chapter>_<n>`. */
  id: string;
  /** Chapter the quest belongs to ('ch1'…'ch9'). */
  chapterId: string;
  /** Display title (API-provided string, mirroring achievements). */
  title: string;
  /** One-line "why" shown under the quest. */
  description: string;
  /** Credit payout on claim. */
  rewardCredits: number;
  /** Detector — how to evaluate completion. */
  detector: QuestDetector;
  /** `false` hides the quest from all responses (unshipped/future chapters). */
  enabled: boolean;
  /** Optional dependency tag (e.g. 'pen-v2') explaining why a quest is gated. */
  dependsOn?: string;
}

/**
 * A single quest with its current per-user state — exactly the shape the
 * frontend `UserQuest` contract (and `GET /user/quests`) requires.
 */
export interface UserQuestState {
  id: string;
  chapterId: string;
  title: string;
  description: string;
  rewardCredits: number;
  /** 0 for non-quantitative (binary/profile) detectors. */
  currentProgress: number;
  /** 0 = non-quantitative detector (no progress bar rendered). */
  threshold: number;
  progressPercent: number;
  status: QuestStatus;
  completedAt: string | null;
  claimedAt: string | null;
  enabled: boolean;
}

/** Aggregated summary of the quest log (used to derive the nav badge). */
export interface QuestsSummary {
  /** Quest count that is not yet `claimed`. */
  completed: number;
  /** Quest count currently claimable (`status === 'completed'`). */
  claimable: number;
  /** Sum of `rewardCredits` across all returned quests. */
  totalReward: number;
  /** Sum of `rewardCredits` for currently claimable quests. */
  unclaimedReward: number;
}